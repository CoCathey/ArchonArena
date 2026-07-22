# Bulk import from a Decks of KeyForge CSV / pasted links

> **Update.** The original design imported a collection by DoK username via a
> DoK "filter" API. That endpoint does not exist in DoK's **public** API —
> their public API (confirmed from their open source, `PublicApiEndpoints.kt`)
> is single-deck lookup only (`GET /public-api/v3/decks/{id}`), which is what
> SAS enrichment uses. There is no public "list a user's decks by username".
> Bulk import now works entirely client-side from a **DoK CSV export** (or
> pasted deck links / ids) and needs no DoK API at all. The server
> owner-listing code below is retained but unused.

## How it works now

`client/Components/Decks/DokImport.jsx` takes a file (the DoK "Download Decks
Spreadsheet" CSV, whose first column is `keyforge_id`) or pasted text (DoK or
Master Vault deck links, or raw ids), extracts every Master Vault UUID with a
regex, dedupes, and imports each through the ordinary `POST /api/decks` path
(Master Vault fetch + SAS enrichment), a few in parallel with a progress bar.
Decks already owned are skipped server-side ("Deck already exists"), so
re-running only adds new decks. No DoK API key, rate limit, or network
dependency on DoK is involved in the import itself.

---

## (Historical) username-based bulk import

## Goal

Let players pull their **entire** deck collection in instead of pasting
one Master Vault link at a time, and keep SAS wired up. A player enters
their Decks of KeyForge (DoK) username; we fetch their whole DoK library
live and import every deck they don't already have. Re-running only
imports newly-added decks, so the same action doubles as an ongoing
"sync" with DoK.

## Why DoK (not Master Vault) for the collection list

Master Vault has no dependable public "list all of a user's decks"
endpoint — a user's deck list there requires their own logged-in MV
session. DoK, by contrast, publishes a filter API intended for exactly
this (see decksofkeyforge.com/about/sellers-and-devs), and DoK already
mirrors each user's registered decks. So DoK is the source of the deck
**list**; each individual deck is still imported from Master Vault (the
authoritative source our engine parses), keeping imported decks byte-for-
byte identical to a normal single-deck import.

## Flow

1. **Prepare** — `POST /api/decks/import/dok/prepare` `{ dokUsername }`:
    - `DokService.listOwnerDecks` pages `POST {DoK}/public-api/v1/decks/filter`
      with `{ owner, page, pageSize, sort }` and the site `Api-Key` header,
      collecting `{ uuid, name, sasRating }` until the collection runs dry
      or a safety cap (`dok.maxImportDecks`, default 500) is hit.
    - We subtract the decks the user already owns
      (`DeckService.getOwnedDeckUuids`) and return the remainder.
    - The DoK username is stored on the user (`Users.DokUsername`) for
      future syncs and to prefill the field.
2. **Import** — the client (`DokImport.jsx`) imports each returned uuid
   through the existing `POST /api/decks` path (Master Vault fetch +
   `deckService.create`, which already dedupes and fires SAS enrichment),
   a few in parallel, with a live progress bar.

Splitting prepare (server, one DoK round-trip set) from import (client
loop over the proven single-deck endpoint) keeps the whole thing
**stateless** — no background jobs, no in-memory progress that dies on
restart or across lobby processes — and reuses one battle-tested import
path for both single and bulk imports.

## The site-wide API key

The DoK `Api-Key` (env `DOK_API_KEY`, already used for SAS enrichment) is
sufficient to read a user's _public_ decks by owner, so **individual
players do not need their own DoK key** — they just supply their DoK
username. If `DOK_API_KEY` is unset the prepare endpoint returns a clear
"not configured on this server yet" message and single-deck Master Vault
import still works.

## Resilience

-   `listOwnerDecks` never throws: a first-page failure is reported as a
    retryable error; a later-page failure returns a partial-but-usable
    list; DoK being down never blocks anything.
-   Deck-id parsing is defensive: it takes `keyforgeId` (or a UUID-shaped
    `id`) and skips anything without a valid Master Vault uuid.
-   Paging stops if the endpoint ever returns no _new_ ids (guards against
    a filter that ignores paging), plus a hard 100-page ceiling.
-   The client import runs at concurrency 3 to be gentle on Master Vault.

## Rate limiting (DoK's per-minute cap)

DoK bills a single site-wide `Api-Key` and caps it at 25 requests/minute on
the free tier (50 / 100 / 250 for patron tiers). All outbound DoK calls —
per-deck SAS enrichment **and** the bulk-import list calls — pass through
one **process-wide sliding-window limiter** (`reserveOutboundSlot`, shared
across every `DokService` instance, since the key is shared):

-   `maxRequestsPerMinute` (config + admin settings, default 25) is the cap.
    Bump it to match your DoK subscription with no redeploy.
-   Best-effort enrichment (`fetchDeckStats`) **skips** when the budget is
    spent and retries on a later access (`needsRefresh` stays true) — it
    never queues or blocks.
-   User-initiated list calls (`fetchOwnerDeckPage`) **wait briefly**
    (bounded) for a slot rather than skipping, then give up gracefully.

Two changes keep bulk import from devouring the budget:

1.  The filter/list response already includes each deck's SAS, so
    `listOwnerDecks` caches it (`cacheSummarySas`, `ON CONFLICT DO NOTHING`)
    — a whole-collection import gets SAS from the couple of list calls it
    already made, not one call per deck.
2.  `enrichDeck` skips decks whose stats are already fresh, so the per-deck
    enrichment fired by `POST /api/decks` during a bulk import is a no-op
    for decks the list step just cached.

Net effect: importing a 50-deck collection costs ~1–2 DoK calls instead of
50+, and nothing the app does can exceed the configured per-minute cap.

**Scale note:** the limiter is per-process, correct for the current
single-lobby deployment. Multiple lobby processes would each hold their own
window; a Redis-backed shared counter is the follow-up when the app scales
horizontally.

## Config (`dok` section, admin-tunable)

-   `filterUrl` — collection filter endpoint (derived from `apiUrl` origin
    if unset).
-   `maxImportDecks` — per-import safety cap (default 500).
-   `maxRequestsPerMinute` — outbound DoK request cap (default 25; set to
    your DoK patron tier: 50 / 100 / 250).
-   Existing `enabled`, `apiKey`, `requestTimeoutMs`, `refreshDays`.

## Where it appears

-   **Onboarding** step 3 ("Import your decks") leads with DoK bulk import,
    single-link paste below.
-   **Decks page** import modal: "Import your whole collection" (DoK) above
    the single-deck link import.

## Field mapping caveat

The DoK filter response is parsed defensively for the Master Vault id
(`keyforgeId`, fallback UUID-shaped `id`). If DoK renames that field, only
`DokService.fetchOwnerDeckPage` needs adjusting.

## Files

-   `server/services/dok/DokService.js` — `getFilterUrl`, `fetchOwnerDeckPage`,
    `listOwnerDecks`.
-   `server/services/DeckService.js` — `getOwnedDeckUuids`.
-   `server/api/decks.js` — `POST /api/decks/import/dok/prepare`.
-   `server/services/UserService.js` / `server/models/User.js` — `DokUsername`
    mapping + `setDokUsername`; `dokUsername` on wire-safe details.
-   `server/db/schema/37 - DokUsername.sql`, `migrations/30 - DokUsername.sql`.
-   `client/Components/Decks/DokImport.jsx`; wired into `pages/Decks.jsx` and
    `pages/Onboarding.jsx`; RTK `prepareDokImport`.
