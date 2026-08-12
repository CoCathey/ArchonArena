/**
 * ARCHON: what the prize pool is, and who gets what.
 *
 * This platform does not touch the money. An event records its buy-in and how
 * the pot is meant to be divided; the organizer collects and pays out however
 * they already do - cash at the counter, a transfer, store credit. Handling it
 * here would mean KYC, 1099s, chargebacks and geo-restriction, permanently, in
 * exchange for a few dollars an event. What people actually want from a
 * platform is not to do the arithmetic in their head at the end of the night.
 *
 * So this is arithmetic, and it lives client-side on purpose: nothing on the
 * server consumes it, and one implementation cannot disagree with itself. If
 * money ever does move through the platform, this calculation becomes
 * authoritative and moves to the server - a deliberate change at that point,
 * not something to pre-empt now.
 *
 * INTEGER CENTS THROUGHOUT. Splits are basis points (7500 = 75%), never
 * fractions, and every division states where the remainder goes. A prize table
 * that does not add up to the pot is the one bug in here anybody will notice.
 */

/** 100% in basis points. */
export const FULL_SHARE = 10000;

export const formatCents = (cents, currency = 'USD') => {
    const amount = (Math.round(cents) / 100).toFixed(2);
    const symbol = { USD: '$', EUR: '€', GBP: '£' }[currency];

    return symbol ? `${symbol}${amount}` : `${amount} ${currency}`;
};

/**
 * A typed decimal to its hundredths, as an integer.
 *
 * Dollars to cents and percent to basis points are the same operation, and it
 * is the one place a float would quietly cost somebody a penny: (10.10 * 100)
 * is 1009.9999999999999 in IEEE754, and Math.round hides that for a while and
 * then does not. So the string is split rather than multiplied.
 *
 * Extra digits are truncated, not rounded - there is no half-cent to round.
 */
const hundredthsOf = (value) => {
    const text = String(value ?? '')
        .trim()
        .replace(/[^0-9.]/g, '');

    if (!text || text === '.') {
        return null;
    }

    const [whole, fraction = ''] = text.split('.');
    const units = Number(whole || 0);
    const parts = Number(`${fraction}00`.slice(0, 2));

    return Number.isFinite(units) && Number.isFinite(parts) ? units * 100 + parts : null;
};

/** "10.50" -> 1050. Null when there is nothing to read. */
export const centsFromAmount = hundredthsOf;

/** 1050 -> "10.50", for putting back in the input. */
export const amountFromCents = (cents) =>
    cents === null || cents === undefined ? '' : (cents / 100).toFixed(2);

/** "7.5" -> 750 basis points. */
export const bpsFromPercent = hundredthsOf;

/** 750 -> "7.5". Trailing zeros trimmed, so 7500 reads as "75", not "75.00". */
export const percentFromBps = (bps) => {
    if (bps === null || bps === undefined) {
        return '';
    }

    return String(Number((bps / 100).toFixed(2)));
};

/** Splits sorted by place, with anything unusable dropped. */
const cleanSplits = (splits) =>
    (Array.isArray(splits) ? splits : [])
        .map((split) => ({ rank: Number(split.rank), bps: Number(split.bps) }))
        .filter((split) => Number.isInteger(split.rank) && split.rank > 0 && split.bps > 0)
        .sort((a, b) => a.rank - b.rank);

/**
 * The pot, and what each PLACE is worth - before anyone is tied.
 *
 * Entrants are everyone who took a seat: waitlisted players never entered, so
 * they never paid. A player who dropped part-way did pay, and their buy-in
 * stays in the pot - which is what every paper event does too.
 *
 * @returns {{poolCents: number, places: Array, retainedCents: number, totalBps: number}}
 */
export const computePrizePool = ({ entryFeeCents, splits, entrantCount } = {}) => {
    const fee = Number(entryFeeCents) || 0;
    const entrants = Math.max(0, Number(entrantCount) || 0);
    const poolCents = fee * entrants;
    const cleaned = cleanSplits(splits);
    const totalBps = cleaned.reduce((sum, split) => sum + split.bps, 0);

    const places = cleaned.map((split) => ({
        rank: split.rank,
        bps: split.bps,
        // Floor every place, so the pot can never be over-allocated. The
        // rounding dust falls into what the organizer retains.
        amountCents: Math.floor((poolCents * split.bps) / FULL_SHARE)
    }));

    const awarded = places.reduce((sum, place) => sum + place.amountCents, 0);

    return {
        poolCents,
        places,
        // Whatever the splits do not hand out. Usually a deliberate cut for
        // the venue; sometimes just the rounding dust.
        retainedCents: poolCents - awarded,
        totalBps
    };
};

/**
 * Who actually gets paid, once the event has final placings.
 *
 * Ties are the part worth getting right, and this platform produces them:
 * computeFinalRanks shares a placing between players knocked out in the same
 * bracket round. The standard rule, and the one used here, is that players
 * sharing a placing POOL the prizes for the positions they occupy and split
 * them evenly - two players tied for 1st in a 75/20 event take 95% between
 * them, not 75% each and not 75% and 20%.
 *
 * @param {object} options
 * @param {number} options.entryFeeCents
 * @param {Array} options.splits
 * @param {Array} options.players every entrant, with `finalRank` where placed
 * @returns {{poolCents, retainedCents, payouts: Array, unallocatedCents: number}}
 */
export const computePayouts = ({ entryFeeCents, splits, players } = {}) => {
    const entrants = (players || []).filter((player) => !player.waitlisted);
    const pool = computePrizePool({
        entryFeeCents,
        splits,
        entrantCount: entrants.length
    });

    const amountForPlace = new Map(pool.places.map((place) => [place.rank, place.amountCents]));

    // Group by placing: everyone on the same finalRank shares.
    const byRank = new Map();

    for (const player of entrants) {
        const rank = Number(player.finalRank);

        if (!Number.isInteger(rank) || rank < 1) {
            continue;
        }

        if (!byRank.has(rank)) {
            byRank.set(rank, []);
        }

        byRank.get(rank).push(player);
    }

    const payouts = [];

    for (const [rank, tied] of [...byRank.entries()].sort((a, b) => a[0] - b[0])) {
        // The positions this group occupies: a two-way tie for 2nd takes up
        // 2nd and 3rd, so both of those prizes go into the group's pot.
        let groupCents = 0;

        for (let position = rank; position < rank + tied.length; position++) {
            groupCents += amountForPlace.get(position) || 0;
        }

        if (groupCents === 0) {
            continue;
        }

        // Even split, and the leftover pennies go one each from the top of a
        // stable order. Between tied players the choice is arbitrary by
        // definition - what matters is that it is the SAME every time the page
        // renders, and that the parts add up to the whole.
        const ordered = [...tied].sort((a, b) => Number(a.userId) - Number(b.userId));
        const each = Math.floor(groupCents / ordered.length);
        let remainder = groupCents - each * ordered.length;

        for (const player of ordered) {
            const extra = remainder > 0 ? 1 : 0;

            remainder -= extra;
            payouts.push({
                userId: player.userId,
                username: player.username,
                rank,
                sharedWith: ordered.length - 1,
                amountCents: each + extra
            });
        }
    }

    payouts.sort((a, b) => a.rank - b.rank || Number(a.userId) - Number(b.userId));

    const paid = payouts.reduce((sum, payout) => sum + payout.amountCents, 0);

    return {
        poolCents: pool.poolCents,
        retainedCents: pool.retainedCents,
        payouts,
        // Prizes for places nobody reached - a 3rd prize in a two-player
        // event. Surfaced rather than silently folded into the retainer, so
        // the organizer can see the table did not fully pay out.
        unallocatedCents: pool.poolCents - pool.retainedCents - paid
    };
};

/**
 * The rows a prize table shows, which are NOT the same before and after.
 *
 * Before the event settles, a row is a place and what that place is worth.
 * After it, a row is a person and what they are actually owed - and those two
 * lists have different shapes, because a shared placing pools the prizes for
 * the positions it occupies: two players tied for 1st in a 75/20 event take 95%
 * between them, occupying 1st AND 2nd. Rendering the promised table alongside
 * the settled one would show that 2nd-place prize twice, once inside the tie
 * and once beside an empty place.
 *
 * So this returns one list or the other, never a blend, and the caller renders
 * whatever it gets.
 *
 * @returns {{settled: boolean, rows: Array, poolCents, retainedCents, unallocatedCents}}
 */
export const prizeRows = ({ entryFeeCents, splits, players, finished } = {}) => {
    const entrants = (players || []).filter((player) => !player.waitlisted);
    const pool = computePrizePool({ entryFeeCents, splits, entrantCount: entrants.length });

    if (!finished) {
        return {
            settled: false,
            rows: cleanSplits(splits).map((split) => ({
                rank: split.rank,
                bps: split.bps,
                amountCents:
                    pool.places.find((place) => place.rank === split.rank)?.amountCents || 0
            })),
            poolCents: pool.poolCents,
            retainedCents: pool.retainedCents,
            unallocatedCents: 0
        };
    }

    const settled = computePayouts({ entryFeeCents, splits, players: entrants });
    const byRank = new Map();

    for (const payout of settled.payouts) {
        if (!byRank.has(payout.rank)) {
            byRank.set(payout.rank, { rank: payout.rank, winners: [] });
        }

        byRank.get(payout.rank).winners.push(payout);
    }

    return {
        settled: true,
        rows: [...byRank.values()].sort((a, b) => a.rank - b.rank),
        poolCents: settled.poolCents,
        retainedCents: settled.retainedCents,
        unallocatedCents: settled.unallocatedCents
    };
};

/**
 * The currencies a buy-in may be denominated in. Every one has exactly two
 * minor digits, because the whole calculation is integer cents - one that does
 * not (JPY, KRW) would be wrong by a factor of a hundred and look fine. Kept in
 * step with PRIZE_CURRENCIES in the tournament service, which is what actually
 * refuses anything else.
 */
export const PRIZE_CURRENCIES = [
    'USD',
    'EUR',
    'GBP',
    'CAD',
    'AUD',
    'NZD',
    'MXN',
    'BRL',
    'SEK',
    'NOK',
    'DKK',
    'PLN',
    'CZK',
    'ZAR'
];

/** "1st", "2nd", "3rd", "4th"... for naming a place in a prize table. */
export const ordinal = (rank) => {
    const value = Number(rank);

    if (!Number.isInteger(value) || value < 1) {
        return String(rank);
    }

    // 11th, 12th and 13th break the last-digit rule.
    const suffix =
        value % 100 >= 11 && value % 100 <= 13
            ? 'th'
            : { 1: 'st', 2: 'nd', 3: 'rd' }[value % 10] || 'th';

    return `${value}${suffix}`;
};

/** The presets that cover almost every local event. */
export const PRIZE_PRESETS = [
    { id: 'none', label: 'No prize pool', splits: [] },
    { id: 'winner', label: 'Winner takes all', splits: [{ rank: 1, bps: 10000 }] },
    {
        id: 'top2',
        label: 'Top 2 (75 / 25)',
        splits: [
            { rank: 1, bps: 7500 },
            { rank: 2, bps: 2500 }
        ]
    },
    {
        id: 'top2-cut',
        label: 'Top 2, 5% held back (75 / 20)',
        splits: [
            { rank: 1, bps: 7500 },
            { rank: 2, bps: 2000 }
        ]
    },
    {
        id: 'top3',
        label: 'Top 3 (50 / 30 / 20)',
        splits: [
            { rank: 1, bps: 5000 },
            { rank: 2, bps: 3000 },
            { rank: 3, bps: 2000 }
        ]
    },
    {
        id: 'top2-venue',
        label: 'Top 2 with 10% for the venue (65 / 25)',
        splits: [
            { rank: 1, bps: 6500 },
            { rank: 2, bps: 2500 }
        ]
    },
    { id: 'custom', label: 'Custom split…', splits: null }
];

/** The preset whose table matches these splits, or 'custom'. */
export const presetIdFor = (splits) => {
    const key = (list) =>
        (list || [])
            .map((split) => `${split.rank}:${split.bps}`)
            .sort()
            .join(',');
    const wanted = key(splits);
    const match = PRIZE_PRESETS.find((preset) => preset.splits && key(preset.splits) === wanted);

    return match ? match.id : 'custom';
};
