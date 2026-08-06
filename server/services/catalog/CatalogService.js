const logger = require('../../log');

// Master Vault's own deck list, not a Decks of KeyForge endpoint. DoK indexes
// every deck that exists by walking this exact list (KeyforgeApi.kt /
// DeckImporterService.kt), so the catalog is built from the registry itself
// rather than from somebody else's copy of it - and it works on a server that
// never bought a DoK key.
const MV_API_URL = 'https://www.keyforgegame.com/api/decks/v2';

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
     * The single crawl cursor row. Returns a zeroed cursor when the row cannot
     * be read: a crawl that starts from page 0 wastes requests on decks it
     * already has (they conflict and are dropped), while a crawl that refuses
     * to start because the database hiccuped stays stopped until someone
     * notices. Never throws.
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
            CurrentPage: 0,
            TotalIndexed: 0,
            LastRunAt: null,
            LastError: null,
            PausedUntil: null,
            ConsecutiveFailures: 0,
            CaughtUp: false
        };
    }

    /**
     * One page of Master Vault's global deck list, oldest registration first.
     * Returns { decks: [{ uuid, name, expansion, houses }], rowCount } or
     * { error, status } describing the failure so the caller's circuit breaker
     * can tell a rate limit from a timeout. Never throws.
     */
    async fetchPage(page) {
        const config = this.getConfig();
        const baseUrl = config.mvApiUrl || MV_API_URL;
        const url = `${baseUrl}?page=${page}&page_size=${this.getPageSize()}&ordering=date`;

        try {
            const response = await fetch(url, {
                method: 'GET',
                // The tail of the list is the whole point of a repeat run, and
                // a cached copy of the last page is by definition the decks
                // registered before the ones this run came for.
                headers: { 'cache-control': 'no-cache' },
                signal: AbortSignal.timeout(config.requestTimeoutMs || 15000)
            });

            if (!response.ok) {
                logger.warn(`Master Vault catalog returned ${response.status} for page ${page}`);

                return { error: `HTTP ${response.status}`, status: response.status };
            }

            const body = await response.json();
            const rows = body && Array.isArray(body.data) ? body.data : null;

            if (!rows) {
                return { error: 'unexpected response shape (expected a data array)', status: null };
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
     */
    async crawlOnce({ pagesPerRun } = {}) {
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

        if (pausedUntil > Date.now()) {
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

        let page = Math.max(0, state.CurrentPage || 0);
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
