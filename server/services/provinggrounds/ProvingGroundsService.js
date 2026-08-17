const logger = require('../../log');
const { normalizeConfig } = require('../rating/EloCalculator');
const RatingService = require('../rating/RatingService');
const MembershipService = require('../membership/MembershipService');
const { resolveEntitlements } = require('../membership/entitlements');
const { CAPABILITIES } = require('../membership/capabilities');
const { cloneCard } = require('./packCards');
const { runSimulatedGame } = require('./SimulatedGame');
const {
    MIN_CONFIDENT_GAMES,
    MIN_OPENING_GAMES,
    sasExpectedScore,
    performanceSas,
    isHiddenGem,
    buildFindings
} = require('./labMath');

/** Most candidate decks offered for enrollment at once. */
const MAX_CANDIDATES = 60;

/** Hard ceiling on the games one report will aggregate. */
const MAX_GAMES_READ = 20000;

/**
 * ARCHON (N18): the Proving Grounds - Vault Master's background deck testing.
 *
 * A member enrolls decks onto a roster; the lobby's sweep quietly plays them
 * against each other with the simulated player (SimulatedGame.js); and the
 * report turns those games into the things a player actually wants to know:
 * how each deck really performs, what SAS said it should do, which decks are
 * hidden gems, and how each one wins.
 *
 * Three properties are load-bearing:
 *
 *  - **Simulated games are invisible to the rest of the platform.** They
 *    live in their own tables, this service never writes `Games` or
 *    `GamePlayers`, and nothing here calls the rating engine. Every official
 *    statistic filters only on FinishedAt/WinnerId, so writing there would
 *    have leaked sparring results into thirty queries at once.
 *  - **Entitlement is checked where the money is.** The API gates enrollment
 *    and reading on the capability; the sweep re-checks each roster's owner
 *    before spending CPU on them, so a lapsed pledge stops the games the day
 *    it lapses - results are kept, and play resumes with the membership.
 *    (The cosmetics rule, applied to compute.)
 *  - **The claims are conservative.** Expected win rates come from the
 *    site's own Elo model's SAS term, "hidden gem" requires the whole
 *    Wilson interval clear of expectation, and nothing is concluded before
 *    MIN_CONFIDENT_GAMES. The lab must be the most honest analyst on the
 *    site, because nobody can argue with a computer that plays in private.
 */
class ProvingGroundsService {
    constructor(configService, db = require('../../db'), settingsService = require('../settings')) {
        this.configService = configService;
        this.db = db;
        this.settingsService = settingsService;
        this.membershipService = new MembershipService(db);
        // For the SAS exchange rate only, so lab expectations track the same
        // admin-tunable model that rates real games.
        this.ratingService = new RatingService(configService, db, settingsService);
        // Injectable for tests: specs replace this with a stub rather than
        // playing half a second of real game per assertion.
        this.runMatch = runSimulatedGame;
    }

    /** Admin-configurable knobs, defaults from the settings registry. */
    getConfig() {
        return this.settingsService.getSectionWithDefaults('provingGrounds');
    }

    /** The elo config whose sasWeight the lab's expectations use. */
    eloConfig() {
        return normalizeConfig((this.ratingService.getConfig() || {}).elo || {});
    }

    /**
     * May this account use the lab at all?
     *
     * Resolved through the one entitlement authority, with the admin role
     * read from UserRoles so the override applies to sweeps the same way it
     * applies to requests.
     *
     * @param {number} userId
     * @returns {Promise<boolean>}
     */
    async userMayUseLab(userId) {
        let isAdmin = false;

        try {
            const rows = await this.db.query(
                'SELECT EXISTS (SELECT 1 FROM "UserRoles" ur JOIN "Roles" r ON r."Id" = ur."RoleId" ' +
                    'WHERE ur."UserId" = $1 AND r."Name" = \'Admin\') AS "IsAdmin"',
                [userId]
            );

            isAdmin = !!(rows && rows[0] && rows[0].IsAdmin);
        } catch (err) {
            logger.error(
                'Proving Grounds admin lookup failed for user %s: %s',
                userId,
                err.message
            );
        }

        const membership = await this.membershipService.getMembership(userId);
        const entitlements = resolveEntitlements({
            user: { id: userId, permissions: { isAdmin } },
            membership
        });

        return entitlements.capabilities.includes(CAPABILITIES.PROVING_GROUNDS);
    }

    /**
     * Put a deck on the member's roster.
     *
     * Refuses rather than quietly accepting anything the sweep could not
     * actually play: the deck must be the caller's, must carry a SAS rating
     * (expectations are meaningless without one), and every card must exist
     * in the local pack data. Failures are thrown with player-readable
     * messages; the API forwards them as 400s.
     *
     * @param {number} userId
     * @param {number} deckId
     */
    async enrollDeck(userId, deckId) {
        const config = this.getConfig();
        const enrolled = await this.db.query(
            'SELECT COUNT(*)::int AS "Count" FROM "ProvingGroundsDecks" WHERE "UserId" = $1',
            [userId]
        );

        if (enrolled[0] && enrolled[0].Count >= config.maxEnrolledPerUser) {
            throw new Error(
                `All ${config.maxEnrolledPerUser} Proving Grounds slots are in use. ` +
                    'Withdraw a deck to enroll another.'
            );
        }

        const decks = await this.db.query(
            'SELECT d."Id", d."UserId", d."Name", COALESCE(d."Banned", false) AS "Banned", ' +
                'ds."SasRating" ' +
                'FROM "Decks" d LEFT JOIN "DeckSas" ds ON ds."Uuid" = d."Uuid" ' +
                'WHERE d."Id" = $1',
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

        if (deck.SasRating == null) {
            throw new Error(
                'That deck has no SAS rating yet. The lab measures decks against what ' +
                    'their SAS predicts, so it needs one - open the deck to fetch its score, ' +
                    'then try again.'
            );
        }

        const { missing, deck: engineDeck } = await this.loadEngineDeck(deckId);

        if (missing.length || engineDeck.houses.length !== 3) {
            throw new Error(
                "The Proving Grounds cannot play that deck yet - it uses cards this server's " +
                    'simulation data does not cover.'
            );
        }

        await this.db.query(
            'INSERT INTO "ProvingGroundsDecks" ("UserId", "DeckId", "EnrolledAt") ' +
                "VALUES ($1, $2, now() AT TIME ZONE 'utc') " +
                'ON CONFLICT ("UserId", "DeckId") DO NOTHING',
            [userId, deckId]
        );
    }

    /**
     * Take a deck off the roster. Its recorded games are deliberately kept -
     * results are the product, and re-enrolling picks up where it left off.
     *
     * @param {number} userId
     * @param {number} deckId
     */
    async withdrawDeck(userId, deckId) {
        await this.db.query(
            'DELETE FROM "ProvingGroundsDecks" WHERE "UserId" = $1 AND "DeckId" = $2',
            [userId, deckId]
        );
    }

    /**
     * A deck row turned into what the engine's `selectDeck` wants: houses as
     * codes, and every card entry carrying its full (cloned) JSON.
     *
     * @param {number} deckId
     * @returns {Promise<{deck: object, missing: string[]}>}
     */
    async loadEngineDeck(deckId) {
        const [deckRows, cardRows, houseRows] = await Promise.all([
            this.db.query(
                'SELECT d."Id", d."Name", d."Uuid", d."ExpansionId" FROM "Decks" d WHERE d."Id" = $1',
                [deckId]
            ),
            this.db.query(
                'SELECT dc."CardId", dc."Count", dc."Maverick", dc."Anomaly", dc."Enhancements", ' +
                    'dc."IsNonDeck", h."Code" AS "House" ' +
                    'FROM "DeckCards" dc LEFT JOIN "Houses" h ON h."Id" = dc."HouseId" ' +
                    'WHERE dc."DeckId" = $1',
                [deckId]
            ),
            this.db.query(
                'SELECT h."Code" FROM "DeckHouses" dh JOIN "Houses" h ON h."Id" = dh."HouseId" ' +
                    'WHERE dh."DeckId" = $1',
                [deckId]
            )
        ]);

        const row = deckRows && deckRows[0];
        const missing = [];
        const cards = [];

        for (const cardRow of cardRows || []) {
            const card = cloneCard(cardRow.CardId);

            if (!card) {
                missing.push(cardRow.CardId);
                continue;
            }

            cards.push({
                id: cardRow.CardId,
                count: cardRow.Count,
                card,
                maverick: cardRow.Maverick || undefined,
                anomaly: cardRow.Anomaly || undefined,
                house: cardRow.House || undefined,
                isNonDeck: !!cardRow.IsNonDeck,
                enhancements: parseEnhancements(cardRow.Enhancements)
            });
        }

        return {
            missing,
            deck: {
                dbId: deckId,
                name: (row && row.Name) || `Deck ${deckId}`,
                uuid: (row && row.Uuid) || `proving-${deckId}`,
                expansion: (row && row.ExpansionId) || 341,
                houses: (houseRows || []).map((house) => house.Code).filter(Boolean),
                cards
            }
        };
    }

    /**
     * One tick of background play: pick the roster most in need of games,
     * play a few matches, record them. Called by the lobby's sweep; safe to
     * call again immediately (per-day budgets are read from the table, so a
     * doubled tick just brings the day's quota forward).
     *
     * @returns {Promise<{played: number, abandoned: number}>}
     */
    async runSweep() {
        const config = this.getConfig();

        if (!config.enabled) {
            return { played: 0, abandoned: 0 };
        }

        const enrollments = await this.db.query(
            'SELECT "UserId", "DeckId" FROM "ProvingGroundsDecks"'
        );

        if (!enrollments || !enrollments.length) {
            return { played: 0, abandoned: 0 };
        }

        // Aliased "GamesToday" rather than "Games" so the spec that forbids
        // the official tables' names anywhere in lab SQL can stay strict.
        const todayCounts = await this.db.query(
            'SELECT x."DeckId", COUNT(*)::int AS "GamesToday" FROM (' +
                'SELECT "WinnerDeckId" AS "DeckId" FROM "ProvingGroundsGames" ' +
                "WHERE \"FinishedAt\" >= date_trunc('day', now() AT TIME ZONE 'utc') " +
                'UNION ALL ' +
                'SELECT "LoserDeckId" FROM "ProvingGroundsGames" ' +
                "WHERE \"FinishedAt\" >= date_trunc('day', now() AT TIME ZONE 'utc')" +
                ') x GROUP BY x."DeckId"',
            []
        );
        const gamesToday = new Map(
            (todayCounts || []).map((count) => [count.DeckId, count.GamesToday])
        );

        const rosters = new Map();

        for (const enrollment of enrollments) {
            if (!rosters.has(enrollment.UserId)) {
                rosters.set(enrollment.UserId, []);
            }

            rosters.get(enrollment.UserId).push(enrollment.DeckId);
        }

        // Rosters are visited round-robin in a shuffled order - one game per
        // member per pass - so one member's full queue cannot starve
        // another's, while a quiet site still gets its full batch from the
        // one roster that wants games. Entitlement verdicts are cached per
        // sweep; budgets are re-read from `gamesToday` as it fills.
        const users = shuffle([...rosters.keys()]);
        const mayUse = new Map();
        let played = 0;
        let abandoned = 0;
        let progress = true;

        while (played < config.gamesPerSweep && progress) {
            progress = false;

            for (const userId of users) {
                if (played >= config.gamesPerSweep) {
                    break;
                }

                const eligible = rosters
                    .get(userId)
                    .filter((deckId) => (gamesToday.get(deckId) || 0) < config.gamesPerDeckPerDay);

                if (eligible.length < 2) {
                    continue;
                }

                if (!mayUse.has(userId)) {
                    mayUse.set(userId, await this.userMayUseLab(userId));
                }

                if (!mayUse.get(userId)) {
                    continue;
                }

                // The two decks most behind on today's games spar first, with
                // a shuffle underneath so equal counts pair differently each
                // tick.
                const pair = shuffle(eligible)
                    .sort((a, b) => (gamesToday.get(a) || 0) - (gamesToday.get(b) || 0))
                    .slice(0, 2);

                const [alpha, omega] = await Promise.all([
                    this.loadEngineDeck(pair[0]),
                    this.loadEngineDeck(pair[1])
                ]);

                if (
                    alpha.missing.length ||
                    omega.missing.length ||
                    alpha.deck.houses.length !== 3 ||
                    omega.deck.houses.length !== 3
                ) {
                    logger.warn(
                        `Proving Grounds skipped rosters of user ${userId}: deck ` +
                            `${alpha.missing.length ? pair[0] : pair[1]} is not simulatable`
                    );
                    continue;
                }

                let result;

                try {
                    result = await this.runMatch(alpha.deck, omega.deck, {
                        maxTurns: config.maxTurnsPerGame
                    });
                } catch (err) {
                    logger.error(
                        `Proving Grounds game failed for user ${userId} ` +
                            `(decks ${pair[0]} vs ${pair[1]}):`,
                        err
                    );
                    abandoned++;
                    continue;
                }

                if (!result || !result.completed) {
                    logger.warn(
                        `Proving Grounds abandoned a game for user ${userId} ` +
                            `(decks ${pair[0]} vs ${pair[1]}): ${result && result.reason}`
                    );
                    abandoned++;
                    continue;
                }

                await this.recordGame(userId, result);
                gamesToday.set(
                    result.winnerDeck.dbId,
                    (gamesToday.get(result.winnerDeck.dbId) || 0) + 1
                );
                gamesToday.set(
                    result.loserDeck.dbId,
                    (gamesToday.get(result.loserDeck.dbId) || 0) + 1
                );
                played++;
                progress = true;
            }
        }

        return { played, abandoned };
    }

    /** Persist one finished simulated game. */
    async recordGame(userId, result) {
        await this.db.query(
            'INSERT INTO "ProvingGroundsGames" ' +
                '("UserId", "WinnerDeckId", "LoserDeckId", "WinnerKeys", "LoserKeys", "Turns", ' +
                '"WinnerWentFirst", "WinnerFirstHouse", "LoserFirstHouse", "WinnerHouseCalls", ' +
                '"LoserHouseCalls", "DurationMs", "FinishedAt") ' +
                "VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, now() AT TIME ZONE 'utc')",
            [
                userId,
                result.winnerDeck.dbId,
                result.loserDeck.dbId,
                result.winnerKeys,
                result.loserKeys,
                result.turns,
                result.winnerWentFirst,
                result.winnerFirstHouse,
                result.loserFirstHouse,
                JSON.stringify(result.winnerHouseCalls || {}),
                JSON.stringify(result.loserHouseCalls || {}),
                result.durationMs
            ]
        );
    }

    /**
     * Everything the Proving Grounds page shows, in one read.
     *
     * @param {number} userId
     * @returns {Promise<object>}
     */
    async getLabReport(userId) {
        const config = this.getConfig();

        const [enrollmentRows, gameRows, candidateRows] = await Promise.all([
            this.db.query(
                'SELECT e."DeckId", e."EnrolledAt", d."Name", ds."SasRating" ' +
                    'FROM "ProvingGroundsDecks" e ' +
                    'JOIN "Decks" d ON d."Id" = e."DeckId" ' +
                    'LEFT JOIN "DeckSas" ds ON ds."Uuid" = d."Uuid" ' +
                    'WHERE e."UserId" = $1 ORDER BY e."EnrolledAt"',
                [userId]
            ),
            this.db.query(
                'SELECT * FROM "ProvingGroundsGames" WHERE "UserId" = $1 ' +
                    'ORDER BY "FinishedAt" LIMIT $2',
                [userId, MAX_GAMES_READ]
            ),
            this.db.query(
                'SELECT d."Id", d."Name", ds."SasRating" ' +
                    'FROM "Decks" d LEFT JOIN "DeckSas" ds ON ds."Uuid" = d."Uuid" ' +
                    'WHERE d."UserId" = $1 AND NOT COALESCE(d."Banned", false) ' +
                    'AND ds."SasRating" IS NOT NULL ' +
                    'AND NOT EXISTS (SELECT 1 FROM "ProvingGroundsDecks" e ' +
                    'WHERE e."UserId" = $1 AND e."DeckId" = d."Id") ' +
                    'ORDER BY ds."SasRating" DESC LIMIT $2',
                [userId, MAX_CANDIDATES]
            )
        ]);

        const games = gameRows || [];
        const enrollmentList = enrollmentRows || [];

        // SAS for every deck the games mention, including ones since
        // withdrawn from the roster - their games still count as opposition.
        const sasByDeck = new Map(
            enrollmentList.map((enrollment) => [enrollment.DeckId, enrollment.SasRating])
        );
        const unknownDeckIds = [
            ...new Set(
                games
                    .flatMap((game) => [game.WinnerDeckId, game.LoserDeckId])
                    .filter((deckId) => !sasByDeck.has(deckId))
            )
        ];

        if (unknownDeckIds.length) {
            const extraSas = await this.db.query(
                'SELECT d."Id", ds."SasRating" FROM "Decks" d ' +
                    'LEFT JOIN "DeckSas" ds ON ds."Uuid" = d."Uuid" WHERE d."Id" = ANY($1)',
                [unknownDeckIds]
            );

            for (const row of extraSas || []) {
                sasByDeck.set(row.Id, row.SasRating);
            }
        }

        const eloConfig = this.eloConfig();
        const decks = enrollmentList.map((enrollment) =>
            this.aggregateDeck(enrollment, games, sasByDeck, eloConfig)
        );

        // Gems first, then by how far above expectation each deck runs.
        decks.sort(
            (a, b) =>
                (b.hiddenGem ? 1 : 0) - (a.hiddenGem ? 1 : 0) ||
                (b.delta ?? -1) - (a.delta ?? -1) ||
                b.games - a.games
        );

        const utcMidnight = new Date();

        utcMidnight.setUTCHours(0, 0, 0, 0);

        return {
            running: !!config.enabled,
            maxEnrolled: config.maxEnrolledPerUser,
            gamesPerDeckPerDay: config.gamesPerDeckPerDay,
            minConfidentGames: MIN_CONFIDENT_GAMES,
            totals: {
                games: games.length,
                today: games.filter((game) => new Date(game.FinishedAt) >= utcMidnight).length
            },
            candidates: (candidateRows || []).map((candidate) => ({
                deckId: candidate.Id,
                name: candidate.Name,
                sas: candidate.SasRating
            })),
            decks,
            findings: buildFindings(decks)
        };
    }

    /**
     * One enrolled deck's games folded into the row the page renders.
     * Pure given its arguments; the SQL above is the only IO.
     */
    aggregateDeck(enrollment, games, sasByDeck, eloConfig) {
        const deckId = enrollment.DeckId;
        const sas = enrollment.SasRating;

        let wins = 0;
        let losses = 0;
        let turnsTotal = 0;
        let keysFor = 0;
        let keysAgainst = 0;
        let wentFirstGames = 0;
        let wentFirstWins = 0;
        let expectedSum = 0;
        let expectedGames = 0;
        let lastPlayedAt = null;
        const expectationGames = [];
        const openings = new Map();

        for (const game of games) {
            const won = game.WinnerDeckId === deckId;

            if (!won && game.LoserDeckId !== deckId) {
                continue;
            }

            const opponentId = won ? game.LoserDeckId : game.WinnerDeckId;
            const opponentSas = sasByDeck.get(opponentId);
            const wentFirst = won ? game.WinnerWentFirst : !game.WinnerWentFirst;
            const firstHouse = won ? game.WinnerFirstHouse : game.LoserFirstHouse;

            if (won) {
                wins++;
            } else {
                losses++;
            }

            turnsTotal += game.Turns;
            keysFor += won ? game.WinnerKeys : game.LoserKeys;
            keysAgainst += won ? game.LoserKeys : game.WinnerKeys;

            if (wentFirst) {
                wentFirstGames++;

                if (won) {
                    wentFirstWins++;
                }
            }

            if (sas != null && opponentSas != null) {
                expectedSum += sasExpectedScore(sas, opponentSas, eloConfig);
                expectedGames++;
                expectationGames.push({ opponentSas, won });
            }

            if (firstHouse) {
                const opening = openings.get(firstHouse) || { games: 0, wins: 0 };

                opening.games++;
                opening.wins += won ? 1 : 0;
                openings.set(firstHouse, opening);
            }

            if (!lastPlayedAt || game.FinishedAt > lastPlayedAt) {
                lastPlayedAt = game.FinishedAt;
            }
        }

        const total = wins + losses;
        const winRate = total ? wins / total : null;
        const expectedWinRate = expectedGames ? expectedSum / expectedGames : null;
        // A performance rating over a thin sample swings wildly (a 3-0 start
        // reads as +80 SAS), so it is withheld until the deck has a sample
        // that can carry the number.
        const playsLike =
            total >= MIN_CONFIDENT_GAMES ? performanceSas(expectationGames, eloConfig) : null;
        const secondGames = total - wentFirstGames;
        const secondWins = wins - wentFirstWins;

        const openingRows = [...openings.entries()]
            .map(([house, record]) => ({
                house,
                games: record.games,
                winRate: record.wins / record.games
            }))
            .sort((a, b) => b.winRate - a.winRate || b.games - a.games);
        const bestOpening =
            openingRows.find((opening) => opening.games >= MIN_OPENING_GAMES) || null;

        const deck = {
            deckId,
            name: enrollment.Name,
            sas,
            enrolledAt: enrollment.EnrolledAt,
            lastPlayedAt,
            games: total,
            wins,
            losses,
            winRate,
            expectedWinRate,
            delta: winRate != null && expectedWinRate != null ? winRate - expectedWinRate : null,
            playsLikeSas: playsLike != null ? Math.round(playsLike * 10) / 10 : null,
            confident: total >= MIN_CONFIDENT_GAMES,
            avgTurns: total ? Math.round((turnsTotal / total) * 10) / 10 : null,
            avgKeysFor: total ? Math.round((keysFor / total) * 100) / 100 : null,
            avgKeysAgainst: total ? Math.round((keysAgainst / total) * 100) / 100 : null,
            firstPlayerWinRate: wentFirstGames >= 5 ? wentFirstWins / wentFirstGames : null,
            secondPlayerWinRate: secondGames >= 5 ? secondWins / secondGames : null,
            openings: openingRows,
            bestOpening
        };

        deck.hiddenGem = isHiddenGem(deck);

        return deck;
    }
}

function parseEnhancements(value) {
    if (!value) {
        return undefined;
    }

    try {
        return JSON.parse(value);
    } catch {
        return undefined;
    }
}

function shuffle(list) {
    const copy = [...list];

    for (let i = copy.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));

        [copy[i], copy[j]] = [copy[j], copy[i]];
    }

    return copy;
}

module.exports = ProvingGroundsService;
