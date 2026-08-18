const fs = require('fs');
const path = require('path');

const logger = require('../../log');

/**
 * ARCHON (F3): what a card DOES, read from the card data itself.
 *
 * The misplay review's founding rule is "no card text" - but that rule was
 * about the GAME LOG, which is localised prose that rewords with every engine
 * release. Card data is the opposite: `master-vault-data/packs/*.json` is
 * canonical, versioned in this repository, keyed by the same card id the
 * recordings store, and its English rules text only changes when a card is
 * actually errata'd. Classifying THAT is reading stable data, not parsing
 * chat.
 *
 * ## What a role is, and what it is not
 *
 * A role is a coarse functional bucket - "this card steals", "this destroys
 * wide", "this forges a key" - matched with deliberately narrow patterns
 * against the canonical text plus the structured keyword list. High precision
 * over recall, always: a card the classifier misses simply gets no special
 * treatment (the review behaves exactly as it did before this module
 * existed), while a card it mislabels would suppress a real flag or invent a
 * false one. When a pattern is in doubt, it stays out.
 *
 * This is NOT rules comprehension. "Steal 2<A> if your opponent has 3 or
 * more Logos cards in play" classifies as amber control even though its
 * condition may never be met; conditions, targets and costs are invisible
 * here. Every consumer phrases its output accordingly - "a steal was in
 * hand", never "this would have worked".
 */

/** The functional buckets the review understands. */
const ROLES = {
    /** Steals or captures - the tools that answer an opponent at check. */
    AMBER_CONTROL: 'amber-control',
    /**
     * Raises the opponent's key cost or forbids their forge - the OTHER
     * answer to a check, and the classic one: the amber stays, the key does
     * not come. Symmetric locks ("Players cannot forge...") and
     * self-drawbacks ("You cannot forge...") stay out - a tool that jams
     * your own forge as hard as theirs is a strategy, not an answer.
     */
    FORGE_DENIAL: 'forge-denial',
    /** Destroys or damages every (enemy) creature - answers a wide board. */
    BOARD_WIPE: 'board-wipe',
    /** Forges a key outside the normal start-of-turn forge. */
    KEY_CHEAT: 'key-cheat',
    /** A creature whose own text forbids it from reaping. */
    CANNOT_REAP: 'cannot-reap',
    /**
     * ARCHON (F9): carries a Fate ability - the penalty that fires when the
     * prophecy it was buried under is fulfilled.
     *
     * Prophetic Visions makes activating a prophecy cost one card from hand,
     * placed face down beneath it; when the prophecy comes true, the buried
     * card's Fate ability resolves against its owner ("destroy the most
     * powerful friendly creature", "your opponent gains 3", "lose 2"). So
     * which card goes under a prophecy is a real decision, and a card
     * carrying a Fate ability is the wrong answer to it.
     */
    HAS_FATE: 'has-fate'
};

/**
 * The narrow patterns. Text uses canonical symbols (`Steal 1<A>`) and a
 * vertical tab between ability lines; matching stays case-insensitive and
 * line-agnostic but otherwise literal.
 */
const AMBER_CONTROL_RE = /\b(steal|capture)\b/i;
// "each creature", "each enemy creature", "each undamaged creature", "each
// creature with power 3 or lower" - but never "each friendly creature" or
// "each of your creatures": a self-wipe answers nothing.
const BOARD_WIPE_RE = /(destroy|deal \d+ damage to) each (?!friendly|of your)(\w+ ){0,3}creature/i;
// Cards refer to the forge PHASE as the quoted '"forge a key" step' (Miasma
// skips it; double-forge cards forge during it). That quoted phrase is a
// noun, not an instruction, and is cut before the key-cheat test so a card
// that merely talks about the step never classifies as cheating a key out.
const FORGE_STEP_PHRASE_RE = /[“"]forge a key[”"] step/gi;
const KEY_CHEAT_RE = /forge a key/i;
const KEY_CHEAT_NEGATED_RE = /(cannot|can['’]t)[^.]{0,40}forge/i;
// "Keys cost +2<A>", "Keys cost +1A", "key costs +1 for each..." - the tax
// family - plus denying the opponent's forge outright ("your opponent cannot
// forge", Miasma's "your opponent skips the ... step"). The pool also holds
// "Players cannot forge..." (symmetric locks) and "You cannot forge..."
// (drawbacks); no pattern reaches those.
const FORGE_DENIAL_RE = /(keys? costs? \+\d|opponent cannot forge|opponent skips[^.]{0,30}forge)/i;
const CANNOT_REAP_RE = /cannot reap/i;
const ENEMY_CANNOT_REAP_RE = /enemy creatures cannot reap/i;
// The ability label itself, which is canonical and unambiguous.
const HAS_FATE_RE = /\bFate:/;

/**
 * Classify one card's data into roles. Pure, so the patterns can be tested
 * against known cards without touching the disk.
 *
 * @param {{text?: string, type?: string}} card
 * @returns {Set<string>}
 */
function classify(card) {
    const roles = new Set();
    const text = typeof card?.text === 'string' ? card.text : '';

    if (!text) {
        return roles;
    }

    if (AMBER_CONTROL_RE.test(text)) {
        roles.add(ROLES.AMBER_CONTROL);
    }

    if (BOARD_WIPE_RE.test(text)) {
        roles.add(ROLES.BOARD_WIPE);
    }

    const withoutStepName = text.replace(FORGE_STEP_PHRASE_RE, '');

    if (KEY_CHEAT_RE.test(withoutStepName) && !KEY_CHEAT_NEGATED_RE.test(withoutStepName)) {
        roles.add(ROLES.KEY_CHEAT);
    }

    if (FORGE_DENIAL_RE.test(text)) {
        roles.add(ROLES.FORGE_DENIAL);
    }

    if (
        card?.type === 'creature' &&
        CANNOT_REAP_RE.test(text) &&
        !ENEMY_CANNOT_REAP_RE.test(text)
    ) {
        roles.add(ROLES.CANNOT_REAP);
    }

    if (HAS_FATE_RE.test(text)) {
        roles.add(ROLES.HAS_FATE);
    }

    return roles;
}

/**
 * Roles for every card id, loaded from the master vault packs once and
 * cached. Reprints repeat an id across packs with the same text; last one in
 * wins, which is also the newest printing.
 *
 * Failure here must never take the review down: an unreadable pack logs and
 * contributes nothing, and a missing directory yields an empty index - the
 * review then simply runs without card knowledge, exactly as it did before
 * this module existed.
 *
 * @returns {Map<string, Set<string>>}
 */
let cachedIndex = null;

function rolesIndex() {
    if (cachedIndex) {
        return cachedIndex;
    }

    const index = new Map();
    const packsDir = path.join(__dirname, '..', '..', '..', 'master-vault-data', 'packs');
    let files = [];

    try {
        files = fs.readdirSync(packsDir).filter((file) => file.endsWith('.json'));
    } catch (err) {
        logger.error('Card knowledge could not list packs: %s', err.message);
    }

    for (const file of files) {
        try {
            const pack = JSON.parse(fs.readFileSync(path.join(packsDir, file), 'utf8'));

            for (const card of pack.cards || []) {
                if (!card || !card.id) {
                    continue;
                }

                const roles = classify(card);

                if (roles.size > 0) {
                    index.set(card.id, roles);
                } else if (!index.has(card.id)) {
                    // Recorded as known-and-plain, so a lookup can tell "no
                    // roles" apart from "never heard of it".
                    index.set(card.id, roles);
                }
            }
        } catch (err) {
            logger.error('Card knowledge could not read %s: %s', file, err.message);
        }
    }

    cachedIndex = index;

    return index;
}

/**
 * The roles of one card id, or an empty set for a card the index does not
 * know. Never throws.
 *
 * @param {string} cardId
 * @returns {Set<string>}
 */
function rolesFor(cardId) {
    if (!cardId) {
        return new Set();
    }

    return rolesIndex().get(cardId) || new Set();
}

module.exports = { ROLES, classify, rolesFor, rolesIndex };
