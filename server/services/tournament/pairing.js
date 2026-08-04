/**
 * Pure pairing logic for the tournament engine. No I/O, exhaustively
 * unit-tested — the same discipline as the Elo calculator.
 *
 * A player is { id, points, opponents: [ids], receivedBye: boolean }.
 * Points are match wins (KeyForge has no draws); byes count as wins.
 *
 * Elimination formats are generated as full bracket *templates* up
 * front: every match slot exists from the start, with source references
 * ("winner of match X" / "loser of match Y") that the service fills in
 * as results arrive. Byes are resolved inside the template so they
 * cascade correctly through both winners and losers brackets.
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
 * Games needed to take a best-of series.
 */
function matchWinsNeeded(bestOf) {
    return Math.floor((bestOf || 1) / 2) + 1;
}

/**
 * Reorder a seeded list (best first) into "fold" order: 1, n/2+1, 2,
 * n/2+2, ... Feeding this to pairSwissRound makes the seeded first
 * round pair top half vs bottom half (1 vs n/2+1), the chess/TCG
 * standard, instead of 1 vs 2.
 */
function foldOrder(players) {
    const half = Math.ceil(players.length / 2);
    const top = players.slice(0, half);
    const bottom = players.slice(half);
    const result = [];

    for (let index = 0; index < half; index++) {
        result.push(top[index]);
        if (bottom[index]) {
            result.push(bottom[index]);
        }
    }

    return result;
}

/**
 * How many candidate pairs the rematch-free search may examine before it
 * gives up and allows rematches.
 *
 * The search is exhaustive backtracking over perfect matchings, which is
 * super-exponential in the worst case. In practice it answers in
 * microseconds, because a Swiss field has only ever played a handful of
 * opponents each and the first candidate almost always works. The budget
 * exists for the case where it does not: a rematch-free matching that is
 * hard to find, or one that does not exist but only reveals that deep in
 * the tree. Pairing runs inside the lobby process, so "eventually" is not
 * an acceptable answer there - a bounded, slightly worse pairing is.
 */
const PAIRING_SEARCH_BUDGET = 200000;

/**
 * Pair a Swiss round.
 *
 * Players are sorted by points (then stable by input order, which the
 * caller seeds by standings or fold order). If the count is odd, the
 * lowest standing player who has not yet received a bye gets one.
 * Pairing then proceeds top-down preferring same-score opponents,
 * avoiding rematches via backtracking; if no rematch-free perfect
 * matching exists (small or late events), rematches are allowed as a
 * last resort and reported in `rematches`.
 *
 * @param {Array} players active (non-dropped) players
 * @returns {{ pairings: Array<[idA, idB]>, bye: id|null,
 *   rematches: Array<[idA, idB]>, exhausted: boolean }}
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

    const played = new Map(players.map((player) => [player.id, new Set(player.opponents || [])]));
    const havePlayed = (a, b) => played.get(a.id)?.has(b.id) || false;

    // Backtracking search for a rematch-free matching, preferring
    // opponents closest in standing order. `budget` is shared across the
    // whole search by reference; running it down aborts rather than
    // returning a wrong answer, and the caller falls back.
    const searchPairings = (remaining, allowRematch, budget) => {
        if (remaining.length === 0) {
            return [];
        }

        const [first, ...rest] = remaining;

        for (let index = 0; index < rest.length; index++) {
            if (budget.left <= 0) {
                return null;
            }
            budget.left--;

            const candidate = rest[index];

            if (!allowRematch && havePlayed(first, candidate)) {
                continue;
            }

            const nextRemaining = rest.filter((_, i) => i !== index);
            const solution = searchPairings(nextRemaining, allowRematch, budget);

            if (solution !== null) {
                return [[first.id, candidate.id], ...solution];
            }
        }

        return null;
    };

    const budget = { left: PAIRING_SEARCH_BUDGET };
    let pairings = searchPairings(toPair, false, budget);
    const exhausted = pairings === null && budget.left <= 0;

    if (pairings === null) {
        // Either no rematch-free matching exists, or finding one would
        // cost more than the budget allows. Both mean the same thing to
        // the round: pair anyway, and say which pairs are repeats so the
        // organizer can see it rather than discover it at the table.
        pairings = searchPairings(toPair, true, { left: Infinity }) || [];
    }

    const byId = new Map(players.map((player) => [player.id, player]));
    const rematches = pairings.filter(([a, b]) => havePlayed(byId.get(a), byId.get(b)));

    return { pairings, bye, rematches, exhausted };
}

/**
 * Pair a single-elimination round from the ordered list of remaining
 * players (best standing first). Standard seeding: 1 plays the lowest
 * remaining seed, 2 the next lowest, and so on; with a non-power-of-two
 * count the top seeds receive byes.
 *
 * Retained for events created before bracket templates existed; new
 * events use buildSingleElimBracket / buildDoubleElimBracket.
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
 * Standard bracket seed placement order for a power-of-two bracket:
 * the sequence of seed numbers reading first-round slots top to bottom,
 * so seed 1 meets seed 2 only in the final (1 v size, then 2 v size-1
 * in the opposite half, and so on).
 *
 * seedPlacementOrder(4) -> [1, 4, 2, 3]
 * seedPlacementOrder(8) -> [1, 8, 4, 5, 2, 7, 3, 6]
 */
function seedPlacementOrder(size) {
    let order = [1];

    while (order.length < size) {
        const doubled = [];
        const target = order.length * 2;

        for (const seed of order) {
            doubled.push(seed);
            doubled.push(target + 1 - seed);
        }

        order = doubled;
    }

    return order;
}

const nextPowerOfTwo = (count) => {
    let size = 1;
    while (size < count) {
        size *= 2;
    }
    return size;
};

/**
 * Internal: resolve byes through a bracket template.
 *
 * Matches are processed in wave order. A participant is a player id, a
 * BYE marker, or a source reference; when a source's match resolves as
 * a bye walkover (or is removed entirely), the reference collapses to
 * the concrete player / BYE. Matches with one real player become
 * walkovers (byeWinner set); matches between two byes are removed and
 * propagate BYE onwards.
 */
function resolveByes(matches) {
    const BYE = Symbol('bye');
    const resolution = new Map(); // key -> { winner, loser } of player id | BYE | null

    const resolveSide = (side) => {
        if (side === null || side === undefined) {
            return BYE;
        }

        if (typeof side === 'object' && side.sourceKey) {
            const source = resolution.get(side.sourceKey);

            if (!source) {
                return side; // source match will really be played
            }

            return side.isLoser ? source.loser : source.winner;
        }

        return side; // concrete player id
    };

    const ordered = [...matches].sort((a, b) => a.round - b.round || a.pos - b.pos);
    const kept = [];

    for (const match of ordered) {
        const p1 = resolveSide(match.player1);
        const p2 = resolveSide(match.player2);

        const p1IsBye = p1 === BYE;
        const p2IsBye = p2 === BYE;

        if (p1IsBye && p2IsBye) {
            // Nobody here: drop the match and pass the bye through.
            resolution.set(match.key, { winner: BYE, loser: BYE });
            continue;
        }

        if (p1IsBye || p2IsBye) {
            const real = p1IsBye ? p2 : p1;

            if (typeof real === 'object' && real.sourceKey) {
                // Real side is still "winner of X": keep the match as a
                // pending walkover — the service resolves it when the
                // source match completes (slot fills, opponent stays
                // empty, auto-win applies).
                kept.push({
                    ...match,
                    player1: real,
                    player2: null,
                    pendingWalkover: true
                });
                continue;
            }

            // Immediate walkover for a known player.
            resolution.set(match.key, { winner: real, loser: BYE });
            kept.push({ ...match, player1: real, player2: null, byeWinner: real });
            continue;
        }

        // Two real (or to-be-determined) sides: a normal match.
        kept.push({ ...match, player1: p1, player2: p2 });
    }

    return kept;
}

/**
 * Build a full single-elimination bracket template.
 *
 * @param {Array<{id}>} seededPlayers best seed first
 * @returns {Array} template matches: { key, bracket: 'W', bracketRound,
 *   round (gating wave), pos, player1, player2, byeWinner?,
 *   pendingWalkover? } where playerN is an id, null, or a source ref
 *   { sourceKey, isLoser }.
 */
function buildSingleElimBracket(seededPlayers) {
    const count = seededPlayers.length;

    if (count < 2) {
        return [];
    }

    const size = nextPowerOfTwo(count);
    const rounds = Math.log2(size);
    const placement = seedPlacementOrder(size);
    const bySlot = placement.map((seed) => (seed <= count ? seededPlayers[seed - 1].id : null));

    const matches = [];

    // Round 1 from seed placement; later rounds reference earlier ones.
    for (let round = 1; round <= rounds; round++) {
        const matchCount = size / Math.pow(2, round);

        for (let pos = 0; pos < matchCount; pos++) {
            const key = `W${round}-${pos}`;

            if (round === 1) {
                matches.push({
                    key,
                    bracket: 'W',
                    bracketRound: round,
                    round,
                    pos,
                    player1: bySlot[pos * 2],
                    player2: bySlot[pos * 2 + 1]
                });
            } else {
                matches.push({
                    key,
                    bracket: 'W',
                    bracketRound: round,
                    round,
                    pos,
                    player1: { sourceKey: `W${round - 1}-${pos * 2}`, isLoser: false },
                    player2: { sourceKey: `W${round - 1}-${pos * 2 + 1}`, isLoser: false }
                });
            }
        }
    }

    return resolveByes(matches);
}

/**
 * Build a full double-elimination bracket template: winners bracket,
 * losers bracket with alternating minor/major rounds (majors reverse
 * their drop-in order on odd rounds to delay rematches), and a grand
 * final. The grand final reset (bracket 'GF', bracketRound 2) is NOT
 * pre-created; the service adds it if the losers side wins GF1.
 *
 * Waves (gating rounds): W round r at wave r; L round j at wave j + 1;
 * grand final after everything else.
 *
 * @param {Array<{id}>} seededPlayers best seed first
 */
function buildDoubleElimBracket(seededPlayers) {
    const count = seededPlayers.length;

    if (count < 2) {
        return [];
    }

    const size = nextPowerOfTwo(count);
    const k = Math.log2(size);
    const placement = seedPlacementOrder(size);
    const bySlot = placement.map((seed) => (seed <= count ? seededPlayers[seed - 1].id : null));

    const matches = [];

    // Winners bracket (same shape as single elim).
    for (let round = 1; round <= k; round++) {
        const matchCount = size / Math.pow(2, round);

        for (let pos = 0; pos < matchCount; pos++) {
            const key = `W${round}-${pos}`;

            matches.push({
                key,
                bracket: 'W',
                bracketRound: round,
                round,
                pos,
                player1:
                    round === 1
                        ? bySlot[pos * 2]
                        : { sourceKey: `W${round - 1}-${pos * 2}`, isLoser: false },
                player2:
                    round === 1
                        ? bySlot[pos * 2 + 1]
                        : { sourceKey: `W${round - 1}-${pos * 2 + 1}`, isLoser: false }
            });
        }
    }

    // Losers bracket: 2(k-1) rounds for k >= 2.
    // L1: W1 losers pair (adjacent). Even rounds 2m are "majors" where
    // W(m+1) losers drop in against the previous L round's winners; odd
    // rounds (>= 3) are "minors" pairing L winners among themselves.
    const lRounds = k >= 2 ? 2 * (k - 1) : 0;

    for (let j = 1; j <= lRounds; j++) {
        const wave = j + 1;

        if (j === 1) {
            const matchCount = size / 4;

            for (let pos = 0; pos < matchCount; pos++) {
                matches.push({
                    key: `L1-${pos}`,
                    bracket: 'L',
                    bracketRound: 1,
                    round: wave,
                    pos,
                    player1: { sourceKey: `W1-${pos * 2}`, isLoser: true },
                    player2: { sourceKey: `W1-${pos * 2 + 1}`, isLoser: true }
                });
            }
        } else if (j % 2 === 0) {
            // Major round: winners of L(j-1) vs losers of W(j/2 + 1).
            const m = j / 2;
            const wRound = m + 1;
            const matchCount = size / Math.pow(2, m + 1);

            for (let pos = 0; pos < matchCount; pos++) {
                // Reverse the drop-in order on odd majors so players
                // from the same winners-bracket path meet as late as
                // possible.
                const dropPos = m % 2 === 1 ? matchCount - 1 - pos : pos;

                matches.push({
                    key: `L${j}-${pos}`,
                    bracket: 'L',
                    bracketRound: j,
                    round: wave,
                    pos,
                    player1: { sourceKey: `W${wRound}-${dropPos}`, isLoser: true },
                    player2: { sourceKey: `L${j - 1}-${pos}`, isLoser: false }
                });
            }
        } else {
            // Minor round: winners of L(j-1) pair adjacently.
            const m = (j - 1) / 2;
            const matchCount = size / Math.pow(2, m + 2);

            for (let pos = 0; pos < matchCount; pos++) {
                matches.push({
                    key: `L${j}-${pos}`,
                    bracket: 'L',
                    bracketRound: j,
                    round: wave,
                    pos,
                    player1: { sourceKey: `L${j - 1}-${pos * 2}`, isLoser: false },
                    player2: { sourceKey: `L${j - 1}-${pos * 2 + 1}`, isLoser: false }
                });
            }
        }
    }

    // Grand final: winners champion vs losers champion.
    const gfWave = (k >= 2 ? lRounds + 1 : k) + 1;

    matches.push({
        key: 'GF-0',
        bracket: 'GF',
        bracketRound: 1,
        round: gfWave,
        pos: 0,
        player1: { sourceKey: `W${k}-0`, isLoser: false },
        player2:
            k >= 2
                ? { sourceKey: `L${lRounds}-0`, isLoser: false }
                : { sourceKey: `W${k}-0`, isLoser: true }
    });

    return resolveByes(matches);
}

/**
 * Full round-robin schedule via the circle method: n-1 rounds (n even;
 * odd n adds a bye slot). Every player meets every other exactly once.
 *
 * @param {Array<{id}>} players
 * @returns {Array<{ round, pairings: Array<[idA, idB]>, bye: id|null }>}
 */
function roundRobinSchedule(players) {
    const ids = players.map((player) => player.id);

    if (ids.length < 2) {
        return [];
    }

    if (ids.length % 2 === 1) {
        ids.push(null); // bye slot
    }

    const rounds = [];
    const fixed = ids[0];
    let rotating = ids.slice(1);

    for (let round = 1; round < ids.length; round++) {
        const left = [fixed, ...rotating.slice(0, rotating.length / 2)];
        const right = [...rotating.slice(rotating.length / 2)].reverse();

        const pairings = [];
        let bye = null;

        for (let index = 0; index < left.length; index++) {
            const a = left[index];
            const b = right[index];

            if (a === null) {
                bye = b;
            } else if (b === null) {
                bye = a;
            } else {
                pairings.push([a, b]);
            }
        }

        rounds.push({ round, pairings, bye });

        // Rotate clockwise, keeping the first seat fixed.
        rotating = [rotating[rotating.length - 1], ...rotating.slice(0, rotating.length - 1)];
    }

    return rounds;
}

/**
 * The floor applied to any single opponent's win percentage before it is
 * averaged into a tiebreaker.
 *
 * Without it, drawing the player who went 0-5 and dropped would wreck
 * your tiebreakers through no fault of your own - you cannot choose your
 * opponents, so a system that punishes you for theirs is measuring the
 * wrong thing. One third is the long-standing TCG convention.
 */
const MIN_OPPONENT_WIN_RATE = 1 / 3;

/**
 * Standings from completed matches.
 *
 * Order is match points, then the three standard TCG tiebreakers:
 *
 *   1. **OMW%** - opponents' match-win percentage. The average of each
 *      opponent's match-win rate, every one floored at 33%. This is the
 *      "was your road hard" measure, and it is a *percentage* rather than
 *      a sum of opponents' points for a reason: once players have byes,
 *      drops and unequal match counts, a sum silently rewards whoever
 *      happened to face busier opponents.
 *   2. **GW%** - your own game-win percentage, which separates a 2-0
 *      match win from a 2-1 in best-of-three events.
 *   3. **OGW%** - opponents' game-win percentage, same floor.
 *
 * Byes are excluded from the opponent averages (you cannot be credited
 * or punished for a round you did not play), but they do count as a match
 * win for your own points and record. Players who dropped stay in the
 * calculation with their final record, because the games they played
 * really happened and their opponents earned those results.
 *
 * Fewest byes remains as the last resort, so a played win outranks a
 * received one when everything else is identical.
 *
 * @param {Array<{id}>} players
 * @param {Array<{player1, player2, winner, round, p1Wins, p2Wins,
 *        doubleLoss}>} matches (player2 null = bye)
 */
function computeStandings(players, matches) {
    const stats = {};
    for (const player of players) {
        stats[player.id] = {
            points: 0,
            byes: 0,
            opponents: [],
            wins: 0,
            losses: 0,
            gameWins: 0,
            gameLosses: 0
        };
    }

    for (const match of matches) {
        if (!match.player1 || !stats[match.player1]) {
            continue;
        }

        if (!match.player2) {
            // A bye/walkover row is an auto-win for its lone player.
            stats[match.player1].points += 1;
            stats[match.player1].wins += 1;
            stats[match.player1].byes += 1;
            stats[match.player1].gameWins += match.p1Wins || 1;
            continue;
        }

        if (!stats[match.player2]) {
            continue;
        }

        const decided = match.winner || match.doubleLoss;

        if (!decided) {
            continue;
        }

        stats[match.player1].opponents.push(match.player2);
        stats[match.player2].opponents.push(match.player1);

        const p1Games = match.p1Wins || (match.winner === match.player1 ? 1 : 0);
        const p2Games = match.p2Wins || (match.winner === match.player2 ? 1 : 0);

        stats[match.player1].gameWins += p1Games;
        stats[match.player1].gameLosses += p2Games;
        stats[match.player2].gameWins += p2Games;
        stats[match.player2].gameLosses += p1Games;

        if (match.winner && stats[match.winner]) {
            stats[match.winner].points += 1;
            stats[match.winner].wins += 1;

            const loser = match.winner === match.player1 ? match.player2 : match.player1;
            stats[loser].losses += 1;
        } else if (match.doubleLoss) {
            stats[match.player1].losses += 1;
            stats[match.player2].losses += 1;
        }
    }

    // Each player's own rates first - the opponent averages are built
    // from these. A bye counts as a match win here, the same way it counts
    // for points: it is a round the player was awarded. What byes are kept
    // out of is the *opponent* averages below, and they are, because a bye
    // never puts anyone in `opponents`.
    const rateOf = (id) => {
        const own = stats[id];

        if (!own) {
            return { matchRate: 0, gameRate: 0 };
        }

        const decidedMatches = own.wins + own.losses;
        const games = own.gameWins + own.gameLosses;

        return {
            matchRate: decidedMatches > 0 ? own.wins / decidedMatches : 0,
            gameRate: games > 0 ? own.gameWins / games : 0
        };
    };

    const ratesById = {};
    for (const player of players) {
        ratesById[player.id] = rateOf(player.id);
    }

    const averageOpponent = (opponents, pick) => {
        if (opponents.length === 0) {
            // Nobody played yet, or every round so far was a bye. Zero
            // rather than the floor: this is "no information", and
            // handing it a third of a win would outrank players who
            // actually beat somebody weak.
            return 0;
        }

        const total = opponents.reduce((sum, opponent) => {
            const rate = ratesById[opponent] ? pick(ratesById[opponent]) : 0;

            return sum + Math.max(rate, MIN_OPPONENT_WIN_RATE);
        }, 0);

        return total / opponents.length;
    };

    const entries = players.map((player) => {
        const own = stats[player.id];
        const rates = ratesById[player.id];

        return {
            id: player.id,
            points: own.points,
            byes: own.byes,
            opponents: own.opponents,
            wins: own.wins,
            losses: own.losses,
            gameWins: own.gameWins,
            gameLosses: own.gameLosses,
            matchWinRate: rates.matchRate,
            gameWinRate: rates.gameRate,
            opponentMatchWinRate: averageOpponent(own.opponents, (rate) => rate.matchRate),
            opponentGameWinRate: averageOpponent(own.opponents, (rate) => rate.gameRate)
        };
    });

    entries.sort(
        (a, b) =>
            b.points - a.points ||
            b.opponentMatchWinRate - a.opponentMatchWinRate ||
            b.gameWinRate - a.gameWinRate ||
            b.opponentGameWinRate - a.opponentGameWinRate ||
            a.byes - b.byes
    );

    return entries.map((entry, index) => ({ ...entry, rank: index + 1 }));
}

module.exports = {
    MIN_OPPONENT_WIN_RATE,
    PAIRING_SEARCH_BUDGET,
    suggestedSwissRounds,
    matchWinsNeeded,
    foldOrder,
    pairSwissRound,
    pairEliminationRound,
    seedPlacementOrder,
    buildSingleElimBracket,
    buildDoubleElimBracket,
    roundRobinSchedule,
    computeStandings
};
