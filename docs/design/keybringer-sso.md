# Design: Keybringer SSO (OpenID Connect)

Status: **Increments 1–2 shipped** — full authorization-code + PKCE login flow,
register-page sign-up entry, and account-settings link/unlink (Connected Services).
Disabled by default until a Keycloak client exists (owner action below). Role mapping
and RP-initiated logout are follow-ups.

Increment 2 adds:

-   `GET /api/account/oidc/identities`, `POST /api/account/oidc/unlink` (JWT-authed).
    Unlink is refused while the account has no usable password and only one identity,
    so an account can never be orphaned.
-   `POST /api/account/oidc/link/start` (JWT-authed XHR): returns the provider
    authorization URL and sets the signed state cookie with the requesting user's id
    (`linkUserId`). The callback detects link mode from the cookie, attaches the
    identity via `linkClaimsToUser` (refusing identities already linked elsewhere), and
    redirects to `/profile#ssoLinked=1` — no session minting. The user id travels in a
    server-signed JWT cookie, so it cannot be forged client-side.
-   Shared `SsoButton` component on Login + Register (renders nothing when SSO is off);
    Keybringer row in Profile → Connected Services next to the inherited Patreon row.

## Owner action required to enable

In the Keybringer Keycloak admin console (realm `keybringer`), create a **confidential
client**:

-   Client ID: e.g. `archon-arena`
-   Valid redirect URIs: `https://archonarena.com/api/account/oidc/callback`
    (plus `http://localhost:4000/api/account/oidc/callback` for dev)
-   Standard flow (authorization code) on; PKCE `S256` recommended
-   Copy the client secret

Then set in `.env.production`: `OIDC_ENABLED=true`, `OIDC_CLIENT_ID`,
`OIDC_CLIENT_SECRET`, `OIDC_REDIRECT_URI`. Nothing else to deploy — the login page shows
the "Sign in with Keybringer" button whenever the server reports SSO enabled.

## Current TCO architecture (analysis)

Auth is local-only: `POST /api/account/login` verifies a bcrypt password, signs a 5-minute
JWT (`configService.secret`) and issues a DB-backed refresh token
(`UserService.addRefreshToken`). Every authenticated API/websocket call uses
`passport-jwt`. There is no external identity support of any kind.

## Proposed architecture

```
Login page ── /api/account/oidc/login ──▶ Keycloak (auth code + PKCE)
                     │  signed httpOnly cookie {state, nonce, verifier}
Keycloak ── /api/account/oidc/callback ──▶ OidcService:
                     ├─ exchange code (token endpoint)
                     ├─ verify ID token signature via JWKS + iss/aud/exp/nonce
                     ├─ resolveUser: linked identity → email link → create account
                     └─ mint the SAME JWT + refresh token as password login
              redirect /login#sso=<payload> ──▶ SPA stores tokens (authSlice)
```

New pieces: `server/services/auth/OidcService.js`, `server/api/oidc.js`,
`UserOidcIdentities` table. Hooks into existing files are minimal and `ARCHON:`-marked
(route registration, cookie-parser middleware, login page).

### Why this shape

-   **Same session machinery as password login**: after identity resolution the flow mints
    the exact JWT + refresh token the rest of the platform already understands. Lobby
    sockets, game nodes, and every API keep working with zero changes — the SSO surface
    area stays confined to login.
-   **No new dependencies**: discovery/JWKS via Node's global `fetch`, RS256 verification
    via `crypto.createPublicKey({format:'jwk'})` + the already-present `jsonwebtoken`.
    Fewer supply-chain moving parts in the most security-sensitive path.
-   **Stateless transient state**: state/nonce/PKCE verifier cross the redirect in a
    short-lived signed httpOnly cookie rather than a server-side session, so any lobby
    instance can complete a login started by another (matters for horizontal scale).
-   **Tokens returned in the URL fragment**: fragments are never sent to servers, so
    tokens don't land in access logs; the SPA consumes and immediately clears them.
-   **Provider-agnostic config**: `auth.oidc.*` describes any standards-compliant OIDC
    provider; a second provider later is config + a second identities-table `Provider`
    value, not new code.
-   **Email linking only when `email_verified`**: linking by unverified email would let
    anyone who can register an arbitrary email at the provider take over a local account.

## Admin-configurable parameters

`auth.oidc.enabled`, `issuer`, `clientId`, `clientSecret`, `redirectUri`, `scopes`,
`providerName`/`providerDisplayName`, `requestTimeoutMs` — env-mapped
(`OIDC_*`), settings-service driven later. Roadmap also tracks an
SSO-only mode (disable local registration) as an admin setting.

## Files changed

-   `server/services/auth/OidcService.js` — new
-   `server/api/oidc.js` — new (status/login/callback endpoints)
-   `server/api/index.js`, `server/server.js` — ARCHON-marked wiring (route init,
    cookie-parser)
-   `server/db/schema/25 - UserOidcIdentities.sql` + `migrations/23 - ...` — new table
-   `client/pages/LoginContainer.jsx` — SSO button + fragment handoff handling
-   `config/default.json5`, `custom-environment-variables.json5`,
    `docker-compose.prod.yml`, `.env.production.example` — config plumbing
-   `test/server/services/auth/OidcService.spec.js` — new (13 tests)

## Database migrations

`23 - UserOidcIdentities.sql`: `UserOidcIdentities(Id PK, UserId FK→Users cascade,
Provider, Subject, Email, CreatedAt, UNIQUE(Provider, Subject))`.

## API changes

-   `GET /api/account/oidc/status` — `{ enabled, providerName }` (public)
-   `GET /api/account/oidc/login` — 302 to provider
-   `GET /api/account/oidc/callback` — 302 to `/login#sso=...` or `/login#ssoError=...`

## Tests

`OidcService.spec.js`: PKCE/state/nonce request construction, discovery caching, token
exchange body, **real RS256 signature verification** against a generated keypair, wrong
nonce/issuer/key rejection, token-endpoint failure, identity resolution (existing link,
verified-email link, unverified-email refusal, account creation, username
sanitization/dedup).

## Future considerations

-   **Link/unlink UI** in account settings (identity table already supports it).
-   **Role mapping**: Keycloak realm roles → Archon Arena roles (admin, TO) on login.
-   **RP-initiated logout** against Keycloak's `end_session_endpoint`.
-   **SSO-only mode**: admin setting to hide local registration entirely.
-   **Password-set flow** for SSO-created accounts (currently no usable password, which
    also blocks password reset until they use "forgot password" with a linked email).
