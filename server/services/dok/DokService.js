const logger = require('../../log');

/**
 * Integration with Decks of KeyForge (decksofkeyforge.com): fetches SAS /
 * AERC deck statistics and caches them in the DeckSas table, keyed by the
 * deck's Master Vault UUID so one row covers every user's copy of a deck.
 *
 * Design constraints:
 *  - Deck import and deck listing must never fail or block on DoK being
 *    slow or down; enrichment is best-effort and cached values degrade
 *    gracefully to "no SAS shown".
 *  - All knobs (enabled, API key, refresh interval, timeout) come from
 *    config so the admin settings service can drive them later.
 *  - The db adapter is injected to keep the service unit-testable.
 */
class DokService {
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

    /**
     * Fetch deck statistics from the DoK public API. Returns the extracted
     * stats or null on any failure (never throws).
     */
    async fetchDeckStats(uuid) {
        const config = this.getConfig();

        if (!this.isEnabled()) {
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
     * Returns an array of { uuid, name, sasRating } (uuid is the Master
     * Vault id, i.e. what our importer needs) or null on any failure.
     */
    async fetchOwnerDeckPage(dokUsername, page) {
        const config = this.getConfig();
        const filterUrl = this.getFilterUrl();

        if (!filterUrl) {
            return null;
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
                logger.warn(
                    `DoK filter API returned ${response.status} for owner ${dokUsername} page ${page}`
                );

                return null;
            }

            const body = await response.json();
            const decks = body && Array.isArray(body.decks) ? body.decks : null;

            if (!decks) {
                return null;
            }

            return decks
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
                .filter((deck) => deck.uuid);
        } catch (err) {
            logger.warn(
                `Failed to fetch DoK decks for owner ${dokUsername} page ${page}: ${err.message}`
            );

            return null;
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
            const pageDecks = await this.fetchOwnerDeckPage(owner, page);

            if (pageDecks === null) {
                if (page === 0) {
                    return { configured: true, error: true, decks: [] };
                }

                break; // partial success - return what we already have
            }

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

        return { configured: true, decks: all, truncated };
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
