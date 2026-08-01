# Archon Arena — Product & Engineering Roadmap

> **Vision:** A next-generation competitive KeyForge platform — think Chess.com for KeyForge —
> built on the proven gameplay engine of The Crucible Online (keyteki), extended with modern
> ratings, tournaments, rankings, analytics, and community features.
>
> **Prime directive:** Gameplay stays 100% compatible with TCO and always remains stable.
> New systems are built _around_ the gameplay engine as loosely-coupled services, never by
> rewriting working gameplay.

**Last full codebase audit:** 2026-07-25.

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

## Where the platform stands (2026-07-29)

**The engineering is far ahead of the operations.** Almost every headline system in this
roadmap — ratings, tournaments, community, matchmaking, statistics, replays, notifications,
a native iOS app — is built, tested, and wired end to end. The retention loop closed with
**N1/N2/N3**: a game can be replayed board-by-board and shared with a public link, players
are told when their round is paired, and the deck intelligence that differentiates the
platform is on the screens where the decisions get made.

**What is missing is the last mile, and it is almost all operational.** The site is not yet
serving players at archonarena.com (**I1**) and there are no off-host backups (**I7**) —
both gated on owner infrastructure actions rather than code. The largest genuinely unbuilt
systems are moderation (**N5**) and the tutorial (**N11**).

**Built and working**

| Area               | State                                                                                                                                                                                                                                 |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Gameplay engine    | keyteki fork, 14 sets, 38,221-test baseline, green in CI                                                                                                                                                                              |
| Brand & navigation | Full rebrand, chess.com-style sidebar, landing hero, token-based light/dark theme                                                                                                                                                     |
| Auth               | Local + Keybringer OIDC (PKCE, JWKS, auto-link, link/unlink UI)                                                                                                                                                                       |
| Decks              | Master Vault import, DoK SAS enrichment, rate-limited outbound calls, bulk collection import                                                                                                                                          |
| Ratings ("Amber")  | SAS-adjusted Elo, FIDE-style K tiers, provisional K, floors, decay, seasons, admin tools, pools (Archon/Sealed/Alliance)                                                                                                              |
| Rankings           | Leaderboards (world/region/country/state), Top Players, personal Ratings page, W–L records                                                                                                                                            |
| Tournaments        | Swiss / single-elim / double-elim / round robin / cut-to-top-N, Bo1/3/5, waitlists, check-in, staff, seeding, penalties, brackets, printables, online automation, KeyForge conditions (deck rules, chains, Triad, Reversal, Adaptive) |
| Matchmaking        | Quick Match queue with Amber-proximity pairing and widening tolerance                                                                                                                                                                 |
| Notifications      | Typed taxonomy, in-app centre (bell + unread), branded email, per-category opt-out; pairing / event-start / friend / club triggers                                                                                                    |
| Community          | Friends, member directory, clubs + invite codes, local store directory, Play IRL hub, onboarding wizard                                                                                                                               |
| Statistics         | Meta dashboard (house/set win rates, SAS bands, format share, house matchup matrix) + per-player and per-deck breakdowns, TTL-cached                                                                                                  |
| Match history      | Filterable Game History on PostgreSQL; board-state replays with forge jumps, per-player perspective and public share links; Watch hub                                                                                                 |
| Admin              | Settings service + `/admin/settings` (rating, DoK, tournament, replay retention, watch/broadcast delay, regions, content, navigation), user/ratings/banlist/nodes/motd/news/bug-report admin                                          |
| Mobile             | Expo iOS app (`mobile/`): login, decks, lobby, pending, full board, spectate, reconnect; EAS + TestFlight runbook                                                                                                                     |
| Ops                | CI (typecheck/lint/build/test + CodeQL), prod compose + Caddy TLS, `deploy/healthcheck.sh`, Sentry wired client + server                                                                                                              |

**Incomplete — built but not finished**

-   **Caster mode** does not exist. Spectating, the Watch hub, spectator counts, a featured
    match and a server-enforced broadcast delay all do (**N1**); both hands visible to a
    caster is the remaining half, and it belongs with **F4** because it needs a privileged
    view rather than a delay.
-   **SAS on the lobby game list.** Deliberately skipped, not missed: decks are not chosen for
    open games, so there is nothing to show there yet. Everywhere else — deck lists, the deck
    view with its AERC breakdown, the pre-game screen, per-deck stats — is done (**N3**).
-   **Admin analytics.** The meta dashboard now covers set win rates and the house matchup
    matrix (**N3**), but there is still no operational/funnel analytics for admins (**N8**).
-   **Admin-config coverage** stops short of auth (SSO-only mode), matchmaking and moderation
    policy; replay retention and the Watch settings are now wired. There is still no
    feature-flag section and only a last-editor audit trail.
-   **Clubs** have no leaderboards, approval-based joins, or ownership transfer.
-   **Web push** is the one part of notifications not built; it waits on the PWA (**N6**).

**Missing entirely**

-   **Moderation tooling** beyond the inherited block list / ban list: no reports, mutes,
    timeouts, or moderation queue.
-   **Any way to learn the game on the platform.** No tutorial, and onboarding never asks how
    much a new account already knows — the `/learn` route is a placeholder.
-   **A funding path.** The inherited Patreon integration has no campaign, credentials, or perks.
-   **In-person game tracking.** Paper games can only be recorded through a tournament.
-   **A reason to visit an empty site.** Nothing to watch when nobody happens to be playing.
-   **Teams**, **versioned public API**, **Discord**, **coaching/AI**, **streaming tools**,
    **organized-play program**.

**Not yet verified in production:** DNS, live WebSocket pass-through, Keycloak client
registration, DoK API key, uptime monitoring, off-host backups.

---

## Prioritized backlog

### Immediate — make the platform real

_Goal: a live, safe, sticky site. Nothing below this line is worth much until players can
reach the platform and feel the competitive loop close._

#### I1 — Go live on archonarena.com and verify end to end

**Why:** every system in this document is speculative until real players are on it. This is
the single highest-value item on the roadmap.
**Tasks**

-   [x] Owner: VPS provisioned, Porkbun DNS pointed at it (docs/DEPLOYMENT.md §2), DoK API
        key obtained.
-   [~] **Keycloak client in the keybringer realm — deferred.** Registering it needs Ghost
    Galaxy's permission, which the platform does not have, so Keybringer SSO is out of
    scope until that changes. Nothing is blocked by it: `auth.oidc.enabled` is `false` by
    default, the login page asks `/api/account/oidc/status` before offering the button, and
    local registration is a complete signup path on its own. When permission does arrive
    this becomes config, not code.
-   Bring up `docker-compose.prod.yml` + Caddy; set `SENTRY_DSN`.
-   Verify WebSocket pass-through to the game node end to end on the live host.
-   Point an external uptime monitor at the site; alert on 5xx and on TLS expiry.
-   Run `deploy/healthcheck.sh` on the host until it is all-PASS.

**Depends on:** owner actions (remaining: bring-up and monitoring). Blocks: I7, and the public
announcement.
**Acceptance criteria**

-   Two players on two different networks complete a full game start-to-finish through
    `https://archonarena.com`, including a reconnect mid-game.
-   Local registration succeeds against the live host. (Keybringer SSO is deferred above; it is
    not a launch gate.)
-   A deck imports with SAS attached from the live DoK key.
-   `deploy/healthcheck.sh` reports zero FAILs; a deliberately triggered error appears in Sentry.
-   Uptime monitor green for 24 continuous hours.

#### I2 — Schema migration ledger and runner _(done)_

**Why:** production schema state is currently untracked. Migrations are applied file-by-file
by hand (docs/DEPLOYMENT.md §4), nothing records what ran, and the schema directory already
contains two duplicate ordinals (`40 - Seasons.sql` / `40 - TournamentMatchGames.sql`,
`41 - GameReplays.sql` / `41 - TournamentPlayerDecks.sql`). Every future feature ships a
migration; this is the highest-leverage operational fix on the list.
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
        applies, an edited migration is refused, and every exit code is correct for CI.

**Depends on:** nothing. Blocks: safe iteration on every schema-touching item below.
**Acceptance criteria**

-   A fresh database and a database at any historical point both converge to the same schema.
-   Running the migrator twice in a row is a no-op the second time.
-   Editing an already-applied migration file fails loudly instead of silently diverging.
-   `healthcheck.sh` FAILs when the running code needs a migration that has not been applied.

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
-   [x] Usernames link through from Leaderboards, Top Players (podium and table), the member
        directory, and opponent names in recent games.
-   [x] Remaining link sites done: lobby game list, pending game, tournament players /
        standings / "Your Match", game history, club member lists. Every username outside the
        game board now links to its profile.
-   [ ] Optional short bio, editable from the account page.

**Acceptance criteria**

-   [x] Every username rendered outside the game board navigates to that player's profile.
-   [x] Verified in a real browser: the page renders every panel for a player with games, and a
        brand-new player with no games or clubs still gets a working page.
-   [x] No private field appears in the payload, asserted by a test.
-   [ ] Server-side caching like the stats endpoints, once traffic justifies it.

#### I4 — Post-game result screen with Amber change _(done)_

**Why:** the rating engine is the heart of the platform and it is currently invisible at the
moment it matters most. Players finish a rated game with no feedback that anything happened.
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

#### I5 — Pre-launch security and abuse pass

**Why:** the moment the site is public it is a target, and account/auth endpoints are the
softest surface. When this item was written, rate limiting existed but was applied only to
bug reports, community actions, deck DoK prepare and tournament creation — not to login,
registration or password reset. Every auth endpoint is now limited, and the limits are
shared across lobby processes; what remains is the `fabric` upgrade.
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
-   [ ] **`fabric` v5 → v7** — now the **only** root left: every remaining critical and high
        in the production tree traces to it alone (13 advisories, down from 16). Scoped in
        detail during this pass:
    -   **What it buys:** fabric 7 declares no hard dependencies (`canvas`/`jsdom` become
        optional, and `canvas@3` drops `@mapbox/node-pre-gyp`), so the whole
        `canvas` → `node-pre-gyp` → `tar` chain — and the only critical in the tree — goes
        away. It keeps a CommonJS entry (`fabric/node`), so server callers need not become
        ESM.
    -   **Real size:** 98 call sites over 10 APIs in 7 files, ~1,600 lines.
    -   **Why it is still its own project:** the migration is mechanical, but the risk is
        _silent visual regression_. Text metrics and shadow rendering changed in fabric 6,
        and the archon maker generates the deck images players look at — a shifted baseline
        would ship subtly wrong deck lists with nothing failing. `buildDeckList`,
        `buildCard` and `buildCardBack` are cleanly exported, so a before/after image-diff
        harness is buildable; that harness is the actual first task, and it does not exist
        yet.
    -   Exposure meanwhile stays low: no SVG path exists (the fabric advisory is stored XSS
        via SVG export) and uploads are magic-byte-gated.
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
        reason. Down to a single documented root (`fabric`) from two.
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
-   [ ] **Owner action:** AWS SES setup — verified sender identity and production access —
        before any of this mail can actually be delivered.

> **This owner action is now a launch blocker, not a nicety.** Email verification is on by
> default (see _Known defects_), so registration depends on outbound mail: with no working
> sender, every sign-up is rolled back with "we could not send your confirmation email" and
> the site takes no new accounts at all. The server logs an error at boot when verification
> is on and `lobby.emailFromAddress` is unset. If SES is not ready when the site goes live,
> set `REQUIRE_ACTIVATION=false` deliberately rather than discovering it from a player —
> accepting that unverified addresses can play until it is turned back on.

**Depends on:** nothing. Blocks: I1's public announcement.
**Acceptance criteria**

-   `/terms` renders the built-in text and is overridable from the admin settings page.
-   Activation and reset emails render correctly in a major HTML client and degrade to
    readable plain text.

#### I7 — Off-host backups and a rehearsed restore

**Why:** docs/DEPLOYMENT.md §5 says it plainly — a backup on the same disk is not a backup.
Ratings, tournament history, and replays are unrecoverable if the VPS is lost.
**Tasks**

-   Nightly `pg_dump` shipped to object storage, encrypted, with retention.
-   Also back up uploaded avatars, custom backgrounds, and card art.
-   Monitor backup freshness; alert when the newest backup is older than 48h.
-   Rehearse a full restore into a scratch environment and write the timing into the runbook.

**Depends on:** I1.
**Acceptance criteria**

-   A restore from an off-host backup produces a working site with intact ratings, tournaments,
    and decks, and the runbook records how long it took.
-   A deliberately stale backup triggers the freshness alert.

### Near-term — the retention loop

_Goal: reasons to come back tomorrow. Sequenced after players exist, because each of these is
tuned by what live usage shows._

#### N1 — Full replays, share links, and the Watch hub _(done)_

**Why:** replays currently capture the message log only, and `/watch` is a placeholder.
Replays are also the substrate for coaching, AI analysis, and streaming tools later.
**Tasks**

-   [x] Board-state snapshots captured alongside the message stream, keyed to the log
        position so the viewer can show the board at any point in the play-by-play. Recorded
        at the state-broadcast layer, never inside gameplay resolution, wrapped so a recording
        failure cannot interrupt a live game. Recording format versioned (`version: 2`).
-   [x] Snapshots are compact and **spectator-safe by construction**: rendered through the
        same `AnonymousSpectator` path that protects live spectators, so a replay can never
        reveal more than watching would have. Asserted by test — neither hand's contents
        appear anywhere in a snapshot.
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

#### N2 — Notifications _(done, less web push)_

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
-   [ ] Web push once the PWA lands (**N6**).

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

**Why:** SAS is the platform's differentiator against a generic ladder, and it is currently
under-displayed — the SAS the platform already stores appears on one screen.
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
        `TournamentMatches.ResultSource`. An IRL or hybrid event takes paper results by
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

#### N10 — Staging, zero-downtime deploys, upstream sync

**Why:** with players on the site, "restart and hope" stops being acceptable, and upstream
keyteki card fixes need a routine path in.
**Tasks**

-   `staging.archonarena.com` deploying from main.
-   Deploy script: drain the game node (finish or migrate live games), deploy, restart, verify.
-   Scheduled upstream keyteki merge process (docs/UPSTREAM.md) with the card regression suite
    as the gate.
-   Load-test game nodes and matchmaking to find the per-node ceiling.

**Depends on:** I1, I2.
**Acceptance criteria**

-   A deploy during active play does not end anyone's game.
-   An upstream merge lands with the full card suite green and a recorded diff of gameplay changes.
-   The documented per-node concurrent-game ceiling is backed by a load test.

#### N11 — Guided tutorial and experience-based onboarding

**Why:** KeyForge is a complex game and Archon Arena is a complex platform. Today a brand-new
player lands in a lobby with no idea what to do, and `/learn` is a placeholder. Asking one
question at sign-up lets the platform teach exactly what each player is missing and skip what
they already know.
**Tasks**

-   Onboarding step: "How well do you know KeyForge?" (new to it / played before). Players who
    know the game get a follow-up: "How well do you know Archon Arena?"
-   **New to the game** → walk the rules inside a real game on the platform: houses, æmber,
    forging, reap/fight/use/action, keys and the end condition — then the platform basics.
-   **Knows the game, new to the platform** → skip the rules entirely; show importing decks,
    starting a game, Quick Match, what Amber is, and where tournaments live.
-   **Knows both** → straight through the existing wizard to a first game.
-   Build the Learn hub (`/learn`) on the same tutorial engine so any lesson can be replayed
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

#### N12 — Patreon supporter program

**Why:** hosting, the DoK API tier, and the domain cost money, and the platform has no funding
path. TCO's Patreon integration is inherited but dormant (`PatreonService`, the `/patreon` page,
`/api/account/linkPatreon`, the `keepsSupporterWithNoPatreon` permission) — it needs credentials,
tiers, and perks that cannot touch competitive fairness.
**Tasks**

-   Owner: create the Patreon campaign and tiers; set `patreonClientId`, `patreonSecret` and
    `patreonCallbackUrl`.
-   Verify the inherited link/unlink and pledge-status refresh against the live campaign.
-   Define supporter perks — cosmetic and convenience only: custom backgrounds and card backs,
    avatar frames, a supporter badge, longer replay retention, larger deck-import batches.
    **(admin-config)** which tier unlocks which perk.
-   A "Support Archon Arena" page saying plainly where the money goes, with an opt-in supporter
    list.

**Depends on:** I1 (live site) and owner Patreon setup.
**Acceptance criteria**

-   Linking a Patreon account grants the supporter role within one refresh cycle; unlinking or a
    lapsed pledge removes it.
-   No perk affects Amber, matchmaking, tournament eligibility, or any other competitive outcome —
    and the support page says so.
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
-   [x] **Rated or not is admin-config** (`inPersonGames.rated`, **off by default** — turning
        it on is a real decision about a ladder the platform did not witness). Even with it on,
        a game with no decks attached is recorded **unrated**, because the Elo engine needs
        both decks' SAS and the alternative is inventing an input. The row records _why_ it
        was unrated, so a player who reported a game and saw no rating change gets an answer.
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

#### N15 — Move-by-move clarity in the apps _(mobile done; web attribution and passive effects open)_

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
-   [ ] **Web client: still only interpolates, never attributes.** `ActivePlayerPrompt` resolves
        `controls[0].source` into `{{card}}` placeholders (`localizedText`), so a prompt whose text
        happens to mention the card reads correctly — but a prompt whose text does _not_ name it
        shows nothing, and that is exactly the case the item was written for. The mobile
        "because of _<card>_" row is the model to port.
-   [ ] Same treatment for triggered and passive effects that change the board without prompting —
        untouched on both clients.

**Depends on:** nothing hard — the engine already tracks each ability's source card.
**Acceptance criteria**

-   [x] On a phone, a player can follow the opponent's whole turn without opening the log sheet.
-   [ ] Every prompt that originates from a card names that card. True on mobile; on web only when
        the prompt text carries a `{{card}}` placeholder.
-   [x] Nothing about what the engine resolves changes — this is presentation only. The mobile work
        is client-side interpolation and display over data the server already sent.

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

#### F3 — Coaching and AI analysis

Coaching profiles/marketplace with booking, shared replay review rooms (coach and student
stepping through together), AI game analysis (blunder detection, alternative lines,
win-probability per turn) over the replay event stream, AI deck insights in SAS context.
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

App Store release of the existing Expo iOS app, Android build, feature parity with the web
platform (tournaments, community, profiles), push notifications.
**Depends on:** N2, N6. **Acceptance:** both stores carry a build that can play, enter a
tournament, and receive pairing pushes.

#### F8 — Scale-out

Redis-backed leaderboard sorted sets, Redis-shared DoK rate-limit counter for multi-process
deployments, multi-lobby settings invalidation, revisit Kubernetes (charts retained in
`infrastructure/`) if VPS scaling stops being enough.
**Depends on:** N10 load testing telling us which ceiling is hit first.
**Acceptance:** a documented scaling step exists for each ceiling the load test finds.

#### F9 — Bot showcase: two AI players in a permanent watchable game

**Why:** an empty lobby is the hardest problem a new platform has. Two bots playing each other
around the clock give the Watch hub content from day one, let a visitor see the game before they
commit to it, and run the engine as a continuous soak test.
**Tasks**

-   An AI player driving the engine through the ordinary player interface (house choice, play /
    use / reap / fight, key timing). Strength can start crude — never stalling matters more.
-   A supervisor that keeps a bot-vs-bot table live, starts a fresh game when one ends, and
    publishes it to the Watch hub as spectatable.
-   Bot games are excluded from Amber, matchmaking, leaderboards, and every statistics aggregate.
-   **(admin-config)**: how many bot tables run, how their decks are chosen, and whether the
    showcase is on at all.
-   Later: bots as practice opponents, as the tutorial's sparring partner (**N11**), and as the
    base for AI analysis (**F3**).

**Depends on:** N1 (Watch hub). Feeds F3 and N11.
**Acceptance criteria**

-   A logged-out visitor can watch a live game within seconds of landing on the site.
-   A bot game reaches a legitimate conclusion (three keys or deck-out) without stalling, looping,
    or throwing; a wedged table is detected and replaced.
-   No bot game appears in any leaderboard, player stat, or meta aggregate — asserted by a test.

---

## Phase-by-phase status

Phases group related work thematically. Sequencing lives in the backlog above; the backlog ID
in a `→` note points to where an unfinished item is scheduled.

## Phase 0 — Working fork & foundation

-   [x] Create ArchonArena repo from keyteki source (github.com/keyteki/keyteki import).
-   [x] Preserve upstream remap path so upstream gameplay/card fixes can be pulled in later
        (documented in `docs/UPSTREAM.md`).
-   [x] Get server + client building locally (`npm install`, dev build passes).
-   [x] Get test suite running; record baseline pass rate before any changes
        (docs/TEST-BASELINE.md: 38,221 passed / 0 failed).
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
-   [ ] Terms of Service page → **I6**.
-   [ ] Keep internal code identifiers stable where renaming risks gameplay breakage
        (rename UI-facing only; engine internals renamed opportunistically later).

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
-   [x] Legacy MongoDB removed from the running application — all services are PostgreSQL-only.
        Two unused standalone scripts and the `monk` dependency remain (housekeeping below).
-   [ ] Point ArchonArena.com DNS (Porkbun) at the host — **owner action** → **I1**.
-   [ ] WebSocket pass-through for game server verified end-to-end on the live host → **I1**.
-   [ ] Uptime monitoring configured and alerting → **I1**.
-   [ ] Automated off-host backups + rehearsed restore → **I7**.
-   [ ] Staging environment (staging.archonarena.com) deploying from main → **N10**.
-   [ ] Zero-downtime deploy script (drain game node, deploy, restart) → **N10**.

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
-   [ ] **Owner action:** register the Keycloak client in the keybringer realm (client
        id/secret, redirect URIs for archonarena.com + localhost) and set OIDC\_\* env vars → **I1**.
-   [ ] Admin setting: SSO-only mode (disable local registration) **(admin-config)**.
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
-   [ ] Show SAS on deck _lists_, lobby games, and pre-game screen → **N3**.
-   [x] **Periodic refresh sweep job** — stalest decks first, yields to live traffic, cadence
        and batch size admin-config (**N3**).
-   [ ] AERC component breakdown display from stored RawData → **N3**.
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
-   [ ] Per-game rating delta surfaced to players → **I4**.
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
-   [x] **Top Players page**: worldwide top 25 by Amber per pool, podium for the top three.
-   [x] **Ratings page**: personal Amber per pool with world rank (#N of M), games,
        provisional badge, and a plain "How Amber works" explainer.
-   [x] **Seasons**: season records, soft reset toward a configurable baseline with a carry
        factor, admin season operations UI (migration 37).
-   [x] Player rank card on the profile page; Amber shown on lobby player names.
-   [ ] Public player profile pages, with every username on the site linking to one → **I3**.
-   [ ] Season display, archive, and end-of-season summary for players → **N4**.
-   [ ] Activity window on boards **(admin-config)** → **N4**.
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
-   [x] Standings: points → strength-of-schedule → extended SoS → fewest byes, with
        W-L records and game counts; live on the event page.
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

## Phase 8 — Modern UI

-   [x] Chess.com-style navigation: fixed left sidebar (Play/Learn/Watch/Community/Other
        with flyout submenus, Sign Up/Log In at bottom) on all non-game screens; in-game
        keeps the slim top bar so the board keeps full width.
-   [x] Home page rebuilt as a landing hero (news → Community > News; lobby chat and
        promo banners removed; admin MOTD/banner notices retained).
-   [x] Placeholder pages routed for Learn and the Community subpages so navigation is
        complete ahead of the features; Stats, Tournaments, Play IRL and Watch have since
        shipped.
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
-   [ ] Replace the `/learn` placeholder with a tutorial that teaches inside a real game →
        **N11**, then the wider Learn hub → **F6**.
-   [ ] Name the card and ability responsible in every prompt ("…because of Gateway to Dis")
        → **N15**.

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
-   [ ] Rich public player profiles: avatar, bio, location, ratings, badges, favourite decks,
        match history summary → **I3**.
-   [x] **Club leaderboards, approval-based joins, ownership transfer** (migration 44).
-   [x] **Teams** (competitive): rosters distinct from clubs, team events, and a team ladder
        earned as a unit rather than averaged from members' Amber.
-   [x] **Moderation tools**: reports with captured evidence, graduated actions with reason
        and expiry, and a full audit log **(admin-config policies)** — migration 48.
-   [ ] Friend activity feed, DMs (moderated), block-list integration → **N5**/**N7**.
-   [ ] Store follow-ups: map view, store-hosted event listings, verified/official badges → **N7**.
-   [ ] Onboarding asks each new account how well they know KeyForge, and (if they do) how well
        they know the platform, then teaches only what is missing → **N11**.
-   [x] **Track in-person games**: both players report independently, agreeing reports commit
        into a real game, decks optional (migration 47). Rating them is admin-config and off
        by default.

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
-   [x] **Admin analytics**: DAU/MAU, games/day, queue health, funnel metrics (/admin/analytics).
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
-   [ ] An AI player able to drive the engine — first as the bot showcase and a practice
        opponent (**F9**), then as the model behind analysis (**F3**).

## Phase 14 — Mobile support

-   [x] **Expo iOS app** (`mobile/`): sign in/register against the lobby (JWT + refresh,
        tokens in the iOS keychain), live game list, create/join/watch games, deck library
        with house icons + SAS and Master Vault import, pending game, and the full game board
        (HUDs, battlelines, prompts, card menus, pile viewers, log/chat, spectator mode,
        reconnect, concede/leave, manual mode). Protocol-identical to the web client.
-   [x] EAS build config + TestFlight runbook (`mobile/TESTFLIGHT.md`); keep-awake during play;
        mobile network resilience (timeouts, reconnect).
-   [ ] Mobile-responsive web as the baseline → **N6**.
-   [ ] PWA: installable, push notifications for round pairings/turn timers → **N6**/**N2**.
-   [ ] Show each move as it happens in the Expo app, rather than only inside the slide-up log
        sheet → **N15**.
-   [ ] Turn the `/mobile/android` placeholder into a real link to the beta build, and
        `/mobile/ios` into a TestFlight invite request → **N14**.
-   [ ] App Store release, Android build, platform feature parity (tournaments, community,
        profiles) → **F7**.

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
-   [ ] Post-game result screen with the Amber change → **I4**.
-   [ ] Matchmaking parameters **(admin-config)**: base tolerance, widening rate, max wait.
-   [x] **Queue health telemetry** (depth, wait time) — recorded as it happens, since the
        queue is in-memory and leaves no trace afterwards (migration 45).
-   [ ] Rematch and rated-rematch flow from the result screen → **I4**.

## Phase 19 — Sustainability & supporter program

Running the platform costs money — a host, the DoK API tier, the domain, eventually object
storage for backups and replays. This phase is about paying for that without ever selling a
competitive advantage.

-   [x] Patreon OAuth linking, pledge-status refresh, and a supporter role inherited from TCO
        (`PatreonService`, `/patreon`, `/api/account/linkPatreon`) — dormant: no campaign, no
        credentials, no defined perks.
-   [ ] **Patreon supporter program**: campaign + tiers, verified link/unlink flow, perks that
        are cosmetic and convenience only, and a page saying where the money goes → **N12**.
-   [ ] Publish running costs and what supporters cover, so the ask is concrete.
-   [ ] Revisit only if Patreon proves insufficient: one-off donations, or store/organizer
        sponsorship of events. Never anything that touches Amber, matchmaking, or eligibility.

---

## Cross-cutting: Site administration _(build alongside every phase)_

-   [x] **Settings service**: typed registry, DB-backed (SiteSettings), in-memory
        snapshot with periodic refresh, who/when audit, defaults in code
        (docs/design/settings-service.md).
-   [x] Admin settings UI at /admin/settings (isAdmin) covering rating (Elo knobs, decay,
        seasons, leaderboard threshold), DoK (including the background SAS sweep), tournaments,
        replays (recording, size cap, retention, purge cadence, sharing), watch (spectator
        counts, broadcast delay, featured game), regions, site content, and navigation page
        visibility.
-   [x] Admin tooling: user admin (roles, disable, delete, password reset), per-player rating
        set/reset, season operations, ban list, nodes, MOTD, news, bug reports.
-   [x] `sectionDefaults()` / `getSectionWithDefaults()`: a registry-only section's code
        defaults are built from the same field descriptors the admin UI renders, so a service
        reading a setting cannot drift from what the admin panel says the default is.
-   [ ] Wire remaining **(admin-config)** flags through the registry: auth SSO-only mode,
        matchmaking parameters, moderation policy thresholds.
-   [x] **Redis pub/sub snapshot invalidation** for multi-lobby deployments. An accelerator
        over the interval refresh, never a dependency on it.
-   [x] **Full audit-log table** (`ModerationAuditLog`, migration 48). Settings changes append
        to it alongside every moderator action, so "who changed this, when, and to what" has an
        answer that the next edit cannot overwrite.
-   [x] **Feature flags** section for gradual rollout; every flag defaults to current behaviour.
-   [ ] Admin panel coverage for tournaments, moderation, and analytics → **N5**/**N8**.
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
-   [x] Gameplay regression suite kept green on every PR (the full card suite runs in CI).
-   [x] **In-app bug reports** (BugReportService, migration 34) with an admin triage page —
        the beta feedback channel.
-   [ ] Data migration/versioning discipline: ledger + runner, one numbered migration per
        schema change → **I2**.
-   [ ] Security: dependency audit, auth rate limiting, OWASP pass before launch → **I5**.
-   [ ] Load testing for game nodes + matchmaking before public launch → **N10**.
-   [ ] Upstream sync process: periodically merge keyteki card fixes (`docs/UPSTREAM.md`) → **N10**.

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
