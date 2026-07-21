# Archon Arena — Product & Engineering Roadmap

> **Vision:** A next-generation competitive KeyForge platform — think Chess.com for KeyForge —
> built on the proven gameplay engine of The Crucible Online (keyteki), extended with modern
> ratings, tournaments, rankings, analytics, and community features.
>
> **Prime directive:** Gameplay stays 100% compatible with TCO and always remains stable.
> New systems are built _around_ the gameplay engine as loosely-coupled services, never by
> rewriting working gameplay.

## How this document is used

-   Every feature and task lives here **before** it is built.
-   Items are checked off (`[x]`) when complete and eventually pruned to the CHANGELOG.
-   Each phase lists **why** it is sequenced where it is.
-   Anything marked **(admin-config)** must be runtime-configurable by site admins via the
    admin panel / settings service — no redeploy needed to tune it.

## Architecture principles (apply to every phase)

-   [ ] Clean architecture; gameplay engine, tournament engine, statistics engine, auth,
        deck service, replay service, API, and frontend are separate, loosely-coupled modules.
-   [ ] Prefer reusable services over logic embedded in the gameplay engine.
-   [ ] TypeScript for all new code; incremental migration of touched JS files only.
-   [ ] PostgreSQL as the system of record; Redis for cache/queues/presence.
-   [ ] Docker for local dev and production parity.
-   [ ] Never introduce breaking changes to gameplay if avoidable; incremental refactoring only.
-   [ ] Every feature ships with: current-architecture analysis, proposed architecture, files
        changed, DB migrations, API changes, tests, and future considerations.
-   [ ] Design for tens of thousands of users (horizontal scale of game nodes, stateless API).
-   [ ] A central **Site Settings service** backs all admin-configurable values with audit log.

---

## Phase 0 — Working fork & foundation _(PRIORITY)_

-   [x] Create ArchonArena repo from keyteki source (github.com/keyteki/keyteki import).
-   [x] Preserve upstream remap path so upstream gameplay/card fixes can be pulled in later
        (documented in `docs/UPSTREAM.md`).
-   [x] Get server + client building locally (`npm install`, dev build passes).
-   [x] Get test suite running; record baseline pass rate before any changes
        (docs/TEST-BASELINE.md: 38,221 passed / 0 failed).
-   [ ] CI pipeline (GitHub Actions): lint, test, build on every PR (upstream workflows
        imported; need pruning of TCO deploy jobs + secrets for our repo).
-   [x] Dockerfile + docker-compose for one-command local stack (inherited from upstream;
        PostgreSQL + Redis, no MongoDB needed).
-   [ ] Document dev environment setup in `docs/DEVELOPMENT.md` (upstream
        docs/local-development.md covers most; needs Archon Arena pass).

**Why first:** nothing else can be verified stable without a reproducible build/test baseline.

## Phase 1 — Rebrand to Archon Arena _(PRIORITY)_

-   [x] Rename user-visible strings: site title, page titles, navbar, about/help pages.
-   [x] package.json name/description, manifest, HTML meta tags, OpenGraph tags.
-   [x] Replace TCO branding references in client UI components.
-   [ ] New logo / favicon / color theme (needs design assets from owner).
-   [ ] Email templates (registration, password reset) rebranded.
-   [ ] Legal pages: ToS, privacy policy, KeyForge/FFG/Ghost Galaxy IP acknowledgement.
-   [ ] Keep internal code identifiers stable where renaming risks gameplay breakage
        (rename UI-facing only; engine internals renamed opportunistically later).

**Why early:** cheap, zero gameplay risk, and everything deployed from day one carries the
correct identity.

## Phase 2 — Production deployment on ArchonArena.com _(PRIORITY)_

-   [x] Choose hosting (VPS w/ Docker Compose to start; K8s charts retained for later) —
        rationale in docs/DEPLOYMENT.md.
-   [x] Production docker-compose: web, game node(s), Postgres, Redis, reverse proxy
        (docker-compose.prod.yml).
-   [x] Caddy reverse proxy with automatic TLS (deploy/Caddyfile).
-   [ ] Point ArchonArena.com DNS (Porkbun) at the host — **owner action**; records
        documented in docs/DEPLOYMENT.md §2.
-   [ ] WebSocket pass-through for game server verified end-to-end on the live host
        (routing designed in Caddyfile; needs a real deploy to verify).
-   [x] Environment/secrets management (.env.production.example, gitignored secrets,
        env-mapped config keys).
-   [x] DB backup + restore runbook (docs/DEPLOYMENT.md §5); automating off-host copies
        still open.
-   [ ] Health checks + uptime monitoring + error tracking (e.g. Sentry self-host or SaaS).
-   [ ] Staging environment (staging.archonarena.com) deploying from main.
-   [ ] Zero-downtime deploy script (at minimum: drain game node, deploy, restart).
-   [ ] Migrate legacy MongoDB usage → PostgreSQL (incremental; new services are PG-only,
        legacy stores migrated table-by-table with dual-write shim where needed).

## Phase 3 — Authentication: Keybringer SSO _(PRIORITY)_

Keybringer runs Keycloak (`account.keybringer.com/realms/keybringer`) — standard
OpenID Connect.

-   [ ] Current-state analysis of TCO auth (local username/password + JWT) — doc.
-   [ ] Add OIDC login via Keycloak (`openid-connect` authorization code + PKCE flow).
-   [ ] Account linking: existing local accounts can link a Keybringer identity;
        new users can register purely via Keybringer.
-   [ ] Admin setting: enable/disable local registration vs SSO-only **(admin-config)**.
-   [ ] Token refresh, logout (RP-initiated), session revocation.
-   [ ] Role mapping: Keycloak roles/groups → Archon Arena roles (admin, TO, moderator).
-   [ ] Auth service extracted behind an interface so future providers (Discord OAuth etc.)
        are pluggable.
-   [ ] Tests: OIDC callback, link/unlink, role sync, token expiry.

**Open question for owner:** we need a Keycloak client registered in the keybringer realm
(client id, redirect URIs for archonarena.com + localhost dev). Requires realm admin access.

## Phase 4 — Deck service: Decks of KeyForge SAS integration _(PRIORITY)_

-   [ ] Current-state analysis of TCO deck import (Master Vault API) — doc.
-   [ ] Standalone **Deck Service** module: owns deck storage, import, enrichment.
-   [ ] Integrate Decks of KeyForge (DoK) API: fetch SAS, AERC scores per deck.
-   [ ] Store SAS snapshot + fetch date per deck; periodic refresh job (SAS changes over time).
-   [ ] Admin settings **(admin-config)**: DoK API key, refresh interval, rate limits,
        enable/disable SAS display.
-   [ ] Show SAS/AERC on deck lists, lobby, and pre-game screen.
-   [ ] Graceful degradation when DoK is down (cached values, "SAS unavailable" state).
-   [ ] Tests: import, enrichment, refresh, API failure paths.

## Phase 5 — Rating engine: SAS-adjusted Elo _(PRIORITY)_

Chess Elo, modified by (a) key differential of the result and (b) SAS (power) difference
between the two decks. Playing up in SAS and winning big should pay more; stomping with a
much stronger deck pays less.

-   [ ] Standalone **Rating Service** (pure functions + persistence adapter; no gameplay
        engine coupling).
-   [ ] Core algorithm: - Expected score `E = 1 / (1 + 10^((Ro - Rp + sasWeight·ΔSAS)/400))` — ΔSAS shifts
        expectation toward the stronger deck. - Margin-of-victory multiplier from key differential (3–0, 3–1, 3–2 keys, forge-out
        vs. timeout, concession) similar to FIDE/Glicko margin variants. - `R' = R + K · movMultiplier(keyDiff) · (S − E)`.
-   [ ] All parameters **(admin-config)**: K-factor (with new-player/provisional K),
        sasWeight, MoV multiplier table, rating floor, placement game count, decay policy.
-   [ ] Rating history table (every game: pre/post rating, opponent, decks, SAS, key diff).
-   [ ] Provisional ratings + placement matches.
-   [ ] Separate rating pools **(admin-config)**: e.g. Archon, Alliance, Sealed; per-format.
-   [ ] Recalculation tool (replay rating history after config change; admin-triggered).
-   [ ] Unit tests: algorithm properties (zero-sum, monotonicity in key diff, SAS handicap
        direction), golden-value tests, config edge cases.

## Phase 6 — Rankings & leaderboards _(PRIORITY)_

-   [ ] Player profile fields: country, state/province, region (self-declared; validated
        against ISO-3166 / subdivisions list).
-   [ ] Leaderboards: worldwide, region (e.g. NA/EU/APAC/LATAM), country, state **(admin-config
        region definitions)**.
-   [ ] Redis-backed leaderboard (sorted sets) with periodic PG snapshot for history.
-   [ ] Minimum games threshold + activity window to appear on boards **(admin-config)**.
-   [ ] Seasons: start/end, soft reset rules **(admin-config)**.
-   [ ] Leaderboard UI with filters + player rank card on profile.
-   [ ] API endpoints for rankings (public, paginated, cached).

## Phase 7 — Tournament engine _(PRIORITY)_

-   [ ] Standalone **Tournament Service** (own tables, own API; talks to game engine via
        events/adapters only).
-   [ ] Formats: Swiss, single elim, double elim, round robin; Archon/Sealed/Alliance.
-   [ ] **Online mode:** auto-created games on Archon Arena, result auto-reporting from the
        game engine, round timers, no-show handling.
-   [ ] **In-person mode:** TO dashboard, manual pairings display, result slips (mobile-first
        result entry), QR join codes, printable pairings.
-   [ ] Hybrid events (online + paper results feeding one standing).
-   [ ] TO tools: create/edit events, registration windows, deck registration (with SAS
        caps/bands as an option **(admin-config per event)**), drops, byes, penalties.
-   [ ] Tournament results feed the Rating Service (weighting **(admin-config)**).
-   [ ] Standings, pairings, and brackets pages (public, spectator-friendly).
-   [ ] Tests: pairing algorithms (Swiss constraints), bracket progression, result flows.

## Phase 8 — Modern UI

-   [ ] UI audit of TCO client (React versions, component inventory) — doc.
-   [ ] Design system: tokens, typography, dark/light themes, component library.
-   [ ] Incremental page-by-page modernization (lobby → decks → profile → game UI last,
        since game UI carries the most gameplay risk).
-   [ ] Responsive layouts (desktop-first, tablet functional, mobile readable).
-   [ ] Accessibility pass (keyboard nav, contrast, screen-reader landmarks).

## Phase 9 — Player identity & community

-   [ ] Rich player profiles: avatar, bio, location, ratings, badges, favorite decks,
        match history summary.
-   [ ] **Clubs** (local scenes/stores): membership, club pages, club leaderboards.
-   [ ] **Teams** (competitive): rosters, team events, team rating.
-   [ ] Friends/follow, blocks, DMs (moderated), presence.
-   [ ] Moderation tools: reports, mutes, bans, audit log **(admin-config policies)**.

## Phase 10 — Match history, replays & spectating

-   [ ] **Replay Service:** persist full game event stream per match (engine already
        event-driven; capture at the message layer, storage-budgeted **(admin-config
        retention)**).
-   [ ] Replay viewer: step through games, jump to key turns.
-   [ ] Match history page: filters by deck, opponent, format, result.
-   [ ] Spectator mode: live view with hidden-information redaction; optional delay
        **(admin-config)**; spectator count display.
-   [ ] Share links for replays/matches.

## Phase 11 — Statistics & analytics

-   [ ] **Statistics Engine** service: consumes game-end + replay events, computes aggregates
        async (never in game path).
-   [ ] Player stats: win rates by house/set/format, key rates, average game length.
-   [ ] Deck stats: per-deck W/L, SAS vs. performance deltas.
-   [ ] Meta dashboards: house/set win rates, SAS bands vs. win %, matchup matrices.
-   [ ] Admin analytics: DAU/MAU, games/day, queue health, funnel metrics.
-   [ ] Public API for stats (rate-limited, cached, versioned).

## Phase 12 — Platform APIs

-   [ ] Versioned public REST API (`/api/v1`): profiles, ratings, rankings, tournaments,
        match history, deck metadata.
-   [ ] API keys + OAuth scopes for third-party apps **(admin-config rate limits)**.
-   [ ] Webhooks: tournament events, match completion.
-   [ ] OpenAPI spec, generated docs page.

## Phase 13 — Coaching & AI analysis

-   [ ] Coaching profiles/marketplace: coaches list availability, students book sessions.
-   [ ] Shared replay review rooms (coach + student stepping through a replay together).
-   [ ] AI game analysis: blunder detection, alternative-line suggestions, win-probability
        graph per turn (model over replay event stream).
-   [ ] AI deck insights: strengths/weaknesses vs. meta, SAS-context commentary.

## Phase 14 — Mobile support

-   [ ] Mobile-responsive web as baseline (from Phase 8).
-   [ ] PWA: installable, push notifications for round pairings/turn timers.
-   [ ] Evaluate React Native wrapper vs. PWA-only — decision doc.

## Phase 15 — Streaming & content tools

-   [ ] Overlay endpoints for OBS (current game state, player names, ratings, key count).
-   [ ] Featured-match page for events; caster mode (both hands visible, delay enforced).
-   [ ] Clip/share moments from replays.

## Phase 16 — Discord integration

-   [ ] Discord OAuth account linking.
-   [ ] Bot: tournament announcements, round pairings pings, result reporting commands.
-   [ ] Webhooks to club/team Discord servers **(admin-config per club)**.
-   [ ] Rich presence ("Playing on Archon Arena").

## Phase 17 — Organized play program

-   [ ] Sanctioned event tooling: TO certification levels, event sanctioning workflow.
-   [ ] OP points/season circuit distinct from Elo **(admin-config point tables)**.
-   [ ] Regional/national/world championship series structures.
-   [ ] Prize/invite tracking, top-N qualification reports.

---

## Cross-cutting: Site administration _(build alongside every phase)_

-   [ ] **Admin panel** with role-gated sections (settings, users, tournaments, moderation,
        analytics).
-   [ ] **Settings service**: typed settings registry, DB-backed, cached in Redis, audited
        (who changed what/when), with sane defaults in code.
-   [ ] Everything marked **(admin-config)** above is wired through this service.
-   [ ] Feature flags for gradual rollout of every new system.

## Cross-cutting: Quality & operations

-   [ ] Gameplay regression suite kept green on every PR (card tests from upstream).
-   [ ] Load testing for game nodes + matchmaking before public launch.
-   [ ] Upstream sync process: periodically merge keyteki card fixes (`docs/UPSTREAM.md`).
-   [ ] Data migration/versioning discipline: every schema change is a numbered migration.
-   [ ] Security: dependency audit, rate limiting, OWASP pass before launch.

---

## Immediate next steps (working queue)

1. ~~Import keyteki source into this repo (Phase 0).~~ ✅
2. ~~Initial rebrand pass — user-visible strings (Phase 1).~~ ✅
3. Get build + tests green; record baseline (Phase 0).
4. Docker compose stack + deployment docs for ArchonArena.com (Phase 2).
5. Keybringer OIDC spike: confirm client registration needs (Phase 3).
6. Deck service extraction + DoK SAS fetch (Phase 4).
7. Rating service with configurable SAS-adjusted Elo (Phase 5).
