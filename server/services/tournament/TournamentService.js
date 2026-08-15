const crypto = require('crypto');

const logger = require('../../log');
const tournamentEvents = require('./tournamentEvents');
const {
    suggestedSwissRounds,
    matchWinsNeeded,
    foldOrder,
    pairSwissRound,
    pairEliminationRound,
    buildSingleElimBracket,
    buildDoubleElimBracket,
    roundRobinSchedule,
    computeStandings
} = require('./pairing');

const FORMATS = ['swiss', 'single-elim', 'double-elim', 'round-robin'];
// ARCHON (N9): 'hybrid' is an event where some tables play on the platform
// and some play on paper, both feeding one standing.
const MODES = ['online', 'irl', 'hybrid'];
// The modes where a match can be played on the platform. 'hybrid' has always
// been in MODES and has always described itself this way, but every path that
// opens a table checked for 'online' exactly - so a hybrid event could not
// open a single one, and the half of it that was supposed to play here had
// nowhere to play. Its tables open on demand rather than at pairing (see
// getMatchesNeedingGames), because the other half is being played on paper.
const PLATFORM_MODES = ['online', 'hybrid'];
// ARCHON (N14): 'live' is an event played in one sitting with a minutes
// clock; 'async' is a league paced in days per round, where the two players
// of each match schedule between themselves when to meet.
const PACINGS = ['live', 'async'];
const DEFAULT_ROUND_DEADLINE_DAYS = 3;
const MAX_ROUND_DEADLINE_DAYS = 30;
// How far ahead a match may be scheduled. Generous on purpose: it bounds
// typos (a proposal for next year), not planning.
const MAX_SCHEDULE_AHEAD_DAYS = 60;
// How far ahead the reminders fire. A day's notice on a round deadline is
// enough to actually arrange something; half an hour on an agreed match time
// is enough to get to a computer without being a nag.
const DEADLINE_WARNING_HOURS = 24;
const MATCH_REMINDER_MINUTES = 30;

// The round clock, in one place. Async events count their deadline in days;
// live events in minutes; an event with neither runs unclocked. Every round
// advance also re-arms the deadline notice ("DeadlineNotifiedAt"), because a
// new round is a new deadline.
const ROUND_CLOCK_SQL =
    '"RoundEndsAt" = CASE ' +
    'WHEN "Pacing" = \'async\' AND COALESCE("RoundDeadlineDays", 0) > 0 ' +
    "THEN (now() AT TIME ZONE 'utc') + (\"RoundDeadlineDays\" * interval '1 day') " +
    'WHEN "RoundTimerMinutes" > 0 ' +
    "THEN (now() AT TIME ZONE 'utc') + (\"RoundTimerMinutes\" * interval '1 minute') " +
    'ELSE NULL END, "DeadlineNotifiedAt" = NULL';
const SEED_METHODS = ['registration', 'rating', 'random', 'manual'];
const VISIBILITIES = ['public', 'private'];
const BEST_OF_OPTIONS = [1, 3, 5];
// Event game formats. 'archon' is the classic constructed format and
// maps onto the lobby's 'normal' games; reversal (pilot your
// opponent's deck) and adaptive-bo1 (play, swap, chain-bid) are
// uniquely possible in KeyForge and fully supported by the engine.
const GAME_FORMATS = ['archon', 'sealed', 'alliance', 'reversal', 'adaptive-bo1'];
const LOBBY_FORMAT_BY_EVENT = {
    archon: 'normal',
    sealed: 'sealed',
    alliance: 'alliance',
    reversal: 'reversal',
    'adaptive-bo1': 'adaptive-bo1'
};
const DECK_SWAP_POLICIES = ['locked', 'between-rounds'];
// ARCHON: prize pools are RECORDED, never held. The platform takes no money
// and moves none; an event states its buy-in and how the pot divides, and the
// organizer collects and pays out the way they already do. See migration 59.
//
// Every currency here has exactly two minor digits, because the whole
// calculation is integer cents. Adding one that does not (JPY, KRW) would make
// the arithmetic silently wrong by a factor of a hundred, so the list is the
// validation - not a convenience.
const PRIZE_CURRENCIES = [
    'USD',
    'EUR',
    'GBP',
    'CAD',
    'AUD',
    'NZD',
    'MXN',
    'BRL',
    'SEK',
    'NOK',
    'DKK',
    'PLN',
    'CZK',
    'ZAR'
];
// $10,000 in cents. Not a policy about how big an event may be - a typo guard,
// since the field is minor units and somebody will eventually type the dollars.
const MAX_ENTRY_FEE_CENTS = 1000000;
/** 100% in basis points. Mirrors FULL_SHARE in client prizePool.js. */
const FULL_SHARE_BPS = 10000;
/**
 * An IANA time-zone name as the browser reports it ('America/Chicago'), or
 * null.
 *
 * Advisory throughout: it exists so an offer can be shown as "8pm your time,
 * 3am theirs", which is the sentence that stops somebody agreeing to a match at
 * three in the morning. Never computed with - the instant is UTC, as
 * everywhere else - so an unrecognised one costs only that sentence.
 */
const cleanZone = (zone) => {
    const text = String(zone || '').trim();

    return /^[A-Za-z_+-]+\/[A-Za-z0-9_+-]+(\/[A-Za-z0-9_+-]+)?$|^UTC$/.test(text)
        ? text.slice(0, 64)
        : null;
};
// House codes as stored in the Houses table.
const HOUSE_CODES = [
    'brobnar',
    'dis',
    'ekwidon',
    'geistoid',
    'logos',
    'mars',
    'ouboros',
    'redemption',
    'sanctum',
    'saurian',
    'shadows',
    'skyborn',
    'staralliance',
    'unfathomable',
    'untamed'
];
const TRIAD_DECKS = 3;

// Join codes skip easily-confused characters (0/O, 1/I/L).
const JOIN_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const JOIN_CODE_LENGTH = 8;

const DEFAULT_TOURNAMENT_CONFIG = {
    // Hard ceiling for per-event player caps.
    maxPlayerCap: 512,
    // Lobby games are created automatically for online events.
    autoCreateGames: true,
    // Organizers may mark events as rated (feeding the Amber engine).
    allowRated: true,
    // SAS chain handicap: 1 starting chain per this many SAS of deck
    // advantage (KeyForge's official self-balancing mechanism).
    sasPerChain: 5,
    // Never assign more handicap chains than this (24 is the deepest
    // official chain tier).
    maxHandicapChains: 24
};

/**
 * Native tournament engine (Phase 7): create events, register players,
 * generate Swiss / elimination / round-robin pairings, collect results,
 * compute standings and final placements. Pure pairing math lives in
 * pairing.js; this service owns persistence and authorization.
 *
 * Any logged-in user can create and run their own events (that is the
 * point for in-person organizers); event staff (judges) share control;
 * site TOs/admins can manage all.
 *
 * Online events integrate with the lobby through tournamentEvents:
 * pairing a round emits 'roundPaired' and the lobby creates the table
 * games; finished games flow back in through recordGameWin().
 */
class TournamentService {
    constructor(db = require('../../db'), options = {}) {
        this.db = db;
        this.configService = options.configService || null;
        this.settingsService = options.settingsService || require('../settings');
        // ARCHON (N7): injected so a TournamentService built without one (as
        // most tests do) finishes team events without rating them, rather
        // than failing to finish them at all.
        this.teamRatingService = options.teamRatingService || null;
    }

    getConfig() {
        const fileConfig = this.configService?.getValue?.('tournament') || {};
        const adminConfig = this.settingsService?.getSection?.('tournament') || {};

        return { ...DEFAULT_TOURNAMENT_CONFIG, ...fileConfig, ...adminConfig };
    }

    generateJoinCode() {
        const bytes = crypto.randomBytes(JOIN_CODE_LENGTH);

        return Array.from(bytes)
            .map((byte) => JOIN_CODE_ALPHABET[byte % JOIN_CODE_ALPHABET.length])
            .join('');
    }

    normalizeJoinCode(code) {
        return String(code || '')
            .toUpperCase()
            .replace(/[^A-Z0-9]/g, '');
    }

    /**
     * jsonb columns come back parsed from Postgres but may be raw
     * strings from lighter test doubles; normalize to a value or null.
     */
    parseJsonColumn(value) {
        if (value === null || value === undefined) {
            return null;
        }

        if (typeof value === 'string') {
            try {
                return JSON.parse(value);
            } catch {
                return null;
            }
        }

        return value;
    }

    async isStaff(tournamentId, userId) {
        const rows = await this.db.query(
            'SELECT 1 FROM "TournamentStaff" WHERE "TournamentId" = $1 AND "UserId" = $2',
            [tournamentId, userId]
        );

        return rows && rows.length > 0;
    }

    /**
     * Organizer, event staff, or site TO/admin.
     */
    async canManage(actor, tournament) {
        if (!actor) {
            return false;
        }

        if (
            actor.id === tournament.OrganizerId ||
            !!actor.permissions?.canManageTournaments ||
            !!actor.permissions?.isAdmin
        ) {
            return true;
        }

        return await this.isStaff(tournament.Id, actor.id);
    }

    /**
     * ARCHON (N9): per-event Alliance pod rules.
     *
     * Returns null when the event sets none, which is the default and means
     * "any legal Alliance deck". Every field is a restriction, so an absent
     * policy can never be more restrictive than a present one.
     */
    parseAlliancePolicy(policy, errors) {
        if (!policy || typeof policy !== 'object') {
            return null;
        }

        const out = {};

        // Reject Alliance decks built before the platform recorded which
        // decks their pods came from. Those decks cannot be checked at all,
        // so an event that cares has to turn people away rather than let an
        // unverifiable deck through as if it had passed.
        out.requirePodProvenance = !!policy.requirePodProvenance;

        if (policy.maxPodsPerSourceDeck !== undefined && policy.maxPodsPerSourceDeck !== null) {
            const max = parseInt(policy.maxPodsPerSourceDeck, 10);

            if (Number.isNaN(max) || max < 1 || max > 3) {
                errors.push('Pods per source deck must be between 1 and 3');
            } else {
                out.maxPodsPerSourceDeck = max;
            }
        }

        if (Array.isArray(policy.allowedPodSets) && policy.allowedPodSets.length > 0) {
            out.allowedPodSets = policy.allowedPodSets
                .map((id) => parseInt(id, 10))
                .filter((id) => !Number.isNaN(id));
        }

        if (Array.isArray(policy.bannedPodHouses) && policy.bannedPodHouses.length > 0) {
            const houses = policy.bannedPodHouses.map((code) => String(code).toLowerCase());
            const unknown = houses.find((code) => !HOUSE_CODES.includes(code));

            if (unknown) {
                errors.push(`Unknown house '${unknown}'`);
            } else {
                out.bannedPodHouses = houses;
            }
        }

        // One physical deck, one player. Alliance is the format where this
        // matters most: two players can each build a legal Alliance deck that
        // silently depends on the same physical Archon sitting on the table.
        out.exclusiveSourceDecks = !!policy.exclusiveSourceDecks;

        return Object.keys(out).length > 0 ? out : null;
    }

    parseEventOptions(options, config) {
        const errors = [];
        const out = {};

        const name = (options.name || '').trim();
        if (name.length < 3 || name.length > 80) {
            errors.push('Name must be 3-80 characters');
        }
        out.name = name;

        out.description = (options.description || '').slice(0, 4000) || null;

        if (!FORMATS.includes(options.format)) {
            errors.push('Unknown tournament format');
        }
        out.format = options.format;

        if (options.mode && !MODES.includes(options.mode)) {
            errors.push('Unknown tournament mode');
        }
        out.mode = options.mode || 'online';

        // ARCHON (N14): async pacing - rounds measured in days, matches
        // scheduled between the players.
        if (options.pacing && !PACINGS.includes(options.pacing)) {
            errors.push('Unknown pacing');
        }
        out.pacing = options.pacing || 'live';

        const deadlineDays = options.roundDeadlineDays
            ? parseInt(options.roundDeadlineDays, 10)
            : null;
        if (
            deadlineDays !== null &&
            (Number.isNaN(deadlineDays) ||
                deadlineDays < 1 ||
                deadlineDays > MAX_ROUND_DEADLINE_DAYS)
        ) {
            errors.push(`Round deadline must be between 1 and ${MAX_ROUND_DEADLINE_DAYS} days`);
        }
        // An async event always has a deadline (that is what paces it); a
        // live event never does - it has the minutes clock instead.
        out.roundDeadlineDays =
            out.pacing === 'async' ? deadlineDays || DEFAULT_ROUND_DEADLINE_DAYS : null;

        out.gameFormat = options.gameFormat || 'archon';

        const roundCount = options.roundCount ? parseInt(options.roundCount, 10) : null;
        if (
            roundCount !== null &&
            (Number.isNaN(roundCount) || roundCount < 1 || roundCount > 20)
        ) {
            errors.push('Round count must be between 1 and 20');
        }
        out.roundCount = roundCount;

        if (options.startTime) {
            const startTime = new Date(options.startTime);
            if (Number.isNaN(startTime.getTime())) {
                errors.push('Start time is not a valid date');
            } else {
                out.startTime = startTime;
            }
        } else {
            out.startTime = null;
        }

        const playerCap = options.playerCap ? parseInt(options.playerCap, 10) : null;
        if (
            playerCap !== null &&
            (Number.isNaN(playerCap) || playerCap < 2 || playerCap > config.maxPlayerCap)
        ) {
            errors.push(`Player cap must be between 2 and ${config.maxPlayerCap}`);
        }
        out.playerCap = playerCap;

        const bestOf = options.bestOf ? parseInt(options.bestOf, 10) : 1;
        if (!BEST_OF_OPTIONS.includes(bestOf)) {
            errors.push('Best-of must be 1, 3 or 5');
        }
        out.bestOf = bestOf;

        const playoffBestOf = options.playoffBestOf ? parseInt(options.playoffBestOf, 10) : null;
        if (playoffBestOf !== null && !BEST_OF_OPTIONS.includes(playoffBestOf)) {
            errors.push('Playoff best-of must be 1, 3 or 5');
        }
        out.playoffBestOf = playoffBestOf;

        const cutTo = options.cutTo ? parseInt(options.cutTo, 10) : null;
        if (cutTo !== null && (Number.isNaN(cutTo) || cutTo < 2 || cutTo > 128)) {
            errors.push('Playoff cut must be between 2 and 128 players');
        }
        if (cutTo !== null && options.format !== 'swiss') {
            errors.push('Playoff cuts only apply to Swiss events');
        }
        out.cutTo = cutTo;

        if (options.seedMethod && !SEED_METHODS.includes(options.seedMethod)) {
            errors.push('Unknown seeding method');
        }
        out.seedMethod = options.seedMethod || 'registration';

        if (options.visibility && !VISIBILITIES.includes(options.visibility)) {
            errors.push('Unknown visibility');
        }
        out.visibility = options.visibility || 'public';

        const roundTimer = options.roundTimerMinutes
            ? parseInt(options.roundTimerMinutes, 10)
            : null;
        if (
            roundTimer !== null &&
            (Number.isNaN(roundTimer) || roundTimer < 5 || roundTimer > 240)
        ) {
            errors.push('Round timer must be between 5 and 240 minutes');
        }
        out.roundTimerMinutes = roundTimer;

        const gameTimeLimit = options.gameTimeLimit ? parseInt(options.gameTimeLimit, 10) : null;
        if (
            gameTimeLimit !== null &&
            (Number.isNaN(gameTimeLimit) || gameTimeLimit < 10 || gameTimeLimit > 180)
        ) {
            errors.push('Game time limit must be between 10 and 180 minutes');
        }
        out.gameTimeLimit = gameTimeLimit;

        out.ratedGames = !!options.ratedGames && config.allowRated !== false;
        out.requireDeckRegistration = !!options.requireDeckRegistration;
        out.hideDecklists = !!options.hideDecklists;

        const sasMin = options.sasMin ? parseInt(options.sasMin, 10) : null;
        const sasMax = options.sasMax ? parseInt(options.sasMax, 10) : null;
        if (sasMin !== null && (Number.isNaN(sasMin) || sasMin < 0 || sasMin > 200)) {
            errors.push('Minimum SAS must be between 0 and 200');
        }
        if (sasMax !== null && (Number.isNaN(sasMax) || sasMax < 0 || sasMax > 200)) {
            errors.push('Maximum SAS must be between 0 and 200');
        }
        if (sasMin !== null && sasMax !== null && sasMin > sasMax) {
            errors.push('Minimum SAS cannot exceed maximum SAS');
        }
        out.sasMin = sasMin;
        out.sasMax = sasMax;

        if (options.gameFormat && !GAME_FORMATS.includes(options.gameFormat)) {
            errors.push('Unknown game format');
        }

        if (options.deckSwapPolicy && !DECK_SWAP_POLICIES.includes(options.deckSwapPolicy)) {
            errors.push('Unknown deck swap policy');
        }
        out.deckSwapPolicy = options.deckSwapPolicy || 'locked';

        const parseCodeList = (value, label, validate) => {
            if (value === undefined || value === null || value === '') {
                return null;
            }

            if (!Array.isArray(value)) {
                errors.push(`${label} must be a list`);
                return null;
            }

            const cleaned = [...new Set(value.map(validate).filter((entry) => entry !== null))];

            if (cleaned.length !== new Set(value.filter((entry) => entry !== '')).size) {
                errors.push(`${label} contains invalid entries`);
            }

            return cleaned.length > 0 ? cleaned : null;
        };

        out.allowedSets = parseCodeList(options.allowedSets, 'Allowed sets', (entry) => {
            const id = parseInt(entry, 10);
            return Number.isNaN(id) || id < 1 ? null : id;
        });

        const houseValidator = (entry) => {
            const code = String(entry || '').toLowerCase();
            return HOUSE_CODES.includes(code) ? code : null;
        };
        out.requiredHouses = parseCodeList(
            options.requiredHouses,
            'Required houses',
            houseValidator
        );
        out.bannedHouses = parseCodeList(options.bannedHouses, 'Banned houses', houseValidator);

        if (
            out.requiredHouses &&
            out.bannedHouses &&
            out.requiredHouses.some((code) => out.bannedHouses.includes(code))
        ) {
            errors.push('A house cannot be both required and banned');
        }

        if (out.requiredHouses && out.requiredHouses.length > 3) {
            errors.push('Decks only have three houses - at most three can be required');
        }

        out.sasChainHandicap = !!options.sasChainHandicap;

        const chainsPerWin = options.chainsPerMatchWin
            ? parseInt(options.chainsPerMatchWin, 10)
            : 0;
        if (Number.isNaN(chainsPerWin) || chainsPerWin < 0 || chainsPerWin > 6) {
            errors.push('Chains per match win must be between 0 and 6');
        }
        out.chainsPerMatchWin = chainsPerWin || 0;

        out.triad = !!options.triad;

        if (out.triad) {
            // Triad pools are fixed for the event and every player needs one.
            out.requireDeckRegistration = true;

            if (out.deckSwapPolicy !== 'locked') {
                errors.push(
                    'Triad events use their three-deck pool - deck swapping does not apply'
                );
            }

            if (options.gameFormat === 'sealed') {
                errors.push('Triad requires registered decks and cannot be sealed');
            }
        }

        if (options.gameFormat === 'sealed' && out.requireDeckRegistration && !out.triad) {
            errors.push('Sealed events cannot require deck registration');
        }

        // ARCHON (N7): team events.
        out.teamEvent = !!options.teamEvent;

        const teamSize = options.teamSize ? parseInt(options.teamSize, 10) : null;

        if (teamSize !== null && (Number.isNaN(teamSize) || teamSize < 2 || teamSize > 12)) {
            errors.push('Team size must be between 2 and 12');
        }

        out.teamSize = out.teamEvent ? teamSize : null;

        // ARCHON (N9): paper results. An IRL or hybrid event accepts them by
        // definition; an online event has to opt in, because on a purely
        // online event a typed-in result is a claim about a game the platform
        // could have witnessed and did not.
        out.allowPaperResults =
            out.mode === 'irl' || out.mode === 'hybrid' ? true : !!options.allowPaperResults;

        // ARCHON (N9): Adaptive Bo3 - the loser of each game chooses to swap
        // decks or bid chains to keep their own.
        out.adaptiveBo3 = !!options.adaptiveBo3;

        if (out.adaptiveBo3) {
            if (out.triad) {
                errors.push('Adaptive and Triad are different series formats - pick one');
            }

            if (options.gameFormat === 'sealed') {
                errors.push('Adaptive swaps registered decks and cannot be sealed');
            }

            // The whole point of Adaptive is a three-game series.
            out.bestOf = 3;
        }

        const alliancePolicy = this.parseAlliancePolicy(options.alliancePolicy, errors);

        if (alliancePolicy && options.gameFormat !== 'alliance') {
            errors.push('Alliance pod rules only apply to Alliance events');
        }

        out.alliancePolicy = alliancePolicy;

        Object.assign(out, this.parsePrizePool(options, errors));

        return { errors, values: out };
    }

    /**
     * ARCHON: the buy-in and how the pot divides.
     *
     * Recorded, never held. The platform does not take, move or hold any money
     * - these are the numbers the organizer announced, so that nobody has to do
     * the arithmetic in their head at the end of the night and so that the
     * split everyone agreed to at sign-up is the one still on the screen when
     * the prizes are handed out.
     *
     * The validation earns its keep at exactly one moment: an organizer typing
     * splits that do not add up, in front of people who have already paid. So
     * the sum is checked against 100% and a table that over-allocates is
     * refused outright - under-allocating is fine and meaningful, it is the cut
     * the venue keeps.
     */
    parsePrizePool(options, errors) {
        const out = {};

        const feeGiven =
            options.entryFeeCents !== undefined &&
            options.entryFeeCents !== null &&
            options.entryFeeCents !== '';
        const fee = feeGiven ? parseInt(options.entryFeeCents, 10) : null;

        if (fee !== null && (Number.isNaN(fee) || fee < 0 || fee > MAX_ENTRY_FEE_CENTS)) {
            errors.push(
                `Entry fee must be between 0 and ${MAX_ENTRY_FEE_CENTS / 100} in whole cents`
            );
        }

        // Zero is not a buy-in, it is the absence of one - stored as null so
        // "free event" and "never configured" are the same state everywhere
        // downstream rather than two that render differently.
        out.entryFeeCents = fee || null;

        const currency = String(options.prizeCurrency || 'USD').toUpperCase();

        if (!PRIZE_CURRENCIES.includes(currency)) {
            errors.push('Unsupported prize currency');
        }

        out.prizeCurrency = PRIZE_CURRENCIES.includes(currency) ? currency : 'USD';
        out.prizeNote = (options.prizeNote || '').trim().slice(0, 500) || null;
        // How to pay. Longer than the payout note because it may carry a
        // handle, a link and a deadline.
        out.paymentInstructions = (options.paymentInstructions || '').trim().slice(0, 1000) || null;

        // Whether start() refuses to begin with unpaid players in the room.
        // Meaningless without a fee, and quietly dropped rather than refused:
        // an organizer clearing the fee has said the event is free, and
        // arguing with them about a leftover checkbox helps nobody.
        out.requirePayment = out.entryFeeCents ? !!options.requirePayment : false;

        const rawSplits = options.prizeSplits;

        if (rawSplits === undefined || rawSplits === null || rawSplits === '') {
            out.prizeSplits = null;

            return out;
        }

        if (!Array.isArray(rawSplits)) {
            errors.push('Prize splits must be a list');
            out.prizeSplits = null;

            return out;
        }

        if (rawSplits.length > 32) {
            errors.push('A prize table can pay at most 32 places');
        }

        const splits = [];
        const seenRanks = new Set();
        let malformed = false;
        let total = 0;

        for (const entry of rawSplits.slice(0, 32)) {
            const rank = parseInt(entry?.rank, 10);
            const bps = parseInt(entry?.bps, 10);

            if (
                Number.isNaN(rank) ||
                rank < 1 ||
                rank > 128 ||
                Number.isNaN(bps) ||
                bps < 1 ||
                bps > FULL_SHARE_BPS
            ) {
                malformed = true;
                continue;
            }

            if (seenRanks.has(rank)) {
                errors.push(`Two prizes are both for place ${rank}`);
                continue;
            }

            seenRanks.add(rank);
            total += bps;
            splits.push({ rank, bps });
        }

        if (malformed) {
            errors.push('Every prize needs a place and a share between 0.01% and 100%');
        }

        // Over 100% is the error worth catching: it is a table that cannot be
        // paid, and the organizer finds out when they try to pay it.
        if (total > FULL_SHARE_BPS) {
            errors.push(
                `Prize shares add up to ${(total / 100).toFixed(2)}% - they cannot exceed 100%`
            );
        }

        splits.sort((a, b) => a.rank - b.rank);
        out.prizeSplits = splits.length > 0 ? splits : null;

        return out;
    }

    async create(actor, options) {
        const config = this.getConfig();
        const { errors, values } = this.parseEventOptions(options, config);

        if (errors.length > 0) {
            return { success: false, message: errors[0] };
        }

        const joinCode = values.visibility === 'private' ? this.generateJoinCode() : null;

        const rows = await this.db.query(
            'INSERT INTO "Tournaments" ("Name", "Description", "OrganizerId", "Format", ' +
                '"GameFormat", "Mode", "RoundCount", "StartTime", "PlayerCap", "BestOf", ' +
                '"PlayoffBestOf", "CutTo", "SeedMethod", "Visibility", "JoinCode", ' +
                '"RoundTimerMinutes", "RatedGames", "RequireDeckRegistration", "SasMin", ' +
                '"SasMax", "HideDecklists", "GameTimeLimit", "DeckSwapPolicy", "AllowedSets", ' +
                '"RequiredHouses", "BannedHouses", "SasChainHandicap", "ChainsPerMatchWin", ' +
                // ARCHON: team events (N7); paper results, Alliance pod rules
                // and Adaptive Bo3 (N9).
                '"Triad", "TeamEvent", "TeamSize", "AllowPaperResults", "AlliancePolicy", ' +
                // ARCHON (N14): async pacing.
                '"AdaptiveBo3", "Pacing", "RoundDeadlineDays", ' +
                // ARCHON: the announced buy-in and prize split. Recorded only -
                // the platform never holds or moves the money.
                '"EntryFeeCents", "PrizeCurrency", "PrizeSplits", "PrizeNote", ' +
                // ARCHON: how to pay, and whether the start button enforces it.
                '"PaymentInstructions", "RequirePayment", "CreatedAt") ' +
                'VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, ' +
                '$16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, $27, $28, $29, ' +
                '$30, $31, $32, $33, $34, $35, $36, $37, $38, $39, $40, $41, $42, ' +
                'now() AT TIME ZONE \'utc\') RETURNING "Id"',
            [
                values.name,
                values.description,
                actor.id,
                values.format,
                values.gameFormat,
                values.mode,
                values.roundCount,
                values.startTime,
                values.playerCap,
                values.bestOf,
                values.playoffBestOf,
                values.cutTo,
                values.seedMethod,
                values.visibility,
                joinCode,
                values.roundTimerMinutes,
                values.ratedGames,
                values.requireDeckRegistration,
                values.sasMin,
                values.sasMax,
                values.hideDecklists,
                values.gameTimeLimit,
                values.deckSwapPolicy,
                values.allowedSets ? JSON.stringify(values.allowedSets) : null,
                values.requiredHouses ? JSON.stringify(values.requiredHouses) : null,
                values.bannedHouses ? JSON.stringify(values.bannedHouses) : null,
                values.sasChainHandicap,
                values.chainsPerMatchWin,
                values.triad,
                values.teamEvent,
                values.teamSize,
                values.allowPaperResults,
                values.alliancePolicy ? JSON.stringify(values.alliancePolicy) : null,
                values.adaptiveBo3,
                values.pacing,
                values.roundDeadlineDays,
                values.entryFeeCents,
                values.prizeCurrency,
                values.prizeSplits ? JSON.stringify(values.prizeSplits) : null,
                values.prizeNote,
                values.paymentInstructions,
                values.requirePayment
            ]
        );

        return { success: true, id: rows[0].Id };
    }

    /**
     * Organizer settings edits. Most settings are only editable before
     * the event starts; the announcement (and round timer) can change
     * at any time.
     */
    async updateSettings(tournamentId, actor, options) {
        const tournament = await this.getTournamentRow(tournamentId);

        if (!tournament) {
            return { success: false, message: 'No such tournament' };
        }

        if (!(await this.canManage(actor, tournament))) {
            return { success: false, message: 'Only the organizer can edit the event' };
        }

        if (Object.prototype.hasOwnProperty.call(options, 'announcement')) {
            await this.db.query('UPDATE "Tournaments" SET "Announcement" = $2 WHERE "Id" = $1', [
                tournamentId,
                (options.announcement || '').slice(0, 2000) || null
            ]);
        }

        const editableLive = ['announcement', 'roundTimerMinutes'];
        const otherKeys = Object.keys(options).filter((key) => !editableLive.includes(key));

        if (tournament.Status !== 'registration' && otherKeys.length > 0) {
            return {
                success: false,
                message: 'Only the announcement and round timer can change after the event starts'
            };
        }

        if (tournament.Status === 'registration') {
            const config = this.getConfig();
            const merged = {
                name: tournament.Name,
                description: tournament.Description,
                format: tournament.Format,
                gameFormat: tournament.GameFormat,
                mode: tournament.Mode,
                roundCount: tournament.RoundCount,
                startTime: tournament.StartTime,
                playerCap: tournament.PlayerCap,
                bestOf: tournament.BestOf,
                playoffBestOf: tournament.PlayoffBestOf,
                cutTo: tournament.CutTo,
                seedMethod: tournament.SeedMethod,
                visibility: tournament.Visibility,
                roundTimerMinutes: tournament.RoundTimerMinutes,
                ratedGames: tournament.RatedGames,
                requireDeckRegistration: tournament.RequireDeckRegistration,
                sasMin: tournament.SasMin,
                sasMax: tournament.SasMax,
                hideDecklists: tournament.HideDecklists,
                gameTimeLimit: tournament.GameTimeLimit,
                deckSwapPolicy: tournament.DeckSwapPolicy,
                allowedSets: this.parseJsonColumn(tournament.AllowedSets),
                requiredHouses: this.parseJsonColumn(tournament.RequiredHouses),
                bannedHouses: this.parseJsonColumn(tournament.BannedHouses),
                sasChainHandicap: tournament.SasChainHandicap,
                chainsPerMatchWin: tournament.ChainsPerMatchWin,
                triad: tournament.Triad,
                pacing: tournament.Pacing,
                roundDeadlineDays: tournament.RoundDeadlineDays,
                // Every column the UPDATE below writes has to be seeded from
                // the row first: an organizer editing one field re-sends the
                // whole settings object, and anything missing here would be
                // parsed as "not set" and written back as null. A prize pool
                // silently emptied by a name change is the exact failure this
                // shape invites.
                entryFeeCents: tournament.EntryFeeCents,
                prizeCurrency: tournament.PrizeCurrency,
                prizeSplits: this.parseJsonColumn(tournament.PrizeSplits),
                prizeNote: tournament.PrizeNote,
                paymentInstructions: tournament.PaymentInstructions,
                requirePayment: tournament.RequirePayment,
                ...options
            };

            const { errors, values } = this.parseEventOptions(merged, config);

            if (errors.length > 0) {
                return { success: false, message: errors[0] };
            }

            let joinCode = tournament.JoinCode;
            if (values.visibility === 'private' && !joinCode) {
                joinCode = this.generateJoinCode();
            } else if (values.visibility === 'public') {
                joinCode = null;
            }

            await this.db.query(
                'UPDATE "Tournaments" SET "Name" = $2, "Description" = $3, "Format" = $4, ' +
                    '"GameFormat" = $5, "Mode" = $6, "RoundCount" = $7, "StartTime" = $8, ' +
                    '"PlayerCap" = $9, "BestOf" = $10, "PlayoffBestOf" = $11, "CutTo" = $12, ' +
                    '"SeedMethod" = $13, "Visibility" = $14, "JoinCode" = $15, ' +
                    '"RoundTimerMinutes" = $16, "RatedGames" = $17, ' +
                    '"RequireDeckRegistration" = $18, "SasMin" = $19, "SasMax" = $20, ' +
                    '"HideDecklists" = $21, "GameTimeLimit" = $22, "DeckSwapPolicy" = $23, ' +
                    '"AllowedSets" = $24, "RequiredHouses" = $25, "BannedHouses" = $26, ' +
                    '"SasChainHandicap" = $27, "ChainsPerMatchWin" = $28, "Triad" = $29, ' +
                    '"Pacing" = $30, "RoundDeadlineDays" = $31, "EntryFeeCents" = $32, ' +
                    '"PrizeCurrency" = $33, "PrizeSplits" = $34, "PrizeNote" = $35, ' +
                    '"PaymentInstructions" = $36, "RequirePayment" = $37 ' +
                    'WHERE "Id" = $1',
                [
                    tournamentId,
                    values.name,
                    values.description,
                    values.format,
                    values.gameFormat,
                    values.mode,
                    values.roundCount,
                    values.startTime,
                    values.playerCap,
                    values.bestOf,
                    values.playoffBestOf,
                    values.cutTo,
                    values.seedMethod,
                    values.visibility,
                    joinCode,
                    values.roundTimerMinutes,
                    values.ratedGames,
                    values.requireDeckRegistration,
                    values.sasMin,
                    values.sasMax,
                    values.hideDecklists,
                    values.gameTimeLimit,
                    values.deckSwapPolicy,
                    values.allowedSets ? JSON.stringify(values.allowedSets) : null,
                    values.requiredHouses ? JSON.stringify(values.requiredHouses) : null,
                    values.bannedHouses ? JSON.stringify(values.bannedHouses) : null,
                    values.sasChainHandicap,
                    values.chainsPerMatchWin,
                    values.triad,
                    values.pacing,
                    values.roundDeadlineDays,
                    values.entryFeeCents,
                    values.prizeCurrency,
                    values.prizeSplits ? JSON.stringify(values.prizeSplits) : null,
                    values.prizeNote,
                    values.paymentInstructions,
                    values.requirePayment
                ]
            );

            await this.promoteWaitlist(tournamentId);
        } else if (Object.prototype.hasOwnProperty.call(options, 'roundTimerMinutes')) {
            const timer = options.roundTimerMinutes
                ? parseInt(options.roundTimerMinutes, 10)
                : null;

            if (timer !== null && (Number.isNaN(timer) || timer < 5 || timer > 240)) {
                return { success: false, message: 'Round timer must be between 5 and 240 minutes' };
            }

            await this.db.query(
                'UPDATE "Tournaments" SET "RoundTimerMinutes" = $2 WHERE "Id" = $1',
                [tournamentId, timer]
            );
        }

        return { success: true };
    }

    async list(status, actor) {
        const params = [];
        const where = [];

        if (status) {
            params.push(status);
            where.push(`t."Status" = $${params.length}`);
        } else {
            // ARCHON: a cancelled event is not a listing, it is a tombstone.
            // Nobody can register for one or play in one, and they pile up at
            // the top of the page - a scene that tries a few configurations
            // before its first real event ends up with a browse list that is
            // mostly abandoned drafts. They stay reachable by their own URL,
            // and by asking for them explicitly with ?status=cancelled.
            where.push(`t."Status" <> 'cancelled'`);
        }

        if (actor) {
            const canSeeAll =
                !!actor.permissions?.canManageTournaments || !!actor.permissions?.isAdmin;

            // ARCHON: the parameter is bound ONLY when a placeholder uses it.
            //
            // This used to push actor.id unconditionally and then skip the
            // clause that referenced it for a site TO or admin - leaving a
            // bound value with nothing to bind to, which Postgres rejects
            // outright ("bind message supplies 1 parameters, but prepared
            // statement requires 0"). So every tournament listing threw for
            // exactly the people who can see every event, and for nobody else:
            // the site owner got an empty list and "create the first one!"
            // while their players saw the events perfectly well.
            if (!canSeeAll) {
                params.push(actor.id);
                const actorParam = `$${params.length}`;

                where.push(
                    `(t."Visibility" = 'public' OR t."OrganizerId" = ${actorParam} OR ` +
                        `EXISTS(SELECT 1 FROM "TournamentStaff" ts WHERE ts."TournamentId" = t."Id" AND ts."UserId" = ${actorParam}) OR ` +
                        `EXISTS(SELECT 1 FROM "TournamentPlayers" tpx WHERE tpx."TournamentId" = t."Id" AND tpx."UserId" = ${actorParam}))`
                );
            }
        } else {
            where.push(`t."Visibility" = 'public'`);
        }

        const rows = await this.db.query(
            'SELECT t."Id", t."Name", t."Format", t."GameFormat", t."Mode", t."Status", ' +
                't."CurrentRound", t."RoundCount", t."StartTime", t."PlayerCap", t."BestOf", ' +
                't."CutTo", t."Stage", t."Visibility", t."RatedGames", t."CreatedAt", ' +
                't."Pacing", t."RoundDeadlineDays", t."RoundEndsAt", ' +
                // ARCHON: the SAS band belongs in the listing. A player
                // scanning open events cannot otherwise tell which ones their
                // decks are eligible for - they find out by clicking in and
                // being refused at registration.
                't."SasMin", t."SasMax", ' +
                // ARCHON: the buy-in, for the same reason. Nobody should have
                // to open an event to find out it costs money to enter. The
                // split itself is not here - that is detail for the event page.
                't."EntryFeeCents", t."PrizeCurrency", ' +
                'u."Username" AS "Organizer", ' +
                '(SELECT COUNT(*) FROM "TournamentPlayers" tp WHERE tp."TournamentId" = t."Id" ' +
                'AND NOT tp."Waitlisted" AND tp."Dropped" IS NOT TRUE) AS "PlayerCount" ' +
                'FROM "Tournaments" t JOIN "Users" u ON u."Id" = t."OrganizerId" ' +
                `${
                    where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''
                } ORDER BY t."Id" DESC LIMIT 100`,
            params
        );

        return (rows || []).map((row) => ({
            id: row.Id,
            name: row.Name,
            format: row.Format,
            gameFormat: row.GameFormat,
            mode: row.Mode,
            status: row.Status,
            currentRound: row.CurrentRound,
            roundCount: row.RoundCount,
            startTime: row.StartTime,
            playerCap: row.PlayerCap,
            bestOf: row.BestOf,
            cutTo: row.CutTo,
            stage: row.Stage,
            visibility: row.Visibility,
            rated: row.RatedGames,
            pacing: row.Pacing || 'live',
            roundDeadlineDays: row.RoundDeadlineDays,
            roundEndsAt: row.RoundEndsAt,
            sasMin: row.SasMin,
            sasMax: row.SasMax,
            entryFeeCents: row.EntryFeeCents,
            prizeCurrency: row.PrizeCurrency || 'USD',
            organizer: row.Organizer,
            playerCount: parseInt(row.PlayerCount, 10)
        }));
    }

    /**
     * ARCHON (N14): every open tournament match this player owes, across all
     * their events.
     *
     * An async league is played over weeks, and a player in three of them has
     * no single page that answers "what do I owe anyone this week" - the event
     * pages each know a third of it. This is that page's data: one row per
     * open match, with the opponent, the agreed or offered time, and the
     * round's deadline, soonest deadline first.
     *
     * Live events are included too. A player mid-event there also benefits
     * from seeing it listed, and excluding them would make the panel lie by
     * omission the moment somebody joined a live event.
     */
    async myOpenMatches(actor) {
        if (!actor) {
            return [];
        }

        const rows = await this.db.query(
            'SELECT m."Id", m."Round", m."ScheduledAt", m."ProposedTime", m."ProposedBy", ' +
                'm."ScheduleNote", m."BestOf", m."Player1Id", m."Player2Id", ' +
                't."Id" AS "TournamentId", t."Name" AS "TournamentName", t."Pacing", ' +
                't."RoundEndsAt", t."Mode", ' +
                'CASE WHEN m."Player1Id" = $1 THEN u2."Username" ELSE u1."Username" END ' +
                'AS "OpponentName", ' +
                'CASE WHEN m."Player1Id" = $1 THEN m."Player2Id" ELSE m."Player1Id" END ' +
                'AS "OpponentId" ' +
                'FROM "TournamentMatches" m ' +
                'JOIN "Tournaments" t ON t."Id" = m."TournamentId" ' +
                'LEFT JOIN "Users" u1 ON u1."Id" = m."Player1Id" ' +
                'LEFT JOIN "Users" u2 ON u2."Id" = m."Player2Id" ' +
                'WHERE t."Status" = \'active\' AND m."Round" = t."CurrentRound" ' +
                'AND m."WinnerId" IS NULL AND m."ResultType" IS NULL ' +
                'AND m."Player1Id" IS NOT NULL AND m."Player2Id" IS NOT NULL ' +
                'AND ($1 IN (m."Player1Id", m."Player2Id")) ' +
                // Soonest deadline first; an event with no deadline sorts last
                // rather than jumping the queue on a NULL.
                'ORDER BY t."RoundEndsAt" ASC NULLS LAST, t."Id", m."Id"',
            [actor.id]
        );

        return (rows || []).map((row) => ({
            matchId: row.Id,
            tournamentId: row.TournamentId,
            tournamentName: row.TournamentName,
            pacing: row.Pacing || 'live',
            mode: row.Mode,
            round: row.Round,
            bestOf: row.BestOf,
            opponentId: row.OpponentId,
            opponent: row.OpponentName,
            scheduledAt: row.ScheduledAt,
            proposedTime: row.ProposedTime,
            proposedBy: row.ProposedBy,
            scheduleNote: row.ScheduleNote,
            roundEndsAt: row.RoundEndsAt,
            // What the player has to DO, decided here so every surface that
            // shows this list agrees about it.
            needsAction: row.ProposedTime
                ? row.ProposedBy === actor.id
                    ? 'waiting'
                    : 'respond'
                : row.ScheduledAt
                ? 'play'
                : 'propose'
        }));
    }

    async getTournamentRow(tournamentId) {
        const rows = await this.db.query('SELECT * FROM "Tournaments" WHERE "Id" = $1', [
            tournamentId
        ]);

        return rows && rows[0];
    }

    async getPlayers(tournamentId) {
        return await this.db.query(
            'SELECT tp."UserId", tp."Dropped", tp."Seed", tp."DeckId", tp."CheckedIn", ' +
                'tp."Waitlisted", tp."FinalRank", tp."EventChains", u."Username", ' +
                // ARCHON: the entry-payment register. PaidBy is joined for its
                // username because "who marked this paid" is the question that
                // actually gets asked when a player and an organizer disagree.
                'tp."PaidAt", tp."PaidBy", pb."Username" AS "PaidByUsername", ' +
                'd."Name" AS "DeckName", d."Uuid" AS "DeckUuid", ds."SasRating" ' +
                'FROM "TournamentPlayers" tp JOIN "Users" u ON u."Id" = tp."UserId" ' +
                'LEFT JOIN "Users" pb ON pb."Id" = tp."PaidBy" ' +
                'LEFT JOIN "Decks" d ON d."Id" = tp."DeckId" ' +
                'LEFT JOIN "DeckSas" ds ON ds."Uuid" = d."Uuid" ' +
                'WHERE tp."TournamentId" = $1 ORDER BY tp."Id"',
            [tournamentId]
        );
    }

    async getMatches(tournamentId) {
        return await this.db.query(
            'SELECT m."Id", m."Round", m."TableNumber", m."Player1Id", m."Player2Id", ' +
                'm."WinnerId", m."Bracket", m."BracketRound", m."BracketPos", ' +
                'm."P1SourceMatchId", m."P1SourceIsLoser", m."P2SourceMatchId", ' +
                'm."P2SourceIsLoser", m."Player1Wins", m."Player2Wins", m."BestOf", ' +
                'm."ResultType", m."P1BannedDeckId", m."P2BannedDeckId", m."P1DeckId", ' +
                // ARCHON (N9): AdaptiveState carries the in-progress chain bid,
                // and getMatchesNeedingGames needs it to seat the right decks.
                // getDetail maps matches field by field, so it does NOT reach
                // the client - if that mapping is ever changed to a spread,
                // the live bid becomes public to both players and spectators.
                'm."P2DeckId", m."AdaptiveState", m."ReportedBy", m."ConfirmedBy", ' +
                'm."ConfirmedAt", ' +
                'm."DisputedBy", m."DisputeNote", ' +
                'm."ScheduledAt", m."ProposedTime", m."ProposedBy", m."ScheduleNote", ' +
                'u1."Username" AS "Player1", u2."Username" AS "Player2" ' +
                'FROM "TournamentMatches" m ' +
                'LEFT JOIN "Users" u1 ON u1."Id" = m."Player1Id" ' +
                'LEFT JOIN "Users" u2 ON u2."Id" = m."Player2Id" ' +
                'WHERE m."TournamentId" = $1 ORDER BY m."Round", m."Id"',
            [tournamentId]
        );
    }

    matchesForStandings(matches) {
        return matches
            .filter((match) => match.Player1Id)
            .map((match) => ({
                player1: match.Player1Id,
                player2: match.Player2Id,
                winner: match.WinnerId,
                round: match.Round,
                p1Wins: match.Player1Wins,
                p2Wins: match.Player2Wins,
                doubleLoss: match.ResultType === 'double-loss'
            }));
    }

    /**
     * Full detail payload for the tournament page: event, players,
     * matches grouped by round, live standings, staff, and the viewer's
     * own flags.
     */
    async getDetail(tournamentId, actor) {
        const tournament = await this.getTournamentRow(tournamentId);

        if (!tournament) {
            return { success: false, message: 'No such tournament' };
        }

        const [players, matches, organizerRows, staffRows, gameRows, triadPools, slotRows] =
            await Promise.all([
                this.getPlayers(tournamentId),
                this.getMatches(tournamentId),
                this.db.query('SELECT "Username" FROM "Users" WHERE "Id" = $1', [
                    tournament.OrganizerId
                ]),
                this.db.query(
                    'SELECT ts."UserId", ts."Role", u."Username" FROM "TournamentStaff" ts ' +
                        'JOIN "Users" u ON u."Id" = ts."UserId" WHERE ts."TournamentId" = $1 ORDER BY ts."Id"',
                    [tournamentId]
                ),
                this.db.query(
                    'SELECT "MatchId", "GameNumber", "GameUuid", "WinnerId" FROM "TournamentMatchGames" ' +
                        'WHERE "TournamentId" = $1 ORDER BY "MatchId", "GameNumber"',
                    [tournamentId]
                ),
                tournament.Triad ? this.getTriadPools(tournamentId) : Promise.resolve({}),
                // ARCHON: the live time offers for every match in one read.
                // Per-match would be a query per row of the pairings table.
                this.db.query(
                    'SELECT s."Id", s."MatchId", s."SlotTime", s."ProposedBy", s."ProposerZone", ' +
                        'u."Username" FROM "TournamentMatchTimeSlots" s ' +
                        'JOIN "Users" u ON u."Id" = s."ProposedBy" ' +
                        'JOIN "TournamentMatches" m ON m."Id" = s."MatchId" ' +
                        'WHERE m."TournamentId" = $1 ORDER BY s."SlotTime"',
                    [tournamentId]
                )
            ]);

        const slotsByMatch = {};

        for (const row of slotRows || []) {
            (slotsByMatch[row.MatchId] = slotsByMatch[row.MatchId] || []).push({
                id: row.Id,
                time: row.SlotTime,
                proposedById: row.ProposedBy,
                proposedBy: row.Username,
                zone: row.ProposerZone || undefined
            });
        }

        const canManage = actor ? await this.canManage(actor, tournament) : false;

        // Amber ratings for the event's pool, for pairing/standings display.
        const ratingById = {};
        if (players.length > 0) {
            const ratingRows = await this.db.query(
                'SELECT "UserId", "Rating" FROM "Ratings" WHERE "Pool" = $1 AND "UserId" = ANY($2)',
                [tournament.GameFormat || 'archon', players.map((player) => player.UserId)]
            );

            for (const row of ratingRows || []) {
                ratingById[row.UserId] = row.Rating;
            }
        }

        const usernames = {};
        for (const player of players) {
            usernames[player.UserId] = player.Username;
        }

        const competitors = players.filter((player) => !player.Waitlisted);

        const standings = computeStandings(
            competitors.map((player) => ({ id: player.UserId })),
            this.matchesForStandings(matches)
        ).map((entry) => {
            const player = players.find((row) => row.UserId === entry.id);

            return {
                ...entry,
                username: usernames[entry.id],
                dropped: player?.Dropped || false,
                finalRank: player?.FinalRank || null
            };
        });

        if (tournament.Status === 'complete') {
            standings.sort((a, b) => {
                const rankA = a.finalRank || Number.MAX_SAFE_INTEGER;
                const rankB = b.finalRank || Number.MAX_SAFE_INTEGER;

                return rankA - rankB || a.rank - b.rank;
            });
        }

        const gamesByMatch = {};
        for (const row of gameRows || []) {
            (gamesByMatch[row.MatchId] = gamesByMatch[row.MatchId] || []).push({
                gameNumber: row.GameNumber,
                gameId: row.GameUuid,
                winnerId: row.WinnerId
            });
        }

        const showDeck = (player) =>
            !tournament.HideDecklists || canManage || (actor && actor.id === player.UserId);

        const myRow = actor ? players.find((player) => player.UserId === actor.id) : null;

        return {
            success: true,
            tournament: {
                id: tournament.Id,
                name: tournament.Name,
                description: tournament.Description,
                announcement: tournament.Announcement,
                format: tournament.Format,
                gameFormat: tournament.GameFormat,
                mode: tournament.Mode,
                status: tournament.Status,
                stage: tournament.Stage || 'main',
                currentRound: tournament.CurrentRound,
                roundCount: tournament.RoundCount,
                startTime: tournament.StartTime,
                playerCap: tournament.PlayerCap,
                bestOf: tournament.BestOf || 1,
                playoffBestOf: tournament.PlayoffBestOf,
                cutTo: tournament.CutTo,
                seedMethod: tournament.SeedMethod || 'registration',
                visibility: tournament.Visibility || 'public',
                joinCode: canManage ? tournament.JoinCode : undefined,
                roundTimerMinutes: tournament.RoundTimerMinutes,
                roundStartedAt: tournament.RoundStartedAt,
                // The authoritative deadline, so an extension the organizer
                // granted is the same number on every screen rather than each
                // client re-deriving it from the round's start.
                roundEndsAt: tournament.RoundEndsAt,
                // ARCHON (N14): async pacing - deadlines in days, matches
                // scheduled between the players.
                pacing: tournament.Pacing || 'live',
                roundDeadlineDays: tournament.RoundDeadlineDays,
                checkInOpen: !!tournament.CheckInOpenedAt,
                // ARCHON (N9): the kiosk code is the organizer's to print.
                checkInCode: canManage ? tournament.CheckInCode : undefined,
                allowPaperResults: !!tournament.AllowPaperResults,
                adaptiveBo3: !!tournament.AdaptiveBo3,
                alliancePolicy: this.parseJsonColumn(tournament.AlliancePolicy),
                // ARCHON (N7): team events.
                teamEvent: !!tournament.TeamEvent,
                teamSize: tournament.TeamSize,
                rated: !!tournament.RatedGames,
                requireDeckRegistration: !!tournament.RequireDeckRegistration,
                sasMin: tournament.SasMin,
                sasMax: tournament.SasMax,
                hideDecklists: !!tournament.HideDecklists,
                gameTimeLimit: tournament.GameTimeLimit,
                deckSwapPolicy: tournament.DeckSwapPolicy || 'locked',
                allowedSets: this.parseJsonColumn(tournament.AllowedSets),
                requiredHouses: this.parseJsonColumn(tournament.RequiredHouses),
                bannedHouses: this.parseJsonColumn(tournament.BannedHouses),
                sasChainHandicap: !!tournament.SasChainHandicap,
                chainsPerMatchWin: tournament.ChainsPerMatchWin || 0,
                triad: !!tournament.Triad,
                // ARCHON: the announced buy-in and split. The platform records
                // these and nothing else - it never holds or moves the money,
                // and the page says so where players can see it.
                entryFeeCents: tournament.EntryFeeCents,
                prizeCurrency: tournament.PrizeCurrency || 'USD',
                prizeSplits: this.parseJsonColumn(tournament.PrizeSplits),
                prizeNote: tournament.PrizeNote,
                paymentInstructions: tournament.PaymentInstructions,
                requirePayment: !!tournament.RequirePayment,
                organizer: organizerRows[0]?.Username,
                canManage,
                isOrganizer: actor ? actor.id === tournament.OrganizerId : false,
                isRegistered: !!(myRow && !myRow.Dropped),
                isWaitlisted: !!(myRow && myRow.Waitlisted && !myRow.Dropped),
                isCheckedIn: !!(myRow && myRow.CheckedIn),
                myDeckId: myRow?.DeckId || null,
                // ARCHON: may this player change their deck right now? The
                // page asks rather than guessing, because "between rounds"
                // is a window that opens and shuts as the event runs, and a
                // button that is refused when clicked is worse than no
                // button. Triad pools have their own ban/pick flow.
                canSwapDeck: !!(
                    myRow &&
                    !myRow.Dropped &&
                    !tournament.Triad &&
                    (tournament.Status === 'registration' ||
                        (tournament.Status === 'active' &&
                            tournament.DeckSwapPolicy === 'between-rounds' &&
                            !this.isRoundUnderwayFor(tournament, myRow.UserId, matches, gameRows)))
                )
            },
            staff: (staffRows || []).map((row) => ({
                userId: row.UserId,
                username: row.Username,
                role: row.Role
            })),
            players: players.map((player) => ({
                userId: player.UserId,
                username: player.Username,
                dropped: player.Dropped,
                seed: player.Seed,
                checkedIn: player.CheckedIn,
                waitlisted: player.Waitlisted,
                finalRank: player.FinalRank,
                // Only where there is a fee: a "paid" column on a free event
                // is a column of meaningless ticks.
                paid: tournament.EntryFeeCents ? !!player.PaidAt : undefined,
                paidAt: tournament.EntryFeeCents ? player.PaidAt : undefined,
                paidBy: tournament.EntryFeeCents ? player.PaidByUsername || undefined : undefined,
                amber: ratingById[player.UserId] ?? null,
                eventChains: player.EventChains || 0,
                deckId: showDeck(player) ? player.DeckId : undefined,
                deckName: showDeck(player) ? player.DeckName : undefined,
                hasDeck: tournament.Triad
                    ? (triadPools[player.UserId] || []).length === TRIAD_DECKS
                    : !!player.DeckId,
                deckSas: showDeck(player) ? player.SasRating : undefined,
                // Triad pools are open information - opponents ban from them.
                triadDecks: tournament.Triad ? triadPools[player.UserId] || [] : undefined
            })),
            matches: matches.map((match) => ({
                id: match.Id,
                round: match.Round,
                table: match.TableNumber,
                bracket: match.Bracket,
                bracketRound: match.BracketRound,
                bracketPos: match.BracketPos,
                player1Id: match.Player1Id,
                player2Id: match.Player2Id,
                player1: match.Player1,
                player2: match.Player2,
                winnerId: match.WinnerId,
                player1Wins: match.Player1Wins,
                player2Wins: match.Player2Wins,
                bestOf: match.BestOf || 1,
                resultType: match.ResultType,
                p1SourceMatchId: match.P1SourceMatchId,
                p1SourceIsLoser: match.P1SourceIsLoser,
                p2SourceMatchId: match.P2SourceMatchId,
                p2SourceIsLoser: match.P2SourceIsLoser,
                p1BannedDeckId: match.P1BannedDeckId,
                p2BannedDeckId: match.P2BannedDeckId,
                p1DeckId: match.P1DeckId,
                p2DeckId: match.P2DeckId,
                reportedBy: match.ReportedBy,
                // A decided match with confirmed false is one player's
                // account of it; the opponent has been asked and has not
                // answered yet.
                confirmed: !!match.ConfirmedAt,
                disputedBy: match.DisputedBy,
                disputeNote: match.DisputeNote,
                // ARCHON (N14): when the players have arranged (or one has
                // offered) to play. Open information - the schedule is how
                // spectators know when to show up too.
                scheduledAt: match.ScheduledAt,
                proposedTime: match.ProposedTime,
                // ARCHON: every time currently on the table, so a player can
                // pick one rather than wait a round trip per candidate.
                timeSlots: slotsByMatch[match.Id] || [],
                proposedBy: match.ProposedBy,
                scheduleNote: match.ScheduleNote,
                games: gamesByMatch[match.Id] || []
            })),
            standings
        };
    }

    async register(tournamentId, actor, options = {}) {
        const tournament = await this.getTournamentRow(tournamentId);

        if (!tournament) {
            return { success: false, message: 'No such tournament' };
        }

        // Whose entry this is. Normally the caller's own; for a late entry an
        // organizer names the player - by username, because that is what an
        // organizer standing at a desk knows. Nobody signs anybody else up for
        // an event without running it - during the registration window either.
        let entrantId = options.userId ? Number(options.userId) : actor.id;

        if (options.username && !options.userId) {
            const named = await this.db.query('SELECT "Id" FROM "Users" WHERE "Username" = $1', [
                (options.username || '').trim()
            ]);

            if (!named || named.length === 0) {
                return { success: false, message: 'No such user' };
            }

            entrantId = named[0].Id;
        }

        if (entrantId !== actor.id && !(await this.canManage(actor, tournament))) {
            return { success: false, message: 'Only the organizer can register another player' };
        }

        // ARCHON: late registration, at the organizer's discretion.
        //
        // A player who turns up at round two of a five-round event is normal
        // at a local scene - the shop was busy, the bus was late - and there
        // was no way to admit them at all: registration closed at start, full
        // stop, and the only workaround was to cancel the event and rebuild
        // it. Swiss pairs on record, so a late entrant simply starts on zero
        // and is paired from there.
        //
        // Only the organizer, and only into an event still running: this is a
        // judge admitting somebody, never a player letting themselves in after
        // seeing the field.
        const lateEntry = tournament.Status === 'active';

        if (lateEntry) {
            if (!(await this.canManage(actor, tournament))) {
                return { success: false, message: 'Registration is closed' };
            }

            if (!options.userId && !options.username) {
                return {
                    success: false,
                    message: 'Registration is closed - add the player from the roster instead'
                };
            }
        } else if (tournament.Status !== 'registration') {
            return { success: false, message: 'Registration is closed' };
        }

        if (tournament.Visibility === 'private') {
            const canManage = await this.canManage(actor, tournament);
            const provided = this.normalizeJoinCode(options.joinCode);

            if (!canManage && provided !== tournament.JoinCode) {
                return { success: false, message: 'This event is private - enter its join code' };
            }
        }

        if (options.deckId) {
            const deckCheck = await this.validateDeck(tournament, entrantId, options.deckId);

            if (!deckCheck.success) {
                return deckCheck;
            }
        }

        // ARCHON (N7): a team event is entered under a team. Players still
        // register and play individually - what makes it a team event is that
        // their results roll up to the roster they entered under.
        let teamId = null;

        if (tournament.TeamEvent) {
            teamId = parseInt(options.teamId, 10);

            if (!Number.isInteger(teamId)) {
                return { success: false, message: 'This is a team event - choose your team' };
            }

            const membership = await this.db.query(
                'SELECT 1 FROM "TeamMembers" WHERE "TeamId" = $1 AND "UserId" = $2',
                [teamId, entrantId]
            );

            if (!membership || membership.length === 0) {
                return { success: false, message: 'You are not on that team' };
            }

            if (tournament.TeamSize) {
                const roster = await this.db.query(
                    'SELECT COUNT(*) AS "Count" FROM "TournamentPlayers" ' +
                        'WHERE "TournamentId" = $1 AND "TeamId" = $2 AND "UserId" <> $3 ' +
                        'AND NOT "Dropped"',
                    [tournamentId, teamId, entrantId]
                );

                if (parseInt(roster[0].Count, 10) >= tournament.TeamSize) {
                    return {
                        success: false,
                        message: `That team has already entered ${tournament.TeamSize} player(s)`
                    };
                }
            }
        }

        let waitlisted = false;

        if (tournament.PlayerCap) {
            const rows = await this.db.query(
                'SELECT COUNT(*) AS "Count" FROM "TournamentPlayers" ' +
                    'WHERE "TournamentId" = $1 AND NOT "Waitlisted" AND "UserId" <> $2',
                [tournamentId, entrantId]
            );

            waitlisted = parseInt(rows[0].Count, 10) >= tournament.PlayerCap;
        }

        await this.db.query(
            'INSERT INTO "TournamentPlayers" ("TournamentId", "UserId", "Waitlisted", "DeckId", "TeamId", "CreatedAt") ' +
                "VALUES ($1, $2, $3, $4, $5, now() AT TIME ZONE 'utc') " +
                'ON CONFLICT ("TournamentId", "UserId") DO UPDATE SET "Dropped" = false, ' +
                '"DeckId" = COALESCE(EXCLUDED."DeckId", "TournamentPlayers"."DeckId"), ' +
                '"TeamId" = COALESCE(EXCLUDED."TeamId", "TournamentPlayers"."TeamId")',
            [tournamentId, entrantId, waitlisted, options.deckId || null, teamId]
        );

        return { success: true, waitlisted };
    }

    /**
     * ARCHON (N9): Alliance pod legality for one event.
     *
     * Every rule here is about provenance - which physical decks the three
     * pods came from - which is why Decks.AlliancePods had to start being
     * recorded (migration 46). A deck built before that has no pod record and
     * cannot be checked; an event with requirePodProvenance says so out loud
     * rather than letting it through as though it had passed.
     */
    async validateAlliancePods(tournament, userId, deck) {
        const policy = this.parseJsonColumn(tournament.AlliancePolicy);

        if (!policy) {
            return { success: true };
        }

        const pods = this.parseJsonColumn(deck.AlliancePods);

        if (!pods || pods.length === 0) {
            if (policy.requirePodProvenance) {
                return {
                    success: false,
                    message:
                        `'${deck.Name}' was built before pod sources were recorded, and this ` +
                        'event checks them. Rebuild the Alliance deck to register it.'
                };
            }

            return { success: true };
        }

        if (policy.bannedPodHouses) {
            const hit = pods.find((pod) =>
                policy.bannedPodHouses.includes(String(pod.house || '').toLowerCase())
            );

            if (hit) {
                return { success: false, message: `This event bans ${hit.house} pods` };
            }
        }

        if (policy.maxPodsPerSourceDeck) {
            const counts = new Map();

            for (const pod of pods) {
                const key = pod.deckUuid;
                counts.set(key, (counts.get(key) || 0) + 1);
            }

            const over = Array.from(counts.values()).some(
                (count) => count > policy.maxPodsPerSourceDeck
            );

            if (over) {
                return {
                    success: false,
                    message:
                        `This event allows at most ${policy.maxPodsPerSourceDeck} pod(s) ` +
                        'from any one deck'
                };
            }
        }

        const sourceUuids = Array.from(new Set(pods.map((pod) => pod.deckUuid).filter(Boolean)));

        if (policy.allowedPodSets && sourceUuids.length > 0) {
            const sources = await this.db.query(
                'SELECT "Uuid", "ExpansionId" FROM "Decks" WHERE "Uuid" = ANY($1)',
                [sourceUuids]
            );

            const offending = (sources || []).find(
                (source) => !policy.allowedPodSets.includes(source.ExpansionId)
            );

            if (offending) {
                return {
                    success: false,
                    message: 'A pod comes from a set this event does not allow'
                };
            }
        }

        if (policy.exclusiveSourceDecks && sourceUuids.length > 0) {
            // The same physical Archon cannot sit behind two players' Alliance
            // decks - at a paper event there is only one copy on the table.
            const clash = await this.db.query(
                'SELECT d."Name" FROM "TournamentPlayers" tp ' +
                    'JOIN "Decks" d ON d."Id" = tp."DeckId" ' +
                    'WHERE tp."TournamentId" = $1 AND tp."UserId" <> $2 ' +
                    'AND d."AlliancePods" IS NOT NULL ' +
                    'AND EXISTS (SELECT 1 FROM jsonb_array_elements(d."AlliancePods") pod ' +
                    "WHERE pod->>'deckUuid' = ANY($3)) LIMIT 1",
                [tournament.Id, userId, sourceUuids]
            );

            if (clash && clash.length > 0) {
                return {
                    success: false,
                    message: 'Another player already sourced a pod from one of those decks'
                };
            }
        }

        return { success: true };
    }

    async validateDeck(tournament, userId, deckId) {
        const rows = await this.db.query(
            'SELECT d."Id", d."UserId", d."Name", d."Uuid", d."ExpansionId", d."IsAlliance", ' +
                'd."AlliancePods", ds."SasRating", ' +
                // The SET CODE, not the row id - see the set legality check below.
                'e."ExpansionId" AS "SetCode", ' +
                '(SELECT json_agg(h."Code") FROM "DeckHouses" dh ' +
                'JOIN "Houses" h ON h."Id" = dh."HouseId" WHERE dh."DeckId" = d."Id") AS "Houses" ' +
                'FROM "Decks" d ' +
                'JOIN "Expansions" e ON e."Id" = d."ExpansionId" ' +
                'LEFT JOIN "DeckSas" ds ON ds."Uuid" = d."Uuid" WHERE d."Id" = $1',
            [deckId]
        );
        const deck = rows && rows[0];

        if (!deck || deck.UserId !== userId) {
            return { success: false, message: 'That deck is not in your collection' };
        }

        // ARCHON (N9): an Alliance event needs an Alliance deck, and a
        // constructed event does not want one. Checked before the pod rules
        // so the message names the actual problem.
        if (tournament.GameFormat === 'alliance' && !deck.IsAlliance) {
            return {
                success: false,
                message: 'This is an Alliance event - register an Alliance deck'
            };
        }

        if (tournament.GameFormat !== 'alliance' && deck.IsAlliance && tournament.GameFormat) {
            return {
                success: false,
                message: 'Alliance decks can only be registered for Alliance events'
            };
        }

        if (deck.IsAlliance) {
            const podCheck = await this.validateAlliancePods(tournament, userId, deck);

            if (!podCheck.success) {
                return podCheck;
            }
        }

        /**
         * Set legality: the deck's expansion must be on the allow list.
         *
         * AllowedSets holds SET CODES - 341, 800 - because that is what the
         * organiser checked in the event form, which is built from the client's
         * expansion constants. `Decks."ExpansionId"` is something else entirely:
         * a foreign key into `Expansions."Id"`, which counts 1, 2, 3.
         *
         * Comparing those two raises no error. It is simply never equal, so
         * every deck registered for a set-restricted event was rejected with a
         * message saying its set was not allowed - including decks from sets
         * that were. Hence "SetCode" in the query above.
         */
        const allowedSets = this.parseJsonColumn(tournament.AllowedSets);

        if (
            allowedSets &&
            allowedSets.length > 0 &&
            !allowedSets.map(Number).includes(Number(deck.SetCode))
        ) {
            return {
                success: false,
                message: 'That deck is from a set this event does not allow'
            };
        }

        // House conditions - only KeyForge has fixed three-house decks.
        const deckHouses = (this.parseJsonColumn(deck.Houses) || []).map((code) =>
            String(code).toLowerCase()
        );
        const requiredHouses = this.parseJsonColumn(tournament.RequiredHouses);
        const bannedHouses = this.parseJsonColumn(tournament.BannedHouses);

        if (requiredHouses && requiredHouses.some((code) => !deckHouses.includes(code))) {
            return {
                success: false,
                message: `This event requires decks with ${requiredHouses.join(', ')}`
            };
        }

        if (bannedHouses) {
            const hit = bannedHouses.find((code) => deckHouses.includes(code));

            if (hit) {
                return {
                    success: false,
                    message: `This event bans house ${hit}`
                };
            }
        }

        // Every KeyForge deck is a unique physical object: the same
        // Archon cannot be registered twice in one event, even from
        // two different collections.
        const singleClash = await this.db.query(
            'SELECT 1 FROM "TournamentPlayers" tp JOIN "Decks" du ON du."Id" = tp."DeckId" ' +
                'WHERE tp."TournamentId" = $1 AND tp."UserId" <> $2 AND du."Uuid" = $3 LIMIT 1',
            [tournament.Id, userId, deck.Uuid]
        );
        const poolClash = await this.db.query(
            'SELECT 1 FROM "TournamentPlayerDecks" tpd JOIN "Decks" du2 ON du2."Id" = tpd."DeckId" ' +
                'WHERE tpd."TournamentId" = $1 AND tpd."UserId" <> $2 AND du2."Uuid" = $3 LIMIT 1',
            [tournament.Id, userId, deck.Uuid]
        );

        if ((singleClash && singleClash.length > 0) || (poolClash && poolClash.length > 0)) {
            return {
                success: false,
                message: 'Another player already registered that exact Archon deck'
            };
        }

        if (tournament.SasMin !== null && tournament.SasMin !== undefined) {
            if (deck.SasRating === null || deck.SasRating === undefined) {
                return {
                    success: false,
                    message: 'This event restricts SAS and that deck has no SAS rating yet'
                };
            }

            if (deck.SasRating < tournament.SasMin) {
                return {
                    success: false,
                    message: `Deck SAS ${deck.SasRating} is below the event minimum of ${tournament.SasMin}`
                };
            }
        }

        if (tournament.SasMax !== null && tournament.SasMax !== undefined) {
            if (deck.SasRating === null || deck.SasRating === undefined) {
                return {
                    success: false,
                    message: 'This event restricts SAS and that deck has no SAS rating yet'
                };
            }

            if (deck.SasRating > tournament.SasMax) {
                return {
                    success: false,
                    message: `Deck SAS ${deck.SasRating} is above the event maximum of ${tournament.SasMax}`
                };
            }
        }

        return { success: true, deck };
    }

    /**
     * ARCHON: has this player's pairing for the round now running already
     * begun?
     *
     * This is the line a 'between-rounds' swap must not cross. "Between
     * rounds" has to mean something precise or it means nothing: without
     * this, an event that merely allows a swap allowed one at any moment
     * while it was active - including between game two and game three of a
     * best-of-three, which is not a deck swap, it is a different match.
     *
     * The moment chosen is the first game hitting the table rather than the
     * pairing being published, so a player who sees their round-three
     * opponent still has until they actually sit down. That matters most in
     * asynchronous events, where the pairing may go up days before anyone
     * plays it.
     */
    async roundUnderwayFor(tournament, userId) {
        const matches = await this.getMatches(tournament.Id);
        const gameRows = await this.db.query(
            'SELECT "MatchId", "GameNumber", "GameUuid", "WinnerId" FROM "TournamentMatchGames" ' +
                'WHERE "TournamentId" = $1 ORDER BY "MatchId", "GameNumber"',
            [tournament.Id]
        );

        return this.isRoundUnderwayFor(tournament, userId, matches, gameRows);
    }

    /**
     * The rule itself, over rows already in hand - getDetail has both lists
     * loaded and reports the same answer to the player as `canSwapDeck`, so
     * the page never offers a swap the service is about to refuse.
     */
    isRoundUnderwayFor(tournament, userId, matches, gameRows) {
        const open = (matches || []).filter(
            (match) =>
                match.Round === tournament.CurrentRound &&
                !match.WinnerId &&
                !match.ResultType &&
                (match.Player1Id === userId || match.Player2Id === userId)
        );

        if (open.length === 0) {
            // Nothing outstanding this round: they are genuinely between
            // rounds, which is the whole window the policy grants.
            return false;
        }

        const started = new Set((gameRows || []).map((row) => row.MatchId));

        return open.some((match) => started.has(match.Id));
    }

    /**
     * ARCHON: the live events these decks are committed to.
     *
     * TournamentPlayers."DeckId" is ON DELETE SET NULL and
     * TournamentPlayerDecks."DeckId" is ON DELETE CASCADE, so deleting a
     * registered deck does not fail - it silently unpins the player. And a
     * null pin is not "a locked seat whose deck went missing", it is an
     * UNPINNED seat: Lobby.tournamentDeckFor reads null as "this event pins
     * nothing", the table's deck picker goes live again, and none of
     * validateDeck's event rules are applied to whatever gets chosen. So
     * deleting a deck was a way through the deck lock, and an accidental one
     * at that - the player cannot even put it back, because registerDeck
     * refuses a change once a locked event is under way.
     *
     * Dropped players are excluded on purpose: withdrawing from the event is
     * the player's own way to release a deck they want rid of.
     */
    async findLiveEventDeckCommitments(userId, deckIds) {
        const ids = (deckIds || []).map((id) => Number(id)).filter((id) => !Number.isNaN(id));

        if (ids.length === 0) {
            return [];
        }

        const rows = await this.db.query(
            'SELECT tp."DeckId", t."Id" AS "TournamentId", t."Name" AS "TournamentName" ' +
                'FROM "TournamentPlayers" tp ' +
                'JOIN "Tournaments" t ON t."Id" = tp."TournamentId" ' +
                'WHERE tp."UserId" = $1 AND tp."DeckId" = ANY($2) AND NOT tp."Dropped" ' +
                "AND t.\"Status\" IN ('registration', 'active') " +
                'UNION ' +
                'SELECT tpd."DeckId", t2."Id", t2."Name" ' +
                'FROM "TournamentPlayerDecks" tpd ' +
                'JOIN "Tournaments" t2 ON t2."Id" = tpd."TournamentId" ' +
                'WHERE tpd."UserId" = $1 AND tpd."DeckId" = ANY($2) ' +
                "AND t2.\"Status\" IN ('registration', 'active')",
            [userId, ids]
        );

        return (rows || []).map((row) => ({
            deckId: row.DeckId,
            tournamentId: row.TournamentId,
            tournamentName: row.TournamentName
        }));
    }

    /**
     * Register or change the deck a player will pilot. Open through the
     * registration window; after that it is the event's DeckSwapPolicy that
     * decides - 'locked' freezes the deck for the whole run (the Archon
     * standard), 'between-rounds' lets a player bring a different one to
     * their next pairing but never mid-match.
     *
     * Whatever this records is what the table will hand the player: the
     * lobby pins the seat to it (see Lobby.tournamentDeckFor), so the
     * pre-game deck picker cannot be used to get around the policy.
     */
    async registerDeck(tournamentId, actor, deckId, targetUserId = null) {
        const tournament = await this.getTournamentRow(tournamentId);

        if (!tournament) {
            return { success: false, message: 'No such tournament' };
        }

        if (tournament.Triad) {
            return { success: false, message: 'This event uses three-deck Triad pools' };
        }

        // ARCHON: the organizer changing somebody's deck.
        //
        // The refusal a locked event gives a player tells them to ask the
        // organizer - and the organizer had no way to do anything about it.
        // A judge ruling on a deck (it was registered wrong, it turned out to
        // be illegal, the physical deck is not the one on the sheet) is
        // adjudication, and it is the same authority they already have over a
        // recorded result. The policy gates below apply to a player acting on
        // their own seat, never to a judge.
        const target = targetUserId ? Number(targetUserId) : actor.id;
        const asManager = target !== actor.id;

        if (asManager && !(await this.canManage(actor, tournament))) {
            return {
                success: false,
                message: "Only the organizer can change another player's deck"
            };
        }

        const playerRows = await this.db.query(
            'SELECT * FROM "TournamentPlayers" WHERE "TournamentId" = $1 AND "UserId" = $2',
            [tournamentId, target]
        );

        if (!playerRows || playerRows.length === 0 || playerRows[0].Dropped) {
            return { success: false, message: 'Register for the event first' };
        }

        // Deck swap policy: 'locked' events freeze decks at start (the
        // Archon standard); 'between-rounds' events let players bring a
        // different deck to their next pairing.
        const swapAllowed =
            tournament.Status === 'active' && tournament.DeckSwapPolicy === 'between-rounds';

        // ARCHON: there is deliberately no "they have no deck yet" exception.
        // It looks humane and it is a hole: in a locked event a player could
        // withhold their deck, read the pairings, and only then choose. A late
        // entrant sets their deck on the way in - register already takes one.
        //
        // A deck a JUDGE released is different, and is recorded as such
        // (DeckReleasedAt) precisely because "released" and "never registered"
        // both look like a null DeckId otherwise. The permission is spent by
        // the registration it was granted for.
        const released = !playerRows[0].DeckId && !!playerRows[0].DeckReleasedAt;

        if (!asManager && !released) {
            if (tournament.Status !== 'registration' && !swapAllowed) {
                return {
                    success: false,
                    message: 'This event locks you to one deck - decks were frozen when it started'
                };
            }

            if (swapAllowed && (await this.roundUnderwayFor(tournament, target))) {
                return {
                    success: false,
                    message:
                        'Your match for this round has already started. You can change deck once it is finished.'
                };
            }
        }

        // Whose deck is being set, for the lobby's re-pin - which is keyed by
        // username. A judge acting on somebody else's seat must re-pin THAT
        // seat, not their own, and the player row is a raw TournamentPlayers
        // select with no username on it.
        let subject = { id: actor.id, username: actor.username };

        if (asManager) {
            const userRows = await this.db.query('SELECT "Username" FROM "Users" WHERE "Id" = $1', [
                target
            ]);

            subject = { id: target, username: userRows?.[0]?.Username };
        }

        if (!deckId) {
            // A judge clearing somebody's deck is a release: it grants that
            // player one registration back. A player clearing their own is
            // not, or the lock would be trivially reopenable.
            await this.db.query(
                'UPDATE "TournamentPlayers" SET "DeckId" = NULL, "DeckReleasedAt" = ' +
                    (asManager ? "now() AT TIME ZONE 'utc'" : '"DeckReleasedAt"') +
                    ' WHERE "TournamentId" = $1 AND "UserId" = $2',
                [tournamentId, target]
            );
            this.emitDeckRegistered(tournamentId, subject, null);

            return { success: true };
        }

        const deckCheck = await this.validateDeck(tournament, target, deckId);

        if (!deckCheck.success) {
            return deckCheck;
        }

        await this.db.query(
            'UPDATE "TournamentPlayers" SET "DeckId" = $3, "DeckReleasedAt" = NULL ' +
                'WHERE "TournamentId" = $1 AND "UserId" = $2',
            [tournamentId, target, deckId]
        );
        this.emitDeckRegistered(tournamentId, subject, deckId);

        return { success: true };
    }

    /**
     * ARCHON: tell the lobby a player's event deck changed.
     *
     * A table for the new round may already be open and waiting (async
     * events open theirs on demand, sometimes well before either player
     * arrives). It was built with the deck registered at the time, and the
     * seat is pinned to that - so without this, a legal between-rounds swap
     * would leave the player pinned to the deck they just replaced.
     */
    emitDeckRegistered(tournamentId, actor, deckId) {
        tournamentEvents.emit('deckRegistered', {
            tournamentId,
            userId: actor.id,
            username: actor.username,
            deckId: deckId || null
        });
    }

    /**
     * Register the three-deck pool for a Triad event (official
     * KeyForge format: opponents ban one of your three each match and
     * you pilot one of the remaining two). Pools lock at start.
     */
    async registerTriadDecks(tournamentId, actor, deckIds) {
        const tournament = await this.getTournamentRow(tournamentId);

        if (!tournament) {
            return { success: false, message: 'No such tournament' };
        }

        if (!tournament.Triad) {
            return { success: false, message: 'This event does not use Triad pools' };
        }

        if (tournament.Status !== 'registration') {
            return { success: false, message: 'Triad pools are locked once the event starts' };
        }

        const playerRows = await this.db.query(
            'SELECT * FROM "TournamentPlayers" WHERE "TournamentId" = $1 AND "UserId" = $2',
            [tournamentId, actor.id]
        );

        if (!playerRows || playerRows.length === 0 || playerRows[0].Dropped) {
            return { success: false, message: 'Register for the event first' };
        }

        if (!Array.isArray(deckIds) || deckIds.length !== TRIAD_DECKS) {
            return { success: false, message: 'Triad needs exactly three decks' };
        }

        const parsed = deckIds.map((id) => parseInt(id, 10));

        if (parsed.some((id) => Number.isNaN(id)) || new Set(parsed).size !== TRIAD_DECKS) {
            return { success: false, message: 'Pick three different decks' };
        }

        const validated = [];

        for (const deckId of parsed) {
            const check = await this.validateDeck(tournament, actor.id, deckId);

            if (!check.success) {
                return check;
            }

            validated.push(check.deck);
        }

        // The three decks must also be three distinct physical Archons.
        if (new Set(validated.map((deck) => deck.Uuid)).size !== TRIAD_DECKS) {
            return { success: false, message: 'Pick three different decks' };
        }

        await this.db.query(
            'DELETE FROM "TournamentPlayerDecks" WHERE "TournamentId" = $1 AND "UserId" = $2',
            [tournamentId, actor.id]
        );

        for (let slot = 0; slot < TRIAD_DECKS; slot++) {
            await this.db.query(
                'INSERT INTO "TournamentPlayerDecks" ("TournamentId", "UserId", "DeckId", "Slot", "CreatedAt") ' +
                    "VALUES ($1, $2, $3, $4, now() AT TIME ZONE 'utc')",
                [tournamentId, actor.id, parsed[slot], slot + 1]
            );
        }

        return { success: true };
    }

    /**
     * Triad pools with deck display data, keyed by user id.
     */
    async getTriadPools(tournamentId) {
        const rows = await this.db.query(
            'SELECT tpd."UserId", tpd."DeckId", tpd."Slot", d."Name" AS "DeckName", ' +
                'd."Uuid" AS "DeckUuid", ds."SasRating" ' +
                'FROM "TournamentPlayerDecks" tpd ' +
                'JOIN "Decks" d ON d."Id" = tpd."DeckId" ' +
                'LEFT JOIN "DeckSas" ds ON ds."Uuid" = d."Uuid" ' +
                'WHERE tpd."TournamentId" = $1 ORDER BY tpd."UserId", tpd."Slot"',
            [tournamentId]
        );

        const pools = {};

        for (const row of rows || []) {
            (pools[row.UserId] = pools[row.UserId] || []).push({
                deckId: row.DeckId,
                slot: row.Slot,
                deckName: row.DeckName,
                deckSas: row.SasRating
            });
        }

        return pools;
    }

    async openCheckIn(tournamentId, actor) {
        const tournament = await this.getTournamentRow(tournamentId);

        if (!tournament) {
            return { success: false, message: 'No such tournament' };
        }

        if (!(await this.canManage(actor, tournament))) {
            return { success: false, message: 'Only the organizer can open check-in' };
        }

        if (tournament.Status !== 'registration') {
            return { success: false, message: 'Check-in only applies before the event starts' };
        }

        // ARCHON (N9): mint the kiosk code when check-in opens, so the QR an
        // organizer prints is only live for the window it is meant for.
        // Deliberately not JoinCode: that one grants entry to a private event
        // and must not end up on a poster by the door.
        const checkInCode = tournament.CheckInCode || this.generateJoinCode();

        await this.db.query(
            'UPDATE "Tournaments" SET "CheckInOpenedAt" = now() AT TIME ZONE \'utc\', ' +
                '"CheckInCode" = $2 WHERE "Id" = $1',
            [tournamentId, checkInCode]
        );

        return { success: true, checkInCode };
    }

    /**
     * ARCHON: mark an entrant paid, or un-mark them.
     *
     * Staff only, and deliberately never the player themselves: a register
     * anybody can tick their own name on is not a register. The platform takes
     * no money and moves none - this records that a human took ten dollars from
     * another human, which is the only thing it can honestly claim to know.
     *
     * `PaidBy` outlives the tick. When a player says they paid and the sheet
     * says otherwise, "marked by which judge, and when" is the question that
     * settles it, and a boolean cannot answer it.
     */
    async setPaid(tournamentId, actor, targetUserId, paid) {
        const tournament = await this.getTournamentRow(tournamentId);

        if (!tournament) {
            return { success: false, message: 'No such tournament' };
        }

        if (!(await this.canManage(actor, tournament))) {
            return { success: false, message: 'Only the organizer or a judge can record payment' };
        }

        if (!tournament.EntryFeeCents) {
            return { success: false, message: 'This event has no entry fee' };
        }

        const userId = parseInt(targetUserId, 10);

        if (Number.isNaN(userId)) {
            return { success: false, message: 'No such player' };
        }

        const rows = await this.db.query(
            'UPDATE "TournamentPlayers" SET ' +
                (paid
                    ? '"PaidAt" = now() AT TIME ZONE \'utc\', "PaidBy" = $3 '
                    : '"PaidAt" = NULL, "PaidBy" = NULL ') +
                'WHERE "TournamentId" = $1 AND "UserId" = $2 RETURNING "UserId"',
            paid ? [tournamentId, userId, actor.id] : [tournamentId, userId]
        );

        if (!rows || rows.length === 0) {
            return { success: false, message: 'That player is not registered for this event' };
        }

        return { success: true, paid: !!paid };
    }

    async checkIn(tournamentId, actor, options = {}) {
        const tournament = await this.getTournamentRow(tournamentId);

        if (!tournament) {
            return { success: false, message: 'No such tournament' };
        }

        if (tournament.Status !== 'registration' || !tournament.CheckInOpenedAt) {
            return { success: false, message: 'Check-in is not open' };
        }

        // ARCHON: an organizer may check somebody else in.
        //
        // This only ever wrote actor.id, so the desk at an in-person event had
        // no way to mark a player present: the player had to own a phone, be
        // signed in, and find the event page themselves, and anyone who could
        // not was dropped as a no-show at start. A staffed desk is the normal
        // way a paper event runs, and the kiosk QR does not replace it -
        // between them they cover the player who scans and the player who
        // hands over a decklist and walks to their table.
        //
        // 'staff' rather than 'self' in CheckedInVia, so the audit trail still
        // distinguishes who did it.
        let targetId = actor.id;
        let via = options.via === 'kiosk' ? 'kiosk' : 'self';

        if (options.userId && Number(options.userId) !== actor.id) {
            if (!(await this.canManage(actor, tournament))) {
                return {
                    success: false,
                    message: 'Only the organizer can check another player in'
                };
            }

            targetId = Number(options.userId);
            via = 'staff';
        }

        const rows = await this.db.query(
            'UPDATE "TournamentPlayers" SET "CheckedIn" = true, ' +
                '"CheckedInAt" = now() AT TIME ZONE \'utc\', "CheckedInVia" = $3 ' +
                'WHERE "TournamentId" = $1 AND "UserId" = $2 AND NOT "Dropped" RETURNING "Id"',
            [tournamentId, targetId, via]
        );

        if (!rows || rows.length === 0) {
            return { success: false, message: 'Register for the event first' };
        }

        return { success: true };
    }

    /**
     * ARCHON (N9): kiosk check-in. A player scans the QR at the door, which
     * carries the check-in code, and lands here already signed in - so a
     * store can run the desk without a laptop per table, or even one at all.
     *
     * The code identifies the event, never the player: it marks whoever is
     * signed in as present, so a scanned code cannot check anyone else in.
     */
    async checkInByCode(code, actor) {
        const normalized = this.normalizeJoinCode(code);

        if (normalized.length < 4) {
            return { success: false, message: 'Invalid check-in code' };
        }

        const rows = await this.db.query(
            'SELECT "Id" FROM "Tournaments" WHERE "CheckInCode" = $1',
            [normalized]
        );

        if (!rows || rows.length === 0) {
            return { success: false, message: 'No event matches that check-in code' };
        }

        const result = await this.checkIn(rows[0].Id, actor, { via: 'kiosk' });

        return result.success ? { ...result, tournamentId: rows[0].Id } : result;
    }

    /**
     * Manual seed assignment (used with the 'manual' seeding method).
     */
    async setSeeds(tournamentId, actor, seeds) {
        const tournament = await this.getTournamentRow(tournamentId);

        if (!tournament) {
            return { success: false, message: 'No such tournament' };
        }

        if (!(await this.canManage(actor, tournament))) {
            return { success: false, message: 'Only the organizer can set seeds' };
        }

        if (tournament.Status !== 'registration') {
            return { success: false, message: 'Seeds are locked once the event starts' };
        }

        if (!Array.isArray(seeds)) {
            return { success: false, message: 'Seeds must be a list' };
        }

        for (const entry of seeds) {
            const userId = parseInt(entry.userId, 10);
            const seed = entry.seed === null ? null : parseInt(entry.seed, 10);

            if (Number.isNaN(userId) || (seed !== null && (Number.isNaN(seed) || seed < 1))) {
                continue;
            }

            await this.db.query(
                'UPDATE "TournamentPlayers" SET "Seed" = $3 WHERE "TournamentId" = $1 AND "UserId" = $2',
                [tournamentId, userId, seed]
            );
        }

        return { success: true };
    }

    async addStaff(tournamentId, actor, username) {
        const tournament = await this.getTournamentRow(tournamentId);

        if (!tournament) {
            return { success: false, message: 'No such tournament' };
        }

        const isOrganizer =
            actor.id === tournament.OrganizerId ||
            !!actor.permissions?.canManageTournaments ||
            !!actor.permissions?.isAdmin;

        if (!isOrganizer) {
            return { success: false, message: 'Only the organizer can manage staff' };
        }

        const rows = await this.db.query('SELECT "Id" FROM "Users" WHERE "Username" = $1', [
            (username || '').trim()
        ]);

        if (!rows || rows.length === 0) {
            return { success: false, message: 'No such user' };
        }

        if (rows[0].Id === tournament.OrganizerId) {
            return { success: false, message: 'The organizer already manages the event' };
        }

        await this.db.query(
            'INSERT INTO "TournamentStaff" ("TournamentId", "UserId", "CreatedAt") ' +
                "VALUES ($1, $2, now() AT TIME ZONE 'utc') " +
                'ON CONFLICT ("TournamentId", "UserId") DO NOTHING',
            [tournamentId, rows[0].Id]
        );

        return { success: true };
    }

    async removeStaff(tournamentId, actor, userId) {
        const tournament = await this.getTournamentRow(tournamentId);

        if (!tournament) {
            return { success: false, message: 'No such tournament' };
        }

        const isOrganizer =
            actor.id === tournament.OrganizerId ||
            !!actor.permissions?.canManageTournaments ||
            !!actor.permissions?.isAdmin;

        if (!isOrganizer) {
            return { success: false, message: 'Only the organizer can manage staff' };
        }

        await this.db.query(
            'DELETE FROM "TournamentStaff" WHERE "TournamentId" = $1 AND "UserId" = $2',
            [tournamentId, parseInt(userId, 10)]
        );

        return { success: true };
    }

    async promoteWaitlist(tournamentId) {
        const tournament = await this.getTournamentRow(tournamentId);

        if (!tournament || tournament.Status !== 'registration') {
            return;
        }

        if (!tournament.PlayerCap) {
            await this.db.query(
                'UPDATE "TournamentPlayers" SET "Waitlisted" = false WHERE "TournamentId" = $1 AND "Waitlisted"',
                [tournamentId]
            );

            return;
        }

        const rows = await this.db.query(
            'SELECT COUNT(*) AS "Count" FROM "TournamentPlayers" ' +
                'WHERE "TournamentId" = $1 AND NOT "Waitlisted"',
            [tournamentId]
        );

        let open = tournament.PlayerCap - parseInt(rows[0].Count, 10);

        while (open > 0) {
            const promoted = await this.db.query(
                'UPDATE "TournamentPlayers" SET "Waitlisted" = false WHERE "Id" = ' +
                    '(SELECT "Id" FROM "TournamentPlayers" WHERE "TournamentId" = $1 AND "Waitlisted" ' +
                    'AND NOT "Dropped" ORDER BY "Id" LIMIT 1) RETURNING "Id"',
                [tournamentId]
            );

            if (!promoted || promoted.length === 0) {
                break;
            }

            open--;
        }
    }

    async drop(tournamentId, targetUserId, actor) {
        const tournament = await this.getTournamentRow(tournamentId);

        if (!tournament) {
            return { success: false, message: 'No such tournament' };
        }

        const target = targetUserId || actor.id;

        if (target !== actor.id && !(await this.canManage(actor, tournament))) {
            return { success: false, message: 'Only the organizer can drop other players' };
        }

        if (tournament.Status === 'registration') {
            await this.db.query(
                'DELETE FROM "TournamentPlayers" WHERE "TournamentId" = $1 AND "UserId" = $2',
                [tournamentId, target]
            );

            await this.promoteWaitlist(tournamentId);
        } else {
            await this.db.query(
                'UPDATE "TournamentPlayers" SET "Dropped" = true WHERE "TournamentId" = $1 AND "UserId" = $2',
                [tournamentId, target]
            );

            if (tournament.Status === 'active') {
                await this.forfeitOpenMatches(tournament, target);
            }
        }

        return { success: true };
    }

    /**
     * When a player drops mid-event, any open match they are in becomes
     * a forfeit win for their opponent (bracket slots then propagate).
     */
    async forfeitOpenMatches(tournament, userId) {
        const matches = await this.getMatches(tournament.Id);

        const open = matches.filter(
            (match) =>
                !match.WinnerId &&
                !match.ResultType &&
                match.Player1Id &&
                match.Player2Id &&
                (match.Player1Id === userId || match.Player2Id === userId)
        );

        for (const match of open) {
            const winnerId = match.Player1Id === userId ? match.Player2Id : match.Player1Id;

            await this.completeMatch(tournament, match, {
                winnerId,
                resultType: 'forfeit',
                reporterId: null
            });
        }
    }

    /**
     * Seed the field per the event's seeding method. Returns players
     * best seed first, and persists the seed numbers for display.
     */
    async seedPlayers(tournament, players) {
        let ordered = [...players];

        if (tournament.SeedMethod === 'random') {
            for (let index = ordered.length - 1; index > 0; index--) {
                const swap = crypto.randomInt(index + 1);
                [ordered[index], ordered[swap]] = [ordered[swap], ordered[index]];
            }
        } else if (tournament.SeedMethod === 'rating') {
            const ids = ordered.map((player) => player.UserId);
            const rows = await this.db.query(
                'SELECT "UserId", "Rating" FROM "Ratings" WHERE "Pool" = $1 AND "UserId" = ANY($2)',
                [tournament.GameFormat || 'archon', ids]
            );

            const ratingById = {};
            for (const row of rows || []) {
                ratingById[row.UserId] = row.Rating;
            }

            ordered.sort((a, b) => (ratingById[b.UserId] || 0) - (ratingById[a.UserId] || 0));
        } else if (tournament.SeedMethod === 'manual') {
            ordered.sort(
                (a, b) => (a.Seed || Number.MAX_SAFE_INTEGER) - (b.Seed || Number.MAX_SAFE_INTEGER)
            );
        }
        // 'registration' keeps the registration order.

        for (let index = 0; index < ordered.length; index++) {
            await this.db.query(
                'UPDATE "TournamentPlayers" SET "Seed" = $3 WHERE "TournamentId" = $1 AND "UserId" = $2',
                [tournament.Id, ordered[index].UserId, index + 1]
            );
        }

        return ordered;
    }

    async insertRoundMatches(tournamentId, round, pairings, byes, bestOf = 1) {
        let table = 1;

        for (const [player1, player2] of pairings) {
            await this.db.query(
                'INSERT INTO "TournamentMatches" ("TournamentId", "Round", "TableNumber", "Player1Id", "Player2Id", "BestOf") ' +
                    'VALUES ($1, $2, $3, $4, $5, $6)',
                [tournamentId, round, table, player1, player2, bestOf]
            );
            table++;
        }

        for (const byePlayer of byes) {
            // A bye is stored as an auto-won match with no opponent
            await this.db.query(
                'INSERT INTO "TournamentMatches" ("TournamentId", "Round", "Player1Id", "WinnerId", "ResultType", "BestOf", "ReportedAt") ' +
                    "VALUES ($1, $2, $3, $3, 'bye', $4, now() AT TIME ZONE 'utc')",
                [tournamentId, round, byePlayer, bestOf]
            );
        }
    }

    /**
     * Persist a bracket template from pairing.js, translating template
     * keys into database ids for the source references. roundOffset
     * shifts the template's wave numbers (used by playoff cuts).
     */
    async insertBracketTemplate(tournamentId, template, { bestOf = 1, roundOffset = 0 } = {}) {
        const idByKey = {};
        const ordered = [...template].sort((a, b) => a.round - b.round || a.pos - b.pos);

        let maxRound = 0;

        for (const match of ordered) {
            const player1 = typeof match.player1 === 'number' ? match.player1 : null;
            const player2 = typeof match.player2 === 'number' ? match.player2 : null;
            const p1Source = match.player1 && match.player1.sourceKey ? match.player1 : null;
            const p2Source = match.player2 && match.player2.sourceKey ? match.player2 : null;

            const rows = await this.db.query(
                'INSERT INTO "TournamentMatches" ("TournamentId", "Round", "Player1Id", "Player2Id", ' +
                    '"WinnerId", "ResultType", "ReportedAt", "Bracket", "BracketRound", "BracketPos", ' +
                    '"P1SourceMatchId", "P1SourceIsLoser", "P2SourceMatchId", "P2SourceIsLoser", "BestOf") ' +
                    'VALUES ($1, $2, $3, $4, $5, $6, ' +
                    (match.byeWinner ? "now() AT TIME ZONE 'utc'" : 'NULL') +
                    ', $7, $8, $9, $10, $11, $12, $13, $14) RETURNING "Id"',
                [
                    tournamentId,
                    match.round + roundOffset,
                    player1,
                    player2,
                    match.byeWinner || null,
                    match.byeWinner ? 'bye' : null,
                    match.bracket,
                    match.bracketRound,
                    match.pos,
                    p1Source ? idByKey[p1Source.sourceKey] : null,
                    p1Source ? !!p1Source.isLoser : false,
                    p2Source ? idByKey[p2Source.sourceKey] : null,
                    p2Source ? !!p2Source.isLoser : false,
                    bestOf
                ]
            );

            idByKey[match.key] = rows[0].Id;
            maxRound = Math.max(maxRound, match.round + roundOffset);
        }

        return { idByKey, maxRound };
    }

    async pairAndInsertRound(tournament, round) {
        const state = await this.buildPairingState(tournament.Id);

        if (tournament.Format === 'single-elim' && !(await this.hasBracketMatches(tournament.Id))) {
            // Events started before bracket templates existed keep the
            // legacy per-round elimination flow.
            let remaining = state;

            if (round > 1) {
                const matches = await this.getMatches(tournament.Id);
                const lastRound = matches.filter((match) => match.Round === round - 1);
                const advancing = lastRound
                    .map((match) => match.WinnerId)
                    .filter((winner) => !!winner);
                remaining = state.filter((player) => advancing.includes(player.id));
            }

            if (remaining.length < 2) {
                return { error: 'Not enough players remaining for another round' };
            }

            const { pairings, byes } = pairEliminationRound(remaining);
            await this.insertRoundMatches(
                tournament.Id,
                round,
                pairings,
                byes,
                tournament.BestOf || 1
            );

            return { remaining: remaining.length };
        }

        const ordered = round === 1 ? foldOrder(state) : state;
        const { pairings, bye, rematches, exhausted } = pairSwissRound(ordered);

        if (pairings.length === 0 && !bye) {
            return { error: 'Not enough players to pair' };
        }

        await this.insertRoundMatches(
            tournament.Id,
            round,
            pairings,
            bye ? [bye] : [],
            tournament.BestOf || 1
        );

        // ARCHON: a Swiss round can run out of fresh opponents - a field
        // thinned by drops, or more rounds booked than the field supports.
        // pairSwissRound pairs anyway and says which pairs repeat, and
        // carrying that out of here is the whole point of computing it.
        // Dropped on the floor, the organizer posts the sheet and hears about
        // the repeat from two players already sitting at the table.
        //
        // `exhausted` stays in the log rather than going to the organizer: it
        // is the operator's distinction between "no rematch-free matching
        // exists" (normal, forced) and "the bounded search gave up" (worth a
        // look), and neither changes what the organizer does next.
        if (rematches && rematches.length > 0) {
            logger.warn(
                `Tournament ${tournament.Id} round ${round}: ${rematches.length} repeat pairing(s)` +
                    (exhausted ? ' (rematch-free search hit its budget)' : '')
            );
        }

        return { rematches: rematches || [] };
    }

    async hasBracketMatches(tournamentId) {
        const rows = await this.db.query(
            'SELECT 1 FROM "TournamentMatches" WHERE "TournamentId" = $1 AND "Bracket" IS NOT NULL LIMIT 1',
            [tournamentId]
        );

        return rows && rows.length > 0;
    }

    /**
     * Player pairing state built from recorded matches (points, previous
     * opponents, byes), restricted to active (non-dropped) players.
     */
    async buildPairingState(tournamentId) {
        const [players, matches] = await Promise.all([
            this.getPlayers(tournamentId),
            this.getMatches(tournamentId)
        ]);

        // Compute standings over ALL competitors (including dropped ones)
        // so that results against a player who later dropped still count.
        // Passing only active players made computeStandings discard every
        // match a dropped player was in, silently erasing the point (and
        // opponent history) earned by whoever beat them - corrupting Swiss
        // pairings and byes.
        const competitors = players.filter((player) => !player.Waitlisted);
        const standings = computeStandings(
            competitors.map((player) => ({ id: player.UserId })),
            this.matchesForStandings(matches)
        );

        // Only ACTIVE (non-dropped) players are paired into the next round.
        const activeIds = new Set(
            competitors.filter((player) => !player.Dropped).map((player) => player.UserId)
        );

        // computeStandings returns entries sorted by standing; keep that
        // order so Swiss pairs within score groups and elim reseeds
        return standings
            .filter((entry) => activeIds.has(entry.id))
            .map((entry) => ({
                id: entry.id,
                points: entry.points,
                opponents: entry.opponents,
                receivedBye: entry.byes > 0
            }));
    }

    async start(tournamentId, actor, options = {}) {
        const tournament = await this.getTournamentRow(tournamentId);

        if (!tournament) {
            return { success: false, message: 'No such tournament' };
        }

        if (!(await this.canManage(actor, tournament))) {
            return { success: false, message: 'Only the organizer can start the event' };
        }

        if (tournament.Status !== 'registration') {
            return { success: false, message: 'Tournament has already started' };
        }

        let players = await this.getPlayers(tournamentId);

        // With check-in open, starting can shed the no-shows first.
        if (tournament.CheckInOpenedAt && options.dropNoShows) {
            const noShows = players.filter(
                (player) => !player.Dropped && !player.Waitlisted && !player.CheckedIn
            );

            for (const player of noShows) {
                await this.db.query(
                    'DELETE FROM "TournamentPlayers" WHERE "TournamentId" = $1 AND "UserId" = $2',
                    [tournamentId, player.UserId]
                );
            }

            if (noShows.length > 0) {
                await this.promoteWaitlist(tournamentId);
                players = await this.getPlayers(tournamentId);
            }
        }

        const active = players.filter((player) => !player.Dropped && !player.Waitlisted);

        if (tournament.Triad) {
            const pools = await this.getTriadPools(tournamentId);
            const missing = active.filter(
                (player) => (pools[player.UserId] || []).length !== TRIAD_DECKS
            );

            if (missing.length > 0) {
                return {
                    success: false,
                    message: `Players without a full Triad pool (3 decks): ${missing
                        .map((player) => player.Username)
                        .join(', ')}. They must register their pool or be removed.`
                };
            }
        } else if (tournament.RequireDeckRegistration) {
            const missing = active.filter((player) => !player.DeckId);

            if (missing.length > 0) {
                return {
                    success: false,
                    message: `Players without a registered deck: ${missing
                        .map((player) => player.Username)
                        .join(', ')}. They must register a deck or be removed.`
                };
            }
        }

        // ARCHON: unpaid entrants, refused in the same shape as a missing deck.
        //
        // Named rather than counted, because the organizer's next action is to
        // go and find those specific people. And refused rather than dropped:
        // removing somebody from an event they turned up to is a decision a
        // person should make, especially when the usual reason for an unpaid
        // tick is that they paid a judge who has not marked it yet.
        if (tournament.RequirePayment && tournament.EntryFeeCents) {
            const unpaid = active.filter((player) => !player.PaidAt);

            if (unpaid.length > 0) {
                return {
                    success: false,
                    message: `Players who have not paid: ${unpaid
                        .map((player) => player.Username)
                        .join(', ')}. Mark them paid on the roster or remove them.`
                };
            }
        }

        if (active.length < 2) {
            return { success: false, message: 'At least 2 players are required' };
        }

        const seeded = await this.seedPlayers(tournament, active);
        const seededIds = seeded.map((player) => ({ id: player.UserId }));
        const bestOf = tournament.BestOf || 1;

        let roundCount = null;

        if (tournament.Format === 'swiss') {
            roundCount = tournament.RoundCount || suggestedSwissRounds(active.length);

            const state = seededIds.map((player) => ({
                id: player.id,
                points: 0,
                opponents: [],
                receivedBye: false
            }));
            const { pairings, bye } = pairSwissRound(foldOrder(state));

            if (pairings.length === 0 && !bye) {
                return { success: false, message: 'Not enough players to pair' };
            }

            await this.insertRoundMatches(tournamentId, 1, pairings, bye ? [bye] : [], bestOf);
        } else if (tournament.Format === 'round-robin') {
            const schedule = roundRobinSchedule(seededIds);

            if (schedule.length === 0) {
                return { success: false, message: 'Not enough players to pair' };
            }

            roundCount = schedule.length;

            for (const round of schedule) {
                await this.insertRoundMatches(
                    tournamentId,
                    round.round,
                    round.pairings,
                    round.bye ? [round.bye] : [],
                    bestOf
                );
            }
        } else {
            const template =
                tournament.Format === 'double-elim'
                    ? buildDoubleElimBracket(seededIds)
                    : buildSingleElimBracket(seededIds);

            if (template.length === 0) {
                return { success: false, message: 'Not enough players to pair' };
            }

            const { maxRound } = await this.insertBracketTemplate(tournamentId, template, {
                bestOf
            });

            roundCount = maxRound;
        }

        await this.db.query(
            'UPDATE "Tournaments" SET "Status" = \'active\', "CurrentRound" = 1, ' +
                '"RoundCount" = $2, "StartedAt" = now() AT TIME ZONE \'utc\', ' +
                '"RoundStartedAt" = now() AT TIME ZONE \'utc\', ' +
                `${ROUND_CLOCK_SQL} WHERE "Id" = $1`,
            [tournamentId, roundCount]
        );

        logger.info(`Tournament ${tournamentId} started by user ${actor.id}`);

        this.emitTournamentStarted(tournamentId);
        this.emitRoundPaired(tournamentId);

        return { success: true };
    }

    emitRoundPaired(tournamentId) {
        try {
            tournamentEvents.emit('roundPaired', { tournamentId });
        } catch (err) {
            logger.error(`Failed to emit roundPaired for tournament ${tournamentId}`, err);
        }
    }

    /**
     * ARCHON: the event has begun (N2). Distinct from 'roundPaired', which also
     * fires for rounds 2..n - a player wants "your event is starting" once, and
     * "you are paired" every round.
     */
    emitTournamentStarted(tournamentId) {
        try {
            tournamentEvents.emit('tournamentStarted', { tournamentId });
        } catch (err) {
            logger.error(`Failed to emit tournamentStarted for tournament ${tournamentId}`, err);
        }
    }

    /**
     * ARCHON: who is playing whom in the current round, for notifications (N2).
     *
     * Deliberately separate from getMatchesNeedingGames, which is scoped to
     * online events that still need a lobby table. A pairing ping matters most
     * at a paper event, where there is no auto-created game to notice.
     */
    async getCurrentRoundPairings(tournamentId) {
        const tournament = await this.getTournamentRow(tournamentId);

        if (!tournament || tournament.Status !== 'active' || !tournament.CurrentRound) {
            return null;
        }

        const rows = await this.db.query(
            'SELECT m."Id", m."TableNumber", m."Player1Id", m."Player2Id", ' +
                'u1."Username" AS "Player1Name", u2."Username" AS "Player2Name" ' +
                'FROM "TournamentMatches" m ' +
                'LEFT JOIN "Users" u1 ON u1."Id" = m."Player1Id" ' +
                'LEFT JOIN "Users" u2 ON u2."Id" = m."Player2Id" ' +
                'WHERE m."TournamentId" = $1 AND m."Round" = $2 ' +
                'ORDER BY m."TableNumber" NULLS LAST, m."Id"',
            [tournamentId, tournament.CurrentRound]
        );

        return {
            tournamentId: tournament.Id,
            name: tournament.Name,
            round: tournament.CurrentRound,
            matches: (rows || []).map((row) => ({
                matchId: row.Id,
                table: row.TableNumber,
                players: [
                    { userId: row.Player1Id, username: row.Player1Name },
                    { userId: row.Player2Id, username: row.Player2Name }
                ].filter((player) => !!player.userId)
            }))
        };
    }

    /**
     * Playing participants of an event, for notifications (N2): registered,
     * not dropped, and not still on the waitlist - a waitlisted player has not
     * got in, so telling them the event they are not in has started would be
     * worse than saying nothing.
     */
    async getActiveParticipants(tournamentId) {
        const rows = await this.db.query(
            'SELECT tp."UserId", u."Username" FROM "TournamentPlayers" tp ' +
                'JOIN "Users" u ON u."Id" = tp."UserId" ' +
                'WHERE tp."TournamentId" = $1 AND tp."Dropped" = false ' +
                'AND tp."Waitlisted" = false',
            [tournamentId]
        );

        return (rows || []).map((row) => ({ userId: row.UserId, username: row.Username }));
    }

    async roundComplete(tournamentId, round) {
        const rows = await this.db.query(
            'SELECT COUNT(*) AS "Unreported" FROM "TournamentMatches" ' +
                'WHERE "TournamentId" = $1 AND "Round" = $2 AND "WinnerId" IS NULL AND "ResultType" IS NULL',
            [tournamentId, round]
        );

        return parseInt(rows[0].Unreported, 10) === 0;
    }

    /**
     * ARCHON: resolve every still-open match in the current round at once.
     *
     * The round clock used to be decorative - stored, drawn, and never acted
     * on - while pairing the next round refuses to run with a result missing.
     * Put together, one player who shuts their laptop mid-round stopped the
     * event for everyone, and the organizer's only recourse was to award each
     * abandoned match by hand.
     *
     * This is the "time in the round" call every tournament makes out loud:
     * whoever is ahead on games takes the match, and a genuine tie is a draw
     * that neither player wins. In a bracket a draw is not a legal outcome -
     * somebody has to advance - so there the organizer is told which matches
     * they must still decide themselves rather than having one picked for them.
     *
     * @param {'leader'|'double-loss'} tieBreak what to do with a level match
     */
    async resolveUnfinished(tournamentId, actor, { tieBreak = 'double-loss' } = {}) {
        const tournament = await this.getTournamentRow(tournamentId);

        if (!tournament) {
            return { success: false, message: 'No such tournament' };
        }

        if (!(await this.canManage(actor, tournament))) {
            return { success: false, message: 'Only the organizer can resolve open matches' };
        }

        if (tournament.Status !== 'active') {
            return { success: false, message: 'Tournament is not active' };
        }

        const matches = await this.getMatches(tournamentId);
        const open = matches.filter(
            (match) =>
                match.Round === tournament.CurrentRound &&
                !match.WinnerId &&
                !match.ResultType &&
                match.Player1Id &&
                match.Player2Id
        );

        const resolved = [];
        const undecidable = [];

        // ARCHON: at an event where matches can be played away from the
        // platform, 0-0 does not mean "level" - it means "nobody has told us
        // yet". Per-game scores are only ever written by recordGameWin, for a
        // table this platform ran itself; a paper result is typed in whole, at
        // completion. So every table in a paper round that has not reached the
        // desk reads as a tie, and the level branch would put a loss and zero
        // points on BOTH players for a game one of them plainly won - a result
        // neither of them can undo, because the match is then decided and
        // written as already confirmed. Those go back to the organizer
        // alongside the bracket matches.
        //
        // AllowPaperResults is the gate rather than the mode, because it is
        // exactly the flag that says "a result may exist that we have not
        // seen": it is forced on for irl and hybrid events, and an online
        // event can opt in.
        const scoresMayBeSilent = !!tournament.AllowPaperResults;

        for (const match of open) {
            const p1Wins = match.Player1Wins || 0;
            const p2Wins = match.Player2Wins || 0;

            if (p1Wins === p2Wins) {
                // Level on games. A bracket has to produce somebody to
                // advance, so it is not ours to call.
                if (match.Bracket || tieBreak === 'leader' || (scoresMayBeSilent && !p1Wins)) {
                    undecidable.push(match.Id);
                    continue;
                }

                await this.completeMatch(tournament, match, {
                    winnerId: null,
                    resultType: 'double-loss',
                    reporterId: actor.id,
                    p1Wins,
                    p2Wins
                });
                resolved.push(match.Id);
                continue;
            }

            await this.completeMatch(tournament, match, {
                winnerId: p1Wins > p2Wins ? match.Player1Id : match.Player2Id,
                resultType: 'time',
                reporterId: actor.id,
                p1Wins,
                p2Wins
            });
            resolved.push(match.Id);
        }

        logger.info(
            `Tournament ${tournamentId} round ${tournament.CurrentRound}: ` +
                `${resolved.length} match(es) resolved on time by user ${actor.id}` +
                (undecidable.length ? `, ${undecidable.length} left for the organizer` : '')
        );

        return {
            success: true,
            resolved: resolved.length,
            undecidable
        };
    }

    /**
     * Extend (or shorten) the current round's clock by a number of minutes.
     * Stored on the event so every client agrees, and so an extension made
     * before a restart is still there afterwards.
     */
    async adjustRoundClock(tournamentId, actor, minutes) {
        const tournament = await this.getTournamentRow(tournamentId);

        if (!tournament) {
            return { success: false, message: 'No such tournament' };
        }

        if (!(await this.canManage(actor, tournament))) {
            return { success: false, message: 'Only the organizer can change the round clock' };
        }

        if (tournament.Status !== 'active') {
            return { success: false, message: 'Tournament is not active' };
        }

        const delta = parseInt(minutes, 10);

        if (!Number.isFinite(delta) || delta === 0) {
            return { success: false, message: 'Give a number of minutes to add or remove' };
        }

        // Extending a round that never had a clock starts one from now,
        // which is what an organizer who just typed "+10 minutes" means.
        // Moving the deadline also re-arms the overdue notice: if the new
        // deadline passes too, that is worth saying again.
        await this.db.query(
            'UPDATE "Tournaments" SET "RoundEndsAt" = ' +
                "COALESCE(\"RoundEndsAt\", now() AT TIME ZONE 'utc') + ($2 * interval '1 minute'), " +
                '"DeadlineNotifiedAt" = NULL ' +
                'WHERE "Id" = $1',
            [tournamentId, delta]
        );

        return { success: true };
    }

    /**
     * ARCHON (N14): a player offers their opponent a time to play their
     * match. One live proposal per match - a new offer (from either side)
     * replaces the previous one, which is how scheduling actually converges:
     * "Thursday 8pm?" / "can't - Friday 7?" is propose, counter-propose.
     *
     * The offered time is stored as a UTC wall-clock string, written out
     * explicitly rather than as a Date so the column's meaning does not
     * depend on the server's timezone.
     */
    async proposeMatchTime(tournamentId, matchId, actor, time, note, zone) {
        const context = await this.scheduleContext(tournamentId, matchId, actor);

        if (context.error) {
            return { success: false, message: context.error };
        }

        const when = new Date(time);

        if (!time || Number.isNaN(when.getTime())) {
            return { success: false, message: 'That is not a valid date and time' };
        }

        const now = Date.now();

        if (when.getTime() < now - 60 * 1000) {
            return { success: false, message: 'Propose a time in the future' };
        }

        if (when.getTime() > now + MAX_SCHEDULE_AHEAD_DAYS * 24 * 60 * 60 * 1000) {
            return {
                success: false,
                message: `Matches can be scheduled at most ${MAX_SCHEDULE_AHEAD_DAYS} days ahead`
            };
        }

        // ARCHON: not after the round is over.
        //
        // The only ceiling here was the typo guard - 60 days - so two players
        // in an async league could agree, in good faith and with the platform
        // confirming it, on a time days past the deadline their round actually
        // ends on. Nothing told them; they found out when the deadline sweep
        // flagged the round and the organizer decided the match without them.
        //
        // The round's own deadline is the real bound, and it is the number the
        // players were shown when they were told how long they had.
        const roundEndsAt = context.tournament?.RoundEndsAt;

        if (roundEndsAt && when.getTime() > new Date(roundEndsAt).getTime()) {
            return {
                success: false,
                message: `This round ends ${new Date(roundEndsAt)
                    .toISOString()
                    .replace('T', ' ')
                    .slice(
                        0,
                        16
                    )} UTC - pick a time before then, or ask the organizer for more time`
            };
        }

        const cleanNote = (note || '').toString().slice(0, 280) || null;

        /**
         * ARCHON: an offer is a ROW, and there may be several live at once.
         *
         * Scheduling used to be one live offer that a counter-proposal
         * replaced, which is one round trip per candidate time between two
         * people who are usually asleep when the other is awake. Two players
         * three zones apart could spend a day of a three-day round finding out
         * that Thursday does not work either.
         *
         * Offering a time somebody already offered is agreement, not a second
         * option, so the unique constraint absorbs it rather than listing it
         * twice.
         */
        await this.db.query(
            'INSERT INTO "TournamentMatchTimeSlots" ' +
                '("MatchId", "ProposedBy", "SlotTime", "ProposerZone", "CreatedAt") ' +
                "VALUES ($1, $2, $3, $4, now() AT TIME ZONE 'utc') " +
                'ON CONFLICT ("MatchId", "SlotTime") DO NOTHING',
            [matchId, actor.id, when.toISOString(), cleanZone(zone)]
        );

        if (cleanNote) {
            await this.db.query(
                'UPDATE "TournamentMatches" SET "ScheduleNote" = $2 WHERE "Id" = $1',
                [matchId, cleanNote]
            );
        }

        await this.syncProposedTime(matchId);

        this.emitScheduleEvent('matchTimeProposed', context, actor, {
            time: when.toISOString(),
            note: cleanNote
        });

        return { success: true };
    }

    /**
     * Every time currently on the table for a match, soonest first.
     */
    async getTimeSlots(matchId) {
        const rows = await this.db.query(
            'SELECT s."Id", s."SlotTime", s."ProposedBy", s."ProposerZone", u."Username" ' +
                'FROM "TournamentMatchTimeSlots" s JOIN "Users" u ON u."Id" = s."ProposedBy" ' +
                'WHERE s."MatchId" = $1 ORDER BY s."SlotTime"',
            [matchId]
        );

        return (rows || []).map((row) => ({
            id: row.Id,
            time: row.SlotTime,
            proposedById: row.ProposedBy,
            proposedBy: row.Username,
            zone: row.ProposerZone || undefined
        }));
    }

    /**
     * Keep the match's ProposedTime/ProposedBy pointing at the soonest live
     * offer.
     *
     * A cache, and deliberately written in exactly one place. Several things
     * downstream ask "is there an offer outstanding" - the deadline reminders,
     * the per-player schedule panel, the match list - and rewriting all of them
     * to count rows in another table would be a lot of churn for a question
     * these two columns already answer. What matters is that nothing else ever
     * writes them, so they cannot drift from the rows they summarise.
     */
    async syncProposedTime(matchId) {
        await this.db.query(
            'UPDATE "TournamentMatches" m SET ' +
                '"ProposedTime" = s."SlotTime", "ProposedBy" = s."ProposedBy" ' +
                'FROM (SELECT "SlotTime", "ProposedBy" FROM "TournamentMatchTimeSlots" ' +
                'WHERE "MatchId" = $1 ORDER BY "SlotTime" LIMIT 1) s WHERE m."Id" = $1',
            [matchId]
        );

        // No slots left means no offer. The join above cannot express that -
        // an UPDATE ... FROM with an empty subquery updates nothing at all.
        await this.db.query(
            'UPDATE "TournamentMatches" SET "ProposedTime" = NULL, "ProposedBy" = NULL ' +
                'WHERE "Id" = $1 AND NOT EXISTS ' +
                '(SELECT 1 FROM "TournamentMatchTimeSlots" WHERE "MatchId" = $1)',
            [matchId]
        );
    }

    /**
     * The opponent agrees to the proposed time: it becomes the match's
     * scheduled time and the proposal is consumed.
     */
    async acceptMatchTime(tournamentId, matchId, actor, slotId = null) {
        const context = await this.scheduleContext(tournamentId, matchId, actor);

        if (context.error) {
            return { success: false, message: context.error };
        }

        const slots = await this.getTimeSlots(matchId);

        if (slots.length === 0) {
            return { success: false, message: 'There is no proposed time to accept' };
        }

        // With one offer on the table, accepting without naming it is
        // unambiguous - and it is what every older client sends.
        const chosen = slotId
            ? slots.find((slot) => slot.id === parseInt(slotId, 10))
            : slots.length === 1
            ? slots[0]
            : null;

        if (!chosen) {
            return {
                success: false,
                message: slotId
                    ? 'That time is no longer on offer - check the times listed'
                    : 'Several times are on offer - pick the one that works'
            };
        }

        if (chosen.proposedById === actor.id) {
            return { success: false, message: 'The other player has to accept your proposal' };
        }

        /**
         * ARCHON: the delete IS the compare-and-swap.
         *
         * Accepting must consume the exact offer it read: if the other player
         * withdraws it between the read and this write, agreeing to a time
         * nobody is offering is wrong. Deleting by primary key answers that
         * unambiguously - one row or none - and, unlike the timestamp
         * comparison it replaces, it cannot be defeated by how a Date is
         * serialised.
         *
         * That comparison was a real bug on any host not set to UTC:
         * node-postgres serialises a Date parameter with the host's offset and
         * Postgres casting it to an unzoned column keeps the wall clock and
         * discards the offset, so the WHERE looked for a time hours from the
         * one stored, matched nothing, and told both players "the proposal
         * changed while you were looking" - every time, forever. An integer key
         * has no such failure mode.
         */
        const claimed = await this.db.query(
            'DELETE FROM "TournamentMatchTimeSlots" WHERE "Id" = $1 AND "MatchId" = $2 ' +
                'RETURNING "SlotTime"',
            [chosen.id, matchId]
        );

        if (!claimed || claimed.length === 0) {
            return {
                success: false,
                message: 'That time was withdrawn while you were looking - check the times listed'
            };
        }

        await this.db.query(
            'UPDATE "TournamentMatches" SET "ScheduledAt" = $2, ' +
                // A newly agreed time is a new thing to be reminded about.
                '"ProposedTime" = NULL, "ProposedBy" = NULL, "ScheduleRemindedAt" = NULL ' +
                'WHERE "Id" = $1',
            [matchId, new Date(claimed[0].SlotTime).toISOString()]
        );

        // The rest of the offers are moot now that a time is agreed.
        await this.db.query('DELETE FROM "TournamentMatchTimeSlots" WHERE "MatchId" = $1', [
            matchId
        ]);

        this.emitScheduleEvent('matchTimeAccepted', context, actor, {
            time: claimed[0].SlotTime
        });

        return { success: true };
    }

    /**
     * Take one of your own offers back off the table without clearing the rest.
     */
    async withdrawMatchTime(tournamentId, matchId, actor, slotId) {
        const context = await this.scheduleContext(tournamentId, matchId, actor, {
            allowManagers: true
        });

        if (context.error) {
            return { success: false, message: context.error };
        }

        const isManager = context.isManager;
        const rows = await this.db.query(
            'DELETE FROM "TournamentMatchTimeSlots" WHERE "Id" = $1 AND "MatchId" = $2' +
                // Your own offers are yours to withdraw. A judge may remove any
                // of them, which is the same authority they already have over
                // an agreed time.
                (isManager ? '' : ' AND "ProposedBy" = $3') +
                ' RETURNING "Id"',
            isManager ? [parseInt(slotId, 10), matchId] : [parseInt(slotId, 10), matchId, actor.id]
        );

        if (!rows || rows.length === 0) {
            return { success: false, message: 'That time is not yours to withdraw' };
        }

        await this.syncProposedTime(matchId);

        return { success: true };
    }

    /**
     * Withdraw or decline the pending proposal, or clear an agreed time so
     * the match reads as unscheduled again. Either player may do it (and so
     * may the organizer, whose judge tools already outrank both).
     */
    async clearMatchSchedule(tournamentId, matchId, actor) {
        const context = await this.scheduleContext(tournamentId, matchId, actor, {
            allowManagers: true
        });

        if (context.error) {
            return { success: false, message: context.error };
        }

        const { match } = context;

        if (!match.ProposedTime && !match.ScheduledAt) {
            return { success: false, message: 'There is nothing scheduled to clear' };
        }

        await this.db.query(
            'UPDATE "TournamentMatches" SET "ScheduledAt" = NULL, "ProposedTime" = NULL, ' +
                '"ProposedBy" = NULL, "ScheduleNote" = NULL, "ScheduleRemindedAt" = NULL ' +
                'WHERE "Id" = $1',
            [matchId]
        );

        // Clearing the schedule clears the offers with it: an offer outliving
        // the plan it belonged to is an offer nobody remembers making.
        await this.db.query('DELETE FROM "TournamentMatchTimeSlots" WHERE "MatchId" = $1', [
            matchId
        ]);

        this.emitScheduleEvent('matchScheduleCleared', context, actor, {
            hadAgreedTime: !!match.ScheduledAt
        });

        return { success: true };
    }

    /**
     * Shared guards for the scheduling actions: the tournament is running,
     * the match exists, is still open, has both players, and the actor is
     * one of them (or, when allowed, a manager).
     */
    async scheduleContext(tournamentId, matchId, actor, { allowManagers = false } = {}) {
        const tournament = await this.getTournamentRow(tournamentId);

        if (!tournament) {
            return { error: 'No such tournament' };
        }

        if (tournament.Status !== 'active') {
            return { error: 'Tournament is not active' };
        }

        const match = await this.getMatchRow(tournamentId, matchId);

        if (!match) {
            return { error: 'No such match' };
        }

        if (match.WinnerId || match.ResultType) {
            return { error: 'This match already has a result' };
        }

        if (!match.Player1Id || !match.Player2Id) {
            return { error: 'This match does not have both players yet' };
        }

        const isParticipant = actor.id === match.Player1Id || actor.id === match.Player2Id;

        if (!isParticipant) {
            if (!allowManagers || !(await this.canManage(actor, tournament))) {
                return { error: 'Only the players in this match can schedule it' };
            }
        }

        return { tournament, match, isParticipant, isManager: !isParticipant };
    }

    /**
     * Scheduling events carry enough for the notification layer to name
     * everyone without another read: the two player ids and who acted.
     */
    emitScheduleEvent(event, context, actor, extra = {}) {
        try {
            tournamentEvents.emit(event, {
                tournamentId: context.tournament.Id,
                tournamentName: context.tournament.Name,
                matchId: context.match.Id,
                round: context.match.Round,
                player1Id: context.match.Player1Id,
                player2Id: context.match.Player2Id,
                byUserId: actor.id,
                byUsername: actor.username,
                ...extra
            });
        } catch (err) {
            logger.error(`Failed to emit ${event} for match ${context.match.Id}`, err);
        }
    }

    /**
     * ARCHON (N14): the async deadline sweep. Finds active async events whose
     * round deadline has passed and has not been flagged yet, marks them (so
     * the notice fires once per deadline, however many lobby ticks see it),
     * and emits an event carrying how much of the round is still unplayed.
     *
     * Nothing is decided here: matches are not forfeited and rounds are not
     * advanced. The deadline is the organizer's cue, and "Time in the round"
     * is one click away - an automatic forfeit could never know which player
     * ghosted whom.
     */
    /**
     * ARCHON: the reminders an asynchronous event owes its players.
     *
     * Everything this event ever told anyone was about something that had
     * already happened: a round was paired, a time was agreed, a deadline had
     * passed. Nobody was ever told anything was ABOUT to. Two players agree to
     * meet on Thursday at eight and nothing reminds either of them; a round
     * ends on Sunday and the first anyone hears is Monday, when matches start
     * being decided by the clock instead of by play.
     *
     * Both passes claim their row with the write that announces, so several
     * lobby processes stay one voice and a restart cannot replay a reminder.
     */
    async sweepScheduleReminders() {
        let warned = 0;
        let reminded = 0;

        // --- rounds whose deadline is close -----------------------------
        try {
            const closing = await this.db.query(
                'UPDATE "Tournaments" SET "DeadlineWarnedAt" = now() AT TIME ZONE \'utc\' ' +
                    'WHERE "Status" = \'active\' AND "Pacing" = \'async\' ' +
                    'AND "RoundEndsAt" IS NOT NULL ' +
                    'AND "RoundEndsAt" > now() AT TIME ZONE \'utc\' ' +
                    'AND "RoundEndsAt" < (now() AT TIME ZONE \'utc\') + ' +
                    `interval '${DEADLINE_WARNING_HOURS} hours' ` +
                    'AND ("DeadlineWarnedAt" IS NULL OR "DeadlineWarnedAt" < "RoundStartedAt") ' +
                    'RETURNING "Id", "Name", "OrganizerId", "CurrentRound", "RoundEndsAt"'
            );

            for (const tournament of closing || []) {
                const matches = await this.getMatches(tournament.Id);
                const open = matches.filter(
                    (match) =>
                        match.Round === tournament.CurrentRound &&
                        match.Player1Id &&
                        match.Player2Id &&
                        !match.WinnerId &&
                        !match.ResultType
                );

                if (open.length === 0) {
                    continue;
                }

                warned++;
                tournamentEvents.emit('roundDeadlineApproaching', {
                    tournamentId: tournament.Id,
                    tournamentName: tournament.Name,
                    organizerId: tournament.OrganizerId,
                    round: tournament.CurrentRound,
                    roundEndsAt: tournament.RoundEndsAt,
                    openMatches: open.map((match) => ({
                        matchId: match.Id,
                        player1Id: match.Player1Id,
                        player2Id: match.Player2Id
                    }))
                });
            }
        } catch (err) {
            logger.error('Failed to warn about approaching tournament deadlines', err);
        }

        // --- matches whose agreed time is close --------------------------
        try {
            const soon = await this.db.query(
                'UPDATE "TournamentMatches" SET "ScheduleRemindedAt" = now() AT TIME ZONE \'utc\' ' +
                    'WHERE "Id" IN (SELECT m."Id" FROM "TournamentMatches" m ' +
                    'JOIN "Tournaments" t ON t."Id" = m."TournamentId" ' +
                    'WHERE t."Status" = \'active\' AND m."ScheduledAt" IS NOT NULL ' +
                    'AND m."WinnerId" IS NULL AND m."ResultType" IS NULL ' +
                    'AND m."ScheduledAt" > now() AT TIME ZONE \'utc\' ' +
                    'AND m."ScheduledAt" < (now() AT TIME ZONE \'utc\') + ' +
                    `interval '${MATCH_REMINDER_MINUTES} minutes' ` +
                    'AND m."ScheduleRemindedAt" IS NULL) ' +
                    'RETURNING "Id", "TournamentId", "Round", "Player1Id", "Player2Id", "ScheduledAt"'
            );

            for (const match of soon || []) {
                const tournament = await this.getTournamentRow(match.TournamentId);

                reminded++;
                tournamentEvents.emit('matchTimeApproaching', {
                    tournamentId: match.TournamentId,
                    tournamentName: tournament?.Name,
                    matchId: match.Id,
                    round: match.Round,
                    player1Id: match.Player1Id,
                    player2Id: match.Player2Id,
                    time: match.ScheduledAt
                });
            }
        } catch (err) {
            logger.error('Failed to remind players of scheduled matches', err);
        }

        return { warned, reminded };
    }

    async sweepRoundDeadlines() {
        let due;

        try {
            due = await this.db.query(
                'SELECT "Id" FROM "Tournaments" ' +
                    'WHERE "Status" = \'active\' AND "Pacing" = \'async\' ' +
                    'AND "RoundEndsAt" IS NOT NULL ' +
                    'AND "RoundEndsAt" < now() AT TIME ZONE \'utc\' ' +
                    'AND ("DeadlineNotifiedAt" IS NULL OR "DeadlineNotifiedAt" < "RoundEndsAt")'
            );
        } catch (err) {
            logger.error('Failed to scan for passed tournament deadlines', err);

            return { notified: 0 };
        }

        let notified = 0;

        for (const row of due || []) {
            try {
                // The write is the claim: only the sweep that flips the marker
                // announces, so several lobby instances stay one voice.
                const claimed = await this.db.query(
                    'UPDATE "Tournaments" SET "DeadlineNotifiedAt" = now() AT TIME ZONE \'utc\' ' +
                        'WHERE "Id" = $1 AND "Status" = \'active\' ' +
                        'AND ("DeadlineNotifiedAt" IS NULL OR "DeadlineNotifiedAt" < "RoundEndsAt") ' +
                        'RETURNING "Id", "Name", "OrganizerId", "CurrentRound", "RoundEndsAt"',
                    [row.Id]
                );

                if (!claimed || claimed.length === 0) {
                    continue;
                }

                const tournament = claimed[0];
                const matches = await this.getMatches(tournament.Id);
                const open = matches.filter(
                    (match) =>
                        match.Round === tournament.CurrentRound &&
                        match.Player1Id &&
                        match.Player2Id &&
                        !match.WinnerId &&
                        !match.ResultType
                );

                notified++;
                tournamentEvents.emit('roundDeadlinePassed', {
                    tournamentId: tournament.Id,
                    tournamentName: tournament.Name,
                    organizerId: tournament.OrganizerId,
                    round: tournament.CurrentRound,
                    roundEndsAt: tournament.RoundEndsAt,
                    openMatches: open.map((match) => ({
                        matchId: match.Id,
                        player1Id: match.Player1Id,
                        player2Id: match.Player2Id,
                        player1: match.Player1,
                        player2: match.Player2
                    }))
                });
            } catch (err) {
                logger.error(`Failed to flag deadline for tournament ${row.Id}`, err);
            }
        }

        return { notified };
    }

    async nextRound(tournamentId, actor) {
        const tournament = await this.getTournamentRow(tournamentId);

        if (!tournament) {
            return { success: false, message: 'No such tournament' };
        }

        if (!(await this.canManage(actor, tournament))) {
            return { success: false, message: 'Only the organizer can pair the next round' };
        }

        if (tournament.Status !== 'active') {
            return { success: false, message: 'Tournament is not active' };
        }

        if (!(await this.roundComplete(tournamentId, tournament.CurrentRound))) {
            return { success: false, message: 'The current round still has unreported results' };
        }

        const isBracket = await this.hasBracketMatches(tournamentId);
        const round = tournament.CurrentRound + 1;

        if (isBracket && tournament.Stage !== 'main') {
            // Playoff bracket: waves already exist, just advance the gate.
            return await this.advanceBracketWave(tournament, round);
        }

        if (isBracket && ['single-elim', 'double-elim'].includes(tournament.Format)) {
            return await this.advanceBracketWave(tournament, round);
        }

        if (tournament.Format === 'round-robin') {
            if (tournament.RoundCount && tournament.CurrentRound >= tournament.RoundCount) {
                return {
                    success: false,
                    message: 'All rounds are complete - finish the event instead'
                };
            }

            await this.db.query(
                `UPDATE "Tournaments" SET "CurrentRound" = $2, "RoundStartedAt" = now() AT TIME ZONE 'utc', ${ROUND_CLOCK_SQL} WHERE "Id" = $1`,
                [tournamentId, round]
            );

            this.emitRoundPaired(tournamentId);

            return { success: true, round };
        }

        if (
            tournament.Format === 'swiss' &&
            tournament.RoundCount &&
            tournament.CurrentRound >= tournament.RoundCount
        ) {
            if (tournament.CutTo) {
                return {
                    success: false,
                    message: 'Swiss rounds are complete - cut to the playoff instead'
                };
            }

            return {
                success: false,
                message: 'All planned rounds are complete - finish the event instead'
            };
        }

        const result = await this.pairAndInsertRound(tournament, round);

        if (result.error) {
            return { success: false, message: result.error };
        }

        await this.db.query(
            `UPDATE "Tournaments" SET "CurrentRound" = $2, "RoundStartedAt" = now() AT TIME ZONE 'utc', ${ROUND_CLOCK_SQL} WHERE "Id" = $1`,
            [tournamentId, round]
        );

        this.emitRoundPaired(tournamentId);

        // The organizer is told about repeat pairings at the moment they pair,
        // which is the only moment they can do anything about them.
        return { success: true, round, rematches: result.rematches || [] };
    }

    async advanceBracketWave(tournament, round) {
        const matches = await this.getMatches(tournament.Id);

        // A wave can be nothing but pre-resolved walkovers (bye-heavy
        // brackets); skip forward to the first wave that still has a
        // playable match.
        let target = null;
        const laterWaves = matches.filter((match) => match.Round >= round);

        for (const match of laterWaves) {
            if (!match.WinnerId && !match.ResultType) {
                target = target === null ? match.Round : Math.min(target, match.Round);
            }
        }

        if (target === null) {
            return {
                success: false,
                message: 'The bracket is complete - finish the event instead'
            };
        }

        await this.db.query(
            `UPDATE "Tournaments" SET "CurrentRound" = $2, "RoundStartedAt" = now() AT TIME ZONE 'utc', ${ROUND_CLOCK_SQL} WHERE "Id" = $1`,
            [tournament.Id, target]
        );

        this.emitRoundPaired(tournament.Id);

        return { success: true, round: target };
    }

    /**
     * Cut a finished Swiss stage to its top-N single-elimination
     * playoff, seeded by Swiss standings.
     */
    async cutToPlayoff(tournamentId, actor) {
        const tournament = await this.getTournamentRow(tournamentId);

        if (!tournament) {
            return { success: false, message: 'No such tournament' };
        }

        if (!(await this.canManage(actor, tournament))) {
            return { success: false, message: 'Only the organizer can cut to the playoff' };
        }

        if (tournament.Status !== 'active' || tournament.Format !== 'swiss') {
            return { success: false, message: 'Only active Swiss events can cut to a playoff' };
        }

        if (tournament.Stage === 'playoff') {
            return { success: false, message: 'The playoff has already started' };
        }

        if (!tournament.CutTo) {
            return { success: false, message: 'This event has no playoff cut configured' };
        }

        if (!(await this.roundComplete(tournamentId, tournament.CurrentRound))) {
            return { success: false, message: 'The current round still has unreported results' };
        }

        if (tournament.RoundCount && tournament.CurrentRound < tournament.RoundCount) {
            return { success: false, message: 'Swiss rounds are still in progress' };
        }

        const state = await this.buildPairingState(tournamentId);
        const cut = state.slice(0, Math.min(tournament.CutTo, state.length));

        if (cut.length < 2) {
            return { success: false, message: 'Not enough players remaining for a playoff' };
        }

        const template = buildSingleElimBracket(cut.map((player) => ({ id: player.id })));
        const bestOf = tournament.PlayoffBestOf || tournament.BestOf || 1;
        const { maxRound } = await this.insertBracketTemplate(tournamentId, template, {
            bestOf,
            roundOffset: tournament.CurrentRound
        });

        await this.db.query(
            'UPDATE "Tournaments" SET "Stage" = \'playoff\', "CurrentRound" = $2, ' +
                '"RoundCount" = $3, "RoundStartedAt" = now() AT TIME ZONE \'utc\', ' +
                `${ROUND_CLOCK_SQL} WHERE "Id" = $1`,
            [tournamentId, tournament.CurrentRound + 1, maxRound]
        );

        logger.info(
            `Tournament ${tournamentId} cut to top ${cut.length} playoff by user ${actor.id}`
        );

        this.emitRoundPaired(tournamentId);

        return { success: true, cutSize: cut.length };
    }

    async getMatchRow(tournamentId, matchId) {
        const rows = await this.db.query(
            'SELECT * FROM "TournamentMatches" WHERE "Id" = $1 AND "TournamentId" = $2',
            [matchId, tournamentId]
        );

        return rows && rows[0];
    }

    /**
     * Mark a match complete and cascade bracket consequences.
     */
    /**
     * Write a decided result.
     *
     * `confirmed` says whether the result stands as agreed fact rather than
     * one player's account. It defaults to true because every caller except a
     * player reporting their own win is either an adjudicator (organizer,
     * judge), a system consequence (a drop forfeiting open matches), or the
     * platform reporting a game it ran itself. `confirmedBy` names the human
     * who vouched for it, and is null when the answer is "the platform did".
     */
    async completeMatch(
        tournament,
        match,
        {
            winnerId,
            resultType,
            reporterId,
            p1Wins,
            p2Wins,
            resultSource,
            confirmed = true,
            confirmedBy
        }
    ) {
        const player1Wins =
            p1Wins !== undefined && p1Wins !== null
                ? p1Wins
                : winnerId && winnerId === match.Player1Id
                ? matchWinsNeeded(match.BestOf)
                : match.Player1Wins || 0;
        const player2Wins =
            p2Wins !== undefined && p2Wins !== null
                ? p2Wins
                : winnerId && winnerId === match.Player2Id
                ? matchWinsNeeded(match.BestOf)
                : match.Player2Wins || 0;

        // ARCHON: writing a result always clears any previous dispute. A
        // dispute is an objection to a specific recorded result; once that
        // result has been replaced there is nothing left to object to, and
        // leaving the flag up would keep the match on the organizer's desk
        // forever after they had already dealt with it.
        await this.db.query(
            'UPDATE "TournamentMatches" SET "WinnerId" = $2, "ResultType" = $3, "ReportedBy" = $4, ' +
                '"Player1Wins" = $5, "Player2Wins" = $6, "ResultSource" = $7, ' +
                '"ConfirmedBy" = $8, "ConfirmedAt" = $9, ' +
                '"DisputedBy" = NULL, "DisputedAt" = NULL, "DisputeNote" = NULL, ' +
                '"ReportedAt" = now() AT TIME ZONE \'utc\' WHERE "Id" = $1',
            [
                match.Id,
                winnerId || null,
                resultType,
                reporterId,
                player1Wins,
                player2Wins,
                // ARCHON (N9): 'paper' marks a result the platform did not
                // witness. An organizer auditing a disputed standing needs to
                // know which rows are claims and which are records.
                resultSource === 'paper' ? 'paper' : 'online',
                confirmed ? (confirmedBy === undefined ? reporterId || null : confirmedBy) : null,
                confirmed ? new Date() : null
            ]
        );

        // Chainbound-style accrual: played match wins add chains that
        // the winner carries into their later games this event.
        if (
            winnerId &&
            resultType === 'played' &&
            tournament.ChainsPerMatchWin &&
            tournament.ChainsPerMatchWin > 0
        ) {
            await this.db.query(
                'UPDATE "TournamentPlayers" SET "EventChains" = "EventChains" + $3 ' +
                    'WHERE "TournamentId" = $1 AND "UserId" = $2',
                [tournament.Id, winnerId, tournament.ChainsPerMatchWin]
            );
        }

        if (match.Bracket) {
            await this.propagateBracket(tournament);
        }
    }

    /**
     * Bracket fixpoint: fill slots whose source matches have completed,
     * auto-complete walkovers (a filled slot whose opponent can never
     * arrive), create the grand-final reset when the losers champion
     * takes GF1, and keep RoundCount in sync. Idempotent - safe to call
     * after any result.
     */
    async propagateBracket(tournament) {
        const matches = await this.getMatches(tournament.Id);
        const byId = new Map(matches.map((match) => [match.Id, match]));

        const isComplete = (match) => !!match.WinnerId || !!match.ResultType;
        const winnerOf = (match) => match.WinnerId || null;
        const loserOf = (match) => {
            if (!match.WinnerId || !match.Player2Id) {
                return null; // walkovers have no loser
            }

            return match.WinnerId === match.Player1Id ? match.Player2Id : match.Player1Id;
        };

        let changed = true;

        while (changed) {
            changed = false;

            for (const match of matches) {
                if (!match.Bracket || isComplete(match)) {
                    continue;
                }

                // Fill slots from completed sources.
                for (const side of [1, 2]) {
                    const playerKey = `Player${side}Id`;
                    const sourceKey = `P${side}SourceMatchId`;
                    const isLoserKey = `P${side}SourceIsLoser`;

                    if (match[playerKey] || !match[sourceKey]) {
                        continue;
                    }

                    const source = byId.get(match[sourceKey]);

                    if (!source || !isComplete(source)) {
                        continue;
                    }

                    const value = match[isLoserKey] ? loserOf(source) : winnerOf(source);

                    if (value) {
                        match[playerKey] = value;
                        await this.db.query(
                            `UPDATE "TournamentMatches" SET "${playerKey}" = $2 WHERE "Id" = $1`,
                            [match.Id, value]
                        );
                        changed = true;
                    }
                }

                // Auto-complete walkovers: one side present, the other
                // provably never coming.
                const sideDead = (side) => {
                    const playerKey = `Player${side}Id`;
                    const sourceKey = `P${side}SourceMatchId`;
                    const isLoserKey = `P${side}SourceIsLoser`;

                    if (match[playerKey]) {
                        return false;
                    }

                    if (!match[sourceKey]) {
                        return true; // resolved as a bye at build time
                    }

                    const source = byId.get(match[sourceKey]);

                    if (!source) {
                        return true;
                    }

                    if (!isComplete(source)) {
                        return false;
                    }

                    return !(match[isLoserKey] ? loserOf(source) : winnerOf(source));
                };

                if (match.Player1Id && !match.Player2Id && sideDead(2)) {
                    match.WinnerId = match.Player1Id;
                    match.ResultType = 'bye';
                    await this.db.query(
                        'UPDATE "TournamentMatches" SET "WinnerId" = $2, "ResultType" = \'bye\', ' +
                            '"ReportedAt" = now() AT TIME ZONE \'utc\' WHERE "Id" = $1',
                        [match.Id, match.Player1Id]
                    );
                    changed = true;
                } else if (match.Player2Id && !match.Player1Id && sideDead(1)) {
                    match.WinnerId = match.Player2Id;
                    match.ResultType = 'bye';
                    await this.db.query(
                        'UPDATE "TournamentMatches" SET "WinnerId" = $2, "ResultType" = \'bye\', ' +
                            '"ReportedAt" = now() AT TIME ZONE \'utc\' WHERE "Id" = $1',
                        [match.Id, match.Player2Id]
                    );
                    changed = true;
                }
            }
        }

        // Grand final reset: the losers-side player (slot 2) taking GF1
        // forces a second final - both players now stand at one loss.
        const gf1 = matches.find((match) => match.Bracket === 'GF' && match.BracketRound === 1);
        const gf2 = matches.find((match) => match.Bracket === 'GF' && match.BracketRound === 2);

        if (
            gf1 &&
            !gf2 &&
            gf1.WinnerId &&
            gf1.Player2Id &&
            gf1.WinnerId === gf1.Player2Id &&
            gf1.ResultType !== 'bye'
        ) {
            await this.db.query(
                'INSERT INTO "TournamentMatches" ("TournamentId", "Round", "Player1Id", "Player2Id", ' +
                    '"Bracket", "BracketRound", "BracketPos", "BestOf") ' +
                    "VALUES ($1, $2, $3, $4, 'GF', 2, 0, $5)",
                [tournament.Id, gf1.Round + 1, gf1.Player1Id, gf1.Player2Id, gf1.BestOf || 1]
            );

            await this.db.query(
                'UPDATE "Tournaments" SET "RoundCount" = GREATEST(COALESCE("RoundCount", 0), $2) WHERE "Id" = $1',
                [tournament.Id, gf1.Round + 1]
            );

            logger.info(`Tournament ${tournament.Id}: grand final reset created`);
        }
    }

    /**
     * Participants report open results; organizers can correct recorded
     * ones (until a bracket result has been built upon). Accepts series
     * scores for best-of matches.
     */
    async reportResult(tournamentId, matchId, winnerId, actor, scores = {}) {
        const tournament = await this.getTournamentRow(tournamentId);

        if (!tournament) {
            return { success: false, message: 'No such tournament' };
        }

        if (tournament.Status !== 'active') {
            return { success: false, message: 'Tournament is not active' };
        }

        const match = await this.getMatchRow(tournamentId, matchId);

        if (!match) {
            return { success: false, message: 'No such match' };
        }

        if (!match.Player2Id || !match.Player1Id) {
            return { success: false, message: 'Byes cannot be reported' };
        }

        if (winnerId !== match.Player1Id && winnerId !== match.Player2Id) {
            return { success: false, message: 'Winner must be one of the match players' };
        }

        const isParticipant = actor.id === match.Player1Id || actor.id === match.Player2Id;
        const isManager = await this.canManage(actor, tournament);
        const alreadyDecided = !!match.WinnerId || !!match.ResultType;

        // Participants may report an open result; only the organizer can
        // change one that is already recorded.
        if (!isManager && (!isParticipant || alreadyDecided)) {
            return { success: false, message: 'Only the organizer can change this result' };
        }

        if (alreadyDecided && match.Bracket) {
            const blocked = await this.bracketResultLocked(tournament, match);

            if (blocked) {
                return {
                    success: false,
                    message: 'Later bracket matches already have results - correct those first'
                };
            }
        }

        const needed = matchWinsNeeded(match.BestOf);
        let p1Wins = scores.player1Wins;
        let p2Wins = scores.player2Wins;

        if (p1Wins !== undefined || p2Wins !== undefined) {
            p1Wins = parseInt(p1Wins, 10) || 0;
            p2Wins = parseInt(p2Wins, 10) || 0;

            const winnerWins = winnerId === match.Player1Id ? p1Wins : p2Wins;
            const loserWins = winnerId === match.Player1Id ? p2Wins : p1Wins;

            if (
                winnerWins !== needed ||
                loserWins < 0 ||
                loserWins >= needed ||
                p1Wins < 0 ||
                p2Wins < 0
            ) {
                return {
                    success: false,
                    message: `Series score must give the winner exactly ${needed} game(s)`
                };
            }
        } else {
            p1Wins = winnerId === match.Player1Id ? needed : 0;
            p2Wins = winnerId === match.Player2Id ? needed : 0;
        }

        // ARCHON (N9): a paper result is a game played across a table, typed
        // in afterwards. Allowed only where the event says so - on a purely
        // online event with no opt-in, a typed result is a claim about a game
        // the platform could have witnessed and did not.
        const isPaper = scores.source === 'paper';

        if (isPaper && !tournament.AllowPaperResults) {
            return {
                success: false,
                message: 'This event does not accept results reported from paper play'
            };
        }

        if (alreadyDecided && match.Bracket) {
            await this.clearDownstream(tournament, match);
        }

        // ARCHON: whose word this result stands on.
        //
        // An organizer or judge is the adjudicator, so their entry is final.
        // A player reporting their own LOSS needs no second signature - people
        // do not falsely concede. A player reporting their own WIN is the case
        // that needs the opponent, and it is the only case that ever mattered:
        // before this, one player could type in a win and the other had no way
        // to say otherwise except finding a human.
        //
        // The unconfirmed result still counts (see the migration for why), so
        // the round is never held hostage - it is simply marked as one player's
        // account rather than an agreed fact.
        const reportedOwnLoss = isParticipant && winnerId !== actor.id;
        const confirmed = isManager || reportedOwnLoss;

        await this.completeMatch(tournament, match, {
            winnerId,
            resultType: 'played',
            reporterId: actor.id,
            p1Wins,
            p2Wins,
            resultSource: isPaper ? 'paper' : 'online',
            confirmed,
            confirmedBy: actor.id
        });

        return { success: true, confirmed };
    }

    /**
     * The opponent agrees with a reported result.
     *
     * Only the player who did NOT report it can confirm - a second click by
     * the reporter would be them agreeing with themselves, which is what the
     * confirmation exists to rule out.
     */
    async confirmResult(tournamentId, matchId, actor) {
        const tournament = await this.getTournamentRow(tournamentId);

        if (!tournament) {
            return { success: false, message: 'No such tournament' };
        }

        const match = await this.getMatchRow(tournamentId, matchId);

        if (!match) {
            return { success: false, message: 'No such match' };
        }

        if (!match.WinnerId && !match.ResultType) {
            return { success: false, message: 'There is no result to confirm yet' };
        }

        const isParticipant = actor.id === match.Player1Id || actor.id === match.Player2Id;

        if (!isParticipant) {
            return { success: false, message: 'Only the players in this match can confirm it' };
        }

        if (match.ReportedBy === actor.id) {
            return {
                success: false,
                message: 'Your opponent has to confirm the result you reported'
            };
        }

        await this.db.query(
            'UPDATE "TournamentMatches" SET "ConfirmedBy" = $2, ' +
                '"ConfirmedAt" = now() AT TIME ZONE \'utc\', ' +
                '"DisputedBy" = NULL, "DisputedAt" = NULL, "DisputeNote" = NULL ' +
                'WHERE "Id" = $1',
            [match.Id, actor.id]
        );

        return { success: true };
    }

    /**
     * The opponent says the recorded result is wrong.
     *
     * This deliberately does NOT reverse anything. A dispute is a claim, not a
     * ruling, and letting either player un-report a result by objecting would
     * just move the abuse to the other side. It raises a flag the organizer can
     * see and act on, and unlocks the match for them to correct.
     */
    async disputeResult(tournamentId, matchId, actor, note) {
        const tournament = await this.getTournamentRow(tournamentId);

        if (!tournament) {
            return { success: false, message: 'No such tournament' };
        }

        const match = await this.getMatchRow(tournamentId, matchId);

        if (!match) {
            return { success: false, message: 'No such match' };
        }

        if (!match.WinnerId && !match.ResultType) {
            return { success: false, message: 'There is no result to dispute yet' };
        }

        const isParticipant = actor.id === match.Player1Id || actor.id === match.Player2Id;

        if (!isParticipant) {
            return { success: false, message: 'Only the players in this match can dispute it' };
        }

        if (match.ReportedBy === actor.id) {
            return { success: false, message: 'You reported this result yourself' };
        }

        await this.db.query(
            'UPDATE "TournamentMatches" SET "DisputedBy" = $2, ' +
                '"DisputedAt" = now() AT TIME ZONE \'utc\', "DisputeNote" = $3, ' +
                '"ConfirmedBy" = NULL, "ConfirmedAt" = NULL WHERE "Id" = $1',
            [match.Id, actor.id, (note || '').toString().slice(0, 500) || null]
        );

        return { success: true };
    }

    /**
     * A recorded bracket result is locked once any downstream match has
     * a played (non-walkover) result.
     */
    async bracketResultLocked(tournament, match) {
        const matches = await this.getMatches(tournament.Id);
        const queue = [match.Id];
        const seen = new Set(queue);

        while (queue.length > 0) {
            const current = queue.shift();
            const dependents = matches.filter(
                (row) => row.P1SourceMatchId === current || row.P2SourceMatchId === current
            );

            for (const dependent of dependents) {
                if (
                    (dependent.WinnerId || dependent.ResultType) &&
                    dependent.ResultType !== 'bye'
                ) {
                    return true;
                }

                if (!seen.has(dependent.Id)) {
                    seen.add(dependent.Id);
                    queue.push(dependent.Id);
                }
            }
        }

        return false;
    }

    /**
     * Reset downstream slots fed by a corrected bracket match so
     * propagation can re-fill them (only reachable when nothing
     * downstream has been played yet).
     */
    async clearDownstream(tournament, match) {
        const matches = await this.getMatches(tournament.Id);
        const queue = [match.Id];

        while (queue.length > 0) {
            const current = queue.shift();
            const dependents = matches.filter(
                (row) => row.P1SourceMatchId === current || row.P2SourceMatchId === current
            );

            for (const dependent of dependents) {
                let touched = false;

                if (dependent.P1SourceMatchId === current && dependent.Player1Id) {
                    dependent.Player1Id = null;
                    touched = true;
                    await this.db.query(
                        'UPDATE "TournamentMatches" SET "Player1Id" = NULL WHERE "Id" = $1',
                        [dependent.Id]
                    );
                }

                if (dependent.P2SourceMatchId === current && dependent.Player2Id) {
                    dependent.Player2Id = null;
                    touched = true;
                    await this.db.query(
                        'UPDATE "TournamentMatches" SET "Player2Id" = NULL WHERE "Id" = $1',
                        [dependent.Id]
                    );
                }

                if (touched && dependent.ResultType === 'bye') {
                    dependent.WinnerId = null;
                    dependent.ResultType = null;
                    await this.db.query(
                        'UPDATE "TournamentMatches" SET "WinnerId" = NULL, "ResultType" = NULL, ' +
                            '"ReportedAt" = NULL WHERE "Id" = $1',
                        [dependent.Id]
                    );
                    queue.push(dependent.Id);
                }
            }
        }
    }

    /**
     * Organizer tools: award a win (forfeit / no-show) on an open match.
     */
    async awardWin(tournamentId, matchId, winnerId, actor, resultType = 'forfeit') {
        const tournament = await this.getTournamentRow(tournamentId);

        if (!tournament) {
            return { success: false, message: 'No such tournament' };
        }

        if (tournament.Status !== 'active') {
            return { success: false, message: 'Tournament is not active' };
        }

        if (!(await this.canManage(actor, tournament))) {
            return { success: false, message: 'Only the organizer can award wins' };
        }

        if (!['forfeit', 'no-show'].includes(resultType)) {
            return { success: false, message: 'Unknown award type' };
        }

        const match = await this.getMatchRow(tournamentId, matchId);

        if (!match) {
            return { success: false, message: 'No such match' };
        }

        if (!match.Player1Id || !match.Player2Id) {
            return { success: false, message: 'Both players must be known to award a win' };
        }

        if (winnerId !== match.Player1Id && winnerId !== match.Player2Id) {
            return { success: false, message: 'Winner must be one of the match players' };
        }

        // ARCHON: an organizer ruling on a match that already has a result is
        // adjudicating, not reporting - the same authority reportResult
        // already grants them over a recorded result.
        //
        // Refusing here did not protect anything. It just meant that when a
        // dispute turned out to be "my opponent never showed up", the correct
        // outcome was unrecordable: the only lever left was re-reporting a
        // normal played win, which puts a false result type into the record
        // the standings and the audit are built from, and pays out Chainbound
        // chains for a game nobody played.
        const decided = !!match.WinnerId || !!match.ResultType;

        if (decided && match.Bracket && (await this.bracketResultLocked(tournament, match))) {
            return {
                success: false,
                message: 'Later bracket matches already have results - correct those first'
            };
        }

        if (decided && match.Bracket) {
            await this.clearDownstream(tournament, match);
        }

        // An award supersedes whatever series score was on the row: the match
        // was not played out, so the games recorded against it are not the
        // result any more.
        const needed = matchWinsNeeded(match.BestOf);

        await this.completeMatch(tournament, match, {
            winnerId,
            resultType,
            reporterId: actor.id,
            p1Wins: winnerId === match.Player1Id ? needed : 0,
            p2Wins: winnerId === match.Player2Id ? needed : 0
        });

        return { success: true };
    }

    /**
     * Organizer tools: record a double loss (both players lose the
     * match; not available in elimination brackets).
     */
    async doubleLoss(tournamentId, matchId, actor) {
        const tournament = await this.getTournamentRow(tournamentId);

        if (!tournament) {
            return { success: false, message: 'No such tournament' };
        }

        if (tournament.Status !== 'active') {
            return { success: false, message: 'Tournament is not active' };
        }

        if (!(await this.canManage(actor, tournament))) {
            return { success: false, message: 'Only the organizer can record a double loss' };
        }

        const match = await this.getMatchRow(tournamentId, matchId);

        if (!match) {
            return { success: false, message: 'No such match' };
        }

        if (match.Bracket) {
            return {
                success: false,
                message: 'Elimination matches need a winner - award a win instead'
            };
        }

        if (!match.Player1Id || !match.Player2Id) {
            return { success: false, message: 'Byes cannot take a double loss' };
        }

        // ARCHON: as with awardWin - an organizer ruling that a disputed match
        // was nobody's win is adjudicating a result, not competing with one.
        // Brackets are already excluded above, so there is no downstream to
        // clear here.

        await this.completeMatch(tournament, match, {
            winnerId: null,
            resultType: 'double-loss',
            reporterId: actor.id,
            p1Wins: 0,
            p2Wins: 0
        });

        return { success: true };
    }

    /**
     * ARCHON (N9): Archon Adaptive Bo3.
     *
     * The official three-game series:
     *   Game 1 - each player pilots their own registered deck.
     *   Game 2 - the decks swap. A player who wins both has beaten the
     *            opponent with each deck and takes the match 2-0.
     *   Game 3 - only reached at 1-1, where each deck has won once and the
     *            question is which is stronger. Players bid CHAINS for the
     *            right to pilot one nominated deck; the bid is a handicap, so
     *            bidding higher means claiming you can win with that deck even
     *            burdened. The loser of game 2 opens the bidding, and a pass
     *            hands the deck to the standing high bidder at their own bid.
     *
     * The negotiation lives on the match row rather than in memory because it
     * happens between games, across reconnects and page reloads, and an
     * organizer standing at the table has to be able to see where it got to.
     */
    adaptiveGameNumber(match) {
        return (match.Player1Wins || 0) + (match.Player2Wins || 0) + 1;
    }

    /**
     * Which deck each player pilots for a given game, before any bid. Game 3
     * is deliberately absent: it is whatever the bid decides.
     */
    adaptiveDecksForGame(match, gameNumber) {
        if (gameNumber === 1) {
            return { [match.Player1Id]: 'own', [match.Player2Id]: 'own' };
        }

        if (gameNumber === 2) {
            return { [match.Player1Id]: 'opponent', [match.Player2Id]: 'opponent' };
        }

        return null;
    }

    async adaptiveContext(tournamentId, matchId, actor) {
        const tournament = await this.getTournamentRow(tournamentId);

        if (!tournament) {
            return { error: 'No such tournament' };
        }

        if (!tournament.AdaptiveBo3) {
            return { error: 'This event is not Adaptive' };
        }

        const match = await this.getMatchRow(tournamentId, matchId);

        if (!match) {
            return { error: 'No such match' };
        }

        if (!match.Player1Id || !match.Player2Id) {
            return { error: 'Byes have no series' };
        }

        if (actor.id !== match.Player1Id && actor.id !== match.Player2Id) {
            const isManager = await this.canManage(actor, tournament);

            if (!isManager) {
                return { error: 'You are not in this match' };
            }
        }

        return { tournament, match };
    }

    async getAdaptiveState(tournamentId, matchId, actor) {
        const context = await this.adaptiveContext(tournamentId, matchId, actor);

        if (context.error) {
            return { success: false, message: context.error };
        }

        const { match } = context;
        const gameNumber = this.adaptiveGameNumber(match);
        const state = this.parseJsonColumn(match.AdaptiveState) || {};

        return {
            success: true,
            gameNumber,
            decks: this.adaptiveDecksForGame(match, gameNumber),
            // Bidding only exists at 1-1 going into game 3.
            bidding:
                gameNumber === 3
                    ? {
                          bidDeckOwnerId: state.bidDeckOwnerId ?? match.Player1Id,
                          currentBid: state.currentBid ?? 0,
                          highBidderId: state.highBidderId ?? null,
                          turnUserId: state.turnUserId ?? this.adaptiveFirstBidder(match),
                          resolved: !!state.resolved,
                          chains: state.chains || null,
                          decks: state.decks || null
                      }
                    : null
        };
    }

    /** The loser of game 2 opens the bidding. */
    adaptiveFirstBidder(match) {
        const p1 = match.Player1Wins || 0;
        const p2 = match.Player2Wins || 0;

        if (p1 === p2) {
            // 1-1 with no recorded order: player 1 opens by convention.
            return match.Player1Id;
        }

        return p1 > p2 ? match.Player2Id : match.Player1Id;
    }

    async saveAdaptiveState(matchId, state) {
        await this.db.query('UPDATE "TournamentMatches" SET "AdaptiveState" = $2 WHERE "Id" = $1', [
            matchId,
            JSON.stringify(state)
        ]);
    }

    async adaptiveBid(tournamentId, matchId, actor, chains) {
        const context = await this.adaptiveContext(tournamentId, matchId, actor);

        if (context.error) {
            return { success: false, message: context.error };
        }

        const { match } = context;

        if (this.adaptiveGameNumber(match) !== 3) {
            return { success: false, message: 'Bidding only happens before game three' };
        }

        const state = this.parseJsonColumn(match.AdaptiveState) || {};

        if (state.resolved) {
            return { success: false, message: 'The bid is already settled' };
        }

        const turnUserId = state.turnUserId ?? this.adaptiveFirstBidder(match);

        if (actor.id !== turnUserId) {
            return { success: false, message: 'It is not your turn to bid' };
        }

        const bid = parseInt(chains, 10);
        const currentBid = state.currentBid ?? 0;

        // A bid is a handicap you take on, so it only ever goes up - and it
        // has to actually beat the standing one or the auction never ends.
        if (Number.isNaN(bid) || bid < 0 || bid > 24) {
            return { success: false, message: 'Bid must be between 0 and 24 chains' };
        }

        if (state.highBidderId && bid <= currentBid) {
            return { success: false, message: `Bid must be more than ${currentBid} chains` };
        }

        const opponentId = actor.id === match.Player1Id ? match.Player2Id : match.Player1Id;

        const next = {
            ...state,
            bidDeckOwnerId: state.bidDeckOwnerId ?? match.Player1Id,
            currentBid: bid,
            highBidderId: actor.id,
            turnUserId: opponentId,
            resolved: false
        };

        await this.saveAdaptiveState(match.Id, next);

        return { success: true, currentBid: bid, turnUserId: opponentId };
    }

    async adaptivePass(tournamentId, matchId, actor) {
        const context = await this.adaptiveContext(tournamentId, matchId, actor);

        if (context.error) {
            return { success: false, message: context.error };
        }

        const { match } = context;

        if (this.adaptiveGameNumber(match) !== 3) {
            return { success: false, message: 'Bidding only happens before game three' };
        }

        const state = this.parseJsonColumn(match.AdaptiveState) || {};

        if (state.resolved) {
            return { success: false, message: 'The bid is already settled' };
        }

        const turnUserId = state.turnUserId ?? this.adaptiveFirstBidder(match);

        if (actor.id !== turnUserId) {
            return { success: false, message: 'It is not your turn' };
        }

        if (!state.highBidderId) {
            // Nobody has bid. Passing first concedes the choice: the opponent
            // takes the nominated deck at zero chains rather than the series
            // deadlocking on two players who both refuse to open.
            const opponentId = actor.id === match.Player1Id ? match.Player2Id : match.Player1Id;
            const bidDeckOwnerId = state.bidDeckOwnerId ?? match.Player1Id;

            const resolved = {
                ...state,
                bidDeckOwnerId,
                currentBid: 0,
                highBidderId: opponentId,
                turnUserId: null,
                resolved: true,
                chains: { [opponentId]: 0, [actor.id]: 0 },
                decks: {
                    [opponentId]: bidDeckOwnerId,
                    [actor.id]:
                        bidDeckOwnerId === match.Player1Id ? match.Player2Id : match.Player1Id
                }
            };

            await this.saveAdaptiveState(match.Id, resolved);

            return { success: true, resolved: true, winnerOfBid: opponentId, chains: 0 };
        }

        const bidDeckOwnerId = state.bidDeckOwnerId ?? match.Player1Id;
        const otherDeckOwnerId =
            bidDeckOwnerId === match.Player1Id ? match.Player2Id : match.Player1Id;

        const resolved = {
            ...state,
            turnUserId: null,
            resolved: true,
            // The high bidder pilots the nominated deck carrying the chains
            // they bid; the other player takes the remaining deck unchained.
            chains: { [state.highBidderId]: state.currentBid ?? 0, [actor.id]: 0 },
            decks: { [state.highBidderId]: bidDeckOwnerId, [actor.id]: otherDeckOwnerId }
        };

        await this.saveAdaptiveState(match.Id, resolved);

        return {
            success: true,
            resolved: true,
            winnerOfBid: state.highBidderId,
            chains: state.currentBid ?? 0
        };
    }

    /**
     * Triad: shared guards for ban/pick actions.
     */
    async triadMatchContext(tournamentId, matchId, actor) {
        const tournament = await this.getTournamentRow(tournamentId);

        if (!tournament) {
            return { error: 'No such tournament' };
        }

        if (!tournament.Triad || tournament.Status !== 'active') {
            return { error: 'This match has no Triad deck step' };
        }

        const match = await this.getMatchRow(tournamentId, matchId);

        if (!match || !match.Player1Id || !match.Player2Id) {
            return { error: 'No such match' };
        }

        if (match.WinnerId || match.ResultType) {
            return { error: 'This match already has a result' };
        }

        const isP1 = actor.id === match.Player1Id;
        const isP2 = actor.id === match.Player2Id;

        if (!isP1 && !isP2) {
            return { error: 'Only the paired players choose Triad decks' };
        }

        const pools = await this.getTriadPools(tournamentId);

        return { tournament, match, isP1, pools };
    }

    /**
     * Triad step 1: ban one of your opponent's three decks. Both bans
     * are independent and immutable once made.
     */
    async triadBan(tournamentId, matchId, actor, deckId) {
        const context = await this.triadMatchContext(tournamentId, matchId, actor);

        if (context.error) {
            return { success: false, message: context.error };
        }

        const { match, isP1, pools } = context;
        const opponentId = isP1 ? match.Player2Id : match.Player1Id;
        const banColumn = isP1 ? 'P2BannedDeckId' : 'P1BannedDeckId';

        if (match[banColumn]) {
            return { success: false, message: 'You already banned a deck for this match' };
        }

        const target = parseInt(deckId, 10);
        const opponentPool = pools[opponentId] || [];

        if (!opponentPool.some((entry) => entry.deckId === target)) {
            return { success: false, message: "Pick one of your opponent's three decks" };
        }

        await this.db.query(`UPDATE "TournamentMatches" SET "${banColumn}" = $2 WHERE "Id" = $1`, [
            match.Id,
            target
        ]);

        return { success: true };
    }

    /**
     * Triad step 2: once your opponent has banned, pilot one of your
     * two remaining decks. When both players have chosen, the online
     * table game is created with those decks.
     */
    async triadPick(tournamentId, matchId, actor, deckId) {
        const context = await this.triadMatchContext(tournamentId, matchId, actor);

        if (context.error) {
            return { success: false, message: context.error };
        }

        const { tournament, match, isP1, pools } = context;
        const ownBanColumn = isP1 ? 'P1BannedDeckId' : 'P2BannedDeckId';
        const pickColumn = isP1 ? 'P1DeckId' : 'P2DeckId';
        const otherPick = isP1 ? match.P2DeckId : match.P1DeckId;

        if (!match[ownBanColumn]) {
            return {
                success: false,
                message: 'Wait for your opponent to ban one of your decks first'
            };
        }

        if (match[pickColumn]) {
            return { success: false, message: 'You already chose your deck for this match' };
        }

        const target = parseInt(deckId, 10);
        const ownPool = pools[actor.id] || [];

        if (!ownPool.some((entry) => entry.deckId === target)) {
            return { success: false, message: 'Pick one of your own three decks' };
        }

        if (target === match[ownBanColumn]) {
            return { success: false, message: 'That deck was banned for this match' };
        }

        await this.db.query(`UPDATE "TournamentMatches" SET "${pickColumn}" = $2 WHERE "Id" = $1`, [
            match.Id,
            target
        ]);

        if (otherPick) {
            // Both decks chosen - the lobby can now build the table.
            this.emitRoundPaired(tournament.Id);
        }

        return { success: true };
    }

    /**
     * Final placements when an event finishes.
     *
     * Elimination stages rank by how deep a player survived (latest
     * elimination wave first; champion on top), sharing placements for
     * same-wave exits. Swiss-only and round-robin events rank straight
     * from the standings; with a playoff cut, non-qualified players rank
     * below the bracket players by Swiss standings.
     */
    async computeFinalRanks(tournament) {
        const [players, matches] = await Promise.all([
            this.getPlayers(tournament.Id),
            this.getMatches(tournament.Id)
        ]);

        const competitors = players.filter((player) => !player.Waitlisted);
        const standings = computeStandings(
            competitors.map((player) => ({ id: player.UserId })),
            this.matchesForStandings(matches)
        );

        const bracketMatches = matches.filter((match) => match.Bracket);

        if (bracketMatches.length === 0) {
            return standings.map((entry) => ({ userId: entry.id, rank: entry.rank }));
        }

        // Elimination wave per bracket player: the wave of the match
        // that knocked them out (double elim players survive W losses).
        const inBracket = new Set();
        const eliminatedAt = {};

        for (const match of bracketMatches) {
            for (const playerId of [match.Player1Id, match.Player2Id]) {
                if (playerId) {
                    inBracket.add(playerId);
                }
            }
        }

        const isDouble = bracketMatches.some((match) => match.Bracket === 'L');
        const gfMatches = bracketMatches
            .filter((match) => match.Bracket === 'GF')
            .sort((a, b) => (a.BracketRound || 1) - (b.BracketRound || 1));
        const lastGf = gfMatches[gfMatches.length - 1];

        let champion = null;

        if (isDouble) {
            champion = lastGf?.WinnerId || null;

            for (const match of bracketMatches) {
                const loser =
                    match.WinnerId && match.Player2Id
                        ? match.WinnerId === match.Player1Id
                            ? match.Player2Id
                            : match.Player1Id
                        : null;

                if (!loser) {
                    continue;
                }

                if (match.Bracket === 'L') {
                    eliminatedAt[loser] = Math.max(eliminatedAt[loser] || 0, match.Round);
                } else if (match.Bracket === 'GF' && match.Id === lastGf?.Id) {
                    eliminatedAt[loser] = Math.max(eliminatedAt[loser] || 0, match.Round);
                }
            }
        } else {
            const finalMatch = [...bracketMatches]
                .filter((match) => match.Bracket === 'W')
                .sort((a, b) => (a.BracketRound || 1) - (b.BracketRound || 1))
                .pop();

            champion = finalMatch?.WinnerId || null;

            for (const match of bracketMatches) {
                const loser =
                    match.WinnerId && match.Player2Id
                        ? match.WinnerId === match.Player1Id
                            ? match.Player2Id
                            : match.Player1Id
                        : null;

                if (loser) {
                    eliminatedAt[loser] = Math.max(eliminatedAt[loser] || 0, match.Round);
                }
            }
        }

        const bracketPlayers = [...inBracket];

        bracketPlayers.sort((a, b) => {
            const aScore = a === champion ? Number.MAX_SAFE_INTEGER : eliminatedAt[a] || 0;
            const bScore = b === champion ? Number.MAX_SAFE_INTEGER : eliminatedAt[b] || 0;

            return bScore - aScore;
        });

        const ranks = [];
        let index = 0;

        while (index < bracketPlayers.length) {
            const score =
                bracketPlayers[index] === champion
                    ? Number.MAX_SAFE_INTEGER
                    : eliminatedAt[bracketPlayers[index]] || 0;

            let groupEnd = index;
            while (
                groupEnd + 1 < bracketPlayers.length &&
                (bracketPlayers[groupEnd + 1] === champion
                    ? Number.MAX_SAFE_INTEGER
                    : eliminatedAt[bracketPlayers[groupEnd + 1]] || 0) === score
            ) {
                groupEnd++;
            }

            for (let cursor = index; cursor <= groupEnd; cursor++) {
                ranks.push({ userId: bracketPlayers[cursor], rank: index + 1 });
            }

            index = groupEnd + 1;
        }

        // Everyone outside the bracket ranks below it by standings.
        let nextRank = bracketPlayers.length + 1;

        for (const entry of standings) {
            if (!inBracket.has(entry.id)) {
                ranks.push({ userId: entry.id, rank: nextRank });
                nextRank++;
            }
        }

        return ranks;
    }

    async finish(tournamentId, actor, options = {}) {
        const tournament = await this.getTournamentRow(tournamentId);

        if (!tournament) {
            return { success: false, message: 'No such tournament' };
        }

        if (!(await this.canManage(actor, tournament))) {
            return { success: false, message: 'Only the organizer can finish the event' };
        }

        if (tournament.Status !== 'active') {
            return { success: false, message: 'Tournament is not active' };
        }

        if (!(await this.roundComplete(tournamentId, tournament.CurrentRound))) {
            return { success: false, message: 'The current round still has unreported results' };
        }

        if (await this.hasBracketMatches(tournamentId)) {
            const matches = await this.getMatches(tournamentId);
            const unresolved = matches.filter(
                (match) => match.Bracket && !match.WinnerId && !match.ResultType
            );

            if (unresolved.length > 0) {
                return {
                    success: false,
                    message: 'The bracket still has undecided matches'
                };
            }
        } else if (
            !options.force &&
            tournament.RoundCount &&
            tournament.CurrentRound < tournament.RoundCount
        ) {
            // ARCHON: finishing is the one organizer action with no way back.
            // It stamps a FinalRank on every player, publishes those to the
            // profile trophy walls and rates the team ladder; nothing reopens
            // a complete event, and cancel() refuses one outright. The button
            // sits in the same row as "Pair Next Round" - the button pressed
            // at the end of every round - so mid-event a slipped click is the
            // likely input rather than the intended one.
            //
            // Ending early is legitimate (the venue closes, the room empties),
            // so this is a confirmation gate and not a ban: the client re-asks
            // and sends it again with force. Bracket events are left alone,
            // because the completeness check above is already stronger.
            return {
                success: false,
                earlyFinish: true,
                roundsPlayed: tournament.CurrentRound,
                roundsPlanned: tournament.RoundCount,
                message: `Only ${tournament.CurrentRound} of ${tournament.RoundCount} rounds have been played`
            };
        }

        const ranks = await this.computeFinalRanks(tournament);

        for (const entry of ranks) {
            await this.db.query(
                'UPDATE "TournamentPlayers" SET "FinalRank" = $3 WHERE "TournamentId" = $1 AND "UserId" = $2',
                [tournamentId, entry.userId, entry.rank]
            );
        }

        await this.db.query(
            'UPDATE "Tournaments" SET "Status" = \'complete\', ' +
                '"FinishedAt" = now() AT TIME ZONE \'utc\' WHERE "Id" = $1',
            [tournamentId]
        );

        logger.info(`Tournament ${tournamentId} finished by user ${actor.id}`);

        // ARCHON (N7): rate the team ladder from the final standings. The
        // event is already marked complete above, so a rating failure leaves a
        // finished event that is not team-rated - which an organizer can
        // retry - rather than an event stuck mid-finish.
        let teamRating = null;

        if (tournament.TeamEvent && this.teamRatingService) {
            try {
                teamRating = await this.teamRatingService.rateEvent(
                    tournamentId,
                    tournament.GameFormat
                );
            } catch (err) {
                logger.error(`Failed to rate team event ${tournamentId}`, err);
            }
        }

        return { success: true, teamRating };
    }

    async cancel(tournamentId, actor) {
        const tournament = await this.getTournamentRow(tournamentId);

        if (!tournament) {
            return { success: false, message: 'No such tournament' };
        }

        if (!(await this.canManage(actor, tournament))) {
            return { success: false, message: 'Only the organizer can cancel the event' };
        }

        if (tournament.Status === 'complete') {
            return { success: false, message: 'Completed tournaments cannot be cancelled' };
        }

        await this.db.query('UPDATE "Tournaments" SET "Status" = \'cancelled\' WHERE "Id" = $1', [
            tournamentId
        ]);

        return { success: true };
    }

    /**
     * A player's completed-event record for profiles and trophy walls.
     */
    async history(username) {
        const rows = await this.db.query(
            'SELECT t."Id", t."Name", t."Format", t."GameFormat", t."Mode", t."FinishedAt", ' +
                'tp."FinalRank", ' +
                '(SELECT COUNT(*) FROM "TournamentPlayers" x WHERE x."TournamentId" = t."Id" AND NOT x."Waitlisted") AS "PlayerCount" ' +
                'FROM "TournamentPlayers" tp ' +
                'JOIN "Tournaments" t ON t."Id" = tp."TournamentId" ' +
                'JOIN "Users" u ON u."Id" = tp."UserId" ' +
                'WHERE u."Username" = $1 AND t."Status" = \'complete\' ' +
                'ORDER BY t."FinishedAt" DESC NULLS LAST LIMIT 50',
            [username]
        );

        return (rows || []).map((row) => ({
            id: row.Id,
            name: row.Name,
            format: row.Format,
            gameFormat: row.GameFormat,
            mode: row.Mode,
            finishedAt: row.FinishedAt,
            finalRank: row.FinalRank,
            playerCount: parseInt(row.PlayerCount, 10)
        }));
    }

    // ------------------------------------------------------------------
    // Online automation (lobby bridge)
    // ------------------------------------------------------------------

    /**
     * Current-round matches of an online event that still need a lobby
     * game, with everything the lobby needs to build them.
     */
    async getMatchesNeedingGames(tournamentId, { forPairing = false } = {}) {
        const tournament = await this.getTournamentRow(tournamentId);

        if (
            !tournament ||
            tournament.Status !== 'active' ||
            !PLATFORM_MODES.includes(tournament.Mode) ||
            !this.getConfig().autoCreateGames
        ) {
            return [];
        }

        // ARCHON (N14): an async round is played out over days. Opening every
        // table the moment the round is paired would park a lobby game per
        // match that nobody will sit at until their scheduled time - so async
        // events only open tables on demand ("Open my table" or the judge
        // tool) and for the next game of a series already underway.
        //
        // ARCHON: a hybrid event is the same argument for a different reason.
        // Some of its pairings are being played across a table with cards, and
        // there is no way to know which from here - so it opens tables on
        // demand too, rather than parking a lobby game nobody will ever sit at
        // for every match played on paper.
        if (forPairing && (tournament.Pacing === 'async' || tournament.Mode === 'hybrid')) {
            return [];
        }

        const [matches, players, gameRows] = await Promise.all([
            this.getMatches(tournamentId),
            this.getPlayers(tournamentId),
            this.db.query(
                'SELECT "MatchId", "GameNumber", "GameUuid", "WinnerId" FROM "TournamentMatchGames" ' +
                    'WHERE "TournamentId" = $1 ORDER BY "MatchId", "GameNumber"',
                [tournamentId]
            )
        ]);

        const playerById = {};
        for (const player of players) {
            playerById[player.UserId] = player;
        }

        const gamesByMatch = {};
        for (const row of gameRows || []) {
            (gamesByMatch[row.MatchId] = gamesByMatch[row.MatchId] || []).push(row);
        }

        const config = this.getConfig();
        const playable = matches.filter(
            (match) =>
                match.Round === tournament.CurrentRound &&
                !match.WinnerId &&
                !match.ResultType &&
                match.Player1Id &&
                match.Player2Id &&
                // Triad matches wait for both ban/pick steps.
                (!tournament.Triad || (match.P1DeckId && match.P2DeckId)) &&
                // ARCHON (N9): game three of an Adaptive Bo3 waits for the
                // chain bid, because the bid is what decides which deck each
                // seat plays. Opening the table first would deal decks the bid
                // is about to contradict - and the deck lock would then hold
                // the players to the wrong ones.
                //
                // This does mean a pair who neither bid nor pass leave their
                // table unopened and the round waiting on them. That is the
                // right trade against dealing the wrong decks, and the
                // organizer can still award or take a paper result - but it is
                // a new way for a round to sit still.
                (!tournament.AdaptiveBo3 ||
                    (match.Player1Wins || 0) + (match.Player2Wins || 0) + 1 !== 3 ||
                    this.parseJsonColumn(match.AdaptiveState)?.resolved === true)
        );

        // SAS lookup for the decks actually being piloted (triad picks
        // can differ from the registered deck on the player row).
        const nextGameNumber = (match) => (match.Player1Wins || 0) + (match.Player2Wins || 0) + 1;

        const registeredDeckFor = (match, side) =>
            playerById[side === 1 ? match.Player1Id : match.Player2Id]?.DeckId || null;

        const adaptiveStateFor = (match) =>
            (tournament.AdaptiveBo3 && this.parseJsonColumn(match.AdaptiveState)) || {};

        /**
         * ARCHON (N9): in an Adaptive Bo3 the DECKS move between seats, so
         * which deck a seat plays is a function of the game number rather than
         * of the player row: game one your own, game two your opponent's, game
         * three whatever the chain bid settled.
         *
         * This is the only place that swap can happen. The lobby pins whatever
         * comes back from here and the deck lock then enforces it - so a swap
         * the event page promises and this function does not deliver is a swap
         * the table actively refuses, which is exactly what it did: the format
         * was offered, the bidding UI worked, and every game dealt the decks
         * the players registered.
         */
        const deckIdFor = (match, side, gameNumber) => {
            if (tournament.Triad) {
                return side === 1 ? match.P1DeckId : match.P2DeckId;
            }

            if (!tournament.AdaptiveBo3) {
                return registeredDeckFor(match, side);
            }

            // Game one is own decks; game two is the straight swap.
            if (gameNumber === 1) {
                return registeredDeckFor(match, side);
            }

            if (gameNumber === 2) {
                return registeredDeckFor(match, side === 1 ? 2 : 1);
            }

            // Game three: the bid decides. decks maps each PLAYER to the id of
            // the player whose deck they pilot.
            const state = adaptiveStateFor(match);
            const playerId = side === 1 ? match.Player1Id : match.Player2Id;
            const ownerId = state.decks?.[playerId];

            if (!ownerId) {
                return null;
            }

            return registeredDeckFor(match, ownerId === match.Player1Id ? 1 : 2);
        };

        const sasByDeckId = {};

        if (tournament.SasChainHandicap) {
            const deckIds = [
                ...new Set(
                    playable
                        .flatMap((match) => {
                            const gameNumber = nextGameNumber(match);

                            return [
                                deckIdFor(match, 1, gameNumber),
                                deckIdFor(match, 2, gameNumber)
                            ];
                        })
                        .filter((id) => !!id)
                )
            ];

            if (deckIds.length > 0) {
                const sasRows = await this.db.query(
                    'SELECT d."Id", ds."SasRating" FROM "Decks" d ' +
                        'LEFT JOIN "DeckSas" ds ON ds."Uuid" = d."Uuid" WHERE d."Id" = ANY($1)',
                    [deckIds]
                );

                for (const row of sasRows || []) {
                    sasByDeckId[row.Id] = row.SasRating;
                }
            }
        }

        return playable.map((match) => {
            const games = gamesByMatch[match.Id] || [];
            const lastDecided = [...games].reverse().find((game) => game.WinnerId);
            const previousWinnerId = lastDecided ? lastDecided.WinnerId : null;

            const gameNumber = nextGameNumber(match);
            const deckIds = [deckIdFor(match, 1, gameNumber), deckIdFor(match, 2, gameNumber)];
            const playerIds = [match.Player1Id, match.Player2Id];

            // Starting chains: SAS handicap (the stronger deck starts
            // chained, KeyForge's official balancing lever) plus any
            // Chainbound accrual from earlier wins this event.
            const startingChains = {};

            for (let side = 0; side < 2; side++) {
                const username = playerById[playerIds[side]]?.Username;

                if (!username) {
                    continue;
                }

                let chains = 0;

                // ARCHON (N9): in Adaptive game three the winning bid IS the
                // handicap - the bidder said what a deck is worth in chains,
                // and that price is the whole mechanism. The SAS handicap is
                // suppressed rather than stacked on top of it: two handicaps
                // for the same imbalance would double-count it.
                const adaptiveChains =
                    gameNumber === 3
                        ? adaptiveStateFor(match).chains?.[playerIds[side]] || 0
                        : null;

                if (adaptiveChains !== null) {
                    chains = adaptiveChains;
                } else if (tournament.SasChainHandicap) {
                    const ownSas = sasByDeckId[deckIds[side]];
                    const oppSas = sasByDeckId[deckIds[1 - side]];

                    if (ownSas != null && oppSas != null && ownSas > oppSas) {
                        const perChain = Math.max(1, config.sasPerChain || 5);
                        chains += Math.floor((ownSas - oppSas) / perChain);
                    }
                }

                if (tournament.ChainsPerMatchWin > 0) {
                    chains += playerById[playerIds[side]]?.EventChains || 0;
                }

                chains = Math.min(chains, config.maxHandicapChains || 24);

                if (chains > 0) {
                    startingChains[username] = chains;
                }
            }

            return {
                tournamentId,
                tournamentName: tournament.Name,
                matchId: match.Id,
                round: match.Round,
                table: match.TableNumber,
                bracket: match.Bracket,
                bestOf: match.BestOf || 1,
                // The lobby speaks in lobby formats ('normal', not 'archon').
                gameFormat: LOBBY_FORMAT_BY_EVENT[tournament.GameFormat] || 'normal',
                hideDecklists: !!tournament.HideDecklists,
                gameTimeLimit: tournament.GameTimeLimit,
                // Which sentence the table uses when it refuses a deck the
                // event did not pin: "locked for the event" and "change it on
                // the event page first" are different instructions.
                deckSwapPolicy: tournament.DeckSwapPolicy || 'locked',
                // ARCHON: a sealed table deals from the event's legal sets.
                // Nothing chosen means the whole sealed pool; the lobby turns
                // these expansion ids into the set codes DeckService wants.
                allowedSets: this.parseJsonColumn(tournament.AllowedSets),
                gameNumber,
                knownGameUuids: games.map((game) => game.GameUuid),
                previousWinner: previousWinnerId ? playerById[previousWinnerId]?.Username : null,
                startingChains: Object.keys(startingChains).length > 0 ? startingChains : null,
                players: playerIds.map((playerId, side) => ({
                    userId: playerId,
                    username: playerById[playerId]?.Username,
                    deckId: deckIds[side]
                }))
            };
        });
    }

    /**
     * Is a match still waiting to be played in the current round? Used
     * by the lobby to retire pending table games whose match has been
     * decided another way (TO award, forfeit, drop) or whose round has
     * moved on.
     */
    async isMatchOpen(tournamentId, matchId) {
        const tournament = await this.getTournamentRow(tournamentId);

        if (!tournament || tournament.Status !== 'active') {
            return false;
        }

        const match = await this.getMatchRow(tournamentId, matchId);

        if (!match || match.WinnerId || match.ResultType) {
            return false;
        }

        return match.Round === tournament.CurrentRound;
    }

    /**
     * Record that the lobby created game N of a match.
     */
    async attachGame(tournamentId, matchId, gameNumber, gameUuid) {
        try {
            await this.db.query(
                'INSERT INTO "TournamentMatchGames" ("TournamentId", "MatchId", "GameNumber", "GameUuid", "CreatedAt") ' +
                    "VALUES ($1, $2, $3, $4, now() AT TIME ZONE 'utc') " +
                    'ON CONFLICT ("MatchId", "GameNumber") DO UPDATE SET "GameUuid" = EXCLUDED."GameUuid" ' +
                    'WHERE "TournamentMatchGames"."WinnerId" IS NULL',
                [tournamentId, matchId, gameNumber, gameUuid]
            );

            return { success: true };
        } catch (err) {
            logger.error(`Failed to attach game ${gameUuid} to match ${matchId}`, err);

            return { success: false };
        }
    }

    /**
     * Auto-report from a finished lobby game (GAMEWIN). Returns whether
     * the match completed, or which series game should be created next.
     */
    async recordGameWin(gameSave) {
        const info = gameSave && gameSave.tournament;

        if (!info || !info.matchId || !info.tournamentId) {
            return { handled: false };
        }

        try {
            const tournament = await this.getTournamentRow(info.tournamentId);

            if (!tournament || tournament.Status !== 'active') {
                return { handled: false };
            }

            const match = await this.getMatchRow(info.tournamentId, info.matchId);

            if (!match || match.WinnerId || match.ResultType) {
                return { handled: false };
            }

            if (!gameSave.winner) {
                return { handled: false };
            }

            const userRows = await this.db.query('SELECT "Id" FROM "Users" WHERE "Username" = $1', [
                gameSave.winner
            ]);
            const winnerId = userRows && userRows[0] && userRows[0].Id;

            if (!winnerId || (winnerId !== match.Player1Id && winnerId !== match.Player2Id)) {
                return { handled: false };
            }

            // Idempotency: each attached game reports at most once.
            const updated = await this.db.query(
                'UPDATE "TournamentMatchGames" SET "WinnerId" = $3 ' +
                    'WHERE "MatchId" = $1 AND "GameUuid" = $2 AND "WinnerId" IS NULL RETURNING "Id"',
                [match.Id, gameSave.gameId, winnerId]
            );

            if (!updated || updated.length === 0) {
                return { handled: true, duplicate: true };
            }

            const p1Wins = (match.Player1Wins || 0) + (winnerId === match.Player1Id ? 1 : 0);
            const p2Wins = (match.Player2Wins || 0) + (winnerId === match.Player2Id ? 1 : 0);
            const needed = matchWinsNeeded(match.BestOf);

            if (p1Wins >= needed || p2Wins >= needed) {
                await this.completeMatch(tournament, match, {
                    winnerId,
                    resultType: 'played',
                    reporterId: null,
                    p1Wins,
                    p2Wins
                });

                logger.info(
                    `Tournament ${tournament.Id} match ${match.Id} auto-reported: winner ${winnerId}`
                );

                return { handled: true, matchComplete: true };
            }

            await this.db.query(
                'UPDATE "TournamentMatches" SET "Player1Wins" = $2, "Player2Wins" = $3 WHERE "Id" = $1',
                [match.Id, p1Wins, p2Wins]
            );

            return {
                handled: true,
                matchComplete: false,
                nextGameNumber: p1Wins + p2Wins + 1
            };
        } catch (err) {
            logger.error('Failed to auto-report tournament game', err);

            return { handled: false };
        }
    }

    /**
     * Participant / organizer request to (re)create the lobby game for
     * a match - the recovery path when a pending game was lost (server
     * restart) or was never spawned. The lobby answers the event.
     */
    async ensureGameForMatch(tournamentId, matchId, actor) {
        const tournament = await this.getTournamentRow(tournamentId);

        if (!tournament) {
            return { success: false, message: 'No such tournament' };
        }

        if (tournament.Status !== 'active' || !PLATFORM_MODES.includes(tournament.Mode)) {
            return { success: false, message: 'This event has no online games to open' };
        }

        const match = await this.getMatchRow(tournamentId, matchId);

        if (!match || !match.Player1Id || !match.Player2Id) {
            return { success: false, message: 'No such match' };
        }

        if (match.WinnerId || match.ResultType) {
            return { success: false, message: 'This match already has a result' };
        }

        const isParticipant = actor.id === match.Player1Id || actor.id === match.Player2Id;

        if (!isParticipant && !(await this.canManage(actor, tournament))) {
            return { success: false, message: 'Only match players can open their table' };
        }

        try {
            // Waited on, not fired and forgotten: the caller is a player who
            // pressed a button and is looking at it. Returning before the table
            // exists is what made them press it again - see tournamentEvents.
            const game = await tournamentEvents.request('ensureMatchGame', {
                tournamentId,
                matchId: match.Id
            });

            if (game && game.id) {
                // The id lets the client walk straight to the table instead of
                // waiting to notice it in the lobby list.
                return { success: true, gameId: game.id };
            }
        } catch (err) {
            logger.error(`Failed to open the table for match ${match.Id}`, err);
        }

        return { success: true };
    }
}

module.exports = TournamentService;
