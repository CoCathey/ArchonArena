const {
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
} = require('../../../../server/services/tournament/pairing');

const player = (id, points = 0, opponents = [], receivedBye = false) => ({
    id,
    points,
    opponents,
    receivedBye
});

describe('suggestedSwissRounds', function () {
    it('uses ceil(log2(n))', function () {
        expect(suggestedSwissRounds(2)).toBe(1);
        expect(suggestedSwissRounds(4)).toBe(2);
        expect(suggestedSwissRounds(8)).toBe(3);
        expect(suggestedSwissRounds(9)).toBe(4);
        expect(suggestedSwissRounds(16)).toBe(4);
        expect(suggestedSwissRounds(1)).toBe(1);
    });
});

describe('pairSwissRound', function () {
    it('pairs an even field with no byes', function () {
        const { pairings, bye } = pairSwissRound([player(1), player(2), player(3), player(4)]);

        expect(bye).toBeNull();
        expect(pairings.length).toBe(2);

        const paired = pairings.flat().sort();
        expect(paired).toEqual([1, 2, 3, 4]);
    });

    it('gives the bye to the lowest player without one', function () {
        const { pairings, bye } = pairSwissRound([
            player(1, 2),
            player(2, 1),
            player(3, 0, [], true), // lowest but already had a bye
            player(4, 1),
            player(5, 0)
        ]);

        expect(bye).toBe(5);
        expect(pairings.length).toBe(2);
        expect(pairings.flat()).not.toContain(5);
    });

    it('allows a second bye when everyone has had one', function () {
        const { bye } = pairSwissRound([
            player(1, 2, [], true),
            player(2, 1, [], true),
            player(3, 0, [], true)
        ]);

        expect(bye).toBe(3);
    });

    it('pairs within score groups when possible', function () {
        const { pairings } = pairSwissRound([
            player(1, 1),
            player(2, 1),
            player(3, 0),
            player(4, 0)
        ]);

        const asSets = pairings.map((pair) => [...pair].sort().join('-'));
        expect(asSets).toContain('1-2');
        expect(asSets).toContain('3-4');
    });

    it('avoids rematches via backtracking', function () {
        // 1 has already played 2; the only rematch-free perfect matching
        // is 1-3 / 2-4 even though 1-2 are both on 1 point.
        const { pairings } = pairSwissRound([
            player(1, 1, [2]),
            player(2, 1, [1]),
            player(3, 0, []),
            player(4, 0, [])
        ]);

        const asSets = pairings.map((pair) => [...pair].sort().join('-'));
        expect(asSets).not.toContain('1-2');
        expect(pairings.length).toBe(2);
    });

    it('falls back to rematches when no clean matching exists', function () {
        // Everyone has played everyone: a rematch is unavoidable.
        const { pairings } = pairSwissRound([
            player(1, 2, [2, 3, 4]),
            player(2, 1, [1, 3, 4]),
            player(3, 1, [1, 2, 4]),
            player(4, 0, [1, 2, 3])
        ]);

        expect(pairings.length).toBe(2);
        expect(pairings.flat().sort()).toEqual([1, 2, 3, 4]);
    });

    it('handles two players and one player', function () {
        expect(pairSwissRound([player(1), player(2)]).pairings).toEqual([[1, 2]]);

        const solo = pairSwissRound([player(1)]);
        expect(solo.pairings).toEqual([]);
        expect(solo.bye).toBe(1);
    });

    it('reports which pairs are repeats when it has to allow them', function () {
        const { pairings, rematches } = pairSwissRound([
            player(1, 2, [2, 3, 4]),
            player(2, 1, [1, 3, 4]),
            player(3, 1, [1, 2, 4]),
            player(4, 0, [1, 2, 3])
        ]);

        expect(pairings.length).toBe(2);
        // Every pair here is a repeat, and the organizer is told so
        // rather than finding out when the players sit down.
        expect(rematches.length).toBe(2);
    });

    it('reports no repeats on a clean pairing', function () {
        const { rematches, exhausted } = pairSwissRound([
            player(1, 1, []),
            player(2, 1, []),
            player(3, 0, []),
            player(4, 0, [])
        ]);

        expect(rematches).toEqual([]);
        expect(exhausted).toBe(false);
    });

    // The search is exhaustive backtracking, which has no natural bound.
    // Pairing runs inside the lobby process, so a round that takes
    // "however long it takes" is a stalled server, not a slow pairing.
    it('pairs a large late-round field promptly', function () {
        const size = 64;
        const players = Array.from({ length: size }, (_, index) => {
            // Each player has met the eight nearest players in standing
            // order, which is roughly what eight Swiss rounds produce.
            const opponents = [];
            for (let step = 1; step <= 8; step++) {
                opponents.push(((index + step) % size) + 1);
                opponents.push(((index - step + size) % size) + 1);
            }

            return player(index + 1, Math.floor((size - index) / 2), opponents);
        });

        const started = Date.now();
        const { pairings } = pairSwissRound(players);
        const elapsed = Date.now() - started;

        expect(pairings.length).toBe(size / 2);
        expect(pairings.flat().sort((a, b) => a - b)).toEqual(
            Array.from({ length: size }, (_, index) => index + 1)
        );
        expect(elapsed).toBeLessThan(2000);
    });

    it('still returns a complete pairing when the search budget runs out', function () {
        // Forced through the budget path directly: whatever the search
        // did or did not manage, every player must still be seated.
        const size = 16;
        const players = Array.from({ length: size }, (_, index) =>
            player(
                index + 1,
                0,
                // Everyone has played everyone below them, leaving a very
                // constrained graph.
                Array.from({ length: index }, (_, other) => other + 1)
            )
        );

        const { pairings, bye } = pairSwissRound(players);

        expect(bye).toBe(null);
        expect(pairings.length).toBe(size / 2);
        expect(new Set(pairings.flat()).size).toBe(size);
    });
});

describe('pairEliminationRound', function () {
    const seeds = (count) => Array.from({ length: count }, (_, index) => ({ id: index + 1 }));

    it('pairs a power-of-two field high vs low', function () {
        const { pairings, byes } = pairEliminationRound(seeds(8));

        expect(byes).toEqual([]);
        expect(pairings).toEqual([
            [1, 8],
            [2, 7],
            [3, 6],
            [4, 5]
        ]);
    });

    it('gives byes to top seeds on a non power of two', function () {
        const { pairings, byes } = pairEliminationRound(seeds(6));

        expect(byes).toEqual([1, 2]);
        expect(pairings).toEqual([
            [3, 6],
            [4, 5]
        ]);
    });

    it('handles the final and a solo winner', function () {
        expect(pairEliminationRound(seeds(2)).pairings).toEqual([[1, 2]]);
        expect(pairEliminationRound(seeds(1)).byes).toEqual([1]);
    });
});

describe('computeStandings', function () {
    it("ranks by points then opponents' match-win percentage", function () {
        const players = [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }];
        const matches = [
            { player1: 1, player2: 4, winner: 1, round: 1 },
            { player1: 2, player2: 3, winner: 2, round: 1 },
            { player1: 1, player2: 2, winner: 1, round: 2 },
            { player1: 3, player2: 4, winner: 3, round: 2 }
        ];

        const standings = computeStandings(players, matches);

        expect(standings[0]).toMatchObject({ id: 1, points: 2, rank: 1 });

        // 2 and 3 both finish 1-1. 2 faced {3 (1-1), 1 (2-0)} -> (0.5+1)/2.
        // 3 faced {2 (1-1), 4 (0-2, floored to 1/3)} -> (0.5+1/3)/2.
        const second = standings[1];
        const third = standings[2];

        expect(second.id).toBe(2);
        expect(second.opponentMatchWinRate).toBeCloseTo(0.75, 6);
        expect(third.id).toBe(3);
        expect(third.opponentMatchWinRate).toBeCloseTo((0.5 + 1 / 3) / 2, 6);
        expect(standings[3]).toMatchObject({ id: 4, points: 0, rank: 4 });
    });

    it('floors any single opponent at a third of a win', function () {
        // 2 lost every match. Without the floor 1's OMW% would be 0 -
        // below a player whose opponent merely went 1-3, which would
        // punish 1 for a draw they did not choose.
        const players = [{ id: 1 }, { id: 2 }];
        const matches = [
            { player1: 1, player2: 2, winner: 1, round: 1 },
            { player1: 1, player2: 2, winner: 1, round: 2 }
        ];

        const standings = computeStandings(players, matches);
        const one = standings.find((entry) => entry.id === 1);

        expect(one.opponentMatchWinRate).toBeCloseTo(1 / 3, 6);
    });

    it('keeps byes out of the opponent averages but counts them as wins', function () {
        const players = [{ id: 1 }, { id: 2 }, { id: 3 }];
        const matches = [
            { player1: 1, player2: null, winner: null, round: 1 }, // bye
            { player1: 2, player2: 3, winner: 2, round: 1 }
        ];

        const standings = computeStandings(players, matches);
        const byePlayer = standings.find((entry) => entry.id === 1);
        const winner = standings.find((entry) => entry.id === 2);

        expect(byePlayer.points).toBe(1);
        expect(winner.points).toBe(1);

        // The bye put nobody in the opponent list, so there is nothing to
        // average and no opponent to be credited for.
        expect(byePlayer.opponents).toEqual([]);
        expect(byePlayer.opponentMatchWinRate).toBe(0);

        // 2 beat somebody, even somebody winless, so their OMW% is the
        // floor - which outranks having faced nobody at all.
        expect(winner.opponentMatchWinRate).toBeCloseTo(1 / 3, 6);
        expect(winner.rank).toBeLessThan(byePlayer.rank);
    });

    it('ignores matches for unknown players', function () {
        const standings = computeStandings(
            [{ id: 1 }],
            [{ player1: 99, player2: 98, winner: 99, round: 1 }]
        );

        expect(standings.length).toBe(1);
        expect(standings[0]).toMatchObject({
            id: 1,
            points: 0,
            byes: 0,
            opponents: [],
            opponentMatchWinRate: 0,
            rank: 1
        });
    });

    it('breaks points and OMW% ties by the player’s own game-win percentage', function () {
        // 1 and 3 both go 1-0 against a single 0-1 opponent, so their
        // OMW% is identical (both floored). 1 won 2-0 where 3 won 2-1.
        const players = [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }];
        const matches = [
            { player1: 1, player2: 2, winner: 1, round: 1, p1Wins: 2, p2Wins: 0 },
            { player1: 3, player2: 4, winner: 3, round: 1, p1Wins: 2, p2Wins: 1 }
        ];

        const standings = computeStandings(players, matches);
        const one = standings.find((entry) => entry.id === 1);
        const three = standings.find((entry) => entry.id === 3);

        expect(one.points).toBe(three.points);
        expect(one.opponentMatchWinRate).toBeCloseTo(three.opponentMatchWinRate, 6);
        expect(one.gameWinRate).toBeCloseTo(1, 6);
        expect(three.gameWinRate).toBeCloseTo(2 / 3, 6);
        expect(one.rank).toBeLessThan(three.rank);
    });

    it("breaks a further tie by opponents' game-win percentage", function () {
        // 1 and 3 each beat a single opponent 2-0, and both those
        // opponents go on to finish 1-1 - so points, OMW% and GW% are all
        // identical. The only difference left is how many *games* those
        // opponents won: 2 sweeps its other match, 4 drops a game.
        const players = [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }, { id: 5 }, { id: 6 }];
        const matches = [
            { player1: 1, player2: 2, winner: 1, round: 1, p1Wins: 2, p2Wins: 0 },
            { player1: 3, player2: 4, winner: 3, round: 1, p1Wins: 2, p2Wins: 0 },
            { player1: 2, player2: 5, winner: 2, round: 2, p1Wins: 2, p2Wins: 0 },
            { player1: 4, player2: 6, winner: 4, round: 2, p1Wins: 2, p2Wins: 1 }
        ];

        const standings = computeStandings(players, matches);
        const one = standings.find((entry) => entry.id === 1);
        const three = standings.find((entry) => entry.id === 3);

        expect(one.points).toBe(three.points);
        expect(one.opponentMatchWinRate).toBeCloseTo(three.opponentMatchWinRate, 6);
        expect(one.gameWinRate).toBeCloseTo(three.gameWinRate, 6);
        // Both are clear of the floor, so the difference actually shows.
        expect(one.opponentGameWinRate).toBeCloseTo(0.5, 6);
        expect(three.opponentGameWinRate).toBeCloseTo(0.4, 6);
        expect(one.rank).toBeLessThan(three.rank);
    });

    it('tracks match records, series game counts and double losses', function () {
        const players = [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }];
        const matches = [
            { player1: 1, player2: 2, winner: 1, round: 1, p1Wins: 2, p2Wins: 1 },
            { player1: 3, player2: 4, winner: null, round: 1, doubleLoss: true }
        ];

        const standings = computeStandings(players, matches);
        const one = standings.find((entry) => entry.id === 1);
        const two = standings.find((entry) => entry.id === 2);
        const three = standings.find((entry) => entry.id === 3);

        expect(one).toMatchObject({ wins: 1, losses: 0, gameWins: 2, gameLosses: 1, points: 1 });
        expect(two).toMatchObject({ wins: 0, losses: 1, gameWins: 1, gameLosses: 2, points: 0 });
        // Double loss: no points for either side, both take a match loss,
        // and they still count as opponents for SOS purposes.
        expect(three).toMatchObject({ wins: 0, losses: 1, points: 0 });
        expect(three.opponents).toContain(4);
    });
});

describe('matchWinsNeeded', function () {
    it('computes series clinch counts', function () {
        expect(matchWinsNeeded(1)).toBe(1);
        expect(matchWinsNeeded(3)).toBe(2);
        expect(matchWinsNeeded(5)).toBe(3);
        expect(matchWinsNeeded(undefined)).toBe(1);
    });
});

describe('foldOrder', function () {
    it('interleaves top and bottom halves', function () {
        const players = [1, 2, 3, 4, 5, 6].map((id) => ({ id }));

        expect(foldOrder(players).map((player) => player.id)).toEqual([1, 4, 2, 5, 3, 6]);
    });

    it('keeps the middle player adjacent on odd counts', function () {
        const players = [1, 2, 3, 4, 5].map((id) => ({ id }));

        expect(foldOrder(players).map((player) => player.id)).toEqual([1, 4, 2, 5, 3]);
    });

    it('makes seeded swiss round 1 pair top half vs bottom half', function () {
        const folded = foldOrder(
            [1, 2, 3, 4].map((id) => ({ id, points: 0, opponents: [], receivedBye: false }))
        );
        const { pairings } = pairSwissRound(folded);

        const asSets = pairings.map((pair) => [...pair].sort().join('-'));
        expect(asSets).toContain('1-3');
        expect(asSets).toContain('2-4');
    });
});

describe('seedPlacementOrder', function () {
    it('produces the standard bracket orders', function () {
        expect(seedPlacementOrder(2)).toEqual([1, 2]);
        expect(seedPlacementOrder(4)).toEqual([1, 4, 2, 3]);
        expect(seedPlacementOrder(8)).toEqual([1, 8, 4, 5, 2, 7, 3, 6]);
    });
});

describe('buildSingleElimBracket', function () {
    const seeds = (count) => Array.from({ length: count }, (_, index) => ({ id: index + 1 }));

    it('builds a full power-of-two bracket with source references', function () {
        const matches = buildSingleElimBracket(seeds(8));

        const round1 = matches.filter((match) => match.bracketRound === 1);
        const round2 = matches.filter((match) => match.bracketRound === 2);
        const final = matches.filter((match) => match.bracketRound === 3);

        expect(round1.length).toBe(4);
        expect(round2.length).toBe(2);
        expect(final.length).toBe(1);

        expect(round1[0]).toMatchObject({ player1: 1, player2: 8, round: 1 });
        expect(round1[1]).toMatchObject({ player1: 4, player2: 5 });
        expect(round2[0].player1).toMatchObject({ sourceKey: 'W1-0', isLoser: false });
        expect(round2[0].player2).toMatchObject({ sourceKey: 'W1-1', isLoser: false });
        expect(final[0].round).toBe(3);
    });

    it('resolves byes so top seeds walk over and later slots prefill', function () {
        const matches = buildSingleElimBracket(seeds(5));

        // Seeds 6-8 are byes: 1, 2, 3 walk over; 4 v 5 is the only real
        // round-1 match; 2 v 3 materializes immediately in round 2.
        const walkovers = matches.filter((match) => match.byeWinner);
        expect(walkovers.map((match) => match.byeWinner).sort()).toEqual([1, 2, 3]);

        const real1 = matches.filter((match) => match.bracketRound === 1 && !match.byeWinner);
        expect(real1.length).toBe(1);
        expect(real1[0]).toMatchObject({ player1: 4, player2: 5 });

        const prefilled = matches.find(
            (match) => match.bracketRound === 2 && match.player1 === 2 && match.player2 === 3
        );
        expect(prefilled).toBeTruthy();

        const semiWithSource = matches.find(
            (match) => match.bracketRound === 2 && match.player1 === 1
        );
        expect(semiWithSource.player2).toMatchObject({ sourceKey: 'W1-1' });
    });

    it('returns nothing for fields below two players', function () {
        expect(buildSingleElimBracket(seeds(1))).toEqual([]);
        expect(buildSingleElimBracket([])).toEqual([]);
    });
});

describe('buildDoubleElimBracket', function () {
    const seeds = (count) => Array.from({ length: count }, (_, index) => ({ id: index + 1 }));

    it('builds winners, losers and grand final for 8 players', function () {
        const matches = buildDoubleElimBracket(seeds(8));

        const w = matches.filter((match) => match.bracket === 'W');
        const l = matches.filter((match) => match.bracket === 'L');
        const gf = matches.filter((match) => match.bracket === 'GF');

        // 7 W matches, 6 L matches (2+2+1+1), 1 GF = 14; a 8-player
        // double elim plays 14 or 15 matches (with reset).
        expect(w.length).toBe(7);
        expect(l.length).toBe(6);
        expect(gf.length).toBe(1);

        // L1 pairs W1 losers; L2 (major) takes W2 losers reversed.
        const l1 = l.filter((match) => match.bracketRound === 1);
        expect(l1[0].player1).toMatchObject({ sourceKey: 'W1-0', isLoser: true });
        expect(l1[0].player2).toMatchObject({ sourceKey: 'W1-1', isLoser: true });

        const l2 = l.filter((match) => match.bracketRound === 2);
        expect(l2[0].player1).toMatchObject({ sourceKey: 'W2-1', isLoser: true });
        expect(l2[1].player1).toMatchObject({ sourceKey: 'W2-0', isLoser: true });

        // Waves: W1=1, W2=2, W3=3; L1=2, L2=3, L3=4, L4=5; GF=6.
        expect(w.find((match) => match.key === 'W3-0').round).toBe(3);
        expect(l.find((match) => match.key === 'L4-0').round).toBe(5);
        expect(gf[0].round).toBe(6);
        expect(gf[0].player1).toMatchObject({ sourceKey: 'W3-0', isLoser: false });
        expect(gf[0].player2).toMatchObject({ sourceKey: 'L4-0', isLoser: false });
    });

    it('handles two players as winners final plus grand final', function () {
        const matches = buildDoubleElimBracket(seeds(2));

        expect(matches.length).toBe(2);
        expect(matches[0]).toMatchObject({ bracket: 'W', player1: 1, player2: 2 });
        expect(matches[1].bracket).toBe('GF');
        expect(matches[1].player1).toMatchObject({ sourceKey: 'W1-0', isLoser: false });
        expect(matches[1].player2).toMatchObject({ sourceKey: 'W1-0', isLoser: true });
    });

    it('cascades byes through the losers bracket', function () {
        // 3 players in a 4 bracket: seed 1 walks over W1-0; L1-0 gets
        // the W1-0 loser (a bye) vs the W1-1 loser -> pending walkover
        // for the W1-1 loser.
        const matches = buildDoubleElimBracket(seeds(3));

        const walkover = matches.find((match) => match.byeWinner === 1);
        expect(walkover).toBeTruthy();

        const l1 = matches.find((match) => match.key === 'L1-0');
        expect(l1.pendingWalkover).toBe(true);
        expect(l1.player1).toMatchObject({ sourceKey: 'W1-1', isLoser: true });
        expect(l1.player2).toBeNull();

        // With both W1 matches resolved as byes (2 players in a 4
        // bracket after drops), L1 vanishes entirely.
        const two = buildDoubleElimBracket([{ id: 1 }, { id: 2 }]);
        expect(two.filter((match) => match.bracket === 'L').length).toBe(0);
    });
});

describe('roundRobinSchedule', function () {
    it('schedules everyone against everyone exactly once', function () {
        const players = [1, 2, 3, 4].map((id) => ({ id }));
        const rounds = roundRobinSchedule(players);

        expect(rounds.length).toBe(3);

        const seen = {};
        for (const round of rounds) {
            expect(round.pairings.length).toBe(2);
            expect(round.bye).toBeNull();

            for (const [a, b] of round.pairings) {
                const key = [a, b].sort().join('-');
                expect(seen[key]).toBeUndefined();
                seen[key] = true;
            }
        }

        expect(Object.keys(seen).length).toBe(6); // C(4,2)
    });

    it('gives each player exactly one bye on odd counts', function () {
        const players = [1, 2, 3, 4, 5].map((id) => ({ id }));
        const rounds = roundRobinSchedule(players);

        expect(rounds.length).toBe(5);

        const byes = rounds.map((round) => round.bye).sort();
        expect(byes).toEqual([1, 2, 3, 4, 5]);

        const seen = {};
        for (const round of rounds) {
            for (const [a, b] of round.pairings) {
                seen[[a, b].sort().join('-')] = true;
            }
        }
        expect(Object.keys(seen).length).toBe(10); // C(5,2)
    });

    it('returns nothing below two players', function () {
        expect(roundRobinSchedule([{ id: 1 }])).toEqual([]);
    });
});
