const logger = require('../../log');
const { cloneCard } = require('./packCards');

/**
 * ARCHON (N32): one way to turn a Master Vault deck into something the engine
 * can play.
 *
 * Two features now build fields out of registered decks - the Gauntlet's random
 * pool and the Vault Tour's curated one - and both need the same three steps:
 * fetch the deck with its cards, parse it with the MEMBER-FACING importer's own
 * parser, and turn the parsed list into engine entries, keeping nothing this
 * server cannot simulate.
 *
 * The parser is the load-bearing part. Mavericks, anomalies, enhancements,
 * prophecies and the card-id spelling rules all come out identical to a deck a
 * player imported, which is the point: an opponent the lab plays is not a
 * second, subtly different notion of "deck" that could drift from the real one.
 *
 * Everything here is best effort and returns a reason rather than throwing: a
 * field that cannot be built must never take a sweep tick with it.
 */

// Master Vault's single-deck endpoint, cards included - the same URL deck
// import uses.
const MV_DECK_URL = 'https://www.keyforgegame.com/api/decks/';

/**
 * Fetch and parse one deck.
 *
 * @param {string} uuid
 * @param {object} deps
 * @param {object} deps.deckService supplies parseDeckResponse
 * @param {number} [deps.timeoutMs]
 * @param {string} [deps.label] what to call this caller in the log
 * @returns {Promise<{parsed: object}|{error: string}>}
 */
async function fetchDeck(uuid, { deckService, timeoutMs = 10000, label = 'lab' } = {}) {
    if (!uuid || !deckService) {
        return { error: 'no-deck-service' };
    }

    try {
        const response = await fetch(`${MV_DECK_URL}${uuid}/?links=cards`, {
            signal: AbortSignal.timeout(timeoutMs)
        });

        if (!response.ok) {
            logger.warn(`${label}: Master Vault returned ${response.status} for ${uuid}`);

            return { error: `master-vault-${response.status}` };
        }

        const body = await response.json();

        if (!body || !body._linked || !body.data) {
            return { error: 'unreadable' };
        }

        const parsed = await deckService.parseDeckResponse(label, body);

        if (!parsed) {
            return { error: 'unparseable' };
        }

        return { parsed };
    } catch (err) {
        logger.warn(`${label}: could not fetch ${uuid}: ${err.message}`);

        return { error: 'fetch-failed' };
    }
}

/**
 * Master Vault card entries turned into engine deck entries, dropping nothing
 * silently: any card this server has no data for comes back in `missing`, which
 * is what makes a deck unplayable rather than a game that crashes mid-sweep.
 */
function toEngineCards(parsedCards) {
    const cards = [];
    const missing = [];

    for (const entry of parsedCards || []) {
        const card = cloneCard(entry.id);

        if (!card) {
            missing.push(entry.id);
            continue;
        }

        cards.push({
            id: entry.id,
            count: entry.count,
            maverick: entry.maverick || undefined,
            anomaly: entry.anomaly || undefined,
            house: entry.house || undefined,
            isNonDeck: !!entry.isNonDeck,
            enhancements: entry.enhancements || undefined,
            prophecyId: entry.prophecyId || undefined
        });
    }

    return { cards, missing };
}

/**
 * A parsed deck reduced to what a field table stores, with the reason it cannot
 * be played when it cannot.
 *
 * A three-house count is the engine's rule, not a preference: a deck with two or
 * four houses is not a game this simulation knows how to start.
 */
/**
 * Stored field entries with their card data re-attached, which is what makes
 * them playable.
 *
 * The field tables store card IDS. The engine's deck builder reads `entry.card`
 * and DROPS any entry that has none (`server/game/deck.js` logs "Corrupt deck"
 * and returns the entry without one; `prepare` then filters it out), so a stored
 * deck handed straight to the engine plays as an EMPTY deck. It does not throw
 * and it does not abandon - it loses, three keys to nothing, every single time.
 * That is the worst shape a bug can take here, because a rigged result looks
 * exactly like a result: the matrix filled in at 100% and nothing in any log
 * said why.
 *
 * Re-attached at draw time rather than stored, so the row stays small and the
 * cards always come from the pack index this build ships rather than a snapshot
 * taken whenever the deck was first fetched.
 */
function withCardData(entries) {
    const cards = [];
    const missing = [];

    for (const entry of entries || []) {
        const card = cloneCard(entry.id);

        if (!card) {
            missing.push(entry.id);
            continue;
        }

        cards.push({ ...entry, card });
    }

    return { cards, missing };
}

function playableDeck(parsed) {
    const { cards, missing } = toEngineCards(parsed.cards || []);
    const houses = (parsed.houses || []).filter(Boolean);

    if (missing.length || houses.length !== 3) {
        return {
            playable: false,
            reasons: missing.length ? missing : ['house-count'],
            name: parsed.name,
            expansion: parsed.expansion,
            houses
        };
    }

    return { playable: true, cards, houses, name: parsed.name, expansion: parsed.expansion };
}

module.exports = { fetchDeck, toEngineCards, withCardData, playableDeck, MV_DECK_URL };
