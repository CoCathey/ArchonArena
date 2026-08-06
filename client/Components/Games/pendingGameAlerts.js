/**
 * Works out whether a change to a pending game's player list is the moment the
 * game filled up - the point at which the players (and only the players) get an
 * audible cue, and whoever was waiting gets a desktop notification.
 *
 * This lives outside the component because it is the whole substance of the
 * behaviour and it is easy to get subtly wrong: the original guard looked for a
 * 1 -> 2 transition, which never happens for a Quick Match because the
 * matchmaker builds the game with both players already in it and the client
 * sees 0 -> 2. That made matchmade games silent.
 *
 * @param {object} args
 * @param {object} args.game - the current pending game, as sent by the server
 * @param {string} args.username - the logged-in user's name
 * @param {number} args.previousPlayerCount - player count from the last render
 * @returns {{ opponent: object, notify: boolean, body: string }|null}
 *   null when nothing should happen; otherwise the cue should play, and a
 *   desktop notification should be shown when `notify` is set.
 */
export function getPendingGameJoinAlert({ game, username, previousPlayerCount }) {
    if (!game || !username) {
        return null;
    }

    const players = Object.values(game.players || {});

    // Spectators are not participants - the cue is for the two people who are
    // about to play, not everyone who happened to open the game.
    if (!players.some((player) => player.name === username)) {
        return null;
    }

    // Fire on the arrival at two rather than on a particular transition, so
    // both the 1 -> 2 of someone joining and the 0 -> 2 of a matchmade game
    // count, and neither fires twice.
    if (players.length !== 2 || previousPlayerCount >= 2) {
        return null;
    }

    const opponent = players.find((player) => player.name !== username);

    if (!opponent) {
        return null;
    }

    // Only the player who was actually waiting on someone wants the browser to
    // interrupt them: in a Quick Match that is both of them, otherwise it is the
    // host. Whoever clicked Join is already looking at this screen.
    const wasWaiting = !!game.quickMatch || game.owner === username;

    return {
        opponent,
        notify: wasWaiting,
        body: game.quickMatch
            ? `${opponent.name} is your Quick Match opponent`
            : `${opponent.name} has joined your game`
    };
}
