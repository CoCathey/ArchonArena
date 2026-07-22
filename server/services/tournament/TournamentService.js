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
const MODES = ['online', 'irl'];
const SEED_METHODS = ['registration', 'rating', 'random', 'manual'];
const VISIBILITIES = ['public', 'private'];
const BEST_OF_OPTIONS = [1, 3, 5];

// Join codes skip easily-confused characters (0/O, 1/I/L).
const JOIN_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const JOIN_CODE_LENGTH = 8;

const DEFAULT_TOURNAMENT_CONFIG = {
    // Hard ceiling for per-event player caps.
    maxPlayerCap: 512,
    // Lobby games are created automatically for online events.
    autoCreateGames: true,
    // Organizers may mark events as rated (feeding the Amber engine).
    allowRated: true
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

        return { errors, values: out };
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
                '"SasMax", "HideDecklists", "GameTimeLimit", "CreatedAt") ' +
                'VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, ' +
                '$16, $17, $18, $19, $20, $21, $22, now() AT TIME ZONE \'utc\') RETURNING "Id"',
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
                values.gameTimeLimit
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
                    '"HideDecklists" = $21, "GameTimeLimit" = $22 WHERE "Id" = $1',
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
                    values.gameTimeLimit
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
        }

        if (actor) {
            params.push(actor.id);
            const actorParam = `$${params.length}`;
            const canSeeAll =
                !!actor.permissions?.canManageTournaments || !!actor.permissions?.isAdmin;

            if (!canSeeAll) {
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
                'u."Username" AS "Organizer", ' +
                '(SELECT COUNT(*) FROM "TournamentPlayers" tp WHERE tp."TournamentId" = t."Id" AND NOT tp."Waitlisted") AS "PlayerCount" ' +
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
            organizer: row.Organizer,
            playerCount: parseInt(row.PlayerCount, 10)
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
                'tp."Waitlisted", tp."FinalRank", u."Username", ' +
                'd."Name" AS "DeckName", d."Uuid" AS "DeckUuid", ds."SasRating" ' +
                'FROM "TournamentPlayers" tp JOIN "Users" u ON u."Id" = tp."UserId" ' +
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
                'm."ResultType", u1."Username" AS "Player1", u2."Username" AS "Player2" ' +
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

        const [players, matches, organizerRows, staffRows, gameRows] = await Promise.all([
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
            )
        ]);

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
                checkInOpen: !!tournament.CheckInOpenedAt,
                rated: !!tournament.RatedGames,
                requireDeckRegistration: !!tournament.RequireDeckRegistration,
                sasMin: tournament.SasMin,
                sasMax: tournament.SasMax,
                hideDecklists: !!tournament.HideDecklists,
                gameTimeLimit: tournament.GameTimeLimit,
                organizer: organizerRows[0]?.Username,
                canManage,
                isOrganizer: actor ? actor.id === tournament.OrganizerId : false,
                isRegistered: !!(myRow && !myRow.Dropped),
                isWaitlisted: !!(myRow && myRow.Waitlisted && !myRow.Dropped),
                isCheckedIn: !!(myRow && myRow.CheckedIn),
                myDeckId: myRow?.DeckId || null
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
                amber: ratingById[player.UserId] ?? null,
                deckId: showDeck(player) ? player.DeckId : undefined,
                deckName: showDeck(player) ? player.DeckName : undefined,
                hasDeck: !!player.DeckId,
                deckSas: showDeck(player) ? player.SasRating : undefined
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

        if (tournament.Status !== 'registration') {
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
            const deckCheck = await this.validateDeck(tournament, actor.id, options.deckId);

            if (!deckCheck.success) {
                return deckCheck;
            }
        }

        let waitlisted = false;

        if (tournament.PlayerCap) {
            const rows = await this.db.query(
                'SELECT COUNT(*) AS "Count" FROM "TournamentPlayers" ' +
                    'WHERE "TournamentId" = $1 AND NOT "Waitlisted" AND "UserId" <> $2',
                [tournamentId, actor.id]
            );

            waitlisted = parseInt(rows[0].Count, 10) >= tournament.PlayerCap;
        }

        await this.db.query(
            'INSERT INTO "TournamentPlayers" ("TournamentId", "UserId", "Waitlisted", "DeckId", "CreatedAt") ' +
                "VALUES ($1, $2, $3, $4, now() AT TIME ZONE 'utc') " +
                'ON CONFLICT ("TournamentId", "UserId") DO UPDATE SET "Dropped" = false, ' +
                '"DeckId" = COALESCE(EXCLUDED."DeckId", "TournamentPlayers"."DeckId")',
            [tournamentId, actor.id, waitlisted, options.deckId || null]
        );

        return { success: true, waitlisted };
    }

    async validateDeck(tournament, userId, deckId) {
        const rows = await this.db.query(
            'SELECT d."Id", d."UserId", d."Name", d."Uuid", ds."SasRating" FROM "Decks" d ' +
                'LEFT JOIN "DeckSas" ds ON ds."Uuid" = d."Uuid" WHERE d."Id" = $1',
            [deckId]
        );
        const deck = rows && rows[0];

        if (!deck || deck.UserId !== userId) {
            return { success: false, message: 'That deck is not in your collection' };
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
     * Register or change the deck a player will pilot. Open through the
     * registration window; locked once the event starts (Archon decks
     * are locked for the whole event, per standard rules).
     */
    async registerDeck(tournamentId, actor, deckId) {
        const tournament = await this.getTournamentRow(tournamentId);

        if (!tournament) {
            return { success: false, message: 'No such tournament' };
        }

        if (tournament.Status !== 'registration') {
            return { success: false, message: 'Decks are locked once the event starts' };
        }

        const playerRows = await this.db.query(
            'SELECT * FROM "TournamentPlayers" WHERE "TournamentId" = $1 AND "UserId" = $2',
            [tournamentId, actor.id]
        );

        if (!playerRows || playerRows.length === 0 || playerRows[0].Dropped) {
            return { success: false, message: 'Register for the event first' };
        }

        if (!deckId) {
            await this.db.query(
                'UPDATE "TournamentPlayers" SET "DeckId" = NULL WHERE "TournamentId" = $1 AND "UserId" = $2',
                [tournamentId, actor.id]
            );

            return { success: true };
        }

        const deckCheck = await this.validateDeck(tournament, actor.id, deckId);

        if (!deckCheck.success) {
            return deckCheck;
        }

        await this.db.query(
            'UPDATE "TournamentPlayers" SET "DeckId" = $3 WHERE "TournamentId" = $1 AND "UserId" = $2',
            [tournamentId, actor.id, deckId]
        );

        return { success: true };
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

        await this.db.query(
            'UPDATE "Tournaments" SET "CheckInOpenedAt" = now() AT TIME ZONE \'utc\' WHERE "Id" = $1',
            [tournamentId]
        );

        return { success: true };
    }

    async checkIn(tournamentId, actor) {
        const tournament = await this.getTournamentRow(tournamentId);

        if (!tournament) {
            return { success: false, message: 'No such tournament' };
        }

        if (tournament.Status !== 'registration' || !tournament.CheckInOpenedAt) {
            return { success: false, message: 'Check-in is not open' };
        }

        const rows = await this.db.query(
            'UPDATE "TournamentPlayers" SET "CheckedIn" = true ' +
                'WHERE "TournamentId" = $1 AND "UserId" = $2 AND NOT "Dropped" RETURNING "Id"',
            [tournamentId, actor.id]
        );

        if (!rows || rows.length === 0) {
            return { success: false, message: 'Register for the event first' };
        }

        return { success: true };
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
        const { pairings, bye } = pairSwissRound(ordered);

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

        return {};
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

        const active = players.filter((player) => !player.Dropped && !player.Waitlisted);
        const standings = computeStandings(
            active.map((player) => ({ id: player.UserId })),
            this.matchesForStandings(matches)
        );

        // computeStandings returns entries sorted by standing; keep that
        // order so Swiss pairs within score groups and elim reseeds
        return standings.map((entry) => ({
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

        if (tournament.RequireDeckRegistration) {
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
                '"RoundStartedAt" = now() AT TIME ZONE \'utc\' WHERE "Id" = $1',
            [tournamentId, roundCount]
        );

        logger.info(`Tournament ${tournamentId} started by user ${actor.id}`);

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

    async roundComplete(tournamentId, round) {
        const rows = await this.db.query(
            'SELECT COUNT(*) AS "Unreported" FROM "TournamentMatches" ' +
                'WHERE "TournamentId" = $1 AND "Round" = $2 AND "WinnerId" IS NULL AND "ResultType" IS NULL',
            [tournamentId, round]
        );

        return parseInt(rows[0].Unreported, 10) === 0;
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
                'UPDATE "Tournaments" SET "CurrentRound" = $2, "RoundStartedAt" = now() AT TIME ZONE \'utc\' WHERE "Id" = $1',
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
            'UPDATE "Tournaments" SET "CurrentRound" = $2, "RoundStartedAt" = now() AT TIME ZONE \'utc\' WHERE "Id" = $1',
            [tournamentId, round]
        );

        this.emitRoundPaired(tournamentId);

        return { success: true, round };
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
            'UPDATE "Tournaments" SET "CurrentRound" = $2, "RoundStartedAt" = now() AT TIME ZONE \'utc\' WHERE "Id" = $1',
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
                '"RoundCount" = $3, "RoundStartedAt" = now() AT TIME ZONE \'utc\' WHERE "Id" = $1',
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
    async completeMatch(tournament, match, { winnerId, resultType, reporterId, p1Wins, p2Wins }) {
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

        await this.db.query(
            'UPDATE "TournamentMatches" SET "WinnerId" = $2, "ResultType" = $3, "ReportedBy" = $4, ' +
                '"Player1Wins" = $5, "Player2Wins" = $6, "ReportedAt" = now() AT TIME ZONE \'utc\' WHERE "Id" = $1',
            [match.Id, winnerId || null, resultType, reporterId, player1Wins, player2Wins]
        );

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

        if (alreadyDecided && match.Bracket) {
            await this.clearDownstream(tournament, match);
        }

        await this.completeMatch(tournament, match, {
            winnerId,
            resultType: 'played',
            reporterId: actor.id,
            p1Wins,
            p2Wins
        });

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

        if (match.WinnerId || match.ResultType) {
            return { success: false, message: 'This match already has a result' };
        }

        await this.completeMatch(tournament, match, {
            winnerId,
            resultType,
            reporterId: actor.id
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

        if (match.WinnerId || match.ResultType) {
            return { success: false, message: 'This match already has a result' };
        }

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

    async finish(tournamentId, actor) {
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

        return { success: true };
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
    async getMatchesNeedingGames(tournamentId) {
        const tournament = await this.getTournamentRow(tournamentId);

        if (
            !tournament ||
            tournament.Status !== 'active' ||
            tournament.Mode !== 'online' ||
            !this.getConfig().autoCreateGames
        ) {
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

        return matches
            .filter(
                (match) =>
                    match.Round === tournament.CurrentRound &&
                    !match.WinnerId &&
                    !match.ResultType &&
                    match.Player1Id &&
                    match.Player2Id
            )
            .map((match) => {
                const games = gamesByMatch[match.Id] || [];
                const lastDecided = [...games].reverse().find((game) => game.WinnerId);
                const previousWinnerId = lastDecided ? lastDecided.WinnerId : null;

                return {
                    tournamentId,
                    tournamentName: tournament.Name,
                    matchId: match.Id,
                    round: match.Round,
                    table: match.TableNumber,
                    bracket: match.Bracket,
                    bestOf: match.BestOf || 1,
                    gameFormat: tournament.GameFormat,
                    hideDecklists: !!tournament.HideDecklists,
                    gameTimeLimit: tournament.GameTimeLimit,
                    gameNumber: (match.Player1Wins || 0) + (match.Player2Wins || 0) + 1,
                    knownGameUuids: games.map((game) => game.GameUuid),
                    previousWinner: previousWinnerId
                        ? playerById[previousWinnerId]?.Username
                        : null,
                    players: [match.Player1Id, match.Player2Id].map((playerId) => ({
                        userId: playerId,
                        username: playerById[playerId]?.Username,
                        deckId: playerById[playerId]?.DeckId || null
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

        if (tournament.Status !== 'active' || tournament.Mode !== 'online') {
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
            tournamentEvents.emit('ensureMatchGame', { tournamentId, matchId: match.Id });
        } catch (err) {
            logger.error(`Failed to emit ensureMatchGame for match ${match.Id}`, err);
        }

        return { success: true };
    }
}

module.exports = TournamentService;
