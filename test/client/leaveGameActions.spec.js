import { leaveGameActions } from '../../client/Components/GameBoard/leaveGame';

/**
 * ARCHON: "Leave Game" (GameContextMenu) and "Back to Lobby" (GameResultPanel,
 * on the post-game result screen) both have to take the player out of a game
 * over both sockets - if the game socket is dead, only the lobby socket gets
 * them out. That sequence used to be written once in GameContextMenu and
 * would have been duplicated verbatim to add a second exit point; this is the
 * one place it is written now, and both call sites depend on it agreeing with
 * itself.
 */
describe('leaveGameActions', function () {
    it('sends leavegame and closes the game, without conceding, when not conceding', function () {
        const actions = leaveGameActions('game-1', false);

        expect(
            actions.some((a) => a.type === 'game/sendMessage' && a.payload.message === 'concede')
        ).toBe(false);
        expect(
            actions.some((a) => a.type === 'game/sendMessage' && a.payload.message === 'leavegame')
        ).toBe(true);
        expect(actions[actions.length - 1].type).toBe('game/closeRequested');
    });

    it('concedes before leaving when conceding', function () {
        const actions = leaveGameActions('game-1', true);

        expect(actions[0].type).toBe('game/sendMessage');
        expect(actions[0].payload.message).toBe('concede');

        const leaveIndex = actions.findIndex(
            (a) => a.type === 'game/sendMessage' && a.payload.message === 'leavegame'
        );
        const concedeIndex = actions.findIndex(
            (a) => a.type === 'game/sendMessage' && a.payload.message === 'concede'
        );

        expect(concedeIndex).toBeLessThan(leaveIndex);
    });

    it('tells the lobby socket which game to drop when a gameId is known', function () {
        const actions = leaveGameActions('game-42', false);
        const lobbyLeave = actions.find((a) => a.type === 'lobby/leaveGameRequested');

        expect(lobbyLeave).toBeDefined();
        expect(lobbyLeave.payload.gameId).toBe('game-42');
    });

    it('never emits a lobby leave with no game to leave', function () {
        for (const gameId of [undefined, null, '']) {
            const actions = leaveGameActions(gameId, false);

            expect(actions.some((a) => a.type === 'lobby/leaveGameRequested')).toBe(false);
        }
    });

    it('always ends by closing the game socket, last', function () {
        for (const conceding of [true, false]) {
            const actions = leaveGameActions('game-1', conceding);

            expect(actions[actions.length - 1].type).toBe('game/closeRequested');
        }
    });
});
