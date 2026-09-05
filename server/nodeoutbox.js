/**
 * ARCHON (N10): the durable outbox shared by both ends of `nodemessage`.
 *
 * The node writes here before publishing (gamenode/gamesocket.js), the lobby
 * drains it and clears each entry once the game is recorded (gamerouter.js).
 * The key lives in one place so the two halves cannot drift apart.
 */
const OUTBOX_KEY = 'nodemessage:outbox';

/**
 * A game finishes once, so keying by its id means a redelivery overwrites the
 * entry rather than queueing a second copy of it.
 *
 * @param {string} gameId
 */
const gameWinKey = (gameId) => `GAMEWIN:${gameId}`;

module.exports = { OUTBOX_KEY, gameWinKey };
