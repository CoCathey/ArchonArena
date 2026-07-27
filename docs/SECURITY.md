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

**Status at last review:** 16 advisories in the production tree (1 critical, 10 high,
5 moderate), _all_ of which trace to exactly two roots: `fabric` and `patreon`. Everything
non-breaking has been applied, and the lint toolchain was moved to `devDependencies` so it
no longer appears in the production graph at all.

Notably fixed: **`ws` memory-exhaustion DoS** (GHSA-96hv-2xvq-fx4p), which sat directly in
the gameplay socket path (`socket.io` → `engine.io` → `ws`) and was the one advisory with
a clear path to a live game server.

### Accepted risks

**`fabric@5` — and its `canvas@2` / `@mapbox/node-pre-gyp` / `tar` chain**

-   _Why not fixed:_ fabric 7 is a rewrite (ESM-only, no `fabric.` namespace, promise-based
    async, changed filter API) and fabric is used across ~1,000 lines — the archon-maker
    deck image generator, card rendering on the game board, card backs, identity cards and
    the `fetchdata` image pipeline. Migrating it is its own project with real gameplay-UI
    risk, tracked on the roadmap rather than bundled into a dependency sweep.
-   _Why the exposure is low:_
    -   The fabric advisory is **stored XSS via SVG export**. The codebase has no SVG path
        at all — no `toSVG`, `loadSVGFromString` or `loadSVGFromURL` anywhere — and the
        only user-supplied image input is magic-byte-gated to PNG/JPEG before it reaches
        fabric.
    -   The critical `tar` advisory (hardlink path traversal) is reached through
        `@mapbox/node-pre-gyp`, which extracts prebuilt binaries **at install time** from a
        trusted source. It is not reachable from user input at runtime.

**`patreon@0.4.1` — and its `node-fetch` / `isomorphic-fetch` chain**

-   _Why not fixed:_ the package is unmaintained; npm's suggested "fix" is a downgrade to
    `0.4.1`'s ancestor, which resolves nothing.
-   _Why the exposure is low:_ the Patreon integration is **dormant** — no campaign, no
    credentials, and `PatreonService` is only reached when a user explicitly links an
    account. The advisory (node-fetch forwarding secure headers across a cross-host
    redirect) requires an active Patreon flow to matter.
-   _Planned:_ replacing the package with direct `fetch` calls is part of the Patreon
    supporter-program work (roadmap N12).

---

## Checklist for the next review

-   [ ] `npm audit --omit=dev`; re-triage anything new, and re-check the two accepted risks
        above are still accepted (has fabric been migrated? is Patreon live yet?).
-   [ ] Re-run the admin and tournament-organizer authorization enumeration.
-   [ ] Confirm no secret has drifted into the settings registry.
-   [ ] Re-run the CSP browser check against the built bundle, including the negative control.
-   [ ] Confirm `deploy/healthcheck.sh` passes on the live host, including the demo-account
        and `EMAIL_FROM_ADDRESS` assertions.
-   [ ] Verify a credential-stuffing attempt against `/api/account/login` is locked out.

## Known gaps

Tracked on the roadmap rather than here:

-   Rate limits and the login failure throttle are **per-process**; a multi-lobby
    deployment would dilute them. They want Redis (roadmap I5).
-   `style-src` still needs `'unsafe-inline'` for React inline styles and HeroUI's runtime
    style injection. Removing it needs nonces threaded through the component tree.
-   `connect-src` allows `wss:` broadly rather than named game-node origins, so a
    split-node topology keeps working. Narrow it once the topology is settled.
-   No moderation tooling beyond the inherited block list and ban list (roadmap N5).
