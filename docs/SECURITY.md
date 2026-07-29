# Security

How Archon Arena is defended, what has been reviewed, and which risks are knowingly
accepted. This is a standing checklist — re-run it before any public announcement and
after any dependency sweep, and update the date below.

**Last reviewed:** 2026-07-27

## Reporting a vulnerability

Open a private security advisory on the GitHub repository rather than a public issue.
Please include reproduction steps and the affected endpoint or page.

---

## Controls in place

### Transport and headers

-   TLS terminated by Caddy with automatic certificates (`deploy/Caddyfile`).
-   `helmet` mounted in `server/server.js`: HSTS (production only, where TLS actually
    terminates), `nosniff`, `X-Frame-Options`, `Cross-Origin-Resource-Policy`,
    `Origin-Agent-Cluster`, `X-Permitted-Cross-Domain-Policies`, and
    `Referrer-Policy: strict-origin-when-cross-origin`.
-   `Cross-Origin-Opener-Policy` is deliberately `same-origin-allow-popups` rather than
    helmet's stricter `same-origin` default: the tournament print-pairings view opens an
    `about:blank` popup and writes into it. Cross-origin popups still cannot reach back
    into the page.
-   **Content-Security-Policy** (`server/csp.js`). Production allows no inline or eval'd
    script, plus `object-src 'none'` and `base-uri` / `form-action` / `frame-ancestors`
    locked to self, and `upgrade-insecure-requests`. Helmet's own default CSP is disabled
    (`contentSecurityPolicy: false`) because it knows nothing about hCaptcha, gameplay
    websockets or the Sentry ingest host — leaving it on would both break the site and
    emit a second, conflicting header.
    -   `CSP_MODE=enforce|report-only|off` can turn the policy down without a redeploy if
        a deployment turns out to need an origin the policy misses. An unrecognised value
        falls back to `enforce`, so a typo cannot silently disable it.
    -   Verified by loading the real production bundle in Chromium under the enforcing
        header: zero violations, with a negative control confirming violations are
        detected when the policy is wrong.

### Authentication and abuse limits

-   Passwords hashed with bcrypt. Sessions are JWT + refresh token.
-   Optional OpenID Connect SSO (Keycloak) with authorization code + PKCE, JWKS signature
    validation, and issuer/nonce checks (`server/services/auth/OidcService.js`).
-   **Every unauthenticated auth endpoint is rate-limited** per IP: login, registration,
    password reset (both halves), activation, token refresh and username lookup.
-   **Login additionally carries a failure throttle** (`createFailureThrottle` in
    `server/api/rateLimit.js`) keyed per-IP _and_ per-username: 10 failures in 15 minutes
    locks that key out for 15 minutes, and a successful login clears it. Counting failures
    rather than requests lets the limit be strict without penalising honest users. The 429
    message is identical whichever key trips, so it reveals nothing about whether an
    account exists.
-   Rate-limit keys come from `req.ip`, derived via Express's `trust proxy` setting
    (exactly one Caddy hop in production, nothing in development) — **not** from raw
    `X-Real-IP` / `X-Forwarded-For` headers, which the caller controls. Trusting one hop is
    only sound because `docker-compose.prod.yml` publishes ports on the `caddy` service
    alone; if a future deployment ever exposes the lobby directly, this must be revisited.
-   **Both limiters are Redis-backed and shared across lobby processes**
    (`server/api/rateLimitStore.js`). They were per-process, which quietly divided every
    limit by the number of lobbies — "10 login failures" meant 10 _per lobby_. Each
    decision is a single Lua script so check-and-record is atomic; a read followed by a
    separate write would let concurrent requests slip past exactly when the limit matters.
    If Redis is unreachable the store falls back to per-process limits, so an outage
    degrades enforcement instead of removing it and cannot take login down with it.

### Authorization

-   Every `/api/admin/*` route requires **both** a valid JWT and an explicit permission
    check (`isAdmin`, or `canManageUsers` for the per-player rating tools). Verified by
    enumeration — no admin route relies on authentication alone.
-   Tournament organizer operations are authorized **in the service layer**, not the route
    layer, so the check cannot be bypassed by a different caller. All thirteen TO-only
    operations (`updateSettings`, `openCheckIn`, `setSeeds`, `addStaff`, `removeStaff`,
    `start`, `nextRound`, `cutToPlayoff`, `awardWin`, `doubleLoss`, `finish`, `cancel`,
    `ensureGameForMatch`) call `canManage`/`isStaff`. Verified by enumeration.

### Data handling

-   PostgreSQL access is exclusively parameterised queries. The one place SQL is
    assembled from a variable — `StatisticsService.sasBandCaseSql` — interpolates only
    hard-coded constants from a module-level table, never user input.
-   Uploaded avatars and backgrounds are gated on magic bytes (PNG or JPEG only), written
    through a path builder that sanitises the filename and asserts the resolved path stays
    inside its base directory (`buildPngPath`).
-   Public endpoints expose only fields that are already public site behaviour. The player
    profile query is asserted by test never to select `Email`, `Password` or `RegisterIp`,
    and disabled/unverified accounts do not resolve.
-   Password reset tokens are HMAC-SHA512 with a 4-hour expiry and are **never logged**.

### Secrets

-   Secrets are environment-only and are deliberately **not** in the runtime settings
    registry (`server/services/settings/registry.js`), so no admin UI can read or change
    them: `SECRET`, `HMAC_SECRET`, `DB_PASSWORD`, `DOK_API_KEY`, `OIDC_CLIENT_SECRET`,
    `AWS_SECRET_ACCESS_KEY`, `CAPTCHA_KEY`, `SENTRY_DSN`.
-   `.env.production` is gitignored; `.env.production.example` carries placeholders only.
-   A production database is seeded with **no accounts**. The demo logins
    (`admin`/`test0`/`test1`) live in `server/db/dev-seed/`, mounted only by the local
    compose file; `deploy/healthcheck.sh` FAILs if any of them exist in production.

---

## Dependency audit

Run `npm audit --omit=dev` — the production tree is what matters; dev tooling is not
shipped.

**Status at last review:** 13 advisories in the production tree (1 critical, 7 high,
5 moderate). Every critical and high now traces to a **single** root: `fabric`. Everything
non-breaking has been applied, and the lint toolchain was moved to `devDependencies` so it
no longer appears in the production graph at all.

The `patreon` package was the other root and is **gone** — `PatreonService` now uses direct
`fetch`, which removed its `node-fetch` / `isomorphic-fetch` chain and three high
advisories with it.

Notably fixed: **`ws` memory-exhaustion DoS** (GHSA-96hv-2xvq-fx4p), which sat directly in
the gameplay socket path (`socket.io` → `engine.io` → `ws`) and was the one advisory with
a clear path to a live game server.

### Accepted risks

**`fabric@5` — and its `canvas@2` / `@mapbox/node-pre-gyp` / `tar` chain**

-   _Why not fixed:_ fabric 7 is a rewrite (ESM-only, no `fabric.` namespace, promise-based
    async, changed filter API) and fabric is used across ~1,600 lines in 7 files —
    the archon-maker deck image generator, card rendering on the game board, card backs,
    identity cards and the `fetchdata` image pipeline. Measured surface: **98 call sites
    across 10 distinct APIs** (`Image`, `Shadow`, `Text`, `Textbox`, `StaticCanvas`,
    `Line`, `util.loadImage`, `util.createCanvasElement`, `Image.fromURL`,
    `Image.filters.Resize`).

    The migration itself is mechanical; the risk is **silent visual regression**. Text
    metrics and shadow rendering changed between fabric 5 and 6, and the archon maker
    generates the deck images players actually look at — a shifted baseline would ship
    subtly wrong deck lists with nothing failing. Doing it safely needs a before/after
    image-diff harness driving `buildDeckList` / `buildCard` / `buildCardBack`, which does
    not exist yet. That is why it stays its own project rather than riding along in a
    dependency sweep.

-   _What v7 would buy:_ fabric 7 declares **no hard dependencies** at all (`canvas` and
    `jsdom` move to `optionalDependencies`, and `canvas@3` no longer uses
    `@mapbox/node-pre-gyp`), so the entire `canvas` → `node-pre-gyp` → `tar` chain — and
    with it the only critical in the tree — disappears. It also keeps a CommonJS entry
    (`fabric/node`), so the server-side callers do not need to become ESM.
-   _Why the exposure is low:_
    -   The fabric advisory is **stored XSS via SVG export**. The codebase has no SVG path
        at all — no `toSVG`, `loadSVGFromString` or `loadSVGFromURL` anywhere — and the
        only user-supplied image input is magic-byte-gated to PNG/JPEG before it reaches
        fabric.
    -   The critical `tar` advisory (hardlink path traversal) is reached through
        `@mapbox/node-pre-gyp`, which extracts prebuilt binaries **at install time** from a
        trusted source. It is not reachable from user input at runtime.

### Resolved since the last review

**`patreon@0.4.1`** — removed. `PatreonService` was three HTTP calls wrapped in an
unmaintained package; it now uses `fetch` directly against Patreon's v2 API (the package
spoke the long-deprecated v1). Three high advisories went with it. The integration is still
dormant — no campaign, no credentials — so N12 still owns verifying it against a live
campaign, but the dependency is no longer in the tree.

---

## Checklist for the next review

-   [ ] `npm audit --omit=dev`; re-triage anything new, and re-check the one remaining
        accepted risk above (has fabric been migrated?).
-   [ ] Re-run the admin and tournament-organizer authorization enumeration.
-   [ ] Confirm no secret has drifted into the settings registry.
-   [ ] Re-run the CSP browser check against the built bundle, including the negative control.
-   [ ] Confirm `deploy/healthcheck.sh` passes on the live host, including the demo-account
        and `EMAIL_FROM_ADDRESS` assertions.
-   [ ] Verify a credential-stuffing attempt against `/api/account/login` is locked out —
        and that the lockout is visible from a _second_ lobby process, not just the one that
        counted the failures.

## Known gaps

Tracked on the roadmap rather than here:

-   No moderation tooling beyond the inherited block list and ban list (roadmap N5).
-   `fabric` is still on v5 — the one remaining accepted risk above.

Closed since the last review:

-   Rate limits and the login failure throttle were **per-process**, which divided every
    limit by the number of lobbies. They are now Redis-backed and shared, falling back to
    per-process limits if Redis is unreachable rather than dropping them.
-   `style-src` no longer carries `'unsafe-inline'`. Font Awesome's runtime CSS injection
    was turned off in favour of the bundled stylesheet, and React Aria's one remaining
    injected rule is allowed by hash — with a test that fails if a library upgrade changes
    the rule out from under the hash.
-   `connect-src` no longer carries a blanket `wss:` (i.e. a websocket to any host on the
    internet). Same-origin gameplay is covered by `'self'`; a split-node topology is now
    opt-in via `GAME_NODE_ORIGINS`.
