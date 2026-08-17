const logger = require('../../log');
const { cloneCard } = require('./packCards');

/**
 * ARCHON (N24): the Gauntlet - the Champion's Challenge against the field.
 *
 * The mirror lab plays a member's decks against each other, which measures a
 * deck against the company it keeps. This plays them against decks nobody here
 * owns: real registered decks, drawn from the Master Vault catalog this site
 * already crawls.
 *
 * Where the field comes from
 * --------------------------
 * Master Vault publishes one global deck list, ordered by registration date,
 * and walking it page by page is how anyone builds a complete index - it is
 * exactly what Decks of KeyForge does, and what CatalogService already does
 * here for deck-name search. The catalog stores names and uuids only, because a
 * search result needs a name and asking for card lists would multiply every
 * crawl response by two orders of magnitude.
 *
 * So a catalog deck cannot be played as it stands: it has to be HYDRATED, its
 * card list fetched once from Master Vault and kept. That is a permanent cache
 * - a registered deck's contents never change - so the pool only ever costs
 * requests while it is growing, and a deck this server cannot simulate is
 * recorded as unplayable rather than retried forever.
 *
 * What the member controls
 * ------------------------
 * Sets, houses, a SAS window, and strategies. The first three are exact,
 * because the catalog and the SAS cache already know them. Strategies are read
 * off the deck's AERC breakdown, which only exists for decks Decks of KeyForge
 * has been asked about - so a strategy filter narrows the pool to enriched
 * decks, and the report says so rather than quietly ignoring the filter.
 *
 * What it refuses to do
 * ---------------------
 *  - Never draws a deck the member owns, or one of their friends' decks: "play
 *    against the field" means strangers' decks, and a friend's deck is exactly
 *    the company-it-keeps problem the Gauntlet exists to escape.
 *  - Never writes "Games", "GamePlayers" or "RatingHistory". Gauntlet games are
 *    sparring, like every other Challenge game.
 *  - Never mixes its results into the mirror record. Two measurements, shown
 *    separately.
 */

// Master Vault's single-deck endpoint, cards included - the same URL deck
// import uses, so a hydrated deck is parsed by exactly the code that parses a
// member's own import (DeckService.parseDeckResponse).
const MV_DECK_URL = 'https://www.keyforgegame.com/api/decks/';

/**
 * The strategy filters, expressed over Decks of KeyForge's AERC components.
 *
 * AERC scores a deck on the things a KeyForge deck can be good at, and those
 * components ARE the strategies - a deck with high amber control fights the
 * amber race, one with high creature control fights on the board. Thresholds
 * are deliberately generous: this asks "does the deck do this well", not "is
 * this the only thing it does", because a member picking `aggro` wants
 * board-focused opponents rather than a single archetype.
 *
 * Keys are a contract - they are stored in GauntletSettings.Strategies. Add,
 * don't rename.
 */
const STRATEGIES = {
    aggro: {
        label: 'Board pressure',
        description: 'Fights for the board - creature control and effective power',
        fields: ['creatureControl', 'effectivePower'],
        // effectivePower is on a different scale (raw power, tens) from the
        // other AERC components (single digits), so each field carries its own
        // bar rather than sharing one.
        thresholds: { creatureControl: 3, effectivePower: 15 }
    },
    amber: {
        label: 'Amber control',
        description: 'Attacks the amber race - steals, denial and taxes',
        fields: ['amberControl'],
        thresholds: { amberControl: 6 }
    },
    speed: {
        label: 'Speed',
        description: 'Races to forge - high expected amber',
        fields: ['expectedAmber'],
        thresholds: { expectedAmber: 18 }
    },
    control: {
        label: 'Artifact and disruption',
        description: 'Answers artifacts and disrupts the opponent’s turn',
        fields: ['artifactControl', 'disruption'],
        thresholds: { artifactControl: 1.5, disruption: 2 }
    },
    efficiency: {
        label: 'Efficiency',
        description: 'Draws and cycles - gets more turns out of the deck',
        fields: ['efficiency'],
        thresholds: { efficiency: 5 }
    }
};

class GauntletService {
    /**
     * @param {object} configService
     * @param {object} [db]
     * @param {object} [settingsService]
     * @param {object} [deps] injected collaborators, for tests
     * @param {object} [deps.deckService] supplies parseDeckResponse
     * @param {object} [deps.dokService] supplies SAS enrichment for the pool
     */
    constructor(
        configService,
        db = require('../../db'),
        settingsService = require('../settings'),
        { deckService = null, dokService = null } = {}
    ) {
        this.configService = configService;
        this.db = db;
        this.settingsService = settingsService;
        this.deckService = deckService;
        this.dokService = dokService;
    }

    getConfig() {
        const section = this.settingsService.getSectionWithDefaults
            ? this.settingsService.getSectionWithDefaults('championsChallenge')
            : {};

        return {
            ...(this.configService.getValue('championsChallenge') || {}),
            ...section
        };
    }

    /** The Gauntlet runs only when the operator has turned the pool on. */
    isPoolEnabled() {
        return this.getConfig().gauntletEnabled !== false;
    }

    sleep(ms) {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }

    // ---------------------------------------------------------------- settings

    /**
     * A member's Gauntlet configuration, defaulted for a member who has never
     * saved one. Never throws - the sweep reads this every tick.
     */
    async settingsFor(userId) {
        let row = null;

        try {
            const rows = await this.db.query(
                'SELECT "Enabled", "FieldSharePct", "Sets", "Houses", "Strategies", ' +
                    '"MinSas", "MaxSas" FROM "GauntletSettings" WHERE "UserId" = $1',
                [userId]
            );

            row = rows && rows[0];
        } catch (err) {
            logger.error('Gauntlet: could not read settings', err);
        }

        return {
            enabled: !!(row && row.Enabled),
            fieldSharePct: row ? row.FieldSharePct : 50,
            sets: csvToList(row && row.Sets)
                .map((set) => parseInt(set, 10))
                .filter(Number.isFinite),
            houses: csvToList(row && row.Houses),
            strategies: csvToList(row && row.Strategies).filter((key) => STRATEGIES[key]),
            minSas: row && row.MinSas != null ? row.MinSas : null,
            maxSas: row && row.MaxSas != null ? row.MaxSas : null
        };
    }

    /**
     * Save a member's Gauntlet configuration. Unknown strategy keys and
     * non-numeric sets are dropped rather than rejected: the stored value has
     * to stay meaningful to a future version that has renamed neither.
     */
    async saveSettings(userId, settings = {}) {
        const clampSas = (value) => {
            const parsed = parseInt(value, 10);

            return Number.isFinite(parsed) ? Math.max(0, Math.min(200, parsed)) : null;
        };
        const share = parseInt(settings.fieldSharePct, 10);
        const sets = (Array.isArray(settings.sets) ? settings.sets : [])
            .map((set) => parseInt(set, 10))
            .filter((set) => Number.isFinite(set) && set > 0);
        const houses = (Array.isArray(settings.houses) ? settings.houses : [])
            .map((house) => String(house).toLowerCase().trim())
            .filter(Boolean);
        const strategies = (Array.isArray(settings.strategies) ? settings.strategies : []).filter(
            (key) => STRATEGIES[key]
        );
        const minSas = clampSas(settings.minSas);
        const maxSas = clampSas(settings.maxSas);

        await this.db.query(
            'INSERT INTO "GauntletSettings" ' +
                '("UserId", "Enabled", "FieldSharePct", "Sets", "Houses", "Strategies", ' +
                '"MinSas", "MaxSas", "UpdatedAt") ' +
                "VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now() AT TIME ZONE 'utc') " +
                'ON CONFLICT ("UserId") DO UPDATE SET ' +
                '"Enabled" = EXCLUDED."Enabled", "FieldSharePct" = EXCLUDED."FieldSharePct", ' +
                '"Sets" = EXCLUDED."Sets", "Houses" = EXCLUDED."Houses", ' +
                '"Strategies" = EXCLUDED."Strategies", "MinSas" = EXCLUDED."MinSas", ' +
                '"MaxSas" = EXCLUDED."MaxSas", "UpdatedAt" = EXCLUDED."UpdatedAt"',
            [
                userId,
                !!settings.enabled,
                Number.isFinite(share) ? Math.max(0, Math.min(100, share)) : 50,
                sets.join(',') || null,
                houses.join(',') || null,
                strategies.join(',') || null,
                // A window given backwards is a typo, not a request for an
                // empty pool.
                minSas != null && maxSas != null ? Math.min(minSas, maxSas) : minSas,
                minSas != null && maxSas != null ? Math.max(minSas, maxSas) : maxSas
            ]
        );

        return this.settingsFor(userId);
    }

    // ---------------------------------------------------------------- the pool

    /**
     * Grow the playable pool: take catalog decks nobody has hydrated yet,
     * fetch each one's cards from Master Vault, and keep what this server can
     * simulate.
     *
     * Bounded per run and paced between requests, for the same reason the
     * catalog crawl is: this is somebody else's API, hit from the same address
     * as user-facing deck import, and a member waiting on their own import
     * matters more than the pool growing quickly.
     *
     * Never throws.
     *
     * @returns {Promise<{hydrated: number, unplayable: number, failed: number}>}
     */
    async hydratePool({ decksPerRun, targetPoolSize } = {}) {
        const config = this.getConfig();
        const perRun = Math.max(1, parseInt(decksPerRun ?? config.gauntletDecksPerRun, 10) || 5);
        const target = Math.max(
            1,
            parseInt(targetPoolSize ?? config.gauntletTargetPoolSize, 10) || 400
        );
        const outcome = { hydrated: 0, unplayable: 0, failed: 0 };

        if (!this.isPoolEnabled() || !this.deckService) {
            return outcome;
        }

        try {
            const sized = await this.db.query(
                'SELECT COUNT(*)::int AS "Count" FROM "GauntletDecks" WHERE "Playable" = true'
            );

            if (sized && sized[0] && sized[0].Count >= target) {
                return outcome;
            }

            // Draw candidates at random across the whole catalog rather than in
            // crawl order: the catalog is ordered by registration date, so
            // taking the head would build a pool entirely out of 2018 decks.
            const candidates = await this.db.query(
                'SELECT c."Uuid", c."Name", c."Expansion", c."Houses" FROM "DeckCatalog" c ' +
                    'WHERE NOT EXISTS (' +
                    'SELECT 1 FROM "GauntletDecks" g WHERE g."Uuid" = c."Uuid") ' +
                    'ORDER BY random() LIMIT $1',
                [perRun]
            );

            for (const candidate of candidates || []) {
                const result = await this.hydrateDeck(candidate);

                if (result === 'hydrated') {
                    outcome.hydrated++;
                } else if (result === 'unplayable') {
                    outcome.unplayable++;
                } else {
                    outcome.failed++;
                    // A failure is usually Master Vault metering us. Stop the
                    // run rather than spending the rest of the budget learning
                    // the same thing four more times.
                    break;
                }

                const delay = parseInt(config.gauntletRequestDelayMs, 10);

                await this.sleep(Number.isFinite(delay) ? delay : 1500);
            }
        } catch (err) {
            logger.error('Gauntlet: pool hydration failed', err);
        }

        if (outcome.hydrated || outcome.unplayable) {
            logger.info(
                `Gauntlet pool: +${outcome.hydrated} playable, ` +
                    `${outcome.unplayable} unplayable, ${outcome.failed} failed`
            );
        }

        return outcome;
    }

    /**
     * Fetch and store one catalog deck.
     *
     * @returns {Promise<'hydrated'|'unplayable'|'failed'>}
     */
    async hydrateDeck({ Uuid, Name, Expansion, Houses }) {
        let parsed;

        try {
            const response = await fetch(`${MV_DECK_URL}${Uuid}/?links=cards`, {
                signal: AbortSignal.timeout(this.getConfig().gauntletRequestTimeoutMs || 10000)
            });

            if (!response.ok) {
                logger.warn(`Gauntlet: Master Vault returned ${response.status} for ${Uuid}`);

                return 'failed';
            }

            const body = await response.json();

            if (!body || !body._linked || !body.data) {
                return 'failed';
            }

            // The member-facing importer's own parser: mavericks, anomalies,
            // enhancements, prophecies and the card-id spelling rules all come
            // out identical to an imported deck, which is the point - a
            // Gauntlet opponent is not a second, subtly different notion of
            // "deck".
            parsed = await this.deckService.parseDeckResponse('gauntlet', body);
        } catch (err) {
            logger.warn(`Gauntlet: could not hydrate ${Uuid}: ${err.message}`);

            return 'failed';
        }

        if (!parsed) {
            return this.storeUnplayable(Uuid, Name, Expansion, Houses, ['unparseable']);
        }

        const { cards, missing } = this.toEngineCards(parsed.cards || []);
        const houses = (parsed.houses || []).filter(Boolean);

        if (missing.length || houses.length !== 3) {
            return this.storeUnplayable(
                Uuid,
                parsed.name || Name,
                parsed.expansion || Expansion,
                houses.join(',') || Houses,
                missing.length ? missing : ['house-count']
            );
        }

        await this.db.query(
            'INSERT INTO "GauntletDecks" ' +
                '("Uuid", "Name", "Expansion", "Houses", "Cards", "Playable", "FetchedAt") ' +
                "VALUES ($1, $2, $3, $4, $5, true, now() AT TIME ZONE 'utc') " +
                'ON CONFLICT ("Uuid") DO UPDATE SET "Cards" = EXCLUDED."Cards", ' +
                '"Playable" = true, "MissingCards" = NULL, "FetchedAt" = EXCLUDED."FetchedAt"',
            [
                Uuid,
                parsed.name || Name,
                parsed.expansion || Expansion,
                houses.join(','),
                JSON.stringify(cards)
            ]
        );

        return 'hydrated';
    }

    async storeUnplayable(uuid, name, expansion, houses, missing) {
        await this.db.query(
            'INSERT INTO "GauntletDecks" ' +
                '("Uuid", "Name", "Expansion", "Houses", "Playable", "MissingCards", "FetchedAt") ' +
                "VALUES ($1, $2, $3, $4, false, $5, now() AT TIME ZONE 'utc') " +
                'ON CONFLICT ("Uuid") DO UPDATE SET "Playable" = false, ' +
                '"MissingCards" = EXCLUDED."MissingCards", "FetchedAt" = EXCLUDED."FetchedAt"',
            [uuid, name || uuid, expansion || 0, houses || null, missing.slice(0, 20).join(',')]
        );

        return 'unplayable';
    }

    /**
     * Master Vault card entries turned into engine deck entries, dropping
     * nothing silently: any card this server has no data for comes back in
     * `missing`, which is what makes a deck unplayable rather than a game that
     * crashes mid-sweep.
     */
    toEngineCards(parsedCards) {
        const cards = [];
        const missing = [];

        for (const entry of parsedCards) {
            const card = cloneCard(entry.id);

            if (!card) {
                missing.push(entry.id);
                continue;
            }

            cards.push({
                id: entry.id,
                count: entry.count,
                maverick: entry.maverick || undefined,
                anomaly: entry.anomaly || undefined,
                house: entry.house || undefined,
                isNonDeck: !!entry.isNonDeck,
                enhancements: entry.enhancements || undefined,
                prophecyId: entry.prophecyId || undefined
            });
        }

        return { cards, missing };
    }

    /**
     * Ask Decks of KeyForge for the SAS and AERC of pool decks that have none.
     *
     * This is what makes the SAS and strategy filters mean anything: a pool
     * deck with no enrichment row can satisfy neither, so an unenriched pool
     * answers every strategy filter with "nothing matches". Bounded per run and
     * metered by DokService's own per-minute budget; entirely best effort, and
     * skipped when the operator has no DoK key (the site works without one -
     * sets and houses still filter, because the catalog knows those).
     *
     * @returns {Promise<number>} how many decks were asked about
     */
    async enrichPool({ decksPerRun } = {}) {
        const config = this.getConfig();
        const perRun = Math.max(1, parseInt(decksPerRun ?? config.gauntletEnrichPerRun, 10) || 5);

        if (!this.dokService || !this.dokService.isEnabled || !this.dokService.isEnabled()) {
            return 0;
        }

        let asked = 0;

        try {
            const rows = await this.db.query(
                'SELECT g."Uuid" FROM "GauntletDecks" g ' +
                    'LEFT JOIN "DeckSas" ds ON ds."Uuid" = g."Uuid" ' +
                    'WHERE g."Playable" = true AND ds."Uuid" IS NULL ' +
                    // Most-played first: a deck the draw keeps picking is the
                    // one whose stats the report most needs.
                    'ORDER BY g."GamesPlayed" DESC LIMIT $1',
                [perRun]
            );

            for (const row of rows || []) {
                await this.dokService.enrichDeck(row.Uuid);
                asked++;
            }
        } catch (err) {
            logger.error('Gauntlet: pool enrichment failed', err);
        }

        return asked;
    }

    /** Does anyone have the Gauntlet switched on? The pool grows only if so. */
    async anyoneWantsField() {
        try {
            const rows = await this.db.query(
                'SELECT 1 FROM "GauntletSettings" WHERE "Enabled" = true LIMIT 1'
            );

            return !!(rows && rows.length);
        } catch (err) {
            logger.error('Gauntlet: could not check for interest', err);

            return false;
        }
    }

    // -------------------------------------------------------------- the draw

    /**
     * Draw one foreign opponent for a member, honouring their filters.
     *
     * Returns the engine-ready deck plus what the report needs to label it, or
     * null when nothing in the pool matches - which is a real answer (a narrow
     * filter on a young pool), and the caller falls back to a mirror game
     * rather than skipping the member's turn entirely.
     *
     * @returns {Promise<{deck: object, uuid: string, name: string, sas: number|null}|null>}
     */
    /**
     * The WHERE clause behind both the draw and the count.
     *
     * One builder, deliberately: counting matches with different SQL from
     * drawing them is exactly how a filter comes to be advertised as reaching
     * decks the draw cannot then find.
     *
     * @returns {{where: string, params: Array, join: string}}
     */
    filterClauses(userId, filters) {
        const params = [userId];
        const conditions = [
            'g."Playable" = true',
            // Never a deck this member owns...
            'NOT EXISTS (SELECT 1 FROM "Decks" d WHERE d."Uuid" = g."Uuid" AND d."UserId" = $1)',
            // ...nor one owned by an accepted friend, in either direction.
            'NOT EXISTS (SELECT 1 FROM "Decks" fd ' +
                'JOIN "Friendships" f ON f."Status" = \'accepted\' AND (' +
                '(f."RequesterId" = $1 AND f."AddresseeId" = fd."UserId") OR ' +
                '(f."AddresseeId" = $1 AND f."RequesterId" = fd."UserId")) ' +
                'WHERE fd."Uuid" = g."Uuid")'
        ];

        if (filters.sets.length) {
            params.push(filters.sets);
            conditions.push(`g."Expansion" = ANY($${params.length})`);
        }

        for (const house of filters.houses) {
            params.push(house);
            // Houses is a comma-separated list of codes; match a whole element.
            conditions.push(`string_to_array(g."Houses", ',') @> ARRAY[$${params.length}::text]`);
        }

        // SAS and strategy both read the enrichment cache. A deck with no SAS
        // row cannot satisfy either, so those filters narrow the pool to
        // enriched decks - see poolStatus, which reports that plainly.
        if (filters.minSas != null) {
            params.push(filters.minSas);
            conditions.push(`ds."SasRating" >= $${params.length}`);
        }

        if (filters.maxSas != null) {
            params.push(filters.maxSas);
            conditions.push(`ds."SasRating" <= $${params.length}`);
        }

        for (const key of filters.strategies) {
            const strategy = STRATEGIES[key];

            for (const field of strategy.fields) {
                params.push(strategy.thresholds[field]);
                // AERC components live in the cached DoK payload. ->> yields
                // text, so cast; a missing component fails the comparison,
                // which is the conservative outcome.
                conditions.push(
                    `(ds."RawData" -> 'deck' ->> '${field}')::numeric >= $${params.length}`
                );
            }
        }

        return {
            join: 'FROM "GauntletDecks" g LEFT JOIN "DeckSas" ds ON ds."Uuid" = g."Uuid"',
            where: conditions.join(' AND '),
            params
        };
    }

    async drawOpponent(userId, settings) {
        const filters = settings || (await this.settingsFor(userId));
        const { join, where, params } = this.filterClauses(userId, filters);
        let rows;

        try {
            rows = await this.db.query(
                'SELECT g."Uuid", g."Name", g."Expansion", g."Houses", g."Cards", ' +
                    `ds."SasRating" ${join} WHERE ${where} ` +
                    // Least-recently-played first, then random among equals, so
                    // the whole pool gets used instead of a favourite few.
                    'ORDER BY g."LastPlayedAt" ASC NULLS FIRST, random() LIMIT 1',
                params
            );
        } catch (err) {
            logger.error('Gauntlet: opponent draw failed', err);

            return null;
        }

        const row = rows && rows[0];

        if (!row) {
            return null;
        }

        return {
            uuid: row.Uuid,
            name: row.Name,
            sas: row.SasRating != null ? row.SasRating : null,
            deck: {
                // No dbId: this deck has no row in "Decks", and nothing
                // downstream may treat it as if it did.
                name: row.Name,
                uuid: row.Uuid,
                expansion: row.Expansion,
                houses: csvToList(row.Houses),
                cards: Array.isArray(row.Cards) ? row.Cards : JSON.parse(row.Cards || '[]')
            }
        };
    }

    /** Mark a drawn deck as used, so the draw moves on through the pool. */
    async noteOpponentPlayed(uuid) {
        try {
            await this.db.query(
                'UPDATE "GauntletDecks" SET "LastPlayedAt" = now() AT TIME ZONE \'utc\', ' +
                    '"GamesPlayed" = "GamesPlayed" + 1 WHERE "Uuid" = $1',
                [uuid]
            );
        } catch (err) {
            logger.error('Gauntlet: could not note opponent play', err);
        }
    }

    // ------------------------------------------------------------- the record

    /**
     * Record one Gauntlet game, from the member's deck's point of view.
     *
     * @param {object} game
     * @param {number} game.userId
     * @param {number} game.deckId the member's deck
     * @param {object} game.opponent as returned by drawOpponent
     * @param {boolean} game.won
     * @param {object} game.result the SimulatedGame result
     */
    async recordGame({ userId, deckId, opponent, won, result }) {
        const mine = won ? 'winner' : 'loser';
        const theirs = won ? 'loser' : 'winner';

        await this.db.query(
            'INSERT INTO "GauntletGames" ' +
                '("UserId", "DeckId", "OpponentUuid", "OpponentName", "OpponentSas", "Won", ' +
                '"MyKeys", "OpponentKeys", "Turns", "WentFirst", "MyFirstHouse", ' +
                '"OpponentFirstHouse", "DurationMs", "FinishedAt") ' +
                'VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, ' +
                "now() AT TIME ZONE 'utc')",
            [
                userId,
                deckId,
                opponent.uuid,
                opponent.name,
                opponent.sas,
                won,
                result[`${mine}Keys`],
                result[`${theirs}Keys`],
                result.turns,
                won ? !!result.winnerWentFirst : !result.winnerWentFirst,
                result[`${mine}FirstHouse`] || null,
                result[`${theirs}FirstHouse`] || null,
                result.durationMs
            ]
        );
    }

    /**
     * Every enrolled deck's record against the field, keyed by deck id.
     *
     * Reported next to the mirror record rather than folded into it: the two
     * numbers answer different questions, and the average of them answers
     * neither.
     */
    async recordsFor(userId) {
        let rows;

        try {
            // Aliased "Played" rather than "Games": the spec that keeps lab SQL
            // away from the official tables forbids that name anywhere in this
            // service's queries, alias or not, and an alias is not worth
            // weakening a tripwire for.
            rows = await this.db.query(
                'SELECT "DeckId", COUNT(*)::int AS "Played", ' +
                    'COUNT(*) FILTER (WHERE "Won")::int AS "Wins", ' +
                    'AVG("OpponentSas")::float AS "AvgOpponentSas" ' +
                    'FROM "GauntletGames" WHERE "UserId" = $1 GROUP BY "DeckId"',
                [userId]
            );
        } catch (err) {
            logger.error('Gauntlet: could not read records', err);

            return {};
        }

        const records = {};

        for (const row of rows || []) {
            records[row.DeckId] = {
                games: row.Played,
                wins: row.Wins,
                losses: row.Played - row.Wins,
                winRate: row.Played ? row.Wins / row.Played : null,
                avgOpponentSas:
                    row.AvgOpponentSas == null ? null : Math.round(row.AvgOpponentSas * 10) / 10
            };
        }

        return records;
    }

    /** The member's most recent field results, for the page's log. */
    async recentGames(userId, limit = 8) {
        try {
            const rows = await this.db.query(
                'SELECT gg."DeckId", d."Name" AS "DeckName", gg."OpponentName", ' +
                    'gg."OpponentSas", gg."Won", gg."MyKeys", gg."OpponentKeys", gg."Turns", ' +
                    'gg."FinishedAt" FROM "GauntletGames" gg ' +
                    'LEFT JOIN "Decks" d ON d."Id" = gg."DeckId" ' +
                    'WHERE gg."UserId" = $1 ORDER BY gg."Id" DESC LIMIT $2',
                [userId, limit]
            );

            return (rows || []).map((row) => ({
                deckId: row.DeckId,
                deckName: row.DeckName,
                opponentName: row.OpponentName,
                opponentSas: row.OpponentSas,
                won: row.Won,
                myKeys: row.MyKeys,
                opponentKeys: row.OpponentKeys,
                turns: row.Turns,
                finishedAt: row.FinishedAt
            }));
        } catch (err) {
            logger.error('Gauntlet: could not read recent games', err);

            return [];
        }
    }

    /**
     * How much of a field there is to play against, and how much of it the
     * member's filters can actually reach. The second number is the honest one:
     * a strategy filter can only match decks whose AERC breakdown has been
     * fetched, and a member whose filters match nothing needs to be told that
     * rather than left wondering why every game is still a mirror.
     */
    async poolStatus(userId, settings) {
        const filters = settings || (await this.settingsFor(userId));

        try {
            const [totals, matching] = await Promise.all([
                this.db.query(
                    'SELECT COUNT(*) FILTER (WHERE "Playable")::int AS "Playable", ' +
                        'COUNT(*)::int AS "Hydrated" FROM "GauntletDecks"'
                ),
                this.countMatching(userId, filters)
            ]);
            const row = (totals && totals[0]) || {};

            return {
                playable: row.Playable || 0,
                hydrated: row.Hydrated || 0,
                matching,
                // Whether the filters depend on enrichment, which is what makes
                // `matching` smaller than a member might expect.
                needsEnrichment: !!(
                    filters.strategies.length ||
                    filters.minSas != null ||
                    filters.maxSas != null
                )
            };
        } catch (err) {
            logger.error('Gauntlet: could not read pool status', err);

            return { playable: 0, hydrated: 0, matching: 0, needsEnrichment: false };
        }
    }

    /** How many pool decks this member's filters actually reach. */
    async countMatching(userId, filters) {
        const { join, where, params } = this.filterClauses(userId, filters);

        try {
            const rows = await this.db.query(
                `SELECT COUNT(*)::int AS "Count" ${join} WHERE ${where}`,
                params
            );

            return (rows && rows[0] && rows[0].Count) || 0;
        } catch (err) {
            logger.error('Gauntlet: could not count pool', err);

            return 0;
        }
    }
}

function csvToList(value) {
    return String(value || '')
        .split(',')
        .map((entry) => entry.trim())
        .filter(Boolean);
}

module.exports = GauntletService;
module.exports.STRATEGIES = STRATEGIES;
