const EventEmitter = require('events');

/**
 * ARCHON: the in-process bridge between the direct message service and the
 * lobby, in the same shape as tournamentEvents.
 *
 * The service writes the row and says so; the lobby, which holds the sockets,
 * decides how the recipient hears about it - live over their socket when they
 * are here, as a notification (in-app, email, push) when they are not. The
 * service knows nothing about sockets and the lobby nothing about the table,
 * and either can be tested without the other.
 *
 * Events:
 *   'sent'  { message }  - a message was written. `message` is the wire form
 *                          the client renders: id, senderId, senderUsername,
 *                          recipientId, recipientUsername, text, matchId,
 *                          sentAt, readAt.
 */
module.exports = new EventEmitter();
