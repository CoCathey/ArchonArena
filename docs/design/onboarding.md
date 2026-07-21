# First-run onboarding wizard

## Goal

New players land in an empty experience: no location (so no regional
leaderboard placement), no club, no decks (so they cannot play), and no
avatar. The wizard walks a fresh account through all four in under a
minute, chess.com-style, with every step skippable.

## When it shows

-   `Users.OnboardedAt` (timestamp, null = wizard not completed). The flag
    travels on the wire-safe user payload as `onboarded`, so both login
    paths can act on it without extra requests.
-   After a successful password or SSO login, the client navigates to
    `/welcome` instead of `/` when `onboarded === false`.
-   The Lobby also redirects un-onboarded users, covering sessions that
    restore from a stored token (user closed the tab mid-wizard).
-   Finishing **or skipping** the wizard stamps `OnboardedAt`
    (`POST /api/account/onboarded`, idempotent) - the wizard never nags a
    player twice, and `/welcome` stays reachable manually.
-   The release migration backfills `OnboardedAt` for all existing users so
    only accounts registered after this release see the wizard.

## Steps

1. **Where are you from?** Country + state selectors feeding the existing
   `PUT /api/account/location` (Phase 6 rankings).
2. **Join a club.** Two paths: an invite code (new) or search + join
   (existing club endpoints).
3. **Import decks.** Master Vault link/code via the existing
   `POST /api/decks` (SAS enrichment fires automatically).
4. **Profile picture.** New lightweight `PUT /api/account/avatar`.

## Club invite codes

-   `Clubs.JoinCode`: 8 characters from an alphabet that omits `0/O/1/I/L`
    (31 symbols, ~8.5e11 combinations), generated server-side at club
    creation with a collision re-roll loop and a partial unique index as
    the backstop. Existing clubs are backfilled by the migration.
-   `POST /api/clubs/join-by-code` normalizes input (case, dashes, spaces)
    then reuses the ordinary join path.
-   Only the club owner sees the code (club detail response + club page
    with copy button). Codes are shareable invites, not secrets; owner-only
    visibility just keeps the sharing decision with the owner.

## Why a dedicated avatar endpoint

The existing avatar path is buried in `PUT /api/account/:username`, which
replaces the whole profile (email, settings, password checks). A wizard
should not assemble that payload just to set a picture.
`PUT /api/account/avatar` accepts a base64 image and reuses the exact
same validation (`isValidImage`) and processing (`processAvatar`)
exported from `server/api/account.js` - one pipeline, two entry points.

## Files

-   `server/db/schema/36 - Onboarding.sql`, `migrations/29 - Onboarding.sql`
-   `server/api/onboarding.js` (complete + avatar), registered in `api/index.js`
-   `server/services/UserService.js` (`setOnboarded`, `onboarded` mapping)
-   `server/models/User.js` (`onboarded` on wire-safe details)
-   `server/services/community/ClubService.js` (join codes)
-   `client/pages/Onboarding.jsx` at `/welcome`; redirects in
    `LoginContainer.jsx` and `Lobby.jsx`; invite-code panel in
    `ClubDetail.jsx`; RTK endpoints + account-slice matchers.
