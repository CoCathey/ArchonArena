# Archon Arena — Product & Engineering Roadmap

> **Vision:** A next-generation competitive KeyForge platform — think Chess.com for KeyForge —
> built on the proven gameplay engine of The Crucible Online (keyteki), extended with modern
> ratings, tournaments, rankings, analytics, and community features.
>
> **Prime directive:** Gameplay stays 100% compatible with TCO and always remains stable.
> New systems are built _around_ the gameplay engine as loosely-coupled services, never by
> rewriting working gameplay.

**Last full codebase audit:** 2026-08-17.

## How this document is used

-   Every feature and task lives here **before** it is built.
-   Items are checked off (`[x]`) when complete and eventually pruned to the CHANGELOG.
-   **Sequencing lives in the [Prioritized backlog](#prioritized-backlog)**, not in the phase
    numbers. Phases are thematic groupings of related work; the backlog says what to build next.
-   Backlog items carry an ID (`I1`, `N3`, `F2`), explicit **dependencies**, and
    **acceptance criteria** so an item can be picked up and finished without re-deriving scope.
-   Each phase lists **why** it is grouped the way it is.
-   Anything marked **(admin-config)** must be runtime-configurable by site admins via the
    admin panel / settings service — no redeploy needed to tune it.

## Architecture principles (apply to every phase)

Standing commitments rather than tasks, so they are never "done" — but each is checked against
the tree at every audit, and one of them is not being kept.

-   [x] Clean architecture; gameplay engine, tournament engine, statistics engine, auth,
        deck service, replay service, membership, moderation, API, and frontend are separate,
        loosely-coupled modules under `server/services/`.
-   [x] Prefer reusable services over logic embedded in the gameplay engine. The engine is still
        reached through the ordinary player interface even by the Champion’s Challenge bots.
-   [ ] **Not kept: TypeScript for all new code.** The server has zero `.ts` files and the web
        client one `.d.ts`; everything added since the fork — ratings, tournaments, membership,
        moderation, the Champion’s Challenge — is JavaScript, type-checked only as far as JSDoc and
        `checkJs: false` allow. The Expo app is the exception and is fully TypeScript. Either
        start keeping this or strike it; carrying a principle nothing follows makes the rest of
        the list mean less.
-   [x] PostgreSQL as the system of record; Redis for cache/queues/presence/rate limits. No
        MongoDB remains anywhere.
-   [x] Docker for local dev and production parity.
-   [x] Never introduce breaking changes to gameplay if avoidable; incremental refactoring only.
-   [x] Every feature ships with: current-architecture analysis, proposed architecture, files
        changed, DB migrations, API changes, tests, and future considerations — the larger ones
        as a design note in `docs/design/`.
-   [ ] Design for tens of thousands of users (horizontal scale of game nodes, stateless API).
        Untested: no load test has been run, and the multi-node fleet was reverted (**N10**).
-   [x] A central **Site Settings service** backs all admin-configurable values with audit log —
        with the three exceptions named under Site administration.

---

## Where the platform stands (2026-08-17)

**The engineering is far ahead of the operations.** Almost every headline system in this
roadmap — ratings, tournaments, community, matchmaking, statistics, replays, notifications,
moderation, a premium membership, a native iOS app — is built, tested, and wired end to end.
The site is live and players are playing real games on it (**I1**).

**Four things changed the shape of the platform since the last audit.** The tournament engine
went from "the most complete system and the least finished product" to running every format to
a champion against real PostgreSQL, with the deck lock, hybrid and asynchronous events, prize
pools and organizer exports (**N9**, **N17**). A premium membership system landed and grew into
its own product surface — tiers, capabilities, Archon Intelligence, the Tournament Lab, AERC
analysis, replay analysis, cosmetics, a preview programme and the Champion’s Challenge
(**N12**, **N18**). Moderation, teams, in-person games and a Learn-to-Play walkthrough — all four listed
as _missing entirely_ at the last audit — shipped (**N5**, **N7**, **N13**, **N11**). And the
platform stopped renting its idea of deck strength: **ARI** (**N19**) is now what the Elo
handicap reads, with SAS demoted to the seed, while thirteen practice bots keep an open table in
the lobby at all times (**F9**) and a learning bot studies its own games (**N21**).

**What is missing is the last mile, and it is mostly operational or visual.** Observability is
still unset on the live host (**Q1**) and there are no off-host backups (**I7**) — both gated on
owner actions rather than code. The largest genuinely unbuilt work is now the look of the site
(**N16**), the responsive/accessibility/PWA pass (**N6**), and self-serve app distribution
(**N14**). The zero-downtime deploy was built and then reverted (see below), so a deploy still
ends games in progress.

**Built and working**

| Area                 | State                                                                                                                                                                                                                                                                       |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Gameplay engine      | keyteki fork, 14 sets, 40,245-test baseline, green in CI; shuffles and coin flips drawn from `crypto` rather than `Math.random`                                                                                                                                             |
| Brand & navigation   | Full rebrand, chess.com-style sidebar, landing hero, token-based light/dark theme                                                                                                                                                                                           |
| Auth                 | Local (with verified activation email) + Keybringer OIDC (PKCE, JWKS, auto-link, link/unlink UI) built but disabled; owner-initiated account deletion distinct from a ban                                                                                                   |
| Decks                | Master Vault import, DoK SAS enrichment + background refresh sweep, rate-limited outbound calls, bulk collection import, a remembered DoK key with scheduled sync, a paced import worker, a Master Vault name catalog, Alliance builder                                     |
| Ratings ("Amber")    | ARI-adjusted Elo (SAS seeds it, play moves it), FIDE-style K tiers, provisional K, floors, decay, seasons + archive, recalculation tool, admin tools, pools (Archon/Sealed/Alliance)                                                                                        |
| Rankings             | Leaderboards under Community (world/region/country/state), a single Stats page, W–L records, public player profiles every username links to                                                                                                                                 |
| Tournaments          | Swiss / single-elim / double-elim / round robin / cut-to-top-N, Bo1/3/5, online / in-person / hybrid / asynchronous, waitlists, QR check-in, staff and judge tools, seeding, penalties, brackets, printables, prize pools, entry-fee register                               |
| Matchmaking          | Quick Match queue with Amber-proximity pairing and widening tolerance, plus queue-health telemetry                                                                                                                                                                          |
| Notifications        | Typed taxonomy, in-app centre (bell + unread), branded email over Resend / SMTP / SES with a daily and monthly budget cap, Expo push to the phone, per-category opt-out                                                                                                     |
| Community            | Friends, member directory, clubs (leaderboards, approval joins, named invitations, ownership transfer), teams with their own ladder, local store directory, Play IRL hub, in-person game tracking, onboarding wizard                                                        |
| Moderation           | Reports with captured snapshots, claim/resolve queue, graduated actions with reason and expiry, chat content filter, full audit log, admin-config policy thresholds                                                                                                         |
| Membership (Archon+) | Tiers → capabilities → entitlements, badges beside names everywhere, Archon Intelligence, Tournament Lab, AERC analysis, deck comparison, replay analysis and the misplay review, profile cosmetics, the preview programme, organizer CSV exports, the Champion's Challenge |
| Statistics           | Meta dashboard (house/set win rates, SAS bands, format share, house matchup matrix) + per-player and per-deck breakdowns, TTL-cached                                                                                                                                        |
| Match history        | Filterable Game History on PostgreSQL; board-state replays with forge jumps, turn navigation, playback, per-player perspective and public share links; Watch hub                                                                                                            |
| Learn                | A played-through Learn-to-Play walkthrough at `/learn` — 93 steps, no account needed                                                                                                                                                                                        |
| Admin                | Settings service + `/admin/settings` (sixteen sections including feature flags, bots and moderation policy), `/admin/analytics`, `/admin/moderation`, `/admin/bots`, user/ratings/season/banlist/nodes/motd/news/bug-report admin, scoped statistics reset                  |
| Mobile               | Expo iOS app (`mobile/`): login, decks, lobby, pending, full board, spectate, reconnect, tournaments, membership, Archon Intelligence, push notifications; EAS + TestFlight runbook; App Store compliance pass                                                              |
| Ops                  | CI (typecheck/lint/build/test + CodeQL), weekly upstream-sync workflow, prod compose + Caddy TLS, `deploy/healthcheck.sh`, `deploy/update.sh`, encrypted off-host backup/restore rehearsed in CI, Sentry wired client + server                                              |

**Incomplete — built but not finished**

-   **Caster mode** does not exist. Spectating, the Watch hub, spectator counts, a featured
    match and a server-enforced broadcast delay all do (**N1**); both hands visible to a
    caster is the remaining half, and it belongs with **F4** because it needs a privileged
    view rather than a delay.
-   **The zero-downtime deploy was built and reverted** (895b773 reverting aedefdd and
    86f5cfa): games could not be started on the deployed stack, which is worse than the problem
    it solved. `deploy/update.sh` runs `up -d --build` again, so a deploy still ends every game
    in progress, the node's health port is read-only, and the admin Restart button is inert
    (it shells out to `pm2`, which is not installed). Reverted with it, and worth restating:
    a game result published while the lobby is restarting is dropped with no retry, so that
    game is never recorded, rated or replayed. → **N10**.
-   **SAS on the lobby game list.** Deliberately skipped, not missed: decks are not chosen for
    open games, so there is nothing to show there yet. Everywhere else — deck lists, the deck
    view with its AERC breakdown, the pre-game screen, per-deck stats — is done (**N3**).
-   **Admin-config coverage** stops short of auth (SSO-only mode) and matchmaking parameters.
    Moderation policy, feature flags and a full audit log are now wired.
-   **Web push.** Push to the Expo app is built and delivering; browser push still waits on the
    PWA (**N6**).
-   **Membership perks are gated in code, not in settings.** `tiers.js` is the single place that
    says which tier unlocks what, which is deliberate — but the roadmap asked for it to be
    admin-config, and it is not. Five capabilities are still flagged `planned` and rendered as
    such rather than as included.
-   **Onboarding still teaches every new player the same thing.** The walkthrough exists; the
    question that would let it teach each player only what they are missing does not (**N11**).

**Missing entirely**

-   **A funding path that has actually been used.** Tiers, capabilities, per-tier checkout
    links, Patreon sync and a diagnostics endpoint are all built and tested — but there is no
    campaign, no credentials set, and no page saying where the money goes (**N12**).
-   **Self-serve app distribution.** `/mobile/ios` and `/mobile/android` are still `Placeholder`
    pages, so the only way into the beta is knowing the owner (**N14**).
-   **Staging and load testing** (**N10**).
-   **Something to _watch_ on an empty site.** The empty-lobby problem is half solved: thirteen
    practice bots keep an open table you can join at any hour (**F9**). What is still missing is
    the bot-vs-bot showcase — the node driver already plays both seats, so what remains is the
    supervisor that keeps one live and lists it on the Watch hub.
-   **PWA, a responsive pass, an accessibility pass** (**N6**) and the **visual redesign**
    (**N16**).
-   **Versioned public API**, **Discord**, **coaching and AI analysis** beyond the shipped
    misplay review, **streaming tools**, **organized-play program**.

**Not yet verified in production:** Sentry DSN and external uptime monitoring (**Q1**), the
off-host backup bucket (**I7**), a working outbound mail transport (**I6**), Patreon campaign
credentials (**N12**), Keycloak client registration (deferred, **Phase 3**).

---

## Prioritized backlog

### Immediate — make the platform real

_Goal: a live, safe, sticky site. Nothing below this line is worth much until players can
reach the platform and feel the competitive loop close._

#### I1 — Go live on archonarena.com and verify end to end _(done)_

**Why:** every system in this document is speculative until real players are on it. This was
the single highest-value item on the roadmap, and it is closed: the site is live and players
are playing real games on it.
**Tasks**

-   [x] Owner: VPS provisioned, Porkbun DNS pointed at it (docs/DEPLOYMENT.md §2), DoK API
        key obtained.
-   [~] **Keycloak client in the keybringer realm — deferred.** Registering it needs Ghost
    Galaxy's permission, which the platform does not have, so Keybringer SSO is out of
    scope until that changes. Nothing is blocked by it: `auth.oidc.enabled` is `false` by
    default, the login page asks `/api/account/oidc/status` before offering the button, and
    local registration is a complete signup path on its own. When permission does arrive
    this becomes config, not code.
-   [x] **Soft launch done** — the stack is up behind Caddy and friends are playing real
        games on it. That closes the bring-up half of this item and moves the risk from "will
        it work" to "what happens when it breaks", which is what the two unticked lines below
        are about.
-   [x] Live, with players. Two players on two networks complete full games, registration
        works against the live host, and decks import with SAS attached.
-   [>] Observability moved to **Q1** rather than held open here. Being live is what this item
    was about; knowing when it breaks is a standing operational concern, not a launch gate,
    and leaving I1 open for it would have hidden the fact that launch is done.

**Depends on:** nothing; done. Unblocked: I7 and the public announcement.
**Acceptance criteria**

-   [x] Two players on two different networks complete a full game start-to-finish through
        `https://archonarena.com`, including a reconnect mid-game.
-   [x] Local registration succeeds against the live host. (Keybringer SSO is deferred above; it
        is not a launch gate.)
-   [x] A deck imports with SAS attached from the live DoK key.

#### I2 — Schema migration ledger and runner _(done)_

**Why:** production schema state was untracked. Migrations were applied file-by-file by hand,
nothing recorded what ran, and the schema directory carried two duplicate ordinals
(`40 - Seasons.sql` / `40 - TournamentMatchGames.sql`, `41 - GameReplays.sql` /
`41 - TournamentPlayerDecks.sql`). Every future feature ships a migration; this was the
highest-leverage operational fix on the list.
**Tasks**

-   [x] `SchemaMigrations` ledger (filename, sha256 checksum, applied-at, applied-by), in
        both the schema tree and as a migration.
-   [x] `npm run migrate`, with `--status` / `--dry-run` / `--baseline`. Each file applies in
        its own transaction alongside its ledger row, so the ledger can never claim a
        migration that half-applied.
-   [x] Refuses to run when an already-applied file has since been edited — the one case
        where two databases diverge silently and forever.
-   [x] A `--baseline` step, because a database built from `server/db/schema` already contains
        every migration's effect and replaying upstream migrations 01-21 at it would error.
        The runner refuses to guess: an untracked database with pending files exits non-zero
        with instructions rather than blindly applying history.
-   [x] Duplicate ordinals renumbered (done in the housekeeping sweep); `deploy/healthcheck.sh`
        now FAILs on a missing ledger or pending migrations; DEPLOYMENT.md rewritten.
-   [x] **Verified against a real PostgreSQL 16**: all 46 schema files apply cleanly in
        alphabetical order, baseline seeds 38 rows, a genuinely new multi-statement migration
        applies, an edited migration is refused, and every exit code is correct for CI. _(Counts
        as of that verification; the tree now carries 74 schema files and 71 migrations, and the
        two directories are numbered independently — see below.)_

> **The two numbering schemes, because they are easy to confuse.**
>
> `server/db/schema/*.sql` builds a database from empty and is what the Docker initdb mount
> runs; `server/db/schema/migrations/*.sql` moves an existing database forward and is what the
> ledger tracks. They have **separate ordinals** — in-person games are schema file 53 and
> migration 47 — and every "migration N" in this document means the second. New work adds a
> file to both.

**Depends on:** nothing. Blocks: safe iteration on every schema-touching item below.
**Acceptance criteria**

-   [x] A fresh database and a database at any historical point both converge to the same schema.
-   [x] Running the migrator twice in a row is a no-op the second time.
-   [x] Editing an already-applied migration file fails loudly instead of silently diverging.
-   [x] `healthcheck.sh` FAILs when the running code needs a migration that has not been applied.

#### I3 — Public player profiles _(done)_

**Why:** a competitive platform is built on players looking each other up. Every piece of
data is already served by an existing API (`/api/ratings/:username`,
`/api/stats/player/:username`, `/api/tournaments/history`, `/api/games`) — this is assembly,
not new systems, and it makes the whole site feel connected.
**Tasks**

-   [x] `/players/:username` renders header (avatar, location, joined, clubs), Amber per pool
        with world rank and W-L, overall record and house win rates, tournament podiums, and
        recent games each linking to its replay.
-   [x] `PlayerProfileService` + public `GET /api/players/:username` for the header, clubs and
        recent games. The page **composes** the already-public ratings, stats and tournament
        endpoints rather than adding a fifth aggregate that reaches across four domains, so each
        panel renders and degrades independently.
-   [x] Privacy-safe fields only, asserted by a test that the query never even selects Email,
        Password or RegisterIp; disabled and unverified accounts do not resolve, matching the
        member directory and leaderboards.
-   [x] Usernames link through from Leaderboards (podium and table), the member
        directory, and opponent names in recent games.
-   [x] Remaining link sites done: lobby game list, pending game, tournament players /
        standings / "Your Match", game history, club member lists. Every username outside the
        game board now links to its profile.
-   [x] Optional short bio, editable from the account page (`Users.Bio`, migration 52,
        `PlayerProfileService.getBio`/`setBio`, `GET`/`PUT /api/account/bio`). Capped at
        280 characters server-side, so the client's counter can never disagree with what
        actually gets saved; empty and whitespace-only values are stored as `NULL` rather
        than an empty string, matching how `State` already distinguishes "not set" from
        "set to nothing". Rendered on the public profile only when present.

**Acceptance criteria**

-   [x] Every username rendered outside the game board navigates to that player's profile.
-   [x] Verified in a real browser: the page renders every panel for a player with games, and a
        brand-new player with no games or clubs still gets a working page.
-   [x] No private field appears in the payload, asserted by a test.
-   [ ] Server-side caching like the stats endpoints, once traffic justifies it.

#### I4 — Post-game result screen with Amber change _(done)_

**Why:** the rating engine is the heart of the platform and it was invisible at the moment it
matters most. Players finished a rated game with no feedback that anything had happened.
**Tasks**

-   [x] `RatingService.getGameResult()` + `GET /api/games/:gameId/rating` read back the deltas
        RatingHistory already persists; nothing is recomputed.
-   [x] `GameResultPanel` on the board once the game is decided: win/loss, the Amber change,
        the new total, the pool, the key margin, the SAS gap that shaped the result, and the
        placement countdown while a rating is still provisional.
-   [x] Unrated games render an explicit "not rated" line rather than a blank panel — an
        unrated game is a 200 with `rated: false`, not a 404 the client has to interpret.
-   [ ] Rematch / view-replay / back-to-lobby actions alongside the result (the engine's own
        rematch prompt already sits directly below it).

**Blocks:** N4.
**Acceptance criteria**

-   [x] Both players see their own delta; Elo being zero-sum, the two are mirror images —
        asserted by a test.
-   [x] Rendered client-side from persisted data, so it never blocks or delays leaving the game
        and adds no gameplay-engine coupling.
-   [x] Deltas always match `RatingHistory`, because they are read from it.

#### I0 — Launch-blocking defects found by review _(done)_

**Why:** three defects that would each have been discovered only after the site was public,
found by auditing the launch path rather than the feature list. All three are fixed.

-   [x] **Transactional email was dead in every environment.** `EmailService` read
        `lobby.emailFrom`; no config file defines that key (both define `emailFromAddress`), so
        the sender was always undefined and every send hit the not-configured guard and returned.
        Account activation and password reset silently did nothing — a player who forgot their
        password had no route back into their account, and the only trace was an info-level log
        line. Fixed the key, added the missing `EMAIL_*` / `AWS_*` env mappings and
        `.env.production.example` entries, made the drop log at warn, made `sendEmail` report
        success, and made `healthcheck.sh` FAIL when no sender is configured.
-   [x] **Production seeded a known-password superuser.** `docker-compose.prod.yml` mounts the
        whole of `server/db/schema/` into `docker-entrypoint-initdb.d`, and
        `99 - Data.sql` — marked "NOT FOR PRODUCTION" in its own comment — inserted `admin`,
        `test0` and `test1` with the password `password`, granting `admin` the Admin role
        (a superuser implying every management permission). Any deployed database was one
        guess from full takeover. Demo accounts moved to `server/db/dev-seed/`, mounted only by
        the local `docker-compose.yml`; added `npm run grant-admin -- <username>` to bootstrap a
        real admin from a normally-registered account; `healthcheck.sh` now FAILs while any demo
        account exists.
-   [x] **The rate limiter could not limit anyone.** It keyed anonymous callers on the
        `x-real-ip` / `x-forwarded-for` request headers, which the caller controls, so varying
        the header per request minted a fresh bucket every time. Now keys on `req.ip` with
        `trust proxy` set to exactly the one Caddy hop in production (sound because only Caddy
        publishes ports) and nothing in development. Regression test included.
-   [x] **Security headers were never actually on.** `helmet` has been a dependency since the
        fork but was never mounted. Enabled with helmet@3 defaults plus a referrer policy.
-   [x] **Auth endpoints were unthrottled.** The limiter existed but was applied only to
        friend requests, club/store/tournament creation and DoK import — never to login,
        registration, password reset, activation, token refresh or username lookup. All six
        are now limited, and login additionally carries a failure throttle
        (`createFailureThrottle`) keyed per-IP and per-username: 10 failures in 15 minutes
        locks that key out for 15 minutes, and a successful login clears it, so counting
        failures rather than requests can be strict without penalising honest users. The
        session record also stopped trusting spoofable forwarding headers for the login IP.
-   [x] **Content-Security-Policy** (`server/csp.js`): production allows no inline or eval'd
        script, plus `object-src 'none'`, `base-uri`, `form-action` and `frame-ancestors`
        locked to self. Allowances are limited to what the client genuinely loads — Google
        Fonts, hCaptcha, `data:`/`blob:` images, `wss:` for gameplay, and the Sentry ingest
        origin derived from the configured DSN. Verified by loading the real production
        bundle in Chromium under the enforcing header: zero violations, with a negative
        control confirming violations are detected when the policy is wrong. `CSP_MODE`
        (`enforce` / `report-only` / `off`) can turn it down without a redeploy.

#### I5 — Pre-launch security and abuse pass _(done)_

**Why:** the moment the site is public it is a target, and account/auth endpoints are the
softest surface. When this item was written, rate limiting existed but was applied only to
bug reports, community actions, deck DoK prepare and tournament creation — not to login,
registration or password reset. Every auth endpoint is now limited, and the limits are
shared across lobby processes. The dependency tree went from 55 advisories (1 critical,
9 high) to 5 (all moderate, none in the production graph).
**Tasks**

-   [x] `helmet` upgraded v3 → v8. Its default CSP is disabled (it would break the site and
        emit a second header) and COOP relaxed to `same-origin-allow-popups` for the
        print-pairings popup — both verified in a browser.
-   [x] `npm audit` triaged. Everything non-breaking applied, including the **`ws`
        memory-exhaustion DoS that sat in the gameplay socket path**. Lint tooling moved to
        `devDependencies`, removing the whole eslint chain from the production graph.
-   [x] Authorization enumerated: every `/api/admin/*` route checks a permission and not just
        a JWT, and all thirteen tournament-organizer operations authorize in the service
        layer where the check cannot be bypassed.
-   [x] Secrets audit: nothing sensitive is settings-registry-editable, and reset tokens are
        never logged. SQL confirmed exclusively parameterised.
-   [x] `docs/SECURITY.md` written — controls, dependency triage with reasoning, two
        documented accepted risks, and a standing re-review checklist.
-   [x] **`fabric` v5 → v7** — the last root: every critical and high in the production tree
        traced to it alone. Fabric 5 vendors its own `canvas@2`, so the
        `canvas` → `node-pre-gyp` → `tar` chain — and the only critical — went with it.
        Fabric 7 uses the `canvas@3` already declared here and keeps a CommonJS entry
        (`fabric/node`), so no server caller had to become ESM.
    -   Fabric 6 was a rewrite, not a bump: the namespace became named exports, the node and
        browser builds split, `util.loadImage` and `Image.fromURL` became promises (the old
        callback form would simply hang forever), several methods stopped returning `this`,
        and `setWidth`/`setHeight` went away. Fabric 7 then changed the **default object
        origin from top-left to centre** — the one that would have shipped silently, since
        several call sites set `originX: 'center'` while relying on `originY` staying `top`.
        Restored once per side; `server/fabricNode.js` is now the server's only way in to
        Fabric so the next file that draws cannot re-break it.
    -   **Verified by the image-diff harness written first for exactly this** (see Quality &
        operations): eight of nine reference images byte-identical to the Fabric 5 output.
        The ninth moves the deck list's three separator rules up one pixel, because Fabric 5
        drew a zero-height stroked `Line` one pixel below its declared y — confirmed
        independent of the origin change, with nothing else in the image moving.
    -   The harness needed two fixes to be trustworthy: `playwright`/`pngjs` were never
        declared (npm pruned playwright as extraneous on the first install), and Playwright
        quietly prefers the headless shell over full Chromium, which rasterises text
        differently and read exactly like a rendering regression. The browser binary is
        pinned now and its identity recorded next to the baselines.
    -   Avatar upload — the only place the server draws with Fabric on a request path — had
        no coverage and now has a test that drives a real upload through `processAvatar`.
-   [x] **`socket.io-parser` patched to 4.2.7** — through 4.2.6 a peer could announce a
        binary event with zero attachments and the reconstructor held it open indefinitely
        (GHSA-2m8v-j782-fhvr), reachable by any connected client. A patch inside the range
        `socket.io` already asked for, so no constraint changed.
-   [x] **`precss` removed.** Declared as a devDependency, imported by nothing, and absent
        from `postcss.config.cjs`, which loads only `@tailwindcss/postcss` — dead weight
        carried over from the fork. It dragged in `postcss-preset-env@6` (2018) and with it
        the last remaining high advisory plus forty moderates, none of which had a fix
        available upstream. The built stylesheet keeps the same content hash, which is the
        proof it was inert.
-   [x] **Replaced the unmaintained `patreon` package with direct `fetch`.** It was three
        HTTP calls wrapped in a package that has been abandoned for years; it now talks to
        Patreon's **v2** API, because the package spoke the long-deprecated v1. Three high
        advisories went with it. The integration is still dormant, so **N12** still owns
        verifying it against a live campaign — the public interface is unchanged so N12 has
        the same surface to wire up.
-   [x] **Rate limiter and login failure throttle moved to Redis.** Being per-process
        quietly divided every limit by the number of lobbies — "10 login failures in 15
        minutes" meant 10 _per lobby_, and an attacker who reconnected got a fresh budget.
        Each decision is one Lua script, so check-and-record is atomic; a read followed by
        a separate write lets concurrent requests through at exactly the moment the limit
        matters. **Verified against a real Redis:** exactly 10 of 50 concurrent requests
        allowed, a lockout raised in one process visible from another, and windows that
        slide correctly. If Redis is unreachable the store falls back to per-process
        limits, so an outage degrades enforcement rather than removing it — and cannot take
        login down with it.
-   [x] **`style-src` no longer carries `'unsafe-inline'`, and `connect-src` no longer
        carries a blanket `wss:`.** Both were settled against the real built bundle in
        Chromium rather than by reasoning about what the app might do at runtime, with a
        negative control proving the check detects violations at all.
    -   Font Awesome was injecting ~15 KB of CSS into a runtime `<style>` tag; that is now
        off (`config.autoAddCss = false`) in favour of the bundled stylesheet — Font
        Awesome's own documented answer, and one less thing injected at runtime.
    -   React Aria's `usePress` prepends one 88-byte rule and offers no nonce hook, so it is
        allowed **by hash**. A hash pins content, which would silently stop applying on a
        library upgrade and quietly degrade mobile press handling — so a test rebuilds the
        rule from the installed package and fails CI instead.
    -   `wss:` permitted a websocket to _any host on the internet_. The documented topology
        keeps game nodes behind the same Caddy, so `'self'` covers them (verified in a
        browser — `'self'` matching ws/wss is a CSP3 behaviour, not something to assume).
        A split-host deployment is now opt-in via `GAME_NODE_ORIGINS`.

**Depends on:** nothing. Blocks: public announcement of the site.
**Acceptance criteria**

-   [x] A scripted credential-stuffing attempt against login is throttled and locked out,
        with a test — and the lockout is now visible from a second lobby process, not only
        the one that counted the failures.
-   [x] No high or critical advisory outstanding in `npm audit`, or each is documented with a
        reason. Zero of either remain; the five moderates left are all build-time and none is
        in the production graph.
-   [x] `docs/SECURITY.md` exists with the checklist, the date it was last run, and the
        results.

#### I6 — Terms of Service and transactional email polish _(mostly done)_

**Why:** taking public sign-ups needs terms, and the activation/reset emails are plain text
that inherit only the site name from config.
**Tasks**

-   [x] `/terms` page — plain-language terms covering accounts, fair play (collusion,
        multi-accounting, exploiting bugs), conduct, liability, IP and user content.
        Admin-editable through Site Settings > Site Content alongside About/Privacy, and
        linked from the sidebar.
-   [x] Registration states the terms at the point of sign-up rather than burying them.
-   [x] Branded HTML email template (`server/services/emailTemplate.js`) with a plain-text
        alternative; both activation and password reset now use it. No images, so nothing
        breaks under blocked remote content and no open-tracking signal leaks.
-   [x] Terms acceptance recorded against the account (`Users.TermsAcceptedAt`, migration 40),
        stamped server-side at account creation rather than trusting a client flag. Covers SSO
        sign-ups too, since both paths go through `addUser`. Nullable, because accounts that
        predate the terms have no acceptance and backfilling one would be a false claim.
-   [x] **Three transports, not one** (`EmailService`): Resend over its HTTP API, any SMTP
        provider, or AWS SES. `lobby.emailTransport` picks one, or `auto` resolves it from
        whichever credential is present — Resend first, because it is the one that can be
        working within minutes of a decision rather than after a domain review. The original
        SES-only design made the owner action harder than the problem.
-   [x] **A send budget that keeps the transport alive** (`MailBudget`, migration 60). Every
        provider's entry plan is a hard cap with a cliff — Resend's free plan is 100 a day and
        3,000 a month — and past it the provider stops accepting _all_ mail, so the first
        casualty is the activation link a new account cannot register without. Sends are
        counted per day and per month and low-priority categories are shed first, so a busy
        Saturday of pairing emails cannot take registration down with it.
-   [ ] **Owner action:** set one of `RESEND_API_KEY`, `SMTP_HOST` or the AWS SES variables,
        with a verified sender identity, before any of this mail can actually be delivered.
        `npm run check:email` reports which transport resolved and what is missing.

> **This owner action is a launch blocker, not a nicety.** Email verification is on by
> default (see _Known defects_), so registration depends on outbound mail: with no working
> sender, every sign-up is rolled back with "we could not send your confirmation email" and
> the site takes no new accounts at all. The server logs an error at boot when verification
> is on and `lobby.emailFromAddress` is unset. If no transport is ready, set
> `REQUIRE_ACTIVATION=false` deliberately rather than discovering it from a player —
> accepting that unverified addresses can play until it is turned back on.

**Depends on:** nothing. Blocks: I1's public announcement.
**Acceptance criteria**

-   `/terms` renders the built-in text and is overridable from the admin settings page.
-   Activation and reset emails render correctly in a major HTML client and degrade to
    readable plain text.

#### I7 — Off-host backups and a rehearsed restore _(code done; needs a bucket)_

**Why:** docs/DEPLOYMENT.md said it plainly and then did not do it — the backup section was
a cron one-liner writing a plain dump to `/var/backups`, on the same disk as the database,
followed by a note to copy it off-host by hand. A backup that depends on somebody
remembering is not a backup. With the soft launch live, ratings, tournament history,
replays and player uploads exist on exactly one disk.
**Tasks**

-   [x] `deploy/backup.sh`: one encrypted archive per run holding the database and the
        uploaded avatars and backgrounds, shipped to any S3-compatible store (the AWS CLI
        runs in a container, so the host installs nothing and `--endpoint-url` covers R2,
        B2, Wasabi and MinIO) or to a second host over rsync, with local and remote
        retention.
    -   The archive is **verified by decrypting it again** and comparing checksums before
        the run counts as a success. A truncated write is then found now rather than during
        the restore you are doing because the server is gone.
    -   The upload is **verified by asking the remote for the object's size**. An upload
        command that exited 0 is not evidence the bytes are there.
    -   A dump that does not contain `Users`, `Ratings` and `Games` is refused, because a
        dump of the wrong or a freshly-initialised database exits 0 and looks like a backup.
    -   `.env.production` is deliberately **not** in the archive: one compromised bucket
        would otherwise give up the data and the keys to read it. Redis is not either
        (nothing durable). Card art is opt-in — `npm run fetchdata` re-downloads it.
-   [x] `deploy/restore.sh` with three modes: `--verify-only` (safe against production,
        proves an archive is readable rather than merely present), `--database NAME` (rehearse
        into a scratch database), and a destructive restore that refuses without `--yes`.
        Every member is checked against the manifest before anything is written.
-   [x] Freshness in `deploy/healthcheck.sh`: FAIL when no passphrase is configured, when no
        backup has ever completed, when the newest is over 48h old, or when backups are
        landing only on the machine they are meant to survive. WARN at 26h — a nightly job
        that missed once. The record it reads is written only after the archive verified and
        the off-host copy was confirmed, so its timestamp means a usable backup exists rather
        than that the script ran.
-   [x] **The rehearsal runs in CI** (`test/deploy/backupRestore.spec.js`), against a real
        PostgreSQL 16 loaded with the whole of `server/db/schema`: back up a populated
        database, restore into a second one, compare row counts, values and table counts,
        and check the uploaded images come back byte for byte. It also proves the integrity
        check refuses a damaged archive and that the script will not restore over the live
        database without `--yes`. A restore procedure nobody executes is a guess, and one
        rehearsed by hand once stops being true at the next schema change.
-   [ ] **Owner:** create a bucket, set `BACKUP_PASSPHRASE` (**and put it in a password
        manager** — it lives on the machine the backup exists to survive), set
        `BACKUP_S3_BUCKET` and the credentials, run `bash deploy/backup.sh` once by hand,
        then add the nightly cron line. All four steps are in DEPLOYMENT.md §6.

**Depends on:** owner action for the bucket; nothing in the code.
**Acceptance criteria**

-   [x] A restore from an archive produces intact ratings, tournaments and decks, and the
        runbook records how long it took (~2s each way on a schema-only database; the fixed
        cost is two rounds of PBKDF2, and DEPLOYMENT.md says to re-measure against real
        history).
-   [x] A damaged archive is refused rather than half-restored.
-   [x] A deliberately stale backup triggers the freshness FAIL. Exercised against seven
        fixtures — nothing configured, configured but never run, fresh, 30h, 73h, fresh but
        local-only, and an unparseable timestamp — each landing on the intended
        OK/WARN/FAIL.

### Near-term — the retention loop

_Goal: reasons to come back tomorrow. Sequenced after players exist, because each of these is
tuned by what live usage shows._

#### N1 — Full replays, share links, and the Watch hub _(done)_

**Why:** replays captured the message log only, and `/watch` was a placeholder. Replays are
also the substrate for coaching, AI analysis, and streaming tools later.
**Tasks**

-   [x] Board-state snapshots captured alongside the message stream, keyed to the log
        position so the viewer can show the board at any point in the play-by-play. Recorded
        at the state-broadcast layer, never inside gameplay resolution, wrapped so a recording
        failure cannot interrupt a live game. Recording format versioned (`version: 2`).
-   [x] Snapshots are compact and **spectator-safe by construction**: rendered through the
        same `AnonymousSpectator` path that protects live spectators, so a replay can never
        reveal more than watching would have. Asserted by test — neither hand's contents
        appear anywhere in a board frame or the public card table. (Since v4, the misplay
        review (**F3**) records hands BESIDE the frames in a separable side channel; share
        links are stripped of it in `GameService`, and a player is only ever served their
        own — the board frames themselves stay spectator-safe, and the test now pins both
        halves.)
-   [x] Capture self-throttles to log advances (the state is broadcast far more often than
        anything visible changes) and stops at a hard cap, setting a `truncated` flag that
        the viewer surfaces rather than silently losing the tail.
-   [x] Replay viewer renders the board beside the log: turn, active player, both players'
        amber/keys/chains/houses, and every visible pile.
-   [x] **Watch hub** (`/watch`): live, spectatable, non-private games, as a filtered view
        over the same lobby state so spectating, passwords and permissions behave exactly as
        they do in the lobby.
-   [x] Retention budget and policy **(admin-config)**: Site Settings > Replays carries the
        recording switch, the size cap (the old 2 MB skip, now explicit and tunable), the
        retention window and the purge cadence. An hourly lobby sweep deletes past the window;
        deleting is idempotent, so an overlapping run on another lobby instance is harmless.
        Retention defaults to **0 days = keep forever** — a site that has not decided on a
        policy must never silently start destroying game history. `saveReplay` now reports
        _why_ it skipped, so "too large" and "never recorded" stop being indistinguishable.
-   [x] Share links (public, no auth): a share token is minted per replay on request and is
        the only way an anonymous caller can read one, so sharing stays an explicit act by a
        player **in the game** rather than a property of every recording. Idempotent, so
        re-sharing never invalidates a link already sent; revocable; and turning sharing off
        site-wide closes existing links, not just new ones. `/replay/shared/:token` renders
        through the same viewer as the authenticated route.
-   [x] Spectator counts on the Watch hub (already on every lobby game summary, never shown),
        an admin-pinned **featured match** (only rendered while that game is actually live, so
        a stale setting quietly does nothing), and an optional **broadcast delay**
        **(admin-config)**. The delay is enforced in the game node, on spectators only — the
        two players always see the live position. The delay path shares the diff base with the
        live path, so a delayed viewer is sent diffs against the position they have actually
        seen; anything still held is flushed when the game closes rather than dropped.
-   [x] Jump-to-key-forge and per-player perspective in the viewer. Forges are read off the
        recorded key counts rather than parsed out of the log — wording is localised and
        changes with the engine, key counts do not. Version 1 recordings have no snapshots, so
        they show no jump controls rather than wrong ones.
-   [x] Match history filters by deck, opponent, format and result, applied in SQL **before**
        the row limit — filtering the last 30 games client-side would answer "you never played
        that deck" for anyone with a longer history. The controls offer the decks, opponents
        and formats that actually appear in that player's history.
-   [x] **Replays are your own games only.** They were readable by any signed-in account that
        knew a game id, and every finished game's id is on both players' public profiles - so in
        practice every game on the site was readable by every member, which is not what a player
        agrees to by finishing a match. Participants and admins only now (an admin because a
        report about a game cannot be investigated without the game); share links are untouched,
        because those are an explicit act by a player about their own game.
-   [x] **A missing replay says which of the five things went wrong** - not yours, never
        recorded, recording switched off, no such game, or replay storage missing on the server -
        instead of one "No replay is available for this game" covering all of them. The last of
        those is an operator problem that makes every replay on the site missing at once, so
        `deploy/healthcheck.sh` now FAILs on a missing `GameReplays` table and on zero replays
        next to finished games.

**Depends on:** I2 (retention migration), I3 (profile links from replays).
**Acceptance criteria**

-   [x] A finished game can be replayed board-state-by-board-state by someone who did not play
        it — and now by someone who is not signed in at all, via a share link.
-   [x] A spectator (live or replay) can never see hidden information, asserted by a test. A
        share link inherits this for free: the snapshots are rendered through the same
        `AnonymousSpectator` path, so a link cannot reveal more than watching would have.
-   [x] Retention is enforced by a job and configurable without redeploy.
-   [ ] Caster mode (both hands visible) stays with **F4** — the delay is the half of it that
        the Watch hub needs, and the half that is safe without a separate privileged view.

#### N2 — Notifications _(done, less browser push)_

**Why:** tournaments and asynchronous community features are only useful if players are told
things happened. Round pairings in particular are unusable without a ping.
**Tasks**

-   [x] Typed event taxonomy (`server/services/notifications/taxonomy.js`): a small closed
        list, because every notification has to be something a player can find, understand and
        switch off, and an unnamed category is none of those. The key is both the event type
        and the opt-out unit, so "turn off pairing emails" is one row rather than a policy
        spread across the code that raises the events.
-   [x] In-app notification centre: bell with unread badge, dropdown list, read-on-open,
        mark-all-read. The badge polls a bare count and the list is only fetched when the
        dropdown opens — polling a page of rows every minute in every signed-in tab is the
        expensive way to render a number.
-   [x] Email for round pairings, tournament start and friend requests, through the branded
        template from **I6**. `email` defaults are set per category by whether the notification
        is useless if missed: a pairing you do not see costs you the match, so it mails; "your
        friend request was accepted" does not.
-   [x] Per-category opt-out in Profile > Notifications, honoured **server-side at the point of
        delivery** rather than at each call site, so a new trigger cannot forget to respect it.
-   [x] Triggers: round pairing and event start (over the existing `tournamentEvents` bridge,
        so the tournament service still knows nothing about notifications), friend request,
        friend request accepted, and someone joining a club you own.
-   [x] Idempotency: a `DedupeKey` partial unique index makes a repeated trigger a no-op —
        `emitRoundPaired` also fires when a best-of series spins up its next game, and a player
        should not be told twice that they are paired. A duplicate suppresses the email too.
-   [x] **Push to the phone** (`PushService`, migration 61). Email is the wrong channel for the
        things a tournament needs to say: "your match starts in fifteen minutes" is worth an
        interruption and worth nothing an hour later. Delivery goes through Expo's push service,
        which fans out to APNs and FCM — the app is built with EAS, so its tokens are Expo
        tokens and there are no Apple or Google credentials to hold. Same contract as the rest
        of the path: nothing throws, failures are logged and dropped, and a `DeviceNotRegistered`
        answer deletes that token on the spot rather than retrying it forever. Which categories
        are allowed to interrupt is part of the taxonomy, not a per-call decision.
-   [ ] Browser push once the PWA lands (**N6**). The transport above is native-app only.

**Depends on:** I6 (email template), I3 (linking to profiles). Blocks: F2 (Discord reuses the taxonomy).
**Acceptance criteria**

-   [x] Pairing a tournament round notifies every paired player in-app and by email. A bye is
        named as a bye rather than sent as a pairing with no opponent.
-   [x] Every category can be turned off per player, and opt-out is honoured (tested, including
        each channel independently).
-   [x] No notification path can block or slow a gameplay or tournament operation. `notify()`
        never throws and never rejects — a database or SES failure is logged and dropped — and
        every caller invokes it fire-and-forget. Asserted by tests that take the database and
        SES away underneath it. A missed notification is a small harm; a pairing that fails to
        commit because the mail server is down is a large one.
-   [x] Notification reads and writes are scoped to the calling account inside the service, so
        an id belonging to someone else is a no-op rather than a cross-account read.

#### N3 — Deck intelligence _(done, less the lobby-list exception)_

**Why:** SAS is the platform's differentiator against a generic ladder, and it was
under-displayed — the SAS the platform already stored appeared on one screen.
**Tasks**

-   [x] SAS column on the deck list, sortable. The data was already fetched and cached on
        that endpoint — it was simply never rendered, so the number players sort their
        collection by was missing from the collection view.
-   [x] AERC component breakdown on the deck view, from the DoK payload already stored in
        `DeckSas.RawData` and never read back until now. Components DoK did not supply are
        omitted rather than shown as zero, which would be a different claim.
-   [x] SAS on the pre-game screen, for both players. Deck _power_ is not deck contents — it
        is the number the rating engine already handicaps with — but it is suppressed for the
        opponent when the game hides decklists, so the existing privacy control still governs.
        Attached after the deck is selected and the state sent, so a slow DeckSas read can
        never delay someone picking a deck.
-   [x] Per-deck stats (Stats > Your Decks): W-L, win rate, and the delta against what decks
        of the same SAS band actually win site-wide — the column that says whether a deck
        wins _for you_ rather than on paper. Unrated decks report a null delta rather than an
        invented expectation.
-   [ ] Lobby game list: decks are not chosen for open games, so there is nothing to show
        there yet — deliberately skipped rather than rendering mostly-empty cells.
-   [x] Best/worst matchups (your record against each opposing house) and "your best deck".
        The callout is ranked by how far a deck beats what its SAS band predicts, **not** by
        raw win rate — a 45% win rate with a weak deck is a better piloting result than 55%
        with the strongest deck on the site, and raw win rate would call the second one your
        best deck. Decks under five games are ignored, and a lone deck is not reported as both
        the best and the worst.
-   [x] Periodic background SAS refresh sweep. Refresh used to be access-triggered only, so a
        deck nobody opened kept its first-ever score forever and the site's SAS drifted away
        from DoK as the model was revised. The sweep takes the stalest decks first and yields
        the moment the shared per-minute budget is gone, one request at a time, so a live
        import or a pre-game lookup is never queued behind it. Cadence and batch size are
        **admin-config**.
-   [x] Set win rates and a house-vs-house matchup matrix on the meta dashboard (**Phase 11**).
        A matchup cell under twenty games reports its game count but **no** win rate: 100% off
        two games reads as a finding and is noise.

**Depends on:** I2 (any stats migration).
**Acceptance criteria**

-   [x] A player can see, without leaving the deck page, how their deck performs relative to
        what its SAS predicts — and which houses they actually beat.
-   [x] Deck lists show SAS whenever it is cached, and degrade silently when not. Lobby games
        are the deliberate exception above.
-   [x] The refresh sweep respects the existing per-minute DoK budget and never starves live
        requests — asserted by a test that leaves it two slots and watches it stop at two.

#### N4 — Ladder maturity _(done)_

**Why:** seasons and decay exist in the engine but are invisible to players, and there is no
way to correct the ladder after tuning the Elo config.
**Tasks**

-   [x] Season archive (migration 43): `startNewSeason` now records every rating it is about
        to reset — final rating, games played, rank, and the rating the reset left behind —
        into `SeasonStandings`, and stamps `Seasons.EndedAt`. Archiving and resetting happen
        in one transaction: standings for a season nobody was reset out of, or a reset with no
        record of what came before, would each be worse than neither.
-   [x] Season display: the current season names the Ratings panel and the leaderboard header,
        Leaderboards gained a season picker that switches the board to final standings, and the
        end-of-season summary is that archive — final rank, Amber, and what the soft reset took.
-   [x] Season badges on profiles: medals for top-three finishes and a "Season finishes" panel
        on the public profile, from the same archive.
-   [x] Activity window on boards **(admin-config)**: `rating.leaderboardActivityDays`, off by
        default. Applied to the board, and to the rank and field size on a profile — if those
        disagreed a player would read "#3 of 40" beside a board listing a different 40.
-   [x] Rating recalculation tool: replays `RatingHistory` under a candidate Elo config,
        admin-triggered, dry-run first, seeded from the season archive.

**Depends on:** I3, I4.
**Acceptance criteria**

-   [x] A player can see which season they are in, where they finished in prior seasons, and
        what a soft reset did to their Amber. The reset delta is stored rather than inferred,
        because a soft reset writes no `RatingHistory` row and is otherwise unrecoverable.
-   [x] Recalculation produces a diff report before it commits, and is idempotent for an
        unchanged config. The Apply button does not exist until a preview has returned, and
        disappears again once committed. Verified against a real PostgreSQL: replaying an
        unchanged config moves nobody; a different K moves the winner further.
-   [x] Recalculation replays only the season in progress, seeded from the archived post-reset
        ratings. Replaying all history would silently undo every soft reset the ladder has ever
        had — resets mutate `Ratings` without leaving a history row to replay.

#### N5 — Moderation toolkit _(done)_

**Why:** the platform inherits a block list and ban list and has a `canModerateChat` role, but
no way to report anything or act proportionately. Community size makes this urgent, not optional.
**Tasks**

-   [x] **Reports** (migration 48): player, chat message, deck, club, store listing — and
        in-person game disputes. Each captures a **snapshot** of what was reported, not just a
        foreign key to it: deleting the evidence is the first thing a bad actor does, and a
        report that reads "message #4213" after the message is gone is not a report. A report
        about a deck is recorded as a report about its owner, so a moderator does not have to
        re-derive who to act on. Verified against a real database by deleting the reported
        message and confirming the report still reads.
-   [x] **Moderation queue** with claim / release / resolve. Claiming is conditional on the
        report still being open, so two moderators racing resolve to one winner rather than
        both believing they have it. Resolving requires written reasoning — a closed report
        with none is indistinguishable from one that was ignored. The queue shows how many
        **distinct** people have reported an account recently, because one complaint is a
        disagreement and five is a pattern, and the report alone does not say which.
-   [x] **Graduated actions**: note, warn, mute, timeout, ban. Each is an append-only row with
        a reason and an expiry, never a flag on the account — that is what lets a player be
        told why and until when, and what makes an action reversible without erasing that it
        happened. A timeout takes chat too, since being unable to play while still free to
        talk is not the sanction anyone picks. A ban also sets `Users.Disabled`, because the
        login path checks that and knows nothing about this table; revoking one puts it back.
        A moderator cannot sanction themselves or another moderator — only an admin can.
-   [x] **Full audit log** of every moderator action, **and** of settings changes, replacing
        the settings service's last-editor-only trail (`SiteSettings` recorded only the most
        recent editor, so "who turned rated play off in March" was unanswerable — the next
        edit overwrote the answer). Entries keep the moderator's name as text beside their id,
        so the trail survives the account being deleted; verified by deleting a moderator and
        confirming their entries still name them. Writing an entry never throws: a moderator
        who saw an error would reasonably repeat the action.
-   [x] **Policy thresholds (admin-config)**: minimum report length, default mute and timeout
        durations, and the repeat-report window and threshold.
-   [x] **A first line in front of the queue** (`server/services/moderation/contentFilter.js`).
        Everything above is after the fact: somebody has to see it, report it, and wait for a
        human, by which time the harm has landed. Every chat path applied exactly one
        transformation — a 512-character truncate — which is also the gap App Store Review
        Guideline 1.2 asks a UGC app to close. The filter masks a short list of slurs and severe
        profanity and is deliberately **not** a toxicity classifier: KeyForge card, house and
        deck names collide with innocent substrings, and a player who cannot type the name of
        the card in their hand concludes the site is broken. So matching is on whole words after
        normalisation (homoglyphs folded, repeated letters collapsed, separators dropped), and
        the message still sends with the term masked — dropping it silently teaches somebody to
        send it again, and refusing it turns the filter into a game to beat.
-   [x] **Reporting reachable where the abuse happens**, rather than only from a profile: the
        report control now sits on the surfaces the problem appears on, so nobody has to
        re-describe what they were already looking at.

**Depends on:** I3 (profiles are where reports start), N2 (notifying the reporter).
**Acceptance criteria**

-   [x] Any player can report from the surface where the problem appears, in two clicks —
        `ReportButton` is inline on the profile and club pages rather than a link to a form
        that would make someone re-describe what they were already looking at.
-   [x] Every moderator action is attributable, reversible, and visible in the audit log.
-   [x] A muted or timed-out player is blocked from the relevant surfaces and told why and for
        how long. Enforced on both chat paths (lobby and table), and the player is sent the
        reason and expiry rather than having the message silently vanish — a message that
        disappears without explanation reads as the site being broken, and they just say it
        again.

#### N6 — Design system, responsive, accessibility, PWA

**Why:** theme tokens and light/dark palettes exist, but there is no documented component
library, no responsive pass, and no accessibility work. Mobile web is the default first
experience for most new players.

**Sequence after N16.** This item systematizes a visual language into a component library; if
it runs first it will systematize the current look and then be rebuilt when the redesign lands.
The responsive and accessibility work is independent of how things look and could go either
way — but the component library specifically should wait.
**Tasks**

-   UI audit doc: component inventory, duplication, and the modernization order.
-   Document the token set and build the shared component library on top of it (on the
    direction chosen in **N16**).
-   Page-by-page responsive pass (decks → community → tournaments → profile → game UI last,
    since the board carries the most gameplay risk).
-   Accessibility: keyboard navigation, contrast, focus order, screen-reader landmarks.
-   PWA: installable, offline shell, push notifications (feeds N2).

**Depends on:** nothing hard; sequence after the play loop is proven.
**Acceptance criteria**

-   Every non-game page is usable at 375 px wide without horizontal scrolling.
-   Lobby, decks, tournaments, and profile are fully keyboard-navigable and pass a contrast audit.
-   The site is installable and receives a push notification on a phone.

#### N7 — Teams and club competition _(done)_

**Why:** clubs exist but are inert — the local-scene story the platform is aiming at needs
competition between groups, not just membership lists.
**Tasks**

-   [x] **Club leaderboards** — a club board ranks its members by Amber, reading the same
        RatingService the site board does so the two can never disagree about a rating.
        Deliberately not a filtered slice of the world board, though: the site board hides
        anyone under `leaderboardMinGames`, which applied to a twelve-person club can empty
        the page — exactly the small scenes the feature exists for. So every rated member is
        listed and the ones who also qualify site-wide are marked.
-   [x] **Approval-based joins** — `Clubs.JoinPolicy`; pending members are rows in
        `ClubMembers` with `Status = 'pending'`, visible only to the owner. A join _code_ does
        not bypass approval: codes get forwarded, and treating one as pre-approval would walk
        a leaked code straight past the vetting the owner asked for. Declining deletes the row
        rather than recording a rejection — a club is not a permanent record of who was turned
        away, and a kept row would quietly stop the person ever asking again.
-   [x] **Ownership transfer** — the club row and both membership rows move in one
        transaction, because a club with two owners or none is worse than a failed transfer.
        The old owner stays on as an ordinary member.
-   [x] **Teams** (migration 44) — rosters distinct from clubs, because a club is a place you
        belong to for years and a team is a roster assembled for a season, and the same player
        is usually in one of each. A team may optionally be fielded by a club, which is how a
        store enters several.
-   [x] **Team events** — `Tournaments.TeamEvent` / `TeamSize`; players register and play
        individually under the team they entered with, and their results roll up.
-   [x] **Team rating** — a separate ladder, seeded flat, moved only by team events. Not
        derived from members' Amber: averaging would let a roster inherit a rating it never
        earned as a unit. An event rates as a round robin on final standings, with the
        per-opponent deltas **averaged rather than summed** — summing would make a 32-team
        event move ratings roughly ten times as far as a 4-team one for the same performance,
        so the ladder would reward entering the biggest field rather than playing best.
-   [x] **Named invitations.** The join code answers "anyone who has this string"; it does
        not answer "I want Sam in my club", which is what an owner wants most of the time. An
        owner can now invite a player by name - from their friends list, or by typing one -
        and the invitee gets a notification, an Accept/Decline on the club page, and a list of
        outstanding invitations on the Clubs page. Invitations are `ClubMembers` rows with
        `Status = 'invited'`, so no migration; the membership test became an allowlist in the
        same change, because "not pending" had counted an invitation as a membership the
        moment invitations existed.

**Depends on:** I3, existing tournament engine.
**Acceptance criteria**

-   [x] A club page ranks its members and can run a club-only event.
-   [x] A team can register as a unit for a team event and carries a team rating that updates
        from results. Rating an event twice is a no-op (unique `(TournamentId, TeamId)`), so
        finishing an event twice cannot rate it twice.

#### N8 — Admin analytics and operations dashboard _(done)_

**Why:** after launch, decisions need numbers: is the funnel working, is the queue healthy,
are tournaments completing.
**Tasks**

-   [x] **DAU/MAU, games/day, tournament completion rates** at `/admin/analytics`. Every
        figure is _derived_ from tables the platform already writes rather than kept in
        counters — derived numbers can be recomputed and audited, counters silently drift and
        then quietly lie. Cached five minutes: these queries scan the games table, and nobody
        makes a different decision because a number is five minutes stale.
-   [x] **Matchmaking queue depth and wait times** (migration 45). The one thing that _had_ to
        be written down: the queue lives entirely in memory, so a queue that was ten deep at
        8pm leaves no trace by 9pm. Recorded fire-and-forget from the lobby, and sampled
        _before_ pairing, since after the sweep the matched players are gone and the queue
        would always look empty. The dashboard leads with the 90th-percentile wait, not the
        average — the average hides the people who gave up.
-   [x] **Funnel**: register → onboard → first deck → first game → second game, scoped to
        accounts registered in the window so it measures now rather than being permanently
        flattered by history. The second game is the step that matters: one game is curiosity,
        two is a returning player.
-   [x] **Feature-flag section** in the settings registry. Every flag defaults to the
        behaviour the site already has, so an unset flag is never a behaviour change.
-   [x] **Redis pub/sub settings invalidation.** The interval refresh already converged
        eventually — fine for a rating tweak, wrong for a flag, since the point of a flag is
        to turn something off _now_ and a thirty-second window where half the lobbies still
        serve the broken feature is the window that matters. Pub/sub is an accelerator, never
        a dependency: the interval keeps running underneath, so losing Redis costs propagation
        latency instead of freezing settings site-wide. The message carries no payload on
        purpose — a pushed snapshot could arrive out of order and overwrite newer state.
-   [x] **Moderation surfaces on the dashboard** (N5): open reports, how many are being
        handled, average time to resolve, and the age of the oldest open report — an unread
        queue is an outage nobody gets paged for. Tournaments remain reachable from the event
        list rather than duplicated into the admin panel.

**Depends on:** I1 (needs traffic), N5 (moderation surfaces).
**Acceptance criteria**

-   [x] An admin can answer "how many people played yesterday and how many came back" without
        SQL. Where a figure has no meaningful value — stickiness with no monthly activity, a
        completion rate with no settled events — it renders as a dash rather than a zero,
        because "0%" is a claim and "no data" is not.
-   [x] A feature flag can be flipped at runtime and takes effect on every lobby process.

#### N9 — Tournament engine follow-ons _(done)_

**Why:** the engine is the most complete system on the platform; these are the remaining gaps
organizers will hit in practice.
**Tasks**

-   [x] **Hybrid events** (migration 46) — a new `hybrid` mode, plus `AllowPaperResults` and
        `TournamentMatches.ResultSource`. The mode shipped half-built and was finished later:
        every path that opens a lobby table tested for `Mode === 'online'` exactly, so a hybrid
        event could not open a single one — the half of it meant to be played on the platform
        had nowhere to play — and the create form never offered the mode at all. Tables now
        open for `online` and `hybrid` alike, but a hybrid event opens them **on demand** rather
        than at pairing: nobody can tell from the server which of its matches are being played
        across a table with cards, so auto-opening every one would park a lobby game for each
        paper match that nobody will ever sit at. An IRL or hybrid event takes paper results by
        definition; a purely online event has to opt in, because there a typed result is a
        claim about a game the platform could have witnessed and did not. Paper results feed
        the **standing only, never Amber** — the Elo engine needs the key differential and
        both decks' SAS, and a result typed in at a table has neither in a form anyone
        verified. Rating paper play is N13's job, where both players report independently.
-   [x] **QR check-in kiosk** — `CheckInCode` is minted when check-in opens, and the QR is
        rendered locally to a data URI (never through a QR web service, which would hand a
        third party the code). Deliberately **not** the join code: that one grants entry to a
        private event and must never end up on a poster. The code identifies the _event_, so
        scanning it marks whoever is signed in as present and a photographed code cannot check
        anyone else in. `CheckedInVia` distinguishes a kiosk scan from a staff override.
-   [x] **Alliance pod legality per event** — `requirePodProvenance`, `maxPodsPerSourceDeck`,
        `allowedPodSets`, `bannedPodHouses`, `exclusiveSourceDecks`. This needed new data
        first: `DeckService.createAlliance` consumed the three source pods and threw the
        provenance away, so the finished deck recorded its cards but nothing about which
        physical decks they came from — and every real Alliance rule is about provenance, so
        none of them could be checked at all. `Decks.AlliancePods` now records it. Decks built
        before that have no pod record and cannot be backfilled, which is exactly why
        `requirePodProvenance` is a policy an event opts into rather than an assumption: it
        turns those decks away by name instead of waving through a deck it cannot check.
-   [x] **Archon Adaptive Bo3** — game 1 own decks, game 2 swapped, and at 1-1 a chain bid for
        the right to pilot the nominated deck. The bid is a handicap, so bids only ever go up;
        passing hands the deck to the standing high bidder at their own bid, and passing when
        nobody has bid concedes it at zero rather than deadlocking two players who both refuse
        to open. The negotiation lives on the match row (`AdaptiveState`) because it happens
        between games and has to survive a reconnect and an organizer looking at the table.

**Depends on:** existing tournament engine.
**Acceptance criteria**

-   [x] A store can run a paper event on the platform with QR check-in and no laptop per table.
-   [x] An Alliance event rejects an illegal pod at registration with a clear reason.

#### N10 — Staging, zero-downtime deploys, upstream sync _(deploy script done; drain reverted)_

**Why:** with players on the site, "restart and hope" stops being acceptable, and upstream
keyteki card fixes need a routine path in.
**Tasks**

-   [x] **A deploy script that cannot half-run** (`deploy/update.sh`): refuses a dirty tree or
        the wrong branch, `git pull --ff-only`, rebuild, migrate, health-check, and report any
        finished games left unrated. Every one of those was a step somebody could skip by hand,
        and skipping them failed quietly rather than loudly — `git fetch` instead of `git pull`
        once kept production 31 commits behind for a month.
-   [x] Scheduled upstream keyteki merge process (docs/UPSTREAM.md): `npm run sync:upstream`
        plus a weekly workflow that runs the full gate and opens a PR only when it is green, an
        issue when it is not. Never auto-merges.
-   [~] **Draining the game node: built, then reverted.** A game lives entirely in one game node
    process's memory and cannot be moved, so "zero downtime" has to mean never restarting a node
    that still has games on it. That was built — a quiesce control on the node's health port,
    `stop_grace_period` matched to the 90-minute drain, a second node to roll onto, and a
    rolling deploy the update script delegated to — and then **reverted in full** (895b773),
    because games could not be started on the deployed stack and that is worse than the problem
    it solved. The cause was never found. What the revert put back:
    -   `deploy/update.sh` runs `up -d --build` directly, so a deploy replaces every container
        at once and ends every game in progress.
    -   The node's health port is three read-only routes again; a node cannot be stood down.
    -   The admin Restart button shells out to `pm2 restart`, and pm2 is not installed anywhere
        in this stack — the one control an operator reaches for during an incident is inert.
    -   The per-node game cap is read from a key the config file does not document, so it is
        never enforced.
    -   A game result published while the lobby is restarting is dropped with no retry, so a
        game that finishes in that window is never recorded, rated or replayed. That bug
        predates the reverted branch and is back.
-   `staging.archonarena.com` deploying from main. **Do this before re-attempting the drain** —
    the reverted attempt failed on the deployed stack in a way no local run reproduced, which is
    exactly the class of failure a staging environment exists to catch.
-   Load-test game nodes and matchmaking to find the per-node ceiling.

**Depends on:** I1, I2.
**Acceptance criteria**

-   A deploy during active play does not end anyone's game — **and a game can still be started
    on the deployed stack afterwards**, which is the check the first attempt did not have.
-   [x] An upstream merge lands with the full card suite green and a recorded diff of gameplay
        changes.
-   The documented per-node concurrent-game ceiling is backed by a load test.

#### N11 — Guided tutorial and experience-based onboarding _(walkthrough done; branching open)_

**Why:** KeyForge is a complex game and Archon Arena is a complex platform. When this was
written a brand-new player landed in a lobby with no idea what to do and `/learn` was a
placeholder; the walkthrough below has since filled that in. What is still missing is the
branching — the platform teaches every new player the same 93 steps, including the ones who
have played KeyForge for years and only need to know where the deck importer is. Asking one
question at sign-up is what lets it teach each player what they are actually missing.
**Tasks**

-   Onboarding step: "How well do you know KeyForge?" (new to it / played before). Players who
    know the game get a follow-up: "How well do you know Archon Arena?"
-   **New to the game** → walk the rules inside a real game on the platform: houses, æmber,
    forging, reap/fight/use/action, keys and the end condition — then the platform basics.
-   **Knows the game, new to the platform** → skip the rules entirely; show importing decks,
    starting a game, Quick Match, what Amber is, and where tournaments live.
-   **Knows both** → straight through the existing wizard to a first game.
-   [x] **The Learn-to-Play walkthrough itself** (`/learn`). Ghost Galaxy's two-player starter
        set demo game, **played** rather than read: 93 steps across all 13 turns with the Radiant
        and Onyx learning decks, on a board styled like the real one. The reader is the Radiant
        player — each of their turns asks for a move ("Play Incubation Chamber from your hand",
        "Reap with Sergeant Zakiel", "Choose house Mars") and they make it by clicking the card,
        house or counter the prompt names; Onyx's turns are watched. Every rule the official
        booklet teaches is taught at the moment it first matters, the spotlit cards' full text is
        pulled in beside the prose, and a closing chapter covers the platform (importing decks,
        Quick Match, manual mode, the game log). Runs client-side with no account, resumes from
        where the reader stopped, and steps backwards.
        `test/client/learnTutorial.spec.js` pins it to the walkthrough's own checkpoints — hand
        sizes, Æmber totals, key costs, which card is drawn when — to the invariant that no step
        invents a card, and to the one that makes the play-through work: every card a step asks
        you to click is on the board at the moment it asks.
-   Build the rest of the Learn hub on the same tutorial engine so any lesson can be replayed
    later, not only at sign-up.
-   Store the answers on the account so the tutorial can be resumed and re-offered.

**Depends on:** the existing onboarding wizard (`/welcome`) and the game engine. Feeds **F6**;
pairs well with **F9** (a bot as the tutorial's sparring partner).
**Acceptance criteria**

-   A player who has never played KeyForge finishes the tutorial and their first real game in one
    sitting, without leaving the site to look up rules.
-   A player who knows the game but not the platform is never shown rules content.
-   Every step is skippable, and the whole tutorial is replayable from `/learn`.
-   The tutorial runs on the real engine — no second rules implementation that can drift from it.
    **Deviation, deliberate:** the Learn-to-Play walkthrough above does _not_ run on the game
    engine. It has to work for a signed-out visitor with no deck, no game node and no socket, and
    it has to step backwards, none of which the engine can do. What it uses instead is a scripted
    board (`client/Components/Learn/tutorialEngine.js`) that only moves state through helpers —
    it cannot assign a hand or an Æmber total, so a drifting step fails its spec rather than
    quietly teaching the wrong thing. The in-game tutorial for a player's _first real game_
    (the "new to the game" task above) should still run on the engine.

#### N12 — Archon+ membership _(built end to end; needs a live campaign)_

**Why:** hosting, the DoK API tier, and the domain cost money, and the platform had no funding
path. TCO's Patreon integration is inherited but was dormant (`PatreonService`, the `/patreon`
page, `/api/account/linkPatreon`, the `keepsSupporterWithNoPatreon` permission) — it needed
credentials, tiers, and perks that cannot touch competitive fairness.

**What this grew into.** It started as "wire up Patreon" and became the platform's second-largest
system after tournaments: four tiers, twenty-six capabilities, and a set of analytics products
behind them. That is recorded here rather than split out, because the thing that keeps it honest
is one document holding both the promise and what backs it.
**Tasks**

-   [x] **The link flow itself.** Credentials moved out of the browser bundle into config
        (`patreon.*` / `PATREON_*`); the `identity.memberships` scope requested, without which
        Patreon returns no membership records and no account could ever have reached `pledged`;
        memberships scoped to our campaign, so backing an unrelated creator no longer grants the
        supporter role here; OAuth `state` bound to a signed cookie and the requesting user id;
        the Integrations tab (previously behind a hardcoded `false`) shown when there is
        something to integrate. Setup walkthrough:
        [docs/design/patreon.md](docs/design/patreon.md), plus `deploy/patreon-setup.sh` and a
        diagnostics endpoint that says which link in the chain is missing.
-   [x] **Tiers, capabilities and entitlements** (migration 62 — a table, not a role, because a
        role has no tier, no expiry, no provider and no record of where it came from). Free /
        Supporter $5 / Archon $10 / Vault Master $20, cumulative by rank so a capability cannot
        be granted to Archon and forgotten for Vault Master. Features check a **capability**, never
        a tier name (`requireCapability` server-side, `PremiumLock` client-side, mirrored in the
        Expo app), so moving a perk between tiers is an edit to `tiers.js` and nothing else.
        Patreon tier titles map onto ours by name with pledge size as the fallback; admins resolve
        to the highest tier. Reconciled on every auth refresh, so a lapse takes effect the same day.
-   [x] **Every tier promise is enforced, or marked as planned.** An audit of the pricing page
        against the code found thirteen capabilities being sold that nothing implemented —
        including all five of Vault Master's, so $20 bought nothing over Archon's $10. Rather than
        delete the roadmap, each carries a `planned` flag and the UI renders it as planned rather
        than included; `isTierPurchasable` **derives** whether a tier may be sold at all from
        whether it delivers something today that the tier below does not, so a tier cannot be left
        on sale by accident and becomes purchasable the day its first feature ships. Five
        capabilities are still flagged: expanded match history, historical stats, private leagues,
        extended tournament options, and the advanced (time-series) performance dashboard.
-   [x] **Archon Intelligence** (`/intelligence`) — Deck, Player and Meta Intelligence, answering
        "is this a good deck", "am I good with it", and "how does it fare against the field".
        Every number comes from a real column; where the data does not exist the metric returns
        `{available: false, reason}` and renders as "not recorded yet" rather than as a zero,
        because a fabricated zero is worse than an absent number — a player will act on it.
        Set-aware, since a result from a rotated-out set answers a different question.
-   [x] **The Tournament Lab, sold as Deep Probe** (`/deep-probe`; the capability id and API
        paths keep the working name, because released phone builds gate on them) — "which of my
        decks should I bring to this event", assembled only from the player's own recorded
        results, with a `confidence` marker about sample size so a 3-game 100% cannot sit
        unlabelled beside a 40-game 58%. Deck comparison sits alongside it.
-   [x] **AERC analysis** — the same record read in AERC terms rather than SAS. "My win rate drops
        against decks with amber control above 8" is actionable; "I lose to decks with 5 more SAS"
        is not. Built from the AERC breakdown DoK already returns and the platform already stores.
-   [x] **Replay analysis and the misplay review** (`advanced_replays`) — see **F3** and Phase 10.
        Watching replays stays free for everyone; what membership buys is the reading of a game
        rather than the watching of it.
-   [x] **Badges beside names, everywhere.** One lookup keyed by username rather than a badge
        threaded through fifteen unrelated services and their SQL — a page gets badges by
        rendering `<PlayerName>` and does not have to know the system exists. Only non-default
        badges are sent.
-   [x] **Profile customisation** — the first cosmetic perks to actually exist, and what
        `profile_cosmetics` (Supporter) and `enhanced_cosmetics` (Vault Master) were already being
        sold as. Five slots: accent colour, profile banner, avatar frame, title and name effect,
        plus a longer bio (migration 68). The catalogue and its per-option tier gating live in one
        file (`server/services/membership/cosmetics.js`); the client maps ids to pixels and never
        decides who may use what. A lapsed pledge stops rendering the same day the badge does,
        without deleting the selection — resubscribing restores it. See
        [docs/design/profile-cosmetics.md](docs/design/profile-cosmetics.md).
-   [x] **The preview programme** (`previews.js`, migration 67) — the mechanism behind
        experimental / beta / early access / priority access, which are not features but positions
        in a queue, and a queue needs a mechanism or the tier is selling a feeling. A preview is
        registered with a stage, the stage decides which capability admits an account, and
        priority access is a head start measured in days from the date the preview opened. Every
        preview is an opt-in switch, and `previewCapabilitiesWithContent()` derives whether those
        capabilities may be advertised at all, so a tier can never sell an empty queue.
-   [x] **Organizer exports** (`organizerExport.js`) — standings, pairings and the entry list of
        any event you run, as CSV, built from the payload the tournament page already renders so
        an export cannot disagree with the screen the organizer is looking at.
-   [x] **The Champion’s Challenge** — Vault Master's first genuinely new capability, and the
        one that took the tier off the shelf. See **N18**.
-   [x] **Per-tier checkout links.** Patreon takes a `?rid=` per tier; without it every button on
        the pricing page lands on the campaign homepage and the player who just chose Archon has
        to go and find Archon again. Reward ids live in config, so a tier recreated on Patreon is
        a settings change rather than a redeploy, and a missing campaign renders "coming soon"
        instead of a dead button.
-   [ ] **Owner:** create the Patreon campaign and tiers; set `PATREON_CLIENT_ID`,
        `PATREON_CLIENT_SECRET` and `PATREON_CAMPAIGN_ID` (and the per-tier reward ids), then link
        your own account to verify the round trip against the live campaign. Nothing below the
        link flow has ever run against a real pledge.
-   [ ] The five `planned` capabilities above, each of which un-flags itself only when something
        actually gates on it.
-   [ ] **(admin-config)** which tier unlocks which perk. Today that mapping is `tiers.js`, which
        is one honest place but still a redeploy.
-   [ ] A "Support Archon Arena" page saying plainly where the money goes, with an opt-in supporter
        list. The `/membership` page is a price list, not an accounting of costs.

**Depends on:** I1 (live site) and owner Patreon setup.
**Acceptance criteria**

-   Linking a Patreon account grants the tier within one refresh cycle; unlinking or a
    lapsed pledge removes it. _(Built and unit-tested against recorded Patreon payloads; never
    run against a live campaign.)_
-   [x] No perk affects Amber, matchmaking, tournament eligibility, or any other competitive
        outcome — asserted by the persona specs, which walk every capability for every tier.
-   [x] A tier that delivers nothing over the tier below it cannot be sold, and this is derived
        rather than maintained by hand.
-   Perks are editable from admin settings without a redeploy.

#### N13 — In-person game tracking _(done)_

**Why:** most KeyForge is still played across a table. The platform already knows decks, Amber
and clubs; letting two players record a paper game keeps local scenes on the same ladder and
gives the Play IRL hub something to do between tournaments.
**Tasks**

-   [x] **Start an in-person game** (migration 47): one player opens it and names the
        opponent, who is notified. Opening a game asserts only that one happened — the result
        comes from both of them separately.
-   [x] **Both players report independently.** Deliberately not "confirm": neither player is
        ever shown the other's answer to agree with, because a pre-filled result is a result
        one person chose. Agreeing reports commit; anything else marks the game disputed and
        tells both players. A mismatch on the _keys_ disputes too, even when both name the
        same winner — keys are a direct Elo input, so agreeing on the winner is not agreeing
        on the result. One report per player is enforced by a unique index rather than by the
        service remembering to check. A disputed game can be withdrawn and re-reported.
-   [x] **Optional deck attachment**, validated against ownership: a deck can only be attached
        to the player who owns it, or a report could credit someone else's deck with a win and
        corrupt deck records and SAS stats.
-   [x] **Rated or not is admin-config** (`inPersonGames.rated`). It shipped **off** — turning it
        on read as a real decision about a ladder the platform did not witness — and the default
        was later flipped **on** (migration 66) on the argument that the safeguards are the
        reason it can be on rather than the reason it should be off: a committed paper game
        already needs two independent reports that agree, inside the window, with both decks
        attached, which is the same evidence an online game produces. Most KeyForge is played on
        paper, so the old default meant the ladder measured only the part of the community that
        plays online. Even with it on, a game with no decks attached is recorded **unrated**,
        because the Elo engine needs both decks' SAS and the alternative is inventing an input.
        The row records _why_ it was unrated, so a player who reported a game and saw no rating
        change gets an answer.
-   [x] **Surfaced everywhere games already are.** A confirmed game materializes a real
        `Games` row (`Source = 'irl'`) plus `GamePlayers`, then goes through the ordinary
        rating path — so match history, deck records, house statistics and Elo all pick it up
        with no changes. A parallel table would have meant teaching each of them about a
        second kind of game: four places to forget. The club page shows its recent paper games.

**Depends on:** I3 (profiles), N5 (disputes reuse the moderation queue). Related: **N9** hybrid
events, which feed one tournament standing rather than the open ladder.
**Acceptance criteria**

-   [x] A paper game confirmed by both players appears in both histories with the right result,
        and in deck/house stats when decks were attached.
-   [x] A one-sided or contradictory report never silently moves anyone's Amber — verified
        against a real PostgreSQL: after a disagreement no `Games` row exists at all.
-   [x] Whether IRL games count toward Amber is an admin setting, and players can see the
        answer before they report (the list endpoint returns it alongside the games).
-   [x] **Escalating a dispute** into the moderation queue (N5). Player-initiated rather than
        automatic: most disagreements are a mistyped key count and get sorted out by
        re-reporting, and routing every one into the queue would bury the reports that are
        about someone behaving badly. The report carries both accounts of the game side by
        side and accuses neither player.

#### N14 — App distribution: Android beta and iOS TestFlight requests

**Why:** builds are already in testers' hands — the owner has had friends running the app on both
iOS and Android for a while, invited by hand. So the app is not the gap; **self-serve** is.
`/mobile/ios` and `/mobile/android` are still `Placeholder` pages, which means the only way into
the beta is knowing the owner personally. That does not scale past the current circle, and it is
the whole of what is left here.
**Tasks**

-   `/mobile/android`: link straight to the Google Play beta track (or a signed APK) with install
    instructions.
-   `/mobile/ios`: a form that requests a TestFlight invite — the requester's account and the
    Apple ID email — plus an admin view of pending requests to work through. Apple caps external
    TestFlight testers, so the queue is the point: it lets the owner work through requests in
    order rather than field them over chat.
-   Show the current beta build number and what changed in it, so a tester knows if they are behind.

**Depends on:** I6 (email template) for the invite request; folds into N2 once notifications exist.
**Acceptance criteria**

-   A signed-in player can request an iOS beta invite in one action and gets a confirmation.
-   An admin can see and clear pending invite requests.
-   The Android page links to an install that works on a clean device.

#### N15 — Move-by-move clarity in the apps _(done)_

**Why:** the Expo app keeps the play-by-play behind a slide-up sheet (`LogSheet`), so on a phone
it is easy to miss what the opponent just did. And on both clients a prompt often asks for a
choice without saying which card is asking — the engine knows the source card, the UI does not
show it.
**Tasks**

-   [x] **Expo app: moves surface as they happen.** While it is the opponent's turn, `PromptPanel`
        shows the latest log lines inline (`WAITING_FEED_LINES`) with a tap-through to the full
        sheet, so following a turn no longer means opening the log (5a62a13).
-   [x] **Expo app: prompts name their card.** `promptText.ts` interpolates `{{card}}` in titles
        and buttons from `values` or the serialized card, and a "because of _<card>_" context row
        renders `controls[].source` above the prompt with a thumbnail. This also fixed a literal
        `{{card}}` rendering as button text when playing from archives.
-   [x] **Web client: prompts name their card.** Two gaps, both closed. `AbilityTargeting`
        showed the source as an unlabelled image with an arrow — readable on a turn with one
        trigger, meaningless on a turn where three resolve in sequence — and now captions it
        "because of _<card>_" like the Expo app. And where no `targeting` control exists at all
        (a card-name or trait-name lookup replaces it), `ActivePlayerPrompt` renders the caption
        on its own, which is the case the item was written for: "choose a creature" with nothing
        saying whether it is Gateway to Dis asking or something played three plays ago.
-   [x] **Passive effects say who is doing it, on web.** A persistent effect prompts nobody, and
        only ~385 of the 2,600 card scripts define a log message, so a creature printed at 8
        sitting at 9 was a number with no explanation anywhere. The engine has always known —
        every effect carries the context of the card that applied it — and `getSummary` now
        sends `effectSources`, which the card zoom lists as "Affected by ...". Self is excluded,
        because a card naming itself would be on nearly every creature and says nothing.
-   [x] **Same for the Expo app.** It already got `effectSources` in the card summary for free;
        `CardZoomOverlay` now renders it as a caption band across the bottom of the zoomed card,
        matching the web card zoom's "Affected by ..." treatment. Attribution stays with the
        card/token being zoomed even while its "show card underneath" toggle is flipped, since an
        effect on a token creature is not acting on the card art shown underneath it.

**Depends on:** nothing hard — the engine already tracks each ability's source card.
**Acceptance criteria**

-   [x] On a phone, a player can follow the opponent's whole turn without opening the log sheet.
-   [x] Every prompt that originates from a card names that card, on both clients — no longer
        only when the prompt text happens to carry a `{{card}}` placeholder.
-   [x] Nothing about what the engine resolves changes — this is presentation only. The mobile work
        is client-side interpolation and display over data the server already sent.

#### N17 — Tournaments end to end _(done)_

**Why:** the tournament engine was the most complete system on the platform and the least
finished product. Everything an organizer could set had a column, a validator and a test; several
things they could set did nothing when the event ran, and the biggest of them was the one players
would notice first.

**Tasks**

-   [x] **The deck lock is enforced.** `DeckSwapPolicy` decided whether decks were frozen for the
        event or swappable between rounds, and nothing anywhere enforced either. A tournament
        table shows the ordinary pre-game deck picker listing the player's whole collection, so
        registering a deck only pre-_selected_ it: a player could register the deck the organizer
        sees in the standings and pilot a different one, in a locked event, with nothing recorded.
        The lobby now pins each seat to the deck the event recorded for that pairing —
        `onSelectDeck` refuses anything else and says which policy is refusing it, and
        `startTournamentGameIfReady` re-checks before starting, because it is the only place a
        tournament game begins.
-   [x] **"Between rounds" means something.** Without a defined window it meant "any time the
        event is active", which includes between game two and game three of a best-of-three. The
        window closes when the first game of a pairing hits the table and reopens when the match
        is decided. It closes at the first game rather than at the pairing because an asynchronous
        pairing goes up days before anyone sits down, and closing it there would leave the policy
        almost no window at all.
-   [x] **The swap is actually offerable.** Once an event started, the only control a registered
        player had was Drop — so a swaps-allowed event and a locked one were identical to the
        people in them. The event page offers the swap when the window is open, names the deck
        they are on when it is not, and asks the server which of the two it is (`canSwapDeck`)
        rather than guessing and offering a click that gets refused.
-   [x] **Hybrid events open tables.** See N9 — the mode was accepted, had its own migration and
        its own feature flag, and could not open a single online table.
-   [x] **The create form says what it is about to build.** Twenty controls decide how an event
        runs and most only matter for some of the others; a top cut on a single-elimination
        bracket, a minutes clock on a league paced in days and a SAS band on a sealed event are
        all accepted and all ignored. The form now describes the event in plain English before the
        organizer commits, and lists the settings that will not do anything. The deck rule moved
        out of the advanced panel to sit with format and pacing: it is enforced at the table now,
        so it is one of the few settings every player in the event feels directly.
-   [x] **Defects found by audit and fixed.** An adversarial audit of the whole platform, re-verified
        finding by finding against the tree (five of twenty claims were refuted on inspection — the
        Start dialog's Cancel does pick the non-destructive branch, and non-bracket ranking is
        documented intent). What survived and is now fixed:
    -   **Accepting an async match time was permanently broken off UTC.** `acceptMatchTime` bound the
        proposal it had just read as a JS `Date`; node-postgres serialises a Date parameter with the
        host's offset and Postgres drops that offset when casting to an unzoned column, so the
        compare-and-swap hunted a time hours from the stored one and told both players "the proposal
        changed while you were looking" — forever. Reproduced against real PostgreSQL under two
        timezones before touching it. The regression test runs in a child process with `TZ` set at
        spawn, because vitest's `pool: 'threads'` means an in-process `process.env.TZ` assignment
        does not move V8's timezone — the obvious version of the test passed against the bug.
    -   **The check-in kiosk QR pointed at a route that did not exist**, so every player scanning the
        printed poster at a live event got the 404 page. Server, service, tests and even the RTK
        mutation were all built; the mutation was exported with zero consumers.
    -   **Two more holes in the deck lock.** `startTournamentGameIfReady` was not "the only place a
        tournament game starts": player one of a pairing owns the table, so the ordinary Start button
        reaches `launchGame`, which had no pin check. And a rematch rebuilt the pending game from a
        field list that never carried the tournament block — no match id (result unreportable) and no
        pin (free deck choice in a locked event). Deleting a registered deck was a third: the foreign
        key is `ON DELETE SET NULL`, and a null pin reads as _unpinned_, not as "locked, deck
        missing".
    -   **"Time in the round" recorded a double loss for every unreported match at a paper event.**
        Per-game scores are only ever written for tables the platform itself ran, so at an in-person
        or hybrid event every table that has not reached the desk is 0-0 — which the level branch
        read as a tie and both players took a loss for. Neither could undo it: the match was then
        decided and written as confirmed. Silence is no longer a score, and the organiser is told
        what was left for them instead of a flat success toast.
    -   **Online sealed events could never start.** The table was built with no set list, and
        `getSealedDeck` threw on `expansions.aoa` — an absent list now means the whole pool, and the
        event's legal sets are passed through.
    -   **An organiser can check a player in.** `checkIn` only ever wrote `actor.id`, so the desk at
        an in-person event had no way to mark anyone present — the player needed a phone, an account
        they were signed into and the event page, and anyone who could not manage that was dropped as
        a no-show at start. The roster showed the status and offered no way to change it.
        `CheckedInVia` records `staff` so the audit trail still says who did it.
    -   **Finishing an event asks first when rounds remain.** It stamps final placings, publishes
        them to profiles and rates the ladder, nothing reopens a complete event, and the button sits
        beside the one pressed at the end of every round.
-   [x] **The rest of the audit's findings.** Judge tools (forfeit / no-show / double loss) refused a
        decided match, and a disputed match is decided by definition — so a dispute that resolved to
        "he never showed up" was unrecordable, and the only lever left filed a false result type.
        Swiss repeat pairings were computed and discarded. The organiser could not change a deck,
        which is what a locked event's own refusal tells players to ask for — that needed a column,
        because "released by a judge" and "never registered" both look like a null `DeckId`, and
        treating them alike would let a player withhold their deck, read the pairings, and only then
        choose. The deck picker listed the whole collection with none of the event's rules applied.
        A misconfigured event could never be corrected (the create form is now shared with an edit
        panel, rather than a second form that would drift). A latecomer could not be admitted at all.
        Asynchronous events reminded nobody of anything before it happened, and two players could
        agree a time after their round had ended. And **Adaptive Bo3 never swapped a deck**: the
        bidding worked, the resolved bid was written to the match row, and nothing downstream read
        it — worse once the deck lock shipped, because the table then held both players to the wrong
        decks. Note one new stall mode: game three now waits for the bid, so a pair who neither bid
        nor pass leave the round waiting on them. That is the right trade against dealing decks the
        bid is about to contradict, and the organiser can still award or take a paper result, but
        `adaptiveBid`/`adaptivePass` have no timeout or force-resolve and should get one.
-   [x] **The participant-callable endpoints are bounded.** Creating an event was the only
        tournament route with a ceiling. The rest are mostly organizer tools behind an
        authorization check, which is a fair reason to leave them — but opening a table builds a
        lobby game and broadcasts it to everyone in the lobby, and reporting, confirming, disputing
        or proposing a time all notify the other player in-app and by email. Those five now have
        ceilings no real player will meet.
-   [x] **A whole event runs against real PostgreSQL.** Every other tournament test used an
        in-memory fake that routes on SQL fragments — good enough for lifecycle logic, but it
        agrees with itself by construction and cannot fail on a column the schema does not have or
        a constraint the code violates. `tournamentEndToEnd.spec.js` runs creation, registration,
        check-in, two Swiss rounds through recorded game results, a top-4 cut, the playoff and the
        finish on the real schema, then single elimination, double elimination and round robin each
        run to a champion, the deck lock, and the asynchronous round clock. The bracket cases are
        the point of the exercise: `propagateBracket` walks winners and losers into matches that
        already exist by following `P1SourceMatchId` / `P2SourceMatchId`, and resolving those links
        from the table is a different thing from resolving them from an array the fake controls.
        Writing it immediately turned up a unique index the fake had no way to model.
-   [x] **Asynchronous events are a pacing, not a display option** (migration 55). A league played
        out over days behaves differently, so `Pacing` is a column: the round clock is measured in
        days, matches are scheduled between the two players rather than called from the desk, and
        the deadline sweep tells the organizer which rounds are overdue. Reminders are columns
        rather than a job queue (migration 57), because the platform is the only thing keeping
        time — two players agree on Thursday at eight and nothing else will remind either of them.
-   [x] **Scheduling with several times and time zones** (migration 65). A single live offer is
        one round trip per candidate time between two people who are usually asleep when the other
        is awake, which is the whole reason an async event exists — two players three zones apart
        could spend a day of a three-day round discovering Thursday does not work either. A player
        now offers several slots at once, each recorded with the zone it was offered from.
-   [x] **Prize pools and an entry-fee register** (migrations 59 and 64). **The platform takes,
        holds and moves no money.** These record what the organizer told everyone the event costs
        and how the pot is meant to be split, and who has handed it over — a register kept where
        everyone is already looking instead of on paper or in the organizer's head. There is no
        payment integration behind either column and no balance anywhere.
-   [x] **A judge can release a registered deck** (migration 56) — a distinct column, because
        "released by a judge" and "never registered" both look like a null `DeckId`, and treating
        them alike would let a player withhold their deck, read the pairings, and only then choose.
-   [x] **Organizer CSV exports** — standings, pairings and the entry list, built from the payload
        the event page already renders (see **N12**, where the capability lives).

#### N16 — Visual redesign: make it look premium

**Why:** the platform's look is inherited from keyteki with a rebrand painted over it. There
are real theme tokens (oklch, light and dark) and ~2,200 lines of CSS behind 50 pages and 111
components — but the visual language was never _designed_, it accreted, one feature at a time,
including everything added recently. It works and it is consistent-ish; it does not look like
something you would trust with a competitive rating, a tournament entry, or a subscription.

That last point is the actual argument, not taste. The platform asks people to believe its
Amber means something, to run their store's events on it, and eventually (**N12**) to pay for
it. A site that looks like a hobby project makes every one of those asks harder, and no amount
of correct Elo math compensates for it.

**Sequence this BEFORE N6, not after.** N6 builds the shared component library on top of the
tokens — if that happens first, the library systematizes the current look and then gets rebuilt
when the look changes. Decide what it should look like, then systematize that.

**Tasks**

-   **Direction on paper first.** Two or three distinct visual directions, each shown on the
    _same_ three screens (lobby, deck list, a tournament page), as static mockups. Pick one
    before touching a component. This is the only cheap moment to change your mind, and
    "premium" is far easier to judge by comparison than in the abstract.
-   **Redesign the token layer, not the pages.** The oklch token set is already the leverage
    point — surfaces, brand, chat rows, table headers all read from it, so a considered palette,
    elevation model and border treatment moves the whole site at once. Pages that hardcode
    colours instead of reading tokens get fixed as they are found; that list is itself useful
    output for N6.
-   **Typography and spacing scale.** The single biggest lever on whether something reads as
    premium, and the one most often skipped: a real type scale with deliberate weights and
    line-heights, and a spacing rhythm that is enforced rather than eyeballed per component.
    The site currently uses Noto Sans for everything and picks sizes ad hoc.
-   **Depth, density and motion.** Decide once how elevation works (shadow? border? tint?),
    how dense a data table should be, and what moves — then apply it everywhere. Inconsistent
    answers to these three are most of what makes a UI feel amateur.
-   **Marketing surfaces get designed, not just themed**: the logged-out landing page, `/about`,
    and the sign-up flow. They are the first thing a new player sees and currently look like
    the app with the nav removed.
-   **The game board is last, and separate.** It is the highest gameplay risk on the site and
    the screen players tolerate least change on. It gets the new tokens, and a considered
    restyle only once the rest has settled.
-   **Both themes are designed.** Dark is not "light with the numbers inverted" — the current
    dark theme is largely derived, and derived dark themes are where muddy contrast comes from.

**Depends on:** nothing hard. **Blocks:** N6 (the component library should be built on the
chosen direction). Pairs with **I5**'s archon-maker image-diff harness — the same harness that
protects the deck images through the fabric upgrade is what proves a token change did not
silently alter them, so build it once and use it for both.

**Acceptance criteria**

-   Every candidate direction was judged on the same three screens before any component changed.
-   No route ships half-migrated: the site never shows the old look beside the new one, which
    means sequencing by route and holding each until it is done.
-   Light and dark are both designed and both audited for contrast — neither derived from the
    other.
-   The archon maker's output and the game board are pixel-verified unchanged by the token work,
    via the image-diff harness, before any deliberate restyle of them begins.
-   A short written record of the decisions — palette, type scale, spacing, elevation, motion —
    lives in `docs/design/` so the next feature does not re-improvise them. **This is what stops
    the redesign accreting all over again**, and it is the deliverable most likely to be skipped.

**A caveat worth stating plainly:** "looks premium" is not a testable condition, and no
acceptance criterion above can make it one. The criteria are about _process_ — comparing
directions properly, not shipping half-migrated routes, writing the decisions down — because
those are the things that reliably separate a redesign that lands from one that stalls
half-finished. Whether the result actually looks premium is a judgement call, and it is yours;
what this item can promise is that the judgement gets made once, deliberately, rather than
re-improvised per page.

#### N18 — The Champion’s Challenge: background deck testing for Vault Master _(done)_

**Why:** Vault Master's pitch is "everything, first", and until now what it sold was previews,
cosmetics and organizer exports — nothing only a $20 member could point at. This is the first
capability that is genuinely new capability: a computer plays a member's decks against each
other around the clock, in the background, and reports what their collection is actually made
of — including the decks whose SAS undersells them. It is also, quietly, the platform's first
AI player driving the real engine, which is the hard half of **F9** (bot showcase) and the
foundation **F3** (AI analysis) wants.

**Tasks**

-   [x] **A simulated player that always finishes.** Drives the engine through the ordinary
        player interface (`server/services/championschallenge/SimulatedGame.js`): house choice by
        hand-and-board count, plays everything legal, reaps what is ready, and answers _any_
        card prompt generically from the buttons and selectable cards the prompt publishes.
        Termination is the requirement, strength is not (yet): Done/Autoresolve preferred on
        selection prompts, Cancel never pressed while an alternative exists, the loop stops on
        `game.winner` before the rematch prompt can seduce it, and turn/interaction caps abandon
        the pathological case. Spec plays real full games and pins a legitimate three-key win.
-   [x] **Simulated games live in their own tables** (`ProvingGroundsDecks`,
        `ProvingGroundsGames`, migration 72). Never `Games`/`GamePlayers`, never the rating
        engine — every official statistic filters only on FinishedAt/WinnerId, so one row in
        the shared table would be a real result in thirty queries at once. A spec forbids the
        official tables' names in any SQL the lab runs.
-   [x] **The sweep** (`Lobby.runChampionsChallengeSweep`): ticks like the import worker, consults
        its cadence on every tick, round-robins rosters so one member cannot starve another,
        re-checks the owner's entitlement before spending CPU (a lapsed pledge stops play the
        day it lapses; results are kept and play resumes with the membership), and yields to
        the event loop mid-game so real players never feel a simulated one.
-   [x] **The report** (`/api/champions-challenge`, page `/champions-challenge`): per-deck simulated
        record against a SAS expectation computed with the site's own Elo model (same
        `sasWeight` the Amber ladder uses); a "plays like" SAS from a chess-style performance
        rating (withheld under 20 games, clamped at ±100 SAS); openings and first-player
        splits; findings in sentences. **Hidden gem** requires the entire 95% Wilson interval
        clear of the SAS expectation — the lab must be the most honest analyst on the site,
        because nobody can argue with a computer that plays in private.
-   [x] **(admin-config)** `championsChallenge` settings section: on/off, sweep cadence, games per
        batch, per-deck daily budget, roster size, turn cap.
-   [x] Capability `champions_challenge` on the Vault Master tier, gated end to end
        (`requireCapability` on every route, `PremiumLock` on the page), declared across
        server, client and mobile mirrors.
-   Later: matchup matrices between specific enrolled decks, and strength upgrades to the
    player — every point of which sharpens the same ratings this feature already reports.
    (The bot sparring a member directly landed as the **F9** Helper Bot, driving the same
    `BotPolicy` this lab plays with.)

**Depends on:** N12 (membership), the gameplay engine. **Feeds F9 and F3** — the AI player
exists now; the showcase supervisor and the analysis models build on it.

**Acceptance criteria**

-   [x] A simulated game reaches a legitimate conclusion (three keys) without stalling,
        looping or throwing; a wedged game is abandoned and recorded nowhere — asserted by
        specs that play real games.
-   [x] No simulated game appears in any leaderboard, player stat, deck record or meta
        aggregate: the lab writes only its own tables, asserted by a spec that forbids
        `"Games"`, `"GamePlayers"` and `"RatingHistory"` in lab SQL.
-   [x] A Vault Master (or admin) can enroll an owned, SAS-rated, simulatable deck and see
        its simulated record; everyone else gets the locked preview and a 403 from the API.
-   [x] "Hidden gem" is a statistical claim (Wilson lower bound above SAS expectation over
        ≥20 games), computed in one tested place.

#### N19 — ARI: the Archon Rating Index _(done)_

**Why:** the ladder priced deck strength with SAS — somebody else's model of a deck, frozen at
scoring time, blind to how the deck actually performs. ARI is the platform's own living deck
rating: every deck has one, it starts where the card math points, and it moves with what the
platform witnesses. It is also a differentiator no deck database can copy, because it is fed
by play that happens here.

**Tasks**

-   [x] **The index** (`server/services/rating/AriService.js`, `DeckAri` migration 73, keyed by
        Master Vault uuid like `DeckSas`): seeded at the SAS/AERC midpoint (either alone when
        one is missing; no seed, no ARI — zero is a claim, not an absence), moved Elo-fashion
        by results, clamped to a sane band, with rated-game and sparring-game counters kept
        separately so "how much of this number is sparring" always has an answer.
-   [x] **It moves with real games.** After every rated game, both decks' ARIs shift against
        the expectation the Elo engine actually used (players and decks), so the index absorbs
        only what player ratings could not explain — outside the rating transaction, so an ARI
        failure can never unrate a game.
-   [x] **It moves with the Champion’s Challenge.** Sparring games nudge ARI at a gentler
        admin-configurable rate (`simGameK`, default half the real-game `gameK`) — the bot's
        evidence is real but plainer. The Challenge page's rating column IS the deck's ARI now
        (the fitted "plays like" it replaced is gone).
-   [x] **It is what Amber spends.** `RatingService` hands the calculator ARI differentials in
        place of raw SAS — same scale, same `sasWeight`, same formula, so nothing about the
        engine changed except what the number knows. History rows record the values used;
        the config snapshot beside them says which regime. **(admin-config)** `rating.ari`:
        the switch (off = raw SAS exactly as before), `gameK`, `simGameK`.
-   [x] **Every deck shows it**: an ARI column beside SAS on the deck list, the deck summary,
        and the Challenge — served wherever SAS already was (`mapDeck`, `attachStats`), so any
        surface that knows a deck's SAS now knows its ARI.

**Alongside, a naming pass:** the Proving Grounds shipped as the **Champion’s Challenge**
(tables keep their birth names; everything above SQL renamed), the Tournament Lab is sold as
**Deep Probe** (capability id and API paths keep the working name — released phone builds gate
on them), Clubs gather under the **Grand Alliance Council**, and Play IRL is **Into the Fray**
— each page now opens by saying what it is for.

**Depends on:** N18 (the sparring games), the rating engine. **Acceptance criteria**

-   [x] A deck with SAS and AERC has an ARI before its first game; a deck with neither has
        none, and its games move no index — asserted in `AriService.spec.js`.
-   [x] Winner and loser move symmetrically, more when the result was surprising, at the sim
        rate for sparring games — asserted with exact arithmetic.
-   [x] With `rating.ari.enabled` off, rating behaves byte-for-byte as before (the rating
        specs run unchanged either way, because the seed falls back to SAS alone when AERC is
        absent).

#### N20 — The new-player welcome: a fortnight of Archon, and a pill that says be nice _(done)_

**Why:** the best moment to show somebody what the platform can tell them about their decks is
while they are still deciding whether to stay — and a fresh face in a lobby full of veterans
deserves to be legible as one.

**Tasks**

-   [x] **Fifteen days of the Archon tier for every new account**, resolved rather than
        stored: `resolveEntitlements` folds the trial in from the registration date the same
        way it folds in a grant or a pledge — the higher tier wins, so a new player who pays
        for Vault Master keeps it, a Supporter runs the trial and lapses back to what they pay
        for, and the trial ends the moment day fifteen does, with no claim button, no
        membership row and no sweep. A constant (`NEW_PLAYER_TRIAL_DAYS`) rather than a
        setting, because the resolver is deliberately pure.
-   [x] **The "New" pill** next to fresh names, everywhere names render: `publicBadge` carries
        `isNew` (from `Users.Registered`, through the batched badge lookup, the profile
        identity, and lobby summaries), and `PlayerBadge` draws an emerald pill — a welcome,
        never a key, because the tier badge is a claim about money and the trial makes none.
        A brand-new free account is now worth including in the badge payload; the
        nothing-to-show filter keeps it.
-   [x] The membership page states the trial with the same number the resolver enforces,
        served on the public catalogue.

**Depends on:** N12. **Acceptance criteria**

-   [x] A three-day-old account resolves to Archon (`source: 'new-player-trial'`,
        complimentary, expiring on day fifteen exactly) and a fifteen-day-old account to free
        — pinned in `entitlements.spec.js`.
-   [x] A trial account's public badge shows the New pill and no tier key; a paying new
        player shows both their paid tier and the pill — pinned in `publicBadge.spec.js`.

#### N21 — The learning bot: a sparring partner that studies its own games _(done)_

**Why:** every number the Champion's Challenge reports is only as good as the player producing
it. A bot that learns makes every ARI, every hidden gem and every finding sharper — and the
machinery it needs (self-play at volume, deterministic replay, a value model) is exactly what
F9's practice opponent and F3's game analysis have been waiting for. Perfect play is not on
any menu (hidden information sees to that); _provably improving_ play is, and proof is the
design's spine.

**Tasks**

-   [x] **The learning loop.** Sparring games log every chosen decision as features
        (`labFeatures.js` — only what a seated player could see); finished games label them;
        a dependency-free logistic model with per-card learned weights (`labPolicy.js`, spec
        proves it finds a planted signal) trains in-process; and the champion model steers
        every sparring game, exploring at softmax temperature so the diary stays honest.
-   [x] **Champion gating.** A candidate trains every `trainEveryGames` logged games and
        must TAKE the title: head-to-head against the champion (per-seat policies), on
        neutral decks that touch nobody's stats, promoted only when the 95% Wilson lower
        bound of its record clears 50% — retired, record kept, if it cannot prove itself in
        the window. The bot can get provably stronger and can never quietly get worse.
-   [x] **Card abilities taken literally: deterministic replay and forking.** Simulated
        games run seeded — engine randomness scoped through an AsyncLocalStorage source
        (`secureRandom.withRandomSource`; real games never enter the scope), bot dice on a
        separate stream, every input logged by list-position. `replayTo` reconstructs the
        exact game at any point (fingerprint-verified in specs), and a mismatch aborts the
        fork loudly rather than play a subtly different game.
-   [x] **The deep bot** (`DeepGame.js`): at the decisions that matter (house calls, key
        turns) it forks the live game, plays each candidate move out — the card's REAL
        ability code resolving — across sampled futures, scores the horizon with the value
        model, and keeps the best road. Every analyzed decision leaves an annotation with
        win odds and alternatives; the largest swing is flagged as where the game turned.
-   [x] **Two bots, one product**: the fast bot keeps the volume (ARI, win rates, gems);
        the deep bot plays `deepGamesPerDay` showcase games rendered on the page with its
        working shown. **(admin-config)** for all of it — the learning switch, training
        cadence and diary depth, arena thresholds, and every deep-thinking budget.
-   [x] **The randomizer**: 🎲 slots fill with a random eligible deck and swap themselves
        for a fresh one after a member-configured number of games — collection-wide gem
        hunting with no manual enrollment. Site admins' decks are exempt from the daily
        game cap, so the operator can flood the lab they are tuning.
-   Later: the deep bot as F9's practice opponent; the value model over real replays as
    F3's win-probability graph and blunder detection; richer features and search budgets as
    the diary deepens.

**Depends on:** N18/N19. **Feeds F9 and F3.**
**Acceptance criteria**

-   [x] Two runs from one seed play the identical game, and a mid-game fork reconstructs
        the exact recorded state before diverging — asserted on real games.
-   [x] Training provably learns: a planted signal (winning moves, a strong card) is found
        from outcomes alone, and the model never trains in place.
-   [x] Promotion demands proof: 52% over 200 games does not take the title; a Wilson-clear
        record does; an unproven candidate retires.
-   [x] Deep games finish legitimately, annotate their decisions, and flag exactly one
        turning point — asserted on a real planned game.
-   [x] Arena games appear in no member-facing table; sparring and showcase games keep
        every existing exclusion (no `Games`, no Elo, no leaderboards).

#### N22 — Getting decks onto the site without a Master Vault link _(done; catalog off by default)_

**Why:** written up after the fact, because it shipped without a backlog entry. Adding a deck
required having its Master Vault link to hand, which is not how players hold their collection —
they know a deck is called "Miss Onyx the Bewildering" and they have five of them on a shelf.
Master Vault has no per-user endpoint and no name lookup; the only identifier it answers to is a
uuid.
**Tasks**

-   [x] **The Master Vault name catalog** (`CatalogService`, migration 51,
        [docs/design/deck-catalog.md](docs/design/deck-catalog.md)). A background crawl walks the
        global deck registry oldest-first and records uuid, name, expansion and houses, so a
        player can search by name. Ordered by registration date because that is the load-bearing
        property: page N holds the same decks forever and new decks only append, so the persisted
        cursor never rewinds and a run that stops halfway costs only the pages it did not reach.
        `links=cards` is deliberately never requested — a search result needs a name, and asking
        for cards would multiply every response by two orders of magnitude for data this table
        does not store. Master Vault only, so it works on a server with no DoK key at all.
        **(admin-config)** and `catalog.enabled` is `false` until an operator opts in, because
        this is a crawl of somebody else's service.
-   [x] **A remembered DoK key with scheduled sync** (`DokLinkService`, migration 54). Buying a
        deck happens more often than anyone wants to go and find their DoK key again. The key is
        somebody else's credential, so it is sealed at rest (`crypto/secretBox.js`) and unsealed
        in exactly one place; if the site secret has rotated, the unseal failure is treated as
        "we do not have a key" rather than shown as a broken sync. A rejection is **terminal**,
        not retried: DoK issues one key per account and generating a new one voids the old
        instantly, so retrying a refused key cannot ever succeed and spends a rate limit finding
        that out.
-   [x] **A paced import worker** (`DeckImportJobService`, migration 53). Syncing produces a job
        rather than importing inline: the worker paces Master Vault, holds the circuit breaker,
        and survives a lobby restart, so a 300-deck collection import cannot be a request that
        times out or a burst that gets the site rate-limited. **(admin-config)** decks per tick,
        request spacing and sweep interval.
-   [x] **Deck co-ownership.** Two accounts can own the same physical deck — a household, a
        store's loaner, a deck that changed hands — which the one-owner-per-row model refused.
-   [x] **Deleting a deck archives its games** instead of erasing them. The delete used to take
        the game records with it, which silently rewrote both players' histories and the stats
        built on them.

**Acceptance criteria**

-   [x] A player can add a deck by typing its name, on a server with no DoK key.
-   [x] A stored DoK key is unreadable at rest and dropped the moment DoK refuses it.
-   [x] A large collection import is paced, resumable, and cannot be lost to a lobby restart.

#### N23 — Account deletion and App Store compliance _(done)_

**Why:** also written up after the fact. Shipping the Expo app to a real review queue turned a
set of legal and safety requirements into engineering work, and one of them — deletion — was a
genuine data-model bug rather than a store rule.
**Tasks**

-   [x] **Deletion is distinct from disablement** (migration 69). `Users.Disabled` was carrying
        two meanings at once — banned by a moderator, and deleted by its owner — which is right
        for suppression (both should vanish from the directory and the leaderboards) and wrong
        for everything else. The bug that proves it: `ModerationService.revoke` lifts a ban by
        clearing `Disabled`, so revoking a ban on a deleted account would have brought the
        account back. Deletion is now its own state, initiated by the owner, from both the web
        and the app.
-   [x] **The apps cannot talk about money on iOS.** Archon+ is sold on the website; the apps let
        a player _use_ a membership they already bought. Guideline 3.1.1 forbids prices and links
        to outside purchasing; 3.1.3(b) permits unlocking content acquired elsewhere, which is
        the shape the app takes. Rather than rely on a guard every future screen has to remember,
        the client **strips** `priceUsd` and `checkoutUrl` out of the tier catalogue before any
        screen sees them, and both fields are optional in the type — a screen that forgets the
        guard cannot compile a price block. Asserted against a real catalogue payload: no price,
        no checkout URL, no `patreon.com` and no `$` anywhere in the JSON an iOS build receives,
        while tier names and benefit copy survive. Paid-entry contests are withheld on iOS for
        the same reason. See [mobile/APP-REVIEW.md](mobile/APP-REVIEW.md).
-   [x] **The UGC safety controls review asks for**: reporting, blocking, published contact, and
        — the one that was missing — a filter in front of posting (**N5**).
-   [x] **Legal links reachable from the app**, without opening a hole: the first pass at this
        introduced one, and closing it is part of the same work.

**Acceptance criteria**

-   [x] An owner can delete their account, and a moderator lifting an unrelated ban cannot
        resurrect it.
-   [x] An iOS build contains no price, no checkout link and no route to one — enforced by a test
        that fails the build rather than by a reviewer noticing.

#### N24 — The Gauntlet: your decks against the field, on their own node _(done)_

**Why:** sparring against your own roster measures a deck against the company it keeps. A deck
that wins 70% inside a weak collection and one that wins 70% against the world are not the
same deck, and the mirror lab cannot tell them apart. The field already exists in this
codebase — `CatalogService` walks Master Vault's global deck list, the same walk Decks of
KeyForge uses to index every deck that exists — it just needed card lists and somewhere
honest to put the results.

**Tasks**

-   [x] **The pool.** Catalog decks hydrated one Master Vault request at a time, parsed by
        the member-facing importer's own parser (so a Gauntlet deck is not a second, subtly
        different notion of "deck"), cached forever — a registered deck's contents never
        change — and marked unplayable rather than retried when this server has no data for
        a card. Grown only while somebody has the Gauntlet switched on. **(admin-config)**
        for pool size, pace, and timeouts.
-   [x] **Never your own, never a friend's.** The draw excludes any pool deck the member or
        an accepted friend owns: a friend's deck is exactly the company-it-keeps problem the
        Gauntlet exists to escape.
-   [x] **Configurable field**: a share of games against the field (the rest stay mirror
        games), sets, houses the opponent must contain, a SAS window, and strategies read off
        the deck's AERC breakdown (amber control, board pressure, speed, artifact/disruption,
        efficiency). Sets and houses are exact; SAS and strategy can only match enriched
        decks, so the page reports how many decks the filters actually reach instead of
        leaving a member wondering why every game is still a mirror.
-   [x] **Reported separately, never averaged.** Field results live in their own table and
        their own column, because "against my decks" and "against the field" are different
        claims. They move ARI at the sim rate, count against the same daily budget, and give
        a single-deck roster games the mirror lab never could.
-   [x] **Deep Probe weighs more than win percentage.** Its ranking now combines ARI, the
        player's win rate against the meta AS IT STANDS (per-house record weighted by
        prevalence, with coverage stated), what their own record can actually support (95%
        lower bound, not face value), and Champion's Challenge results — field games counting
        double the mirror ones. Every term is shown, weights included; the page names the
        best all-round deck and the best against the current meta, which are often different.
-   [x] **A node of its own.** `npm run challenge` runs the sweep in a dedicated process, so
        simulated games stop competing with the lobby's real players. Which node plays is
        **(admin-config)** (`sweepOwner`: lobby / worker / any) and the right to sweep is a
        database lease claimed in one atomic statement — two sweepers would quietly play every
        deck twice its daily budget, invisibly. The worker needs Postgres and nothing else.
-   Later: matchup matrices against named archetypes; the pool as a public meta sample;
    field results feeding the ARI seed for decks nobody here owns.

**Depends on:** N18/N19/N21 and **N22** (the Master Vault deck catalog, whose index is the field). **Feeds** Deep Probe and F3.
**Acceptance criteria**

-   [x] The draw never returns a deck the member or a friend owns, and the count the page
        shows is built from the same clauses as the draw.
-   [x] A hydrated deck this server cannot simulate is remembered as unplayable, so it never
        costs a second Master Vault request.
-   [x] Field games are recorded from the member's deck's point of view, never written to the
        mirror table, and never summed with mirror results.
-   [x] A 3-0 cannot outrank a 40-game record in Deep Probe's ranking, and a missing term
        (no ARI, no Challenge games) renormalises the weights rather than counting as zero.
-   [x] Two processes cannot both sweep: the lease is atomic, a database error means nobody
        plays, and an unrecognised `sweepOwner` falls back to the lobby.

#### N25 — Sharpening the bot: targeting, honest search, better credit _(done)_

**Why:** four things were wrong with how the Champion's Challenge bot learned, and every one of
them was invisible in the output — a bot that targets at random and a bot that targets well both
produce a tidy win-rate table. Each fix makes every number the lab reports, every ARI it moves
and every Deep Probe ranking that reads it more truthful.

**Tasks**

-   [x] **Targeting.** Selections — "choose a creature to destroy", "steal from whom", most of
        what one KeyForge player does to another — were answered by a dice roll over the
        selectable cards. They are decisions now, with ownership-gated features (a big creature
        is a good thing to destroy and a bad thing to sacrifice, which one weight cannot say),
        amber-on-card, readiness, location, and two learned weights per distinct prompt so
        "destroy" and "heal" can be told apart when the board looks identical.
-   [x] **Common random numbers in the search.** The rollout seed mixed in the candidate index,
        so roads were compared under different futures and a move could win for having been
        dealt a better deck. Futures are shared across candidates at a decision — a search bug,
        not a tuning choice: it made the deep bot report deck luck as insight.
-   [x] **Credit assignment.** Labelling every decision with the final result trained the model
        against strong plays in games thrown away twenty turns later. Labels now lean partly on
        the value of the position the same seat reached next, with the value model frozen for the
        batch. **(admin-config)** `trainingLambda`; 0 restores the old behaviour exactly.
-   [x] **Distillation.** The deep bot's rollouts measure what a move is worth and those numbers
        only fed the showcase panel. They are training targets now — the rejected roads included,
        which are the only negative examples the loop ever gets — so a minute of forking becomes
        knowledge that costs nothing to reuse.
-   [x] **Cheaper, faster title fights.** A sequential probability ratio test replaces fixed-N
        Wilson (a 73% record over fifty games takes the title; an even one is ruled out in about
        seventy), and arena pairings are paired: one seed played twice with the seats swapped, so
        deck and draw luck cancel. `arenaMinGames` is a floor under the test now rather than a
        sample size, hence its default falling from 150 to 30.
-   [x] **Evidence weighed.** Sparse weights shrink toward zero by observation count, so a card
        seen twice cannot outrank one measured over hundreds; exploration anneals toward a floor
        that stays above zero; dropped forks are counted and logged rather than silently thinning
        the search.
-   Later: feature crosses for the key race; a value model over real replays (F3's
    win-probability graph); per-deck card contribution in the member's report.

**Depends on:** N21. **Feeds** F9 (the practice bots play this policy), F3 and Deep Probe.
**Acceptance criteria**

-   [x] A real game logs targeting decisions carrying the prompt that asked for them, and a model
        weight change flips which target is taken.
-   [x] Candidates at one decision are rolled out under identical futures, pinned on the seed
        derivation itself because the effect is otherwise only visible as noise.
-   [x] A strong follow-up position lifts the label of a move the game later wasted, and a
        position strong for the OPPONENT does not.
-   [x] A measured search target outranks the outcome-derived label; a deep game returns lessons
        for roads it rejected as well as the one it took.
-   [x] Three lucky games do not outweigh three hundred measured ones.
-   [x] Each arena pairing is played twice on one seed with the seats swapped, and a title
        settled mid-pair stops the second half.

#### N26 — The model on real games, and the lab made visible _(done)_

**Why:** the value model trained by N21/N25 had only ever looked at the lab's own sparring, and
three of the most useful things the Challenge produces were never shown to anybody. This points
the model at real replays, surfaces what the roster's games were already computing, and gives an
operator a way to see whether the lab is working at all.

**Tasks**

-   [x] **Win-probability curve on real games** (`replayValue.js`), under `advanced_replays` so
        it reaches the Archon tier rather than staying behind Vault Master. Every recorded board
        frame scored from one player's seat; the sharpest drops flagged and clickable, jumping
        the viewer to the frame. Parity is STRUCTURAL: one `stateFeaturesFrom`, two adapters
        (live engine, recorded frame), because a model read against differently-scaled features
        produces a confident graph of nothing with no error anywhere. A spec asserts a live
        position and its recording give identical features.
-   [x] **The refusals, stated in the panel.** No counterfactual lines — forking a game needs a
        seed and an input log, which only the bot's own games have — and a drop is a change in
        the position, not a verdict on a decision. With no trained model there is no curve at
        all rather than a heuristic stand-in a reader could not tell apart.
-   [x] **Your decks against each other**: the matchup matrix the mirror lab has been producing
        since N18, counted from the winner column only, blank where a pair is too thin.
-   [x] **What the bot makes of your deck**: per-card contribution from the learned model's
        weights, dropped entirely for cards it has seen fewer than `SHRINK_PRIOR` times, because
        below that the number is mostly prior and "no view yet" is the truthful answer.
-   [x] **The sparring partner's history**: every version that took the title and the record it
        took it on — each one having cleared the sequential test against its predecessor, so the
        list only ever goes one way.
-   [x] **Win rates carry their 95% interval.** 5-3 and 300-180 both print "62%".
-   [x] **Lab health on `/admin/analytics`**: games today, which node holds the sweep lease and
        whether its heartbeat has gone stale (a dead worker node is otherwise invisible), diary
        depth, champion version, any title fight, pool against target, last Master Vault fetch,
        and what the pool could not play — grouped, because one card id at the top of that list
        is actionable.
-   Later: an on-demand showcase game; per-turn win probability on the live board for
    spectators; the curve over a member's whole history as a form graph.

**Depends on:** N21/N25 (the model), N1 (board-state replays). **Feeds F3.**
**Acceptance criteria**

-   [x] A live position and the recorded frame of that same position produce identical features —
        the one property that makes the curve mean anything.
-   [x] A curve rises as the seat's amber lead grows, and reads the same game inverted from the
        other seat.
-   [x] No model means no curve, with a reason a member can read.
-   [x] A matchup pairing is counted once, not twice; a pairing involving a withdrawn deck is not
        counted at all.
-   [x] A card the model has barely seen is left out of contribution rather than listed with a
        confident-looking number.
-   [x] A stale sweep lease reports as stale, and the health panel survives every one of its
        queries failing.

### Future — differentiation

_Goal: the things that make Archon Arena the KeyForge platform rather than a KeyForge site.
Each is worth doing; none should displace the loop above._

#### F1 — Versioned public API

Versioned `/api/v1` (profiles, ratings, rankings, tournaments, match history, deck metadata),
API keys and OAuth scopes **(admin-config rate limits)**, webhooks for tournament and match
events, OpenAPI spec with a generated docs page. Also brings rate limiting and versioning to
the currently unversioned public stats endpoints.
**Depends on:** I3, N1. **Acceptance:** a third-party app authenticates, reads a leaderboard,
and receives a webhook on tournament completion, using only the published docs.

#### F2 — Discord integration

OAuth account linking, a bot for tournament announcements and pairing pings and result
reporting, per-club webhooks **(admin-config)**, rich presence.
**Depends on:** N2 (event taxonomy), F1 (webhooks). **Acceptance:** a club's Discord receives
pairings for its event without anyone copying anything by hand.

#### F3 — Coaching and AI analysis _(misplay review shipped; the rest open)_

Coaching profiles/marketplace with booking, shared replay review rooms (coach and student
stepping through together), AI game analysis (blunder detection, alternative lines,
win-probability per turn) over the replay event stream, AI deck insights in SAS context.

**Shipped — the misplay review** (Archon+, under `advanced_replays`): recordings are
version 4 — each player's hand is captured beside every board frame, from the player's own
perspective, in a side channel the server strips for anyone who may not read it (share links
always; each player sees their own hand only; admins both). The replay viewer draws your
recorded hand at every step, and the analysis panel flags "moments worth a second look":
house calls that had almost nothing to act on when another house was full, ready creatures
of the called house left unused at end of main, playable cards held that displaced fresh
draws, and a house clogging the hand across consecutive turns. Deliberately heuristic and
deliberately phrased as questions - it is arithmetic over recorded state
(`replayMisplays.js`), not a simulation.
Good decisions that merely look thin are recognised and dropped rather than flagged: v5
recordings carry the active player's legally callable houses (so Control the Weak is never
a "misplay"), and hindsight over the rest of the recording clears a call that forged,
out-earned the fuller house or denied a check, a hold that got played within two turns (or
that the game ended too soon to judge), idle creatures already past the point of
mattering, and a clog that cashed out into a big turn.
**Card knowledge** (`cardKnowledge.js`): the review also reads what each card DOES, from
the canonical master-vault text - narrow, high-precision roles only (steals/captures,
board wipes, key cheats, cannot-reap). v6 recordings add the owner's archives beside the
hands (same table, same stripping rules), so every zone the player could reach is read.
On top of that: house-call worth counts bonus pips and recorded archives; a creature that
cannot reap is never "unused"; a hold of pure answers is insurance, not a slip; the
"answer held" moment names the steal or wipe that sat reachable while the check or the
wide board it answers actually landed; and a per-house **toolbox** profiles what the deck
showed (cards, pips, steals, wipes, key cheats) - the reading house calls are planned
with. Always availability, never outcome: conditions, costs and targets stay invisible,
and the panel says so. True "what would have happened" alternative lines and
win-probability remain open, and would sit on the same recordings.
**Depends on:** N1 (board-state replays are the input). **Acceptance:** a coach and student
step through the same replay in sync, and a finished game produces a win-probability graph.

#### F4 — Streaming and content tools

OBS overlay endpoints (game state, names, Amber, key count), featured-match page and caster
mode with both hands visible and delay enforced, clip/share moments from replays.
**Depends on:** N1. **Acceptance:** a caster streams an event match with overlays and an
enforced delay, with no way for the stream to leak hidden information to live players.

#### F5 — Organized play program

Sanctioned event tooling, TO certification levels, an OP points/season circuit distinct from
Amber **(admin-config point tables)**, regional/national/world championship structures,
prize and invite tracking, top-N qualification reports.
**Depends on:** N7, N9. **Acceptance:** a multi-event season awards circuit points and
produces a qualification report without manual spreadsheets.

#### F6 — Learn hub

The rest of `/learn` once **N11** has built the tutorial: puzzles ("forge this turn"), a
strategy library, deck-reading guides, and a first-game funnel that hands new players straight
into Quick Match.
**Depends on:** N11 (the tutorial engine), N6. **Acceptance:** a player can find and finish a
lesson on something specific — a keyword, a house, reading SAS — without playing a whole game.

#### F7 — Mobile general availability

App Store release of the existing Expo iOS app and an Android build, then the rest of feature
parity with the web platform. Tournaments, membership, Archon Intelligence and push notifications
are already in the app (**N14**/**N23**); community, public profiles and a replay viewer are not.
**Depends on:** N2 (done), N6, and **N14** for the distribution path in between.
**Acceptance:** both stores carry a build that can play, enter a tournament, and receive pairing
pushes.

#### F8 — Scale-out

Redis-backed leaderboard sorted sets, Redis-shared DoK rate-limit counter for multi-process
deployments, revisit Kubernetes (charts retained in `infrastructure/`) if VPS scaling stops being
enough. Multi-lobby settings invalidation is done (**N8**).
**Depends on:** N10 load testing telling us which ceiling is hit first.
**Acceptance:** a documented scaling step exists for each ceiling the load test finds.

#### F9 — Bot showcase: two AI players in a permanent watchable game

**Why:** an empty lobby is the hardest problem a new platform has. Two bots playing each other
around the clock give the Watch hub content from day one, let a visitor see the game before they
commit to it, and run the engine as a continuous soak test.
**Tasks**

-   [x] An AI player driving the engine through the ordinary player interface (house choice,
        play / use / reap / fight, key timing). Strength can start crude — never stalling
        matters more. **Built as the Champion’s Challenge sparring partner (N18)** —
        `server/services/championschallenge/SimulatedGame.js`; the showcase reuses it. The
        policy was extracted to `server/services/botplayer/BotPolicy.js`, which the practice
        bots (F9) still play; this lab moved on to a learned policy in **N21**.
-   [x] **The practice opponents: thirteen bots, one per house** (design:
        `docs/design/practice-bots.md`). The lobby always has an open table hosted by a bot
        from the roster — join it, pick a deck, and the game starts itself. Each bot belongs
        to a house and plays only decks containing it (its own collection first, standalone
        decks as the zero-setup fallback), so the table that replaces a joined one is a
        different character playing a different colour of deck. Games run on the real engine
        on the real game node, answering instantly; wedges end in an honest concede, never a
        hang, and a pump can never hold the node's event loop.
-   [x] **The practice bots play the champion model.** The move list and the learned policy
        are shared with the Champion's Challenge (`server/services/botplayer/decisions.js`,
        N21's `labPolicy`), so the lab's training shows up in the lobby with no second brain
        to maintain; a site with no champion yet plays the heuristics. **(admin-config)**
        `bots.useLearnedPolicy`. The lab's DEEP planner stays in the lab: it plans by forking
        a seeded replay, which a live table with a person clicking in it cannot provide, and
        costs about a minute of compute per game. Deep thought at a live table wants seeded
        practice games and a logged input stream first — the bot-vs-bot showcase is where
        that pays off, since both seats are ours.
-   [x] **Bot Settings** (`/admin/bots`, isAdmin): the roster with each bot's name, picture,
        profile, on/off switch and deck count, plus the knobs that govern all of them. Bots
        are ordinary accounts, so their pictures and profiles go through the same pipeline a
        player's do — and are unenterable, house-keyed, and can never capture a real
        account's name.
-   [x] Bot games are excluded from Amber, matchmaking, leaderboards, and every statistics
        aggregate — never persisted at all (the Champion’s Challenge doctrine, applied at
        the router), and Quick Join never matches into a bot table. Asserted by
        `test/server/gameRouterBotGames.spec.js`.
-   A supervisor that keeps a bot-vs-bot table live, starts a fresh game when one ends, and
    publishes it to the Watch hub as spectatable. (The node driver already plays both seats —
    `test/server/gameserver.botdriver.spec.js` pins a full bot-vs-bot game — so what remains
    is the supervisor and the Watch listing.)
-   **(admin-config)**: how many showcase tables run, how their decks are chosen, and whether
    the showcase is on at all.
-   Later: the bot as the tutorial's sparring partner (**N11**), and as the base for AI
    analysis (**F3**).

**Depends on:** N1 (Watch hub). Feeds F3 and N11.
**Acceptance criteria**

-   A logged-out visitor can watch a live game within seconds of landing on the site.
-   [x] A bot game reaches a legitimate conclusion (three keys or deck-out) without stalling,
        looping, or throwing; a wedged table concedes rather than holds its player — asserted
        by `test/server/gameserver.botdriver.spec.js`, which plays full games through the real
        game server wiring.
-   [x] No bot game appears in any leaderboard, player stat, or meta aggregate — asserted by
        `test/server/gameRouterBotGames.spec.js`.

---

## Phase-by-phase status

Phases group related work thematically. Sequencing lives in the backlog above; the backlog ID
in a `→` note points to where an unfinished item is scheduled.

## Phase 0 — Working fork & foundation

-   [x] Create ArchonArena repo from keyteki source (github.com/keyteki/keyteki import).
-   [x] Preserve upstream remap path so upstream gameplay/card fixes can be pulled in later
        (documented in `docs/UPSTREAM.md`).
-   [x] Get server + client building locally (`npm install`, dev build passes).
-   [x] Get test suite running; record baseline pass rate before any changes, and re-record it
        whenever it legitimately moves (docs/TEST-BASELINE.md: 38,221 at the fork, 40,144 as of
        the misplay review / 0 failed).
-   [x] CI pipeline (GitHub Actions): `.github/workflows/ci.yml` runs typecheck, lint, build
        and the full test suite on every push and PR; CodeQL runs weekly. TCO deploy jobs pruned.
-   [x] Dockerfile + docker-compose for one-command local stack (PostgreSQL + Redis).
-   [x] Document dev environment setup in `docs/DEVELOPMENT.md` — the Archon Arena pass over
        the platform layer (services, schema vs migrations, settings, seeding, verification),
        with `local-development.md` still covering the engine/stack basics.

**Why first:** nothing else can be verified stable without a reproducible build/test baseline.

## Phase 1 — Rebrand to Archon Arena

-   [x] Rename user-visible strings: site title, page titles, navbar, about/help pages.
-   [x] package.json name/description, manifest, HTML meta tags, OpenGraph tags.
-   [x] Replace TCO branding references in client UI components.
-   [x] Logo + favicons: Archon Arena mark (amber keyhole in hexagonal arena) generated
        by scripts/generate-brand-assets.js; theme-color metas updated.
-   [x] Site-wide color theme: token-based light/dark palettes keyed to the brand amber
        (`client/styles/tailwind.css`). Owner may still supply custom art to replace the
        generated mark.
-   [x] Transactional emails carry the site name from config (`appName`); they are plain text.
        → **I6** for branded HTML templates.
-   [x] Legal pages: privacy policy rewritten for Archon Arena; About page rewritten
        (platform intro, ratings explainer, lineage credits, FFG/Ghost Galaxy IP
        acknowledgement).
-   [x] **About/Privacy admin-editable**: Site Settings > Site Content accepts Markdown
        that replaces either built-in page (react-markdown, HTML-escaped; empty = built-in).
-   [x] Terms of Service page, admin-editable alongside About and Privacy, and stated at the
        point of sign-up rather than buried (**I6**). How to Play, About, Privacy and Terms have
        since been rewritten as Archon Arena's own copy rather than edited inherited text.
-   [ ] Keep internal code identifiers stable where renaming risks gameplay breakage
        (rename UI-facing only; engine internals renamed opportunistically later). Still
        deliberate; `docs/README.md` and `AGENTS.md` are the two _documents_ still addressed to
        keyteki (see Known defects).

**Why early:** cheap, zero gameplay risk, and everything deployed from day one carries the
correct identity.

## Phase 2 — Production deployment on ArchonArena.com

-   [x] Choose hosting (VPS w/ Docker Compose to start; K8s charts retained for later) —
        rationale in docs/DEPLOYMENT.md.
-   [x] Production docker-compose: web, game node(s), Postgres, Redis, reverse proxy
        (docker-compose.prod.yml).
-   [x] Caddy reverse proxy with automatic TLS (deploy/Caddyfile).
-   [x] Environment/secrets management (.env.production.example, gitignored secrets,
        env-mapped config keys).
-   [x] Health-check script covering containers, TLS, game-node wiring, migrations, card data,
        env and disk (`deploy/healthcheck.sh`).
-   [x] Error tracking wired client + server (Sentry); needs `SENTRY_DSN` set on the host.
-   [x] Legacy MongoDB removed entirely — all services are PostgreSQL-only, the two dead
        standalone scripts are deleted and the `monk` dependency is gone (housekeeping below).
-   [x] Point ArchonArena.com DNS (Porkbun) at the host, and verify WebSocket pass-through for
        the game server end-to-end on the live host — both done at the soft launch (**I1**).
-   [x] Scripted production update (`deploy/update.sh`): clean-tree and branch preflight,
        fast-forward pull, rebuild, migrate, health-check, unrated-game report → **N10**.
-   [x] Backup and restore scripts, encrypted and off-host capable, with the restore rehearsed
        in CI against a real PostgreSQL → **I7** (the bucket itself is still an owner action).
-   [ ] Uptime monitoring configured and alerting → **Q1**.
-   [ ] `SENTRY_DSN` set on the host (client and server are already wired) → **Q1**.
-   [ ] Off-host backup destination configured and the first run made → **I7**.
-   [ ] Staging environment (staging.archonarena.com) deploying from main → **N10**.
-   [ ] Zero-downtime deploy (drain game node, deploy, restart) → **N10**. Built once and
        reverted; a deploy currently ends every game in progress.

## Phase 3 — Authentication: Keybringer SSO

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
-   [x] Sign-up entry point: "Sign up with Keybringer" on the Register page (shared
        SsoButton; hidden until SSO is configured).
-   [x] Link/unlink UI in account settings (Connected Services), with orphan
        protection: unlink refused while the account has no password and no other
        identity.
-   [~] **Deferred, not blocked.** Registering the Keycloak client in the keybringer realm
    (client id/secret, redirect URIs for archonarena.com + localhost) needs Ghost Galaxy's
    permission, which the platform does not have, so this whole phase is dormant until that
    changes. `auth.oidc.enabled` is `false` by default, the login page asks
    `/api/account/oidc/status` before offering the button, and local registration is a complete
    signup path on its own. When permission arrives this becomes config, not code — so nothing
    below is worth building first.
-   [ ] Admin setting: SSO-only mode (disable local registration) **(admin-config)**. One of the
        two **(admin-config)** promises in this document with no registry section behind it; the
        other is the matchmaking parameters in Phase 18.
-   [ ] RP-initiated logout against Keycloak; session revocation on unlink.
-   [ ] Role mapping: Keycloak roles/groups → Archon Arena roles (admin, TO, moderator).
-   [ ] Password-set flow for SSO-created accounts.

## Phase 4 — Deck service: Decks of KeyForge SAS integration

-   [x] Current-state analysis of TCO deck import (Master Vault API) —
        docs/design/deck-sas.md.
-   [x] Integrate Decks of KeyForge (DoK) API: fetch SAS/AERC per deck
        (server/services/dok/DokService.js; DeckSas table keyed by Master Vault uuid).
-   [x] Store SAS snapshot + fetch date; stale rows refresh in the background on access
        (bounded per request).
-   [x] Config-driven **(admin-config)**: refresh interval, timeout, per-minute cap and
        enable/disable are all editable at runtime from Site Settings > Decks of KeyForge.
        The API key itself stays env-only (`DOK_API_KEY`) on purpose.
-   [x] Graceful degradation when DoK is down (cached values, SAS simply absent).
-   [x] **Per-minute rate limiting** on all outbound DoK calls (process-wide sliding
        window; maxRequestsPerMinute, default 25, admin-tunable to match DoK patron
        tiers 50/100/250). Enrichment skips over budget; bulk import caches SAS from the
        filter response so a collection costs ~1-2 calls, not one-per-deck.
-   [x] Tests: enrichment, refresh windows, API failure paths, rate limiting (32 tests).
-   [x] **Bulk / live import from Decks of KeyForge** (docs/design/dok-import.md), with a live
        progress bar, re-run sync, and a remembered DoK username (Users.DokUsername).
-   [x] Show SAS on deck _lists_ and the pre-game screen (**N3**). The lobby game list is the
        deliberate exception — decks are not chosen for open games.
-   [x] **Periodic refresh sweep job** — stalest decks first, yields to live traffic, cadence
        and batch size admin-config (**N3**).
-   [x] AERC component breakdown display from stored RawData (**N3**), and AERC-based analysis
        of a player's own record (**N12**).
-   [x] **Master Vault deck catalog** — a background crawl building a name → uuid index so decks
        can be added by name rather than by link; off by default (**N22**,
        docs/design/deck-catalog.md).
-   [x] **Stored DoK key with scheduled sync**, sealed at rest, and a **paced import worker** so
        a large collection import is a job rather than a request (**N22**).
-   [x] **Deck co-ownership**, and deleting a deck archives its games rather than erasing them
        (**N22**).
-   [ ] Redis-backed shared rate-limit counter for multi-process scale → **F8**.

## Phase 5 — Rating engine: SAS-adjusted Elo

Chess Elo, modified by (a) key differential of the result and (b) SAS (power) difference
between the two decks. Playing up in SAS and winning big should pay more; stomping with a
much stronger deck pays less.

-   [x] Core algorithm as a pure calculator (`server/services/rating/EloCalculator.js`;
        design: docs/design/rating-engine.md): SAS handicap folded into expected score,
        key-differential margin-of-victory multipliers, provisional K, rating floor.
-   [x] All calculator parameters override-driven **(admin-config)** with validation.
-   [x] Unit tests: algorithm properties (zero-sum, monotonicity in key diff, SAS handicap
        direction), golden-value tests, config edge cases (27 tests).
-   [x] RatingService orchestration layer: hooks GAMEWIN at the lobby/router layer
        (ARCHON-marked, fire-and-forget, idempotent), zero gameplay-engine coupling.
-   [x] DB: Ratings + RatingHistory tables (migration 24) with per-game Elo config
        snapshot; SAS joined from DeckSas at rating time.
-   [x] Public API: GET /api/ratings/:username (pool, rating, gamesPlayed, provisional).
-   [x] Ratings shown in the UI: lobby game list, pending game, profile rank card, Ratings
        and Leaderboards pages.
-   [x] Admin settings service overrides wired into RatingService at rating time.
-   [x] Rating decay policy **(admin-config)**: grace days, points per week, floor, and an
        auto-apply schedule (migration 37).
-   [x] Provisional/placement badge until N games.
-   [x] Separate rating pools: Archon / Sealed / Alliance, mapped from game format.
-   [x] Per-game rating delta surfaced to players on the post-game result panel (**I4**).
-   [x] **Recalculation tool** (replay rating history under a candidate Elo config;
        admin-triggered, dry-run first, seeded from the season archive) — migration 43.

## Phase 6 — Rankings & leaderboards

-   [x] Player profile fields: country (validated ISO-3166 alpha-2) + state/province
        (US/CA dropdowns, free text elsewhere) — Profile > Account > Location; migration 25.
-   [x] Region mapping: country → NA/LATAM/EU/MEA/APAC (server/services/rating/regions.js).
-   [x] **Region mapping admin-configurable**: Site Settings > Regions lets admins move
        any country to a different region (stringMap overrides; defaults untouched).
-   [x] **Admin rating tools**: view / set / reset any player's Amber per pool from User
        Admin (RatingHistory kept as audit trail; reset re-enters at default as provisional).
-   [x] **FIDE-style K tiers**: ≥2100 → K24, ≥2400 → K16 (admin-config thresholds/values).
-   [x] **Tournament K multiplier** (config tournamentKMultiplier, default 1.1).
-   [x] **W–L records** on the Ratings page and Leaderboards (aggregated from RatingHistory).
-   [x] Leaderboards: worldwide, region, country, state over rating pools; disabled
        accounts excluded; provisional flag shown.
-   [x] Minimum games threshold to appear on boards (rating.leaderboardMinGames).
-   [x] Leaderboard UI (Community > Leaderboards): scope tabs follow the viewer's saved
        location, pool tabs (Archon/Sealed/Alliance), pagination, own-row highlight.
-   [x] Public API: GET /api/ratings/leaderboard (paginated, capped limit).
-   [x] **"Amber" branding**: ratings surfaced as Amber via a shared AmberValue component —
        display only, the Elo math is unchanged. Deck power stays "SAS" to avoid confusion.
-   [x] **Top Players page**: worldwide top 25 by Amber per pool, podium for the top three. Since
        folded into Leaderboards — it was the same ranking query pinned to the top 25 — and the
        statistics pages gathered from Play, Community and two top-level tabs into one Stats
        section. Every former path still redirects, because a dead link is worse than a redirect
        nobody notices.
-   [x] **Ratings page**: personal Amber per pool with world rank (#N of M), games,
        provisional badge, and a plain "How Amber works" explainer.
-   [x] **Seasons**: season records, soft reset toward a configurable baseline with a carry
        factor, admin season operations UI (migration 37).
-   [x] Player rank card on the profile page; Amber shown on lobby player names.
-   [x] Public player profile pages, with every username outside the game board linking to one
        (**I3**).
-   [x] Season display, archive, end-of-season summary and season badges for players (**N4**).
-   [x] Activity window on boards **(admin-config)**, applied to the board and to the rank and
        field size on a profile so the two cannot disagree (**N4**).
-   [x] Membership badges beside names on every board and roster (**N12**).
-   [ ] Redis-backed leaderboard cache (sorted sets) once traffic warrants → **F8**.

## Phase 7 — Tournament engine

-   [x] Standalone **Tournament Service** (own tables/API, zero gameplay-engine coupling;
        docs/design/tournament-engine.md; migrations 27 + 32).
-   [x] Formats: Swiss (score groups, rematch-avoiding backtracking, byes, folded seeded
        round 1) and single elimination (seeded, top-seed byes); Archon/Sealed/Alliance
        per event.
-   [x] Event lifecycle: create (any logged-in user organizes), registration window,
        drops (self or TO), round pairing gated on complete results, finish/cancel.
-   [x] Result flow: participants report open results, organizer can correct; byes
        auto-win; table numbers per pairing for IRL play.
-   [x] Standings: match points → **OMW%** → **GW%** → **OGW%** → fewest byes, with
        W-L records and game counts; live on the event page. These are the standard TCG
        tiebreakers, each opponent floored at 33% so a draw against somebody who went 0-5
        and dropped cannot wreck a tiebreak you had no say in, byes excluded from the
        opponent averages, dropped players still counted at their final record. They
        replaced sums of opponents' points, which only mean anything while every player
        has played the same number of matches — i.e. never, once byes and drops exist.
-   [x] Public pages: tournament list + create form, event page with players, per-round
        pairings, reporting buttons, standings, TO controls.
-   [x] **Online automation:** auto-created lobby games per pairing (reserved for the paired
        players, registered decks pre-selected, auto-start when both are seated), GAMEWIN
        auto-reporting (idempotent, series-aware), round timers with a live clock, "Open my
        table" recovery, no-show/forfeit awards, auto-forfeit of open matches on drops.
-   [x] Tournament results feed the Rating Service: unrated events never move Amber;
        rated events apply the tournament K multiplier (**admin-config** allowRated).
-   [x] Formats: double elimination (full winners/losers bracket templates with
        grand-final reset), round robin (circle-method full schedule), Swiss cut to
        top-N single-elim playoff (own best-of); best-of 1/3/5 series everywhere.
-   [x] Registration operations: player caps with FIFO waitlists + auto-promotion,
        scheduled start times, private events with join codes, TO-opened check-in
        (optionally shedding no-shows at start), co-organizers/judges (staff),
        seeding by registration/rating/random/manual, per-event announcements.
-   [x] TO tools: deck registration with SAS caps/bands per event (DeckSas-backed,
        decks locked at start, decklist visibility control), penalties (forfeit,
        no-show, double loss), printable pairings/standings, bracket visualization,
        result-correction locking once later bracket results build on them.
-   [x] Player experience: "Your Match" panel (opponent + Amber + deck, join/rejoin
        your table, bye notice), final placements with podium display, personal
        tournament record (trophy history) via /api/tournaments/history.
-   [x] Tests: pairing algorithms + bracket templates + lifecycle/authorization/
        automation (68 tournament tests + rating gating tests).
-   [x] **KeyForge-only conditions** (migration 33): deck swap policy (locked vs
        between-rounds), set legality (allowed expansions), house restrictions
        (required/banned houses), one-Archon-per-event uniqueness, SAS chain handicap
        (stronger deck starts chained, auto-applied to online games via the engine's
        adaptive-chains path; per-chain SAS + cap **admin-config**), Chainbound-style event
        chains, the official **Triad** format (3-deck pools, per-match opponent ban + pick),
        and Reversal / Adaptive Bo1 event formats with event→lobby format mapping.
-   [x] **Hybrid events**: online + paper results feeding one standing (migration 46). Paper
        results move the standing, never Amber — the ladder needs inputs nobody typed in.
-   [x] **Kiosk check-in**: a per-event QR, rendered locally, that only checks in whoever
        scans it — safe to leave on the table.
-   [x] **Alliance pod legality per event**, backed by newly-recorded pod provenance
        (`Decks.AlliancePods`) — the rules were previously uncheckable for want of the data.
-   [x] **Archon Adaptive Bo3**: own decks, swapped decks, then a chain bid for the decider.
-   [x] **Round-pairing notifications** — in-app and email, deduplicated per player per round (**N2**).
-   [x] **Result integrity** (migration 49): reporting your own loss is taken at face value;
        reporting your own win waits on the opponent, who can confirm or dispute it. Judges
        and platform-witnessed games are final. An unconfirmed result still counts and the
        round still advances — the alternative hands any sore loser a veto — but the
        disagreement is now visible to the organizer instead of surfacing at the awards
        ceremony. Previously either player could type in any result and the other had no
        recourse inside the platform at all.
-   [x] **A round clock that cannot deadlock the event** (migration 49): the deadline is
        stored (so an extension is one edit everyone sees, not a number each client derives),
        and "time in the round" decides every open match on its current game score — leader
        takes it, level is a draw, bracket matches go back to the organizer because somebody
        has to advance. Before this the timer was decorative while pairing refused to run
        with a result missing, so one player closing their laptop stopped the event.
-   [x] **Bounded pairing search**: the rematch-avoiding backtracking now carries an explicit
        work budget and degrades to allowing (and reporting) rematches rather than running
        unboundedly inside the lobby process.
-   [x] **The deck lock is actually enforced at the table** — the event's registered deck is
        pinned to the seat, re-checked wherever a tournament game can start, and a "between
        rounds" window that means something (**N17**).
-   [x] **Asynchronous events** (migration 55): round deadlines in days, player-to-player
        scheduling with several offered slots across time zones (migration 65), reminders before
        the thing happens rather than only after (migration 57), and an overdue-round sweep.
-   [x] **Prize pools and an entry-fee register** (migrations 59, 64). The platform records what
        the organizer announced and who has paid; it takes, holds and moves no money.
-   [x] **Judge deck release** (migration 56), event editing after creation, latecomer admission,
        desk-side check-in, and judge tools that work on an already-decided match (**N17**).
-   [x] **Organizer CSV exports** of standings, pairings and the entry list (**N12**).
-   [x] **A create form that describes the event it is about to build**, and names the settings
        that will not do anything for the format chosen (**N17**).
-   [x] **A whole event, every format, run against real PostgreSQL** in CI (**N17**).

## Phase 8 — Modern UI

-   [x] Chess.com-style navigation: fixed left sidebar (Play/Learn/Watch/Community/Other
        with flyout submenus, Sign Up/Log In at bottom) on all non-game screens; in-game
        keeps the slim top bar so the board keeps full width.
-   [x] Home page rebuilt as a landing hero (news → Community > News; lobby chat and
        promo banners removed; admin MOTD/banner notices retained).
-   [x] Placeholder pages routed for Learn and the Community subpages so navigation is
        complete ahead of the features; Stats, Tournaments, Play IRL, Watch, Learn, Teams,
        Clubs, Members, Membership and the Archon+ pages have since shipped. Five placeholders
        remain: `/mobile/ios` and `/mobile/android` (**N14**), and Articles / Blogs / Forums,
        which nothing currently plans to build and which the navigation settings can hide.
-   [x] Design tokens: light/dark palettes, brand amber, typography, table/chat/nav tokens
        (`client/styles/tailwind.css`). The token _mechanism_ is done and is the leverage point
        for the redesign; what was never designed is the visual language sitting on it.
-   [ ] **Total visual redesign** — a considered palette, type scale, spacing rhythm, elevation
        and motion model, aimed at looking like something worth trusting with a rating and a
        subscription → **N16**. Sequence before the component library below.
-   [ ] UI audit of the client (component inventory, duplication, modernization order) → **N6**.
-   [ ] Documented component library on top of the tokens → **N6**.
-   [ ] Incremental page-by-page modernization (decks → profile → game UI last, since game
        UI carries the most gameplay risk) → **N6**.
-   [ ] Responsive layouts (desktop-first, tablet functional, mobile readable) → **N6**.
-   [ ] Accessibility pass (keyboard nav, contrast, screen-reader landmarks) → **N6**.
-   [x] Replace the `/learn` placeholder — a 93-step Learn-to-Play walkthrough now plays the
        starter-set demo game there, on a board styled like the real one (**N11**). The tutorial
        that teaches inside a _real_ game, and the wider Learn hub, are still open →
        **N11**/**F6**.
-   [x] Name the card and ability responsible in every prompt ("…because of Gateway to Dis"),
        and attribute passive effects on card zoom, on both clients → **N15**.

## Phase 9 — Player identity & community

-   [x] **Clubs v1** (local scenes/stores): create/join/leave, club pages with member
        lists, owner remove/disband (server/services/community/ClubService).
-   [x] **Club invite codes**: every club gets a shareable 8-char join code (owner-visible
        with copy button); join-by-code endpoint used by the club page and onboarding.
-   [x] **First-run onboarding wizard** (`/welcome`, docs/design/onboarding.md): new
        accounts are walked through location, club join (code or search), deck import,
        profile picture, and a first-game step — all skippable; completion stamped in
        Users.OnboardedAt (existing users backfilled as onboarded).
-   [x] **Member directory**: public searchable member list (username/country filters,
        rating-sorted, privacy-safe fields only) with joined-24h/total/online stats.
-   [x] **Play IRL + local stores** (`/play-irl`, docs/design/rankings-amber-and-irl.md):
        in-person play hub with a community-contributed local game store / venue directory
        (searchable by name/city + country; adder or admin can remove; Stores schema 38 /
        migration 31) and shortcuts to in-person tournaments and clubs.
-   [x] **Friends v1**: requests by username, accept/decline/cancel/remove, mutual-request
        auto-accept, online presence dots (server/services/community/FriendService).
-   [x] **Rich public player profiles**: avatar, bio, location, ratings, badges, favourite decks,
        match history summary → **I3**.
-   [x] **Club leaderboards, approval-based joins, ownership transfer** (migration 44).
-   [x] **Teams** (competitive): rosters distinct from clubs, team events, and a team ladder
        earned as a unit rather than averaged from members' Amber.
-   [x] **Moderation tools**: reports with captured evidence, graduated actions with reason
        and expiry, a chat content filter, and a full audit log **(admin-config policies)** —
        migration 48.
-   [x] **Named club invitations**: an owner invites a player by name from their friends list or
        by typing one; the invitee gets a notification and an Accept/Decline (**N7**).
-   [x] **Profile customisation** — accent colour, banner, avatar frame, title, name effect and a
        longer bio, gated per option by membership tier (**N12**).
-   [ ] Friend activity feed, DMs (moderated), block-list integration. **Unowned:** no current
        backlog item covers these; N5 built the moderation the DM feature would have needed, but
        not the feature. Sequence behind **N16**/**N6** if it is picked up.
-   [ ] Store follow-ups: map view, store-hosted event listings, verified/official badges.
        **Unowned** — N7 shipped clubs and teams and did not reach these.
-   [ ] Onboarding asks each new account how well they know KeyForge, and (if they do) how well
        they know the platform, then teaches only what is missing → **N11**. Still the open half
        of that item: the walkthrough exists, the branching does not.
-   [x] **Track in-person games**: both players report independently, agreeing reports commit
        into a real game, decks optional (migration 47). Rating them is admin-config and now
        **on** by default (migration 66); a game with no decks attached is still recorded
        unrated, because the Elo engine needs both decks' SAS.

## Phase 10 — Match history, replays & spectating

-   [x] **Replay capture v1**: the structured play-by-play is recorded at game end and stored
        per game (GameReplays, migration 38; `Game.getReplay()` reads the chat log only, no
        gameplay coupling); oversized captures are skipped.
-   [x] Replay viewer v1 (`/replay/:gameId`): step/scrub through the recorded log, reusing the
        in-game Messages renderer.
-   [x] Match history page (`/matches`), ported from the legacy MongoDB aggregation to
        PostgreSQL.
-   [x] Spectating from the lobby game list, with spectator lists and mute-spectators support
        inherited from the engine.
-   [x] **Board-state snapshots + board replay viewer** — the recording now carries the board
        at each log position, rendered beside the play-by-play, and is spectator-safe by
        construction (**N1**).
-   [x] **Watch hub** (`/watch`): live spectatable games (**N1**).
-   [x] **Storage-budgeted retention** **(admin-config)**: size cap, retention window and purge
        cadence in Site Settings > Replays, enforced by an hourly lobby sweep (**N1**).
-   [x] **Featured match, spectator counts, optional broadcast delay** — the delay is enforced
        in the game node on spectators only, so the players always see the live position (**N1**).
-   [x] **Share links for replays** (public, no auth, revocable, per-replay token) (**N1**).
-   [x] **Match history filters** by deck, opponent, format and result, applied in SQL before
        the row limit (**N1**).
-   [x] **Replays were being recorded and then thrown away.** A board frame carried full card
        summaries — around 1.1 KB per card, most of it a ten-language locale block and
        interaction state a recording can never use — so a mid-game frame came to 27 KB and a
        capped recording to 16 MB, eight times `replay.maxCaptureKb`. Every normal-length
        game's replay was refused at the point of storage, leaving one warn line in the node's
        log and a site where no replay ever loaded. Frames now reference a card table written
        once per recording (~1.1 KB per frame, ~0.5 MB for a whole game). `deploy/healthcheck.sh`
        already FAILed on "0 replays for N finished games"; this is what it was reporting.
-   [x] **Capture is driven by the engine, not by the socket layer** — `Game.continue()`
        records, rather than only `GameServer.sendGameState`, so anything that advances a game
        records one and the capture is testable end to end. The winning position is captured
        explicitly in `recordWinner`: without it a replay ended on the board as it stood
        _before_ the deciding key was forged.
-   [x] **A long game is thinned, not truncated** — at the frame cap the recording is halved
        and capture continues, instead of stopping dead and leaving the half of the game that
        decided it with no board at all.
-   [x] **Replay viewer fixes**: forged keys rendered as `[object Object]` (the engine's key
        map printed straight into the text), board cards collapsed to slivers (`CardImage`
        renders `h-full w-full` into a box with no size), and the board shown before the first
        recorded frame was one from later in the game.
-   [x] **Turn navigation, playback and card zoom** in the viewer: one jump button per turn
        labelled with the house that was called, play/pause with speed, arrow-key stepping.
-   [x] **Replay Intelligence on the phone** — the aggregate half is on the Expo app's
        Intelligence screen, where a list of houses with one number each reads better than it
        does on the web: the five-column row folds to a bar, a percentage and a sub-line, with
        the house icons the app already has. It loads outside the screen's `load()` because it
        is the one panel the set filter cannot narrow, and re-parsing 25 stored recordings on
        every tap of a set chip is a phone's latency and data allowance spent on an answer that
        never changes. The per-game turn-by-turn analysis is deliberately NOT there: the app
        has no replay viewer to hang it on, and a six-column turn table is the wrong thing at
        390 points wide.
-   [x] **Replay analysis** (**N12**, Archon tier `advanced_replays`): every turn with the
        house called on it, amber per turn, the key race, and the point after which the winner
        was never headed. Read from recorded board state only — never parsed out of the
        localised message log — and surfaced both on a game's replay and, aggregated over a
        player's last 25 recordings, as Replay Intelligence on Archon Intelligence. It answers
        the one question no other table on the site can: which house you actually call, and how
        you do when you call it.
-   [ ] Two bots playing each other continuously, watchable by anyone — permanent content for the
        Watch hub and a continuous engine soak test → **F9**.

## Phase 11 — Statistics & analytics

-   [x] **Statistics Engine** service (`StatisticsService`): on-demand, TTL-cached
        aggregation over persisted games (never in the game path).
-   [x] Player stats: win rates by house & format, key rates, average game length.
-   [x] Meta dashboards: house win rates, SAS bands vs. win %, format popularity.
-   [x] Public API for stats (`/api/stats/*`), cached.
-   [x] **Set win rates and the house matchup matrix** on the meta dashboard; matchups under
        twenty games report a game count but no win rate (**N3**).
-   [x] Deck stats: per-deck W/L, SAS vs. performance deltas, per-opposing-house matchups and
        best/worst deck callouts (**N3**).
-   [x] **Admin analytics**: DAU/MAU, games/day, queue health, funnel metrics, and the
        moderation queue's own health (`/admin/analytics`) — **N8**.
-   [x] **Premium statistics are gated in one place** (`statsGating.js`): the same cached
        aggregate is filtered per caller, so a paid column can never be served to a free account
        and the filtering can never mutate the shared cache — asserted by test (**N12**).
-   [x] **Set-aware analysis** across the intelligence surfaces: a result from a rotated-out set
        answers a different question, so the set filter is the first filter rather than a
        refinement (**N12**).
-   [ ] Rate limiting + versioning for the public stats API → **F1**.

## Phase 12 — Platform APIs

-   [ ] Versioned public REST API (`/api/v1`) → **F1**.
-   [ ] API keys + OAuth scopes for third-party apps **(admin-config rate limits)** → **F1**.
-   [ ] Webhooks: tournament events, match completion → **F1**.
-   [ ] OpenAPI spec, generated docs page → **F1**.

## Phase 13 — Coaching & AI analysis

-   [ ] Coaching profiles/marketplace: coaches list availability, students book sessions → **F3**.
-   [ ] Shared replay review rooms (coach + student stepping through a replay together) → **F3**.
-   [ ] AI game analysis: blunder detection, alternative-line suggestions, win-probability
        graph per turn (model over the replay event stream) → **F3**.
-   [ ] AI deck insights: strengths/weaknesses vs. meta, SAS-context commentary → **F3**.
-   [x] An AI player able to drive the engine — shipped first as the Champion’s Challenge'
        sparring partner (**N18**, `server/services/championschallenge/SimulatedGame.js`).
-   [ ] The same player as the bot showcase and a practice opponent (**F9**), then as the
        model behind analysis (**F3**).

## Phase 14 — Mobile support

-   [x] **Expo iOS app** (`mobile/`): sign in/register against the lobby (JWT + refresh,
        tokens in the iOS keychain), live game list, create/join/watch games, deck library
        with house icons + SAS and Master Vault import, pending game, and the full game board
        (HUDs, battlelines, prompts, card menus, pile viewers, log/chat, spectator mode,
        reconnect, concede/leave, manual mode). Protocol-identical to the web client.
-   [x] EAS build config + TestFlight runbook (`mobile/TESTFLIGHT.md`); keep-awake during play;
        mobile network resilience (timeouts, reconnect).
-   [x] **Push notifications on the device** — Expo push, with the notification taxonomy deciding
        what is allowed to interrupt (**N2**, migration 61).
-   [x] **Tournaments in the app**: browse, create, register, report, and the event detail screen.
-   [x] **Archon+ in the app**: membership status, Archon Intelligence, the Tournament Lab, the
        set filter, Replay Intelligence, and Patreon linking — with every money surface stripped
        out of the iOS build rather than merely hidden (**N23**).
-   [x] **Board completeness**: prophecies, a pile viewer that cannot lock up, hiding your own
        hand on the opponent's turn, every offered game mode, and passive-effect attribution on
        card zoom (**N15**).
-   [x] Account deletion and the safety controls App Store review asks for (**N23**).
-   [ ] Mobile-responsive web as the baseline → **N6**.
-   [ ] PWA: installable, **browser** push for round pairings/turn timers → **N6**. Native push
        is done; this is the web half.
-   [x] Show each move as it happens in the Expo app, rather than only inside the slide-up log
        sheet → **N15**.
-   [ ] Turn the `/mobile/android` placeholder into a real link to the beta build, and
        `/mobile/ios` into a TestFlight invite request → **N14**.
-   [ ] App Store release, Android build, and the rest of platform feature parity (community,
        profiles, replay viewer) → **F7**.

## Phase 15 — Streaming & content tools

-   [ ] Overlay endpoints for OBS (current game state, player names, ratings, key count) → **F4**.
-   [ ] Featured-match page for events; caster mode (both hands visible, delay enforced) → **F4**.
-   [ ] Clip/share moments from replays → **F4**.

## Phase 16 — Discord integration

-   [ ] Discord OAuth account linking → **F2**.
-   [ ] Bot: tournament announcements, round pairings pings, result reporting commands → **F2**.
-   [ ] Webhooks to club/team Discord servers **(admin-config per club)** → **F2**.
-   [ ] Rich presence ("Playing on Archon Arena") → **F2**.

## Phase 17 — Organized play program

-   [ ] Sanctioned event tooling: TO certification levels, event sanctioning workflow → **F5**.
-   [ ] OP points/season circuit distinct from Elo **(admin-config point tables)** → **F5**.
-   [ ] Regional/national/world championship series structures → **F5**.
-   [ ] Prize/invite tracking, top-N qualification reports → **F5**.

## Phase 18 — Matchmaking & the competitive play loop

The loop a competitive player repeats: queue → play → see the result → play again. Added as
its own phase because it cuts across the lobby, rating engine, and UI, and because it is what
turns a feature-complete site into a habit.

-   [x] **Quick Match** matchmaking (`server/services/matchmaking/MatchmakingService.js`):
        in-memory queue pairing on Amber proximity with tolerance that widens with wait time,
        FIFO fairness, format-scoped, `canPair` guard for block-lists and in-game players.
        The service holds no sockets and no clock, so pairing is deterministic and unit-tested.
-   [x] Quick Match UI with live queue sizes and a searching state; first-game step in
        onboarding hands new players into the queue.
-   [x] Game types removed — every game is the same; rating pools follow format instead.
-   [x] Offered formats narrowed to Normal (headline), Sealed, Adaptive and Alliance across
        New Game, the lobby filters, Quick Match, the tournament create form and the mobile
        app. Unchained and Reversal are hidden from the UI — the engine and the stored games
        still support them, they are simply not offerable. Re-list them by restoring their
        entries in `GameFormats.jsx`, `GameLobby.jsx`, `QuickMatchPanel.jsx`,
        `pages/Tournaments.jsx` and `mobile/app/new-game.tsx`.
-   [x] Post-game result screen with the Amber change, the pool, the key margin and the SAS gap
        that shaped it — read back from `RatingHistory`, never recomputed (**I4**).
-   [x] **Games are rated by default, everywhere** (migration 66). Counting towards the ladder is
        the normal case, and two of the three ways to play defaulted to the opposite: a
        tournament created without ticking the box produced games that never reached the ladder —
        failing quietly, and only discoverable after the event, when it could no longer be
        fixed — and in-person games were off site-wide. Online games needed nothing; they have no
        rated flag and have always been rated when the result is a decided two-player game. Only
        an _absent_ value takes the default, so an organizer's explicit "unrated" is still kept.
-   [x] **The rematch button no longer deletes the game.** Both handlers broadcast `removegame`
        and dropped the table as their first two statements, then went looking for six things
        that could each fail — every one of them after the point of no return, leaving two
        players holding nothing. The invariant now asserted is that however a rematch fails, the
        players are never left with no game.
-   [ ] Matchmaking parameters **(admin-config)**: base tolerance, widening rate, max wait. Still
        the second **(admin-config)** promise in this document with no registry section behind
        it (the other is SSO-only mode, Phase 3).
-   [x] **Queue health telemetry** (depth, wait time) — recorded as it happens, since the
        queue is in-memory and leaves no trace afterwards (migration 45).
-   [ ] Rematch, view-replay and back-to-lobby actions alongside the result panel itself → **I4**.
        The engine's own rematch prompt sits below it and works; these are the deliberate
        follow-ons.

## Phase 19 — Sustainability & supporter program

Running the platform costs money — a host, the DoK API tier, the domain, eventually object
storage for backups and replays. This phase is about paying for that without ever selling a
competitive advantage.

-   [x] Patreon OAuth linking, pledge-status refresh, and a supporter role inherited from TCO
        (`PatreonService`, `/patreon`, `/api/account/linkPatreon`).
-   [x] **Patreon link flow made real** — credentials moved to config (`patreon.*`, env
        `PATREON_*`), the `identity.memberships` scope added (without it no account could ever
        reach `pledged`), memberships scoped to our campaign, OAuth `state` added, and the
        Integrations tab surfaced. Dormant until the owner sets credentials; see
        [docs/design/patreon.md](docs/design/patreon.md).
-   [x] **Archon+ built end to end** (**N12**): four tiers backed by a capability system, a
        pricing page, per-tier checkout links, badges, cosmetics, a preview programme, and the
        analytics products the paid tiers are sold on — Archon Intelligence, the Tournament Lab,
        AERC analysis, replay analysis and the Champion’s Challenge. Every capability is enforced
        server-side, and a tier that would deliver nothing over the one below it cannot be sold.
-   [x] **Perks stay clear of competitive fairness**, asserted by the persona specs rather than
        promised in prose: no capability touches Amber, matchmaking, tournament eligibility or
        any other competitive outcome.
-   [x] **The apps sell nothing on iOS** — prices and checkout links are stripped out of the
        payload rather than merely hidden (**N23**).
-   [ ] **Owner: a live campaign.** Credentials, tiers and reward ids, then link one real account
        to prove the round trip. Nothing above has run against a real pledge → **N12**.
-   [ ] Publish running costs and what supporters cover, so the ask is concrete — the missing
        "Support Archon Arena" page → **N12**.
-   [ ] Revisit only if Patreon proves insufficient: one-off donations, or store/organizer
        sponsorship of events. Never anything that touches Amber, matchmaking, or eligibility.

---

## Cross-cutting: Site administration _(build alongside every phase)_

-   [x] **Settings service**: typed registry, DB-backed (SiteSettings), in-memory
        snapshot with periodic refresh, who/when audit, defaults in code
        (docs/design/settings-service.md).
-   [x] Admin settings UI at /admin/settings (isAdmin). Sixteen sections: rating (Elo knobs,
        ARI, decay, seasons, leaderboard threshold), DoK (including the background SAS sweep), the
        Master Vault catalog crawl, the deck-import worker, the Champion's Challenge, the practice
        bots, tournaments,
        replays (recording, size cap, retention, purge cadence, sharing), watch (spectator
        counts, broadcast delay, featured game), regions, site content, navigation page
        visibility, team rating, in-person games, moderation policy, and feature flags.
-   [x] Admin tooling: user admin (roles, disable, delete, password reset), per-player rating
        set/reset, season operations, ban list, nodes, MOTD, news, bug reports, membership
        grants, the moderation queue, and the analytics dashboard.
-   [x] `sectionDefaults()` / `getSectionWithDefaults()`: a registry-only section's code
        defaults are built from the same field descriptors the admin UI renders, so a service
        reading a setting cannot drift from what the admin panel says the default is.
-   [x] Moderation policy thresholds wired through the registry (**N5**).
-   [ ] Wire the last two **(admin-config)** promises through the registry: auth SSO-only mode
        (Phase 3) and matchmaking parameters (Phase 18). Membership perk-to-tier mapping is a
        third, deliberately deferred — it lives in `tiers.js` (**N12**).
-   [x] **Redis pub/sub snapshot invalidation** for multi-lobby deployments. An accelerator
        over the interval refresh, never a dependency on it.
-   [x] **Full audit-log table** (`ModerationAuditLog`, migration 48). Settings changes append
        to it alongside every moderator action, so "who changed this, when, and to what" has an
        answer that the next edit cannot overwrite.
-   [x] **Feature flags** section for gradual rollout; every flag defaults to current behaviour.
        Five today: teams, in-person games, club leaderboards, Adaptive Bo3, hybrid events.
-   [x] Admin panel coverage for moderation (`/admin/moderation`) and analytics
        (`/admin/analytics`) — **N5**/**N8**. Tournaments stay reachable from the event list
        rather than duplicated into the admin panel, deliberately.
-   [x] **Reset all statistics** (isAdmin, `AdminResetService`): site-wide reset scoped by
        category — ratings, replays, game records, seasons — rather than one opaque button.
        Every call is a dry run unless explicitly confirmed, so the caller can always show
        what is about to be destroyed; the real run is one transaction, clears the statistics
        cache, and logs loudly and attributably. Accounts, decks, clubs, stores and
        tournaments are never touched, asserted by test.

## Cross-cutting: Quality & operations

-   [x] **Game-connection resilience** (`docs/design/game-leave-resilience.md`): a
        post-connect reconnection blip no longer reports a failed handoff (which
        marked a live setup-phase game finished and froze the board); reconnection
        given ~2 min to recover; "Leave Game" now also leaves over the lobby
        socket so a stranded player can always escape and the lobby tears the game
        down on the node instead of leaving a ghost.
-   [x] **Game-state sync** (`docs/design/game-state-sync.md`): the node now says on
        the wire whether a `gamestate` is a whole board or a delta, instead of leaving
        clients to infer it — an inference that broke whenever the node reset its diff
        baseline while a client's socket stayed up (a second tab, or the phone app and
        the web app signed in together), and that failed by hanging the browser tab
        outright, since jsondiffpatch loops forever when handed a board as a delta. The
        lobby's per-reconnect handoff no longer rebuilds a live game socket (which used
        to swap the board out for the pending-game screen with no way back but a
        refresh); a socket the node supersedes is closed rather than silently starved;
        and both clients can ask for a fresh board over the live connection (`resync`)
        instead of dropping it, so the mobile app no longer falls back to
        "Connecting to the game…" on every blip and every return from the background.
-   [x] Gameplay regression suite kept green on every PR (the full card suite runs in CI).
-   [x] **Game randomness comes from `crypto`, not `Math.random`.** Shuffles and the coin flip
        decided who went first and what everyone drew, out of a PRNG whose state is recoverable
        from a short run of its own output. On a rated ladder that is a fairness property, not a
        cryptography preference.
-   [x] **Closing the site counts as a loss.** An abandoned game used to sit unresolved, which
        made walking away strictly cheaper than playing on — the one outcome a ladder must not
        price that way.
-   [x] **Who went first is recorded** (migration 63). The engine has always known it —
        `FirstPlayerSelection` sets `game.firstPlayer` during setup — but `getSaveState()` never
        carried it and there was no column, so "do I win more going first?", one of the few
        genuinely actionable things a KeyForge player can learn, was thrown away at the end of
        every game ever played here.
-   [x] **A player can hide their own hand while the opponent takes their turn** (migration 58)
        — a stored option rather than a browser toggle, because that is where a player looks for
        it and because it should follow them to the phone.
-   [x] **In-app bug reports** (BugReportService, migration 34) with an admin triage page —
        the beta feedback channel.
-   [x] Data migration/versioning discipline: ledger + runner, one numbered migration per
        schema change → **I2**.
-   [x] Security: dependency audit, auth rate limiting, OWASP pass before launch → **I5**.
-   [x] **Image-diff harness over the archon maker** (`npm run test:images`). The deck
        list, the card back and every card image are drawn by Fabric in
        `client/archonMaker.js`, and nothing in the suite looked at the result — a
        library upgrade, a font change or a token change could move text a pixel or drop
        a shadow with every test still green. Nine reference images render in a real
        browser against the Vite dev server (not `dist/`, which would baseline the
        previous release) and are compared byte for byte; a size change is a hard
        failure. Built before the Fabric upgrade and proved to fail first: a one-pixel
        shift injected into the deck-list card title moved 5.1% of that image and left
        the other seven at 0.0000%. The Chromium binary is pinned and recorded with the
        baselines, because the headless shell and full Chromium do not rasterise text
        identically and the difference reads exactly like a regression.
-   [ ] Load testing for game nodes + matchmaking before public launch → **N10**.
-   [ ] **Q1 — Know when the live site breaks.** Inherited from I1 when launch closed. The
        site has real players and no error reporting and no uptime monitoring: a 5xx at 2am is
        invisible to everyone except the player who hit it, and TLS or a container dying is
        found by someone complaining. Both are owner actions, both are minutes:
    -   Set `SENTRY_DSN` in `.env.production`. Client and server are already wired
        (`server/server.js`, `server/gamenode/gameserver.js`, and the CSP allows the ingest
        origin) - only the DSN is missing.
    -   Point an external uptime monitor at `https://archonarena.com/`; alert on 5xx and on
        certificate expiry. It has to be external: a monitor on the box cannot tell you the
        box is gone.
    -   Run `deploy/healthcheck.sh` on the host until it is all-PASS. Its exit code is the
        number of failures, so it drops into cron or uptime tooling as-is.
-   [x] Upstream sync process: `npm run sync:upstream` plus a weekly workflow that applies
        keyteki's gameplay changes, runs the full gate, and opens a PR only when it is green —
        an issue when it is not. Never auto-merges (`docs/UPSTREAM.md`).

## Known defects & housekeeping

Small, real, and worth clearing while touching the surrounding code. None is urgent on its own.

-   [x] **Duplicate schema ordinals** — renumbered to 40-44, preserving the exact
        alphabetical execution order the initdb mount depends on.
-   [x] **Dead legacy router** — `client/routes.jsx` and `client/routes.js` deleted;
        `client/AppRoutes.jsx` was and is the live router.
-   [x] **Dead MongoDB code** — `server/stats.js` and `server/scripts/addsealed.js` deleted
        (both superseded: `StatisticsService` and `importstandalonedecks.js`), and the `monk`
        dependency plus the `mongod` npm script removed. No MongoDB remains anywhere.
-   [x] **Third-party font loading** — Noto Sans and Orbitron self-hosted in
        `client/assets/fonts/` (~210 KB: Noto Sans is a variable font, so one file per subset
        covers 400/500/600). OFL licences bundled. Two origins dropped from the CSP.
-   [x] **`helmet` upgraded v3 → v8** in **I5** (this entry was stale — the checkbox was never
        ticked when the upgrade landed; `package.json` has carried `^8.3.0` since).
-   [x] **Silent replay drop** — the 2 MB skip is now the admin-configurable
        `replay.maxCaptureKb`, and `saveReplay` returns which of "stored", "too large",
        "recording disabled" or "no replay" happened. A skip used to read from the outside
        exactly like a game that was never recorded (**N1**).
-   [x] **"Rematch: Swap Decks" read as the wrong thing** — now "Rematch: Trade Decks" and
        "Rematch: Pick New Decks", so the difference is stated rather than implied.
        `GameWonPrompt.spec.js` updated; no locale entries existed for these labels.
-   [x] **`docs/DEVELOPMENT.md`** — the Archon Arena developer guide: prime directive,
        layout, the schema-vs-migrations split, service and settings conventions, the
        verification loop, and which features need third-party provisioning. Complements
        `local-development.md` rather than repeating it.
-   [x] **Email verification never happened** — sign-ups got no confirmation mail and could
        play immediately. `lobby.requireActivation` was `false`, which skipped the email _and_
        wrote `Verified = true`; it is now on by default, overridable with
        `REQUIRE_ACTIVATION=false` for an instance with no mail. Turning it on exposed four
        further breakages, none of which had ever run against PostgreSQL: the expiry was
        stored as the string `'YYYYMMDD-HH:mm:ss'` into a `timestamp` column (PG rejects it,
        so registration threw); the activate endpoint validated the id against a MongoDB
        ObjectId regex; the expiry check compared a string to a moment with `<`, giving NaN,
        so no link ever expired; and `activateUser` updated a column named
        `"ActivationExpiry"`, which does not exist. Minting, expiry and verification now share
        `server/services/activationToken.js` so the three cannot disagree about the format
        again, and the token compare is constant-time. A registration whose email cannot be
        sent is rolled back rather than left as an unusable account holding a username, a new
        rate-limited `POST /api/account/resend-activation` re-issues a link without leaking
        whether the account exists, and the boot check warns when verification is on but no
        sender is configured. Register no longer claims "you can now proceed to login" when
        login will refuse them. Verified end to end against a real PostgreSQL 16 — register →
        mail → activate → login, with negative controls for tampered, expired, replayed and
        cross-account links.

-   [x] **"My Decks" sorted one page, not the collection** — the deck list is paged by the
        server, and the table re-sorted whichever fifteen rows it had been handed, so "highest
        SAS" meant "highest SAS on this page" and looked identical to the real answer. Three
        things caused it and all three are fixed: the ordering decision moved out of
        `ReactTable`'s render into `tableRows.visibleRows`, where remote mode returns the
        server's page in the server's order; ARI gained a SQL form (`EFFECTIVE_ARI_SQL`, the
        twin of `effectiveAri`, seed included) so the database can order by the number the
        column actually shows; and a sort column the query cannot express now logs instead of
        silently becoming `LastUpdated`. Every ordering also ends `, "Id" ASC` — SAS, ARI, set
        and win rate all repeat freely, and ties left unordered let a deck appear on two pages
        while another appeared on none. The card-back column no longer offers a sort it never
        had.

### Open, and currently true

-   [ ] **A game result published while the lobby is restarting is dropped with no retry.** The
        game is never recorded, rated or replayed, and nothing tells either player. A fix landed
        with the zero-downtime work and went back out with the revert, so this is live again.
        → **N10**.
-   [ ] **The admin Restart button is inert.** `NodesAdmin` shells out to `pm2 restart`, and pm2
        is not installed anywhere in this stack — the one control an operator reaches for during
        an incident does nothing and reports nothing. → **N10**.
-   [ ] **The per-node game cap is never enforced.** The node reads `config.maxGames` while the
        config file documents `gameNode.maxGames`, and `numGames >= undefined` is false for every
        number. It is unset today either way, so the effect is that a node has no ceiling rather
        than the wrong one. → **N10**.
-   [ ] **`adaptiveBid` / `adaptivePass` have no timeout or force-resolve.** Game three of an
        Adaptive Bo3 waits for the bid, so a pair who neither bid nor pass leave the round
        waiting on them. The organizer can still award or take a paper result, which is why this
        is a defect and not a blocker. → **N9**.
-   [ ] **`docs/README.md` and `AGENTS.md` still say "Keyteki".** Both describe the project by
        its pre-fork name and neither lists the platform documentation (`DEVELOPMENT.md`,
        `DEPLOYMENT.md`, `SECURITY.md`, `UPSTREAM.md`, `docs/design/`) that has been written
        since. Engine-facing docs, so nothing is wrong in them — they are just addressed to a
        project this is no longer only a fork of.
