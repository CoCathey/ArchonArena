/**
 * Pure pairing logic for the tournament engine. No I/O, exhaustively
 * unit-tested — the same discipline as the Elo calculator.
 *
 * A player is { id, points, opponents: [ids], receivedBye: boolean }.
 * Points are match wins (KeyForge has no draws); byes count as wins.
 */

/**
 * Recommended Swiss round count for a player count (ceil(log2(n)),
 * minimum 1).
 */
function suggestedSwissRounds(playerCount) {
    if (playerCount <= 1) {
        return 1;
    }

    return Math.max(1, Math.ceil(Math.log2(playerCount)));
}

/**
 * Pair a Swiss round.
 *
 * Players are sorted by points (then stable by input order, which the
 * caller seeds by registration/rating). If the count is odd, the lowest
 * standing player who has not yet received a bye gets one. Pairing then
 * proceeds top-down preferring same-score opponents, avoiding rematches
 * via backtracking; if no rematch-free perfect matching exists (small or
 * late events), rematches are allowed as a last resort.
 *
 * @param {Array} players active (non-dropped) players
 * @returns {{ pairings: Array<[idA, idB]>, bye: id|null }}
 */
function pairSwissRound(players) {
    const sorted = [...players].sort((a, b) => b.points - a.points);

    let bye = null;
    let toPair = sorted;

    if (sorted.length % 2 === 1) {
        // Lowest-standing player without a previous bye; if everyone has
        // had one, the lowest-standing player gets a second.
        const byeCandidate =
            [...sorted].reverse().find((player) => !player.receivedBye) ||
            sorted[sorted.length - 1];
        bye = byeCandidate.id;
        toPair = sorted.filter((player) => player.id !== bye);
    }

    const havePlayed = (a, b) => (a.opponents || []).includes(b.id);

    // Backtracking search for a rematch-free matching, preferring
    // opponents closest in standing order.
    const searchPairings = (remaining, allowRematch) => {
        if (remaining.length === 0) {
            return [];
        }

        const [first, ...rest] = remaining;

        for (let index = 0; index < rest.length; index++) {
            const candidate = rest[index];

            if (!allowRematch && havePlayed(first, candidate)) {
                continue;
            }

            const nextRemaining = rest.filter((_, i) => i !== index);
            const solution = searchPairings(nextRemaining, allowRematch);

            if (solution !== null) {
                return [[first.id, candidate.id], ...solution];
            }
        }

        return null;
    };

    const pairings = searchPairings(toPair, false) || searchPairings(toPair, true) || [];

    return { pairings, bye };
}

/**
 * Pair a single-elimination round from the ordered list of remaining
 * players (best standing first). Standard seeding: 1 plays the lowest
 * remaining seed, 2 the next lowest, and so on; with a non-power-of-two
 * count the top seeds receive byes.
 *
 * @param {Array<{id}>} seededPlayers remaining players, best seed first
 * @returns {{ pairings: Array<[idA, idB]>, byes: Array<id> }}
 */
function pairEliminationRound(seededPlayers) {
    const count = seededPlayers.length;

    if (count <= 1) {
        return { pairings: [], byes: seededPlayers.map((player) => player.id) };
    }

    let bracketSize = 1;
    while (bracketSize < count) {
        bracketSize *= 2;
    }

    const byeCount = bracketSize - count;
    const byes = seededPlayers.slice(0, byeCount).map((player) => player.id);
    const playing = seededPlayers.slice(byeCount);

    const pairings = [];
    for (let index = 0; index < playing.length / 2; index++) {
        pairings.push([playing[index].id, playing[playing.length - 1 - index].id]);
    }

    return { pairings, byes };
}

/**
 * Standings from completed matches: points (wins, byes included), then
 * strength of schedule (sum of opponents' points), then fewest byes so a
 * played win outranks a received one.
 *
 * @param {Array<{id}>} players
 * @param {Array<{player1, player2, winner, round}>} matches
 *        (player2 null = bye)
 */
function computeStandings(players, matches) {
    const stats = {};
    for (const player of players) {
        stats[player.id] = { points: 0, byes: 0, opponents: [] };
    }

    for (const match of matches) {
        if (!stats[match.player1]) {
            continue;
        }

        if (!match.player2) {
            stats[match.player1].points += 1;
            stats[match.player1].byes += 1;
            continue;
        }

        if (!stats[match.player2]) {
            continue;
        }

        stats[match.player1].opponents.push(match.player2);
        stats[match.player2].opponents.push(match.player1);

        if (match.winner && stats[match.winner]) {
            stats[match.winner].points += 1;
        }
    }

    const entries = players.map((player) => {
        const own = stats[player.id];
        const sos = own.opponents.reduce(
            (total, opponent) => total + (stats[opponent]?.points || 0),
            0
        );

        return {
            id: player.id,
            points: own.points,
            sos: sos,
            byes: own.byes,
            opponents: own.opponents
        };
    });

    entries.sort((a, b) => b.points - a.points || b.sos - a.sos || a.byes - b.byes);

    return entries.map((entry, index) => ({ ...entry, rank: index + 1 }));
}

module.exports = {
    suggestedSwissRounds,
    pairSwissRound,
    pairEliminationRound,
    computeStandings
};
