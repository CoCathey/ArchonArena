const {
    suggestedSwissRounds,
    pairSwissRound,
    pairEliminationRound,
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
    it('ranks by points then strength of schedule', function () {
        const players = [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }];
        const matches = [
            { player1: 1, player2: 4, winner: 1, round: 1 },
            { player1: 2, player2: 3, winner: 2, round: 1 },
            { player1: 1, player2: 2, winner: 1, round: 2 },
            { player1: 3, player2: 4, winner: 3, round: 2 }
        ];

        const standings = computeStandings(players, matches);

        expect(standings[0]).toMatchObject({ id: 1, points: 2, rank: 1 });
        // 2 and 3 both have 1 point; 2 beat 3 but SOS decides:
        // 2 played {3,1} (1+2=3 SOS), 3 played {2,4} (1+0=1 SOS)
        expect(standings[1]).toMatchObject({ id: 2, points: 1, sos: 3, rank: 2 });
        expect(standings[2]).toMatchObject({ id: 3, points: 1, sos: 1, rank: 3 });
        expect(standings[3]).toMatchObject({ id: 4, points: 0, rank: 4 });
    });

    it('counts byes as points but ranks played wins above them on ties', function () {
        const players = [{ id: 1 }, { id: 2 }, { id: 3 }];
        const matches = [
            { player1: 1, player2: null, winner: null, round: 1 }, // bye
            { player1: 2, player2: 3, winner: 2, round: 1 }
        ];

        const standings = computeStandings(players, matches);

        const first = standings.find((entry) => entry.id === 2);
        const second = standings.find((entry) => entry.id === 1);

        expect(first.points).toBe(1);
        expect(second.points).toBe(1);
        // 2's win came from play; SOS may be 0 for both (1 has no
        // opponents; 2's opponent has 0 points), so byes break the tie
        expect(first.rank).toBeLessThan(second.rank);
    });

    it('ignores matches for unknown players', function () {
        const standings = computeStandings(
            [{ id: 1 }],
            [{ player1: 99, player2: 98, winner: 99, round: 1 }]
        );

        expect(standings).toEqual([{ id: 1, points: 0, sos: 0, byes: 0, opponents: [], rank: 1 }]);
    });
});
