# Design: Direct Messages

Status: **shipped** — one thread per pair of players, live over the lobby socket,
notified through the notification centre when the recipient is away, with the block
list and moderation mutes enforced. Part of **N57** in the roadmap.

## Why

A tournament pairs two people who have to agree on when to play. The platform gave
them a scheduler (offer times, accept one) and no way to talk: "can we do 8 instead of
7?", "I'll be ten minutes late", "which table are you at?" went to Discord, to the
event chat everybody reads, or nowhere. The scheduler proposes and accepts; this is the
conversation around it.

It is deliberately small. A list of people you have talked to, a thread, a box. No
group chats, no attachments, no read receipts beyond the unread count. The Phase 9
notes had listed "DMs (moderated)" as unowned; N5 had already built the moderation
they need.

## Architecture

```
client /messages (+/:username)            MessageBadge (nav + sidebar, polls unread)
   └─ /api/messages/*  (JWT; every query scoped to the caller inside the service)
        └─ DirectMessageService  (validation, block list, mute, persistence)
             ├─ directMessageEvents 'sent' → lobby.onDirectMessageSent
             │      ├─ recipient connected here → socket 'directmessage' (live)
             │      ├─ sender connected here    → socket 'directmessage' (other tabs)
             │      └─ recipient not here       → NotificationService 'message.direct'
             │                                     (in-app / email / push, once an
             │                                      hour per sender)
             └─ "DirectMessages"  (schema 88 / migration 93)
```

The service knows nothing about sockets; the lobby knows nothing about the table.
Either can be tested alone, and the split is the same one `tournamentEvents` already
draws for pairings.

### Why one table and no conversation row

A conversation is the pair of people in it. `(LEAST, GREATEST)` of the two user ids
names it, so the inbox is one grouped query and nothing has to be created before the
first message is sent. `ReadAt` is per message: the badge is "how many are waiting for
me", and opening a thread stamps that sender's messages in one update. A partial index
on unread rows keeps the count cheap however long history gets.

`MatchId` is recorded when a message is sent from a match panel, so a moderator reading
a report — and, later, the thread itself — can see what it was about. It is `SET NULL`
on delete: the message outlives the event.

### Who may message whom

-   Not yourself, not a deleted account, not somebody who does not exist.
-   Not across a block in **either** direction, and the refusal reads the same both
    ways: telling a blocked player they are blocked is information the blocker did not
    choose to share.
-   Not while muted. The same `checkRestriction(userId, 'chat')` the lobby applies,
    with the same message, so a sanction that stopped lobby chat does not leave a hole.
-   Text passes the same content filter as lobby chat at the point of sending.
-   Sending is rate limited (30 a minute) — generous for a conversation, useless for a
    script working through the member list.

### Delivery

"Connected" means connected to **this** lobby process. Under several lobbies a
recipient on another one is treated as away: they get the notification as well as the
live copy their own lobby will not send. That is the harmless direction to be wrong in,
and the client's polls (badge every minute, open thread every fifteen seconds) close
the gap.

The notification dedupe key rolls over hourly per sender, so a conversation with
somebody who is away is one email an hour, not one per line. The category
`message.direct` mails and pushes by default: the message is usually "can we play at 8
instead?", which is worth little an hour later, and a player can switch it off like any
other.

A recipient who **is** connected but is not looking at that thread gets a toast with
the first line and an Open button — the same `lobbynotice` channel the tournament
series continuation uses to speak to a player wherever they are.

## Client

-   `pages/DirectMessages.jsx` — inbox left, thread right, composer below. Enter sends,
    Shift+Enter for a new line. Reading the thread marks it read.
-   `Components/Site/MessageBadge.jsx` — envelope with the unread count, in the top bar
    (during games), its mobile menu, and the sidebar.
-   `MyMatchPanel` — "Message _opponent_" under the pairing, next to the scheduler.
-   `socket-middleware` — `directmessage` invalidates every messages query and raises
    the toast when the thread is not on screen.

## Tests

-   `services/community/DirectMessageService.spec.js` — validation, block list both
    ways, mute enforcement, the inbox shape (once per pair, newest first, unread
    counts), thread ordering and paging, read marking, the announcement.
-   `lobby.directMessages.spec.js` — live delivery to both ends, the notification for
    an absent recipient and its hourly key, a lobby with no notification service.
-   `api/messagesRoutes.spec.js` — the routes exist, fixed paths precede `:username`,
    sending is the one route with a limiter.

## Not built

-   Group threads, attachments, editing or deleting a sent message.
-   Reporting a message from the thread (the report dialog exists; the button does
    not yet).
-   Cross-lobby presence, so a recipient on another process would be treated as online.
