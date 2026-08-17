const logger = require('../../log');
const { normalizeConfig } = require('../rating/EloCalculator');
const RatingService = require('../rating/RatingService');
const MembershipService = require('../membership/MembershipService');
const { resolveEntitlements } = require('../membership/entitlements');
const { CAPABILITIES } = require('../membership/capabilities');
const crypto = require('node:crypto');

const AriService = require('../rating/AriService');
const BotPolicyService = require('./BotPolicyService');
const GauntletService = require('./GauntletService');
const DeckService = require('../DeckService');
const DokService = require('../dok/DokService');
const { cloneCard, getCardIndex } = require('./packCards');
const { runSimulatedGame, PLAYER_ONE } = require('./SimulatedGame');
const { runDeepGame } = require('./DeepGame');
const {
    MIN_CONFIDENT_GAMES,
    MIN_OPENING_GAMES,
    sasExpectedScore,
    isHiddenGem,
    buildFindings,
    wilsonInterval
} = require('./labMath');
const { shrink, SHRINK_PRIOR } = require('./labPolicy');

/** Most candidate decks offered for enrollment at once. */
const MAX_CANDIDATES = 60;

/** Hard ceiling on the games one report will aggregate. */
const MAX_GAMES_READ = 20000;

/**
 * ARCHON (N18): the Champion’s Challenge - Vault Master's background deck testing.
 *
 * (Shipped as "the Proving Grounds"; renamed before anyone met it. The two
 * tables keep their birth names - ProvingGroundsDecks/ProvingGroundsGames -
 * because renaming an applied migration's tables costs a checksum-guarded
 * migration dance and buys nothing a comment doesn't.)
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
class ChampionsChallengeService {
    constructor(configService, db = require('../../db'), settingsService = require('../settings')) {
        this.configService = configService;
        this.db = db;
        this.settingsService = settingsService;
        this.membershipService = new MembershipService(db);
        // For the SAS exchange rate only, so lab expectations track the same
        // admin-tunable model that rates real games.
        this.ratingService = new RatingService(configService, db, settingsService);
        // ARCHON (N19): sparring games move each deck's ARI - the gentler
        // simGameK, but the same index real games move.
        this.ariService = new AriService(db);
        // ARCHON (N21): the learning loop's diary, candidates and champion.
        this.policyService = new BotPolicyService(configService, db, settingsService);
        // ARCHON (N24): the Gauntlet - foreign decks drawn from the Master
        // Vault catalog. Its hydrator parses Master Vault responses with the
        // member-facing importer's own parser, handed a card index read from
        // the pack files rather than Redis: the lab is the one workload with
        // nobody waiting on it, so it must never compete for a shared cache.
        this.gauntletService = new GauntletService(configService, db, settingsService, {
            deckService: new DeckService(configService, {
                getAllCards: async () => getCardIndex()
            }),
            // SAS and AERC for pool decks, which is what the SAS and strategy
            // filters read. Optional: a server with no DoK key still plays the
            // field, filtered by set and house.
            dokService: new DokService(configService, db, settingsService)
        });
        // Injectable for tests: specs replace these with stubs rather than
        // playing real games per assertion.
        this.runMatch = runSimulatedGame;
        this.runDeep = runDeepGame;
    }

    /** A fresh 32-bit seed for a deterministic, replayable sparring game. */
    newSeed() {
        return crypto.randomInt(0x7fffffff);
    }

    /**
     * ARCHON (N24): claim the right to be the process that plays.
     *
     * Sparring is CPU, and CPU spent on sparring is CPU not spent on the real
     * games somebody is waiting for - so the sweep can be run on a node of its
     * own (server/challengeworker) instead of inside the lobby. Which means two
     * processes can now both believe it is their job, and a doubled sweeper is
     * not a harmless duplicate: every deck would quietly play twice its daily
     * budget, invisibly, in results nobody can audit.
     *
     * So the right to sweep is a lease, taken in ONE statement - the upsert
     * either wins or returns nothing, with no read-then-write window for a
     * second process to slip through. A holder that dies costs one lease period
     * of idleness; it can never cost a double-played roster.
     *
     * @param {string} owner this process's identity, for the operator's benefit
     * @param {number} [leaseSeconds] how long a silent holder keeps the lease
     * @returns {Promise<boolean>} whether this process may sweep now
     */
    async claimSweepLease(owner, leaseSeconds) {
        const seconds = Math.max(30, parseInt(leaseSeconds, 10) || 120);

        try {
            const rows = await this.db.query(
                'INSERT INTO "ChallengeSweepLease" ("Id", "Owner", "HeartbeatAt") ' +
                    "VALUES (1, $1, now() AT TIME ZONE 'utc') " +
                    'ON CONFLICT ("Id") DO UPDATE SET "Owner" = $1, ' +
                    '"HeartbeatAt" = now() AT TIME ZONE \'utc\' ' +
                    // Renew our own lease, or take one nobody has refreshed.
                    'WHERE "ChallengeSweepLease"."Owner" = $1 ' +
                    'OR "ChallengeSweepLease"."HeartbeatAt" < ' +
                    "now() AT TIME ZONE 'utc' - ($2 || ' seconds')::interval " +
                    'RETURNING "Owner"',
                [owner, seconds]
            );

            return !!(rows && rows.length);
        } catch (err) {
            logger.error('Champion’s Challenge could not claim the sweep lease', err);

            // Refuse rather than risk two sweepers: a quiet lab is recoverable,
            // a doubled one corrupts the numbers the whole feature sells.
            return false;
        }
    }

    /**
     * Whether this kind of process is the one configured to sweep.
     *
     * `sweepOwner` is the operator's answer to "where do the simulated games
     * run": the lobby (the default, and how this shipped), a dedicated worker
     * node, or whichever process gets there first.
     *
     * @param {'lobby'|'worker'} role
     */
    maySweepAs(role) {
        const configured = this.getConfig().sweepOwner;
        // An unrecognised value falls back to the lobby rather than to nobody: a
        // typo in a setting should leave the lab working as it always has, not
        // silently stop every member's games with no error anywhere.
        const owner = ['lobby', 'worker', 'any'].includes(configured) ? configured : 'lobby';

        return owner === 'any' || owner === role;
    }

    /**
     * The entry point both hosts use: check this process is the configured
     * host, take the lease, then sweep. Callers must not reach past this to
     * `runSweep` - that is what would let two nodes play at once.
     *
     * @param {'lobby'|'worker'} role
     * @param {string} owner process identity for the lease row
     */
    async runSweepAs(role, owner) {
        if (!this.maySweepAs(role)) {
            return { played: 0, abandoned: 0, skipped: 'not-this-node' };
        }

        if (!(await this.claimSweepLease(owner, this.getConfig().sweepLeaseSeconds))) {
            return { played: 0, abandoned: 0, skipped: 'lease-held-elsewhere' };
        }

        return this.runSweep();
    }

    /** Admin-configurable knobs, defaults from the settings registry. */
    getConfig() {
        return this.settingsService.getSectionWithDefaults('championsChallenge');
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
        const access = await this.rosterAccess(userId);

        return access.mayUse;
    }

    /**
     * Access AND standing: whether this roster's owner may use the lab, and
     * whether they are a site admin - admins' decks are exempt from the
     * per-deck daily budget, because the person tuning the lab needs to be
     * able to flood it.
     *
     * @param {number} userId
     * @returns {Promise<{mayUse: boolean, isAdmin: boolean}>}
     */
    async rosterAccess(userId) {
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
                'Champion’s Challenge admin lookup failed for user %s: %s',
                userId,
                err.message
            );
        }

        const membership = await this.membershipService.getMembership(userId);
        const entitlements = resolveEntitlements({
            user: { id: userId, permissions: { isAdmin } },
            membership
        });

        return {
            mayUse: entitlements.capabilities.includes(CAPABILITIES.CHAMPIONS_CHALLENGE),
            isAdmin
        };
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
                `All ${config.maxEnrolledPerUser} Champion’s Challenge slots are in use. ` +
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
                "The Champion’s Challenge cannot play that deck yet - it uses cards this server's " +
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
                uuid: (row && row.Uuid) || `challenge-${deckId}`,
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

        // ARCHON (N19): read once per sweep - which index rate sparring games
        // move ARI at, and whether they move it at all.
        const ariConfig = (this.ratingService.getConfig() || {}).ari || {};
        const eloConfig = this.eloConfig();

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

        // ARCHON (N24): field games count against the same daily budget. A
        // deck's rest day is a rest day - otherwise turning the Gauntlet on
        // would quietly double how hard every deck is worked.
        const fieldToday = await this.db.query(
            'SELECT "DeckId", COUNT(*)::int AS "GamesToday" FROM "GauntletGames" ' +
                "WHERE \"FinishedAt\" >= date_trunc('day', now() AT TIME ZONE 'utc') " +
                'GROUP BY "DeckId"',
            []
        );

        for (const count of fieldToday || []) {
            gamesToday.set(count.DeckId, (gamesToday.get(count.DeckId) || 0) + count.GamesToday);
        }

        const rosters = new Map();

        for (const enrollment of enrollments) {
            if (!rosters.has(enrollment.UserId)) {
                rosters.set(enrollment.UserId, []);
            }

            rosters.get(enrollment.UserId).push(enrollment.DeckId);
        }

        // ARCHON (N21): the champion model plays every sparring game; its
        // games feed the diary that trains its successor.
        const learning = config.learningEnabled !== false;
        const championModel = learning ? await this.policyService.champion() : null;
        const championVersion = championModel ? championModel.version : null;
        // ARCHON (N25): exploration ANNEALS. A young model needs to try
        // second-best moves to find out they were best; a model trained on
        // fifty thousand games is mostly being made worse by the noise. The
        // temperature decays with the champion's experience toward a floor that
        // never quite reaches zero, because a policy that stops exploring
        // entirely can never discover it has grown wrong.
        const temperature = this.explorationTemperature(config, championModel);

        // Rosters are visited round-robin in a shuffled order - one game per
        // member per pass - so one member's full queue cannot starve
        // another's, while a quiet site still gets its full batch from the
        // one roster that wants games. Entitlement verdicts are cached per
        // sweep; budgets are re-read from `gamesToday` as it fills.
        const users = shuffle([...rosters.keys()]);
        const access = new Map();
        // ARCHON (N24): each roster's Gauntlet configuration, read once.
        const fieldSettings = new Map();
        let played = 0;
        let abandoned = 0;
        let progress = true;

        while (played < config.gamesPerSweep && progress) {
            progress = false;

            for (const userId of users) {
                if (played >= config.gamesPerSweep) {
                    break;
                }

                if (!access.has(userId)) {
                    access.set(userId, await this.rosterAccess(userId));
                }

                if (!access.get(userId).mayUse) {
                    continue;
                }

                // ARCHON (N20-adjacent): a site admin's decks are exempt from
                // the daily budget - the person tuning the lab must be able
                // to flood it. Everyone else's decks rest at the cap.
                const unlimited = access.get(userId).isAdmin;
                const eligible = rosters
                    .get(userId)
                    .filter(
                        (deckId) =>
                            unlimited || (gamesToday.get(deckId) || 0) < config.gamesPerDeckPerDay
                    );

                if (!eligible.length) {
                    continue;
                }

                // ARCHON (N24): mirror game or field game? The member sets the
                // share; the coin is flipped per game so both measurements
                // accumulate together rather than in blocks.
                if (!fieldSettings.has(userId)) {
                    fieldSettings.set(userId, await this.gauntletService.settingsFor(userId));
                }

                const field = fieldSettings.get(userId);
                const wantsField =
                    field.enabled &&
                    field.fieldSharePct > 0 &&
                    crypto.randomInt(100) < field.fieldSharePct;

                if (wantsField) {
                    // A field game needs one deck of the member's, not two - so
                    // a single-deck roster, which the mirror lab could never
                    // give a game at all, plays here.
                    const mine = shuffle(eligible).sort(
                        (a, b) => (gamesToday.get(a) || 0) - (gamesToday.get(b) || 0)
                    )[0];
                    const outcome = await this.playFieldGame({
                        userId,
                        deckId: mine,
                        settings: field,
                        config,
                        championModel,
                        championVersion,
                        learning,
                        ariConfig,
                        eloConfig
                    });

                    if (outcome === 'played') {
                        gamesToday.set(mine, (gamesToday.get(mine) || 0) + 1);
                        played++;
                        progress = true;
                        continue;
                    }

                    if (outcome === 'abandoned') {
                        abandoned++;
                        continue;
                    }

                    // 'no-opponent': the pool has nothing matching this
                    // member's filters yet. Fall through to a mirror game
                    // rather than spending their tick on nothing.
                }

                if (eligible.length < 2) {
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
                        `Champion’s Challenge skipped rosters of user ${userId}: deck ` +
                            `${alpha.missing.length ? pair[0] : pair[1]} is not simulatable`
                    );
                    continue;
                }

                // ARCHON (N21): one deep, annotated showcase game per roster
                // per day (config), when its budget allows; every other game
                // is the fast bot exploring and logging its decisions.
                const deepToday = await this.deepGamesToday(userId);
                const playDeep = learning && deepToday < (config.deepGamesPerDay || 0);
                let result;

                try {
                    result = playDeep
                        ? await this.runDeep(alpha.deck, omega.deck, {
                              seed: this.newSeed(),
                              policy: championModel,
                              maxTurns: config.maxTurnsPerGame,
                              // ARCHON (N25): a showcase game is also the best
                              // training data the site produces, so it goes in
                              // the diary like any other - and its SEARCH goes
                              // in too, as lessons.
                              recordDecisions: learning,
                              maxAnalyzedDecisions: config.deepMaxAnalyzedDecisions,
                              candidatesCap: config.deepCandidates,
                              samplesPerCandidate: config.deepSamples,
                              rolloutTurns: config.deepRolloutTurns
                          })
                        : await this.runMatch(alpha.deck, omega.deck, {
                              seed: this.newSeed(),
                              maxTurns: config.maxTurnsPerGame,
                              policy: championModel,
                              // Exploration keeps the diary honest: a bot
                              // that never tries second-best moves can never
                              // learn which ones were actually best.
                              temperature,
                              recordDecisions: learning
                          });
                } catch (err) {
                    logger.error(
                        `Champion’s Challenge game failed for user ${userId} ` +
                            `(decks ${pair[0]} vs ${pair[1]}):`,
                        err
                    );
                    abandoned++;
                    continue;
                }

                if (!result || !result.completed) {
                    logger.warn(
                        `Champion’s Challenge abandoned a game for user ${userId} ` +
                            `(decks ${pair[0]} vs ${pair[1]}): ${result && result.reason}`
                    );
                    abandoned++;
                    continue;
                }

                await this.recordGame(userId, result);

                // The diary: this game's decisions, labeled by its outcome.
                if (learning && result.decisions && result.decisions.length) {
                    try {
                        const logged = await this.policyService.recordTrainingGame(
                            {
                                policyVersion: championVersion,
                                winnerSide: result.winner,
                                decisions: result.decisions
                            },
                            config.trainingGamesKept
                        );

                        if (logged % (config.trainEveryGames || 25) === 0) {
                            await this.policyService.trainCandidate({
                                batchGames: (config.trainEveryGames || 25) * 8,
                                lambda: config.trainingLambda
                            });
                        }
                    } catch (err) {
                        logger.error('Challenge bot: failed to log training game', err);
                    }
                }

                // ARCHON (N25): the deep bot's search, kept. Every road it
                // rolled out is a decision whose value was measured, and the
                // fast policy trains toward those numbers directly - which is
                // how a minute of forking becomes knowledge that costs nothing
                // to use afterwards.
                await this.recordDeepLessons(result, config);

                // The randomizer: a random slot that has served its games
                // swaps for a fresh random deck.
                await this.rotateRandomSlots(userId, [pair[0], pair[1]]);

                // ARCHON (N19): a sparring result moves both decks' ARIs at
                // the sim rate. Best-effort by AriService contract - a failed
                // index update never fails the sweep - and skipped entirely
                // when the admin has ARI off.
                if (ariConfig.enabled) {
                    await this.ariService.applyGameResult({
                        winnerUuid: result.winnerDeck.uuid,
                        loserUuid: result.loserDeck.uuid,
                        k: ariConfig.simGameK,
                        sasWeight: eloConfig.sasWeight,
                        sim: true
                    });
                }

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

        // ARCHON (N21): the title fight. If a candidate is in training, it
        // plays the champion on NEUTRAL decks - never anyone's roster, never
        // recorded as deck data - and its record decides the crown.
        if (learning) {
            try {
                await this.runArenaStep(config);
            } catch (err) {
                logger.error('Challenge bot: arena step failed', err);
            }
        }

        // ARCHON (N24): grow the field, after the games rather than before -
        // hydration waits on Master Vault, and a member's games should not.
        // Only while somebody actually plays the field: a pool nobody has asked
        // for is not worth a single outbound request.
        try {
            if (await this.gauntletService.anyoneWantsField()) {
                await this.gauntletService.hydratePool();
                await this.gauntletService.enrichPool();
            }
        } catch (err) {
            logger.error('Gauntlet: pool upkeep failed', err);
        }

        return { played, abandoned };
    }

    /**
     * ARCHON (N24): one Gauntlet game - a member's deck against a stranger's.
     *
     * The opponent is drawn from the hydrated Master Vault pool, filtered by
     * the member's settings and never including their own or a friend's deck.
     * The result is recorded as a field result (GauntletGames), kept apart from
     * the mirror record because they answer different questions, and moves both
     * decks' ARI at the sim rate - the same evidence a mirror game is, so it is
     * weighed the same way.
     *
     * The member's deck always takes the alpha seat, which is what makes
     * `winner === PLAYER_ONE` mean "mine won" without consulting the decks.
     *
     * @returns {Promise<'played'|'abandoned'|'no-opponent'>}
     */
    async playFieldGame({
        userId,
        deckId,
        settings,
        config,
        championModel,
        championVersion,
        learning,
        ariConfig,
        eloConfig
    }) {
        const opponent = await this.gauntletService.drawOpponent(userId, settings);

        if (!opponent) {
            return 'no-opponent';
        }

        const mine = await this.loadEngineDeck(deckId);

        if (mine.missing.length || mine.deck.houses.length !== 3) {
            logger.warn(`Gauntlet skipped deck ${deckId} of user ${userId}: not simulatable`);

            return 'abandoned';
        }

        let result;

        try {
            result = await this.runMatch(mine.deck, opponent.deck, {
                seed: this.newSeed(),
                maxTurns: config.maxTurnsPerGame,
                policy: championModel,
                temperature: 0.7,
                recordDecisions: learning
            });
        } catch (err) {
            logger.error(
                `Gauntlet game failed for user ${userId} (deck ${deckId} vs ${opponent.uuid}):`,
                err
            );

            return 'abandoned';
        }

        if (!result || !result.completed) {
            logger.warn(
                `Gauntlet abandoned a game for user ${userId} (deck ${deckId} vs ` +
                    `${opponent.uuid}): ${result && result.reason}`
            );

            return 'abandoned';
        }

        const won = result.winner === PLAYER_ONE;

        try {
            await this.gauntletService.recordGame({ userId, deckId, opponent, won, result });
            await this.gauntletService.noteOpponentPlayed(opponent.uuid);
        } catch (err) {
            logger.error('Gauntlet: could not record a field game', err);

            return 'abandoned';
        }

        // The diary does not care whose deck was on the other side: a decision
        // made against a stranger's deck is training data on the same terms.
        if (learning && result.decisions && result.decisions.length) {
            try {
                const logged = await this.policyService.recordTrainingGame(
                    {
                        policyVersion: championVersion,
                        winnerSide: result.winner,
                        decisions: result.decisions
                    },
                    config.trainingGamesKept
                );

                if (logged % (config.trainEveryGames || 25) === 0) {
                    await this.policyService.trainCandidate({
                        batchGames: (config.trainEveryGames || 25) * 8
                    });
                }
            } catch (err) {
                logger.error('Challenge bot: failed to log training game', err);
            }
        }

        await this.rotateRandomSlots(userId, [deckId]);

        if (ariConfig.enabled) {
            await this.ariService.applyGameResult({
                winnerUuid: result.winnerDeck.uuid,
                loserUuid: result.loserDeck.uuid,
                k: ariConfig.simGameK,
                sasWeight: eloConfig.sasWeight,
                sim: true
            });
        }

        return 'played';
    }

    /**
     * ARCHON (N25): store what a deep game's search measured.
     *
     * The lessons go into the diary as a row whose decisions carry explicit
     * targets - the win probability the rollouts found for each road, taken or
     * not. `trainModel` prefers a target over any outcome-derived label, so the
     * next candidate is trained partly on positions whose value was established
     * by playing them out rather than inferred from who eventually won.
     *
     * The rejected roads matter as much as the chosen one: they are the only
     * negative examples the loop ever gets. Outcome-labelled play can say "this
     * move appeared in a won game"; only the search can say "this move was
     * worth 0.62 and that one 0.41 from the same position".
     *
     * Best effort - a diary write that fails must never cost the game.
     */
    async recordDeepLessons(result, config) {
        if (!result || !result.deep || !result.lessons || !result.lessons.length) {
            return;
        }

        try {
            await this.policyService.recordTrainingGame(
                {
                    policyVersion: null,
                    // Every decision here carries its own target, so the winner
                    // is not what labels them - but the row keeps it, because a
                    // lesson row is still a record of a real game.
                    winnerSide: result.winner,
                    decisions: result.lessons
                },
                config.trainingGamesKept
            );

            if (result.forksFailed && result.forksFailed > result.forksPlayed / 4) {
                // A deep bot quietly running on a quarter of its samples looks
                // exactly like a deep bot that is thinking hard.
                logger.warn(
                    `Challenge deep bot: ${result.forksFailed} of ${result.forksPlayed} forks ` +
                        'could not be played - the search is running on fewer samples than budgeted'
                );
            }
        } catch (err) {
            logger.error('Challenge bot: failed to store deep lessons', err);
        }
    }

    /**
     * ARCHON (N25): how adventurously the fast bot plays, given how much the
     * champion has already seen.
     *
     * Decays from `explorationTemperature` toward `explorationFloor` on the
     * champion's trained-game count, halving every `explorationHalfLife` games.
     * The floor is deliberately above zero: a policy that stops exploring cannot
     * notice the day its own habits stopped working, which is exactly what
     * happens when the card pool changes underneath it.
     */
    explorationTemperature(config, championModel) {
        const start = Number(config.explorationTemperature);
        const floor = Number(config.explorationFloor);
        const halfLife = Number(config.explorationHalfLife);
        const top = Number.isFinite(start) ? start : 0.7;
        const bottom = Number.isFinite(floor) ? floor : 0.15;
        const half = Number.isFinite(halfLife) && halfLife > 0 ? halfLife : 20000;
        const seen = (championModel && championModel.trainedGames) || 0;

        return bottom + (top - bottom) * Math.pow(0.5, seen / half);
    }

    /** How many deep showcase games this roster has had today (UTC). */
    async deepGamesToday(userId) {
        const rows = await this.db.query(
            'SELECT COUNT(*)::int AS "DeepToday" FROM "ProvingGroundsGames" ' +
                'WHERE "UserId" = $1 AND "Deep" = true ' +
                "AND \"FinishedAt\" >= date_trunc('day', now() AT TIME ZONE 'utc')",
            [userId]
        );

        return rows && rows[0] ? rows[0].DeepToday : 0;
    }

    /**
     * ARCHON (N21): one arena game between the candidate and the champion,
     * seats alternated by coin flip, on neutral decks built from pack data.
     * The result goes only to the candidate's record; promotion and
     * retirement live in BotPolicyService.
     */
    async runArenaStep(config) {
        const candidate = await this.policyService.candidate();

        if (!candidate) {
            return;
        }

        const champion = await this.policyService.champion();
        const [deckA, deckB] = this.neutralArenaDecks();
        // ARCHON (N25): PAIRED SEEDS. One seed, played twice, seats swapped -
        // so both brains face the same shuffles, the same draws and the same
        // first-player advantage, once from each side.
        //
        // A coin flip per game (which is what this was) leaves deck and draw
        // luck in the record, and that noise is most of why a title fight
        // needed hundreds of games to say anything. Pairing cancels it: what
        // survives a pair is the difference between the two players, which is
        // the only thing being measured.
        const seed = this.newSeed();
        const halves = [true, false];

        for (const candidateIsAlpha of halves) {
            const result = await this.runMatch(deckA, deckB, {
                seed,
                maxTurns: config.maxTurnsPerGame,
                // A genuine head-to-head: one brain per seat. A null champion is
                // the heuristics - exactly the baseline the first candidate has
                // to dethrone.
                policies: candidateIsAlpha
                    ? { alpha: candidate.Model, omega: champion }
                    : { alpha: champion, omega: candidate.Model },
                temperature: 0,
                recordDecisions: false
            });

            if (!result || !result.completed) {
                // Drop the whole pair: half a pair is an unpaired game, which
                // is the noise this is here to remove.
                return;
            }

            const candidateWon = candidateIsAlpha
                ? result.winner === PLAYER_ONE
                : result.winner !== PLAYER_ONE;
            const verdict = await this.policyService.recordArenaResult(candidate.Id, candidateWon, {
                minGames: config.arenaMinGames,
                decideGames: config.arenaDecideGames
            });

            // Settled mid-pair: the title has changed hands or the candidate is
            // gone, and the second half would be scored against a row that no
            // longer holds the crown it was contesting.
            if (verdict === 'promoted' || verdict === 'retired') {
                return;
            }
        }
    }

    /**
     * Two fixed 36-card decks from pack data, for arena games: neutral
     * ground that no member's stats can be polluted by and every candidate
     * meets alike.
     */
    neutralArenaDecks() {
        if (this.arenaDecks) {
            return this.arenaDecks;
        }

        const build = (name, houses) => {
            const byHouse = {};

            for (const card of Object.values(getCardIndex())) {
                if (
                    houses.includes(card.house) &&
                    !card.isNonDeck &&
                    ['creature', 'artifact', 'action', 'upgrade'].includes(card.type)
                ) {
                    (byHouse[card.house] = byHouse[card.house] || []).push(card);
                }
            }

            const cards = [];

            for (const house of houses) {
                const pool = byHouse[house];

                for (let i = 0; i < 12; i++) {
                    const card = pool[(i * 5) % pool.length];

                    cards.push({ id: card.id, count: 1, card: cloneCard(card.id) });
                }
            }

            return { name, uuid: `arena-${name}`, expansion: 341, houses, cards };
        };

        this.arenaDecks = [
            build('Arena Alpha', ['brobnar', 'dis', 'logos']),
            build('Arena Omega', ['sanctum', 'shadows', 'untamed'])
        ];

        return this.arenaDecks;
    }

    /**
     * ARCHON (N21): the randomizer's rotation. Any random slot among the
     * decks that just played, whose games since enrollment have reached its
     * target, is swapped for a fresh random deck carrying the same target.
     */
    async rotateRandomSlots(userId, deckIds) {
        try {
            const slots = await this.db.query(
                'SELECT e."DeckId", e."RandomGamesTarget", e."EnrolledAt", ' +
                    '(SELECT COUNT(*)::int FROM "ProvingGroundsGames" g ' +
                    ' WHERE g."UserId" = e."UserId" ' +
                    ' AND (g."WinnerDeckId" = e."DeckId" OR g."LoserDeckId" = e."DeckId") ' +
                    ' AND g."FinishedAt" >= e."EnrolledAt") AS "PlayedSince" ' +
                    'FROM "ProvingGroundsDecks" e ' +
                    'WHERE e."UserId" = $1 AND e."Random" = true AND e."DeckId" = ANY($2)',
                [userId, deckIds]
            );

            for (const slot of slots || []) {
                if (!slot.RandomGamesTarget || slot.PlayedSince < slot.RandomGamesTarget) {
                    continue;
                }

                await this.withdrawDeck(userId, slot.DeckId);

                const swapped = await this.enrollRandomDeck(userId, slot.RandomGamesTarget, {
                    exclude: [slot.DeckId]
                });

                logger.info(
                    `Challenge randomizer: user ${userId} deck ${slot.DeckId} rotated out ` +
                        `after ${slot.PlayedSince} games` +
                        (swapped ? ` for deck ${swapped}` : ' (no replacement available)')
                );
            }
        } catch (err) {
            logger.error('Challenge randomizer rotation failed', err);
        }
    }

    /**
     * Fill several randomizer slots in one go, stopping early when the roster
     * runs out of room or the collection runs out of eligible decks - a
     * partial fill is a real answer here ("I asked for five, I own three"),
     * so the caller gets the list and decides what to say about it.
     *
     * Each deck is enrolled before the next is drawn, and the draw excludes
     * anything already on the roster, so one call cannot pick the same deck
     * twice.
     *
     * @returns {Promise<number[]>} the enrolled deck ids, in the order drawn
     */
    async enrollRandomDecks(userId, gamesTarget, count) {
        const wanted = Math.max(1, Math.min(this.getConfig().maxEnrolledPerUser, count || 1));
        const enrolled = [];

        for (let slot = 0; slot < wanted; slot++) {
            const deckId = await this.enrollRandomDeck(userId, gamesTarget, {
                exclude: enrolled
            });

            if (!deckId) {
                break;
            }

            enrolled.push(deckId);
        }

        return enrolled;
    }

    /**
     * Enroll a random eligible deck into a randomizer slot: owned, rated,
     * simulatable, not already on the roster, not excluded. A handful of
     * candidates are drawn and tried in random order, because "simulatable"
     * can only be proven by loading the deck.
     *
     * @returns {Promise<number|null>} the enrolled deck id, or null
     */
    async enrollRandomDeck(userId, gamesTarget, { exclude = [] } = {}) {
        const target = Math.max(1, Math.min(500, parseInt(gamesTarget, 10) || 20));
        const candidates = await this.db.query(
            'SELECT d."Id" FROM "Decks" d ' +
                'LEFT JOIN "DeckSas" ds ON ds."Uuid" = d."Uuid" ' +
                'WHERE d."UserId" = $1 AND NOT COALESCE(d."Banned", false) ' +
                'AND ds."SasRating" IS NOT NULL ' +
                'AND NOT (d."Id" = ANY($2)) ' +
                'AND NOT EXISTS (SELECT 1 FROM "ProvingGroundsDecks" e ' +
                'WHERE e."UserId" = $1 AND e."DeckId" = d."Id") ' +
                'ORDER BY random() LIMIT 8',
            [userId, exclude]
        );

        for (const row of candidates || []) {
            const { missing, deck } = await this.loadEngineDeck(row.Id);

            if (missing.length || deck.houses.length !== 3) {
                continue;
            }

            await this.db.query(
                'INSERT INTO "ProvingGroundsDecks" ' +
                    '("UserId", "DeckId", "EnrolledAt", "Random", "RandomGamesTarget") ' +
                    "VALUES ($1, $2, now() AT TIME ZONE 'utc', true, $3) " +
                    'ON CONFLICT ("UserId", "DeckId") DO NOTHING',
                [userId, row.Id, target]
            );

            return row.Id;
        }

        return null;
    }

    /** Persist one finished simulated game, deep annotations and all. */
    async recordGame(userId, result) {
        await this.db.query(
            'INSERT INTO "ProvingGroundsGames" ' +
                '("UserId", "WinnerDeckId", "LoserDeckId", "WinnerKeys", "LoserKeys", "Turns", ' +
                '"WinnerWentFirst", "WinnerFirstHouse", "LoserFirstHouse", "WinnerHouseCalls", ' +
                '"LoserHouseCalls", "DurationMs", "Deep", "Annotations", "FinishedAt") ' +
                'VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, ' +
                "now() AT TIME ZONE 'utc')",
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
                result.durationMs,
                !!result.deep,
                result.annotations ? JSON.stringify(result.annotations) : null
            ]
        );
    }

    /**
     * Everything the Champion’s Challenge page shows, in one read.
     *
     * @param {number} userId
     * @returns {Promise<object>}
     */
    async getLabReport(userId, { isAdmin = false } = {}) {
        const config = this.getConfig();

        const [enrollmentRows, gameRows, candidateRows] = await Promise.all([
            this.db.query(
                'SELECT e."DeckId", e."EnrolledAt", e."Random", e."RandomGamesTarget", ' +
                    'd."Name", d."Uuid", ds."SasRating" ' +
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
        // ARCHON (N19): each deck's ARI - stored when any game has moved it,
        // the SAS/AERC seed otherwise - so the page always has a number where
        // the deck's rating goes.
        const ariByUuid = await this.ariService.ariForUuids(
            enrollmentList.map((enrollment) => enrollment.Uuid)
        );
        const decks = enrollmentList.map((enrollment) =>
            this.aggregateDeck(enrollment, games, sasByDeck, eloConfig, ariByUuid)
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

        // ARCHON (N21): the latest deep showcase games, annotations and all,
        // with names for both seats so the sentences read as decks.
        const nameByDeck = new Map(
            enrollmentList.map((enrollment) => [enrollment.DeckId, enrollment.Name])
        );
        const showcase = games
            .filter((game) => game.Deep && game.Annotations)
            .slice(-5)
            .reverse()
            .map((game) => ({
                playedAt: game.FinishedAt,
                winner: nameByDeck.get(game.WinnerDeckId) || `Deck ${game.WinnerDeckId}`,
                loser: nameByDeck.get(game.LoserDeckId) || `Deck ${game.LoserDeckId}`,
                winnerKeys: game.WinnerKeys,
                loserKeys: game.LoserKeys,
                turns: game.Turns,
                annotations: game.Annotations
            }));

        const bot = await this.policyService.vitals().catch(() => null);
        // ARCHON (N26): the three things the roster's own games were already
        // producing and nothing showed - which of your decks beats which, what
        // the bot has learned about the cards in your best deck, and the
        // champion's line of succession.
        const champion = await this.policyService.champion().catch(() => null);
        const matchups = this.matchupMatrix(enrollmentList, games);
        const strengthCurve = await this.policyService.strengthCurve().catch(() => []);
        const topDeck = decks.find((deck) => deck.games > 0) || null;
        const cards = topDeck ? await this.cardContribution(topDeck.deckId, champion) : null;

        // ARCHON (N24): the field. Each deck's record against strangers' decks
        // is attached BESIDE its mirror record, never folded into it - 60%
        // against your own collection and 60% against the world are different
        // claims, and their average answers neither.
        const [fieldSettings, fieldRecords, fieldRecent] = await Promise.all([
            this.gauntletService.settingsFor(userId),
            this.gauntletService.recordsFor(userId),
            this.gauntletService.recentGames(userId)
        ]);
        const poolStatus = await this.gauntletService.poolStatus(userId, fieldSettings);

        for (const deck of decks) {
            const record = fieldRecords[deck.deckId];

            deck.field = record || { games: 0, wins: 0, losses: 0, winRate: null };
            // Whether the field agrees with the mirror lab about this deck. A
            // deck that beats your collection but not the world is the more
            // common story, and the one worth telling.
            deck.field.confident = deck.field.games >= MIN_CONFIDENT_GAMES;
        }

        return {
            running: !!config.enabled,
            maxEnrolled: config.maxEnrolledPerUser,
            gamesPerDeckPerDay: config.gamesPerDeckPerDay,
            // ARCHON: a site admin's decks are exempt from the daily budget.
            unlimited: !!isAdmin,
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
            findings: buildFindings(decks),
            showcase,
            bot,
            matchups,
            strengthCurve,
            cards: cards ? { ...cards, deckId: topDeck.deckId, deckName: topDeck.name } : null,
            gauntlet: {
                ...fieldSettings,
                pool: poolStatus,
                recent: fieldRecent,
                strategies: Object.entries(GauntletService.STRATEGIES).map(([key, strategy]) => ({
                    key,
                    label: strategy.label,
                    description: strategy.description
                }))
            }
        };
    }

    /**
     * ARCHON (N26): the lab's vital signs, for the operator.
     *
     * Everything here already existed - as a counter in a result object, a
     * warning in a log, a row nobody reads. That is the problem: two features
     * ship behind operator switches (the Gauntlet's catalog crawl, the worker
     * node), and an operator deciding whether to turn them on had no way to see
     * whether the last hour of work went anywhere.
     *
     * Read-only, tolerant of every part being absent, and never throws: a health
     * panel that 500s is worse than no health panel.
     */
    async labHealth() {
        const config = this.getConfig();
        const ask = async (sql, params = []) => {
            try {
                return await this.db.query(sql, params);
            } catch (err) {
                logger.error('Challenge health query failed', err);

                return null;
            }
        };

        const [lease, sparring, pool, unplayable, diary, deep] = await Promise.all([
            ask('SELECT "Owner", "HeartbeatAt" FROM "ChallengeSweepLease" WHERE "Id" = 1'),
            ask(
                'SELECT COUNT(*)::int AS "Total", ' +
                    'COUNT(*) FILTER (WHERE "FinishedAt" >= ' +
                    "date_trunc('day', now() AT TIME ZONE 'utc'))::int AS \"Today\" " +
                    'FROM "ProvingGroundsGames"'
            ),
            ask(
                'SELECT COUNT(*) FILTER (WHERE g."Playable")::int AS "Playable", ' +
                    'COUNT(*)::int AS "Hydrated", ' +
                    // ARCHON (N27): how much of the playable pool carries a SAS
                    // score, and how much has been asked about without getting
                    // one. Without this pair, a SAS or strategy filter that
                    // matches nothing is unexplainable from the outside: the
                    // filters are computed from Decks of KeyForge enrichment, so
                    // an unenriched pool answers every one of them with "no
                    // opponents" while looking perfectly healthy.
                    'COUNT(*) FILTER (WHERE g."Playable" AND ds."Uuid" IS NOT NULL)::int AS "Rated", ' +
                    'COUNT(*) FILTER (WHERE g."Playable" AND ds."Uuid" IS NULL ' +
                    'AND g."SasAskedAt" IS NOT NULL)::int AS "Unrated", ' +
                    'MAX(g."FetchedAt") AS "LastFetch" FROM "GauntletDecks" g ' +
                    'LEFT JOIN "DeckSas" ds ON ds."Uuid" = g."Uuid"'
            ),
            ask(
                'SELECT "MissingCards", COUNT(*)::int AS "Decks" FROM "GauntletDecks" ' +
                    'WHERE "Playable" = false AND "MissingCards" IS NOT NULL ' +
                    'GROUP BY "MissingCards" ORDER BY "Decks" DESC LIMIT 5'
            ),
            ask('SELECT COUNT(*)::int AS "Games" FROM "BotTrainingGames"'),
            ask(
                'SELECT COUNT(*)::int AS "Games", ' +
                    'AVG(jsonb_array_length("Annotations"))::float AS "Annotations" ' +
                    'FROM "ProvingGroundsGames" WHERE "Deep" = true AND "Annotations" IS NOT NULL'
            )
        ]);

        const leaseRow = lease && lease[0];
        const heartbeat = leaseRow ? new Date(leaseRow.HeartbeatAt) : null;
        const leaseSeconds = Math.max(30, parseInt(config.sweepLeaseSeconds, 10) || 120);

        return {
            running: !!config.enabled,
            // Where the games are supposed to run, and who is actually running
            // them - the two most useful facts when a lab has gone quiet.
            sweepOwner: config.sweepOwner || 'lobby',
            lease: leaseRow
                ? {
                      owner: leaseRow.Owner,
                      heartbeatAt: leaseRow.HeartbeatAt,
                      // A holder that stopped refreshing is the signal that a
                      // worker node died, and it is invisible without this.
                      stale: !heartbeat || Date.now() - heartbeat.getTime() > leaseSeconds * 1000
                  }
                : null,
            sparring: {
                total: (sparring && sparring[0] && sparring[0].Total) || 0,
                today: (sparring && sparring[0] && sparring[0].Today) || 0
            },
            learning: {
                enabled: config.learningEnabled !== false,
                diaryGames: (diary && diary[0] && diary[0].Games) || 0,
                vitals: await this.policyService.vitals().catch(() => null),
                curve: await this.policyService.strengthCurve(10).catch(() => [])
            },
            deep: {
                games: (deep && deep[0] && deep[0].Games) || 0,
                avgAnnotations:
                    deep && deep[0] && deep[0].Annotations
                        ? Math.round(deep[0].Annotations * 10) / 10
                        : null
            },
            gauntlet: {
                enabled: config.gauntletEnabled !== false,
                playable: (pool && pool[0] && pool[0].Playable) || 0,
                hydrated: (pool && pool[0] && pool[0].Hydrated) || 0,
                lastFetchAt: (pool && pool[0] && pool[0].LastFetch) || null,
                target: config.gauntletTargetPoolSize,
                // How many pool decks the SAS and strategy filters can see, and
                // how many DoK was asked about and had no rating for - the second
                // number is a ceiling on the first, not a fault.
                rated: (pool && pool[0] && pool[0].Rated) || 0,
                unrated: (pool && pool[0] && pool[0].Unrated) || 0,
                // What the pool could NOT play, grouped - an operator seeing one
                // card id at the top of this list has learned something
                // actionable about their card data.
                unplayable: (unplayable || []).map((row) => ({
                    reason: row.MissingCards,
                    decks: row.Decks
                }))
            }
        };
    }

    /**
     * ARCHON (N26): which of your decks beats which.
     *
     * The mirror lab has been playing every pair on the roster against each
     * other for as long as it has been running, and nothing has ever shown the
     * result. This is the table those games were always producing: rows are the
     * deck, columns the opponent, cells the record between exactly those two.
     *
     * Pure given the games, and read from the WINNER column only - counting a
     * game from both sides would double every cell.
     */
    matchupMatrix(enrollments, games) {
        const ids = enrollments.map((enrollment) => enrollment.DeckId);
        const onRoster = new Set(ids);
        const cells = {};

        for (const game of games) {
            if (!onRoster.has(game.WinnerDeckId) || !onRoster.has(game.LoserDeckId)) {
                continue;
            }

            const forward = `${game.WinnerDeckId}|${game.LoserDeckId}`;
            const reverse = `${game.LoserDeckId}|${game.WinnerDeckId}`;

            cells[forward] = cells[forward] || { wins: 0, games: 0 };
            cells[reverse] = cells[reverse] || { wins: 0, games: 0 };
            cells[forward].wins++;
            cells[forward].games++;
            cells[reverse].games++;
        }

        return {
            decks: enrollments.map((enrollment) => ({
                deckId: enrollment.DeckId,
                name: enrollment.Name
            })),
            cells: Object.fromEntries(
                Object.entries(cells).map(([key, cell]) => [
                    key,
                    {
                        ...cell,
                        winRate: cell.games ? cell.wins / cell.games : null,
                        // Same conservatism as everywhere else: a 2-0 between two
                        // decks is not a matchup, it is two games.
                        confident: cell.games >= MIN_OPENING_GAMES
                    }
                ])
            ),
            minGames: MIN_OPENING_GAMES
        };
    }

    /**
     * ARCHON (N26): what the bot has learned about the cards in YOUR deck.
     *
     * The learned policy carries a weight per card id and a count of how often
     * it has seen each one (N25). Intersected with a deck's card list, that is a
     * genuinely new thing to tell a member: not what a card is worth in the
     * abstract, but what having played it has been worth across the games this
     * site has actually played.
     *
     * Two refusals keep it honest. A card the model has seen fewer than
     * SHRINK_PRIOR times is dropped outright - below that, most of what the
     * number expresses is the prior rather than the card, and "no view yet" is
     * the truthful thing to say. And a card it HAS seen plenty of but is neutral
     * about is dropped too, because a list where most rows say nothing teaches a
     * reader to ignore the rows that do.
     *
     * @returns {Promise<object|null>} strongest and weakest cards, or null
     */
    async cardContribution(deckId, model) {
        if (!model || !model.cardWeights) {
            return null;
        }

        let rows;

        try {
            rows = await this.db.query(
                'SELECT dc."CardId", dc."Count" FROM "DeckCards" dc WHERE dc."DeckId" = $1',
                [deckId]
            );
        } catch (err) {
            logger.error('Challenge: could not read deck cards for contribution', err);

            return null;
        }

        const counts = model.cardCounts || {};
        const scored = [];

        for (const row of rows || []) {
            const seen = counts[row.CardId] || 0;

            if (seen < SHRINK_PRIOR) {
                continue;
            }

            const weight = shrink(model.cardWeights[row.CardId], seen);

            if (Math.abs(weight) < 0.02) {
                continue;
            }

            const card = getCardIndex()[row.CardId];

            scored.push({
                cardId: row.CardId,
                name: card ? card.name : row.CardId,
                copies: row.Count,
                weight: Math.round(weight * 1000) / 1000,
                games: seen
            });
        }

        if (!scored.length) {
            return null;
        }

        scored.sort((a, b) => b.weight - a.weight);

        return {
            modelVersion: model.version || 0,
            best: scored.slice(0, 5),
            worst: scored
                .slice(-5)
                .reverse()
                .filter((entry) => entry.weight < 0)
        };
    }

    /**
     * One enrolled deck's games folded into the row the page renders.
     * Pure given its arguments; the SQL above is the only IO.
     */
    aggregateDeck(enrollment, games, sasByDeck, eloConfig, ariByUuid = new Map()) {
        const deckId = enrollment.DeckId;
        const sas = enrollment.SasRating;
        const ariInfo = ariByUuid.get(enrollment.Uuid);

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
        // ARCHON (N21): the randomizer's odometer - games since this slot
        // was (re)filled, against its swap target.
        let sinceEnrolled = 0;
        const enrolledAt = enrollment.EnrolledAt ? new Date(enrollment.EnrolledAt) : null;
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

            if (enrolledAt && new Date(game.FinishedAt) >= enrolledAt) {
                sinceEnrolled++;
            }
        }

        const total = wins + losses;
        const winRate = total ? wins / total : null;
        const expectedWinRate = expectedGames ? expectedSum / expectedGames : null;
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
            // ARCHON (N26): the interval, not just the rate. 5-3 and 300-180 both
            // print "62%"; only one of them means it.
            interval: wilsonInterval(wins, total),
            expectedWinRate,
            delta: winRate != null && expectedWinRate != null ? winRate - expectedWinRate : null,
            // ARCHON (N19): the deck's ARI - the platform's living rating,
            // which these very games have been moving - plus how much of its
            // evidence is sparring, so the page can say so.
            ari: ariInfo && ariInfo.ari != null ? Math.round(ariInfo.ari * 10) / 10 : null,
            ariSimGames: ariInfo ? ariInfo.simGames : 0,
            ariRatedGames: ariInfo ? ariInfo.ratedGames : 0,
            confident: total >= MIN_CONFIDENT_GAMES,
            avgTurns: total ? Math.round((turnsTotal / total) * 10) / 10 : null,
            avgKeysFor: total ? Math.round((keysFor / total) * 100) / 100 : null,
            avgKeysAgainst: total ? Math.round((keysAgainst / total) * 100) / 100 : null,
            firstPlayerWinRate: wentFirstGames >= 5 ? wentFirstWins / wentFirstGames : null,
            secondPlayerWinRate: secondGames >= 5 ? secondWins / secondGames : null,
            openings: openingRows,
            bestOpening,
            // ARCHON (N21): randomizer slots and their odometers.
            random: !!enrollment.Random,
            randomGamesTarget: enrollment.RandomGamesTarget || null,
            gamesSinceEnrolled: sinceEnrolled
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

module.exports = ChampionsChallengeService;
