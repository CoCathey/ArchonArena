import {
    gameCloseRequested,
    gameSendMessage,
    lobbyLeaveGameRequested
} from '../../redux/socketActions';

/**
 * ARCHON: the actions that take a player out of a game and back to the
 * lobby, over both sockets. GameContextMenu's "Leave Game" and
 * GameResultPanel's "Back to Lobby" both need exactly this sequence, so it
 * is written once here instead of twice.
 *
 * The game-socket emit is the normal path, but if that socket is dead (the
 * player was stranded at an unresponsive board) it goes nowhere - so
 * `leavegame` also goes out over the independent, still-alive lobby socket.
 * That guarantees the player can always escape, and lets the server tear the
 * game down instead of leaving a ghost in the lobby list.
 *
 * @param {string|undefined} gameId
 * @param {boolean} conceding whether to concede before leaving - only
 *   meaningful mid-game; a finished game has already decided its winner.
 * @returns {object[]} redux actions, in the order they must dispatch
 */
export function leaveGameActions(gameId, conceding) {
    const actions = [];

    if (conceding) {
        actions.push(gameSendMessage('concede'));
    }

    actions.push(gameSendMessage('leavegame'));

    if (gameId) {
        actions.push(lobbyLeaveGameRequested(gameId));
    }

    actions.push(gameCloseRequested());

    return actions;
}
