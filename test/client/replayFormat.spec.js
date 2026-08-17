import {
    boardAtStep,
    handsAtStep,
    hydrateBoard,
    hydrateCard,
    hydratePile,
    snapshotAtStep
} from '../../client/replayFormat';

/**
 * ARCHON: reading a recording, whichever version wrote it.
 *
 * Board frames changed shape when the capture was made compact - piles became
 * references into a card table held once for the whole recording, which is what
 * brought a game's recording under the store limit and got replays saved at
 * all. Recordings written before that are still in the database and still have
 * to draw, so both formats are read here.
 */
describe('replay format', function () {
    const cards = [
        {
            id: 'troll',
            name: 'Troll',
            image: 'troll',
            number: '048',
            house: 'brobnar',
            type: 'creature',
            power: 8
        },
        {
            id: 'anger',
            name: 'Anger',
            image: 'anger',
            number: '053',
            house: 'brobnar',
            type: 'action'
        },
        { facedown: true, cardback: 'cardback' }
    ];

    describe('hydrateCard', function () {
        it('resolves a pile reference into something the card renderer can draw', function () {
            const card = hydrateCard(0, cards, 'discard');

            expect(card.name).toBe('Troll');
            expect(card.image).toBe('troll');
            // The renderer reads the long names the live game state uses.
            expect(card.printedHouse).toBe('brobnar');
            expect(card.powerPrinted).toBe(8);
            expect(card.location).toBe('discard');
        });

        it('keeps the live state of a card in play alongside its identity', function () {
            const card = hydrateCard(
                { card: 0, uuid: 'abc', exhausted: true, power: 11, tokens: { damage: 2 } },
                cards,
                'play area'
            );

            expect(card.name).toBe('Troll');
            expect(card.uuid).toBe('abc');
            expect(card.exhausted).toBe(true);
            // Power under an effect wins over the printed value.
            expect(card.modifiedPower).toBe(11);
            expect(card.tokens.damage).toBe(2);
        });

        it('falls back to the printed power when nothing changed it', function () {
            expect(hydrateCard({ card: 0, uuid: 'abc' }, cards, 'play area').modifiedPower).toBe(8);
        });

        it('resolves upgrades on a creature', function () {
            const card = hydrateCard(
                { card: 0, uuid: 'abc', upgrades: [{ card: 1, uuid: 'def' }] },
                cards,
                'play area'
            );

            expect(card.childCards.length).toBe(1);
            expect(card.childCards[0].name).toBe('Anger');
        });

        it('reads a version 2 entry, which held the whole summary inline', function () {
            const card = hydrateCard({ name: 'Troll', image: 'troll' }, [], 'discard');

            expect(card.name).toBe('Troll');
            expect(card.location).toBe('discard');
        });

        // A card the reader was never allowed to see stays that way.
        it('carries a face-down card through as face-down', function () {
            expect(hydrateCard(2, cards, 'archives').facedown).toBe(true);
        });

        it('drops a reference to a card that is not in the table', function () {
            expect(hydrateCard(99, cards, 'discard')).toBe(null);
            expect(hydratePile([0, 99, 1], cards, 'discard').length).toBe(2);
        });
    });

    describe('hydrateBoard', function () {
        const board = {
            round: 3,
            activePlayer: 'alice',
            players: [
                {
                    name: 'alice',
                    cardPiles: {
                        cardsInPlay: [{ card: 0, uuid: 'a' }],
                        discard: [1],
                        purged: [],
                        archives: [2]
                    }
                }
            ]
        };

        it('resolves every pile', function () {
            const resolved = hydrateBoard(board, cards);

            expect(resolved.players[0].cardPiles.cardsInPlay[0].name).toBe('Troll');
            expect(resolved.players[0].cardPiles.discard[0].name).toBe('Anger');
            expect(resolved.players[0].cardPiles.archives[0].facedown).toBe(true);
            expect(resolved.round).toBe(3);
        });

        it('is null rather than a broken board when there is nothing to draw', function () {
            expect(hydrateBoard(null, cards)).toBe(null);
            expect(hydrateBoard({}, cards)).toBe(null);
        });
    });

    describe('boardAtStep', function () {
        const snapshots = [
            { messageIndex: 5, board: { round: 1 } },
            { messageIndex: 12, board: { round: 2 } },
            { messageIndex: 30, board: { round: 3 } }
        ];

        it('shows the last board recorded at or before the position', function () {
            expect(boardAtStep(snapshots, 12).round).toBe(2);
            expect(boardAtStep(snapshots, 20).round).toBe(2);
            expect(boardAtStep(snapshots, 999).round).toBe(3);
        });

        // It used to fall back to the first frame, which drew a board from
        // later in the game than the log the reader was looking at.
        it('shows nothing before the first recorded board', function () {
            expect(boardAtStep(snapshots, 0)).toBe(null);
            expect(boardAtStep(snapshots, 4)).toBe(null);
        });

        it('copes with a recording that has no boards at all', function () {
            expect(boardAtStep([], 10)).toBe(null);
            expect(boardAtStep(undefined, 10)).toBe(null);
        });
    });

    // ARCHON (F3): the recorded hands, resolved for the hand pile the viewer
    // draws. Whatever the server let this reader have is what arrives here -
    // their own hand, both for an admin, none on a share link - so the only
    // jobs are picking the right frame and resolving the hand-card table.
    describe('handsAtStep', function () {
        const handCards = [
            { id: 'anger', name: 'Anger', image: 'anger', house: 'brobnar', type: 'action' },
            { id: 'troll', name: 'Troll', image: 'troll', house: 'brobnar', type: 'creature' }
        ];
        const snapshots = [
            { messageIndex: 5, board: { round: 1 }, hands: { alice: [0, 1] } },
            { messageIndex: 12, board: { round: 2 }, hands: { alice: [1] } },
            // An older frame shape with no hands at all.
            { messageIndex: 30, board: { round: 3 } }
        ];

        it('resolves the hand recorded at or before the position', function () {
            const hands = handsAtStep(snapshots, 7, handCards);

            expect(hands.alice.length).toBe(2);
            expect(hands.alice[0].name).toBe('Anger');
            expect(hands.alice[0].location).toBe('hand');
            expect(handsAtStep(snapshots, 12, handCards).alice[0].name).toBe('Troll');
        });

        it('is empty before the first frame, and on frames with no hands', function () {
            expect(handsAtStep(snapshots, 2, handCards)).toEqual({});
            expect(handsAtStep(snapshots, 40, handCards)).toEqual({});
            expect(handsAtStep(undefined, 10, handCards)).toEqual({});
        });

        it('drops a hand entry the table does not have rather than drawing a hole', function () {
            const hands = handsAtStep(
                [{ messageIndex: 1, hands: { alice: [0, 99] } }],
                5,
                handCards
            );

            expect(hands.alice.length).toBe(1);
        });

        it('snapshotAtStep hands the whole frame over, board and hands together', function () {
            const frame = snapshotAtStep(snapshots, 12);

            expect(frame.board.round).toBe(2);
            expect(frame.hands.alice).toEqual([1]);
        });
    });
});
