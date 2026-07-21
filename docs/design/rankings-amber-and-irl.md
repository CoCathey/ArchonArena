# Amber branding, Top Players, Ratings & Play IRL

Four related additions on top of the Phase 6 rating engine and Phase 9
community work.

## "Amber" - the player-rating brand

Player ratings are surfaced as **Amber** (after KeyForge's Æmber), the way
Clash Royale surfaces trophies: a themed currency instead of a bare "rating
points" number. This is a **display-only** rename - the stored value is
still the numeric SAS-adjusted Elo; none of the math changes.

-   `client/Components/Site/AmberValue.jsx` renders an amber-gem glyph + the
    number in amber. Used anywhere a player rating appears.
-   Relabelled: Leaderboards and Members "Rating" columns → "Amber"; new
    Top Players and Ratings pages use it throughout.
-   **Deck power stays "SAS."** Amber (player) and SAS (deck) are deliberately
    distinct so they are never confused.

## Top Players (`/community/top-players`)

A worldwide "hall of fame": the top 25 by Amber for the selected pool
(archon / sealed / alliance), with a **podium** for the top three (avatars,
medals) and a compact list below. Distinct from Leaderboards, which is the
scoped explorer (region / country / state, paginated). Reuses
`getLeaderboard({ scope: 'world' })`; the leaderboard query now also returns
each player's avatar for the podium.

## Ratings (`/community/ratings`)

A personal Amber dashboard plus an explainer:

-   Per pool: Amber value, **world rank (#N of M)**, rated games, and a
    provisional badge. `RatingService.getRatingsForUsername` now computes
    `rank` (players with strictly higher rating, +1) and `totalRated` per pool
    via correlated subqueries.
-   "How Amber works": SAS handicap, key-differential scaling, provisional
    period - in plain language, with the Clash-Royale-style "it can go down
    too" note.
-   Logged-out / no-games states point to Log In / Play Online.

## Play IRL (`/play-irl`) and local stores

In-person play hub:

-   Intro + shortcuts to in-person **tournaments** (the tournament engine
    already supports them) and **clubs**.
-   **Local stores directory** - a community-contributed list of game stores /
    venues, searchable by name/city and country. Anyone signed in can add a
    store; the person who added it (or an admin) can remove it.

### Stores data model

`Stores` (schema 38 / migration 31): Name (required), Country/State/City,
Address, Website, Description, AddedByUserId, CreatedAt.

-   `FK_Stores_Users_AddedByUserId` is **ON DELETE SET NULL** - community
    listings survive the contributor deleting their account (verified against
    Postgres). Indexed on (Country, State) for location filtering.
-   `StoreService` (create with country validation + field sanitizing, list
    with filters capped at 200, remove with adder/admin authorization).
-   Routes: `GET /api/stores` (public), `POST /api/stores` (JWT),
    `POST /api/stores/:id/remove` (JWT). Registered in `api/community.js`.

## Files

-   `client/Components/Site/AmberValue.jsx`; relabels in `pages/Leaderboards.jsx`,
    `pages/Members.jsx`.
-   `client/pages/TopPlayers.jsx`, `pages/Ratings.jsx`, `pages/PlayIrl.jsx`;
    routes in `AppRoutes.jsx` (replace three placeholders).
-   `server/services/rating/RatingService.js` (rank + avatar on leaderboard).
-   `server/services/community/StoreService.js`; `server/api/community.js`.
-   `server/db/schema/38 - Stores.sql`, `migrations/31 - Stores.sql`.
-   RTK: `getStores` / `addStore` / `removeStore`; `STORES` tag.
-   Tests: `StoreService.spec.js` (6), `RatingService.spec.js` (rank).
