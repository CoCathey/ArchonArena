# Design: Rating Engine (SAS-adjusted Elo)

Status: **Increments 1–2 shipped** — pure calculator (increment 1) plus persistence and
live game-end integration (increment 2). Rated play is ON by default for casual +
competitive 2-player games. Admin settings service wiring and the recalculation tool are
follow-ups (see ROADMAP.md Phase 5).

Increment 2 (`RatingService`, `server/services/rating/RatingService.js`):

-   **Hook**: `gamerouter.js` GAMEWIN handler chains `ratingService.processGame(gameId)`
    after `GameService.update()` persists the result (ARCHON-marked; fire-and-forget with
    error logging — rating can never affect game flow).
-   **Idempotent by construction**: pre-check on `RatingHistory` plus a
    `UNIQUE (GameId, UserId)` constraint means duplicate GAMEWINs, rematch re-saves, or
    crashes can never double-rate a game.
-   **What rates**: exactly-2-player games with a recorded winner whose `GameType` is in
    `rating.ratedTypes` (default casual + competitive) and whose `WinReason` is not
    excluded (default excludes `rematch`). Win reasons map to calculator result types:
    `keys`→keys, `concede`→concede, `clock`/`* after time`→timeout.
-   **SAS at game time**: joins `GamePlayers → Decks → DeckSas` by deck uuid, so the
    Phase 4 cache feeds the handicap with no extra fetches; missing SAS degrades to an
    even-deck matchup.
-   **Pools**: one rating per player per `GameFormat` (archon/sealed/alliance…),
    defaulting to `archon`.
-   **Auditability**: every history row snapshots the effective Elo config (jsonb), so
    past ratings remain explainable and recalculable after tuning.
-   **API**: `GET /api/ratings/:username` → `[{ pool, rating, gamesPlayed, provisional }]`
    (public).

## Current TCO architecture (analysis)

TCO has **no rating system at all**. Relevant existing pieces:

-   `server/services/GameService.js` persists finished games (winner, loser, key counts) to
    PostgreSQL (`Games` / `GamePlayers` tables).
-   `server/lobby.js` receives `GAMEWIN` / `GAMECLOSED` messages from game nodes via
    `server/gamerouter.js` — this is where a game result first reaches the lobby process.
-   `server/services/ConfigService.js` is a thin wrapper over file-based `node-config`;
    values are fixed at process start. There is no runtime-editable settings store.
-   Master Vault deck import exists (`server/services/DeckService.js`); SAS is not stored
    (Phase 4 adds it).

## Proposed architecture

A **Rating Service** that is deliberately split into two layers:

1. **`server/services/rating/EloCalculator.js` (this increment)** — pure functions, no
   I/O, no imports from the gameplay engine. Given two players (rating, games played,
   deck SAS), the key result, and a config object, it returns new ratings.
2. **`RatingService` (next increment)** — orchestrates: loads effective config from the
   settings service, loads player ratings, calls the calculator, persists rating history.
   It subscribes to game-completion at the **lobby/service layer** (where `GAMEWIN`
   already arrives), never inside `server/game/**`.

### Why this shape

-   **Pure calculator first**: rating math is the highest-dispute, highest-correctness
    component. Keeping it pure makes it exhaustively unit-testable, trivially reusable by
    the future "recalculate season with different parameters" admin tool, and immune to
    gameplay-engine changes.
-   **Config passed in, not read**: admins must be able to tune every parameter at runtime
    (per product requirements) and historical recalculation must be able to replay with a
    _historical_ config. Both preclude the calculator reading global config itself.
-   **No gameplay coupling**: per the prime directive, the engine (`server/game/**`) is
    untouched. Ratings consume game _results_, which already flow to the lobby.

## The algorithm

Standard Elo with two modifications:

```
effectiveDiff = (Rp − Ro) + sasWeight × (SASp − SASo)
E              = 1 / (1 + 10^(−effectiveDiff / 400))
mov            = keyDiffMultipliers[clamp(winnerKeys − loserKeys, 1, 3)]
                 × resultTypeMultipliers[resultType]
R'             = R + K × mov × (S − E)         S ∈ {1, 0}
```

-   **SAS handicap** (`sasWeight`, default 4): a deck-power difference shifts the expected
    score exactly as a rating difference would. Default 4 means 25 SAS ≈ 100 Elo. Winning
    with a much stronger deck pays less; upsets with weaker decks pay more. `sasWeight: 0`
    turns the feature off.
-   **Margin of victory**: key differential of the final score scales the exchange
    (defaults: 3−2 → ×1.0, 3−1 → ×1.1, 3−0 → ×1.25). The multiplier is identical for both
    players, preserving zero-sum. Games can end with the _loser_ ahead on keys (concede /
    timeout); the differential clamps to the narrowest margin rather than rewarding it.
-   **Result type**: a second multiplier keyed by how the game ended (`keys`, `concede`,
    `timeout`) so admins can e.g. discount timeout wins.
-   **Provisional players**: K = 64 (default) for a player's first 10 rated games, 32 after,
    so new players converge fast. Provisional-vs-established games are intentionally not
    zero-sum (standard practice).
-   **Rating floor** (default 100) prevents runaway deflation of inactive/losing accounts.

## Admin-configurable parameters (all of them)

`defaultRating`, `ratingFloor`, `kFactor`, `provisionalKFactor`, `provisionalGames`,
`sasWeight`, `keyDiffMultipliers`, `resultTypeMultipliers` — defaults live in
`eloDefaults.js`; the settings service (roadmap, cross-cutting) will layer admin overrides
on top and pass the merged object in. `normalizeConfig()` validates any override set and
rejects nonsense (non-positive K, negative weights) so a bad admin edit cannot corrupt
ratings.

## Files changed (this increment)

-   `server/services/rating/eloDefaults.js` — new
-   `server/services/rating/EloCalculator.js` — new
-   `test/server/services/rating/EloCalculator.spec.js` — new (property + golden tests)

## Database migrations

None yet. Next increment adds: `Ratings` (player, pool, rating, gamesPlayed) and
`RatingHistory` (game id, pre/post ratings, expected scores, SAS values, key diff, config
snapshot id). A config snapshot per game is what makes later recalculation/auditing
possible.

## API changes

None yet. Next increments expose `GET /api/players/:id/rating` and leaderboard endpoints
(Phase 6).

## Tests

`EloCalculator.spec.js`: golden values against the classic Elo table, complementarity
(E_a + E_b = 1), zero-sum for established players, monotonicity in key differential and
SAS differential, provisional K behavior, rating floor, config validation, and admin
override behavior.

## Future considerations

-   **Rating pools** per format (Archon / Alliance / Sealed) — the calculator is already
    pool-agnostic; pools are a persistence concern.
-   **Glicko-2 migration**: if we later want rating deviation/volatility, the pure-function
    boundary means only this module changes; persistence keys stay.
-   **Inflation monitoring**: MoV multipliers + provisional asymmetry can drift the pool
    mean; the stats engine should track mean rating over time so admins can tune.
-   **Anti-manipulation**: win-trading/sandbagging detection belongs in a separate integrity
    service that reads `RatingHistory`, not in the calculator.
