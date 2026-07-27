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

## Where the platform stands (2026-07-25)

**The engineering is far ahead of the operations.** Almost every headline system in this
roadmap — ratings, tournaments, community, matchmaking, statistics, replays, a native iOS
app — is built, tested, and wired end to end. What is missing is the last mile: the site is
not yet serving players at archonarena.com, and a handful of player-facing surfaces that
turn those systems into a habit-forming loop (public profiles, post-game results,
notifications) do not exist yet.

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
| Community          | Friends, member directory, clubs + invite codes, local store directory, Play IRL hub, onboarding wizard                                                                                                                               |
| Statistics         | Meta dashboard (house win rates, SAS bands, format share) + per-player breakdowns, TTL-cached                                                                                                                                         |
| Match history      | Game History page on PostgreSQL; recorded play-by-play + step-through viewer                                                                                                                                                          |
| Admin              | Settings service + `/admin/settings` (rating, DoK, tournament, regions, content, navigation), user/ratings/banlist/nodes/motd/news/bug-report admin                                                                                   |
| Mobile             | Expo iOS app (`mobile/`): login, decks, lobby, pending, full board, spectate, reconnect; EAS + TestFlight runbook                                                                                                                     |
| Ops                | CI (typecheck/lint/build/test + CodeQL), prod compose + Caddy TLS, `deploy/healthcheck.sh`, Sentry wired client + server                                                                                                              |

**Incomplete — built but not finished**

-   **Replays** capture the chat/play-by-play log only; there is no board-state snapshot,
    no retention policy, no share link.
-   **Spectating** works from the lobby game list, but there is no Watch hub, no broadcast
    delay, and no caster mode.
-   **SAS** shows on the deck summary only — not on deck lists, lobby games, or the pre-game
    screen; the AERC component breakdown stored in `DeckSas.RawData` is never displayed.
-   **Meta dashboards** lack set win rates and matchup matrices; there are no per-deck stats
    and no admin/operational analytics.
-   **Admin-config coverage** stops short of auth (SSO-only mode), matchmaking, replay
    retention, and moderation policy; there is no feature-flag section and only a
    last-editor audit trail.
-   **Clubs** have no leaderboards, approval-based joins, or ownership transfer.

**Missing entirely**

-   **Public player profiles.** No `/players/:username` route exists; no username anywhere on
    the site is clickable. For a competitive community platform this is the single largest hole.
-   **Post-game result screen.** A rated game ends with no indication that Amber moved.
-   **Notifications** of any kind — in-app, email, or push.
-   **Moderation tooling** beyond the inherited block list / ban list: no reports, mutes,
    timeouts, or moderation queue.
-   **Any way to learn the game on the platform.** No tutorial, and onboarding never asks how
    much a new account already knows — the `/learn` route is a placeholder.
-   **A funding path.** The inherited Patreon integration has no campaign, credentials, or perks.
-   **In-person game tracking.** Paper games can only be recorded through a tournament.
-   **A reason to visit an empty site.** Nothing to watch when nobody happens to be playing.
-   **Teams**, **versioned public API**, **Discord**, **coaching/AI**, **streaming tools**,
    **organized-play program**.
-   **Schema migration ledger.** Migrations are applied by hand with no record of what ran.

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

-   Owner: provision the VPS, point Porkbun DNS at it (docs/DEPLOYMENT.md §2), register the
    Keycloak client in the keybringer realm, obtain a DoK API key.
-   Bring up `docker-compose.prod.yml` + Caddy; set `SENTRY_DSN`.
-   Verify WebSocket pass-through to the game node end to end on the live host.
-   Point an external uptime monitor at the site; alert on 5xx and on TLS expiry.
-   Run `deploy/healthcheck.sh` on the host until it is all-PASS.

**Depends on:** owner actions (VPS, DNS, Keycloak, DoK key). Blocks: I3–I7, all near-term work.
**Acceptance criteria**

-   Two players on two different networks complete a full game start-to-finish through
    `https://archonarena.com`, including a reconnect mid-game.
-   Keybringer SSO login and local registration both succeed against the live host.
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
softest surface. Rate limiting exists (`server/api/rateLimit.js`) but is applied only to bug
reports, community actions, deck DoK prepare, and tournament creation — not to login,
registration, or password reset.
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
-   [ ] **`fabric` v5 → v7** — the last critical/high advisories all trace to it. A rewrite
        (ESM-only, promise-based, ~1,000 lines of usage across the archon maker, game board
        and fetchdata pipeline), so it is its own project. Exposure documented as low: no SVG
        path exists and uploads are magic-byte-gated.
-   [ ] Replace the unmaintained `patreon` package with direct `fetch` (folds into **N12**).
-   [ ] Move the rate limiter and login failure throttle to Redis so limits hold across
        processes; both are per-process today.
-   [ ] Tighten `style-src` off `'unsafe-inline'` with nonces or hashes, and narrow
        `connect-src` from `wss:` to the actual game-node origins.

**Depends on:** nothing. Blocks: public announcement of the site.
**Acceptance criteria**

-   A scripted credential-stuffing attempt against login is throttled and locked out, with a test.
-   No high or critical advisory outstanding in `npm audit`, or each is documented with a reason.
-   `docs/SECURITY.md` exists with the checklist, the date it was last run, and the results.

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

#### N1 — Full replays, share links, and the Watch hub _(mostly done)_

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
-   [ ] Retention budget and policy **(admin-config)**; the 2 MB oversized-capture skip is
        still implicit.
-   [ ] Share links for replays and matches (public, no auth) — replays are still
        authenticated.
-   [ ] Featured match, spectator counts, and an optional broadcast delay **(admin-config)**.
-   [ ] Jump-to-key-forge and per-player perspective in the viewer.

**Depends on:** I2 (retention migration), I3 (profile links from replays).
**Acceptance criteria**

-   A finished game can be replayed board-state-by-board-state by someone who did not play it.
-   A spectator (live or replay) can never see hidden information, asserted by a test.
-   Retention is enforced by a job and configurable without redeploy.

#### N2 — Notifications

**Why:** tournaments and asynchronous community features are only useful if players are told
things happened. Round pairings in particular are unusable without a ping.
**Tasks**

-   In-app notification centre (bell + unread state) with a typed event taxonomy.
-   Email notifications for round pairings, tournament start, friend requests, club invites,
    with per-category opt-out in account settings.
-   Web push once the PWA lands (N6).

**Depends on:** I6 (email template), I3 (linking to profiles). Blocks: F2 (Discord reuses the taxonomy).
**Acceptance criteria**

-   Pairing a tournament round notifies every paired player in-app and by email within a minute.
-   Every category can be turned off per player, and opt-out is honoured (tested).
-   No notification path can block or slow a gameplay or tournament operation.

#### N3 — Deck intelligence _(mostly done)_

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
-   [ ] Best/worst matchups and "your best deck" callouts.
-   [ ] Periodic background SAS refresh sweep (today refresh is access-triggered only).

**Depends on:** I2 (any stats migration).
**Acceptance criteria**

-   A player can see, without leaving the deck page, how their deck performs relative to what
    its SAS predicts.
-   Deck lists and lobby games show SAS whenever it is cached, and degrade silently when not.
-   The refresh sweep respects the existing per-minute DoK budget and never starves live requests.

#### N4 — Ladder maturity

**Why:** seasons and decay exist in the engine but are invisible to players, and there is no
way to correct the ladder after tuning the Elo config.
**Tasks**

-   Season display: current season on leaderboards, season archive, end-of-season summary.
-   Season rewards/badges surfaced on profiles (depends on I3).
-   Activity window on boards **(admin-config)**.
-   Rating recalculation tool: replay `RatingHistory` under a new config, admin-triggered,
    dry-run first.

**Depends on:** I3, I4.
**Acceptance criteria**

-   A player can see which season they are in, where they finished in prior seasons, and what
    a soft reset did to their Amber.
-   Recalculation produces a diff report before it commits, and is idempotent for an unchanged config.

#### N5 — Moderation toolkit

**Why:** the platform inherits a block list and ban list and has a `canModerateChat` role, but
no way to report anything or act proportionately. Community size makes this urgent, not optional.
**Tasks**

-   Reports: player, chat message, deck name, club, store listing — with reason and context capture.
-   Moderation queue with claim/resolve, and graduated actions (warn, mute, timeout, ban) with
    reason and expiry.
-   Full audit log of moderator actions (replacing the settings service's last-editor-only trail).
-   Policy thresholds **(admin-config)**.

**Depends on:** I3 (profiles are where reports start), N2 (notifying the reporter).
**Acceptance criteria**

-   Any player can report from the surface where the problem appears, in two clicks.
-   Every moderator action is attributable, reversible, and visible in the audit log.
-   A muted or timed-out player is blocked from the relevant surfaces and told why and for how long.

#### N6 — Design system, responsive, accessibility, PWA

**Why:** theme tokens and light/dark palettes exist, but there is no documented component
library, no responsive pass, and no accessibility work. Mobile web is the default first
experience for most new players.
**Tasks**

-   UI audit doc: component inventory, duplication, and the modernization order.
-   Document the token set and build the shared component library on top of it.
-   Page-by-page responsive pass (decks → community → tournaments → profile → game UI last,
    since the board carries the most gameplay risk).
-   Accessibility: keyboard navigation, contrast, focus order, screen-reader landmarks.
-   PWA: installable, offline shell, push notifications (feeds N2).

**Depends on:** nothing hard; sequence after the play loop is proven.
**Acceptance criteria**

-   Every non-game page is usable at 375 px wide without horizontal scrolling.
-   Lobby, decks, tournaments, and profile are fully keyboard-navigable and pass a contrast audit.
-   The site is installable and receives a push notification on a phone.

#### N7 — Teams and club competition

**Why:** clubs exist but are inert — the local-scene story the platform is aiming at needs
competition between groups, not just membership lists.
**Tasks**

-   Club leaderboards, approval-based joins, ownership transfer (the recorded Clubs v1 follow-ups).
-   Team rosters distinct from clubs, team events in the tournament engine, team rating.

**Depends on:** I3, existing tournament engine.
**Acceptance criteria**

-   A club page ranks its members and can run a club-only event.
-   A team can register as a unit for a team event and carries a team rating that updates from results.

#### N8 — Admin analytics and operations dashboard

**Why:** after launch, decisions need numbers: is the funnel working, is the queue healthy,
are tournaments completing.
**Tasks**

-   DAU/MAU, games/day, matchmaking queue depth and wait times, tournament completion rates.
-   Funnel: register → onboard → first deck → first game → second game.
-   Feature-flag section in the settings registry for gradual rollout.
-   Redis pub/sub settings-snapshot invalidation for multi-lobby deployments.
-   Extend the admin panel to tournaments and moderation.

**Depends on:** I1 (needs traffic), N5 (moderation surfaces).
**Acceptance criteria**

-   An admin can answer "how many people played yesterday and how many came back" without SQL.
-   A feature flag can be flipped at runtime and takes effect on every lobby process.

#### N9 — Tournament engine follow-ons

**Why:** the engine is the most complete system on the platform; these are the remaining gaps
organizers will hit in practice.
**Tasks**

-   Hybrid events (online + paper results feeding one standing).
-   QR join codes / check-in kiosk flows for IRL events.
-   Alliance-specific conditions (pod legality checks per event).
-   Archon Adaptive Bo3 (full swap/bid series) as a match type.

**Depends on:** existing tournament engine.
**Acceptance criteria**

-   A store can run a paper event on the platform with QR check-in and no laptop per table.
-   An Alliance event rejects an illegal pod at registration with a clear reason.

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

#### N13 — In-person game tracking

**Why:** most KeyForge is still played across a table. The platform already knows decks, Amber
and clubs; letting two players record a paper game keeps local scenes on the same ladder and
gives the Play IRL hub something to do between tournaments.
**Tasks**

-   Start an in-person game: one player opens it and names the opponent; the opponent confirms.
-   Both players report the result independently. Matching reports commit; a mismatch is flagged
    back to both players (and to a club officer or TO when the game belongs to an event).
-   Optionally attach each player's deck (Master Vault id or from their library) so SAS, house
    stats and deck records include paper play.
-   Decide and document whether IRL games are rated **(admin-config)**: the key differential and
    both decks' SAS are inputs the Elo engine needs, so they must be reported, never inferred.
-   Surface these games in Game History, player stats, and on the club page.

**Depends on:** I3 (profiles), N5 (disputes reuse the moderation queue). Related: **N9** hybrid
events, which feed one tournament standing rather than the open ladder.
**Acceptance criteria**

-   A paper game confirmed by both players appears in both histories with the right result, and in
    deck/house stats when decks were attached.
-   A one-sided or contradictory report never silently moves anyone's Amber.
-   Whether IRL games count toward Amber is an admin setting, and players can see the answer
    before they report.

#### N14 — App distribution: Android beta and iOS TestFlight requests

**Why:** `/mobile/ios` and `/mobile/android` are placeholder pages while a working Expo build and
a TestFlight runbook (`mobile/TESTFLIGHT.md`) already exist. Testers have no way in today.
**Tasks**

-   `/mobile/android`: link straight to the Google Play beta track (or a signed APK) with install
    instructions.
-   `/mobile/ios`: a form that requests a TestFlight invite — the requester's account and the
    Apple ID email — plus an admin view of pending requests to work through.
-   Show the current beta build number and what changed in it, so a tester knows if they are behind.

**Depends on:** I6 (email template) for the invite request; folds into N2 once notifications exist.
**Acceptance criteria**

-   A signed-in player can request an iOS beta invite in one action and gets a confirmation.
-   An admin can see and clear pending invite requests.
-   The Android page links to an install that works on a clean device.

#### N15 — Move-by-move clarity in the apps

**Why:** the Expo app keeps the play-by-play behind a slide-up sheet (`LogSheet`), so on a phone
it is easy to miss what the opponent just did. And on both clients a prompt often asks for a
choice without saying which card is asking — the engine knows the source card, the UI does not
show it.
**Tasks**

-   Expo app: surface each move as it happens — a persistent recent-moves strip or a per-action
    inline notice — with the full log still available in the sheet.
-   Both clients: name the card and ability behind every prompt ("Choose a creature to destroy —
    because of Gateway to Dis"), taken from the ability's source card rather than re-derived.
-   Same treatment for triggered and passive effects that change the board without prompting.

**Depends on:** nothing hard — the engine already tracks each ability's source card.
**Acceptance criteria**

-   On a phone, a player can follow the opponent's whole turn without opening the log sheet.
-   Every prompt that originates from a card names that card.
-   Nothing about what the engine resolves changes — this is presentation only.

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
-   [ ] Periodic refresh sweep job (currently access-triggered only) → **N3**.
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
-   [ ] Recalculation tool (replay rating history after config change; admin-triggered) → **N4**.

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
-   [ ] Hybrid events (online + paper results feeding one standing) → **N9**.
-   [ ] QR join codes / check-in kiosk flows for IRL events → **N9**.
-   [ ] Alliance-specific conditions (pod legality checks per event) → **N9**.
-   [ ] Archon Adaptive Bo3 (full swap/bid series) as a match type → **N9**.
-   [ ] Round-pairing notifications → **N2**.

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
        (`client/styles/tailwind.css`).
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
-   [ ] Club leaderboards, approval-based joins, ownership transfer → **N7**.
-   [ ] **Teams** (competitive): rosters, team events, team rating → **N7**.
-   [ ] Moderation tools: reports, mutes, bans, audit log **(admin-config policies)** → **N5**.
-   [ ] Friend activity feed, DMs (moderated), block-list integration → **N5**/**N7**.
-   [ ] Store follow-ups: map view, store-hosted event listings, verified/official badges → **N7**.
-   [ ] Onboarding asks each new account how well they know KeyForge, and (if they do) how well
        they know the platform, then teaches only what is missing → **N11**.
-   [ ] **Track in-person games**: both players start it, both report the score, decks optional
        → **N13**.

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
-   [ ] Storage-budgeted retention **(admin-config)** → **N1**.
-   [ ] Featured match, spectator counts, optional broadcast delay → **N1**.
-   [ ] Share links for replays/matches → **N1**.
-   [ ] Match history filters by deck, opponent, format, result → **N1**.
-   [ ] Two bots playing each other continuously, watchable by anyone — permanent content for the
        Watch hub and a continuous engine soak test → **F9**.

## Phase 11 — Statistics & analytics

-   [x] **Statistics Engine** service (`StatisticsService`): on-demand, TTL-cached
        aggregation over persisted games (never in the game path).
-   [x] Player stats: win rates by house & format, key rates, average game length.
-   [x] Meta dashboards: house win rates, SAS bands vs. win %, format popularity.
-   [x] Public API for stats (`/api/stats/*`), cached.
-   [ ] Set win rates and matchup matrices on the meta dashboard → **N3**.
-   [ ] Deck stats: per-deck W/L, SAS vs. performance deltas → **N3**.
-   [ ] Admin analytics: DAU/MAU, games/day, queue health, funnel metrics → **N8**.
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
-   [ ] Queue health telemetry (depth, wait time, match quality) → **N8**.
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
        seasons, leaderboard threshold), DoK, tournaments, regions, site content, and
        navigation page visibility.
-   [x] Admin tooling: user admin (roles, disable, delete, password reset), per-player rating
        set/reset, season operations, ban list, nodes, MOTD, news, bug reports.
-   [ ] Wire remaining **(admin-config)** flags through the registry: auth SSO-only mode,
        matchmaking parameters, replay retention, moderation policy thresholds.
-   [ ] Redis pub/sub snapshot invalidation for multi-lobby deployments → **N8**.
-   [ ] Full audit-log table (currently last-editor only) → **N5**.
-   [ ] Feature flags section for gradual rollout of new systems → **N8**.
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
-   [ ] **`helmet` pinned at v3**, several majors behind. Now mounted with a CSP (**I0**);
        the major-version upgrade stays with **I5**.
-   [ ] **Silent replay drop**: `GameService.saveReplay` skips captures over 2 MB with only a
        log line. Fold into the retention policy in **N1** so the behaviour is explicit and
        visible.
-   [x] **"Rematch: Swap Decks" read as the wrong thing** — now "Rematch: Trade Decks" and
        "Rematch: Pick New Decks", so the difference is stated rather than implied.
        `GameWonPrompt.spec.js` updated; no locale entries existed for these labels.
-   [x] **`docs/DEVELOPMENT.md`** — the Archon Arena developer guide: prime directive,
        layout, the schema-vs-migrations split, service and settings conventions, the
        verification loop, and which features need third-party provisioning. Complements
        `local-development.md` rather than repeating it.
