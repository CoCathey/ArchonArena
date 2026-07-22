# Game connection resilience: stranded players & ghost games

## The incident

Two players started a game. The second player (the joiner) reached the
setup-phase **mulligan** prompt — the board rendered, "Keep Starting Hand?"
with _Keep Hand_ / _Mulligan_ buttons — but **clicking the buttons did
nothing**. Both players eventually gave up and left, yet the game **still
showed in the lobby** afterwards ("it still has a game").

## Root cause

The mulligan game-step itself is correct upstream keyteki: it is an
`AllPlayerPrompt`, so both players can respond independently until each has
decided. A stuck button is therefore **not** a game-logic bug — it means the
player's clicks never reached the game node. Three connection-layer gaps
combined to produce the incident:

1. **A post-connect reconnection blip was misreported as a failed handoff.**
   The game-board socket fired `connect_error` on _every_ failed attempt,
   including reconnection attempts after a successful connect, and each one
   emitted `connectfailed` to the lobby. The lobby ran `notifyFailedConnect`
   → `game.failedConnect(player)` on the node, which marks the game
   `finishedAt`. So a brief network blip on the joiner's side turned a live
   game into a "finished" one while they were still staring at the board —
   and its buttons no longer resolved.

2. **Reconnection gave up too fast.** `reconnectionAttempts: 5` (~15s) was
   not enough to ride out a real blip, so the socket stopped retrying and the
   player was permanently stranded at a dead board.

3. **"Leave Game" only spoke over the (dead) game socket.** The Leave button
   dispatched `concede` / `leavegame` exclusively through the game-node
   socket. When that socket was dead there was **no working way to leave**,
   and — because the node never learned the player had gone — the finished
   game lingered as a ghost in the lobby until the node's stale-game sweep,
   or forever if the dead socket never timed out.

## The fix (three surgical changes)

### 1. Don't misreport reconnection blips as failed handoffs

`client/redux/middleware/socket-middleware.js` — the game socket records
`tHasConnected = true` on its first `connect`. `connect_error` now emits
`connectfailed` to the lobby **only when `tHasConnected` is false** (a genuine
initial-handoff failure). A blip after a successful connect is left to
socket.io's normal reconnection and never marks the live game finished.

### 2. Give reconnection room to recover

Same file — `reconnectionAttempts` raised `5 → 20` (~2 minutes with the
existing 5s max delay). Safe now that a post-connect `connect_error` no longer
reports a failed handoff, so extra attempts can only help.

### 3. Leave over both sockets + tear the game down

-   `client/Components/Navigation/GameContextMenu.jsx` — leaving now also
    dispatches `lobbyLeaveGameRequested(currentGame.id)` over the independent
    lobby socket, so a player can always escape even when the game socket is
    dead. (Both the confirm-to-concede path and the plain leave path.)
-   `server/lobby.js` `onLeaveGame` — for a **started, non-tournament** game,
    when the lobby's authoritative view shows the game empty (every player has
    left), it now calls `this.router.closeGame(game)` to force the node to tear
    the game down, then removes it and broadcasts `removegame`. If the opponent
    is still playing it only broadcasts `updategame` and leaves the live game
    running on the node. This reuses the same `router.closeGame` path already
    used by `clearGamesForUser`.

## Why this is safe

-   `router.closeGame` fires **only** when the lobby's `PendingGame.isEmpty()`
    is true, which happens only when every player is marked `left` — and the
    lobby marks `left` solely from explicit leaves (node `PLAYERLEFT` events and
    lobby `leavegame`). An actively-playing opponent is never `left`, so a live
    game is never force-closed.
-   Leaving over both sockets is idempotent: `game.leave` / `router.closeGame`
    / socket close all tolerate being run twice (normal game-socket leave still
    flows through the node's `PLAYERLEFT`, and the lobby path just confirms it).
-   No change to the mulligan step or any game-engine logic.

## Files

-   `client/redux/middleware/socket-middleware.js` — `tHasConnected` guard,
    `reconnectionAttempts` 5 → 20.
-   `client/Components/Navigation/GameContextMenu.jsx` — `leaveViaBothSockets`.
-   `server/lobby.js` — `onLeaveGame` closes started+empty games on the node.
-   Tests: `test/server/lobby.onLeaveGame.spec.js`.
