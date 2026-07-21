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
-   [x] Logo + favicons: Archon Arena mark (amber keyhole in hexagonal arena) generated
        by scripts/generate-brand-assets.js; theme-color metas updated. Full site color
        theme pass still open (below).
-   [ ] Site-wide color theme aligned to the brand mark (accent/amber pass over the UI);
        owner may also supply custom art to replace the generated mark.
-   [ ] Email templates (registration, password reset) rebranded.
-   [x] Legal pages: privacy policy rewritten for Archon Arena (what/why/who/retention,
        no ads or trackers); About page rewritten (platform intro, ratings explainer,
        lineage credits, FFG/Ghost Galaxy IP acknowledgement). ToS still open.
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

-   [x] Current-state analysis of TCO auth (local username/password + JWT) —
        docs/design/keybringer-sso.md.
-   [x] OIDC login via Keycloak (authorization code + PKCE, JWKS signature validation,
        no new dependencies) — server/services/auth/OidcService.js + /api/account/oidc/\*.
-   [x] Account resolution: existing link → login; verified-email match → auto-link;
        otherwise create a pre-verified account. New users can register purely via
        Keybringer.
-   [x] Provider-agnostic config **(admin-config-ready)**: OIDC\_\* env vars; login page
        button appears only when the server reports SSO enabled.
-   [x] Tests: request construction, RS256 verification, nonce/issuer/key rejection,
        identity resolution paths (13 tests).
-   [ ] **Owner action:** register the Keycloak client in the keybringer realm (client
        id/secret, redirect URIs for archonarena.com + localhost) and set OIDC\_\* env vars.
-   [x] Sign-up entry point: "Sign up with Keybringer" on the Register page (shared
        SsoButton; hidden until SSO is configured).
-   [x] Link/unlink UI in account settings (Connected Services), with orphan
        protection: unlink refused while the account has no password and no other
        identity.
-   [ ] Admin setting: SSO-only mode (disable local registration) **(admin-config)**.
-   [ ] RP-initiated logout against Keycloak; session revocation on unlink.
-   [ ] Role mapping: Keycloak roles/groups → Archon Arena roles (admin, TO, moderator).
-   [ ] Password-set flow for SSO-created accounts.

## Phase 4 — Deck service: Decks of KeyForge SAS integration _(PRIORITY)_

-   [x] Current-state analysis of TCO deck import (Master Vault API) —
        docs/design/deck-sas.md.
-   [x] Integrate Decks of KeyForge (DoK) API: fetch SAS/AERC per deck
        (server/services/dok/DokService.js; DeckSas table keyed by Master Vault uuid).
-   [x] Store SAS snapshot + fetch date; stale rows refresh in the background on access
        (bounded per request).
-   [x] Config-driven **(admin-config-ready)**: DoK API key (DOK_API_KEY), refresh
        interval, timeout, enable/disable.
-   [x] Graceful degradation when DoK is down (cached values, SAS simply absent).
-   [x] Tests: enrichment, refresh windows, API failure paths (19 tests).
-   [ ] Show SAS on deck _lists_, lobby games, and pre-game screen (deck page done).
-   [ ] Periodic refresh sweep job (currently access-triggered only).
-   [ ] Wire DoK settings into the runtime admin settings service once it exists.
-   [ ] AERC component breakdown display from stored RawData.

## Phase 5 — Rating engine: SAS-adjusted Elo _(PRIORITY)_

Chess Elo, modified by (a) key differential of the result and (b) SAS (power) difference
between the two decks. Playing up in SAS and winning big should pay more; stomping with a
much stronger deck pays less.

-   [x] Core algorithm as a pure calculator (`server/services/rating/EloCalculator.js`;
        design: docs/design/rating-engine.md): SAS handicap folded into expected score,
        key-differential margin-of-victory multipliers, provisional K, rating floor.
-   [x] All calculator parameters override-driven **(admin-config)** with validation:
        K-factor, provisional K + game count, sasWeight, MoV tables, floor, default rating.
-   [x] Unit tests: algorithm properties (zero-sum, monotonicity in key diff, SAS handicap
        direction), golden-value tests, config edge cases (27 tests).
-   [x] RatingService orchestration layer: hooks GAMEWIN at the lobby/router layer
        (ARCHON-marked, fire-and-forget, idempotent), zero gameplay-engine coupling.
-   [x] DB: Ratings + RatingHistory tables (migration 24) with per-game Elo config
        snapshot; SAS joined from DeckSas at rating time.
-   [x] Public API: GET /api/ratings/:username (pool, rating, gamesPlayed, provisional).
-   [ ] Show ratings in the UI (profile page, lobby player names) — with Phase 6
        leaderboards.
-   [ ] Wire admin settings service overrides into RatingService (needs settings service).
-   [ ] Rating decay policy **(admin-config)**.
-   [ ] Provisional/placement UX (badge until N games).
-   [ ] Separate rating pools **(admin-config)**: e.g. Archon, Alliance, Sealed; per-format.
-   [ ] Recalculation tool (replay rating history after config change; admin-triggered).

## Phase 6 — Rankings & leaderboards _(PRIORITY)_

-   [x] Player profile fields: country (validated ISO-3166 alpha-2) + state/province
        (US/CA dropdowns, free text elsewhere) — Profile > Account > Location; migration 25.
-   [x] Region mapping: country → NA/LATAM/EU/MEA/APAC (server/services/rating/regions.js;
        code-defined for now, admin-config later).
-   [x] Leaderboards: worldwide, region, country, state over rating pools; disabled
        accounts excluded; provisional flag shown.
-   [x] Minimum games threshold to appear on boards (rating.leaderboardMinGames,
        config-driven).
-   [x] Leaderboard UI (Community > Leaderboards): scope tabs follow the viewer's saved
        location, pool tabs (Archon/Sealed/Alliance), pagination, own-row highlight.
-   [x] Public API: GET /api/ratings/leaderboard (paginated, capped limit).
-   [ ] Redis-backed leaderboard cache (sorted sets) once traffic warrants; PG indexes
        carry current scale fine.
-   [ ] Activity window on boards **(admin-config)**.
-   [ ] Seasons: start/end, soft reset rules **(admin-config)**.
-   [ ] Player rank card on profile page; ratings shown on lobby player names.

## Phase 7 — Tournament engine _(PRIORITY)_

-   [x] Standalone **Tournament Service** (own tables/API, zero gameplay-engine coupling;
        docs/design/tournament-engine.md; migration 27).
-   [x] Formats: Swiss (score groups, rematch-avoiding backtracking, byes) and single
        elimination (seeded, top-seed byes); Archon/Sealed/Alliance per event.
-   [x] Event lifecycle: create (any logged-in user organizes), registration window,
        drops (self or TO), round pairing gated on complete results, finish/cancel.
-   [x] Result flow: participants report open results, organizer can correct; byes
        auto-win; table numbers per pairing for IRL play.
-   [x] Standings: points → strength-of-schedule → fewest byes; live on the event page.
-   [x] Public pages: tournament list + create form, event page with players, per-round
        pairings, reporting buttons, standings, TO controls.
-   [x] Tests: pairing algorithms + lifecycle/authorization (26 tests).
-   [ ] **Online automation (increment 2):** auto-created games per pairing, GAMEWIN
        auto-reporting, round timers, no-show handling.
-   [ ] Tournament results feed the Rating Service (weighting **(admin-config)**).
-   [ ] Formats: double elimination, round robin, Swiss cut to top-N.
-   [ ] TO tools: deck registration with SAS caps/bands **(admin-config per event)**,
        penalties, printable pairings, QR join codes.
-   [ ] Hybrid events (online + paper results feeding one standing).

## Phase 8 — Modern UI

-   [ ] UI audit of TCO client (React versions, component inventory) — doc.
-   [ ] Design system: tokens, typography, dark/light themes, component library.
-   [x] Chess.com-style navigation: fixed left sidebar (Play/Learn/Watch/Community/Other
        with flyout submenus, Sign Up/Log In at bottom) on all non-game screens; in-game
        keeps the slim top bar so the board keeps full width.
-   [x] Home page rebuilt as a landing hero (news → Community > News; lobby chat and
        promo banners removed; admin MOTD/banner notices retained).
-   [x] Placeholder pages routed for Learn, Watch, Play IRL, Stats, Tournaments, and
        Community subpages so navigation is complete ahead of the features.
-   [ ] Incremental page-by-page modernization (decks → profile → game UI last,
        since game UI carries the most gameplay risk).
-   [ ] Responsive layouts (desktop-first, tablet functional, mobile readable).
-   [ ] Accessibility pass (keyboard nav, contrast, screen-reader landmarks).

## Phase 9 — Player identity & community

-   [ ] Rich player profiles: avatar, bio, location, ratings, badges, favorite decks,
        match history summary.
-   [x] **Clubs v1** (local scenes/stores): create/join/leave, club pages with member
        lists, owner remove/disband (server/services/community/ClubService). Follow-ups:
        club leaderboards, approval-based joins, ownership transfer.
-   [x] **Club invite codes**: every club gets a shareable 8-char join code (owner-visible
        with copy button); join-by-code endpoint used by the club page and onboarding.
-   [x] **First-run onboarding wizard** (`/welcome`, docs/design/onboarding.md): new
        accounts are walked through location, club join (code or search), deck import,
        and profile picture - all skippable; completion stamped in Users.OnboardedAt
        (existing users backfilled as onboarded). Follow-ups: highlight a "play your
        first game" step once casual matchmaking lands.
-   [x] **Member directory**: public searchable member list (username/country filters,
        rating-sorted, privacy-safe fields only) with joined-24h/total/online stats.
-   [ ] **Teams** (competitive): rosters, team events, team rating.
-   [x] **Friends v1**: requests by username, accept/decline/cancel/remove, mutual-request
        auto-accept, online presence dots (server/services/community/FriendService).
        Follow-ups: block-list integration, DMs (moderated), friend activity feed.
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

-   [x] **Settings service**: typed registry, DB-backed (SiteSettings), in-memory
        snapshot with periodic refresh, who/when audit, defaults in code
        (docs/design/settings-service.md).
-   [x] Admin settings UI at /admin/settings (isAdmin): rating engine (all Elo knobs,
        rated types, leaderboard threshold) and DoK sections editable at runtime.
-   [ ] Wire remaining **(admin-config)** flags through the registry as their features
        land (auth SSO-only mode, tournament defaults, region definitions...).
-   [ ] Redis pub/sub snapshot invalidation for multi-lobby deployments.
-   [ ] Full audit-log table (currently last-editor only).
-   [ ] Feature flags section for gradual rollout of new systems.
-   [ ] Broader **admin panel** (users, tournaments, moderation, analytics) as those
        systems arrive.

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
3. ~~Get build + tests green; record baseline (Phase 0).~~ ✅
4. ~~Docker compose stack + deployment docs for ArchonArena.com (Phase 2).~~ ✅
5. ~~Keybringer OIDC login flow (Phase 3).~~ ✅ (owner: register Keycloak client)
6. ~~DoK SAS fetch + display (Phase 4).~~ ✅
7. ~~SAS-adjusted Elo calculator (Phase 5, increment 1).~~ ✅
8. **Owner actions:** provision a VPS + point Porkbun DNS (docs/DEPLOYMENT.md §2);
   register the Keycloak client (docs/design/keybringer-sso.md); get a DoK API key.
9. RatingService persistence + GAMEWIN wiring (Phase 5, increment 2).
10. Rankings: profile location fields + leaderboards (Phase 6).
11. Site Settings service + admin panel foundations (cross-cutting).
12. Tournament engine data model + Swiss pairing core (Phase 7).
