import { findKeyForges, orderPlayersForPerspective } from '../../client/replayMarkers';

describe('findKeyForges', function () {
    const snapshot = (messageIndex, keysByPlayer) => ({
        messageIndex,
        board: {
            players: Object.entries(keysByPlayer).map(([name, keys]) => ({
                name,
                stats: { keys }
            }))
        }
    });

    it('reports each point where a player key count went up', function () {
        const forges = findKeyForges([
            snapshot(0, { alice: 0, bob: 0 }),
            snapshot(12, { alice: 1, bob: 0 }),
            snapshot(30, { alice: 1, bob: 1 }),
            snapshot(48, { alice: 2, bob: 1 })
        ]);

        expect(forges).toEqual([
            { messageIndex: 12, player: 'alice', keys: 1 },
            { messageIndex: 30, player: 'bob', keys: 1 },
            { messageIndex: 48, player: 'alice', keys: 2 }
        ]);
    });

    it('treats the first snapshot as a baseline, not a forge', function () {
        // A game with starting keys - or a recording that began late - would
        // otherwise open with a forge that never happened.
        expect(findKeyForges([snapshot(0, { alice: 2 })])).toEqual([]);
    });

    it('ignores a key count going down', function () {
        // Keys can be stolen or lost; that is not a forge.
        const forges = findKeyForges([
            snapshot(0, { alice: 2 }),
            snapshot(5, { alice: 1 }),
            snapshot(9, { alice: 2 })
        ]);

        expect(forges).toEqual([{ messageIndex: 9, player: 'alice', keys: 2 }]);
    });

    it('returns nothing for a version 1 recording with no snapshots', function () {
        expect(findKeyForges([])).toEqual([]);
        expect(findKeyForges(undefined)).toEqual([]);
    });

    it('skips malformed snapshots instead of throwing', function () {
        const forges = findKeyForges([
            { messageIndex: 1 },
            { messageIndex: 2, board: {} },
            { messageIndex: 3, board: { players: [{ name: 'alice' }] } },
            snapshot(4, { alice: 0 }),
            snapshot(5, { alice: 1 })
        ]);

        expect(forges).toEqual([{ messageIndex: 5, player: 'alice', keys: 1 }]);
    });
});

describe('orderPlayersForPerspective', function () {
    const players = [{ name: 'alice' }, { name: 'bob' }];

    it('puts the chosen player last, where your own side of the table is', function () {
        expect(orderPlayersForPerspective(players, 'alice').map((p) => p.name)).toEqual([
            'bob',
            'alice'
        ]);
    });

    it('leaves the order alone when the player is already last', function () {
        expect(orderPlayersForPerspective(players, 'bob').map((p) => p.name)).toEqual([
            'alice',
            'bob'
        ]);
    });

    it('leaves the board intact for a name that is not in this game', function () {
        // A perspective left over from another replay must not blank the board.
        expect(orderPlayersForPerspective(players, 'carol')).toBe(players);
        expect(orderPlayersForPerspective(players, null)).toBe(players);
        expect(orderPlayersForPerspective(undefined, 'alice')).toBeUndefined();
    });
});
