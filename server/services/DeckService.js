const logger = require('../log');
const util = require('../util');
const db = require('../db');
const { expand, flatten } = require('../Array');
const { effectiveAri, EFFECTIVE_ARI_SQL } = require('./rating/AriService');
const Constants = require('../constants');
// ARCHON: game-deciding randomness comes from one place - see the module.
const secureRandom = require('../game/secureRandom');
const BonusOrder = Constants.Houses.concat(['amber', 'capture', 'damage', 'draw', 'discard']);

/**
 * ARCHON: the Unchained set.
 *
 * Playable only in an Unchained game, and the only thing playable there. It was
 * a bare 601 in getRandomDeckIdForUser and nowhere else, which is how the deck
 * LIST came to ignore the rule the dice enforced.
 */
const UNCHAINED_EXPANSION_ID = 601;

/**
 * ARCHON: "the same deck", for questions asked of every copy of it at once.
 *
 * A deck's identity is its Master Vault uuid, not its name: KeyForge builds
 * names from a finite word list, so two unrelated decks can and do share one.
 * Rows imported before uuids were recorded have nothing better, so they fall
 * back to matching on name - the old behaviour, for exactly the rows that
 * cannot do better.
 *
 * `d` is the outer deck row; `x` is the alias of the table being matched.
 */
const sameDeckAs = (alias) =>
    `CASE WHEN d."Uuid" IS NULL THEN ${alias}."Name" = d."Name" ELSE ${alias}."Uuid" = d."Uuid" END`;

/**
 * How many PEOPLE hold this deck - the number behind the inherited
 * Used / Popular / Notorious labels. It was COUNT(*) over rows sharing a name,
 * which counts name collisions between unrelated decks as shared ownership.
 */
const OWNER_COUNT_SQL = `(SELECT COUNT(DISTINCT x."UserId") FROM "Decks" x WHERE ${sameDeckAs(
    'x'
)})`;

/**
 * ARCHON: the record of this deck in EVERYONE's hands, not just its owner's.
 *
 * The per-owner counts answer "how do I do with this deck"; these answer "how
 * does this deck do", pooled across every account that owns a copy. Both are
 * worth seeing and they are different numbers, so the deck page shows them side
 * by side rather than picking one.
 *
 * Matched on the uuid the GAME recorded rather than through a live "Decks" row:
 * an owner who has since deleted their copy still played those games, and the
 * pooled record is the one number that should not care whose collection the
 * deck is currently in. Falls back to the row join for a deck with no uuid -
 * alliance and standalone decks - which have no durable identity to match on.
 *
 * A game with no winner (abandoned, still running) counts as neither.
 */
const globalRecord = (outcome) =>
    '(SELECT COUNT(*) FROM "Games" g ' +
    'JOIN "GamePlayers" gp ON gp."GameId" = g."Id" ' +
    // ARCHON (F9): a practice game against a bot is recorded and replayable,
    // and is not a result - it never moves a deck's record.
    'WHERE g."BotGame" IS NOT TRUE AND CASE WHEN d."Uuid" IS NULL ' +
    'THEN gp."DeckId" IN (SELECT x."Id" FROM "Decks" x WHERE x."Name" = d."Name") ' +
    'ELSE gp."DeckUuid" = d."Uuid" END ' +
    `AND ${outcome})`;

const GLOBAL_RECORD_SQL = {
    wins: globalRecord('g."WinnerId" = gp."PlayerId"'),
    losses: globalRecord('g."WinnerId" IS NOT NULL AND g."WinnerId" != gp."PlayerId"')
};

const allianceRestrictedRules = {
    befuddle: { expansions: [600] },
    ghostform: { expansions: [452, 600] },
    'heart-of-the-forest': { expansions: [435] },
    infurnace: { expansions: [452, 479, 874] },
    jervi: { expansions: [700] },
    'key-abduction': { expansions: [341, 435, 609, 700], maxQuantity: 1 },
    'legionary-trainer': { expansions: [600] },
    reiteration: { expansions: [886] },
    'strategic-feint': { expansions: [886] },
    'united-action': { expansions: [452, 496] },
    'winds-of-death': { expansions: [600, 609] }
};

/**
 * ARCHON: the sealed pool, as a table rather than a chain of eighteen ifs.
 *
 * Keyed by the set code the new-game form sends, valued by the
 * "Expansions"."ExpansionId" the decks carry. Deliberately not sourced from
 * server/constants.js: that list has no codes on it and omits several sets.
 */
const sealedExpansionIds = {
    cota: 341,
    aoa: 435,
    wc: 452,
    mm: 479,
    dt: 496,
    woe: 600,
    vm2023: 609,
    gr: 700,
    vm2024: 737,
    as: 800,
    toc: 855,
    momu: 874,
    pv: 886,
    disc: 907,
    cc: 918,
    dm: 928,
    vm2025: 939,
    vm2026: 964
};

/** Hand a transaction's connection back to the pool. */
function releaseClient(client) {
    if (client && client.release) {
        client.release();
    }
}

class DeckService {
    /**
     * ARCHON: the set-code map a sealed table needs, from the expansion ids an
     * event stores in AllowedSets. An empty or absent list means the whole
     * pool - see getSealedDeck.
     */
    static sealedExpansionsFromIds(expansionIds) {
        if (!Array.isArray(expansionIds) || expansionIds.length === 0) {
            return undefined;
        }

        const wanted = new Set(expansionIds.map((id) => Number(id)));
        const codes = Object.entries(sealedExpansionIds).filter(([, id]) => wanted.has(id));

        // A restriction we cannot express is not silently the whole pool.
        return codes.length > 0 ? Object.fromEntries(codes.map(([code]) => [code, true])) : null;
    }

    constructor(configService, cardService) {
        this.configService = configService;
        this.cardService = cardService;
        this.houseCache = {};
    }

    async getHouseIdFromName(house) {
        if (this.houseCache[house]) {
            return this.houseCache[house];
        }

        let houses;
        try {
            houses = await db.query('SELECT "Id", "Code" FROM "Houses"', []);
        } catch (err) {
            logger.error('Failed to retrieve houses', err);

            return undefined;
        }

        if (!houses || houses.length == 0) {
            logger.error('Could not find any houses');

            return undefined;
        }

        for (let house of houses) {
            this.houseCache[house.Code] = house.Id;
        }

        return this.houseCache[house];
    }

    async getByUuid(id) {
        let deck;

        try {
            deck = await db.query(
                'SELECT d.*, u."Username", e."ExpansionId" as "Expansion"' +
                    'FROM "Decks" d ' +
                    'JOIN "Users" u ON u."Id" = "UserId" ' +
                    'JOIN "Expansions" e on e."Id" = d."ExpansionId" ' +
                    'WHERE d."Uuid" = $1',
                [id]
            );
        } catch (err) {
            logger.error(`Failed to retrieve deck: ${id}`, err);

            throw new Error('Unable to fetch deck: ' + id);
        }

        if (!deck || deck.length === 0) {
            logger.warn(`Failed to retrieve deck: ${id} as it was not found`);

            return undefined;
        }

        let retDeck = this.mapDeck(deck[0]);

        await this.getDeckCardsAndHouses(retDeck);

        return retDeck;
    }

    async getByUuidForUser(id, userId) {
        let deck;

        try {
            deck = await db.query(
                'SELECT d.*, u."Username", e."ExpansionId" as "Expansion"' +
                    'FROM "Decks" d ' +
                    'JOIN "Users" u ON u."Id" = "UserId" ' +
                    'JOIN "Expansions" e on e."Id" = d."ExpansionId" ' +
                    'WHERE d."Uuid" = $1 AND d."UserId" = $2',
                [id, userId]
            );
        } catch (err) {
            logger.error(`Failed to retrieve deck: ${id} for user: ${userId}`, err);

            throw new Error('Unable to fetch deck: ' + id);
        }

        if (!deck || deck.length === 0) {
            return undefined;
        }

        let retDeck = this.mapDeck(deck[0]);

        await this.getDeckCardsAndHouses(retDeck);

        return retDeck;
    }

    async getById(id) {
        let deck;

        try {
            deck = await db.query(
                // ARCHON: $1 is the DECK id, and the win/loss subqueries used to
                // compare it against "WinnerId" and "PlayerId", which are USER
                // ids. The counts were therefore meaningless - zero unless a
                // deck id happened to equal a user id - and the mobile deck
                // screen has been showing them as a record ever since. The
                // owner is d."UserId", and correlating on that needs no extra
                // parameter.
                //
                // "DeckCount" is quoted for the same reason it is quoted in
                // getFlaggedUnverifiedDecksForUser: unquoted, Postgres folds it
                // to `deckcount`, mapDeck reads `deck.DeckCount` and gets
                // undefined, and every deck's usage level came out 0.
                // WinRate is derived in an outer select, the same way
                // findForUser does it, so the two endpoints agree. Without it
                // mapDeck's `winRate` was undefined here and only here.
                //
                // The Global* counts are the same deck in everyone's hands -
                // this is the only query that carries them, because the deck
                // page is the only place that shows them and they cost a join
                // per row.
                'SELECT *, ' +
                    'CASE WHEN "WinCount" + "LoseCount" = 0 THEN 0 ELSE (CAST("WinCount" AS FLOAT) / ("WinCount" + "LoseCount")) * 100 END AS "WinRate", ' +
                    'CASE WHEN "GlobalWinCount" + "GlobalLoseCount" = 0 THEN 0 ELSE (CAST("GlobalWinCount" AS FLOAT) / ("GlobalWinCount" + "GlobalLoseCount")) * 100 END AS "GlobalWinRate" ' +
                    'FROM ( ' +
                    `SELECT d.*, u."Username", e."ExpansionId" as "Expansion", ${OWNER_COUNT_SQL} AS "DeckCount", ` +
                    '(SELECT COUNT(*) FROM "Games" g JOIN "GamePlayers" gp ON gp."GameId" = g."Id" WHERE g."BotGame" IS NOT TRUE AND g."WinnerId" = d."UserId" AND gp."PlayerId" = d."UserId" AND gp."DeckId" = d."Id") AS "WinCount", ' +
                    '(SELECT COUNT(*) FROM "Games" g JOIN "GamePlayers" gp ON gp."GameId" = g."Id" WHERE g."BotGame" IS NOT TRUE AND g."WinnerId" != d."UserId" AND g."WinnerId" IS NOT NULL AND gp."PlayerId" = d."UserId" AND gp."DeckId" = d."Id") AS "LoseCount", ' +
                    `${GLOBAL_RECORD_SQL.wins} AS "GlobalWinCount", ` +
                    `${GLOBAL_RECORD_SQL.losses} AS "GlobalLoseCount" ` +
                    'FROM "Decks" d ' +
                    'JOIN "Users" u ON u."Id" = "UserId" ' +
                    'JOIN "Expansions" e on e."Id" = d."ExpansionId" ' +
                    'WHERE d."Id" = $1 ' +
                    ') sq ',
                [id]
            );
        } catch (err) {
            logger.error(`Failed to retrieve deck: ${id}`, err);

            throw new Error('Unable to fetch deck: ' + id);
        }

        if (!deck || deck.length === 0) {
            logger.warn(`Failed to retrieve deck: ${id} as it was not found`);

            return undefined;
        }

        let retDeck = this.mapDeck(deck[0]);

        await this.getDeckCardsAndHouses(retDeck);

        return retDeck;
    }

    /**
     * ARCHON: the Master Vault ids of every deck a user already owns, used
     * to skip re-importing during a Decks of KeyForge bulk sync.
     */
    async getOwnedDeckUuids(userId) {
        let rows;

        try {
            rows = await db.query(
                'SELECT "Uuid" FROM "Decks" WHERE "UserId" = $1 AND "Uuid" IS NOT NULL',
                [userId]
            );
        } catch (err) {
            logger.error('Failed to list owned deck uuids', err);

            return [];
        }

        return (rows || []).map((row) => row.Uuid);
    }

    /**
     * ARCHON: Lucky Dice - one random deck from everything a user owns that is
     * legal for the game asking.
     *
     * The constraints mirror what the deck-select modal offers for the same
     * game, so the dice can never land on a deck the player could not have
     * clicked: alliance decks only in alliance games, the Unchained set only in
     * (and only for) Unchained games, and in a SAS-bound game only decks whose
     * cached SAS sits inside the range - which also excludes decks DoK has not
     * rated, exactly as the bound itself does.
     *
     * The roll itself is ours rather than the database's - see the note on the
     * query below.
     *
     * @returns {Promise<number|null>} a deck id, or null when nothing is
     *          eligible (which callers should tell the player, not swallow)
     */
    async getRandomDeckIdForUser(
        userId,
        { isAlliance, unchainedOnly = false, sasMin, sasMax } = {}
    ) {
        const params = [userId];
        let where = 'WHERE d."UserId" = $1 ';

        if (isAlliance !== undefined && isAlliance !== null) {
            params.push(isAlliance);
            where += `AND d."IsAlliance" = $${params.length} `;
        }

        // Playable only in the unchained format, and the only thing playable
        // there. The deck list applies the same rule via the `unchained` filter.
        where += unchainedOnly
            ? `AND e."ExpansionId" = ${UNCHAINED_EXPANSION_ID} `
            : `AND e."ExpansionId" <> ${UNCHAINED_EXPANSION_ID} `;

        if (sasMin !== undefined && sasMin !== null) {
            params.push(sasMin);
            where += `AND ds."SasRating" >= $${params.length} `;
        }

        if (sasMax !== undefined && sasMax !== null) {
            params.push(sasMax);
            where += `AND ds."SasRating" <= $${params.length} `;
        }

        /**
         * ARCHON: the row is chosen HERE, not by Postgres.
         *
         * `ORDER BY random()` is uniform but predictable - Postgres's random()
         * is a seeded PRNG like any other, and this picks the deck somebody
         * plays a rated, sometimes paid, game with. Counting and then taking a
         * cryptographic offset costs one extra query on a path that runs once
         * per game, and makes the choice unguessable. See game/secureRandom.
         */
        let rows;

        try {
            const counted = await db.query(
                'SELECT count(*)::int AS "Total" FROM "Decks" d ' +
                    'JOIN "Expansions" e ON e."Id" = d."ExpansionId" ' +
                    'LEFT JOIN "DeckSas" ds ON ds."Uuid" = d."Uuid" ' +
                    where,
                params
            );
            const total = (counted && counted[0] && counted[0].Total) || 0;

            if (total === 0) {
                return null;
            }

            rows = await db.query(
                'SELECT d."Id" FROM "Decks" d ' +
                    'JOIN "Expansions" e ON e."Id" = d."ExpansionId" ' +
                    'LEFT JOIN "DeckSas" ds ON ds."Uuid" = d."Uuid" ' +
                    where +
                    `ORDER BY d."Id" OFFSET $${params.length + 1} LIMIT 1`,
                [...params, secureRandom.randomInt(total)]
            );
        } catch (err) {
            logger.error('Failed to pick a random deck', err);

            return null;
        }

        return rows && rows.length > 0 ? rows[0].Id : null;
    }

    /**
     * ARCHON (F9): a random deck for a practice bot, from the whole library.
     *
     * The pool is every deck this platform has ever imported - each one came
     * from Master Vault by way of Decks of KeyForge, and a deck is 36 cards
     * with a uuid, not somebody's property: the bot plays the cards, nothing
     * about whose collection a copy sits in reaches the table. Counting by
     * uuid rather than by row is what makes that true in the arithmetic too,
     * so a deck twenty people own is one deck in the hat, not twenty.
     *
     * Drawing from the library rather than from the bot's own collection is
     * what gives the difficulty settings something to choose from: three ARI
     * bands need hundreds of decks per house to feel different, and no
     * hand-stocked account is going to hold them.
     *
     * @param {object} options
     * @param {string} options.house the bot's house; the deck must contain it
     * @param {number} [options.minAri] inclusive
     * @param {number} [options.maxAri] inclusive
     * @param {number} [options.userId] restrict to one account's collection
     * @returns {Promise<number|null>} a "Decks" row id, or null for an empty pool
     */
    async getRandomPracticeDeckId(options = {}) {
        const { sql, params } = this.practiceDeckPool(options);

        try {
            const total = await this.countPracticeDecks(options);

            if (total === 0) {
                return null;
            }

            // Chosen here rather than by `ORDER BY random()`, for the reason
            // given on the Lucky Dice roll above.
            const rows = await db.query(
                `SELECT "Id" FROM (${sql}) pool ORDER BY "Id" OFFSET $${params.length + 1} LIMIT 1`,
                [...params, secureRandom.randomInt(total)]
            );

            return rows && rows.length > 0 ? rows[0].Id : null;
        } catch (err) {
            logger.error('Failed to pick a practice deck', err);

            return null;
        }
    }

    /**
     * How many distinct decks that pool holds - what Bot Settings shows, and
     * the total the random offset is drawn against.
     */
    async countPracticeDecks(options = {}) {
        const { sql, params } = this.practiceDeckPool(options);

        try {
            const rows = await db.query(
                `SELECT count(*)::int AS "Total" FROM (${sql}) pool`,
                params
            );

            return (rows && rows[0] && rows[0].Total) || 0;
        } catch (err) {
            logger.error('Failed to count practice decks', err);

            return 0;
        }
    }

    /** The pool query itself, shared by the count and the draw. */
    practiceDeckPool({ house, minAri, maxAri, userId } = {}) {
        const params = [];
        // A deck with no uuid predates the column; it is still one deck, and
        // its row id is the only identity it has.
        const identity = 'COALESCE(d."Uuid", \'row:\' || d."Id"::text)';
        let where =
            'WHERE d."IsAlliance" = false AND d."Banned" = false ' +
            'AND COALESCE(d."Flagged", false) = false ' +
            `AND e."ExpansionId" <> ${UNCHAINED_EXPANSION_ID} `;

        if (userId) {
            params.push(userId);
            where += `AND d."UserId" = $${params.length} `;
        }

        if (house) {
            params.push(String(house).toLowerCase());
            where +=
                'AND EXISTS (SELECT 1 FROM "DeckHouses" dh JOIN "Houses" h ON h."Id" = dh."HouseId" ' +
                `WHERE dh."DeckId" = d."Id" AND h."Code" = $${params.length}) `;
        }

        if (minAri !== undefined && minAri !== null) {
            params.push(minAri);
            where += `AND ${EFFECTIVE_ARI_SQL} >= $${params.length} `;
        }

        if (maxAri !== undefined && maxAri !== null) {
            params.push(maxAri);
            where += `AND ${EFFECTIVE_ARI_SQL} <= $${params.length} `;
        }

        return {
            sql:
                `SELECT DISTINCT ON (${identity}) d."Id" FROM "Decks" d ` +
                'JOIN "Expansions" e ON e."Id" = d."ExpansionId" ' +
                'LEFT JOIN "DeckSas" ds ON ds."Uuid" = d."Uuid" ' +
                'LEFT JOIN "DeckAri" da ON da."Uuid" = d."Uuid" ' +
                where +
                `ORDER BY ${identity}, d."Id"`,
            params
        };
    }

    async deckExistsForUser(user, deckId) {
        let deck;
        try {
            deck = await db.query(
                'SELECT 1 FROM "Decks" d WHERE d."Identity" = $1 AND d."UserId" = $2',
                [deckId, user.id]
            );
        } catch (err) {
            logger.error(`Failed to check deck: ${deckId}`, err);

            return false;
        }

        return deck && deck.length > 0;
    }

    async getStandaloneDeckById(standaloneId) {
        let deck;

        try {
            deck = await db.query(
                'SELECT d.*, e."ExpansionId" as "Expansion" ' +
                    'FROM "StandaloneDecks" d ' +
                    'JOIN "Expansions" e on e."Id" = d."ExpansionId" ' +
                    'WHERE d."Id" = $1 ',
                [standaloneId]
            );
        } catch (err) {
            logger.error(`Failed to retrieve deck: ${standaloneId}`, err);

            throw new Error('Unable to fetch deck: ' + standaloneId);
        }

        if (!deck || deck.length === 0) {
            logger.warn(`Failed to retrieve deck: ${standaloneId} as it was not found`);

            return undefined;
        }

        let retDeck = this.mapDeck(deck[0]);

        await this.getDeckCardsAndHouses(retDeck, true);

        return retDeck;
    }

    async getStandaloneDecks() {
        let decks;

        try {
            decks = await db.query(
                'SELECT d.*, e."ExpansionId" as "Expansion" ' +
                    'FROM "StandaloneDecks" d ' +
                    'JOIN "Expansions" e on e."Id" = d."ExpansionId"'
            );
        } catch (err) {
            logger.error('Failed to retrieve standalone decks', err);

            throw new Error('Unable to fetch standalone decks');
        }

        if (!decks || decks.length === 0) {
            logger.warn('Failed to retrieve standalone decks, none found');

            return undefined;
        }

        let retDecks = [];
        for (const deck of decks) {
            let retDeck = this.mapDeck(deck);

            retDeck.verified = true;

            await this.getDeckCardsAndHouses(retDeck, true);

            retDecks.push(retDeck);
        }

        return retDecks;
    }

    async createStandalone(deck) {
        return this.insertDeck(deck);
    }

    /**
     * ARCHON: deal a random sealed deck.
     *
     * `expansions` is the set list the table was built with, as a map of set
     * code to boolean - the shape the new-game form sends. A TOURNAMENT table
     * is built by the lobby rather than by that form, and an event whose
     * organizer restricted no sets has no list at all, so both "undefined" and
     * "empty" have to mean the whole sealed pool. They used to mean a
     * TypeError on `expansions.aoa` and a SQL `IN()` with nothing in it
     * respectively, which is why an online sealed event could never deal a
     * deck and so could never start a single game.
     */
    async getSealedDeck(expansions) {
        const dbExpansions = Object.entries(sealedExpansionIds)
            .filter(([code]) => expansions && expansions[code])
            .map(([, id]) => id);

        let deck;
        // No sets chosen means every set, not none: `IN()` is a syntax error.
        const setFilter =
            dbExpansions.length > 0
                ? ` AND d."ExpansionId" IN (SELECT "Id" FROM "Expansions" WHERE "ExpansionId" IN(${dbExpansions.join(
                      ','
                  )}))`
                : '';
        try {
            // ARCHON: chosen here rather than by Postgres, for the same reason
            // as the Lucky Dice pick above - a sealed deal decides a game, and
            // `ORDER BY random()` is uniform but predictable. See
            // game/secureRandom.
            const counted = await db.query(
                `SELECT count(*)::int AS "Total" from "Decks" d JOIN "Expansions" e on e."Id" = d."ExpansionId" WHERE "IncludeInSealed" = True${setFilter}`
            );
            const total = (counted && counted[0] && counted[0].Total) || 0;

            if (total === 0) {
                logger.warn('Could not find any sealed decks!');

                return undefined;
            }

            deck = await db.query(
                `SELECT d.*, e."ExpansionId" AS "Expansion" from "Decks" d JOIN "Expansions" e on e."Id" = d."ExpansionId" WHERE "IncludeInSealed" = True${setFilter} ORDER BY d."Id" OFFSET $1 LIMIT 1`,
                [secureRandom.randomInt(total)]
            );
        } catch (err) {
            logger.error('Failed to fetch random deck', err);
            throw new Error('Failed to fetch random deck');
        }

        if (!deck || deck.length === 0) {
            logger.warn('Could not find any sealed decks!');
            return undefined;
        }

        let retDeck = this.mapDeck(deck[0]);

        await this.getDeckCardsAndHouses(retDeck);

        return retDeck;
    }

    async getNumDecksForUser(
        user,
        options = { page: 1, pageSize: 10, sort: 'lastUpdated', sortDir: 'desc', filter: [] }
    ) {
        let ret;
        let params = [user.id];
        let index = 2;
        const filter = this.processFilter(index, params, options?.filter);

        try {
            ret = await db.query(
                // DeckSas joined for the same reason findForUser joins it: the
                // sasMin/sasMax filters compare against ds, and a count that
                // cannot see the column would disagree with the page it counts.
                'SELECT COUNT(*) AS "NumDecks" FROM "Decks" d ' +
                    'JOIN "Expansions" e ON e."Id" = d."ExpansionId" ' +
                    'LEFT JOIN "DeckSas" ds ON ds."Uuid" = d."Uuid" ' +
                    // DeckAri joined for the same reason: every column a filter
                    // can name has to resolve in the count as well as in the
                    // page, or the pager promises rows the page cannot show.
                    'LEFT JOIN "DeckAri" da ON da."Uuid" = d."Uuid" ' +
                    'WHERE "UserId" = $1 ' +
                    filter,
                params
            );
        } catch (err) {
            logger.error('Failed to count users decks');

            throw new Error('Failed to count decks');
        }

        return ret && ret.length > 0 ? ret[0].NumDecks : 0;
    }

    mapColumn(column, isSort = false) {
        switch (column) {
            case 'lastUpdated':
                return '"LastUpdated"';
            case 'name':
                return isSort ? 'lower("Name")' : 'lower(d."Name")';
            case 'expansion':
                return isSort ? '"Expansion"' : 'e."ExpansionId"';
            case 'winRate':
                return '"WinRate"';
            // The client's SAS column is keyed 'sasRating', and an unrecognised
            // sort silently became LastUpdated - which is how sorting by SAS
            // ended up ordering by date and then being re-sorted per page.
            case 'sasRating':
            case 'sas':
                return '"SasRating"';
            // ARCHON: ARI, and specifically the EFFECTIVE ARI - the stored
            // rating when games have moved it, the SAS/AERC seed otherwise.
            // Ordering by the stored column alone would bury every deck the
            // engine has not touched yet behind decks it has, which is most of
            // a collection and none of what the reader asked for.
            //
            // A sort runs outside the subquery, where the computed column is in
            // scope; a filter would run inside it, where the joins are.
            case 'ari':
                return isSort ? '"EffectiveAri"' : EFFECTIVE_ARI_SQL;
            case 'isAlliance':
                return '"IsAlliance"';
            default:
                // A sort this query cannot express must not pass for one it can.
                // Falling through to LastUpdated silently is exactly how "sort
                // by ARI" came to mean "newest first, then reordered within
                // whichever fifteen rows the page happened to hold" - an answer
                // with no way for a reader to tell it was the wrong one.
                if (column) {
                    logger.warn(
                        `Deck query asked to sort by "${column}", which has no column here; ` +
                            'ordering by LastUpdated instead'
                    );
                }

                return '"LastUpdated"';
        }
    }

    processFilter(index, params, filterOptions) {
        if (typeof filterOptions === 'string') {
            try {
                filterOptions = JSON.parse(filterOptions);
            } catch (error) {
                filterOptions = [];
            }
        }
        let filter = '';

        for (let filterObject of filterOptions || []) {
            if (filterObject.name === 'expansion') {
                if (!filterObject.value) {
                    continue;
                }
                if (filterObject.value.length === 0) {
                    filter += 'AND 1 = 0 ';
                    continue;
                }
                filter += `AND ${this.mapColumn(filterObject.name)} IN ${expand(
                    1,
                    filterObject.value.length,
                    index
                )} `;
                params.push(
                    ...filterObject.value.map((v) =>
                        typeof v === 'object' && v !== null ? v.value : v
                    )
                );
                index += filterObject.value.length;
            } else if (filterObject.name === 'isAlliance') {
                filter += `AND ${this.mapColumn(filterObject.name)} = $${index++} `;
                params.push(filterObject.value);
            } else if (filterObject.name === 'unchained') {
                // ARCHON: the Unchained set is playable only in an Unchained
                // game and is the only thing playable there.
                //
                // The web picker expresses this by narrowing its expansion
                // list; a client that filters by set id rather than by
                // enumerating twenty expansions needs to say it in one flag,
                // and getRandomDeckIdForUser already applies the same rule.
                //
                // Not parameterised because it is a constant, not input: the
                // value only decides which side of the comparison to take.
                filter += filterObject.value
                    ? `AND e."ExpansionId" = ${UNCHAINED_EXPANSION_ID} `
                    : `AND e."ExpansionId" <> ${UNCHAINED_EXPANSION_ID} `;
            } else if (filterObject.name === 'house') {
                // ARCHON: houses live in DeckHouses, not on the deck row, so
                // they cannot go through mapColumn. Repeat the filter once per
                // house to mean "contains all of these" - the way a player
                // narrowing a collection expects it to read.
                if (!filterObject.value) {
                    continue;
                }
                filter +=
                    'AND EXISTS (SELECT 1 FROM "DeckHouses" dh JOIN "Houses" h ON h."Id" = dh."HouseId" ' +
                    `WHERE dh."DeckId" = d."Id" AND h."Code" = $${index++}) `;
                params.push(String(filterObject.value).toLowerCase());
            } else if (filterObject.name === 'sasMin' || filterObject.name === 'sasMax') {
                // ARCHON: the deck picker for a SAS-bound game only shows what
                // the game will accept. Bounds are compared on the DeckSas join
                // (ds), which both deck queries include; >= against NULL is
                // false, so unrated decks drop out of a bounded list - the same
                // rule the game itself enforces.
                const bound = parseInt(filterObject.value, 10);

                if (Number.isNaN(bound)) {
                    continue;
                }

                const operator = filterObject.name === 'sasMin' ? '>=' : '<=';
                filter += `AND ds."SasRating" ${operator} $${index++} `;
                params.push(bound);
            } else {
                filter += `AND ${this.mapColumn(filterObject.name)} LIKE $${index++} `;
                params.push(`%${filterObject.value}%`);
            }
        }

        return filter;
    }

    async findForUser(
        user,
        options = { page: 1, pageSize: 10, sort: 'lastUpdated', sortDir: 'desc', filter: [] }
    ) {
        let retDecks = [];
        let decks;
        let pageSize = options.pageSize;
        let page = options.page;
        let sortColumn = this.mapColumn(options.sort, true);
        let sortDir = options.sortDir === 'desc' ? 'DESC' : 'ASC';
        let params = [user.id, pageSize, (page - 1) * pageSize];

        let index = 4;
        const filter = this.processFilter(index, params, options.filter);

        try {
            decks = await db.query(
                'SELECT *, CASE WHEN "WinCount" + "LoseCount" = 0 THEN 0 ELSE (CAST("WinCount" AS FLOAT) / ("WinCount" + "LoseCount")) * 100 END AS "WinRate" FROM ( ' +
                    // ARCHON: "DeckCount" quoted. Unquoted, Postgres folds the
                    // alias to `deckcount`, so mapDeck's `deck.DeckCount` was
                    // undefined and every deck's usage level computed as 0.
                    `SELECT d.*, u."Username", e."ExpansionId" as "Expansion", ds."SasRating" AS "SasRating", ds."AercScore" AS "AercScore", da."Ari" AS "Ari", ${EFFECTIVE_ARI_SQL} AS "EffectiveAri", ${OWNER_COUNT_SQL} AS "DeckCount", ` +
                    '(SELECT COUNT(*) FROM "Games" g JOIN "GamePlayers" gp ON gp."GameId" = g."Id" WHERE g."BotGame" IS NOT TRUE AND g."WinnerId" = $1 AND gp."DeckId" = d."Id") AS "WinCount", ' +
                    '(SELECT COUNT(*) FROM "Games" g JOIN "GamePlayers" gp ON gp."GameId" = g."Id" WHERE g."BotGame" IS NOT TRUE AND g."WinnerId" != $1 AND g."WinnerId" IS NOT NULL AND gp."PlayerId" = $1 AND gp."DeckId" = d."Id") AS "LoseCount" ' +
                    // ARCHON: SAS joined HERE rather than attached to the page
                    // afterwards. It used to be decorated onto the rows the API
                    // had already fetched, which meant the database could not
                    // order by it: a request to sort by SAS fell through to
                    // LastUpdated, and the client re-sorted the fifteen rows it
                    // happened to receive. "Highest SAS" showed the best deck on
                    // page one, not the best deck you own. LEFT so a deck with
                    // no cached score is still listed.
                    'FROM "Decks" d ' +
                    'JOIN "Users" u ON u."Id" = "UserId" ' +
                    'JOIN "Expansions" e on e."Id" = d."ExpansionId" ' +
                    'LEFT JOIN "DeckSas" ds ON ds."Uuid" = d."Uuid" ' +
                    // ARCHON (N19): ARI beside SAS on every deck row.
                    'LEFT JOIN "DeckAri" da ON da."Uuid" = d."Uuid" ' +
                    'WHERE "UserId" = $1 ' +
                    filter +
                    ') sq ' +
                    // NULLS LAST in both directions: an unscored deck is not a
                    // zero-SAS deck, and sorting ascending should not open with
                    // every deck DoK has never rated.
                    //
                    // "Id" breaks every tie, and it is not decoration: SAS, ARI,
                    // set and win rate all repeat freely across a collection, and
                    // an ORDER BY that leaves ties unordered lets Postgres return
                    // them in a different order for each page - so a deck could
                    // appear on page one AND page two while another appeared on
                    // neither. Pagination is only coherent over a total order.
                    `ORDER BY ${sortColumn} ${sortDir} NULLS LAST, "Id" ASC ` +
                    'LIMIT $2 ' +
                    'OFFSET $3',
                params
            );
        } catch (err) {
            logger.error('Failed to retrieve decks', err);
        }

        // ARCHON (N33): the lab's hidden-gem verdict, on the deck list.
        //
        // A member's decks are looked at here far more often than on the
        // Champion's Challenge page, and "this one wins more than its rating
        // says it should" is the most useful thing the lab knows about a deck.
        // The verdict is ASKED FOR, not recomputed: the threshold and the
        // confidence rule stay in labMath, where they are tested, and the day
        // they change this list changes with them. One grouped read per page,
        // and a failure costs a badge rather than the deck list.
        const gems = await this.hiddenGemDeckIds(user);

        for (let deck of decks) {
            let retDeck = this.mapDeck(deck);

            await this.getDeckCardsAndHouses(retDeck);

            retDeck.hiddenGem = gems.has(retDeck.id);

            retDecks.push(retDeck);
        }

        return retDecks;
    }

    /**
     * Deck ids the Champion's Challenge currently calls hidden gems, or an
     * empty set when there is no lab to ask. Injected rather than required at
     * the top so DeckService keeps no hard dependency on the lab: this is a
     * badge, and a site running without the Challenge still lists decks.
     */
    async hiddenGemDeckIds(user) {
        const lab = this.championsChallengeService;

        if (!user || !lab || typeof lab.hiddenGemsFor !== 'function') {
            return new Set();
        }

        return lab.hiddenGemsFor(user.id);
    }

    async getDeckCardsAndHouses(deck, standalone = false) {
        let cardTableQuery;

        if (standalone) {
            cardTableQuery = 'SELECT * FROM "StandaloneDeckCards" WHERE "DeckId" = $1';
        } else {
            cardTableQuery =
                'SELECT dc.*, h."Code" as "House" FROM "DeckCards" dc LEFT JOIN "Houses" h ON h."Id" = dc."HouseId" WHERE "DeckId" = $1';
        }

        let cards = await db.query(cardTableQuery, [deck.id]);

        // These are cards that have changed houses in later sets.
        let specialCardDefaultHouses = {
            'armageddon-cloak': 'sanctum',
            'avenging-aura': 'sanctum',
            'book-of-malefaction': 'sanctum',
            'eye-of-judgment': 'sanctum',
            'hymn-to-duma': 'sanctum',
            'johnny-longfingers': 'shadows',
            'lord-golgotha': 'sanctum',
            'mantle-of-the-zealot': 'sanctum',
            'martyr-s-end': 'sanctum',
            'master-of-the-grey': 'sanctum',
            'mighty-lance': 'sanctum',
            'one-stood-against-many': 'sanctum',
            'rogue-ogre': 'brobnar',
            'the-promised-blade': 'sanctum',
            'champion-tabris': 'sanctum',
            'dark-centurion': 'saurian',
            'first-or-last': 'sanctum',
            francus: 'sanctum',
            'glorious-few': 'sanctum',
            'gorm-of-omm': 'sanctum',
            'grey-abbess': 'sanctum',
            'professor-terato': 'logos',
            'scrivener-favian': 'sanctum',
            'bordan-the-redeemed': 'sanctum',
            'bull-wark': 'sanctum',
            'burning-glare': 'sanctum',
            'citizen-shrix': 'saurian',
            retribution: 'sanctum',
            'shifting-battlefield': 'sanctum',
            snarette: 'dis',
            'subtle-otto': 'shadows',
            'even-ivan': 'logos',
            'odd-clawde': 'logos',
            'sacro-alien': 'staralliance',
            'sacro-beast': 'untamed',
            'sacro-bot': 'logos',
            'sacro-fiend': 'dis',
            'sacro-saurus': 'saurian',
            'sacro-thief': 'shadows',
            corrode: 'unfathomable',
            'purifier-of-souls': 'sanctum',
            stampede: 'untamed',
            'follow-the-leader': 'brobnar',
            picaroon: 'dis',
            'research-smoko': 'logos',
            'vault-s-blessing': 'untamed'
        };

        deck.cards = cards.map((card) => ({
            dbId: card.Id,
            id: card.CardId,
            count: card.Count,
            maverick: card.Maverick || undefined,
            anomaly: card.Anomaly || undefined,
            image: card.ImageUrl || undefined,
            house: card.House || specialCardDefaultHouses[card.CardId] || undefined,
            isNonDeck: card.IsNonDeck,
            prophecyId: card.ProphecyId || undefined,
            enhancements: card.Enhancements
                ? card.Enhancements.replace(/[[{}"\]]/gi, '')
                      .split(',')
                      .filter((c) => c.length > 0)
                      .sort((a, b) => BonusOrder.indexOf(a) - BonusOrder.indexOf(b))
                : undefined
        }));

        // Sort cards: prophecy cards by ProphecyId first, then by dbId, others maintain original order
        deck.cards.sort((a, b) => {
            // Put deck cards first.
            if (!a.isNonDeck && b.isNonDeck) {
                return -1;
            }
            if (a.isNonDeck && !b.isNonDeck) {
                return 1;
            }

            // If both have ProphecyId, sort by ProphecyId first, then by dbId
            if (a.prophecyId && b.prophecyId) {
                if (a.prophecyId !== b.prophecyId) {
                    return a.prophecyId - b.prophecyId;
                }
                return a.dbId - b.dbId;
            }
            // If neither has ProphecyId, maintain original order by dbId
            return a.dbId - b.dbId;
        });

        let houseTable = standalone ? 'StandaloneDeckHouses' : 'DeckHouses';
        let houses = await db.query(
            `SELECT * FROM "${houseTable}" dh JOIN "Houses" h ON h."Id" = dh."HouseId" WHERE "DeckId" = $1`,
            [deck.id]
        );
        deck.houses = houses.map((house) => house.Code);

        if (!standalone) {
            let accolades = await db.query(
                'SELECT * FROM "DeckAccolades" WHERE "DeckId" = $1 ORDER BY "Id"',
                [deck.id]
            );
            deck.accolades = accolades.map((a) => ({
                id: a.AccoladeId,
                name: a.Name,
                image: a.ImageUrl,
                shown: a.Shown
            }));
        }

        deck.isStandalone = standalone;
    }

    async create(user, deck) {
        let deckResponse;

        try {
            let response = await util.httpRequest(
                `https://www.keyforgegame.com/api/decks/${deck.uuid}/?links=cards`,
                { allowedHosts: ['www.keyforgegame.com'] }
            );

            if (response[0] === '<') {
                logger.error('Deck failed to import: %s %s', deck.uuid, response);

                throw new Error('Invalid response from Api. Please try again later.');
            }

            deckResponse = JSON.parse(response);
        } catch (error) {
            logger.error(`Unable to import deck ${deck.uuid}`, error);

            // ARCHON: say WHICH upstream failure this was. Master Vault meters
            // hard, and a bulk import that cannot tell "you are going too fast"
            // from "this deck is broken" has no way to back off - it just burns
            // through the rest of the collection failing, which is how a
            // 257-deck sync imported 3 and reported 251 unexplained failures.
            const rateLimited = error.statusCode === 429;
            const importError = new Error(
                rateLimited
                    ? 'Master Vault is rate limiting deck imports. Please wait a moment and try again.'
                    : 'Invalid response from Api. Please try again later.'
            );
            importError.code = rateLimited ? 'upstream_rate_limited' : 'upstream_error';
            importError.statusCode = error.statusCode;

            throw importError;
        }

        if (!deckResponse || !deckResponse._linked || !deckResponse.data) {
            throw new Error('Invalid response from Api. Please try again later.');
        }

        let newDeck = await this.parseDeckResponse(deck.username, deckResponse);
        if (!newDeck) {
            throw new Error('There was a problem importing your deck, please try again later.');
        }

        let validExpansion = await this.checkValidDeckExpansion(newDeck);
        if (!validExpansion) {
            return {
                success: false,
                message: 'This deck is from a future expansion and not currently supported'
            };
        }

        let deckExists = await this.deckExistsForUser(user, newDeck.identity);
        if (deckExists) {
            return {
                success: false,
                message: 'Deck already exists.'
            };
        }

        newDeck.isAlliance = false;

        let response = await this.insertDeck(newDeck, user);

        return {
            success: true,
            deck: await this.getById(response.id)
        };
    }

    async createAlliance(user, deck) {
        if (!Array.isArray(deck.pods) || deck.pods.length !== 3) {
            throw new Error('Alliance decks must be built from exactly 3 house pods');
        }

        const parsedPods = deck.pods.map((pod) => {
            const [deckId, house] = typeof pod === 'string' ? pod.split(':') : [];
            return {
                deckId,
                house
            };
        });

        if (parsedPods.some((pod) => !pod.deckId || !pod.house)) {
            throw new Error('Each pod must be in the format deckUuid:house');
        }

        const uniqueHouses = new Set(parsedPods.map((pod) => pod.house));
        if (uniqueHouses.size !== 3) {
            throw new Error('Alliance decks must use 3 different houses');
        }

        const deckIds = parsedPods.map((pod) => pod.deckId);
        const uniqueDeckIds = Array.from(new Set(deckIds));
        const ownedDeckPromises = uniqueDeckIds.map((deckId) =>
            this.getByUuidForUser(deckId, user.id)
        );
        const decksByUuid = {};
        let cardsById;
        const allCardsById = await this.cardService.getAllCards();
        let expansionId;

        const ownedDecks = await Promise.all(ownedDeckPromises);
        const missingOwnedDeckIds = [];

        for (let i = 0; i < ownedDecks.length; i++) {
            const dbDeck = ownedDecks[i];
            if (!dbDeck) {
                missingOwnedDeckIds.push(uniqueDeckIds[i]);
                continue;
            }

            if (!expansionId) {
                expansionId = dbDeck.expansion;
            } else if (expansionId !== dbDeck.expansion) {
                throw new Error(
                    'Failed to create deck. Only Alliance from the same expansion is allowed'
                );
            }

            if (!cardsById) {
                cardsById = await this.cardService.getCardsForExpansionById(
                    undefined,
                    dbDeck.expansion
                );
                deck.expansion = dbDeck.expansion;
            }

            decksByUuid[dbDeck.uuid] = dbDeck;
        }

        if (missingOwnedDeckIds.length > 0) {
            const missingDeckChecks = await Promise.all(
                missingOwnedDeckIds.map((deckId) => this.getByUuid(deckId))
            );

            if (missingDeckChecks.some((dbDeck) => !!dbDeck)) {
                throw new Error('Failed to create deck. You may only use your own decks');
            }

            throw new Error('Failed to create deck. One or more source decks do not exist');
        }

        const expansion = Constants.Expansions.find((candidate) => candidate.id === expansionId);
        const expansionRequiresTide = Boolean(expansion?.tideRequired);
        const expansionRequiresToken = Boolean(expansion?.tokenRequired);
        const expansionSupportsProphecy = Boolean(expansion?.prophecySupported);
        const selectedDeckIds = uniqueDeckIds;

        for (let pod of parsedPods) {
            const sourceDeck = decksByUuid[pod.deckId];
            if (!sourceDeck.houses.includes(pod.house)) {
                throw new Error('Failed to create deck. Invalid house selection for source deck');
            }
        }

        const selectedTokenId = deck.tokenCard && deck.tokenCard.id ? deck.tokenCard.id : undefined;
        const selectedTokenSourceDeck = deck.tokenSourceDeck;

        if (expansionRequiresToken && !selectedTokenId && !selectedTokenSourceDeck) {
            throw new Error('Token creature source must be specified for this set');
        }

        if (!expansionRequiresToken && (selectedTokenId || selectedTokenSourceDeck)) {
            throw new Error('Token creature reference cards are not allowed for this set');
        }

        const isTokenCreatureCard = (card) => {
            const cardType =
                card?.card?.type || cardsById?.[card?.id]?.type || allCardsById?.[card?.id]?.type;
            return card?.isNonDeck && card?.id !== 'the-tide' && cardType === 'token creature';
        };

        let tokenCardToAdd;
        if (expansionRequiresToken) {
            if (selectedTokenSourceDeck) {
                const sourceDeck = decksByUuid[selectedTokenSourceDeck];
                if (!sourceDeck || !selectedDeckIds.includes(selectedTokenSourceDeck)) {
                    throw new Error(
                        'Selected token source deck must contribute at least one selected pod'
                    );
                }

                tokenCardToAdd = sourceDeck.cards.find((card) => isTokenCreatureCard(card));
            } else {
                for (const selectedDeckId of selectedDeckIds) {
                    const selectedDeck = decksByUuid[selectedDeckId];
                    const tokenCard = selectedDeck.cards.find(
                        (card) => card.id === selectedTokenId && isTokenCreatureCard(card)
                    );

                    if (tokenCard) {
                        tokenCardToAdd = tokenCard;
                        break;
                    }
                }
            }

            if (!tokenCardToAdd) {
                throw new Error('Selected token creature must come from a contributing deck');
            }
        }

        const prophecySourceDecks = selectedDeckIds
            .map((selectedDeckId) => decksByUuid[selectedDeckId])
            .filter((selectedDeck) =>
                selectedDeck.cards.some(
                    (card) => (card.card && card.card.type === 'prophecy') || card.prophecyId
                )
            );

        if (!expansionSupportsProphecy && deck.prophecySourceDeck) {
            throw new Error('Prophecy cards are not allowed for this set');
        }

        let prophecySourceDeck;
        if (expansionSupportsProphecy && prophecySourceDecks.length > 0) {
            if (prophecySourceDecks.length === 1) {
                prophecySourceDeck = prophecySourceDecks[0];
                if (
                    deck.prophecySourceDeck &&
                    deck.prophecySourceDeck !== prophecySourceDeck.uuid
                ) {
                    throw new Error('Invalid prophecy source deck specified');
                }
            } else {
                if (!deck.prophecySourceDeck) {
                    throw new Error('Prophecy source deck must be specified for this alliance');
                }

                prophecySourceDeck = decksByUuid[deck.prophecySourceDeck];
                if (!prophecySourceDeck) {
                    throw new Error('Invalid prophecy source deck specified');
                }

                if (!selectedDeckIds.includes(prophecySourceDeck.uuid)) {
                    throw new Error(
                        'Prophecy source deck must contribute at least one selected pod'
                    );
                }

                const sourceHasProphecy = prophecySourceDeck.cards.some(
                    (card) => (card.card && card.card.type === 'prophecy') || card.prophecyId
                );
                if (!sourceHasProphecy) {
                    throw new Error(
                        'Selected prophecy source deck does not contain prophecy cards'
                    );
                }
            }
        }

        if (!expansionSupportsProphecy && prophecySourceDecks.length > 0) {
            throw new Error('Prophecy cards are not allowed for this set');
        }

        deck.houses = Constants.Houses.filter((house) =>
            parsedPods.some((pod) => pod.house === house)
        );

        let podCards = [];

        if (prophecySourceDeck) {
            const sourceProphecyCards = prophecySourceDeck.cards.filter(
                (card) => (card.card && card.card.type === 'prophecy') || card.prophecyId
            );

            for (let card of sourceProphecyCards) {
                podCards.push({
                    ...card,
                    prophecyId: card.prophecyId
                });
            }
        }

        if (expansionRequiresToken && tokenCardToAdd) {
            podCards.push(tokenCardToAdd);
        }

        for (let pod of parsedPods) {
            const dbDeck = decksByUuid[pod.deckId];
            const house = pod.house;

            for (let card of dbDeck.cards) {
                if ((card.card && card.card.type === 'prophecy') || card.prophecyId) {
                    continue;
                }

                if (card.card && card.card.type === 'archon power') {
                    continue;
                }

                if (card.isNonDeck) {
                    continue;
                }

                if (card.maverick === house || card.anomaly === house || card.house === house) {
                    podCards.push(card);
                } else if (!card.maverick && !card.anomaly && !card.house) {
                    if (cardsById[card.id] && cardsById[card.id].house === house) {
                        podCards.push(card);
                    } else if (allCardsById[card.id].house === house) {
                        podCards.push(card);
                    }
                }
            }
        }

        if (expansionRequiresTide) {
            podCards.push({
                count: 1,
                id: 'the-tide',
                isNonDeck: true
            });
        }

        const isSingleUnmodifiedArchonDeck = this.isSingleUnmodifiedArchonDeck(
            parsedPods,
            decksByUuid
        );
        if (!isSingleUnmodifiedArchonDeck) {
            this.validateAllianceRestrictedList(podCards, expansionId);
        }

        deck.lastUpdated = new Date();
        deck.identity = deck.name;
        deck.cards = podCards;
        deck.isAlliance = true;
        // ARCHON (N9): record which physical decks the pods came from. Until
        // now this was consumed here and discarded, leaving the finished deck
        // with no trace of its provenance - so no Alliance event rule ("one
        // pod per deck", "pods only from these sets", "nobody else may source
        // from a deck you used") could be checked at all.
        deck.alliancePods = parsedPods.map((pod) => ({
            deckUuid: pod.deckId,
            house: pod.house
        }));

        return this.insertDeck(deck, user);
    }

    isSingleUnmodifiedArchonDeck(parsedPods, decksByUuid) {
        const uniqueDeckIds = Array.from(new Set(parsedPods.map((pod) => pod.deckId)));
        if (uniqueDeckIds.length !== 1) {
            return false;
        }

        const sourceDeck = decksByUuid[uniqueDeckIds[0]];
        if (!sourceDeck || !Array.isArray(sourceDeck.houses) || sourceDeck.houses.length !== 3) {
            return false;
        }

        const selectedHouses = parsedPods.map((pod) => pod.house).sort();
        const sourceHouses = [...sourceDeck.houses].sort();

        return selectedHouses.join(':') === sourceHouses.join(':');
    }

    validateAllianceRestrictedList(cards, expansionId) {
        const applicableRules = Object.entries(allianceRestrictedRules)
            .filter(([, rule]) => rule.expansions.includes(expansionId))
            .reduce((acc, [cardId, rule]) => {
                acc[cardId] = rule;
                return acc;
            }, {});

        if (Object.keys(applicableRules).length === 0) {
            return;
        }

        const restrictedCardsInDeck = cards.filter(
            (card) => !card.isNonDeck && applicableRules[card.id]
        );

        const quantitiesByCardId = restrictedCardsInDeck.reduce((acc, card) => {
            acc[card.id] = (acc[card.id] || 0) + (card.count || 1);
            return acc;
        }, {});

        const restrictedCardIds = Object.keys(quantitiesByCardId);
        if (restrictedCardIds.length > 1) {
            throw new Error('Alliance deck may include cards from only one restricted card name');
        }

        const restrictedCardId = restrictedCardIds[0];
        if (!restrictedCardId) {
            return;
        }

        const rule = applicableRules[restrictedCardId];
        if (rule.maxQuantity && quantitiesByCardId[restrictedCardId] > rule.maxQuantity) {
            throw new Error(
                `Alliance restricted card ${restrictedCardId} exceeds quantity limit of ${rule.maxQuantity}`
            );
        }
    }

    async checkValidDeckExpansion(deck) {
        let ret;
        try {
            ret = await db.query('SELECT 1 FROM "Expansions" WHERE "ExpansionId" = $1', [
                deck.expansion
            ]);
        } catch (err) {
            logger.error('Failed to check expansion', err, deck.expansion, deck.uuid);

            return false;
        }

        return ret && ret.length > 0;
    }

    /**
     * ARCHON: one connection, held for the whole transaction.
     *
     * `db.query` is `pool.query` and takes a fresh connection per statement, so
     * this function's `BEGIN` opened a transaction on a connection nobody kept
     * and then returned it to the pool still open, while the inserts it was
     * meant to protect auto-committed one at a time somewhere else. The open
     * transaction then travelled with that connection into whatever borrowed it
     * next, which is how one failed import could start breaking queries that
     * had nothing to do with decks.
     *
     * The connection is taken and given back here, so no exit from the import
     * itself - including one nobody wrote a handler for - can leak it.
     */
    async insertDeck(deck, user) {
        const client = await db.startTransaction();

        try {
            return await this.insertDeckInTransaction(client, deck, user);
        } finally {
            releaseClient(client);
        }
    }

    async insertDeckInTransaction(client, deck, user) {
        let ret;

        try {
            if (user) {
                ret = await db.queryTran(
                    client,
                    'INSERT INTO "Decks" ("UserId", "Uuid", "Identity", "Name", "IncludeInSealed", "LastUpdated", "Verified", "ExpansionId", "Flagged", "Banned", "IsAlliance", "AlliancePods") ' +
                        'VALUES ($1, $2, $3, $4, $5, $6, false, (SELECT "Id" FROM "Expansions" WHERE "ExpansionId" = $7), false, false, $8, $9) RETURNING "Id"',
                    [
                        user.id,
                        deck.uuid,
                        deck.identity,
                        deck.name,
                        !deck.isAlliance,
                        deck.lastUpdated,
                        deck.expansion,
                        deck.isAlliance,
                        deck.alliancePods ? JSON.stringify(deck.alliancePods) : null
                    ]
                );
            } else {
                ret = await db.queryTran(
                    client,
                    'INSERT INTO "StandaloneDecks" ("Identity", "Name", "LastUpdated", "ExpansionId") ' +
                        'VALUES ($1, $2, $3, (SELECT "Id" FROM "Expansions" WHERE "ExpansionId" = $4)) RETURNING "Id"',
                    [deck.identity, deck.name, deck.lastUpdated || new Date(), deck.expansion]
                );
            }
        } catch (err) {
            logger.error('Failed to add deck', err);

            await db.queryTran(client, 'ROLLBACK').catch(() => {});

            throw new Error('Failed to import deck');
        }

        deck.id = ret[0].Id;

        let params = [];
        for (let card of deck.cards) {
            params.push(card.id);
            params.push(card.count);
            params.push(card.maverick);
            params.push(card.anomaly);
            if (user) {
                params.push(card.image);
                params.push(await this.getHouseIdFromName(card.house));
                params.push(card.enhancements ? JSON.stringify(card.enhancements) : undefined);
                params.push(card.isNonDeck);
                params.push(card.prophecyId); // Add prophecy ID
            }

            params.push(deck.id);
            if (!user) {
                params.push(card.enhancements);
            }
        }

        try {
            if (user) {
                await db.queryTran(
                    client,
                    `INSERT INTO "DeckCards" ("CardId", "Count", "Maverick", "Anomaly", "ImageUrl", "HouseId", "Enhancements", "IsNonDeck", "ProphecyId", "DeckId") VALUES ${expand(
                        deck.cards.length,
                        10
                    )}`,
                    params
                );
            } else {
                await db.queryTran(
                    client,
                    `INSERT INTO "StandaloneDeckCards" ("CardId", "Count", "Maverick", "Anomaly", "DeckId", "Enhancements") VALUES ${expand(
                        deck.cards.length,
                        6
                    )}`,
                    params
                );
            }
        } catch (err) {
            logger.error('Failed to add deck', err);

            await db.queryTran(client, 'ROLLBACK').catch(() => {});

            throw new Error('Failed to import deck');
        }

        let deckHouseTable = user ? '"DeckHouses"' : '"StandaloneDeckHouses"';
        try {
            await db.queryTran(
                client,
                `INSERT INTO ${deckHouseTable} ("DeckId", "HouseId") VALUES ($1, (SELECT "Id" FROM "Houses" WHERE "Code" = $2)), ` +
                    '($1, (SELECT "Id" FROM "Houses" WHERE "Code" = $3)), ($1, (SELECT "Id" FROM "Houses" WHERE "Code" = $4))',
                flatten([deck.id, deck.houses])
            );

            if (user && deck.accolades && deck.accolades.length > 0) {
                let accoladeParams = [];
                for (let i = 0; i < deck.accolades.length; i++) {
                    const accolade = deck.accolades[i];
                    const shown = i < 3;
                    accoladeParams.push(deck.id, accolade.id, accolade.name, accolade.image, shown);
                }
                await db.queryTran(
                    client,
                    `INSERT INTO "DeckAccolades" ("DeckId", "AccoladeId", "Name", "ImageUrl", "Shown") VALUES ${expand(
                        deck.accolades.length,
                        5
                    )}`,
                    accoladeParams
                );
            }

            // ARCHON: a deck you delete and import again is the same deck, and
            // its games should say so.
            //
            // "GamePlayers"."DeckId" is ON DELETE SET NULL, so deleting a deck
            // does not archive its record - it cuts every game loose, and the
            // wins and losses disappear from the deck page, the matchup tables
            // and Archon Intelligence alike. Re-importing did not undo that,
            // because the import writes a NEW row with a new id and the games
            // still pointed at nothing.
            //
            // The uuid recorded on the game (migration 71) says which deck was
            // actually played, so the games can be pointed back at the row that
            // now represents it. Scoped to this user's own orphans: another
            // owner's games belong to their copy, and a row that still has a
            // "DeckId" is not orphaned and must not be moved.
            if (user && deck.uuid) {
                await db.queryTran(
                    client,
                    'UPDATE "GamePlayers" SET "DeckId" = $1 ' +
                        'WHERE "PlayerId" = $2 AND "DeckId" IS NULL AND "DeckUuid" = $3',
                    [deck.id, user.id, deck.uuid]
                );
            }

            await db.queryTran(client, 'COMMIT');
        } catch (err) {
            logger.error('Failed to add deck', err);

            await db.queryTran(client, 'ROLLBACK').catch(() => {});

            throw new Error('Failed to import deck');
        }

        return deck;
    }

    async update(deck) {
        if (deck.verified) {
            try {
                await db.query(
                    'UPDATE "Decks" SET "Verified" = true, "LastUpdated" = $2 WHERE "Id" = $1',
                    [deck.id, new Date()]
                );
            } catch (err) {
                logger.error('Failed to update deck', err);

                throw new Error('Failed to update deck');
            }
        }

        for (let card of deck.cards) {
            if (card.enhancements) {
                try {
                    await db.query('UPDATE "DeckCards" SET "Enhancements" = $2 WHERE "Id" = $1', [
                        card.dbId,
                        card.enhancements
                    ]);
                } catch (err) {
                    logger.error('Failed to update deck enhancements', err);

                    throw new Error('Failed to update deck');
                }
            }
        }
    }

    async delete(id) {
        try {
            await db.query('DELETE FROM "Decks" WHERE "Id" = $1', [id]);
        } catch (err) {
            logger.error('Failed to delete deck', err);

            throw new Error('Failed to delete deck');
        }
    }

    async deleteMany(ids) {
        if (!ids || ids.length === 0) {
            return;
        }

        try {
            await db.query(`DELETE FROM "Decks" WHERE "Id" IN ${expand(1, ids.length)}`, ids);
        } catch (err) {
            logger.error('Failed to delete decks', err);

            throw new Error('Failed to delete decks');
        }
    }

    async checkDeckOwnershipForUser(userId, ids) {
        if (!ids || ids.length === 0) {
            return { allExist: false, allOwned: false };
        }

        try {
            const result = await db.query(
                `SELECT COUNT(*) AS "TotalCount",
                        COUNT(*) FILTER (WHERE "UserId" = $1) AS "OwnedCount"
                 FROM "Decks"
                 WHERE "Id" = ANY($2)`,
                [userId, ids]
            );
            const totalCount = parseInt(result[0].TotalCount, 10);
            const ownedCount = parseInt(result[0].OwnedCount, 10);

            return {
                allExist: totalCount === ids.length,
                allOwned: ownedCount === ids.length
            };
        } catch (err) {
            logger.error('Failed to verify deck ownership', err);

            throw new Error('Failed to verify deck ownership');
        }
    }

    /**
     * ARCHON: the Used / Popular / Notorious level for a deck, in one place.
     *
     * It was inlined in the lobby and again in GET /api/decks, which is how the
     * two could disagree, and neither honoured a policy switch because there
     * was none. Sharing a deck is allowed here unless an operator says
     * otherwise, so this returns 0 - "nothing to say about who owns it" -
     * unless lobby.flagSharedDecks is on.
     */
    usageLevelFor(deck) {
        if (!this.configService.getValueForSection('lobby', 'flagSharedDecks')) {
            return 0;
        }

        const owners = deck && deck.usageCount;
        let level = 0;

        if (owners > this.configService.getValueForSection('lobby', 'lowerDeckThreshold')) {
            level = 1;
        }

        if (owners > this.configService.getValueForSection('lobby', 'middleDeckThreshold')) {
            level = 2;
        }

        if (owners > this.configService.getValueForSection('lobby', 'upperDeckThreshold')) {
            level = 3;
        }

        return level;
    }

    async getFlaggedUnverifiedDecksForUser(user) {
        let retDecks = [];
        let decks;

        // Nothing is flagged when sharing is allowed, and asking the database
        // for rows we would then have to ignore is just a slower way to
        // return nothing.
        if (!this.configService.getValueForSection('lobby', 'flagSharedDecks')) {
            return retDecks;
        }

        try {
            decks = await db.query(
                `SELECT d.*, u."Username", e."ExpansionId" as "Expansion", ${OWNER_COUNT_SQL} AS "DeckCount", ` +
                    '(SELECT COUNT(*) FROM "Games" g JOIN "GamePlayers" gp ON gp."GameId" = g."Id" WHERE g."BotGame" IS NOT TRUE AND g."WinnerId" = $1 AND gp."DeckId" = d."Id") AS "WinCount", ' +
                    '(SELECT COUNT(*) FROM "Games" g JOIN "GamePlayers" gp ON gp."GameId" = g."Id" WHERE g."BotGame" IS NOT TRUE AND g."WinnerId" != $1 AND g."WinnerId" IS NOT NULL AND gp."PlayerId" = $1 AND gp."DeckId" = d."Id") AS "LoseCount" ' +
                    'FROM "Decks" d ' +
                    'JOIN "Users" u ON u."Id" = "UserId" ' +
                    'JOIN "Expansions" e on e."Id" = d."ExpansionId" ' +
                    `WHERE u."Id" = $1 AND d."Verified" = False AND ${OWNER_COUNT_SQL} > $2`,
                [user.id, this.configService.getValueForSection('lobby', 'lowerDeckThreshold')]
            );
        } catch (err) {
            logger.error(`Failed to retrieve unverified decks: ${user.id}`, err);

            throw new Error(`Unable to fetch unverified decks: ${user.id}`);
        }

        for (let deck of decks) {
            let retDeck = this.mapDeck(deck);

            await this.getDeckCardsAndHouses(deck);

            retDecks.push(retDeck);
        }

        return retDecks;
    }

    async verifyDecksForUser(user) {
        try {
            await db.query(
                'UPDATE "Decks" SET "Verified" = True WHERE "UserId" = $1 AND "Verified" = False',
                [user.id]
            );
        } catch (err) {
            logger.error(`Failed to verify decks: ${user.id}`, err);

            throw new Error(`Unable to unverify decks: ${user.id}`);
        }
    }

    async parseDeckResponse(username, deckResponse) {
        const allCards = await this.cardService.getAllCards();

        let specialCards = {
            479: { 'dark-æmber-vault': true, 'it-s-coming': true },
            855: {
                'armageddon-cloak': true,
                'avenging-aura': true,
                'book-of-malefaction': true,
                'eye-of-judgment': true,
                'hymn-to-duma': true,
                'johnny-longfingers': true,
                'lord-golgotha': true,
                'mantle-of-the-zealot': true,
                'martyr-s-end': true,
                'master-of-the-grey': true,
                'mighty-lance': true,
                'one-stood-against-many': true,
                'rogue-ogre': true,
                'the-promised-blade': true,
                'champion-tabris': true,
                'dark-centurion': true,
                'first-or-last': true,
                francus: true,
                'glorious-few': true,
                'gorm-of-omm': true,
                'grey-abbess': true,
                'professor-terato': true,
                'scrivener-favian': true,
                'bordan-the-redeemed': true,
                'bull-wark': true,
                'burning-glare': true,
                'citizen-shrix': true,
                retribution: true,
                'shifting-battlefield': true,
                snarette: true,
                'subtle-otto': true,
                'even-ivan': true,
                'odd-clawde': true,
                'sacro-alien': true,
                'sacro-beast': true,
                'sacro-bot': true,
                'sacro-fiend': true,
                'sacro-saurus': true,
                'sacro-thief': true
            },
            874: {
                'dark-æmber-vault': true,
                'build-your-champion': true,
                'digging-up-the-monster': true,
                'tomes-gigantica': true
            },
            886: {
                'avenging-aura': true,
                corrode: true,
                'lord-golgotha': true,
                'one-stood-against-many': true,
                'purifier-of-souls': true,
                stampede: true,
                'dark-centurion': true,
                'follow-the-leader': true,
                picaroon: true,
                'research-smoko': true,
                'vault-s-blessing': true,
                'citizen-shrix': true,
                'even-ivan': true,
                'odd-clawde': true
            }
        };

        let anomalies = {
            cosmicrux: { anomalySets: [453, 918, 939], house: 'ouboros' },
            'ecto-charge': { anomalySets: [600], house: 'geistoid' },
            ignitus: { anomalySets: [453, 918, 939], house: 'ouboros' },
            'lateral-shift': { anomalySets: [452, 453, 600, 886], house: 'unfathomable' },
            'near-future-lens': { anomalySets: [600], house: 'staralliance' },
            'nizak-the-forgotten': {
                anomalySets: [452, 453, 600, 886, 918, 939],
                house: 'ouboros'
            },
            'orb-of-wonder': { anomalySets: [453], house: 'sanctum' },
            'the-grim-reaper': { anomalySets: [453], house: 'geistoid' },
            'the-red-baron': { anomalySets: [453], house: 'skyborn' },
            'thermal-depletion': { anomalySets: [453, 918, 939], house: 'ouboros' },
            timequake: { anomalySets: [452, 453, 600, 886, 918, 939], house: 'ouboros' },
            'treok-the-wise': { anomalySets: [453, 939], house: 'ouboros' },
            valoocanth: { anomalySets: [453], house: 'unfathomable' }
        };

        let deckCards = deckResponse._linked.cards;

        let enhancementsByCardId = {};

        if (deckResponse.data.bonus_icons) {
            for (let icon of deckResponse.data.bonus_icons) {
                if (!enhancementsByCardId[icon.card_id]) {
                    enhancementsByCardId[icon.card_id] = [];
                }

                enhancementsByCardId[icon.card_id].push(icon.bonus_icons);
            }
        }

        let cards = deckCards.map((card) => {
            let id = card.card_title
                .toLowerCase()
                .replace(/[,?.!"„""“”]/gi, '')
                .replace(/[ ''’]/gi, '-');

            if (card.rarity === 'Evil Twin') {
                id += '-evil-twin';
            }

            let retCard;
            let count = deckResponse.data._links.cards.filter((uuid) => uuid === card.id).length;
            if (card.is_maverick) {
                retCard = {
                    id: id,
                    count: count,
                    maverick: card.house.replace(' ', '').toLowerCase()
                };
            } else if (card.is_anomaly) {
                retCard = {
                    id: id,
                    count: count,
                    anomaly: card.house.replace(' ', '').toLowerCase()
                };
            } else {
                retCard = {
                    id: id,
                    count: count
                };
            }

            // Store sort_override for prophecy cards
            if (card.sort_override !== undefined && card.sort_override !== null) {
                retCard.sortOverride = card.sort_override;
            }

            if (card.is_enhanced) {
                retCard.enhancements = [];
                retCard.uuid = card.id;
            }

            if (
                card.card_type === 'Creature2' ||
                (card.card_text === '' &&
                    card.power === null &&
                    card.card_type === 'Creature' &&
                    card.rarity === 'Rare') ||
                card.card_type === 'Gigantic Creature Art'
            ) {
                retCard.id += '2';
            }

            const normalizedHouse = card.house.toLowerCase().replace(' ', '');
            const cardData = allCards[retCard.id];

            if (!cardData) {
                logger.error(
                    'Deck import failed: missing card metadata for id %s (title %s) in deck %s',
                    retCard.id,
                    card.card_title,
                    deckResponse.data.id
                );
                throw new Error('There was a problem importing your deck, please try again later.');
            }

            // Revenants can be in any house, their real house is set on the deck itself.
            if (normalizedHouse !== cardData.house) {
                retCard.house = normalizedHouse;
            }

            // If this is one of the cards that has an entry for every house, get the correct house image
            if (specialCards[card.expansion] && specialCards[card.expansion][id]) {
                retCard.house = normalizedHouse;
                retCard.image = `${retCard.id}-${retCard.house}`;
            }

            if (anomalies[id] && !anomalies[id].anomalySets.includes(card.expansion)) {
                // Former anomaly cards use their printed house in regular sets.
                delete retCard.anomaly;
                retCard.house = anomalies[id].house;
                retCard.image = `${retCard.id}-${retCard.house}`;
            }

            retCard.isNonDeck = card.is_non_deck;

            return retCard;
        });

        let toAdd = [];
        for (let card of cards) {
            if (card.enhancements) {
                for (let i = 0; i < card.count - 1; i++) {
                    let cardToAdd = Object.assign({}, card);

                    cardToAdd.enhancements = enhancementsByCardId[card.uuid][i + 1];
                    // Preserve sortOverride for enhanced cards
                    if (card.sortOverride !== undefined) {
                        cardToAdd.sortOverride = card.sortOverride;
                    }

                    cardToAdd.count = 1;
                    toAdd.push(cardToAdd);
                }

                card.enhancements = enhancementsByCardId[card.uuid][0];
                card.count = 1;
            }
        }

        cards = cards.concat(toAdd);

        // Auto-assign prophecy IDs based on sort_override order (first two = 1, second two = 2)
        const prophecyCards = cards.filter(
            (card) => allCards[card.id] && allCards[card.id].type === 'prophecy'
        );
        if (prophecyCards.length === 4) {
            // Sort prophecy cards by sort_override field from API
            prophecyCards.sort((a, b) => {
                const aSort =
                    a.sortOverride !== undefined && a.sortOverride !== null
                        ? a.sortOverride
                        : Infinity;
                const bSort =
                    b.sortOverride !== undefined && b.sortOverride !== null
                        ? b.sortOverride
                        : Infinity;
                return aSort - bSort;
            });
            // First two prophecies get prophecyId 1, second two get prophecyId 2
            prophecyCards[0].prophecyId = 1;
            prophecyCards[1].prophecyId = 1;
            prophecyCards[2].prophecyId = 2;
            prophecyCards[3].prophecyId = 2;
        }

        let uuid = deckResponse.data.id;
        let anyIllegalCards = cards.find(
            (card) =>
                !card.id
                    .split('')
                    .every((char) =>
                        'æaăàáãǎâbcdeĕèéěfghĭìíǐijklmnoöǑŏòóõǒpqrstuŭùúǔüvwxyz0123456789-[]*…'.includes(
                            char
                        )
                    )
        );
        if (anyIllegalCards) {
            logger.error(`DECK IMPORT ERROR: ${anyIllegalCards.id}`);

            return undefined;
        }

        const accolades = (deckResponse._linked.accolades || [])
            .filter((a) => a.visible)
            .map((a) => ({ id: a.id, name: a.name, image: a.image }));

        return {
            expansion: deckResponse.data.expansion,
            username: username,
            uuid: uuid,
            identity: deckResponse.data.name
                .toLowerCase()
                .replace(/[,?.!"„""]/gi, '')
                .replace(/[ '']/gi, '-'),
            cardback: '',
            name: deckResponse.data.name,
            houses: deckResponse.data._links.houses.map((house) =>
                house.replace(' ', '').toLowerCase()
            ),
            cards: cards,
            accolades: accolades,
            lastUpdated: new Date()
        };
    }

    async refreshAccolades(deckId, user) {
        const deck = await this.getById(deckId);
        if (!deck) {
            throw new Error('Deck not found');
        }

        if (deck.username !== user.username) {
            throw new Error('Unauthorized');
        }

        let deckResponse;
        try {
            let response = await util.httpRequest(
                `https://www.keyforgegame.com/api/decks/${deck.uuid}/?links=cards`,
                { allowedHosts: ['www.keyforgegame.com'] }
            );

            if (response[0] === '<') {
                logger.error('Failed to refresh accolades: %s %s', deck.uuid, response);
                throw new Error('Invalid response from API. Please try again later.');
            }

            deckResponse = JSON.parse(response);
        } catch (error) {
            logger.error(`Unable to refresh accolades for deck ${deck.uuid}`, error);
            throw new Error('Invalid response from API. Please try again later.');
        }

        if (!deckResponse || !deckResponse._linked || !deckResponse.data) {
            throw new Error('Invalid response from API. Please try again later.');
        }

        const accolades = (deckResponse._linked.accolades || [])
            .filter((a) => a.visible)
            .map((a) => ({ id: a.id, name: a.name, image: a.image }));

        const existingAccolades = await db.query(
            'SELECT "AccoladeId", "Shown" FROM "DeckAccolades" WHERE "DeckId" = $1',
            [deckId]
        );
        const shownMap = {};
        for (const existing of existingAccolades) {
            shownMap[existing.AccoladeId] = existing.Shown;
        }

        const resultShownMap = {};
        // ARCHON: one connection, held for the whole transaction. `db.query` is
        // `pool.query` and takes a fresh connection per statement, so a `BEGIN`
        // sent that way opened a transaction on a connection nobody kept and
        // handed it back to the pool still open - and the next unrelated query
        // to borrow that connection ran inside it.
        const client = await db.startTransaction();
        try {
            await db.queryTran(client, 'DELETE FROM "DeckAccolades" WHERE "DeckId" = $1', [deckId]);

            if (accolades.length > 0) {
                let shownCount = 0;
                let accoladeParams = [];
                for (const accolade of accolades) {
                    let shown = shownMap[accolade.id];
                    if (shown === undefined) {
                        shown = shownCount < 3;
                        if (shown) {
                            shownCount++;
                        }
                    }
                    resultShownMap[accolade.id] = shown;
                    accoladeParams.push(deckId, accolade.id, accolade.name, accolade.image, shown);
                }
                await db.queryTran(
                    client,
                    `INSERT INTO "DeckAccolades" ("DeckId", "AccoladeId", "Name", "ImageUrl", "Shown") VALUES ${expand(
                        accolades.length,
                        5
                    )}`,
                    accoladeParams
                );
            }

            await db.queryTran(client, 'COMMIT');
        } catch (err) {
            await db.queryTran(client, 'ROLLBACK').catch(() => {});
            logger.error('Failed to refresh accolades', err);
            throw new Error('Failed to update accolades in database');
        } finally {
            releaseClient(client);
        }

        return accolades.map((a) => ({
            ...a,
            shown: resultShownMap[a.id] || false
        }));
    }

    async updateAccoladeShown(deckId, accoladeId, shown, user) {
        const deck = await this.getById(deckId);
        if (!deck) {
            throw new Error('Deck not found');
        }

        if (deck.username !== user.username) {
            throw new Error('Unauthorized');
        }

        if (shown) {
            const shownCount = await db.query(
                'SELECT COUNT(*) as count FROM "DeckAccolades" WHERE "DeckId" = $1 AND "Shown" = true',
                [deckId]
            );
            if (shownCount[0].count >= 3) {
                throw new Error('Maximum of 3 accolades can be shown');
            }
        }

        await db.query(
            'UPDATE "DeckAccolades" SET "Shown" = $1 WHERE "DeckId" = $2 AND "AccoladeId" = $3',
            [shown, deckId, accoladeId]
        );
    }

    mapDeck(deck) {
        return {
            expansion: deck.Expansion,
            id: deck.Id,
            identity: deck.Identity,
            isAlliance: !!deck.IsAlliance,
            name: deck.Name,
            lastUpdated: deck.LastUpdated,
            losses: deck.LoseCount,
            usageCount: deck.DeckCount,
            username: deck.Username,
            uuid: deck.Uuid,
            verified: deck.Verified,
            wins: deck.WinCount,
            winRate: deck.WinRate,
            // ARCHON: the same deck in everyone's hands. Only getById selects
            // these, so they are undefined - not zero - on every other path,
            // and the UI can tell "nobody has played it" from "not asked for".
            globalWins: deck.GlobalWinCount,
            globalLosses: deck.GlobalLoseCount,
            globalWinRate: deck.GlobalWinRate,
            // Present when the row came from a query that joins DeckSas.
            // attachStats fills this in for the paths that do not.
            sasRating: deck.SasRating != null ? deck.SasRating : undefined,
            // ARCHON (N19): the Archon Rating Index - stored when any game
            // has moved it, the SAS/AERC seed otherwise, undefined on paths
            // that did not join (attachStats decorates those).
            ari: effectiveAri(deck) ?? undefined
        };
    }
}

module.exports = DeckService;
module.exports.UNCHAINED_EXPANSION_ID = UNCHAINED_EXPANSION_ID;
