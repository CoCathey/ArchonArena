import { playerNeedsInput, shouldHideHand } from '../../client/Components/GameBoard/handVisibility';

/**
 * ARCHON: hiding your own hand on the opponent's turn.
 *
 * The setting itself is trivial - draw the cards or do not. What is worth
 * testing is when NOT to hide them, because getting that wrong strands a
 * player on a prompt about a card they can no longer see, in the middle of a
 * game, with a clock running.
 *
 * So the rule fails towards showing, and these are the cases it has to get
 * right rather than a description of what it does.
 */
describe('hand visibility on the opponent turn', function () {
    const hide = (overrides) =>
        shouldHideHand({
            enabled: true,
            isMyTurn: false,
            isPeeking: false,
            needsInput: false,
            ...overrides
        });

    // The whole point of the feature.
    it('hides the hand while the opponent plays', function () {
        expect(hide({})).toBe(true);
    });

    it('does nothing at all unless the player turned it on', function () {
        expect(hide({ enabled: false })).toBe(false);
        expect(shouldHideHand({})).toBe(false);
        expect(shouldHideHand()).toBe(false);
    });

    it('never hides the hand on your own turn', function () {
        expect(hide({ isMyTurn: true })).toBe(false);
    });

    /**
     * The case that would make this feature harmful rather than merely
     * unwanted: during the opponent's turn a player can still be asked to
     * discard, to choose, to answer a reaction - and every one of those can be
     * about a card in hand.
     */
    it('puts the hand back the moment the game asks the player something', function () {
        expect(hide({ needsInput: true })).toBe(false);
    });

    it('shows the hand while the player is peeking at it', function () {
        expect(hide({ isPeeking: true })).toBe(false);
    });

    describe('what counts as being asked something', function () {
        it('does not count waiting on the opponent', function () {
            // What uiprompt.js hands a waiting player, and nothing else.
            expect(playerNeedsInput({ menuTitle: 'Waiting for opponent' })).toBe(false);
            expect(playerNeedsInput({})).toBe(false);
            expect(playerNeedsInput()).toBe(false);
        });

        it('counts a card selection', function () {
            expect(playerNeedsInput({ selectCard: true })).toBe(true);
        });

        it('counts buttons and controls', function () {
            expect(playerNeedsInput({ buttons: [{ text: 'Done' }] })).toBe(true);
            expect(playerNeedsInput({ controls: [{ type: 'targeting' }] })).toBe(true);
        });

        // Belt and braces for a prompt shape that marks the cards rather than
        // setting selectCard - the hand must not be hidden underneath it.
        it('counts a selectable or selected card in hand', function () {
            expect(
                playerNeedsInput({ cardPiles: { hand: [{ id: 1 }, { id: 2, selectable: true }] } })
            ).toBe(true);
            expect(playerNeedsInput({ cardPiles: { hand: [{ id: 1, selected: true }] } })).toBe(
                true
            );
            expect(playerNeedsInput({ cardPiles: { hand: [{ id: 1 }, { id: 2 }] } })).toBe(false);
        });

        it('survives a player state that has no hand yet', function () {
            expect(playerNeedsInput({ cardPiles: {} })).toBe(false);
        });
    });

    // The two halves together, as the board actually asks the question.
    it('shows a mulliganing player their hand, though it is not their turn', function () {
        const mulliganing = { buttons: [{ text: 'Mulligan' }, { text: 'Keep' }] };

        expect(hide({ needsInput: playerNeedsInput(mulliganing) })).toBe(false);
    });

    it('hides it again once they are only watching', function () {
        const watching = { menuTitle: 'Waiting for opponent' };

        expect(hide({ needsInput: playerNeedsInput(watching) })).toBe(true);
    });
});
