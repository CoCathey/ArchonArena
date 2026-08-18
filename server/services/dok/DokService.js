const crypto = require('node:crypto');

const { effectiveAri } = require('../rating/AriService');

const logger = require('../../log');

// ARCHON: one sliding window per Api-Key, not one per process.
//
// DoK meters its per-minute cap against whichever key made the request, and the
// site now sends two kinds: the site-wide key that pays for SAS enrichment, and
// each player's own key when we list their collection. Charging a player's
// paging to a single shared window would throttle SAS for everybody over quota
// DoK never actually spent, so every key gets its own budget here too.
//
// Keys are bucketed by a hash so a player's DoK credential is never held in
// module state, and a bucket is dropped once its window drains - otherwise the
// map would keep a row for every player who ever imported, forever.
const outboundRequestTimes = new Map();

// Decks of KeyForge's free-tier cap. Every key this site sends is held to it -
// see getRateLimit for why it is a ceiling and not a default.
const DOK_FREE_TIER_RPM = 25;

function keyIdFor(apiKey) {
    return crypto.createHash('sha256').update(String(apiKey)).digest('hex').slice(0, 16);
}

function reserveOutboundSlot(keyId, limit, headroom = 0) {
    const now = Date.now();
    const cutoff = now - 60000;

    // Sweep every bucket, not just this key's: a player who imported once and
    // left would otherwise keep an entry nobody ever prunes again.
    for (const [id, times] of outboundRequestTimes) {
        while (times.length && times[0] <= cutoff) {
            times.shift();
        }

        if (times.length === 0) {
            outboundRequestTimes.delete(id);
        }
    }

    const slots = outboundRequestTimes.get(keyId) || [];

    // `headroom` is how many of this minute's requests the caller agrees not to
    // touch. Background work passes it so a sweep can never take the last slot
    // of a minute and leave a member's own deck page with no SAS on it: the
    // sweeps have another minute, the member is looking at the page now.
    if (slots.length >= Math.max(1, limit - Math.max(0, headroom))) {
        return false;
    }

    slots.push(now);
    outboundRequestTimes.set(keyId, slots);

    return true;
}

/**
 * Integration with Decks of KeyForge (decksofkeyforge.com): fetches SAS /
 * AERC deck statistics and caches them in the DeckSas table, keyed by the
 * deck's Master Vault UUID so one row covers every user's copy of a deck, and
 * lists a player's own DoK collection (/my-decks) so they can bulk-import it.
 *
 * Design constraints:
 *  - Deck import and deck listing must never fail or block on DoK being
 *    slow or down; enrichment is best-effort and cached values degrade
 *    gracefully to "no SAS shown".
 *  - Two credentials are in play: the site-wide key SAS enrichment spends, and
 *    the player's own key /my-decks requires. Collection listing therefore only
 *    needs `enabled` (isImportEnabled) and works on a server that has no site
 *    key at all, while SAS still needs both (isEnabled).
 *  - Outbound calls are capped to DoK's per-minute request limit
 *    (maxRequestsPerMinute; 25 on the free tier, higher for patrons) via a
 *    sliding window per key. Best-effort enrichment skips when the budget is
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
    // Test hook: clear every key's rate-limit window between cases.
    static _resetRateLimiter() {
        outboundRequestTimes.clear();
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

    // ARCHON: collection import authenticates as the player, so it must not be
    // gated on the site's own key the way SAS enrichment is - a server that
    // never bought a DoK key can still let players pull in their own decks.
    isImportEnabled() {
        return !!this.getConfig().enabled;
    }

    /**
     * ARCHON: everyone runs at DoK's free tier, 25 requests per minute, and
     * this is a CEILING rather than a default.
     *
     * DoK publishes 25/min free with 50/100/250 for patron tiers, and their own
     * rules ask plainly that the API not be spammed - their site has been taken
     * down by misuse of it before. A configured value above the free tier is
     * therefore a promise about somebody else's service that this deployment
     * cannot keep on its own: the per-key windows here are per PROCESS, so two
     * lobbies each believing they may send 250/min send 500, and the tier a key
     * actually has is DoK's business, not a number in our config.
     *
     * So config may lower this and may not raise it. If a patron tier is ever
     * worth using, raising DOK_FREE_TIER_RPM is the one-line change - made
     * deliberately, by someone who has checked the subscription, rather than by
     * an admin nudging a slider during an incident.
     */
    getRateLimit() {
        const limit = parseInt(this.getConfig().maxRequestsPerMinute, 10);

        if (!Number.isFinite(limit) || limit <= 0) {
            return DOK_FREE_TIER_RPM;
        }

        return Math.min(limit, DOK_FREE_TIER_RPM);
    }

    /**
     * ARCHON: how much of the per-minute budget background work leaves alone.
     *
     * Two sweeps now spend this budget on nobody's behalf in particular - the
     * stale-SAS refresh, and the Gauntlet asking about pool decks the crawl
     * brought in - and a sweep that empties the minute is indistinguishable, from
     * a member's side, from DoK being down: their deck page shows no SAS and
     * their import waits. Peek-and-take alone does not prevent that, because the
     * sweep is entitled to the last slot. So background callers hold back a few.
     */
    getBackgroundHeadroom() {
        const headroom = parseInt(this.getConfig().backgroundHeadroom, 10);

        if (!Number.isFinite(headroom) || headroom < 0) {
            return 5;
        }

        // Never so much headroom that background work can make no progress at
        // all; the reservation floor keeps at least one slot reachable.
        return Math.min(headroom, Math.max(0, this.getRateLimit() - 1));
    }

    // Non-blocking: reserve one request against this minute's budget for the
    // key that will be sent. Defaults to the site key, which is what every
    // SAS caller uses, so those call sites need not name it. `headroom` marks
    // the caller as background work - see getBackgroundHeadroom.
    reserveRequestSlot(apiKey = this.getConfig().apiKey, { headroom = 0 } = {}) {
        return reserveOutboundSlot(keyIdFor(apiKey), this.getRateLimit(), headroom);
    }

    // Blocking (bounded): for user-initiated calls that should prefer to
    // proceed rather than silently skip. Polls at roughly the slot-refill
    // spacing until a slot frees or maxWaitMs elapses.
    async waitForRequestSlot(maxWaitMs = 8000, apiKey = this.getConfig().apiKey) {
        const start = Date.now();

        for (;;) {
            if (this.reserveRequestSlot(apiKey)) {
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
    async fetchDeckStats(uuid, { alreadyReserved = false, headroom = 0 } = {}) {
        const config = this.getConfig();

        if (!this.isEnabled()) {
            return null;
        }

        // Enrichment is best-effort: if this minute's budget is spent, skip
        // and let a later access retry (needsRefresh stays true). Callers that
        // reserved their own slot (the refresh sweep, which has to know whether
        // the budget or the request failed) say so rather than double-spending.
        if (!alreadyReserved && !this.reserveRequestSlot(undefined, { headroom })) {
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

    getMyDecksUrl() {
        const config = this.getConfig();

        if (config.myDecksUrl) {
            return config.myDecksUrl;
        }

        // Derive the collection endpoint from the single-deck apiUrl origin
        // when not explicitly configured.
        try {
            return new URL(config.apiUrl).origin + '/public-api/v1/my-decks';
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
     * Fetch one page of the decks DoK holds for a player, authenticating as
     * that player with their own Api-Key. Returns
     * { decks: [{ uuid, name, sasRating }] } on success (uuid is the Master
     * Vault id, i.e. what our importer needs) or { error } describing the
     * failure (HTTP status, timeout, rate limit) so callers can tell the user
     * what actually went wrong.
     */
    async fetchMyDecksPage(apiKey, page) {
        const config = this.getConfig();
        const myDecksUrl = this.getMyDecksUrl();

        if (!myDecksUrl) {
            return { error: 'no my-decks endpoint configured' };
        }

        // User-initiated, and billed to this player's own DoK budget rather
        // than the site's: wait briefly for a slot rather than skipping.
        if (!(await this.waitForRequestSlot(8000, apiKey))) {
            logger.warn(`DoK per-minute rate limit reached; could not fetch my-decks page ${page}`);

            return { error: 'per-minute rate limit reached' };
        }

        try {
            const response = await fetch(`${myDecksUrl}?page=${page}`, {
                method: 'GET',
                headers: { 'Api-Key': apiKey },
                signal: AbortSignal.timeout(config.requestTimeoutMs || 10000)
            });

            if (!response.ok) {
                let hint = '';
                // ARCHON: a machine-readable reason alongside the prose. An
                // automatic sync has to tell "this key is dead" from "DoK had a
                // bad minute": the first must stop the schedule and ask the
                // player for a new key, the second must simply be tried again.
                // Matching on the wording would make that distinction a
                // property of an error message somebody will reword one day.
                let errorCode = 'upstream_error';

                if (response.status === 401 || response.status === 403) {
                    hint = ' (API key rejected)';
                    errorCode = 'key_rejected';
                } else if (response.status === 404) {
                    hint = ' (endpoint not found)';
                } else if (response.status === 429) {
                    hint = ' (DoK rate limit)';
                    errorCode = 'rate_limited';
                }
                logger.warn(`DoK my-decks API returned ${response.status} for page ${page}`);

                return { error: `HTTP ${response.status}${hint}`, errorCode };
            }

            const body = await response.json();

            if (!Array.isArray(body)) {
                return { error: 'unexpected response shape (expected an array of decks)' };
            }

            const decks = body
                .map((entry) => {
                    // Each entry is a PublicMyDeckInfo: ownership flags
                    // wrapped around the deck itself. Fall back to the
                    // entry so an unwrapped deck still parses.
                    const deck = (entry && entry.deck) || entry || {};

                    return {
                        uuid: this.isUuid(deck.keyforgeId) ? deck.keyforgeId : null,
                        name: typeof deck.name === 'string' ? deck.name : null,
                        sasRating:
                            typeof deck.sasRating === 'number' ? Math.round(deck.sasRating) : null
                    };
                })
                .filter((deck) => deck.uuid);

            // Rows we could not read are worth saying out loud. If DoK ever
            // moves the Master Vault id, every row drops here and the caller
            // sees an empty collection - which is indistinguishable from a
            // player who owns nothing unless the count was logged.
            if (decks.length < body.length) {
                logger.warn(
                    `DoK my-decks page ${page}: ignored ${body.length - decks.length} of ` +
                        `${body.length} entries with no Master Vault id`
                );
            }

            // rowCount is what DoK sent, deliberately not decks.length: paging
            // continues on it, so a page of unreadable rows must not look like
            // the end of the collection and silently truncate the import.
            return { decks, rowCount: body.length };
        } catch (err) {
            const detail = err.name === 'TimeoutError' ? 'request timed out' : err.message;
            logger.warn(`Failed to fetch DoK my-decks page ${page}: ${detail}`);

            return { error: `could not connect (${detail})` };
        }
    }

    /**
     * List a player's DoK collection by paging /my-decks with their key until
     * it runs dry (or a safety cap is hit). Never throws:
     *  - { configured: false } when DoK import is off on this server
     *  - { configured: true, error: true } when the very first page fails
     *  - { configured: true, decks, truncated, partial, skipped } otherwise
     *
     * `skipUuids` is the set of decks the caller already has. Filtering happens
     * HERE, mid-page, rather than on the finished list, and that is the whole
     * reason re-running a capped sync makes progress: the cap counts decks that
     * still need importing, so a player with 700 decks gets 1-500, imports
     * them, and the next run - now skipping those 500 - returns 501-700.
     * Filtering afterwards would hand back the same first 500 forever and the
     * rest would be unreachable through this feature.
     */
    async listMyDecks(apiKey, { maxDecks, skipUuids } = {}) {
        if (!this.isImportEnabled()) {
            return { configured: false, decks: [] };
        }

        const key = String(apiKey || '').trim();

        if (!key) {
            return { configured: true, decks: [] };
        }

        const config = this.getConfig();
        const cap = maxDecks || config.maxImportDecks || 500;
        const skip = skipUuids instanceof Set ? skipUuids : new Set(skipUuids || []);
        const all = [];
        const rated = [];
        const seen = new Set();
        let truncated = false;
        let partial = false;
        let skipped = 0;

        // Hard page ceiling as a runaway guard on top of the deck cap.
        for (let page = 0; page < 100; page++) {
            const pageResult = await this.fetchMyDecksPage(key, page);

            if (pageResult.error) {
                if (page === 0) {
                    return {
                        configured: true,
                        error: true,
                        errorDetail: pageResult.error,
                        // Carried up so an automatic sync can stop for a dead
                        // key and retry for anything else.
                        errorCode: pageResult.errorCode || 'upstream_error',
                        decks: []
                    };
                }

                // Partial success. Flagged rather than silent: without it the
                // caller cannot tell a collection that ended from one that was
                // cut off, and would present half an import as all of it.
                logger.warn(`DoK my-decks stopped early at page ${page}: ${pageResult.error}`);
                partial = true;
                break;
            }

            // Measured on what DoK sent, not on what parsed - see fetchMyDecksPage.
            if (pageResult.rowCount === 0) {
                break;
            }

            let fresh = 0;
            for (const deck of pageResult.decks) {
                if (seen.has(deck.uuid)) {
                    continue;
                }

                seen.add(deck.uuid);
                fresh++;
                // Cached for every deck DoK reported, owned or not: a deck the
                // player already has still wants its SAS kept current, and this
                // response is the cheapest place it will ever come from.
                rated.push(deck);

                if (skip.has(deck.uuid)) {
                    skipped++;
                    continue;
                }

                // Checked before the push, so reaching the cap exactly is not
                // truncation - only an actual next deck we refused to take is.
                if (all.length >= cap) {
                    truncated = true;
                    break;
                }

                all.push(deck);
            }

            // Nothing new out of decks we could read means DoK is ignoring
            // `page` and handing back the same ones; stop rather than fetch
            // them a hundred times. A page where nothing PARSED is a different
            // thing - the decks after it are still worth asking for, and the
            // page ceiling is what bounds that case.
            if (truncated || (pageResult.decks.length > 0 && fresh === 0)) {
                break;
            }
        }

        // The my-decks response already carries each deck's SAS - cache it now
        // so bulk-imported decks show SAS with zero extra per-deck API calls.
        await this.cacheSummarySas(rated);

        return { configured: true, decks: all, truncated, partial, skipped };
    }

    /**
     * Persist SAS ratings pulled from a collection listing. Uses ON
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
            // ARCHON (N19): DeckAri rides along so every reader of a deck's
            // SAS can carry its ARI too - one join here instead of a second
            // lookup on every path that decorates decks.
            rows = await this.db.query(
                'SELECT ds."Uuid", ds."SasRating", ds."AercScore", ds."FetchedAt", da."Ari" ' +
                    'FROM "DeckSas" ds LEFT JOIN "DeckAri" da ON da."Uuid" = ds."Uuid" ' +
                    'WHERE ds."Uuid" = ANY($1)',
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
     *
     * `background: true` marks the call as nobody's page load - the Gauntlet
     * asking about a pool deck, say - and holds back part of the minute's budget
     * for the calls that are. Returns whether stats were stored, so a caller
     * pacing itself can tell "DoK answered" from "DoK had nothing, or we were
     * out of budget" instead of asking again on every sweep.
     */
    async enrichDeck(uuid, { background = false } = {}) {
        if (!uuid || !this.isEnabled() || this.pendingFetches.has(uuid)) {
            return false;
        }

        // Skip when we already hold fresh stats - e.g. SAS cached from a
        // bulk-import collection listing - so importing a collection does not
        // spend one API call per deck on data we already have.
        const stored = await this.getStoredStats([uuid]);
        if (stored[uuid] && !this.needsRefresh(stored[uuid].FetchedAt)) {
            return true;
        }

        this.pendingFetches.add(uuid);

        try {
            const stats = await this.fetchDeckStats(uuid, {
                headroom: background ? this.getBackgroundHeadroom() : 0
            });

            if (stats) {
                await this.upsertStats(uuid, stats);

                return true;
            }
        } catch (err) {
            logger.warn(`Failed to enrich deck ${uuid} with DoK stats: ${err.message}`);
        } finally {
            this.pendingFetches.delete(uuid);
        }

        return false;
    }

    /**
     * ARCHON: the decks whose cached SAS is missing or past its refresh
     * window, stalest first.
     *
     * Only decks somebody actually owns - a DeckSas row whose deck has since
     * been deleted is not worth an API call.
     */
    async findStaleDeckUuids(limit) {
        const config = this.getConfig();
        const refreshDays = config.refreshDays == null ? 30 : config.refreshDays;
        const cutoff = new Date(Date.now() - refreshDays * 24 * 60 * 60 * 1000);

        const rows = await this.db.query(
            'SELECT DISTINCT d."Uuid" AS "uuid", ds."FetchedAt" AS "fetchedAt" ' +
                'FROM "Decks" d LEFT JOIN "DeckSas" ds ON ds."Uuid" = d."Uuid" ' +
                'WHERE d."Uuid" IS NOT NULL AND (ds."FetchedAt" IS NULL OR ds."FetchedAt" < $1) ' +
                'ORDER BY ds."FetchedAt" ASC NULLS FIRST LIMIT $2',
            [cutoff, limit]
        );

        return (rows || []).map((row) => row.uuid);
    }

    /**
     * ARCHON: periodic background SAS refresh (N3).
     *
     * Refresh used to be access-triggered only: a deck nobody opened kept its
     * first-ever score forever, so the site's SAS slowly drifted away from what
     * DoK actually says as the model was revised.
     *
     * This deliberately spends only what is left of the shared per-minute
     * budget after live traffic, one request at a time, and stops the moment a
     * slot is unavailable - a player importing a collection or looking at a
     * pre-game screen is never queued behind the sweep. Whatever it does not
     * reach this pass it reaches on the next, because the stalest decks sort
     * first and the sweep re-queries each run.
     *
     * Never throws: a failed sweep must not take a lobby tick with it.
     */
    async refreshStaleDecks({ batchSize } = {}) {
        const config = this.getConfig();

        if (!this.isEnabled() || config.sweepEnabled === false) {
            return { refreshed: 0, attempted: 0, budgetExhausted: false, skipped: true };
        }

        const cap = Math.max(1, parseInt(batchSize ?? config.sweepBatchSize, 10) || 10);
        let uuids;

        try {
            uuids = await this.findStaleDeckUuids(cap);
        } catch (err) {
            logger.warn(`SAS refresh sweep could not list stale decks: ${err.message}`);

            return { refreshed: 0, attempted: 0, budgetExhausted: false };
        }

        let refreshed = 0;
        let attempted = 0;
        let budgetExhausted = false;

        const headroom = this.getBackgroundHeadroom();

        for (const uuid of uuids) {
            // Peek-and-take, minus the headroom the sweep leaves for live
            // traffic: if this returns false, the sweep yields rather than
            // waiting for a slot. Without the headroom "what is left after live
            // traffic" was only true in the order the requests happened to
            // arrive - the sweep could take the minute's last slot and a member
            // arriving a second later got nothing.
            if (!this.reserveRequestSlot(undefined, { headroom })) {
                budgetExhausted = true;
                break;
            }

            attempted++;

            try {
                const stats = await this.fetchDeckStats(uuid, { alreadyReserved: true });

                if (stats) {
                    await this.upsertStats(uuid, stats);
                    refreshed++;
                }
            } catch (err) {
                logger.warn(`SAS refresh sweep failed for deck ${uuid}: ${err.message}`);
            }
        }

        return { refreshed, attempted, budgetExhausted };
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
                // ARCHON (N19): the platform's own index - stored where any
                // game has moved it, the SAS/AERC seed otherwise.
                deck.ari = effectiveAri(row);
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
