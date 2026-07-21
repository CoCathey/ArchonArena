# Bulk & live import from Decks of KeyForge

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

## Config (`dok` section, admin-tunable)

-   `filterUrl` — collection filter endpoint (derived from `apiUrl` origin
    if unset).
-   `maxImportDecks` — per-import safety cap (default 500).
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
