const logger = require('../../log');
const { fetchDeck, playableDeck } = require('./masterVault');
const { wilsonInterval } = require('./labMath');
const { DEFAULT_FIELD, DEFAULT_EVENT } = require('./vaultTourField');

/**
 * ARCHON (N32): the Vault Tour - a slate of decks against a field somebody won
 * a tournament with.
 *
 * The lab already answers two questions. The mirror games measure a deck against
 * the company it keeps; the Gauntlet measures it against a random sample of
 * every deck that exists. Neither answers the one a competitive player actually
 * asks, which is "how does this hold up against what WINS". That field cannot be
 * sampled, because winning decks are not a distribution - they are a list, and
 * somebody has to know which decks were on it.
 *
 * So the field here is CURATED: an operator enters the winners and runners-up
 * from real events, by Master Vault id, and the lab plays a member's slate
 * against them over and over. The deliverable is the matrix - this deck against
 * that deck, both records - because against sixteen named opponents the average
 * is the least interesting number available.
 *
 * Three separations are deliberate, and each one is a decision rather than an
 * accident of implementation:
 *
 *  - **Not the roster.** The slate is three decks and the Champion's Challenge
 *    roster is eight. Different question, different opposition, different sample
 *    - and a member testing three decks against tournament decks should not have
 *    to withdraw five to do it. A deck may sit in both.
 *  - **Its own budget.** Twelve games per deck per day, counted from this
 *    table alone, so a Vault Tour deck neither steals from nor is starved by the
 *    roster's games. Site admins are exempt, as they are everywhere in the lab -
 *    the person tuning it has to be able to flood it.
 *  - **Never ARI.** ARI is a rating on the SAS scale, fed by games against
 *    representative opposition. A hand-picked field of tournament winners is the
 *    opposite of representative, and feeding it in would import the operator's
 *    choice of opponents straight into the platform's deck rating, where nobody
 *    could see it or subtract it. The matrix says what these games found; the
 *    rating stays out of it.
 */

/** Most decks a member may have on the slate at once. */
const SLATE_SIZE = 3;

/**
 * What an operator may say about a field deck's finish.
 *
 * `unknown` exists because the seeded field arrived as a list of decks without
 * placings, and "won the event" is not a claim to invent to fill a column.
 */
const PLACINGS = [
    { key: 'winner', label: 'Winner' },
    { key: 'runner-up', label: 'Runner-up' },
    { key: 'finalist', label: 'Finalist' },
    { key: 'other', label: 'Also entered' },
    { key: 'unknown', label: 'Unconfirmed' }
];

const UUID_PATTERN = /[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/;

class VaultTourService {
    /**
     * @param {object} configService
     * @param {object} [db]
     * @param {object} [settingsService]
     * @param {object} [deps]
     * @param {object} [deps.deckService] supplies parseDeckResponse
     */
    constructor(
        configService,
        db = require('../../db'),
        settingsService = require('../settings'),
        { deckService = null } = {}
    ) {
        this.configService = configService;
        this.db = db;
        this.settingsService = settingsService;
        this.deckService = deckService;
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

    isEnabled() {
        return this.getConfig().vaultTourEnabled !== false;
    }

    /** Games one slate deck may play per day. Shares the lab's number by design. */
    gamesPerDeckPerDay() {
        const perDay = parseInt(this.getConfig().gamesPerDeckPerDay, 10);

        return Number.isFinite(perDay) && perDay > 0 ? perDay : 12;
    }

    // ------------------------------------------------------------- the field

    /**
     * Add one tournament deck to the field.
     *
     * Takes a Master Vault link or a bare id, because an operator entering a
     * dozen decks is copying links out of an event report, not extracting uuids
     * from them.
     *
     * A deck this server cannot simulate is STORED as unplayable rather than
     * refused: the operator needs to see which of their entries is not playing
     * and why, instead of watching one silently never appear in the matrix.
     *
     * @returns {Promise<{ok: boolean, message?: string, deck?: object}>}
     */
    async addDeck({ link, event, placing, eventDate, userId }) {
        const uuid = this.parseUuid(link);

        if (!uuid) {
            return { ok: false, message: 'That is not a Master Vault deck link or id.' };
        }

        const name = String(event || '').trim();

        if (!name) {
            return { ok: false, message: 'Say which event this deck is from.' };
        }

        const finish = PLACINGS.find((entry) => entry.key === placing) ? placing : 'other';
        const result = await fetchDeck(uuid, {
            deckService: this.deckService,
            timeoutMs: this.getConfig().gauntletRequestTimeoutMs || 10000,
            label: 'vault-tour'
        });

        if (result.error) {
            return {
                ok: false,
                message:
                    result.error === 'no-deck-service'
                        ? 'Deck import is not available on this server.'
                        : `Master Vault could not be read for that deck (${result.error}).`
            };
        }

        const deck = playableDeck(result.parsed);

        try {
            await this.db.query(
                'INSERT INTO "VaultTourDecks" ' +
                    '("Uuid", "Name", "Expansion", "Houses", "Cards", "Playable", "MissingCards", ' +
                    '"Event", "Placing", "EventDate", "AddedByUserId", "FetchedAt") ' +
                    "VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, now() AT TIME ZONE 'utc') " +
                    'ON CONFLICT ("Uuid") DO UPDATE SET "Cards" = EXCLUDED."Cards", ' +
                    '"Playable" = EXCLUDED."Playable", "MissingCards" = EXCLUDED."MissingCards", ' +
                    '"Event" = EXCLUDED."Event", "Placing" = EXCLUDED."Placing", ' +
                    '"EventDate" = EXCLUDED."EventDate", "FetchedAt" = EXCLUDED."FetchedAt"',
                [
                    uuid,
                    deck.name || uuid,
                    deck.expansion || 0,
                    (deck.houses || []).join(',') || null,
                    deck.playable ? JSON.stringify(deck.cards) : null,
                    !!deck.playable,
                    deck.playable ? null : (deck.reasons || []).slice(0, 20).join(','),
                    name,
                    finish,
                    eventDate || null,
                    userId || null
                ]
            );
        } catch (err) {
            logger.error('Vault Tour: could not store a field deck', err);

            return { ok: false, message: 'That deck could not be saved.' };
        }

        return {
            ok: true,
            deck: {
                uuid,
                name: deck.name || uuid,
                event: name,
                placing: finish,
                playable: !!deck.playable,
                missing: deck.playable ? null : (deck.reasons || []).join(', ')
            },
            message: deck.playable
                ? undefined
                : 'Added, but this server cannot simulate that deck, so it will not be played.'
        };
    }

    /**
     * ARCHON (N32): put the shipped field in the table, if it is not there.
     *
     * Ids only, with no cards: hydration is a Master Vault request per deck and
     * belongs on the paced pass below, not in a startup burst. ON CONFLICT DO
     * NOTHING, so an operator's corrections - a real event name, a confirmed
     * placing, a deletion - survive every later sweep.
     *
     * @returns {Promise<number>} rows added
     */
    async seedDefaults() {
        if (!DEFAULT_FIELD.length) {
            return 0;
        }

        try {
            const rows = await this.db.query(
                'INSERT INTO "VaultTourDecks" ' +
                    '("Uuid", "Name", "Expansion", "Playable", "Event", "Placing", "FetchedAt") ' +
                    "SELECT uuid, uuid, 0, false, $2, 'unknown', " +
                    "now() AT TIME ZONE 'utc' FROM unnest($1::text[]) AS uuid " +
                    'ON CONFLICT ("Uuid") DO NOTHING RETURNING "Uuid"',
                [DEFAULT_FIELD, DEFAULT_EVENT]
            );

            if (rows && rows.length) {
                logger.info(`Vault Tour: seeded ${rows.length} field deck(s) awaiting card data`);
            }

            return (rows || []).length;
        } catch (err) {
            logger.error('Vault Tour: could not seed the field', err);

            return 0;
        }
    }

    /**
     * Fetch the cards for field decks that have none yet.
     *
     * Bounded per run and paced between requests for the same reason the
     * Gauntlet's hydration is: this is somebody else's API, hit from the same
     * address as user-facing deck import, and a member waiting on their own
     * import matters more than the field being ready quickly.
     *
     * Every attempt stamps `FetchedAt` and the queue is oldest-attempt-first, so
     * a deck Master Vault could not answer for rotates to the back instead of
     * being retried in a tight loop - and is retried eventually, because the
     * usual cause is a bad minute rather than a bad deck.
     *
     * @returns {Promise<{hydrated: number, unplayable: number, failed: number}>}
     */
    async hydrateField({ decksPerRun } = {}) {
        const config = this.getConfig();
        const perRun = Math.max(1, parseInt(decksPerRun ?? config.vaultTourFetchPerRun, 10) || 3);
        const outcome = { hydrated: 0, unplayable: 0, failed: 0 };

        if (!this.deckService) {
            return outcome;
        }

        let pending;

        try {
            pending = await this.db.query(
                'SELECT "Uuid" FROM "VaultTourDecks" WHERE "Cards" IS NULL ' +
                    'ORDER BY "FetchedAt" ASC LIMIT $1',
                [perRun]
            );
        } catch (err) {
            logger.error('Vault Tour: could not list decks awaiting card data', err);

            return outcome;
        }

        for (const row of pending || []) {
            const stored = await this.hydrateOne(row.Uuid);

            outcome[stored] = (outcome[stored] || 0) + 1;

            if (stored === 'failed') {
                // Usually Master Vault metering us. Stop rather than spending the
                // rest of the run learning the same thing twice more.
                break;
            }

            const delay = parseInt(config.gauntletRequestDelayMs, 10);

            await this.sleep(Number.isFinite(delay) ? delay : 1500);
        }

        return outcome;
    }

    sleep(ms) {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }

    /**
     * Fetch one field deck's cards and store them.
     *
     * @returns {Promise<'hydrated'|'unplayable'|'failed'>}
     */
    async hydrateOne(uuid) {
        const result = await fetchDeck(uuid, {
            deckService: this.deckService,
            timeoutMs: this.getConfig().gauntletRequestTimeoutMs || 10000,
            label: 'vault-tour'
        });

        if (result.error) {
            // The stamp still moves: an attempt was made, and the queue is
            // ordered by when each deck was last tried.
            await this.db
                .query(
                    'UPDATE "VaultTourDecks" SET "FetchedAt" = ' +
                        'now() AT TIME ZONE \'utc\' WHERE "Uuid" = $1',
                    [uuid]
                )
                .catch(() => undefined);

            return 'failed';
        }

        const deck = playableDeck(result.parsed);

        try {
            await this.db.query(
                'UPDATE "VaultTourDecks" SET "Name" = $2, "Expansion" = $3, "Houses" = $4, ' +
                    '"Cards" = $5, "Playable" = $6, "MissingCards" = $7, "FetchedAt" = ' +
                    'now() AT TIME ZONE \'utc\' WHERE "Uuid" = $1',
                [
                    uuid,
                    deck.name || uuid,
                    deck.expansion || 0,
                    (deck.houses || []).join(',') || null,
                    deck.playable ? JSON.stringify(deck.cards) : null,
                    !!deck.playable,
                    deck.playable ? null : (deck.reasons || []).slice(0, 20).join(',')
                ]
            );
        } catch (err) {
            logger.error(`Vault Tour: could not store cards for ${uuid}`, err);

            return 'failed';
        }

        return deck.playable ? 'hydrated' : 'unplayable';
    }

    /** A Master Vault link, a uuid, or nothing. */
    parseUuid(link) {
        const match = UUID_PATTERN.exec(String(link || ''));

        return match ? match[0].toLowerCase() : null;
    }

    async removeDeck(uuid) {
        try {
            await this.db.query('DELETE FROM "VaultTourDecks" WHERE "Uuid" = $1', [uuid]);

            return true;
        } catch (err) {
            logger.error('Vault Tour: could not remove a field deck', err);

            return false;
        }
    }

    /** The whole field, newest event first, for the operator and the member. */
    async field() {
        try {
            const rows = await this.db.query(
                'SELECT "Uuid", "Name", "Expansion", "Houses", "Playable", "MissingCards", ' +
                    '"Event", "Placing", "EventDate", "GamesPlayed" FROM "VaultTourDecks" ' +
                    'ORDER BY "EventDate" DESC NULLS LAST, "Event", "Placing", "Name"'
            );

            return (rows || []).map((row) => ({
                uuid: row.Uuid,
                name: row.Name,
                expansion: row.Expansion,
                houses: row.Houses ? row.Houses.split(',') : [],
                playable: row.Playable,
                missing: row.MissingCards,
                event: row.Event,
                placing: row.Placing,
                eventDate: row.EventDate,
                games: row.GamesPlayed
            }));
        } catch (err) {
            logger.error('Vault Tour: could not read the field', err);

            return [];
        }
    }

    // ------------------------------------------------------------- the slate

    /** A member's chosen decks, with their names. */
    async slateFor(userId) {
        try {
            const rows = await this.db.query(
                'SELECT e."DeckId", e."EnrolledAt", d."Name", d."Uuid", ds."SasRating" ' +
                    'FROM "VaultTourEntries" e ' +
                    'JOIN "Decks" d ON d."Id" = e."DeckId" ' +
                    'LEFT JOIN "DeckSas" ds ON ds."Uuid" = d."Uuid" ' +
                    'WHERE e."UserId" = $1 ORDER BY e."EnrolledAt"',
                [userId]
            );

            return (rows || []).map((row) => ({
                deckId: row.DeckId,
                name: row.Name,
                uuid: row.Uuid,
                sas: row.SasRating,
                enrolledAt: row.EnrolledAt
            }));
        } catch (err) {
            logger.error('Vault Tour: could not read a slate', err);

            return [];
        }
    }

    /**
     * Put a deck on the slate. Throws with a sentence a player can read, the way
     * roster enrollment does.
     */
    async enroll(userId, deckId, { loadEngineDeck }) {
        const existing = await this.db.query(
            'SELECT COUNT(*)::int AS "Count" FROM "VaultTourEntries" WHERE "UserId" = $1',
            [userId]
        );

        if (existing[0] && existing[0].Count >= SLATE_SIZE) {
            throw new Error(
                `The Vault Tour runs ${SLATE_SIZE} decks at a time. Withdraw one to add another.`
            );
        }

        const decks = await this.db.query(
            'SELECT d."Id", d."UserId", d."Name", COALESCE(d."Banned", false) AS "Banned" ' +
                'FROM "Decks" d WHERE d."Id" = $1',
            [deckId]
        );
        const deck = decks && decks[0];

        if (!deck) {
            throw new Error('No such deck.');
        }

        if (deck.UserId !== userId) {
            throw new Error('Not your deck.');
        }

        if (deck.Banned) {
            throw new Error('That deck is banned from play.');
        }

        // No SAS requirement, unlike the roster: the roster compares a deck with
        // what its rating predicted, and the Vault Tour compares it with named
        // opponents. A deck DoK has never rated has a place here.
        const { missing, deck: engineDeck } = await loadEngineDeck(deckId);

        if (missing.length || engineDeck.houses.length !== 3) {
            throw new Error(
                'The lab cannot play that deck yet - it uses cards this server’s simulation ' +
                    'data does not cover.'
            );
        }

        await this.db.query(
            'INSERT INTO "VaultTourEntries" ("UserId", "DeckId", "EnrolledAt") ' +
                "VALUES ($1, $2, now() AT TIME ZONE 'utc') " +
                'ON CONFLICT ("UserId", "DeckId") DO NOTHING',
            [userId, deckId]
        );

        return { deckId, name: deck.Name };
    }

    async withdraw(userId, deckId) {
        await this.db.query(
            'DELETE FROM "VaultTourEntries" WHERE "UserId" = $1 AND "DeckId" = $2',
            [userId, deckId]
        );
    }

    // -------------------------------------------------------------- the play

    /** Everyone with a slate, for the sweep. */
    async rosters() {
        try {
            const rows = await this.db.query(
                'SELECT "UserId", "DeckId" FROM "VaultTourEntries" ORDER BY "UserId"'
            );

            return rows || [];
        } catch (err) {
            logger.error('Vault Tour: could not read the slates', err);

            return [];
        }
    }

    /**
     * Games each of a member's slate decks has played since UTC midnight.
     *
     * Counted from this table alone: the Vault Tour's budget is its own, so
     * these games neither steal from the roster's twelve nor are starved by them.
     */
    async gamesToday(userId) {
        const counts = new Map();

        try {
            const rows = await this.db.query(
                'SELECT "DeckId", COUNT(*)::int AS "Played" FROM "VaultTourGames" ' +
                    'WHERE "UserId" = $1 AND "FinishedAt" >= ' +
                    "date_trunc('day', now() AT TIME ZONE 'utc') GROUP BY \"DeckId\"",
                [userId]
            );

            for (const row of rows || []) {
                counts.set(row.DeckId, row.Played);
            }
        } catch (err) {
            logger.error('Vault Tour: could not count today’s games', err);
        }

        return counts;
    }

    /**
     * The next opponent for a member's deck: a playable field deck, least
     * recently played first, so the slate meets the whole field rather than the
     * same two decks forever.
     *
     * Never a deck the member owns - playing your own deck against itself is the
     * mirror lab, and it is next door.
     */
    async drawOpponent(userId) {
        let rows;

        try {
            rows = await this.db.query(
                'SELECT v."Uuid", v."Name", v."Expansion", v."Houses", v."Cards", v."Event", ' +
                    'v."Placing" FROM "VaultTourDecks" v ' +
                    'WHERE v."Playable" = true AND NOT EXISTS (' +
                    'SELECT 1 FROM "Decks" d WHERE d."Uuid" = v."Uuid" AND d."UserId" = $1) ' +
                    'ORDER BY v."LastPlayedAt" ASC NULLS FIRST, random() LIMIT 1',
                [userId]
            );
        } catch (err) {
            logger.error('Vault Tour: could not draw an opponent', err);

            return null;
        }

        const row = rows && rows[0];

        if (!row) {
            return null;
        }

        const cards = typeof row.Cards === 'string' ? JSON.parse(row.Cards) : row.Cards;

        return {
            uuid: row.Uuid,
            name: row.Name,
            event: row.Event,
            placing: row.Placing,
            deck: {
                name: row.Name,
                uuid: row.Uuid,
                expansion: row.Expansion,
                houses: row.Houses ? row.Houses.split(',') : [],
                cards
            }
        };
    }

    async noteOpponentPlayed(uuid) {
        try {
            await this.db.query(
                'UPDATE "VaultTourDecks" SET "LastPlayedAt" = ' +
                    'now() AT TIME ZONE \'utc\', "GamesPlayed" = "GamesPlayed" + 1 ' +
                    'WHERE "Uuid" = $1',
                [uuid]
            );
        } catch (err) {
            logger.error('Vault Tour: could not note a played opponent', err);
        }
    }

    /** One result, from the member's deck's point of view. */
    async recordGame({ userId, deckId, opponent, won, result, persona = null }) {
        const mine = won ? 'winner' : 'loser';
        const theirs = won ? 'loser' : 'winner';

        await this.db.query(
            'INSERT INTO "VaultTourGames" ' +
                '("UserId", "DeckId", "OpponentUuid", "OpponentName", "OpponentEvent", ' +
                '"OpponentPlacing", "Won", "MyKeys", "OpponentKeys", "Turns", "WentFirst", ' +
                '"Persona", "DurationMs", "FinishedAt") ' +
                'VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, ' +
                "now() AT TIME ZONE 'utc')",
            [
                userId,
                deckId,
                opponent.uuid,
                opponent.name,
                opponent.event,
                opponent.placing,
                won,
                result[`${mine}Keys`],
                result[`${theirs}Keys`],
                result.turns,
                won ? !!result.winnerWentFirst : !result.winnerWentFirst,
                persona,
                result.durationMs
            ]
        );
    }

    // ------------------------------------------------------------ the matrix

    /**
     * The whole point of the feature: this deck against that deck, both records.
     *
     * Rows are the member's slate, columns the field, cells the record between
     * exactly those two - because against a list of named opponents an average
     * is the least interesting number available. A deck that goes 60% overall
     * while losing every game to the one deck that won the biggest event of the
     * year has been told something an average would have hidden.
     *
     * Never throws; an empty matrix is what "no games yet" looks like.
     */
    async matrixFor(userId) {
        let rows;

        try {
            rows = await this.db.query(
                'SELECT "DeckId", "OpponentUuid", "OpponentName", "OpponentEvent", ' +
                    '"OpponentPlacing", COUNT(*)::int AS "Played", ' +
                    'COUNT(*) FILTER (WHERE "Won")::int AS "Wins" ' +
                    'FROM "VaultTourGames" WHERE "UserId" = $1 ' +
                    'GROUP BY "DeckId", "OpponentUuid", "OpponentName", "OpponentEvent", ' +
                    '"OpponentPlacing"',
                [userId]
            );
        } catch (err) {
            logger.error('Vault Tour: could not build the matrix', err);

            return { opponents: [], cells: {}, totals: {} };
        }

        const opponents = new Map();
        const cells = {};
        const totals = {};

        for (const row of rows || []) {
            if (!opponents.has(row.OpponentUuid)) {
                opponents.set(row.OpponentUuid, {
                    uuid: row.OpponentUuid,
                    name: row.OpponentName,
                    event: row.OpponentEvent,
                    placing: row.OpponentPlacing
                });
            }

            cells[`${row.DeckId}|${row.OpponentUuid}`] = {
                games: row.Played,
                wins: row.Wins,
                losses: row.Played - row.Wins,
                winRate: row.Played ? row.Wins / row.Played : null
            };

            const total = totals[row.DeckId] || { games: 0, wins: 0 };

            total.games += row.Played;
            total.wins += row.Wins;
            totals[row.DeckId] = total;
        }

        for (const [deckId, total] of Object.entries(totals)) {
            totals[deckId] = {
                ...total,
                losses: total.games - total.wins,
                // The interval, because "62% against the field" over eleven games
                // is not a finding, and the field is small on purpose.
                ...wilsonInterval(total.wins, total.games)
            };
        }

        return { opponents: [...opponents.values()], cells, totals };
    }

    /**
     * The decks a member could put on the slate.
     *
     * Its own query rather than the roster's candidate list, which is wrong here
     * three times over: it requires a SAS rating (the Vault Tour does not - it
     * compares a deck with named opponents rather than with what its rating
     * predicted), it excludes decks already in the eight (a deck may sit in
     * both, by design), and it is ordered by SAS, so a member saw their eight
     * highest-rated unenrolled decks and nothing else.
     */
    async candidatesFor(userId, { limit = 200 } = {}) {
        try {
            const rows = await this.db.query(
                'SELECT d."Id", d."Name", ds."SasRating" FROM "Decks" d ' +
                    'LEFT JOIN "DeckSas" ds ON ds."Uuid" = d."Uuid" ' +
                    'WHERE d."UserId" = $1 AND NOT COALESCE(d."Banned", false) ' +
                    'AND NOT EXISTS (SELECT 1 FROM "VaultTourEntries" e ' +
                    'WHERE e."UserId" = $1 AND e."DeckId" = d."Id") ' +
                    'ORDER BY lower(d."Name") LIMIT $2',
                [userId, Math.max(1, Math.min(1000, limit))]
            );

            return (rows || []).map((row) => ({
                deckId: row.Id,
                name: row.Name,
                sas: row.SasRating
            }));
        } catch (err) {
            logger.error('Vault Tour: could not list candidate decks', err);

            return [];
        }
    }

    /** Everything the member's panel needs, in one read. */
    async reportFor(userId) {
        const [slate, field, matrix, candidates] = await Promise.all([
            this.slateFor(userId),
            this.field(),
            this.matrixFor(userId),
            this.candidatesFor(userId)
        ]);

        return {
            enabled: this.isEnabled(),
            slateSize: SLATE_SIZE,
            gamesPerDeckPerDay: this.gamesPerDeckPerDay(),
            placings: PLACINGS,
            slate,
            candidates,
            // The member sees the field they are being measured against - a
            // matrix whose columns are unexplained is a wall of percentages -
            // but not WHY an entry is unplayable, which is the operator's
            // problem with their own card data rather than a player's.
            field: field.map((entry) => ({
                uuid: entry.uuid,
                name: entry.name,
                expansion: entry.expansion,
                houses: entry.houses,
                playable: entry.playable,
                event: entry.event,
                placing: entry.placing,
                eventDate: entry.eventDate,
                games: entry.games
            })),
            playableField: field.filter((deck) => deck.playable).length,
            matrix
        };
    }
}

module.exports = VaultTourService;
module.exports.SLATE_SIZE = SLATE_SIZE;
module.exports.PLACINGS = PLACINGS;
