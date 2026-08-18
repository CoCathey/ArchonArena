const logger = require('../../log');

// Master Vault's own deck list, not a Decks of KeyForge endpoint. DoK indexes
// every deck that exists by walking this exact list (KeyforgeApi.kt /
// DeckImporterService.kt), so the catalog is built from the registry itself
// rather than from somebody else's copy of it - and it works on a server that
// never bought a DoK key.
const MV_API_URL = 'https://www.keyforgegame.com/api/decks/v2/';

// Master Vault is a Django service, and Django hands out the same HTTP 404
// for three different questions, two of which this crawl has now asked:
//
//  - `/api/decks/v2?page=1` - no trailing slash - is a 404 while
//    `/api/decks/v2/?page=1` is the deck list. The crawl asked without the
//    slash for its whole life and indexed nothing, while single-deck fetches
//    (spelled `/<uuid>/?links=cards`, carrying one by accident) worked the
//    entire time.
//  - `?page=0` is a 404 too: Django's pages are numbered FROM 1, and an
//    invalid page number gets the same answer as a wrong path. The crawl's
//    cursor started at 0, so after the slash was fixed it went on asking a
//    perfectly healthy endpoint for a page that cannot exist, reading the 404
//    as "wrong address", "failing" on every candidate below, and tripping its
//    own breaker. Page numbering is crawlOnce's job; it counts from 1.
//  - A page past the end of the list is the third - see fetchPage, which is
//    what keeps that one from reading as an outage.
//
// Faults like these are invisible to retrying, so the URL is resolved rather
// than assumed: the shapes below are tried in order until one answers with a
// deck list, and the winner is remembered for the rest of the process.
//
// Ordered most to least specific. An operator override (`catalog.mvApiUrl`)
// always goes first - it is the escape hatch for the day Master Vault moves
// again and this list is wrong.
const MV_API_CANDIDATES = [MV_API_URL, 'https://www.keyforgegame.com/api/decks/'];

// Master Vault is somebody else's service and is entitled to know who is
// asking. An unidentified client is also the first thing an operator blocks.
const MV_USER_AGENT = 'ArchonArena/1.0 (+https://archonarena.com)';

/**
 * The Master Vault deck catalog: a name -> uuid index of every deck that
 * EXISTS, so a player can find their decks by name instead of pasting a Master
 * Vault link (docs/design/deck-catalog.md).
 *
 * Design constraints:
 *  - Master Vault has no "my decks" endpoint of any kind, and no name search.
 *    The only way to answer "which deck is called Miss Onyx the Wanderer" is to
 *    have already walked the global list, which is what this crawls.
 *  - The walk is ordered by registration date, oldest first. That is the
 *    load-bearing property: page N holds the same decks forever and new decks
 *    only ever append at the tail, so the persisted cursor never has to rewind
 *    and a run that stops halfway costs nothing but the pages it did not reach.
 *  - `links=cards` is deliberately never requested. DoK needs card lists; a
 *    search result needs a name, and asking for the cards would multiply every
 *    response by two orders of magnitude for data this table does not store.
 *  - Crawling is one job with one cursor, and every method here is best effort:
 *    a crawl or a search that fails must degrade to "no new rows" / "no
 *    results", never to an exception in a lobby tick or an API handler.
 *  - The db adapter is injected to keep the service unit-testable.
 */
class CatalogService {
    constructor(configService, db = require('../../db'), settingsService = require('../settings')) {
        this.configService = configService;
        this.db = db;
        this.settingsService = settingsService;
        // null = not yet checked; see supportsTrigram.
        this.trigramAvailable = null;
        // Latches true once the catalog has rows; see hasIndexedDecks.
        this.catalogPopulated = false;
    }

    getConfig() {
        // Runtime admin overrides (SiteSettings) win over file config.
        return {
            ...(this.configService.getValue('catalog') || {}),
            ...this.settingsService.getSection('catalog')
        };
    }

    isEnabled() {
        return !!this.getConfig().enabled;
    }

    // ARCHON: crawling and searching are separate switches because they answer
    // to different people. Turning the crawl off is an operator's decision
    // about outbound traffic; turning search off is a tournament organiser's
    // decision about their site's UI. Neither should imply the other - an
    // organiser who hides the search box still wants the index kept current,
    // and an operator who stops crawling still wants the rows already indexed
    // to remain findable rather than vanishing with the crawler.
    isSearchEnabled() {
        return this.getConfig().searchEnabled !== false;
    }

    getPageSize() {
        const pageSize = parseInt(this.getConfig().pageSize, 10);

        return Number.isFinite(pageSize) && pageSize > 0 ? pageSize : 25;
    }

    isUuid(value) {
        return (
            typeof value === 'string' &&
            /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(
                value
            )
        );
    }

    sleep(ms) {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }

    /**
     * The single crawl cursor row. Returns a first-page cursor when the row
     * cannot be read: a crawl that restarts from page 1 wastes requests on
     * decks it already has (they conflict and are dropped), while a crawl
     * that refuses to start because the database hiccuped stays stopped until
     * someone notices. Never throws.
     */
    async getState() {
        try {
            const rows = await this.db.query(
                'SELECT "CurrentPage", "TotalIndexed", "LastRunAt", "LastError", "PausedUntil", ' +
                    '"ConsecutiveFailures", "CaughtUp" FROM "DeckCatalogState" WHERE "Id" = 1'
            );

            if (rows && rows[0]) {
                return rows[0];
            }
        } catch (err) {
            logger.warn(`Failed to read deck catalog state: ${err.message}`);
        }

        return {
            CurrentPage: 1,
            TotalIndexed: 0,
            LastRunAt: null,
            LastError: null,
            PausedUntil: null,
            ConsecutiveFailures: 0,
            CaughtUp: false
        };
    }

    /**
     * The endpoint shapes to try, best first: an operator's override, then the
     * ones known to have been Master Vault's deck list. A URL without a trailing
     * slash gets one, because that single character is the difference between a
     * deck list and a 404 and is not worth an operator's afternoon.
     */
    apiCandidates() {
        const configured = this.getConfig().mvApiUrl;
        const withSlash = (url) => (url.endsWith('/') ? url : `${url}/`);
        const candidates = configured ? [withSlash(configured)] : [];

        for (const candidate of MV_API_CANDIDATES) {
            if (!candidates.includes(candidate)) {
                candidates.push(candidate);
            }
        }

        // Once one has answered, it is the only one worth asking.
        return this.resolvedApiUrl ? [this.resolvedApiUrl] : candidates;
    }

    /**
     * One page of Master Vault's global deck list, oldest registration first.
     * Pages are numbered from 1 - Django answers `?page=0` with the same 404
     * a wrong path gets, so there is no page 0 to ask for.
     *
     * Returns { decks: [{ uuid, name, expansion, houses }], rowCount } or
     * { error, status } describing the failure so the caller's circuit breaker
     * can tell a rate limit from a timeout. Never throws.
     *
     * A "wrong address" answer - a 404, an auth wall in front of one variant,
     * or a 200 that is not a deck list - moves on to the next candidate; every
     * other status is Master Vault answering, and is reported as-is. The error
     * carries the URL, because "HTTP 404" on its own tells an operator nothing
     * they can act on.
     */
    async fetchPage(page) {
        const resolved = this.resolvedApiUrl;
        let last = { error: 'no endpoint to try', status: null };

        for (const baseUrl of this.apiCandidates()) {
            const attempt = await this.fetchPageFrom(baseUrl, page);

            if (!attempt.error) {
                if (this.resolvedApiUrl !== baseUrl) {
                    this.resolvedApiUrl = baseUrl;
                    logger.info(`Master Vault catalog: reading the deck list from ${baseUrl}`);
                }

                return attempt;
            }

            // Django's 404 for a page past the end is indistinguishable from
            // its 404 for a wrong path. From the endpoint that has been
            // answering with deck lists, on a page past the first, it usually
            // means the tail: the last page held exactly page_size decks, the
            // cursor stepped past it, and the decks that will fill the next
            // page have not been registered yet. Confirmed against page 1 -
            // which exists for as long as the list does - and reported as an
            // empty page, so the crawl records "caught up" rather than an
            // outage it would break its own circuit over.
            if (baseUrl === resolved && attempt.status === 404 && page > 1) {
                const probe = await this.fetchPageFrom(baseUrl, 1);

                if (!probe.error) {
                    return { decks: [], rowCount: 0 };
                }
            }

            last = attempt;

            // Anything other than "that address is not the deck list" means we
            // found the service and it said no - a rate limit, a timeout, an
            // outage. Retrying a different spelling would just be three requests
            // where one was already answered.
            if (!this.isWrongAddress(attempt)) {
                break;
            }

            // A remembered endpoint that has stopped being the deck list is
            // forgotten again, so the next attempt re-resolves from the full
            // candidate list instead of failing against a memory.
            if (baseUrl === resolved) {
                this.resolvedApiUrl = null;
            }
        }

        return last;
    }

    /**
     * "That address is not the deck list": a missing path, a listing variant
     * behind an auth wall this server holds no key for, one Master Vault has
     * withdrawn, or a 200 serving something else entirely. Distinct from
     * Master Vault saying no - a 429 or a 500 is the service itself
     * answering, and asking a second spelling of the same origin would be
     * hammering a server that has already spoken.
     */
    isWrongAddress(attempt) {
        return !!attempt.wrongAddress || [401, 403, 404, 410].includes(attempt.status);
    }

    /** One page from one candidate URL. Never throws. */
    async fetchPageFrom(baseUrl, page) {
        const config = this.getConfig();
        const url = `${baseUrl}?page=${page}&page_size=${this.getPageSize()}&ordering=date`;

        try {
            const response = await fetch(url, {
                method: 'GET',
                headers: {
                    // The tail of the list is the whole point of a repeat run,
                    // and a cached copy of the last page is by definition the
                    // decks registered before the ones this run came for.
                    'cache-control': 'no-cache',
                    'user-agent': MV_USER_AGENT
                },
                signal: AbortSignal.timeout(config.requestTimeoutMs || 15000)
            });

            if (!response.ok) {
                logger.warn(
                    `Master Vault catalog returned ${response.status} for page ${page} at ${url}`
                );

                return {
                    error: `HTTP ${response.status} from ${baseUrl}`,
                    status: response.status
                };
            }

            const body = await response.json();
            const rows = body && Array.isArray(body.data) ? body.data : null;

            if (!rows) {
                // A 200 that is not a deck list is the same problem a 404 is:
                // this is not the address. Say so, so the caller tries the next.
                return {
                    error: `unexpected response shape from ${baseUrl} (expected a data array)`,
                    status: null,
                    wrongAddress: true
                };
            }

            const decks = rows
                .map((row) => {
                    const deck = row || {};
                    const expansion = parseInt(deck.expansion, 10);
                    const houses = Array.isArray(deck._links && deck._links.houses)
                        ? deck._links.houses.filter((house) => typeof house === 'string')
                        : [];

                    return {
                        uuid: this.isUuid(deck.id) ? deck.id : null,
                        name: typeof deck.name === 'string' ? deck.name : null,
                        expansion: Number.isFinite(expansion) ? expansion : null,
                        houses: houses.length > 0 ? houses.join(',') : null
                    };
                })
                // Uuid, Name and Expansion are the table's NOT NULL columns and
                // a page is stored as a single statement, so a row missing any
                // of them is not one bad row - it is the whole page failing to
                // index. They are dropped here, where the loss is one deck.
                .filter((deck) => deck.uuid && deck.name && deck.expansion !== null);

            // rowCount is what Master Vault sent, which is deliberately not
            // decks.length: page fullness decides whether the cursor advances,
            // and measuring it after filtering would let a single unparseable
            // row make a full page look like the end of the list - pinning the
            // crawl on that page for as long as the row stays broken.
            return { decks, rowCount: rows.length };
        } catch (err) {
            const detail = err.name === 'TimeoutError' ? 'request timed out' : err.message;
            logger.warn(`Failed to fetch Master Vault catalog page ${page}: ${detail}`);

            return { error: `could not connect (${detail})`, status: null };
        }
    }

    /**
     * Index a page of decks in one statement. ON CONFLICT DO NOTHING because
     * the catalog is immutable once written: a deck's name, set and houses are
     * fixed at registration, so a row we already hold is a row we already know.
     *
     * Returns how many rows were NEWLY added, which is what RETURNING gives us
     * and what "indexed" has to mean. Counting rows offered instead would make
     * TotalIndexed climb forever: once the crawl is caught up it re-reads the
     * same tail page every run, and each pass would claim to have indexed a
     * pageful of decks it already had. Never throws.
     */
    async upsertDecks(decks) {
        const rows = (decks || []).filter((deck) => deck && deck.uuid);

        if (rows.length === 0) {
            return 0;
        }

        const values = rows.map((deck, i) => {
            const base = i * 4;
            const placeholders = `$${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}`;

            return `(${placeholders}, now() AT TIME ZONE 'utc')`;
        });
        const params = [];

        for (const deck of rows) {
            params.push(deck.uuid, deck.name, deck.expansion, deck.houses || null);
        }

        let inserted;

        try {
            inserted = await this.db.query(
                'INSERT INTO "DeckCatalog" ' +
                    '("Uuid", "Name", "Expansion", "Houses", "FirstSeen") VALUES ' +
                    values.join(', ') +
                    ' ON CONFLICT ("Uuid") DO NOTHING RETURNING "Uuid"',
                params
            );
        } catch (err) {
            logger.warn(`Failed to index ${rows.length} Master Vault decks: ${err.message}`);

            return 0;
        }

        return (inserted || []).length;
    }

    // Doubling per consecutive failure, capped. The cap matters more than the
    // curve: Master Vault coming back up must not wait an unbounded number of
    // hours for a crawler that gave up in the night.
    backoffMs(consecutiveFailures) {
        const config = this.getConfig();
        const base = config.backoffBaseMs || 60000;
        const max = config.backoffMaxMs || 3600000;

        return Math.min(max, base * Math.pow(2, Math.max(0, consecutiveFailures - 1)));
    }

    async recordProgress(currentPage, indexed, caughtUp) {
        try {
            await this.db.query(
                'UPDATE "DeckCatalogState" SET "CurrentPage" = $1, ' +
                    '"TotalIndexed" = "TotalIndexed" + $2, "CaughtUp" = $3, ' +
                    '"LastRunAt" = now() AT TIME ZONE \'utc\', "LastError" = NULL, ' +
                    '"ConsecutiveFailures" = 0, "PausedUntil" = NULL WHERE "Id" = 1',
                [currentPage, indexed, caughtUp]
            );
        } catch (err) {
            logger.warn(`Failed to persist deck catalog progress: ${err.message}`);
        }
    }

    async recordFailure(error, consecutiveFailures, pausedUntil) {
        try {
            await this.db.query(
                'UPDATE "DeckCatalogState" SET "ConsecutiveFailures" = $1, "LastError" = $2, ' +
                    '"PausedUntil" = $3, "LastRunAt" = now() AT TIME ZONE \'utc\' WHERE "Id" = 1',
                [consecutiveFailures, error, pausedUntil]
            );
        } catch (err) {
            logger.warn(`Failed to persist deck catalog failure: ${err.message}`);
        }
    }

    /**
     * ARCHON: one pass of the crawl - a bounded number of pages, then stop.
     *
     * The cursor is persisted per page rather than per run, so a lobby restart
     * mid-crawl costs at most the page in flight. A full page advances it; a
     * SHORT page does not, because a short page means we have reached the decks
     * registered so far and the next run must ask for that same page again to
     * collect the ones registered since. CaughtUp records that state, which is
     * what turns this from a multi-day backfill into a cheap tail poll.
     *
     * ARCHON: the circuit breaker is deliberately far more aggressive than the
     * crawl itself needs. The crawler and every user-facing single-deck import
     * hit the same Master Vault origin from the same IP, so a crawl that keeps
     * hammering through 429s does not merely fail to index - it gets the site
     * rate-limited or IP-blocked, and takes ordinary deck import down with it.
     * A 429 therefore pauses on the FIRST occurrence rather than after a run of
     * them: backing off hard costs a few hours of indexing nobody is waiting
     * for, and protects the feature players actually depend on.
     *
     * Never throws - a failed crawl must not take a lobby tick with it.
     *
     * `ignorePause` is for a human: the breaker exists to stop a TIMER from
     * hammering a service that keeps saying no, and an operator pressing
     * "crawl now" on the health panel is the opposite of that - one deliberate
     * pass, watched, usually to find out whether a fix worked. Without it the
     * recovery button is inert for exactly as long as the thing it exists to
     * recover from.
     */
    async crawlOnce({ pagesPerRun, ignorePause } = {}) {
        const config = this.getConfig();

        if (!this.isEnabled()) {
            return {
                indexed: 0,
                pagesRequested: 0,
                caughtUp: false,
                paused: false,
                budgetExhausted: false,
                skipped: true
            };
        }

        const state = await this.getState();
        const pausedUntil = state.PausedUntil ? new Date(state.PausedUntil).getTime() : 0;

        if (!ignorePause && pausedUntil > Date.now()) {
            return {
                indexed: 0,
                pagesRequested: 0,
                caughtUp: !!state.CaughtUp,
                paused: true,
                budgetExhausted: false,
                skipped: true
            };
        }

        const pageSize = this.getPageSize();
        const maxPages = Math.max(1, parseInt(pagesPerRun ?? config.pagesPerRun, 10) || 10);
        const maxFailures = Math.max(1, parseInt(config.maxConsecutiveFailures, 10) || 3);
        const delayMs = config.requestDelayMs == null ? 3000 : config.requestDelayMs;

        // Clamped to 1, not 0: Master Vault's pages are numbered from 1, and
        // `?page=0` is answered with the same HTTP 404 as a wrong path. This
        // floor is also what un-sticks databases from before that was
        // understood - their persisted cursor still says 0, and the crawl
        // spent weeks pinned there, reading Django's "Invalid page." as
        // "wrong address" on every candidate URL it knew.
        let page = Math.max(1, parseInt(state.CurrentPage, 10) || 1);
        let failures = state.ConsecutiveFailures || 0;
        let indexed = 0;
        let pagesRequested = 0;
        let caughtUp = !!state.CaughtUp;
        let paused = false;

        for (let i = 0; i < maxPages; i++) {
            // Between pages, never before the first: the delay exists to space
            // requests out, and a run of one page owes Master Vault nothing.
            if (i > 0 && delayMs > 0) {
                await this.sleep(delayMs);
            }

            const result = await this.fetchPage(page);
            pagesRequested++;

            if (result.error) {
                failures++;

                const trip = result.status === 429 || failures >= maxFailures;
                const backoff = trip ? this.backoffMs(failures) : 0;

                // Every failure is persisted, not just the one that trips the
                // breaker. The crawl is a short job on a timer, so a Master
                // Vault outage mostly shows up as one failure per run, and a
                // count that reset between runs would never reach the
                // threshold however long the outage lasted.
                await this.recordFailure(
                    result.error,
                    failures,
                    trip ? new Date(Date.now() + backoff) : null
                );

                if (trip) {
                    logger.warn(
                        `Master Vault catalog crawl paused for ${Math.round(backoff / 1000)}s ` +
                            `after ${failures} consecutive failures (${result.error})`
                    );

                    paused = true;
                    break;
                }

                // The cursor did not move, so this is a retry of the same page
                // one delay later - a page nobody has indexed yet is not a page
                // to skip past.
                continue;
            }

            failures = 0;

            const added = await this.upsertDecks(result.decks);
            indexed += added;

            const full = (result.rowCount || 0) >= pageSize;

            caughtUp = !full;

            if (full) {
                page++;
            }

            await this.recordProgress(page, added, caughtUp);

            if (!full) {
                break;
            }
        }

        return {
            indexed,
            pagesRequested,
            caughtUp,
            paused,
            // The page budget only runs out when neither the tail of the list
            // nor the breaker stopped the run first, i.e. there is more registry
            // to walk and the next run will walk it.
            budgetExhausted: !caughtUp && !paused
        };
    }

    /**
     * ARCHON: whether the pg_trgm GIN index actually got created.
     *
     * The migration tries to create it and carries on with a NOTICE when the
     * role is not allowed to CREATE EXTENSION, which on managed Postgres is the
     * normal case rather than the exotic one. That leaves two different
     * databases in the wild, and the difference is not cosmetic: a substring
     * match (`%term%`) is index-served where the trigram index exists and a
     * sequential scan of every deck in existence where it does not.
     *
     * So the query shape follows the index rather than assuming it. Checked
     * once and cached - an index does not appear halfway through a process, and
     * paying a catalog lookup per keystroke to re-learn the same answer would
     * cost more than the branch saves. Detection failing is treated as "no
     * trigram", because guessing wrong in that direction costs a narrower
     * search, while guessing wrong the other way costs a table scan.
     */
    async supportsTrigram() {
        const configured = this.getConfig().substringSearch;

        if (configured === true || configured === false) {
            return configured;
        }

        if (this.trigramAvailable != null) {
            return this.trigramAvailable;
        }

        try {
            const rows = await this.db.query(
                "SELECT 1 FROM pg_indexes WHERE schemaname = 'public' " +
                    "AND indexname = 'IX_DeckCatalog_NameTrgm'"
            );

            this.trigramAvailable = !!(rows && rows.length > 0);
        } catch (err) {
            logger.warn(`Could not detect the deck catalog trigram index: ${err.message}`);

            this.trigramAvailable = false;
        }

        return this.trigramAvailable;
    }

    /**
     * ARCHON: whether the catalog holds anything at all.
     *
     * The crawl is off by default, so the ordinary state of a fresh install is
     * a search box backed by an empty table. Without this the UI cannot tell
     * "no deck of that name exists" from "this server has never indexed
     * anything", and it told players the former - inviting them to try again
     * later for an index nobody had switched on.
     *
     * Cached once it is true: a catalog that has rows does not go back to
     * having none, and this is only consulted when a search finds nothing, so
     * the empty case costs one LIMIT 1 on a query that already returned no
     * rows. Failure reports "has decks" so a database hiccup degrades to the
     * ordinary no-results wording rather than accusing the operator of a
     * misconfiguration.
     */
    async hasIndexedDecks() {
        if (this.catalogPopulated) {
            return true;
        }

        try {
            const rows = await this.db.query('SELECT 1 FROM "DeckCatalog" LIMIT 1');

            this.catalogPopulated = !!(rows && rows.length > 0);

            return this.catalogPopulated;
        } catch (err) {
            logger.warn(`Could not check whether the deck catalog is populated: ${err.message}`);

            return true;
        }
    }

    /**
     * Find catalogued decks by name. Returns [] rather than throwing on any
     * failure: a search box that says "no results" while the catalog is unwell
     * is a far better outcome than a 500 on a page players use to add decks.
     */
    async search(query, { limit, expansion } = {}) {
        if (!this.isSearchEnabled()) {
            return [];
        }

        const config = this.getConfig();
        const term = String(query || '').trim();

        // A one-character query matches a meaningful fraction of every deck
        // that exists, which is a table scan to build a result nobody wanted.
        if (term.length < 2) {
            return [];
        }

        // Escaped, not interpolated: LIKE's own wildcards are ordinary
        // characters in a deck name, so a player typing one means it literally.
        const escaped = term.replace(/[\\%_]/g, '\\$&').toLowerCase();
        // Lowercased here rather than with lower($1) in SQL so the comparison is
        // unambiguously `lower("Name") LIKE <constant>` - the exact shape the
        // btree text_pattern_ops index is built to answer for a prefix.
        const pattern = (await this.supportsTrigram()) ? `%${escaped}%` : `${escaped}%`;
        const params = [pattern];
        let sql =
            'SELECT "Uuid", "Name", "Expansion", "Houses" FROM "DeckCatalog" ' +
            'WHERE lower("Name") LIKE $1';

        if (expansion != null) {
            params.push(expansion);
            sql += ` AND "Expansion" = $${params.length}`;
        }

        // The caller's limit is a request, not a promise: the cap is what stops
        // one keystroke on a public endpoint returning results by the thousand.
        // Clamped at both ends - Postgres rejects a negative LIMIT outright, so
        // an unbounded floor turns `?limit=-1` into a query error swallowed as
        // "no results", one log line per request.
        params.push(Math.max(1, Math.min(limit || 25, config.maxSearchResults || 50)));
        // Sorted on lower("Name") rather than "Name" so the ordering can be
        // served by the same index the match is already reading.
        sql += ` ORDER BY lower("Name") ASC LIMIT $${params.length}`;

        let rows;

        try {
            rows = await this.db.query(sql, params);
        } catch (err) {
            logger.warn(`Deck catalog search failed: ${err.message}`);

            return [];
        }

        return (rows || []).map((row) => ({
            uuid: row.Uuid,
            name: row.Name,
            expansion: row.Expansion,
            houses: row.Houses
        }));
    }
}

module.exports = CatalogService;
