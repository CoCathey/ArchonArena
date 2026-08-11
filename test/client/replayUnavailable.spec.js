const { replayUnavailable } = require('../../client/Components/GameBoard/replayUnavailable');

/**
 * ARCHON: "replays don't work".
 *
 * That report was unactionable because the page said the same sentence for
 * every cause - a game recorded before the feature existed, a capture over the
 * size limit, recording switched off, a server whose replay table was never
 * created, and (now) somebody else's game. Each has a different next step for
 * whoever is reading it, and one of them is not even a player's problem.
 */
describe('replayUnavailable', function () {
    const reasons = [
        'not-your-game',
        'recording-disabled',
        'storage-missing',
        'no-such-game',
        'not-recorded'
    ];

    it('says something different for every reason the server gives', function () {
        const messages = reasons.map((reason) => replayUnavailable({ data: { reason } }).key);

        expect(new Set(messages).size).toBe(reasons.length);
        expect(messages.every((message) => message.length > 0)).toBe(true);
    });

    // The one case where the reader can do something about it themselves.
    it('only offers the share-link hint when the game is not theirs', function () {
        expect(replayUnavailable({ data: { reason: 'not-your-game' } }).isOwnershipProblem).toBe(
            true
        );

        for (const reason of reasons.filter((r) => r !== 'not-your-game')) {
            expect(replayUnavailable({ data: { reason } }).isOwnershipProblem).toBe(false);
        }
    });

    // This one is an operator problem, and the wording has to send the reader
    // to an administrator rather than leave them thinking their game was lost.
    it('points a missing replay table at an administrator', function () {
        expect(replayUnavailable({ data: { reason: 'storage-missing' } }).key).toMatch(
            /administrator/i
        );
    });

    it('falls back to the old sentence when the server said nothing useful', function () {
        for (const error of [undefined, {}, { data: {} }, { data: { reason: 'something-new' } }]) {
            const outcome = replayUnavailable(error);

            expect(outcome.key).toBe('No replay is available for this game.');
            expect(outcome.isOwnershipProblem).toBe(false);
        }
    });
});
