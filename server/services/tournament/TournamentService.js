const logger = require('../../log');
const {
    suggestedSwissRounds,
    pairSwissRound,
    pairEliminationRound,
    computeStandings
} = require('./pairing');

const FORMATS = ['swiss', 'single-elim'];
const MODES = ['online', 'irl'];

/**
 * Native tournament engine (Phase 7): create events, register players,
 * generate Swiss / single-elimination pairings, collect results, compute
 * standings. Pure pairing math lives in pairing.js; this service owns
 * persistence and authorization.
 *
 * Any logged-in user can create and run their own events (that is the
 * point for in-person organizers); site TOs/admins can manage all.
 */
class TournamentService {
    constructor(db = require('../../db')) {
        this.db = db;
    }

    canManage(actor, tournament) {
        return (
            actor.id === tournament.OrganizerId ||
            !!actor.permissions?.canManageTournaments ||
            !!actor.permissions?.isAdmin
        );
    }

    async create(actor, options) {
        const name = (options.name || '').trim();

        if (name.length < 3 || name.length > 80) {
            return { success: false, message: 'Name must be 3-80 characters' };
        }

        if (!FORMATS.includes(options.format)) {
            return { success: false, message: 'Unknown tournament format' };
        }

        if (options.mode && !MODES.includes(options.mode)) {
            return { success: false, message: 'Unknown tournament mode' };
        }

        const roundCount = options.roundCount ? parseInt(options.roundCount, 10) : null;
        if (
            roundCount !== null &&
            (Number.isNaN(roundCount) || roundCount < 1 || roundCount > 20)
        ) {
            return { success: false, message: 'Round count must be between 1 and 20' };
        }

        const rows = await this.db.query(
            'INSERT INTO "Tournaments" ("Name", "Description", "OrganizerId", "Format", ' +
                '"GameFormat", "Mode", "RoundCount", "CreatedAt") ' +
                'VALUES ($1, $2, $3, $4, $5, $6, $7, now() AT TIME ZONE \'utc\') RETURNING "Id"',
            [
                name,
                (options.description || '').slice(0, 2000) || null,
                actor.id,
                options.format,
                options.gameFormat || 'archon',
                options.mode || 'online',
                roundCount
            ]
        );

        return { success: true, id: rows[0].Id };
    }

    async list(status) {
        const params = [];
        let where = '';

        if (status) {
            params.push(status);
            where = 'WHERE t."Status" = $1';
        }

        const rows = await this.db.query(
            'SELECT t."Id", t."Name", t."Format", t."GameFormat", t."Mode", t."Status", ' +
                't."CurrentRound", t."RoundCount", t."CreatedAt", u."Username" AS "Organizer", ' +
                '(SELECT COUNT(*) FROM "TournamentPlayers" tp WHERE tp."TournamentId" = t."Id") AS "PlayerCount" ' +
                'FROM "Tournaments" t JOIN "Users" u ON u."Id" = t."OrganizerId" ' +
                `${where} ORDER BY t."Id" DESC LIMIT 100`,
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
            'SELECT tp."UserId", tp."Dropped", tp."Seed", u."Username" ' +
                'FROM "TournamentPlayers" tp JOIN "Users" u ON u."Id" = tp."UserId" ' +
                'WHERE tp."TournamentId" = $1 ORDER BY tp."Id"',
            [tournamentId]
        );
    }

    async getMatches(tournamentId) {
        return await this.db.query(
            'SELECT m."Id", m."Round", m."TableNumber", m."Player1Id", m."Player2Id", ' +
                'm."WinnerId", u1."Username" AS "Player1", u2."Username" AS "Player2" ' +
                'FROM "TournamentMatches" m ' +
                'JOIN "Users" u1 ON u1."Id" = m."Player1Id" ' +
                'LEFT JOIN "Users" u2 ON u2."Id" = m."Player2Id" ' +
                'WHERE m."TournamentId" = $1 ORDER BY m."Round", m."TableNumber"',
            [tournamentId]
        );
    }

    /**
     * Full detail payload for the tournament page: event, players,
     * matches grouped by round, and live standings.
     */
    async getDetail(tournamentId, actor) {
        const tournament = await this.getTournamentRow(tournamentId);

        if (!tournament) {
            return { success: false, message: 'No such tournament' };
        }

        const [players, matches, organizerRows] = await Promise.all([
            this.getPlayers(tournamentId),
            this.getMatches(tournamentId),
            this.db.query('SELECT "Username" FROM "Users" WHERE "Id" = $1', [
                tournament.OrganizerId
            ])
        ]);

        const usernames = {};
        for (const player of players) {
            usernames[player.UserId] = player.Username;
        }

        const standings = computeStandings(
            players.map((player) => ({ id: player.UserId })),
            matches.map((match) => ({
                player1: match.Player1Id,
                player2: match.Player2Id,
                winner: match.WinnerId,
                round: match.Round
            }))
        ).map((entry) => ({
            ...entry,
            username: usernames[entry.id],
            dropped: players.find((player) => player.UserId === entry.id)?.Dropped || false
        }));

        return {
            success: true,
            tournament: {
                id: tournament.Id,
                name: tournament.Name,
                description: tournament.Description,
                format: tournament.Format,
                gameFormat: tournament.GameFormat,
                mode: tournament.Mode,
                status: tournament.Status,
                currentRound: tournament.CurrentRound,
                roundCount: tournament.RoundCount,
                organizer: organizerRows[0]?.Username,
                canManage: actor ? this.canManage(actor, tournament) : false,
                isRegistered: actor
                    ? players.some((player) => player.UserId === actor.id && !player.Dropped)
                    : false
            },
            players: players.map((player) => ({
                userId: player.UserId,
                username: player.Username,
                dropped: player.Dropped
            })),
            matches: matches.map((match) => ({
                id: match.Id,
                round: match.Round,
                table: match.TableNumber,
                player1Id: match.Player1Id,
                player2Id: match.Player2Id,
                player1: match.Player1,
                player2: match.Player2,
                winnerId: match.WinnerId
            })),
            standings
        };
    }

    async register(tournamentId, actor) {
        const tournament = await this.getTournamentRow(tournamentId);

        if (!tournament) {
            return { success: false, message: 'No such tournament' };
        }

        if (tournament.Status !== 'registration') {
            return { success: false, message: 'Registration is closed' };
        }

        await this.db.query(
            'INSERT INTO "TournamentPlayers" ("TournamentId", "UserId", "CreatedAt") ' +
                "VALUES ($1, $2, now() AT TIME ZONE 'utc') " +
                'ON CONFLICT ("TournamentId", "UserId") DO UPDATE SET "Dropped" = false',
            [tournamentId, actor.id]
        );

        return { success: true };
    }

    async drop(tournamentId, targetUserId, actor) {
        const tournament = await this.getTournamentRow(tournamentId);

        if (!tournament) {
            return { success: false, message: 'No such tournament' };
        }

        const target = targetUserId || actor.id;

        if (target !== actor.id && !this.canManage(actor, tournament)) {
            return { success: false, message: 'Only the organizer can drop other players' };
        }

        if (tournament.Status === 'registration') {
            await this.db.query(
                'DELETE FROM "TournamentPlayers" WHERE "TournamentId" = $1 AND "UserId" = $2',
                [tournamentId, target]
            );
        } else {
            await this.db.query(
                'UPDATE "TournamentPlayers" SET "Dropped" = true WHERE "TournamentId" = $1 AND "UserId" = $2',
                [tournamentId, target]
            );
        }

        return { success: true };
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

        const active = players.filter((player) => !player.Dropped);
        const standings = computeStandings(
            active.map((player) => ({ id: player.UserId })),
            matches.map((match) => ({
                player1: match.Player1Id,
                player2: match.Player2Id,
                winner: match.WinnerId,
                round: match.Round
            }))
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

    async insertRoundMatches(tournamentId, round, pairings, byes) {
        let table = 1;

        for (const [player1, player2] of pairings) {
            await this.db.query(
                'INSERT INTO "TournamentMatches" ("TournamentId", "Round", "TableNumber", "Player1Id", "Player2Id") ' +
                    'VALUES ($1, $2, $3, $4, $5)',
                [tournamentId, round, table, player1, player2]
            );
            table++;
        }

        for (const byePlayer of byes) {
            // A bye is stored as an auto-won match with no opponent
            await this.db.query(
                'INSERT INTO "TournamentMatches" ("TournamentId", "Round", "Player1Id", "WinnerId", "ReportedAt") ' +
                    "VALUES ($1, $2, $3, $3, now() AT TIME ZONE 'utc')",
                [tournamentId, round, byePlayer]
            );
        }
    }

    async pairAndInsertRound(tournament, round) {
        const state = await this.buildPairingState(tournament.Id);

        if (tournament.Format === 'single-elim') {
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
            await this.insertRoundMatches(tournament.Id, round, pairings, byes);

            return { remaining: remaining.length };
        }

        const { pairings, bye } = pairSwissRound(state);

        if (pairings.length === 0 && !bye) {
            return { error: 'Not enough players to pair' };
        }

        await this.insertRoundMatches(tournament.Id, round, pairings, bye ? [bye] : []);

        return {};
    }

    async start(tournamentId, actor) {
        const tournament = await this.getTournamentRow(tournamentId);

        if (!tournament) {
            return { success: false, message: 'No such tournament' };
        }

        if (!this.canManage(actor, tournament)) {
            return { success: false, message: 'Only the organizer can start the event' };
        }

        if (tournament.Status !== 'registration') {
            return { success: false, message: 'Tournament has already started' };
        }

        const players = await this.getPlayers(tournamentId);
        const activeCount = players.filter((player) => !player.Dropped).length;

        if (activeCount < 2) {
            return { success: false, message: 'At least 2 players are required' };
        }

        const roundCount =
            tournament.Format === 'swiss'
                ? tournament.RoundCount || suggestedSwissRounds(activeCount)
                : null;

        const result = await this.pairAndInsertRound({ ...tournament, CurrentRound: 0 }, 1);
        if (result.error) {
            return { success: false, message: result.error };
        }

        await this.db.query(
            'UPDATE "Tournaments" SET "Status" = \'active\', "CurrentRound" = 1, ' +
                '"RoundCount" = $2, "StartedAt" = now() AT TIME ZONE \'utc\' WHERE "Id" = $1',
            [tournamentId, roundCount]
        );

        logger.info(`Tournament ${tournamentId} started by user ${actor.id}`);

        return { success: true };
    }

    async roundComplete(tournamentId, round) {
        const rows = await this.db.query(
            'SELECT COUNT(*) AS "Unreported" FROM "TournamentMatches" ' +
                'WHERE "TournamentId" = $1 AND "Round" = $2 AND "WinnerId" IS NULL',
            [tournamentId, round]
        );

        return parseInt(rows[0].Unreported, 10) === 0;
    }

    async nextRound(tournamentId, actor) {
        const tournament = await this.getTournamentRow(tournamentId);

        if (!tournament) {
            return { success: false, message: 'No such tournament' };
        }

        if (!this.canManage(actor, tournament)) {
            return { success: false, message: 'Only the organizer can pair the next round' };
        }

        if (tournament.Status !== 'active') {
            return { success: false, message: 'Tournament is not active' };
        }

        if (!(await this.roundComplete(tournamentId, tournament.CurrentRound))) {
            return { success: false, message: 'The current round still has unreported results' };
        }

        if (
            tournament.Format === 'swiss' &&
            tournament.RoundCount &&
            tournament.CurrentRound >= tournament.RoundCount
        ) {
            return {
                success: false,
                message: 'All planned rounds are complete - finish the event instead'
            };
        }

        const round = tournament.CurrentRound + 1;
        const result = await this.pairAndInsertRound(tournament, round);

        if (result.error) {
            return { success: false, message: result.error };
        }

        await this.db.query('UPDATE "Tournaments" SET "CurrentRound" = $2 WHERE "Id" = $1', [
            tournamentId,
            round
        ]);

        return { success: true, round };
    }

    async reportResult(tournamentId, matchId, winnerId, actor) {
        const tournament = await this.getTournamentRow(tournamentId);

        if (!tournament) {
            return { success: false, message: 'No such tournament' };
        }

        if (tournament.Status !== 'active') {
            return { success: false, message: 'Tournament is not active' };
        }

        const rows = await this.db.query(
            'SELECT * FROM "TournamentMatches" WHERE "Id" = $1 AND "TournamentId" = $2',
            [matchId, tournamentId]
        );
        const match = rows && rows[0];

        if (!match) {
            return { success: false, message: 'No such match' };
        }

        if (!match.Player2Id) {
            return { success: false, message: 'Byes cannot be reported' };
        }

        if (winnerId !== match.Player1Id && winnerId !== match.Player2Id) {
            return { success: false, message: 'Winner must be one of the match players' };
        }

        const isParticipant = actor.id === match.Player1Id || actor.id === match.Player2Id;
        const isManager = this.canManage(actor, tournament);

        // Participants may report an open result; only the organizer can
        // change one that is already recorded.
        if (!isManager && (!isParticipant || match.WinnerId)) {
            return { success: false, message: 'Only the organizer can change this result' };
        }

        await this.db.query(
            'UPDATE "TournamentMatches" SET "WinnerId" = $2, "ReportedBy" = $3, ' +
                '"ReportedAt" = now() AT TIME ZONE \'utc\' WHERE "Id" = $1',
            [matchId, winnerId, actor.id]
        );

        return { success: true };
    }

    async finish(tournamentId, actor) {
        const tournament = await this.getTournamentRow(tournamentId);

        if (!tournament) {
            return { success: false, message: 'No such tournament' };
        }

        if (!this.canManage(actor, tournament)) {
            return { success: false, message: 'Only the organizer can finish the event' };
        }

        if (tournament.Status !== 'active') {
            return { success: false, message: 'Tournament is not active' };
        }

        if (!(await this.roundComplete(tournamentId, tournament.CurrentRound))) {
            return { success: false, message: 'The current round still has unreported results' };
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

        if (!this.canManage(actor, tournament)) {
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
}

module.exports = TournamentService;
