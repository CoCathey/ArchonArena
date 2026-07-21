# Design: Decks of KeyForge SAS integration

Status: **Increment 1 shipped** — cached enrichment + deck page display. Admin settings
UI, richer AERC breakdowns, and lobby/pre-game display are follow-ups (ROADMAP Phase 4).

## Current TCO architecture (analysis)

Decks are imported from the Master Vault API through `DeckService.create()` →
`insertDeck()` and stored in PostgreSQL (`Decks`, `DeckCards`, `DeckHouses`). The
`master-vault-data/` package has DoK _card data_ converters, but the server has **no
deck-level SAS integration**: nothing stores or displays deck power.

## Proposed architecture

A small **DoK service** (`server/services/dok/DokService.js`) owning everything about
deck statistics:

```
POST /api/decks (import) ──▶ dokService.enrichDeck(uuid)      (fire-and-forget)
GET  /api/decks (+/:id)  ──▶ dokService.attachStats(decks)    (cached read +
                                                               bounded background refresh)
DoK public API ◀── fetch ── DokService ── upsert ──▶ "DeckSas" table (keyed by uuid)
```

### Why this shape

-   **Keyed by Master Vault UUID, not deck row**: the same physical deck imported by many
    users is many `Decks` rows but _one_ SAS record; one fetch serves everyone. It also
    gives the rating engine (Phase 5) a lookup that works at game time regardless of whose
    copy is playing.
-   **Separate `DeckSas` table, upstream tables untouched**: keeps upstream merges clean
    (per docs/UPSTREAM.md) and makes the whole feature droppable/rebuildable.
-   **API-layer hooks only** (marked `// ARCHON:` in `server/api/decks.js`): `DeckService`
    is upstream-owned and unmodified. Enrichment is not import's problem.
-   **Best-effort by design**: deck import never fails, and deck listing never blocks, on
    DoK being slow or down. Reads come from our table; refreshes happen in the background,
    bounded to 5 per request to prevent stampedes; every DoK/db failure degrades to
    "no SAS shown".
-   **`RawData jsonb` column**: DoK returns rich AERC components (amber control, expected
    amber, …). Storing the raw payload now means the statistics engine and AI analysis
    phases get full data without re-fetching under DoK rate limits.

## Admin-configurable parameters

`dok.enabled`, `dok.apiKey` (env `DOK_API_KEY`), `dok.apiUrl`, `dok.requestTimeoutMs`,
`dok.refreshDays` — file/env config today, settings-service driven later.

## Files changed

-   `server/services/dok/DokService.js` — new
-   `server/db/schema/24 - DeckSas.sql`, `server/db/schema/migrations/22 - DeckSas.sql` — new
-   `server/db/schema/00 - Roles.sql` — new (fixes fresh-DB init when the superuser isn't
    `keyteki`, which production compose hits)
-   `server/api/decks.js` — three `ARCHON:` hooks (attach on GET, enrich on POST)
-   `client/Components/Decks/DeckSummary.jsx` — SAS row when available
-   `config/default.json5`, `config/custom-environment-variables.json5`,
    `docker-compose.prod.yml`, `.env.production.example` — config plumbing
-   `test/server/services/dok/DokService.spec.js` — new (19 tests)

## Database migrations

`22 - DeckSas.sql`: `DeckSas(Uuid PK, SasRating, AercScore, AercVersion, RawData jsonb,
FetchedAt)`.

## API changes

`GET /api/decks` and `GET /api/decks/:id` responses now include `sasRating` and
`aercScore` per deck when known (absent otherwise — clients must treat as optional).

## Tests

`DokService.spec.js`: enable/disable logic, response parsing/rounding, API error /
network failure / malformed body paths, upsert wiring, refresh-window logic, batch
attach, background fetch bounding, db-failure resilience.

## Future considerations

-   **Refresh job**: a periodic sweep refreshing stale rows (instead of only
    request-triggered refresh) once there's a job runner; config already has `refreshDays`.
-   **Rate limiting**: DoK asks integrators to stay modest; if volume grows, funnel
    enrichment through a Redis-backed queue with a global rate cap.
-   **SAS-banded tournaments** (Phase 7) and **rating SAS lookup** (Phase 5) both read
    `DeckSas` by uuid — no new integration needed.
-   **AERC component display** on the deck page from `RawData`.
