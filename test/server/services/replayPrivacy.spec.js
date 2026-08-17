const { stripReplayHands, replayPlayerNames } = require('../../../server/services/replayPrivacy');

/**
 * ARCHON (F3): who may read the hands inside a recording.
 *
 * The board frames are spectator-safe by construction; the recorded hands are
 * not, and this module is the whole of what keeps them from the wrong reader.
 * The properties that matter: stripping removes every trace (not just the
 * obvious key), keeping one player's hand does not smuggle the other's cards
 * out through the shared table, and the function never modifies the recording
 * it was given - the same object is served to different readers.
 */
describe('replay hand privacy', function () {
    /** A v4 recording: two players, two frames, hands referencing the table. */
    const recording = () => ({
        version: 4,
        players: [{ name: 'alice' }, { name: 'bob' }],
        cards: [{ id: 'troll', name: 'Troll', type: 'creature' }],
        handCards: [
            { id: 'ganger-chieftain', name: 'Ganger Chieftain' },
            { id: 'urchin', name: 'Urchin' },
            { id: 'dust-pixie', name: 'Dust Pixie' }
        ],
        snapshots: [
            {
                messageIndex: 3,
                board: { round: 1, activePlayer: 'alice', players: [] },
                hands: { alice: [0], bob: [1, 2] }
            },
            {
                messageIndex: 8,
                board: { round: 1, activePlayer: 'bob', players: [] },
                hands: { alice: [0, 1], bob: [2] }
            }
        ]
    });

    it('stripping everything leaves no trace of either hand', function () {
        const stripped = stripReplayHands(recording());
        const serialised = JSON.stringify(stripped);

        expect(serialised).not.toContain('Ganger Chieftain');
        expect(serialised).not.toContain('Urchin');
        expect(serialised).not.toContain('Dust Pixie');
        expect(serialised).not.toContain('hands');
        expect(stripped.handCards).toBeUndefined();
        // The board frames and public table are untouched.
        expect(stripped.snapshots.length).toBe(2);
        expect(stripped.snapshots[0].board.round).toBe(1);
        expect(stripped.cards[0].name).toBe('Troll');
    });

    it('keeping one player keeps their hand at every frame, and only theirs', function () {
        const stripped = stripReplayHands(recording(), ['bob']);

        expect(stripped.snapshots[0].hands.alice).toBeUndefined();
        expect(stripped.snapshots[1].hands.alice).toBeUndefined();
        expect(stripped.snapshots[0].hands.bob.length).toBe(2);
        expect(stripped.snapshots[1].hands.bob.length).toBe(1);
    });

    // The subtle leak this module exists to prevent: keep alice's hand naively
    // and the table still ships bob's drawn-but-never-played cards.
    it('rebuilds the hand table so the other player leaves nothing behind', function () {
        const stripped = stripReplayHands(recording(), ['alice']);
        const serialised = JSON.stringify(stripped);

        expect(serialised).not.toContain('Dust Pixie');

        // And the kept entries were remapped to match the rebuilt table: the
        // second frame's alice holds Ganger Chieftain and Urchin.
        const names = stripped.snapshots[1].hands.alice.map(
            (entry) => stripped.handCards[entry].name
        );

        expect(names).toEqual(['Ganger Chieftain', 'Urchin']);
    });

    it('does not modify the recording it was given', function () {
        const replay = recording();
        const before = JSON.stringify(replay);

        stripReplayHands(replay, ['alice']);
        stripReplayHands(replay);

        expect(JSON.stringify(replay)).toBe(before);
    });

    it('passes a pre-v4 recording through untouched', function () {
        const replay = {
            version: 3,
            players: [{ name: 'alice' }],
            cards: [],
            snapshots: [{ messageIndex: 1, board: { round: 1, players: [] } }]
        };

        const stripped = stripReplayHands(replay);

        expect(stripped.snapshots).toEqual(replay.snapshots);
        expect(stripped.handCards).toBeUndefined();
    });

    it('drops a malformed hand entry rather than serving it', function () {
        const replay = recording();

        replay.snapshots[0].hands.bob = [1, 99, -2, 'nonsense', null];

        const names = stripReplayHands(replay, ['bob']).snapshots[0].hands.bob.map(
            (entry) => entry
        );

        expect(names.length).toBe(1);
    });

    it('keeps admin reads whole: both names, both hands', function () {
        const replay = recording();
        const stripped = stripReplayHands(replay, replayPlayerNames(replay));

        expect(stripped.snapshots[0].hands.alice.length).toBe(1);
        expect(stripped.snapshots[0].hands.bob.length).toBe(2);

        const bobNames = stripped.snapshots[0].hands.bob.map(
            (entry) => stripped.handCards[entry].name
        );

        expect(bobNames).toEqual(['Urchin', 'Dust Pixie']);
    });

    // ARCHON (F3): v6 records the owner's archives beside the hands - one
    // side channel, one set of rules, one strip.
    it('strips and keeps recorded archives under exactly the hand rules', function () {
        const replay = recording();

        replay.snapshots[0].archives = { alice: [1], bob: [2] };

        const strippedAll = stripReplayHands(replay);

        expect(JSON.stringify(strippedAll.snapshots)).not.toContain('Urchin');
        expect(strippedAll.snapshots[0].archives).toBeUndefined();

        const aliceOnly = stripReplayHands(replay, ['alice']);

        expect(aliceOnly.snapshots[0].archives.bob).toBeUndefined();
        expect(
            aliceOnly.snapshots[0].archives.alice.map((entry) => aliceOnly.handCards[entry].name)
        ).toEqual(['Urchin']);
        // The one table serves both zones, rebuilt without bob's cards.
        expect(JSON.stringify(aliceOnly)).not.toContain('Dust Pixie');
    });
});
