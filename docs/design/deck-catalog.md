# Design: the Master Vault deck catalog

Status: **Shipped, off by default.** A background crawl walks Master Vault's global deck
registry and records uuid, name, expansion and houses for every deck that exists, so a
player can find their decks by typing a name. `catalog.enabled` is `false` until an
operator opts in.

## The problem

Master Vault has no per-user deck endpoint and no name lookup. The only identifier it
will answer to is a deck's uuid, which means that today the sole way to add a deck to
this site is to have its Master Vault link to hand. Players do not think about their
decks that way. They know a deck is called "Miss Onyx the Bewildering", and they have
five of them on a shelf.

Decks of KeyForge solved this years ago, and the way they solved it is instructive: they
crawled the entire Master Vault registry and built their own index. There is no shortcut
they know about that we do not. The catalog does the same thing for the one question we
need answered — which uuid is the deck with this name — and nothing else.

This is deliberately separate from SAS. DoK remains the source of deck statistics
(docs/design/deck-sas.md); the catalog is Master Vault only, and works on a server that
has no DoK key at all.

## The crawl

`GET /api/decks/v2?page=N&page_size=P&ordering=date` against
`www.keyforgegame.com`, oldest registration first, with the cursor persisted in
`DeckCatalogState`.

`ordering=date` ascending is the load-bearing choice. Under any other ordering — by name,
by newest first, by anything Master Vault computes — page N holds different decks
tomorrow than it does today, and a walk that pages forward through a shifting list silently
misses decks and revisits others with no way to tell which. Oldest-first means new decks
only ever append at the tail: page N holds the same decks forever, the cursor never has to
rewind, and a run that stops halfway costs nothing but the pages it did not reach.

A page is stored in one `INSERT ... ON CONFLICT DO NOTHING`, which is all the conflict
handling the table needs: a deck's name, set and houses are fixed at registration, so a
row we already hold is a row we already know. A **full** page advances the cursor; a
**short** page does not, because a short page means the walk has reached the decks
registered so far and the next run must ask for that same page again to pick up the ones
registered since. That state is recorded as `CaughtUp`, and it is what turns the job from
a multi-day backfill into a cheap tail poll that finds nothing most of the time.

`links=cards` is never requested. The catalog stores four fields, none of them cards, and
asking for cards would multiply every response by two orders of magnitude for data that
goes straight in the bin.

## Why an index and not whole decks

The tempting version of this feature crawls decks properly — cards and all — and then
importing a deck is a local copy with no Master Vault round-trip. Two things make that a
much worse deal than it looks.

**The row count.** A KeyForge deck is roughly 36 `DeckCards` rows. Master Vault passed
two million decks some time ago and only grows; at five million decks a full card crawl is
180 million-plus rows in a table whose primary key is an `integer` identity capped at
2,147,483,647 — under an order of magnitude of headroom on a counter that cannot be reset,
in a table that also holds the decks people actually play. The catalog as built is one
narrow row per deck, which at the same five million decks is a table Postgres finds
unremarkable.

**The second parser.** Master Vault's v2 list endpoint does not return cards per deck. It
returns them page-level, in a `_linked` block, with each deck carrying a list of card ids
to be joined against it. That is a different shape from the single-deck response
`DeckService.parseDeckResponse` already handles, so consuming it would mean writing a
second deck parser — one that must stay bug-compatible with the first forever, since a
deck imported through the crawl and the same deck imported by link have to produce
identical rows or games between them are not comparable. Two parsers for one format is a
maintenance liability that outlives whoever thought it was a good idea.

Fetching cards on demand through the existing single-deck path avoids both. Picking a
search result runs exactly the same import as pasting a link.

## Why `Expansion` has no foreign key

Every other deck table in this repo references `Expansions`. `DeckCatalog."Expansion"` is
a bare `integer` that is never validated, and that is not an oversight.

The crawler reaches decks in registration order, so it meets the first deck of a brand-new
set on the day that set goes on sale — weeks or months before this codebase has an
`Expansions` row for it. Under a foreign key that deck is an insert failure. And because
the crawl is a single ordered cursor rather than a set of independent jobs, it does not
skip the page and carry on: it stalls, permanently, at exactly the moment the index is
worth the most, which is release week, when every player is looking for the decks they
just opened.

So the catalog records whatever number Master Vault reported and asks no questions.
Whether an expansion is playable here is the import path's decision, and the import path
does check.

## The circuit breaker

`ConsecutiveFailures` and `PausedUntil` in `DeckCatalogState` back off the crawl on
errors, doubling from a minute to a cap of an hour. A `429` trips it on the **first**
occurrence rather than after a run of failures.

That is more aggressive than the crawl itself needs, and it is aggressive for a reason
that has nothing to do with the crawl. The crawler and every user-facing single-deck
import leave from the same address, and Master Vault meters the origin, not the job. A
crawler that keeps hammering through rate limits does not merely fail to index — it earns
the site a rate limit or an IP block, and takes ordinary deck import down with it. Players
adding a deck they want to play with right now are strictly more important than an index
nobody is waiting on, so the breaker spends hours of indexing to protect them. Backing off
too hard costs a delay in a background job; backing off too late costs the feature the
site actually depends on.

The same reasoning sets the defaults: one page every three seconds, ten pages per run,
runs every fifteen minutes. Far gentler than Master Vault would tolerate, because the
budget is shared with something that matters more.

Everything on `CatalogService` is best effort in the repo's usual sense — it logs and
returns a sentinel rather than throwing. A failed crawl must not take a lobby tick with
it, and a failed search must return no results rather than a 500 on the page players use
to add decks.

## The integrity consequence

Stated plainly, because it is the reason this ships off by default: **a searchable global
index means anyone can import any deck.** Today a player needs the link, which is a weak
control but a real one — it is a rough proxy for having the physical deck. Name search
removes it. Someone who reads a tournament report can find and import the deck it
describes.

Three things bound that, none of them new:

-   Imported decks are already `Verified = false`, and the existing usage-level
    heuristics already look at how many users hold a deck with the same name relative to
    `lobby.lowerDeckThreshold` (`DeckService.getFlaggedUnverifiedDecksForUser`). A deck
    that suddenly appears in many collections is exactly what that check is shaped to
    notice, and it notices catalog imports the same way it notices pasted ones.
-   `catalog.enabled` is off by default. An operator who does not want this does nothing.
-   `catalog.searchEnabled` is a separate switch, defaulting on, so an operator can build
    and maintain the index while leaving search unexposed — useful for an organiser who
    wants the data ready before deciding, and for one who wants the index kept current
    while the search box is hidden during an event.

Separating the two switches is the point: turning the crawl off is a decision about
outbound traffic to somebody else's service, and turning search off is a decision about
this site's UI. Neither should imply the other, and in particular stopping the crawl must
not make already-indexed decks unfindable.

None of this makes deck ownership provable. It was not provable before either; the link
requirement was a speed bump, and the honest position is that integrity here rests on the
usage heuristics and on tournament organisers checking physical decks, not on the
difficulty of guessing a uuid.

## The pg_trgm fallback

The right index for "find the deck whose name contains this" is a `pg_trgm` GIN index.
On managed Postgres the application role is routinely not permitted to `CREATE
EXTENSION`, and pg_trgm may not be installed at all — so a migration that assumes it can
create one is a migration that works on a VPS and fails on RDS, during a deploy, which is
the worst possible time to be debugging SQL.

So the migration creates two btree indexes that need nothing installed:

-   `lower("Name")` — exact lookup and collation-ordered listing, which is why `search()`
    orders by `lower("Name")` rather than `"Name"`: the ordering is then served by the
    same index as the match.
-   `lower("Name") text_pattern_ops` — prefix matching. It needs its own operator class
    because outside the C collation a default btree cannot serve `LIKE 'prefix%'` at all,
    and without it every keystroke is a sequential scan of every deck in existence.

`CREATE EXTENSION` and the GIN index each get their **own** `DO` block, with its own
`EXCEPTION WHEN OTHERS` raising a `NOTICE` and continuing. Either can be the one refused,
but they must not share a handler: a PL/pgSQL block with an `EXCEPTION` clause is a
subtransaction, so one handler around both means a failed index build — `maintenance_work_mem`,
disk, a lock timeout on a large table — rolls the extension back with it, while the notice
blames only the index. That leaves a database that could have had `pg_trgm` without it, and
strands the documented upgrade path, which is to install the extension and add a later
migration creating just the index. Verified on PostgreSQL 16: under one shared handler the
extension is gone afterwards; under two it survives.

`CatalogService.search` then has to know which of the two databases it is talking to,
because the fallback index only helps if the query is shaped to use it. A leading-wildcard
`LIKE '%term%'` cannot be served by a btree at all, trigram or no trigram — so a service
that always issued one would leave the `text_pattern_ops` index unused and sequentially
scan every deck in existence on every keystroke, which is precisely the outcome the
fallback exists to prevent. So `supportsTrigram()` looks the index up in `pg_indexes` once
and caches the answer, and the pattern follows:

-   trigram present → `%term%`, matching anywhere in the name, served by the GIN index.
-   trigram absent → `term%`, matching from the start, served by the `text_pattern_ops`
    btree.

Detection failing is treated as "absent": guessing wrong in that direction costs a
narrower search, and guessing wrong in the other costs a table scan per keystroke. The
pattern is lowercased in JavaScript rather than with `lower($1)` so the comparison is
unambiguously `lower("Name") LIKE <constant>` — the exact shape the btree can answer —
and `%`, `_` and `\` are escaped so a wildcard in a deck name is treated as the literal
character a player typing it meant.

`catalog.substringSearch` overrules the detection in either direction. It is config-only,
deliberately absent from the admin settings registry: forcing substring matching on a
database with no trigram index is a self-inflicted table scan, and that should require a
deploy by someone who knows what pg_trgm is, not a checkbox.

The API-level rate limit on search is the backstop for the same risk, bounding the damage
on instances that did not get a trigram index.

## Files

-   `server/services/catalog/CatalogService.js` — the crawler and search. `crawlOnce`
    (one bounded pass), `fetchPage`, `upsertDecks`, `getState` / `recordProgress` /
    `recordFailure` (cursor and breaker), `search`.
-   `server/db/schema/55 - DeckCatalog.sql` and
    `server/db/schema/migrations/51 - DeckCatalog.sql` — `DeckCatalog`,
    `DeckCatalogState` (single row, pinned by CHECK), and the index strategy above.
-   `config/default.json5` → `catalog` — crawl cadence, page size, delays, breaker
    thresholds, search cap.
-   `server/services/settings/registry.js` → `catalog` — the same knobs as runtime admin
    settings, so an operator can throttle or stop the crawl without a redeploy. That
    matters here because the reason to reach for them is usually that Master Vault is
    unhappy with us.
-   `server/lobby.js` — `runCatalogCrawl`, a one-minute tick that consults
    `crawlIntervalMinutes` on each pass (rather than baking the interval into
    `setInterval`, which would ignore an admin change until restart) and does nothing
    else: where the walk has got to and how hard it may push live in the crawler.
-   `server/api/decks.js` — `GET /api/decks/catalog/search`, which annotates results with
    `owned` from `DeckService.getOwnedDeckUuids` in a second query rather than a join,
    keeping the catalog table ignorant of user-owned decks.
-   `client/Components/Decks/DeckSearch.jsx` — the debounced search box; picking a result
    imports through the ordinary `saveDeck` mutation. `client/redux/api.js` →
    `searchDeckCatalog`.
