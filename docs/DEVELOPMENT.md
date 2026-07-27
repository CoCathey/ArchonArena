# Developing Archon Arena

This is the Archon Arena-specific developer guide: the **platform** built around the
gameplay engine — services, database, settings, APIs and conventions.

For getting the stack running at all (Docker, Postgres/Redis, card data, running the
lobby and a game node), see **[local-development.md](local-development.md)** first. For
implementing or fixing cards, see [implementing-cards.md](implementing-cards.md) and
[testing-cards.md](testing-cards.md). This document does not repeat any of that.

## The prime directive

> Gameplay stays 100% compatible with The Crucible Online and always remains stable.

Everything Archon Arena adds is built **around** the engine as loosely-coupled services,
never by rewriting working gameplay. In practice:

-   `server/game/` is the inherited engine. Treat it as a dependency you can read but
    should rarely change. Changes there risk the 38,000-test card suite and any upstream
    merge (see [UPSTREAM.md](UPSTREAM.md)).
-   Platform code lives in `server/services/`, `server/api/` and `client/`.
-   Where the platform needs to react to gameplay, it hooks at the **lobby/router** layer
    (e.g. the rating engine hooks `GAMEWIN` in `server/lobby.js`), fire-and-forget and
    idempotent, so a failure in platform code can never break a game in progress.
-   Archon-added code is marked with an `ARCHON:` comment explaining _why_, which makes it
    easy to see what is ours versus inherited when merging upstream.

## Layout

| Path                           | What lives there                                              |
| ------------------------------ | ------------------------------------------------------------- |
| `server/game/`                 | Gameplay engine (inherited). Cards under `cards/<NN>-<SET>/`. |
| `server/services/`             | Platform services — one directory per domain                  |
| `server/api/`                  | Express route modules, registered in `server/api/index.js`    |
| `server/db/schema/`            | Schema for a **fresh** database (see below)                   |
| `server/db/schema/migrations/` | Incremental changes for an **existing** database              |
| `server/db/dev-seed/`          | Local-only demo accounts — never mounted in production        |
| `client/`                      | React SPA. Pages in `pages/`, shared UI in `Components/`      |
| `client/AppRoutes.jsx`         | The live router                                               |
| `client/menus.js`              | Sidebar navigation                                            |
| `test/server/services/`        | Platform service tests (mirror the service path)              |
| `deploy/`                      | Caddyfile and the production health check                     |

Current platform services: `rating/` (SAS-adjusted Elo, decay, seasons), `tournament/`,
`community/` (friends, clubs, stores, member directory, player profiles), `dok/` (Decks of
KeyForge SAS), `auth/` (OIDC), `settings/`, `matchmaking/`, plus `StatisticsService`,
`GameService`, `DeckService`, `UserService` and others at the top level.

## Database

**Two directories, two audiences.** This trips people up, so read it once:

-   `server/db/schema/*.sql` builds a database **from empty**. Docker mounts this whole
    directory into the Postgres container's `docker-entrypoint-initdb.d`, which runs every
    file **in alphabetical order** on first boot only.
-   `server/db/schema/migrations/*.sql` moves an **existing** database forward. Files 01–21
    are inherited from upstream keyteki and are already baked into the schema directory;
    22 onwards are Archon-era.

**Adding a table or column therefore means writing it twice**: once in the schema
directory (so fresh databases get it) and once as a numbered migration (so deployed
databases get it). Keep the numbers unique and sequential — alphabetical order is
execution order, so a file that depends on another must sort after it.

Migrations are currently applied by hand in production (see
[DEPLOYMENT.md](DEPLOYMENT.md) §4). A ledger and runner are on the roadmap (I2).

Because the schema directory is mounted into production, **never put anything there that
production must not have**. The demo accounts (`admin` / `test0` / `test1`, password
`password`) live in `server/db/dev-seed/` for exactly this reason — they were previously in
`99 - Data.sql` and were being created on every production deploy. Production bootstraps
its first admin with `npm run grant-admin -- <username>` instead.

## Service conventions

Platform services follow a shape that makes them testable without a database:

```js
class ThingService {
    // db is injectable and defaults to the shared pool
    constructor(db = require('../../db')) {
        this.db = db;
    }
}
```

Anything time-dependent takes an injectable clock (`options.now`) for the same reason —
see `StatisticsService` and `MatchmakingService`. `MatchmakingService` goes furthest: it
holds no sockets and no clock at all, so its pairing logic is pure and deterministic.

Tests mirror the service path under `test/server/services/` and use a fake `db` whose
`query` is a `vi.fn()` routed by which table the SQL mentions — see
`PlayerProfileService.spec.js` or `BugReportService.spec.js` for the pattern.

## Runtime settings

Anything an admin should be able to tune without a redeploy goes through the settings
service rather than config files:

1. Add the field to `server/services/settings/registry.js` (the registry drives both
   server-side validation and the admin UI at `/admin/settings`).
2. Read it with `settingsService.getSection('<section>')`, merged over code defaults.

Secrets stay **out** of the registry — API keys and credentials are environment-only on
purpose. Config precedence is: code defaults → `config/*.json5` → environment variables
(mapped in `config/custom-environment-variables.json5`) → runtime admin settings.

## Frontend

-   Routes go in `client/AppRoutes.jsx`; navigation entries in `client/menus.js`.
-   Data fetching is RTK Query in `client/redux/api.js` — add the endpoint and export its
    hook.
-   Styling is Tailwind v4 with design tokens in `client/styles/tailwind.css` (light/dark
    palettes, brand amber). Prefer tokens over hard-coded colours.
-   User-facing strings go through `t()` / `<Trans>`. Locale files are `client/locales/*.json`;
    a missing key falls back to the key itself, so English works without an entry.
-   Fonts are self-hosted in `client/assets/fonts/`. Do not add a webfont CDN — the privacy
    policy promises no third-party requests, and the CSP blocks them.

## Verifying a change

The same four checks CI runs, in the order that fails fastest:

```bash
npm run lint             # prettier + eslint
npm run typecheck:client # tsc over the client
npm run build            # production bundle
npm test                 # full suite, ~2 minutes
```

`npm test` is pure game-logic and service tests — it needs no Postgres, Redis or running
server. `npm run lint:fix` fixes most formatting complaints automatically.

Run a single suite while iterating:

```bash
npx vitest run test/server/services/rating/RatingService.spec.js
```

## What needs an account somewhere else

Some features are fully implemented but inert until someone provisions the third party.
The health check (`deploy/healthcheck.sh`) reports which are configured:

| Feature                 | Needs                                                 |
| ----------------------- | ----------------------------------------------------- |
| Transactional email     | AWS SES: verified sender identity + production access |
| SAS / deck power        | A Decks of KeyForge API key (`DOK_API_KEY`)           |
| Keybringer SSO          | A Keycloak client registered in the realm             |
| Error tracking          | A Sentry DSN                                          |
| Patreon supporter perks | A Patreon campaign and OAuth credentials              |

None of these block local development — each degrades gracefully when unset.

## Where work is tracked

[ROADMAP.md](../ROADMAP.md) is the single source of truth: a prioritized backlog with IDs
(`I1`, `N3`, `F2`), dependencies and acceptance criteria, plus per-phase status and a
running list of known defects. Add a feature there before building it.
