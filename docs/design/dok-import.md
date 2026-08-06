# Design: Bulk import a collection from Decks of KeyForge

Status: **Shipped.** A player pastes their own DoK API key and the site imports every
deck in their DoK library that they do not already have here. The CSV / pasted-links
route is kept alongside it for players who would rather not hand over a key.

## The problem

Master Vault has no dependable public "list all of a user's decks" endpoint — a user's
deck list there lives behind their own logged-in MV session. So the site cannot ask the
authoritative source what a player owns, and adding a collection one pasted link at a
time is the kind of chore that stops people finishing onboarding.

Decks of KeyForge already mirrors each user's registered decks, which makes it the
obvious source for the deck **list**. Each individual deck is still imported from Master
Vault, so a bulk-imported deck is byte-for-byte identical to one imported by pasting its
link.

## What DoK's public API actually offers

An earlier version of this document claimed DoK had no public way to list a user's decks
at all, and the code before it assumed a `POST /public-api/v1/decks/filter` endpoint that
does not exist. Both were wrong in different directions. Checked against DoK's open
source (`PublicApiEndpoints.kt`) and their own Sellers & Devs page, the public API
offers:

-   `GET /public-api/v3/decks/{id}` — single-deck lookup, which is what SAS enrichment
    uses (see docs/design/deck-sas.md).
-   `GET /public-api/v1/my-decks?page=N` — the decks DoK holds for **whoever's key is on
    the request**, 100 per page. There is a sibling `/public-api/v1/my-alliances`.
-   No listing by username, under any endpoint. That much of the old note was right, and
    it is a deliberate design on DoK's part: the collection returned is decided by the
    `Api-Key` header, so there is no way to ask for somebody else's.

That last point is what shapes everything below. Listing a collection is not something
the site can do on a player's behalf with its own credential; the player has to supply
theirs. DoK's documentation anticipates this and says third-party tools may ask users
for their key for exactly this purpose, which is why this is a supported integration
rather than a workaround.

## Flow

1.  **Prepare** — `POST /api/decks/import/dok/prepare` `{ dokApiKey }`:
    -   `DokService.listMyDecks` pages `GET {DoK}/public-api/v1/my-decks?page=N` with
        `Api-Key: <the user's key>`, collecting `{ uuid, name, sasRating }` until a page
        comes back empty, adds no new ids, or the safety cap (`dok.maxImportDecks`,
        default 500) is hit.
    -   Decks the user already owns (`DeckService.getOwnedDeckUuids`) are subtracted, and
        the remainder is returned.
2.  **Import** — the client (`DokImport.jsx`) imports each returned uuid through the
    ordinary `POST /api/decks` path (Master Vault fetch + `deckService.create`, which
    already dedupes and fires SAS enrichment), a few in parallel, with a live progress
    bar.

Splitting prepare (server, one set of DoK round-trips) from import (client loop over the
proven single-deck endpoint) keeps the whole feature **stateless** — no background jobs,
no in-memory progress that dies on restart or across lobby processes — and means one
battle-tested import path serves both single and bulk imports. A bulk import cannot
produce a deck that a single import could not, because it is the same code.

## The key is used transiently and never stored

The key exists for the duration of the prepare request and is then dropped. It is not
written to the database, not held in module state, and never logged. The rate limiter
buckets by a SHA-256 prefix of the key rather than the key itself for the same reason.

This costs the user a paste on every re-sync, and that is the intended trade. This
codebase has no encryption-at-rest helper, so "store it for convenience" means storing a
third party's credential in plaintext in a column, where it is one backup dump or one
over-broad admin query away from being a leak of an account on someone else's site. The
convenience saved is a few seconds; the exposure is unbounded, and it is not even our
exposure to accept on the user's behalf.

Storing it **encrypted** is a reasonable follow-up. It needs a key-management story
first (where the encryption key lives, how it rotates, what happens on restore from
backup), and that is a piece of infrastructure this repo does not have yet. When it
exists, an opt-in "remember my DoK key" checkbox turns re-sync into a single button.

## Rate limiting is per key, not per process

All outbound DoK calls pass through a sliding-window limiter capped at
`dok.maxRequestsPerMinute` (default 25, DoK's free tier; patron tiers are 50 / 100 /
250). The window is now **per `Api-Key`**, not one shared window for the process.

That distinction fixes a real bug rather than being tidiness. DoK meters its per-minute
cap against whichever key made the request. A player's `my-decks` paging spends _their_
DoK quota, not the site's — so charging it to the site-wide window would count requests
DoK never billed us for, and the visible effect is that one player importing a large
collection throttles SAS enrichment for every other player on the site, for no reason at
all. Per-key windows mean each credential gets exactly the budget DoK actually gives it.

Bucketing is by a hash of the key, and a bucket is deleted once its window drains, so the
map does not accumulate a row for every player who ever ran an import.

Within that budget the two kinds of call behave differently, because they answer to
different people:

-   Best-effort enrichment (`fetchDeckStats`) **skips** when the site key's budget is
    spent and retries on a later access (`needsRefresh` stays true). Nobody is waiting on
    it.
-   User-initiated listing (`fetchMyDecksPage`) **waits briefly** (bounded, 8s) for a
    slot before giving up, because somebody is watching a progress bar.

Two further things keep a bulk import cheap. The `my-decks` response already carries each
deck's SAS, so `listMyDecks` caches it (`cacheSummarySas`, `ON CONFLICT DO NOTHING`, so a
richer prior per-deck fetch is never clobbered); and `enrichDeck` skips decks whose stats
are already fresh, so the per-deck enrichment fired by `POST /api/decks` during the import
is a no-op for everything the list step just cached. Importing a 50-deck collection costs
one or two DoK calls rather than fifty.

**Scale note:** the limiter is per-process, which is correct for the current single-lobby
deployment. Multiple lobby processes would each hold their own windows; a Redis-backed
shared counter is the follow-up when the app scales horizontally.

## Collection import does not need the site's key

`isEnabled()` (SAS) requires `dok.enabled` **and** `dok.apiKey`. Collection import uses
`isImportEnabled()`, which requires only `dok.enabled`, because the credential it
authenticates with belongs to the user and arrives on the request.

The practical consequence is that a server which never obtained a `DOK_API_KEY` can still
offer collection import — players bring their own keys — while SAS enrichment on that
server correctly stays off. The two features have genuinely different prerequisites, and
gating them on the same check would have made the more widely usable one unavailable to
the deployments most likely to want it.

## The trap this creates for the operator

DoK issues **one key per account**, and generating a new one voids the previous one the
instant it is created. That is fine for a player, who has one key and one use for it. It
is a trap for whoever runs the server, because `DOK_API_KEY` — the credential that buys
SAS for every player — is very likely to have come from that person's own DoK account. If
they then follow this feature's own instructions and generate a key to sync their
collection, they have just revoked the site's key, and SAS quietly stops working for
everybody. The failure is not obviously connected to the action that caused it, which is
what makes it worth writing down.

This was not hypothetical: it happened on the first production deploy of this feature, and
surfaced as `healthcheck.sh` reporting `DoK rejected the API key (HTTP 403)`.

The obvious guard — "don't generate a key, copy the one you already have" — **is not
possible**, and the first attempt at this shipped that advice before checking. DoK has no
endpoint that returns an existing key: `PublicApiStore` exposes only a `POST` that mints a
new one, and `SellersAndDevs` sets `apiKey = undefined` on mount, so the page displays a
key solely in the moment it is created. A key you did not write down is unrecoverable.

So the rule has to be **generate once, then reuse that string everywhere**, and generating
has to be treated as a rotation that must be propagated:

-   The in-app instructions say to generate, copy immediately, and reuse the same key
    anywhere else DoK is used — naming `DOK_API_KEY` explicitly, because the operator is
    the person most likely to have a second use and least likely to connect the symptom
    to the cause.
-   `.env.production.example` says this key and any key pasted into the sync box must be
    the same string, and suggests a DoK account dedicated to the server so an operator
    rotating their personal key cannot take site-wide SAS down with them.
-   The healthcheck's fix hint describes recovery as a rotation rather than telling the
    operator to find a key that cannot be found, and gives a probe that distinguishes a
    rejected key from Cloudflare blocking the host, since both present as `403`.

## CSV and pasted links stay

The same component still accepts a DoK "Download Decks Spreadsheet" CSV (whose first
column is `keyforge_id`) or pasted DoK / Master Vault links and raw ids: it pulls every
Master Vault uuid out with a regex, dedupes, and feeds the identical import loop.

This is not legacy code kept out of politeness. Handing a third-party API key to a game
site is a real thing to ask of someone, and a player who would rather not is entitled to
a way in that involves no credential at all. The CSV route also works when DoK is down,
and when `dok.enabled` is off entirely. Both routes converge on the same list of uuids
and the same import loop, so keeping the second one costs a file input.

## Resilience

-   `listMyDecks` never throws: `{ configured: false }` when DoK import is off,
    `{ error: true, errorDetail }` when the very first page fails (retryable, and the
    detail distinguishes a rejected key from a timeout), and a partial-but-usable list
    when a later page fails.
-   HTTP status is translated into something a player can act on — 401/403 becomes "API
    key rejected" rather than a bare number.
-   Deck-id parsing is defensive. Each entry is a `PublicMyDeckInfo` wrapping the deck, so
    the parser reads `entry.deck` and falls back to the entry itself, takes `keyforgeId`
    only when it is UUID-shaped, and drops anything else.
-   Paging stops when a page returns no _new_ ids (guarding against an endpoint that
    ignores paging), plus a hard 100-page ceiling on top of the deck cap.
-   `POST /api/decks/import/dok/prepare` is rate-limited per user. That limit now exists
    to stop the site hammering DoK on one user's behalf, not to protect our own SAS
    budget — per-key windows already handle the latter.
-   The client import runs at concurrency 3 to be gentle on Master Vault.

## Config (`dok` section, admin-tunable)

-   `myDecksUrl` — collection endpoint (derived from the `apiUrl` origin when unset).
-   `maxImportDecks` — per-import safety cap (default 500).
-   `maxRequestsPerMinute` — per-key outbound DoK cap (default 25; raise it to match your
    DoK patron tier: 50 / 100 / 250).
-   Existing `enabled`, `apiKey`, `apiUrl`, `requestTimeoutMs`, `refreshDays`.

## Where it appears

-   **Onboarding** step 3 ("Import your decks") leads with collection import, with the
    single-link paste below.
-   **Decks page** import modal: "Import your whole collection" above single-deck import,
    now alongside catalog name search (docs/design/deck-catalog.md), which is the route
    for players who do not use DoK at all.

## Historical

The `/public-api/v1/decks/filter` code — `DokService.getFilterUrl`, `fetchOwnerDeckPage`
and `listOwnerDecks`, and the `dok.filterUrl` config key — **has been deleted**. That
endpoint does not exist in DoK's public API and never did; the code was written against
an assumed shape, could only ever have returned 404, and its continued presence was the
main reason this document stayed wrong. Do not resurrect it. If a by-username listing is
ever wanted, check `PublicApiEndpoints.kt` first — as of this writing there is no such
endpoint at any version.

`Users.DokUsername` (schema `37 - DokUsername.sql`, migration `30 - DokUsername.sql`) and
`UserService.setDokUsername` survive as unused columns and an unused setter. They are
harmless, and dropping a column is a migration with more risk than leaving it; but
nothing writes `DokUsername` any more, and nothing should. There is no username in this
flow.

## Files

-   `server/services/dok/DokService.js` — `getMyDecksUrl`, `fetchMyDecksPage`,
    `listMyDecks`, `isImportEnabled`, `cacheSummarySas`, and the per-key
    `reserveOutboundSlot` window.
-   `server/services/DeckService.js` — `getOwnedDeckUuids`.
-   `server/api/decks.js` — `POST /api/decks/import/dok/prepare` and its rate limit.
-   `client/Components/Decks/DokImport.jsx` — both routes in (key, CSV/paste) and the
    shared import loop; wired into `pages/Decks.jsx` and `pages/Onboarding.jsx`.
-   `client/redux/api.js` — `prepareDokImport`.
-   `config/default.json5` → `dok` — every knob.
-   `test/server/services/dok/DokService.spec.js`.
