# Design: Patreon supporter linking (N12)

Status: **link flow shipped, dormant until credentials exist.** A player can connect
their Patreon account from Profile → Integrations, and an active pledge to the
configured campaign grants the Supporter role (and loses it when the pledge lapses).
What a supporter tier actually _unlocks_ is the second half of N12 and is not
implemented here — see [Not in this increment](#not-in-this-increment).

## Owner action required to enable

Nothing in the app is Patreon-aware until these are set. Until then the profile shows
no Patreon row, `/api/account/patreon/status` reports `enabled: false`, and no supporter
role is ever granted or revoked.

1. **Create the campaign** at <https://www.patreon.com/create> and set up whatever
   tiers you want to offer.
2. **Register an OAuth client** at
   <https://www.patreon.com/portal/registration/register-clients>.
    - App name / description / icon: whatever players should see on the consent screen.
    - **Redirect URI**: `https://archonarena.com/patreon` — this must equal
      `PATREON_CALLBACK_URL` (and `patreon.callbackUrl`) **character for character**.
      A trailing-slash difference is enough for Patreon to reject the code exchange
      with `invalid_grant`. Add `http://localhost:4000/patreon` too if you want the
      flow to work in development.
    - Copy the **Client ID** and **Client Secret**.
3. **Find the campaign id.** The client registration page also shows a _Creator's
   Access Token_; use it once:

    ```sh
    curl -H "Authorization: Bearer <creator-access-token>" \
      https://www.patreon.com/api/oauth2/v2/campaigns
    ```

    The `data[0].id` in the response is the campaign id.

4. **Set the environment** in `.env.production` and redeploy:

    ```sh
    PATREON_CLIENT_ID=...
    PATREON_CLIENT_SECRET=...
    PATREON_CAMPAIGN_ID=...
    PATREON_CAMPAIGN_URL=https://www.patreon.com/yourcampaign   # optional
    ```

**Set `PATREON_CAMPAIGN_ID`.** Patreon's identity endpoint returns the player's
memberships across _every_ creator they support. With no campaign id configured the
service counts all of them, so anyone who backs any unrelated creator on Patreon is
granted the supporter role here. The id is what scopes it to your campaign.

To verify: log in, go to Profile → Integrations → Link Account, approve on Patreon, and
you should land back on `/profile` with the row reading `Supporter - <your tier>`.

## How to test it

The awkward part: you probably cannot subscribe to your own campaign, so the
tier mapping is the one stage you cannot fully exercise alone. Test the chain in
stages instead - each one tells you which link is broken.

**1. Did the configuration reach the app?**

```sh
curl -s https://archonarena.com/api/account/patreon/status
```

`{"enabled":true}` means the client id and secret are loaded. `false` means
they stopped at the host - check `docker-compose.prod.yml` forwards them.

`bash deploy/healthcheck.sh` covers the same ground and FAILS if credentials are
set without a campaign id, which is the dangerous half-configured state.

**2. Does the OAuth handshake work?** Link your own account: Profile ->
Integrations -> Link Account, or the button on `/membership`. You do not need to
be paying for this to prove something - a successful link with no pledge reports
`linked`, which means the client id, secret, redirect URI and campaign scoping
are all correct. A failure here is almost always the redirect URI not matching
`callbackUrl` character for character.

**3. What does Patreon actually say about you?** Signed in as an admin:

```sh
curl -s -H "Authorization: Bearer <your token>" \
  https://archonarena.com/api/admin/patreon/diagnostics
```

This reports each stage separately - configuration (secrets as booleans, so it is
safe to paste into a bug report), whether the account is linked, the raw status,
tier titles and pledge amount Patreon returned, the tier we map that to, the row
we stored, and the entitlement that came out. When a stage disagrees with the one
before it, that is the broken link.

**4. Does a tier actually unlock features?** Without waiting for a real patron,
comp a tier to a SECOND, non-admin account:

```sh
curl -s -X POST -H "Authorization: Bearer <admin token>" \
  -H 'Content-Type: application/json' \
  -d '{"username":"testplayer","tier":"archon"}' \
  https://archonarena.com/api/admin/memberships/grant
```

Sign in as that account: the premium panels unlock. Revoke with
`{"username":"testplayer","tier":null}` and check they lock again. This exercises
the entitlement system end to end but NOT the Patreon mapping - a comp is stored
in different columns on purpose.

Your own admin account is the wrong thing to test with: the override returns
everything before any membership is read, so it can never show you what a paying
member sees.

**5. The tier mapping.** This needs a real pledge, from an account that is not
yours - a friend, or a second Patreon account. The moment they link, step 3 shows
their tier titles and what we mapped them to. Until then the mapping is covered
by unit tests (`test/server/services/membership/patreonSync.spec.js`) against the
titles and amounts in `tiers.js`, not against your live campaign.

## What was inherited, and what was wrong with it

The Patreon integration came from The Crucible Online and had never been run against a
live campaign here. Four things had to change before it could work at all:

-   **The client id was hardcoded in the browser bundle** (`client/constants.js`) — and
    it was TCO's, not ours. The authorization request went to somebody else's campaign.
    The client no longer carries a client id at all; the server builds the authorization
    URL from config.
-   **The `identity.memberships` scope was never requested.** Patreon then returns an
    identity with no membership records, so `getPatreonStatusForUser` sees no active
    patron and every linked account reports `linked`. Nobody could ever have reached
    `pledged`, which means the supporter role could never have been granted. This is the
    kind of failure that looks like "nobody has pledged yet" rather than like a bug.
-   **No campaign scoping** (above).
-   **No `state` parameter**, so the link flow had no CSRF protection at all.

## The flow

```
Profile ── POST /api/account/patreon/link/start ──▶ { url }
             │  signed httpOnly cookie {state, linkUserId}
        window.location.assign(url)
             ▼
        Patreon consent screen
             │  scope=identity identity.memberships
             ▼
        GET /patreon?code=…&state=…  (SPA route, client/pages/Patreon.jsx)
             │
             └─ POST /api/account/linkPatreon { code, state }
                     ├─ verifyLinkState: cookie signature + expiry, state equality,
                     │  and cookie's linkUserId === the authenticated user
                     ├─ exchange the code for tokens, store on the account
                     ├─ read the membership (campaign-scoped)
                     └─ grant/revoke the Supporter role
```

`state` is minted server-side, kept in a 10-minute signed httpOnly cookie pinned to the
requesting user id, and consumed on first use whether or not it validates. The user-id
pin is what stops a code obtained under one account being redeemed under another; the
same mechanism, for the same reason, as `server/api/oidc.js`.

`SameSite=lax` (not `strict`) because Patreon returns the player by a top-level
cross-site GET — `strict` would drop the cookie and every link would fail as expired.

## Where the pledge is re-checked

`POST /api/account/checkauth` runs on every auth refresh: it reads the pledge, refreshes
the Patreon access token if it has expired, and reconciles the Supporter role. So a
pledge that lapses on Patreon is reflected here within one refresh cycle without any
webhook.

Two guards on that sweep:

-   It only runs while the integration **is enabled**. Unconfigured, every account
    reports `none` and the sweep would revoke the supporter role from everyone who has
    it — including on a deployment that has never turned Patreon on.
-   `keepsSupporterWithNoPatreon` (admin-granted, per account) exempts an account
    entirely, for contributors and lifetime supporters who do not pledge.

Patreon webhooks would make this immediate rather than eventual. They were not used:
they need a publicly reachable endpoint with signature verification and a replay story,
and "within one refresh cycle" is well inside what the acceptance criteria ask for.

## Files

| File                                        | Role                                                   |
| ------------------------------------------- | ------------------------------------------------------ |
| `server/services/PatreonService.js`         | OAuth calls, campaign-scoped membership, tier readout  |
| `server/api/patreon.js`                     | Routes, `state` verification, supporter role sync      |
| `server/api/account.js`                     | `checkauth` re-check (the only remaining Patreon hook) |
| `client/Components/Profile/ProfileMain.jsx` | The Integrations row                                   |
| `client/pages/Patreon.jsx`                  | OAuth callback landing page                            |
| `config/default.json5` → `patreon`          | Every knob                                             |

## Endpoints

| Endpoint                               | Auth | Purpose                                  |
| -------------------------------------- | ---- | ---------------------------------------- |
| `GET /api/account/patreon/status`      | —    | `{ enabled, campaignUrl }`; gates all UI |
| `GET /api/account/patreon/me`          | JWT  | `{ status, tiers, amountCents }`         |
| `POST /api/account/patreon/link/start` | JWT  | `{ url }` + state cookie                 |
| `POST /api/account/linkPatreon`        | JWT  | Exchange the code (inherited path)       |
| `POST /api/account/unlinkPatreon`      | JWT  | Forget the token, drop the role          |

## Not in this increment

-   **Perks.** Which tier unlocks what (custom backgrounds, card backs, avatar frames,
    supporter badge, longer replay retention, larger import batches), editable from
    admin settings without a redeploy. The tier titles and entitled amount are already
    returned by `/api/account/patreon/me`, so this is a consumer of existing data.
    Per the roadmap, no perk may affect Amber, matchmaking or tournament eligibility.
-   **The "Support Archon Arena" page** — where the money goes, plus an opt-in
    supporter list.
-   **Webhooks** for immediate pledge changes (see above).
