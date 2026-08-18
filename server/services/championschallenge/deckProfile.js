/**
 * ARCHON (N30): what a deck is trying to do, read from its own cards.
 *
 * The Gauntlet lets a member say "play me decks that fight for the board" or
 * "decks that race", and until now those filters were computed from Decks of
 * KeyForge's AERC breakdown. That made the most configurable part of the feature
 * depend on somebody else's API and somebody else's key: no key, no enrichment,
 * no strategy filter, and a pool that answers every strategy with "no opponents"
 * while looking perfectly healthy.
 *
 * A deck's card list is already here. So this reads the deck itself.
 *
 * What this is NOT
 * ----------------
 * It is not AERC and it is not SAS. AERC is a per-card dataset DoK maintains by
 * hand, refined over years, and nothing computed from card text in a hundred
 * lines is a substitute for it - so these numbers live on their own scale, under
 * their own names, and the filters prefer DoK's numbers for any deck that has
 * them. This exists to make the filters WORK on a server with no key, not to
 * replace a rating, and it never feeds ARI: a rating built partly on a keyword
 * count would be a worse rating wearing the same clothes.
 *
 * How it reads a card
 * -------------------
 * Printed values where they exist - amber icons, creature power and armour are
 * facts, not guesses - and clause-level keyword matching for the rest. CLAUSE
 * level matters: "destroy a friendly creature" and "destroy an enemy creature"
 * are opposite facts about a deck, and card-level matching cannot tell them
 * apart. Text is split on sentence and line boundaries and each clause is
 * checked with its own polarity guard.
 *
 * It will misread cards. A coarse count over 36 cards is still a usable signal
 * for "does this deck do a lot of this", which is the only question the filters
 * ask, and every threshold is calibrated so that a filter selects a minority of
 * real decks rather than all or none of them (see the spec).
 */

/** The axes, named after what they measure rather than after AERC's fields. */
const AXES = [
    'amberControl',
    'expectedAmber',
    'artifactControl',
    'creatureControl',
    'efficiency',
    'disruption',
    'effectivePower'
];

// Clauses are what get matched, not whole cards: one card commonly does a
// friendly thing and an unfriendly thing in two sentences.
const CLAUSE_SPLIT = /[.\n|]+/;

// "your opponent draws" is not card draw for you; "destroy a friendly creature"
// is not removal. Each rule carries the guard that makes it mean what it says.
const THEIRS = /\b(enemy|opponent|opponent’s|opponent's|their)\b/;
const MINE = /\b(friendly|your own|you control)\b/;

// Card text conjugates: "steal 1" and "steals 1" are the same fact, and a
// pattern that matches only the bare stem silently misses half the pool - which
// is invisible, because a keyword count that is uniformly too low still produces
// a tidy-looking number.
const RULES = [
    {
        axis: 'amberControl',
        // Steal and capture take amber off the opponent; "loses" says so plainly.
        match: /\bsteals?\b|\bcaptures?d?\b|\bcaptured\b|\bopponent loses\b|\bloses \d+\b/,
        weight: 1
    },
    {
        axis: 'expectedAmber',
        // Text-granted amber, on top of the printed bonus icons counted below.
        match: /\bgains? \d+\b/,
        guard: (clause) => !THEIRS.test(clause),
        weight: 1
    },
    {
        axis: 'artifactControl',
        match: /\bartifacts?\b/,
        guard: (clause) => /\bdestroys?\b|\bpurges?\b|\buses?\b|\bcontrol\b/.test(clause),
        weight: 1
    },
    {
        axis: 'creatureControl',
        match: /\bdestroys?\b|\bdestroyed\b|\bdeals? \d+\b|\bdeals? damage\b|\bstuns?\b|\bsplash\b/,
        // Removal aimed at your own board is not removal; a clause that names
        // neither side is counted, because most removal reads "destroy a
        // creature" and means the opponent's in practice.
        guard: (clause) => !(MINE.test(clause) && !THEIRS.test(clause)),
        weight: 1
    },
    {
        axis: 'efficiency',
        match: /\bdraws?\b|\barchives?\b|\bready\b|\breadies\b|\bsearch your deck\b/,
        guard: (clause) => !THEIRS.test(clause),
        weight: 1
    },
    {
        axis: 'disruption',
        match: /\bdiscards?\b|\bpurges?\b|\bexhausts?\b|\bcannot\b|\bskips?\b|\bstuns?\b/,
        // Only when it is aimed at them: discarding your own cards is a cost.
        guard: (clause) => THEIRS.test(clause),
        weight: 1
    }
];

/**
 * A deck's profile from its cards.
 *
 * @param {Array<{id: string, count?: number}>} cards the deck list
 * @param {object} index card id -> pack card data
 * @returns {object|null} one number per axis, or null for an unreadable list
 */
function profileDeck(cards, index) {
    if (!Array.isArray(cards) || !cards.length || !index) {
        return null;
    }

    const totals = Object.fromEntries(AXES.map((axis) => [axis, 0]));
    let known = 0;

    for (const entry of cards) {
        const card = index[entry && entry.id];

        if (!card) {
            continue;
        }

        const count = Math.max(1, parseInt(entry.count, 10) || 1);

        known += count;

        // Printed facts first.
        totals.expectedAmber += (card.amber || 0) * count;

        if (card.type === 'creature') {
            totals.effectivePower += ((card.power || 0) + (card.armor || 0)) * count;
        }

        const text = String(card.text || '').toLowerCase();

        if (!text) {
            continue;
        }

        for (const clause of text.split(CLAUSE_SPLIT)) {
            if (!clause.trim()) {
                continue;
            }

            for (const rule of RULES) {
                if (!rule.match.test(clause)) {
                    continue;
                }

                if (rule.guard && !rule.guard(clause)) {
                    continue;
                }

                totals[rule.axis] += rule.weight * count;
            }
        }
    }

    if (!known) {
        return null;
    }

    // Rounded, because these are estimates and a stored 3.7000000000000002 in a
    // jsonb column invites someone to believe the last five digits.
    return Object.fromEntries(AXES.map((axis) => [axis, Math.round(totals[axis] * 100) / 100]));
}

module.exports = { profileDeck, AXES, RULES };
