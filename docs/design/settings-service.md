# Design: Runtime Settings Service (admin-config backbone)

Status: **Increment 1 shipped** — DB-backed settings with registry validation, admin API

-   UI, wired into the rating engine and DoK integration. Redis pub/sub invalidation and
    a full audit-log table are follow-ups.

## Current architecture (analysis)

All configuration was file/env based (`node-config` via `ConfigService`), fixed at
process start. The product requirement — "make as much configurable by the site admin
as possible, like the Elo" — needs values editable at runtime from the site, without
redeploys or SSH.

## Proposed architecture

```
Admin UI (/admin/settings, isAdmin)
   └─ /api/admin/settings (GET registry+values / PUT section / DELETE section)
        └─ SettingsService (singleton)
             ├─ registry.js: editable sections/fields, types, ranges, defaults
             ├─ SiteSettings table: one jsonb overrides row per section + who/when
             └─ in-memory snapshot: sync reads, 30s refresh + refresh-on-write
Consumers: RatingService.getConfig(), DokService.getConfig()
   merge: code defaults ← file config ← DB overrides   (DB wins)
```

### Why this shape

-   **Registry-constrained editing**: only fields declared in `registry.js` (with types
    and ranges) are editable. Secrets (API keys, OIDC credentials) are deliberately not
    in the registry — a compromised admin session cannot exfiltrate or change them.
    Validation runs server-side on every write; a bad value can never reach consumers.
-   **Synchronous snapshot reads**: rating a game must not await a settings query. The
    singleton refreshes on an interval (unref'd timer) and immediately after writes, so
    changes apply instantly in-process. Multi-instance deployments converge within one
    interval; Redis pub/sub invalidation is the noted upgrade when we scale lobbies.
-   **Overrides, not copies**: the DB stores only what the admin changed. Defaults keep
    living in code (single source of truth), file config still works for
    deployment-level tuning, and "Reset to defaults" is a row delete.
-   **Per-section rows**: matches how services consume config (whole section at once)
    and keeps writes atomic per concern.
-   **Rating history stays auditable**: `RatingHistory.ConfigSnapshot` already records
    the effective Elo config per game, so tuning never obscures how a past rating
    happened.

## What's editable now

-   **Rating Engine**: rated play on/off, rated game types, leaderboard min games, and
    every Elo parameter (starting rating, floor, K-factors, provisional count, SAS
    weight, key-differential and result-type multiplier tables).
-   **Decks of KeyForge**: enrichment on/off, refresh window, request timeout.

## Files changed

-   `server/services/settings/{registry,SettingsService,index}.js` — new
-   `server/db/schema/29 - SiteSettings.sql` + `migrations/26 - SiteSettings.sql` — new
-   `server/api/admin-settings.js` — new (isAdmin-gated); registered in `api/index.js`
-   `server/server.js` — ARCHON-marked `settings.start()` at boot
-   `server/services/rating/RatingService.js`, `server/services/dok/DokService.js` —
    getConfig() merges the settings snapshot (injectable for tests)
-   `client/pages/SettingsAdmin.jsx` (+ route, sidebar entry, RTK endpoints)
-   `test/server/services/settings/SettingsService.spec.js` — new (12 tests)

## Database migrations

`26 - SiteSettings.sql`: `SiteSettings(Key PK, Value jsonb, UpdatedBy FK→Users set-null,
UpdatedAt)`.

## API changes

-   `GET /api/admin/settings` — registry + overrides + last-editor audit (isAdmin)
-   `PUT /api/admin/settings/:section` — validate + save overrides (isAdmin)
-   `DELETE /api/admin/settings/:section` — reset to defaults (isAdmin)

## Tests

Registry validation (types, ranges, unknown fields/sections, nested elo), service
snapshot behaviour (cache, refresh failure resilience, write-then-read, reject-invalid,
reset), and precedence integration (admin > file > defaults) through RatingService.

## Future considerations

-   **Redis pub/sub invalidation** for multi-lobby deployments.
-   **Audit log table** (full change history, not just last editor) once moderation
    tooling lands.
-   **More sections**: auth (SSO-only mode), tournament defaults, leaderboard region
    definitions — each is just a registry entry + consumer merge.
-   **Feature flags**: same mechanism, boolean-only section.
