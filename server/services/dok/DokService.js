const logger = require('../../log');

// Process-wide sliding-window log of outbound DoK request times. DoK bills
// a single site-wide Api-Key, so the cap must be global across every
// DokService instance in the process - not per-instance. Each entry is a
// request timestamp (ms); anything older than 60s is pruned on access.
const outboundRequestTimes = [];

function reserveOutboundSlot(limit) {
    const now = Date.now();
    const cutoff = now - 60000;

    while (outboundRequestTimes.length && outboundRequestTimes[0] <= cutoff) {
        outboundRequestTimes.shift();
    }

    if (outboundRequestTimes.length < limit) {
        outboundRequestTimes.push(now);

        return true;
    }

    return false;
}

/**
 * Integration with Decks of KeyForge (decksofkeyforge.com): fetches SAS /
 * AERC deck statistics and caches them in the DeckSas table, keyed by the
 * deck's Master Vault UUID so one row covers every user's copy of a deck.
 *
 * Design constraints:
 *  - Deck import and deck listing must never fail or block on DoK being
 *    slow or down; enrichment is best-effort and cached values degrade
 *    gracefully to "no SAS shown".
 *  - Outbound calls are capped to DoK's per-minute request limit
 *    (maxRequestsPerMinute; 25 on the free tier, higher for patrons) via a
 *    shared sliding window. Best-effort enrichment skips when the budget is
 *    spent; user-initiated calls wait briefly for a slot.
 *  - All knobs (enabled, API key, refresh interval, timeout, rate limit)
 *    come from config so the admin settings service can drive them.
 *  - The db adapter is injected to keep the service unit-testable.
 */
// The AERC components DoK reports, in the order it presents them. Kept here so
// the labels and the field names cannot drift apart.
const AERC_COMPONENTS = [
    { key: 'amberControl', label: 'Amber Control' },
    { key: 'expectedAmber', label: 'Expected Amber' },
    { key: 'artifactControl', label: 'Artifact Control' },
    { key: 'creatureControl', label: 'Creature Control' },
    { key: 'efficiency', label: 'Efficiency' },
    { key: 'recursion', label: 'Recursion' },
    { key: 'disruption', label: 'Disruption' },
    { key: 'effectivePower', label: 'Effective Power' },
    { key: 'creatureProtection', label: 'Creature Protection' },
    { key: 'other', label: 'Other' }
];

class DokService {
    // Test hook: clear the shared rate-limit window between cases.
    static _resetRateLimiter() {
        outboundRequestTimes.length = 0;
    }

    constructor(configService, db = require('../../db'), settingsService = require('../settings')) {
        this.configService = configService;
        this.db = db;
        this.settingsService = settingsService;
        this.pendingFetches = new Set();
    }

    getConfig() {
        // Runtime admin overrides (SiteSettings) win over file config.
        return {
            ...(this.configService.getValue('dok') || {}),
            ...this.settingsService.getSection('dok')
        };
    }

    isEnabled() {
        const config = this.getConfig();

        return !!config.enabled && !!config.apiKey;
    }

    // DoK's per-minute request cap (25 free; 50/100/250 for patron tiers).
    getRateLimit() {
        const limit = parseInt(this.getConfig().maxRequestsPerMinute, 10);

        return Number.isFinite(limit) && limit > 0 ? limit : 25;
    }

    // Non-blocking: reserve one request against this minute's budget.
    reserveRequestSlot() {
        return reserveOutboundSlot(this.getRateLimit());
    }

    // Blocking (bounded): for user-initiated calls that should prefer to
    // proceed rather than silently skip. Polls at roughly the slot-refill
    // spacing until a slot frees or maxWaitMs elapses.
    async waitForRequestSlot(maxWaitMs = 8000) {
        const start = Date.now();

        for (;;) {
            if (this.reserveRequestSlot()) {
                return true;
            }

            if (Date.now() - start >= maxWaitMs) {
                return false;
            }

            const spacing = Math.min(1000, Math.max(50, Math.ceil(60000 / this.getRateLimit())));
            await new Promise((resolve) => setTimeout(resolve, spacing));
        }
    }

    /**
     * Fetch deck statistics from the DoK public API. Returns the extracted
     * stats or null on any failure (never throws).
     */
    async fetchDeckStats(uuid) {
        const config = this.getConfig();

        if (!this.isEnabled()) {
            return null;
        }

        // Enrichment is best-effort: if this minute's budget is spent, skip
        // and let a later access retry (needsRefresh stays true).
        if (!this.reserveRequestSlot()) {
            return null;
        }

        try {
            const response = await fetch(`${config.apiUrl}${uuid}`, {
                headers: { 'Api-Key': config.apiKey },
                signal: AbortSignal.timeout(config.requestTimeoutMs || 10000)
            });

            if (!response.ok) {
                logger.warn(`DoK API returned ${response.status} for deck ${uuid}`);

                return null;
            }

            const body = await response.json();
            const deck = body && body.deck;

            if (!deck || typeof deck.sasRating !== 'number') {
                logger.warn(`DoK API returned no usable stats for deck ${uuid}`);

                return null;
            }

            return {
                sasRating: Math.round(deck.sasRating),
                aercScore: deck.aercScore != null ? Math.round(deck.aercScore) : null,
                aercVersion: deck.aercVersion != null ? Math.round(deck.aercVersion) : null,
                raw: deck
            };
        } catch (err) {
            logger.warn(`Failed to fetch DoK stats for deck ${uuid}: ${err.message}`);

            return null;
        }
    }

    getFilterUrl() {
        const config = this.getConfig();

        if (config.filterUrl) {
            return config.filterUrl;
        }

        // Derive the collection-filter endpoint from the single-deck apiUrl
        // origin when not explicitly configured.
        try {
            return new URL(config.apiUrl).origin + '/public-api/v1/decks/filter';
        } catch {
            return null;
        }
    }

    isUuid(value) {
        return (
            typeof value === 'string' &&
            /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(
                value
            )
        );
    }

    /**
     * Fetch one page of a DoK user's public decks via the filter endpoint.
     * Returns { decks: [{ uuid, name, sasRating }] } on success (uuid is the
     * Master Vault id, i.e. what our importer needs) or { error } describing
     * the failure (HTTP status, timeout, rate limit) so callers can tell the
     * user what actually went wrong.
     */
    async fetchOwnerDeckPage(dokUsername, page) {
        const config = this.getConfig();
        const filterUrl = this.getFilterUrl();

        if (!filterUrl) {
            return { error: 'no filter endpoint configured' };
        }

        // User-initiated: wait briefly for a slot rather than skipping.
        if (!(await this.waitForRequestSlot())) {
            logger.warn(
                `DoK per-minute rate limit reached; could not fetch owner deck page ${page}`
            );

            return { error: 'per-minute rate limit reached' };
        }

        try {
            const response = await fetch(filterUrl, {
                method: 'POST',
                headers: { 'Api-Key': config.apiKey, 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    owner: dokUsername,
                    page,
                    pageSize: 100,
                    sort: 'ADDED_DATE',
                    sortDirection: 'DESC'
                }),
                signal: AbortSignal.timeout(config.requestTimeoutMs || 10000)
            });

            if (!response.ok) {
                let hint = '';
                if (response.status === 401 || response.status === 403) {
                    hint = ' (API key rejected)';
                } else if (response.status === 404) {
                    hint = ' (endpoint not found - filterUrl may be wrong)';
                } else if (response.status === 429) {
                    hint = ' (DoK rate limit)';
                }
                logger.warn(
                    `DoK filter API returned ${response.status} for owner ${dokUsername} page ${page}`
                );

                return { error: `HTTP ${response.status}${hint}` };
            }

            const body = await response.json();
            const decks = body && Array.isArray(body.decks) ? body.decks : null;

            if (!decks) {
                return { error: 'unexpected response shape (no decks array)' };
            }

            return {
                decks: decks
                    .map((deck) => ({
                        uuid: this.isUuid(deck.keyforgeId)
                            ? deck.keyforgeId
                            : this.isUuid(deck.id)
                            ? deck.id
                            : null,
                        name: typeof deck.name === 'string' ? deck.name : null,
                        sasRating:
                            typeof deck.sasRating === 'number' ? Math.round(deck.sasRating) : null
                    }))
                    .filter((deck) => deck.uuid)
            };
        } catch (err) {
            const detail = err.name === 'TimeoutError' ? 'request timed out' : err.message;
            logger.warn(
                `Failed to fetch DoK decks for owner ${dokUsername} page ${page}: ${detail}`
            );

            return { error: `could not connect (${detail})` };
        }
    }

    /**
     * List a DoK user's whole public collection by paging the filter
     * endpoint until it runs dry (or a safety cap is hit). Never throws:
     *  - { configured: false } when DoK is not set up on this server
     *  - { configured: true, error: true } when the very first page fails
     *  - { configured: true, decks: [...], truncated } otherwise (a later
     *    page failing yields a partial-but-usable list)
     */
    async listOwnerDecks(dokUsername, { maxDecks } = {}) {
        if (!this.isEnabled()) {
            return { configured: false, decks: [] };
        }

        const owner = String(dokUsername || '').trim();

        if (!owner) {
            return { configured: true, decks: [] };
        }

        const config = this.getConfig();
        const cap = maxDecks || config.maxImportDecks || 500;
        const all = [];
        const seen = new Set();
        let truncated = false;

        // Hard page ceiling as a runaway guard on top of the deck cap.
        for (let page = 0; page < 100; page++) {
            const pageResult = await this.fetchOwnerDeckPage(owner, page);

            if (pageResult.error) {
                if (page === 0) {
                    return {
                        configured: true,
                        error: true,
                        errorDetail: pageResult.error,
                        decks: []
                    };
                }

                break; // partial success - return what we already have
            }

            const pageDecks = pageResult.decks;

            if (pageDecks.length === 0) {
                break;
            }

            let added = 0;
            for (const deck of pageDecks) {
                if (seen.has(deck.uuid)) {
                    continue;
                }

                seen.add(deck.uuid);
                all.push(deck);
                added++;

                if (all.length >= cap) {
                    truncated = true;
                    break;
                }
            }

            // No new decks (endpoint ignored paging, or we hit the cap) -
            // stop rather than loop forever.
            if (truncated || added === 0) {
                break;
            }
        }

        // The filter response already carries each deck's SAS - cache it now
        // so bulk-imported decks show SAS with zero extra per-deck API calls.
        await this.cacheSummarySas(all);

        return { configured: true, decks: all, truncated };
    }

    /**
     * Persist SAS ratings pulled from a filter/list response. Uses ON
     * CONFLICT DO NOTHING so a fuller prior per-deck fetch (with AERC
     * breakdown) is never clobbered by this lighter summary.
     */
    async cacheSummarySas(decks) {
        const rated = (decks || []).filter((deck) => typeof deck.sasRating === 'number');

        if (rated.length === 0) {
            return;
        }

        const values = rated.map(
            (deck, i) => `($${i + 1}, $${rated.length + i + 1}, now() AT TIME ZONE 'utc')`
        );
        const params = [...rated.map((deck) => deck.uuid), ...rated.map((deck) => deck.sasRating)];

        try {
            await this.db.query(
                'INSERT INTO "DeckSas" ("Uuid", "SasRating", "FetchedAt") VALUES ' +
                    values.join(', ') +
                    ' ON CONFLICT ("Uuid") DO NOTHING',
                params
            );
        } catch (err) {
            logger.warn(`Failed to cache summary SAS from DoK: ${err.message}`);
        }
    }

    async upsertStats(uuid, stats) {
        await this.db.query(
            'INSERT INTO "DeckSas" ("Uuid", "SasRating", "AercScore", "AercVersion", "RawData", "FetchedAt") ' +
                "VALUES ($1, $2, $3, $4, $5, now() AT TIME ZONE 'utc') " +
                'ON CONFLICT ("Uuid") DO UPDATE SET "SasRating" = $2, "AercScore" = $3, ' +
                '"AercVersion" = $4, "RawData" = $5, "FetchedAt" = now() AT TIME ZONE \'utc\'',
            [uuid, stats.sasRating, stats.aercScore, stats.aercVersion, JSON.stringify(stats.raw)]
        );
    }

    /**
     * Stored stats for a set of uuids as a map: uuid -> row.
     */
    async getStoredStats(uuids) {
        if (!uuids || uuids.length === 0) {
            return {};
        }

        let rows;
        try {
            rows = await this.db.query(
                'SELECT "Uuid", "SasRating", "AercScore", "FetchedAt" FROM "DeckSas" WHERE "Uuid" = ANY($1)',
                [uuids]
            );
        } catch (err) {
            logger.error('Failed to read DeckSas', err);

            return {};
        }

        const result = {};
        for (const row of rows || []) {
            result[row.Uuid] = row;
        }

        return result;
    }

    needsRefresh(fetchedAt) {
        const config = this.getConfig();
        const refreshDays = config.refreshDays == null ? 30 : config.refreshDays;

        if (!fetchedAt) {
            return true;
        }

        const ageMs = Date.now() - new Date(fetchedAt).getTime();

        return ageMs > refreshDays * 24 * 60 * 60 * 1000;
    }

    /**
     * Fetch-and-store for one deck, deduplicating concurrent requests for
     * the same uuid. Best effort: never throws.
     */
    async enrichDeck(uuid) {
        if (!uuid || !this.isEnabled() || this.pendingFetches.has(uuid)) {
            return;
        }

        // Skip when we already hold fresh stats - e.g. SAS cached from a
        // bulk-import filter response - so importing a collection does not
        // spend one API call per deck on data we already have.
        const stored = await this.getStoredStats([uuid]);
        if (stored[uuid] && !this.needsRefresh(stored[uuid].FetchedAt)) {
            return;
        }

        this.pendingFetches.add(uuid);

        try {
            const stats = await this.fetchDeckStats(uuid);

            if (stats) {
                await this.upsertStats(uuid, stats);
            }
        } catch (err) {
            logger.warn(`Failed to enrich deck ${uuid} with DoK stats: ${err.message}`);
        } finally {
            this.pendingFetches.delete(uuid);
        }
    }

    /**
     * Attach cached SAS stats to an array of decks (objects with a `uuid`
     * property), and kick off background refreshes for missing/stale
     * entries (bounded per call, fire-and-forget).
     */
    /**
     * ARCHON: the AERC component breakdown for one deck, from the DoK payload
     * already stored in DeckSas.RawData.
     *
     * SAS is a single number; AERC is what it is made of - how much amber
     * control, creature control, efficiency and so on the deck has. The whole
     * payload has been persisted since SAS enrichment landed but was never read
     * back, so players saw the score without any of the reasoning behind it.
     *
     * Returns null when the deck has no stored stats, and skips any component
     * DoK did not supply rather than reporting a misleading zero.
     */
    async getAercBreakdown(uuid) {
        if (!uuid) {
            return null;
        }

        const rows = await this.db.query(
            'SELECT "SasRating", "AercScore", "AercVersion", "RawData", "FetchedAt" ' +
                'FROM "DeckSas" WHERE "Uuid" = $1',
            [uuid]
        );
        const row = rows && rows[0];

        if (!row || !row.RawData) {
            return null;
        }

        const raw = typeof row.RawData === 'string' ? JSON.parse(row.RawData) : row.RawData;
        const components = AERC_COMPONENTS.map((component) => ({
            key: component.key,
            label: component.label,
            value: typeof raw[component.key] === 'number' ? raw[component.key] : null
        })).filter((component) => component.value !== null);

        return {
            sasRating: row.SasRating,
            aercScore: row.AercScore,
            aercVersion: row.AercVersion,
            fetchedAt: row.FetchedAt,
            components,
            // Useful context DoK returns alongside the components.
            sasPercentile: typeof raw.sasPercentile === 'number' ? raw.sasPercentile : null,
            synergyRating: typeof raw.synergyRating === 'number' ? raw.synergyRating : null,
            antisynergyRating:
                typeof raw.antisynergyRating === 'number' ? raw.antisynergyRating : null
        };
    }

    async attachStats(decks, { maxBackgroundFetches = 5 } = {}) {
        const withUuids = (decks || []).filter((deck) => deck && deck.uuid);

        if (withUuids.length === 0) {
            return decks;
        }

        const stored = await this.getStoredStats([...new Set(withUuids.map((d) => d.uuid))]);

        let backgroundFetches = 0;
        const scheduled = new Set();
        for (const deck of withUuids) {
            const row = stored[deck.uuid];

            if (row) {
                deck.sasRating = row.SasRating;
                deck.aercScore = row.AercScore;
            }

            if (
                this.isEnabled() &&
                !scheduled.has(deck.uuid) &&
                this.needsRefresh(row && row.FetchedAt) &&
                backgroundFetches < maxBackgroundFetches
            ) {
                scheduled.add(deck.uuid);
                backgroundFetches++;
                // Deliberately not awaited: refresh must never slow a request
                this.enrichDeck(deck.uuid);
            }
        }

        return decks;
    }
}

module.exports = DokService;
module.exports.AERC_COMPONENTS = AERC_COMPONENTS;
