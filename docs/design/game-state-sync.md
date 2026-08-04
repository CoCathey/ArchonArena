# Game state sync: frozen boards and "Connecting to the game…"

Follow-on to [game-leave-resilience.md](game-leave-resilience.md), which fixed
players being stranded at a dead board. This one is about the board that is
still attached to a live socket and has quietly stopped moving.

## The reports

Two symptoms, from the same player, on the two clients:

-   **Mobile** — "sometimes the app will kick you out of the game and just say
    connecting to the game."
-   **Web** — "sometimes it will get caught up and I will have to refresh to see
    it is actually my turn and it's not stuck."

They are the same bug seen from two angles, plus a second one that only the web
client had.

## Root cause 1: nothing on the wire said "this is a whole board"

The node sends a player either a complete board or a jsondiffpatch delta, both
over the `gamestate` event. Which one it sends depends on `game.jsonForUsers` —
a diff baseline held **per player name**, not per socket — and that baseline is
reset in four places: a player connecting, reconnecting, disconnecting, or
leaving.

Neither client was told which it had received. Both inferred it:

```js
if (rootState) {
    /* must be a delta */
} else {
    /* must be a whole board */
}
```

That inference is right only while the two ends agree about when the baseline
resets. They stop agreeing the moment a reset happens on the node's side of a
connection the client still has open — which is exactly what a second
connection for the same user does. Two tabs, or the phone app and the web app
signed in together, or a reconnect that beat the old socket's ping timeout: the
node resets the baseline, sends the _other_ client a complete board, and that
client — still holding a board — puts a whole game state through a delta
patcher.

That does not fail in a way anything could catch. Measured against the exact
`jsondiffpatch@0.4.1` the node uses:

| value in the board             | result of applying it as a delta   |
| ------------------------------ | ---------------------------------- |
| number (`amber: 3`)            | the key is silently **deleted**    |
| boolean (`activePlayer: true`) | the key is silently **deleted**    |
| **string** (`phase: 'main'`)   | **never returns — infinite loop**  |
| array of 1–2 (`hand: [a, b]`)  | the array becomes a single element |
| array of 3                     | the key is silently deleted        |

Every real board contains strings — player names, the phase, card names — so in
practice the patcher **hangs the JavaScript thread**. On the web that is a tab
that stops responding and only a refresh clears: _"I have to refresh to see it
is actually my turn."_ The mobile client uses its own delta patcher
(`src/net/jsonpatch.ts`), which throws instead of hanging, so it fell into its
`catch` and cycled the socket — and cycling the socket is what put
"Connecting to the game…" on screen.

## Root cause 2: the web rebuilt its game socket on every lobby reconnect

`Lobby.onConnection` sends a `handoff` to any user whose game has already
started — on **every** lobby socket connection, not only when the game begins.
The lobby socket reconnects with `reconnectionAttempts: Infinity`, so a network
blip mid-game produces a handoff for the game already in progress.

The middleware answered each one by closing the game socket and building a new
one. Three things followed:

1.  `gameCloseRequested` → `lobbyActions.gameSocketClosed()` clears
    `lobby.currentGame`. `/play` renders `<GameBoard />` only while that is set,
    and the lobby deliberately stops sending `gamestate` for a game once it has
    started (`Lobby.sendGameState` returns early for `game.started`). So the
    board was replaced by the pending-game screen with nothing to put it back.
2.  The outgoing socket kept all its handlers. Its `disconnect` landed _after_
    the replacement had delivered its first board and wiped it — after which the
    next delta arrived with no board to apply it to and was adopted as if it
    were one.
3.  Two live sockets for one user meant the node handed the player to whichever
    connected last, starving the other (root cause 1's trigger, self-inflicted).

The mobile client had the same shape in a smaller form: it skipped the rebuild
only when `socket.connected` was true, so a handoff arriving _during_ a blip —
which is precisely when one arrives — tore down a socket that was already
reconnecting and raced the two.

## Root cause 3: a superseded socket was starved in silence

`player.socket` is singular. A second connection for the same user overwrote it
and the displaced client was left holding an open, authenticated socket that
would never be sent another byte. It had no way to know: no disconnect, no
error, just a board that stopped moving.

## The fix

### Node (`server/gamenode/gameserver.js`)

-   **`sendStateTo` marks what it sent**: `send('gamestate', payload, { full })`.
    An extra argument, so a client that does not read it is unaffected.
-   **`onConnection` closes the socket it supersedes.** The player is pointed at
    the new socket first, so the close runs through `onSocketDisconnected`'s
    existing `player.id !== socket.id` guard and cannot mark the player
    disconnected or tear the game down. The displaced client now gets a visible,
    recoverable disconnect instead of a board that stops moving for no stated
    reason. Because socket.io does not retry a server-initiated disconnect, the
    two clients cannot flap: ownership moves only when a client is actually used
    (a lobby reconnect, a foreground, a Reconnect tap), never on a timer.
-   **A `resync` command**, alongside `leavegame`: clear that player's baseline
    and send them a complete board over the live socket. Previously the only way
    to ask for one was to drop the connection, which costs a round trip with the
    board off screen and races the outgoing socket against the incoming one.
    Requests from a socket that has already been superseded are ignored.
-   `deliverStateTo` splits the per-player delivery decision (including the N1
    spectator broadcast delay) out of `sendGameState`, so `resync` honours the
    delay too — a delayed spectator cannot use it as a fast path to the table.

### Web (`client/redux/middleware/socket-middleware.js`)

-   **A handoff for the game already connected keeps that connection**, and just
    calls `connect()` if it is down. `currentGame`, and therefore the board,
    stays put. Tracked in a module-scoped `gameSocketGameId`, because
    `handoffReceived` overwrites `games.gameId` before the handler could compare.
    (The old comparison read a `store.getState()` captured in a closure at
    `lobbyConnectRequested` time, so it was stale for the life of the session.)
-   **The game socket's `auth` is now read at handshake time**, not at socket
    construction. Handoff JWTs last five minutes, so a fixed `auth` object keeps
    re-presenting an expired token and every reconnection attempt after that is
    refused. Rebuilding the socket on each handoff was hiding this by accident —
    it was the only thing getting a fresh token to the handshake — so keeping the
    connection is only safe alongside this. (The mobile client already did it
    this way.)
-   **Every handler ignores a socket that is no longer the live one.** The
    `reconnect_*` listeners live on a Manager that socket.io shares between
    connections to the same node, so they outlive the socket they were
    registered for; a flag beats trying to unregister them.
-   **`full` decides how a state is applied**, and the patch is wrapped: a delta
    that will not apply leaves the last good board on screen and asks for a
    snapshot rather than rendering something wrong. A delta with no board to
    apply it to does the same instead of adopting the delta as a board.

### Mobile (`mobile/src/net/`)

-   **`stateSync.ts`** holds the full/delta decision as a pure function, tested
    in `test/stateSync.test.ts`.
-   **A handoff for the game already connected keeps that socket** even while it
    is mid-reconnect.
-   **`connect` no longer blanks the board.** It did so to guarantee the next
    state would be treated as complete — which the marker now guarantees
    properly. Blanking is what dropped the player onto "Connecting to the game…"
    on every reconnection blip and, via the foreground `resyncGame()`, every
    single time they switched apps and came back.
-   **`resyncGame()` asks over the live socket** instead of cycling it, so the
    board stays up. Because a socket the OS suspended can report `connected`
    while being dead, the request is watched: if no state arrives within 5s the
    connection is cycled after all.
-   A `disconnect` the node asked for (`io server disconnect`, i.e. this account
    connected from somewhere else) is shown as failed rather than reconnecting,
    because socket.io will not retry one of those. That is the state that offers
    Reconnect, and the board stays on screen behind it.

## Known rough edge

A spectator under the N1 broadcast delay who asks for a resync is answered
through the delay queue, so their snapshot arrives `delaySeconds` later — past
the mobile watchdog, which will cycle the socket once before the state lands.
That is no worse than the old behaviour, which cycled the socket every time, and
the delay is deliberately not something a resync may skip past.

## Compatibility

The `full` marker is an added argument on an existing event, and both clients
fall back to the old inference when it is absent — so a node and a client from
either side of this change interoperate, at the old level of safety, during a
rolling deploy.

## Tests

-   `test/server/gamestate.sync.spec.js` — the marker on first send, on
    subsequent sends, and after a baseline reset; per-player baselines; the
    delayed-spectator path; `resync` behaviour including from a superseded
    socket; second-connection eviction. Plus the terminating half of the
    corruption table above, asserted directly against `jsondiffpatch` — the
    non-terminating half is, for obvious reasons, described rather than run.
-   `test/client/gameSocketMiddleware.spec.js` — a repeated handoff keeps the
    socket, the board and `currentGame`, and the kept socket presents the newest
    token at its next handshake; a handoff for a different game replaces it and
    ignores the straggler; full/delta handling including both resync paths and
    the no-marker fallback.
-   `mobile/test/stateSync.test.ts` — the decision table, both with and without
    the marker.
