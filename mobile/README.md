# Archon Arena Mobile

An [Expo](https://expo.dev) app for playing **KeyForge** on your iPhone against the
[Archon Arena](../README.md) backend — the same lobby, decks, matchmaking and gameplay
engine the website uses, with a UI built for one-handed portrait play.

## What it does

- **Sign in / register** against the Archon Arena lobby (JWT + refresh-token flow,
  tokens kept in the iOS keychain via `expo-secure-store`)
- **Play tab** — live game list over the lobby socket, create game in any of the
  six modes the lobby runs (Archon, Sealed, Adaptive, Alliance, Reversal,
  Unchained) with every option the web form has — password, spectators, open
  hands, mute spectators, hidden deck lists, unlisted games, time limit, Lucky
  Dice and SAS bounds — quick join, join/watch with password
- **Decks tab** — your deck library with house icons + SAS, Master Vault import by
  link or id, standalone decks for instant play, deck detail view (full card list
  by house with card zoom)
- **Stats tab** — world leaderboard per rating pool, your ratings/rank, win-rate
  breakdowns by house and format, and match history
- **Profile tab** — account, appearance and notification settings, Archon+
  status, and friends (presence, requests, and dropping into a friend's game)
- **Archon+** — membership status, what each tier includes, and connecting an
  existing Patreon account (OAuth sign-in through the system browser). What the
  screen may say about *buying* a membership is decided per platform — see
  `APP-REVIEW.md`
- **Archon Intelligence** — rating history, performance against what your rating
  predicted, per-deck breakdowns, your decks ranked, record by house, and the
  meta. Each panel gated on its own capability, so a Supporter sees what a
  Supporter paid for
- **Tournament Lab** — compare up to four of your decks on record, rating swing,
  recent form and matchups before picking one for an event
- **Pending game** — pick a deck (yours or standalone), chat, start when both ready
- **Game board** — full live gameplay:
  - opponent + player HUDs (æmber, keys, key cost, chains, houses, pile counts)
  - battlelines and artifact rows, card tokens (damage/power/æmber/ward), stun,
    exhaust, selection highlights
  - server-driven prompt panel (mulligans, house choice, ability targeting, Fight/Reap
    menus, end-of-game rematch) including house-icon prompts, with card names
    interpolated into buttons/titles and a "because of <card>" source-card context
    for effect resolution
  - live play-by-play: while the opponent acts, the latest log lines appear in the
    waiting panel with a tap-through to the full log
  - tap to play/use a card, long-press to zoom, card menus for in-play cards
  - drag and drop: pull a card up to the battleline to play it (or to the discard
    chip for the house action); manual mode unlocks moves between all your zones,
    mirroring the web client
  - discard/archives/purged pile viewers, game log + chat sheet
  - spectator mode, reconnect handling, concede/leave, manual-mode toggle

## How it talks to the backend

Protocol identical to the web client (`client/`):

| Layer | Transport | Notes |
| --- | --- | --- |
| Auth, decks | REST `/api/...` | `Authorization: Bearer <5-min JWT>`, transparent refresh via `/api/account/token` |
| Lobby | socket.io at server origin | `auth: { token }`; `newgame`, `joingame`, `selectdeck`, `startgame`, `handoff`, … |
| Gameplay | socket.io at `handoff.address:port` with path `/<node>/socket.io` | first `gamestate` is the full state, every subsequent one is a **jsondiffpatch delta** |

The delta patching lives in `src/net/jsonpatch.ts` — a dependency-free implementation
of the jsondiffpatch delta format (including diff-match-patch text deltas) because the
jsondiffpatch UMD build can't resolve its text-diff dependency under Metro. It is
pinned against the server's exact jsondiffpatch version by unit tests and verified
against real server deltas by the live e2e test.

Card images are loaded straight from the lobby server (`/img/cards/<image>.png`) and
cached on disk by `expo-image`, so the app ships no card data.

## Project layout

```
app/                    expo-router screens
  (tabs)/               Play / Decks / Events / Stats / Profile
  login.tsx register.tsx new-game.tsx pending.tsx game.tsx
  membership.tsx intelligence.tsx tournament-lab.tsx
src/
  api/                  REST client + wire types
  friends/              the friends section of the Profile tab
  membership/           capabilities, entitlements, Patreon linking, store policy
  net/                  lobby socket, game socket, jsonpatch
  stores/               zustand stores (auth, settings, lobby, game)
  game/                 board UI: CardTile, PlayerHud, PromptPanel, modals, log
  ui/                   shared primitives + HouseIcon
assets/img/             house icons, key icons, cardback (from client/assets)
test/                   vitest: jsonpatch unit+fuzz tests, live-server e2e
```

## Running it

```bash
cd mobile
npm install
npm run ios        # or: npm start, then scan the QR with Expo Go
```

Sign in against the default server (`https://archonarena.com`) or tap
**Server settings** on the login screen and point it at your own instance
(e.g. `http://<your-lan-ip>:4000` when running the backend locally — the game
node must also be reachable on its port, 9500 by default).

## App Store / Play Store

`APP-REVIEW.md` covers what review will ask about: why the iOS build shows no
prices or purchase links, why Patreon account linking is a sign-in rather than a
purchase, and the notes to paste into App Store Connect. The rules themselves
live in `src/membership/storePolicy.ts` and are asserted in
`test/membership.test.ts` — if those fail, the iOS build is no longer
submittable.

## Tests

```bash
npm run typecheck   # strict TS
npm test            # jsonpatch unit + 300-round fuzz vs the server's jsondiffpatch
```

### Live end-to-end test

`test/e2e.live-server.test.ts` drives two players through the complete real flow —
register → login → lobby sockets → create/join → standalone decks → start →
handoff → game node → mulligans/house choices/turns → chat → concede — patching
every real server delta through the app's own pipeline. Run it with the backend up
(see `docs/local-development.md` in the repo root):

```bash
AA_E2E=1 npm test               # expects lobby on :4000, game node on :9500
AA_SERVER=... AA_GAME_NODE=...  # to override
```

## Not yet implemented

Sealed/alliance formats, tournaments, lobby chat, spectator lists,
card-name/trait typeahead prompts (regular prompt buttons cover the common
cases), push notifications.
