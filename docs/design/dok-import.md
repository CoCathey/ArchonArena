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
2.  **Import** — prepare hands the remaining uuids to a server-side job, and a sweep in
    the lobby imports them a few at a time through the ordinary `deckService.create`
    path (Master Vault fetch, dedupe, SAS enrichment). The client polls the job and is
    free to close the modal.

Splitting prepare (server, one set of DoK round-trips) from import (client loop over the
proven single-deck endpoint) keeps the whole feature **stateless** — no background jobs,
no in-memory progress that dies on restart or across lobby processes — and means one
battle-tested import path serves both single and bulk imports. A bulk import cannot
produce a deck that a single import could not, because it is the same code.

**The statelessness half of that paragraph no longer holds**, and it is left standing
because the decision it records is one worth being able to find. The import step is now a
persisted job; step 2 above describes what replaced it, and "The import runs on the
server now" below says what changed. The shared-import-path half is untouched, and is
still the reason a bulk-imported deck and a pasted one are the same deck.

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

## The import runs on the server now

The import loop used to live in the browser: prepare returned uuids and `DokImport.jsx`
posted them back to `POST /api/decks` a few at a time. Master Vault meters deck fetches
hard enough that a 257-deck collection takes minutes, which made the import a property of
a modal staying open for minutes. Closing it, following a link, or letting a phone sleep
the tab ended the import wherever it had got to.

That is the ordinary outcome, not an unlucky one, and the distinction is the whole
argument. A player who abandons a five-second job is behaving strangely; a player who
will not sit and watch a five-minute one is behaving normally. The feature was asking for
attention it had no right to.

The damage was smaller than it sounds and worse than it looks. Decks that had landed
stayed landed, and re-running prepare subtracts them, so a second attempt did resume in
effect — but only for a player who knew to try again, and nothing told them whether the
import had finished or died, because the progress bar left with the modal. "Did that
work?" is not a question a collection import should leave anybody holding.

So the loop moved to the server and became a row. Prepare is unchanged in shape: it still
lists the collection synchronously with the player's key, still subtracts the decks they
already own. What it does with the remainder is different — instead of handing uuids back
to the browser it creates a job holding them. A sweep in the lobby claims the oldest due
job and imports a few of its decks per pass, through the same `deckService.create` a
single paste uses. The client polls `GET /api/decks/import/status` and may close the
modal, navigate away, or come back tomorrow; `POST /api/decks/import/cancel` exists for a
player who changes their mind, which is now a deliberate act rather than a side effect of
dismissing a dialog.

Pacing improves as a side effect, and by more than the move looks like it should. Ten
browsers each spacing their own requests politely still arrive at one origin as ten times
one browser's traffic, and no browser can see the other nine. Master Vault meters the
origin. One worker with one queue is the only place that rate is a number anybody can
hold, let alone tune.

### The key is still never stored, and nothing had to be careful about it

Deferring work usually means storing the credential the work needs, and that would have
been fatal here — the section above spends several paragraphs on why a DoK key must not
be written down, and a background importer that needed one would have forced exactly the
thing that section refuses.

It does not need one, for a reason worth stating plainly because the entire design hangs
off it. The key authenticates one question: which decks this player owns on DoK.
Importing a deck asks a different service an unrelated question, and Master Vault has
never heard of Decks of KeyForge, let alone its API keys — it would not know what to do
with one if the job carried it. So the only thing the listing step produces that the
import step consumes is uuids, and a uuid is a public identifier that appears in the
deck's own URL.

The job therefore holds uuids and nothing else, and the key falls out of scope when the
prepare request returns, exactly as it did when the import ran in the browser. This is
not a rule anyone has to keep remembering: there is no key column on `DeckImportJobs` to
populate, so a later change cannot start storing one by accident — it would first have to
decide to add somewhere to put it.

### Why the state is in Postgres

An in-memory job would have been less code and the wrong shape for the failure this
change exists to fix. The lobby restarts on every deploy. A job living in a process dies
with it, and the player it belonged to is precisely the player who closed the modal
because we told them they could: no page open, no progress bar, no way to tell an import
that finished from one that evaporated. That is the original bug with a longer fuse and a
better excuse.

**This reverses the "stateless, no background jobs" decision recorded above**, and the
reversal deserves an honest account, because the earlier reasoning was not wrong.
Statelessness is close to free when the work is short: a request that can carry the whole
job needs no cursor to persist, no restart to survive, and leaves no row in a state
nobody expects. What changed is not the principle but the measurement. This job is not
short. At minutes per collection the browser stopped being a place work could safely
live, and the price of statelessness stopped being "one fewer table" and became "the
import breaks whenever a player behaves reasonably". The work outgrew the argument.

### One live job per user is a database constraint

Two live jobs for one player would work the same collection twice: racing on the same
decks, each counting the other's imports as its own progress, and between them doubling
that player's draw on the Master Vault budget every other importing player is queued
behind. So `DeckImportJobs` carries a unique index on `"UserId"`, partial to
`"Status" IN ('pending', 'running')`.

It is an index rather than a check in `DeckImportJobService` because the service cannot
enforce it. "Does this user already have a job?" followed by "then insert one" is two
statements, and two processes interleave them as readily as one runs them in order — an
application-level check is a check that both callers pass at once. Being partial also
supplies the release condition for free: finishing or cancelling a job drops it out of
the index, so completed imports pile up as history without ever blocking the next one.
`createJob` cancels before it inserts for exactly that reason, and if the cancel fails the
index refuses the insert and the player is told their import could not start — the right
answer, and a much better one than two jobs racing.

### The circuit breaker tells a bad deck from a bad moment

`deckService.create` fails in two quite different ways and the sweep has to tell them
apart. A deck from an expansion the engine does not implement, or one the player already
has, is a fact about that deck: it will fail identically forever. So the cursor advances
past it, the reason is counted into `Reasons`, and the collection carries on. One
unimportable deck must not wedge the two hundred behind it.

An `upstream_rate_limited` error is not a fact about the deck at all. It is a fact about
the minute we asked in, and the deck it interrupted was never read. So it ends the batch
**without advancing the cursor**, and the job is parked by setting `PausedUntil`, which
takes it out of the sweep's claim query until the backoff expires. The throttled deck is
the first one attempted when the job is next claimed. That is the point of not advancing:
a cursor that stepped over it would quietly drop a deck the player owns from their
collection on the grounds that Master Vault was busy, and nothing downstream would ever
notice, because a skipped deck and an absent deck look identical.

Backoff doubles per consecutive failure from `backoffBaseMs` (a minute) to `backoffMaxMs`
(half an hour), and the cap matters more than the curve. Somebody is waiting on this job
even though they are no longer watching it, so a backoff that keeps doubling through the
night would turn a minute of Master Vault being unhappy into an import that never
visibly resumes. A batch that succeeds clears the counter, because the upstream answering
is the only evidence that matters and a failure count left over from an outage half an
hour ago would park a job that is plainly fine.

### Files

-   `server/services/deckimport/DeckImportJobService.js` — the job's whole lifecycle:
    `createJob`, `claimNextJob`, `recordProgress`, `pauseJob`, `finishJob`,
    `cancelActive`, `backoffMs`. `claimNextJob` is a single
    `UPDATE ... WHERE "Id" = (SELECT ... FOR UPDATE SKIP LOCKED)` so that two lobby
    processes claim different jobs instead of both working one. Best effort throughout in
    the repo's usual sense — it logs and returns a sentinel, because a failed query here
    must not throw into a lobby tick or into the status poll a player is watching.
-   `server/db/schema/57 - DeckImportJobs.sql` and
    `server/db/schema/migrations/53 - DeckImportJobs.sql` — the table, the partial
    live-job index above, and the `("Status", "CreatedAt")` index the claim query walks.
    The file's comments carry the column-level reasoning: why `Username` is denormalised,
    why `Uuids` is one write-once blob, and why there is no key column.
-   `server/lobby.js` — `runDeckImportSweep`, which is only the clock and the batch.
    Which decks remain, how fast to pull them and whether the job is parked all live in
    the row and the service, the same division as `runCatalogCrawl`. It logs a job
    finishing or being parked and stays quiet about ordinary batches, because a log that
    narrates every five decks of a 250-deck import is a log nobody reads.
-   `config/default.json5` → `deckImport` and `server/services/settings/registry.js` →
    `deckImport` — `enabled`, `decksPerTick`, `requestSpacingMs`, `sweepIntervalSeconds`,
    the backoff bounds, and `maxJobDecks`. Admin-tunable for the reason the catalog's
    knobs are: the occasion for reaching for them is usually that Master Vault is unhappy
    with us, and that is not a moment to need a redeploy. Unlike the crawl, `enabled`
    defaults **on** — this is the machinery behind a button players already press, not an
    outbound job nobody asked for, so an instance that upgrades must not quietly lose
    collection import to an unset flag.
-   `server/api/decks.js` — `POST /api/decks/import/dok/prepare` (unchanged up to the
    point where it creates a job instead of returning uuids),
    `POST /api/decks/import/queue` for the CSV and pasted-link routes, which arrive
    already holding uuids, `GET /api/decks/import/status`, and
    `POST /api/decks/import/cancel`.
-   `client/Components/Decks/DokImport.jsx` — polls the job instead of driving it, and
    `client/redux/api.js` → `queueDeckImport`, `getDeckImportStatus`, `cancelDeckImport`.
-   `test/server/services/deckimport/DeckImportJobService.spec.js`.

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
-   The import itself is paced by the lobby sweep rather than by the browser
    (`decksPerTick`, `requestSpacingMs`), which is both gentler on Master Vault and a rate
    that exists as a number somewhere instead of being whatever the open tabs add up to.

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
-   `client/Components/Decks/DokImport.jsx` — both routes in (key, CSV/paste), now
    handing off to the background job rather than looping itself; wired into
    `pages/Decks.jsx` and `pages/Onboarding.jsx`.
-   `client/redux/api.js` — `prepareDokImport`.
-   `config/default.json5` → `dok` — every knob.
-   `test/server/services/dok/DokService.spec.js`.

The background import's own files — the job service, its table, the lobby sweep, the
`deckImport` config and the status endpoints — are listed under "The import runs on the
server now" above.

## Remembering the key

A player may ask us to keep their Decks of KeyForge key so their collection
refreshes itself, with a **Sync now** button for when they do not want to wait.
This reverses the "the key is never stored" decision recorded above, and it was
reversed deliberately rather than drifted into: buying a deck happens far more
often than anyone wants to go and find an API key, and DoK cannot show a player
a key they have already generated, so "just paste it again" is a worse ask here
than it looks.

Three things shape how it is stored.

**It is sealed, not stored.** `server/services/crypto/secretBox.js` is
AES-256-GCM with a key derived from the site secret. GCM rather than an
unauthenticated mode because a leaked database is exactly the threat, and
tampering should be a decryption failure rather than a silently altered value.
The stored form is `v1.<iv>.<tag>.<ciphertext>`, so a later scheme can live
beside this one — and anything not in that form is passed through unchanged,
which is what let `Users.PatreonToken` move onto the same seal without a rewrite
migration over rows that may no longer be decryptable. Tokens written before the
change still read; they are sealed the next time they are written.

Rotating the site secret makes stored secrets unreadable, and that is a
survivable outcome by design: an unreadable DoK key is dropped and the player is
asked for a new one, an unreadable Patreon token costs a supporter badge until
they relink. Neither throws, because both sit on paths (a status poll, building
every user object) where a throw would be a broken page or a failed login.

**A rejection is terminal, not a retry.** DoK issues one key per account and
generating a new one voids the previous instantly, so a stored key dies whenever
the player generates another anywhere — something that has already happened once
on this deployment, taking the site's own `DOK_API_KEY` with it. `DokService`
therefore reports a machine-readable `errorCode` alongside its prose, and a
`key_rejected` stops the schedule, drops the dead key and sets
`Users.DokKeyRejectedAt`, which is what the import dialog reads to ask for a new
one. Matching on the wording would have made that distinction a property of an
error message somebody will reword. Retrying a refused key can never succeed and
only spends a rate limit finding out.

**Auto-sync is opt-in and does not import anything itself.** The checkbox is
separate from using a key, so pasting one to import once does not enrol anybody
in us keeping their credential. The sweep does only the cheap half — list the
collection, subtract what is owned, queue a job — and the deck-import worker
does the Master Vault work, so however many collections are listed, Master Vault
still sees one paced queue with one circuit breaker. Listing more collections
per run would lengthen that queue rather than make anything arrive sooner, which
is why `dok.autoSyncPerRun` is small.

Every DoK key the site sends, its own and each player's, is held to the free
tier's 25 requests a minute. That is a ceiling in code rather than a
configurable default: the windows enforcing it are per lobby process, so two
lobbies each trusting a configured patron tier would send double it, and which
tier a key really has is DoK's business rather than our config's.

### Files

-   `server/services/crypto/secretBox.js` — the seal, with the plaintext
    passthrough that makes adopting it migration-free.
-   `server/services/dok/DokLinkService.js` — storing, unsealing, syncing, and
    the rejection handling.
-   `server/db/schema/58 - DokAccountLink.sql` and
    `server/db/schema/migrations/54 - DokAccountLink.sql`.
-   `server/services/UserService.js` — the link columns, and the Patreon token
    on the same seal.
-   `server/lobby.js` — `runDokAutoSync`.
-   `server/api/decks.js` — the link, sync and forget endpoints.
-   `client/Components/Decks/DokImport.jsx` — the opt-in, Sync now, Forget key,
    and the rejected-key state.
