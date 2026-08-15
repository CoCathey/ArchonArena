const crypto = require('crypto');

const logger = require('./../log');

const DEFAULT_IN_PERSON_CONFIG = {
    /**
     * ARCHON: on by default, matching every other kind of game on the site.
     *
     * This was off, with the reasoning that the platform did not witness these
     * games. That is true, and it is why the safeguards below exist rather than
     * why the default should be no: a committed in-person game already required
     * two independent reports that agree, inside a reporting window, with both
     * decks attached. A result nobody disputes, filed by both players, with the
     * decks named, is the same evidence an online game produces - the engine
     * having watched it is not what makes it true.
     *
     * The alternative cost is worse and less visible: most KeyForge is played
     * on paper, and leaving it unrated meant the ladder measured only the part
     * of the community that plays online.
     *
     * An admin can still turn it off site-wide in Settings > In-Person Games.
     */
    rated: true,
    // A paper result reported weeks later is not evidence of anything.
    reportWindowDays: 7
};

const GAME_FORMATS = ['archon', 'sealed', 'alliance'];

/**
 * In-person game tracking (N13).
 *
 * Most KeyForge is still played across a table, and the platform already
 * knows the decks, the Amber and the clubs - the only missing piece is a
 * trustworthy way to say "we played, here is what happened".
 *
 * Trust is the entire design. An online game is witnessed by the engine; a
 * paper game is witnessed by two people who may disagree, and one of whom
 * has a reason to. So nothing here treats one person's word as a result:
 * both players file independently, the two have to agree, and a mismatch
 * becomes a visible dispute rather than a quietly-chosen winner.
 */
class InPersonGameService {
    constructor(db = require('../db'), options = {}) {
        this.db = db;
        this.settingsService = options.settingsService || require('./settings');
        this.notificationService = options.notificationService || null;
        // Injected: a confirmed game goes through the ordinary rating path.
        this.ratingService = options.ratingService || null;
        // ARCHON (N5): a dispute the two players cannot settle between them
        // can be escalated into the moderation queue. Optional, so a service
        // built without one still disputes correctly - it just has no
        // escalation path, which is exactly how N13 shipped.
        this.moderationService = options.moderationService || null;
    }

    /**
     * Hand a disputed game to the moderators.
     *
     * Deliberately player-initiated rather than automatic. Most disagreements
     * are a mis-typed key count and get sorted out by re-reporting; routing
     * every one of them into the queue would bury the reports that are
     * actually about someone behaving badly. Escalation is what a player does
     * when re-reporting has not worked.
     */
    async escalate(id, actorId, details) {
        const game = await this.getGameRow(id);

        if (!game) {
            return { success: false, message: 'No such game' };
        }

        if (game.Player1Id !== actorId && game.Player2Id !== actorId) {
            return { success: false, message: 'You were not in that game' };
        }

        if (game.Status !== 'disputed') {
            return { success: false, message: 'Only a disputed game can be escalated' };
        }

        if (game.ReportId) {
            return { success: false, message: 'This dispute is already with the moderators' };
        }

        if (!this.moderationService) {
            return { success: false, message: 'Escalation is not available' };
        }

        const report = await this.moderationService.report(actorId, {
            targetType: 'inPersonGame',
            targetId: id,
            reason: 'other',
            details:
                String(details || '').trim() ||
                'The two reports of this in-person game do not match and we cannot agree.'
        });

        if (!report.success) {
            return report;
        }

        await this.db.query('UPDATE "InPersonGames" SET "ReportId" = $2 WHERE "Id" = $1', [
            id,
            report.id
        ]);

        // Both players are told, because a dispute escalated behind one
        // player's back is a worse process than no escalation at all.
        if (this.notificationService) {
            for (const userId of [game.Player1Id, game.Player2Id]) {
                this.notificationService.notify({
                    userId,
                    category: 'game.inperson',
                    title: 'Your in-person game dispute has gone to the moderators',
                    url: `/play/in-person/${id}`,
                    data: { inPersonGameId: id, reportId: report.id }
                });
            }
        }

        logger.info(`In-person game ${id} escalated to report ${report.id} by user ${actorId}`);

        return { success: true, reportId: report.id };
    }

    getConfig() {
        const overrides = this.settingsService?.getSection?.('inPersonGames') || {};

        return { ...DEFAULT_IN_PERSON_CONFIG, ...overrides };
    }

    normalizeFormat(format) {
        const value = String(format || 'archon').toLowerCase();

        return GAME_FORMATS.includes(value) ? value : 'archon';
    }

    async getGameRow(id) {
        const rows = await this.db.query('SELECT * FROM "InPersonGames" WHERE "Id" = $1', [id]);

        return rows && rows[0];
    }

    async getReports(id) {
        const rows = await this.db.query(
            'SELECT * FROM "InPersonGameReports" WHERE "InPersonGameId" = $1 ORDER BY "Id"',
            [id]
        );

        return rows || [];
    }

    /**
     * Open a paper game against a named opponent. The opponent is not asked
     * to confirm a result here - only that a game happened; the result comes
     * from both of them separately.
     */
    async create(actorId, options = {}) {
        const username = String(options.opponentUsername || '').trim();

        if (!username) {
            return { success: false, message: 'Name the player you played against' };
        }

        const rows = await this.db.query(
            'SELECT "Id", "Username", "Disabled" FROM "Users" WHERE lower("Username") = lower($1)',
            [username]
        );
        const opponent = rows && rows[0];

        if (!opponent || opponent.Disabled) {
            return { success: false, message: 'No such player' };
        }

        if (opponent.Id === actorId) {
            return { success: false, message: 'You cannot record a game against yourself' };
        }

        let clubId = null;

        if (options.clubId) {
            // Both players have to be in the club for the game to belong to
            // it - otherwise anyone could attribute games to any club.
            const membership = await this.db.query(
                'SELECT "UserId" FROM "ClubMembers" WHERE "ClubId" = $1 AND "UserId" = ANY($2) ' +
                    'AND "Status" = \'active\'',
                [parseInt(options.clubId, 10), [actorId, opponent.Id]]
            );

            if (!membership || membership.length < 2) {
                return {
                    success: false,
                    message: 'Both players must be members of that club'
                };
            }

            clubId = parseInt(options.clubId, 10);
        }

        const inserted = await this.db.query(
            'INSERT INTO "InPersonGames" ("CreatedById", "Player1Id", "Player2Id", "ClubId", ' +
                '"GameFormat", "Status", "PlayedAt", "CreatedAt") ' +
                "VALUES ($1, $1, $2, $3, $4, 'pending', $5, now() AT TIME ZONE 'utc') " +
                'RETURNING "Id"',
            [
                actorId,
                opponent.Id,
                clubId,
                this.normalizeFormat(options.gameFormat),
                options.playedAt ? new Date(options.playedAt) : new Date()
            ]
        );

        const id = inserted[0].Id;

        if (this.notificationService) {
            const actorRows = await this.db.query(
                'SELECT "Username" FROM "Users" WHERE "Id" = $1',
                [actorId]
            );
            const actorName = actorRows && actorRows[0] ? actorRows[0].Username : 'A player';

            this.notificationService.notify({
                userId: opponent.Id,
                category: 'game.inperson',
                title: `${actorName} recorded an in-person game with you`,
                url: `/play/in-person/${id}`,
                data: { inPersonGameId: id, username: actorName }
            });
        }

        return { success: true, id };
    }

    /**
     * File this player's account of the game. Deliberately not "confirm":
     * a player is asked what happened, never shown a number to agree with,
     * because a pre-filled result is a result one person chose.
     */
    async report(id, actorId, report = {}) {
        const game = await this.getGameRow(id);

        if (!game) {
            return { success: false, message: 'No such game' };
        }

        if (game.Player1Id !== actorId && game.Player2Id !== actorId) {
            return { success: false, message: 'You were not in that game' };
        }

        if (game.Status === 'confirmed') {
            return { success: false, message: 'That game is already confirmed' };
        }

        if (game.Status === 'cancelled') {
            return { success: false, message: 'That game was cancelled' };
        }

        const winnerId = parseInt(report.winnerId, 10);

        if (winnerId !== game.Player1Id && winnerId !== game.Player2Id) {
            return { success: false, message: 'The winner must be one of the two players' };
        }

        const player1Keys = parseInt(report.player1Keys, 10);
        const player2Keys = parseInt(report.player2Keys, 10);

        if (
            Number.isNaN(player1Keys) ||
            Number.isNaN(player2Keys) ||
            player1Keys < 0 ||
            player2Keys < 0 ||
            player1Keys > 10 ||
            player2Keys > 10
        ) {
            return { success: false, message: 'Key counts must be between 0 and 10' };
        }

        const winnerKeys = winnerId === game.Player1Id ? player1Keys : player2Keys;
        const loserKeys = winnerId === game.Player1Id ? player2Keys : player1Keys;

        // Not a rules engine - just a sanity floor. A "winner" with fewer keys
        // than the loser is a typo somewhere, and committing it would rate a
        // game whose reported margin describes the wrong player.
        if (winnerKeys < loserKeys) {
            return {
                success: false,
                message: 'The winner cannot have forged fewer keys than the loser'
            };
        }

        const decks = await this.validateDecks(game, report);

        if (!decks.success) {
            return decks;
        }

        const existing = await this.db.query(
            'SELECT 1 FROM "InPersonGameReports" WHERE "InPersonGameId" = $1 AND "ReporterId" = $2',
            [id, actorId]
        );

        if (existing && existing.length > 0) {
            return { success: false, message: 'You have already reported this game' };
        }

        await this.db.query(
            'INSERT INTO "InPersonGameReports" ("InPersonGameId", "ReporterId", "WinnerId", ' +
                '"Player1Keys", "Player2Keys", "Player1DeckId", "Player2DeckId", "CreatedAt") ' +
                "VALUES ($1, $2, $3, $4, $5, $6, $7, now() AT TIME ZONE 'utc')",
            [
                id,
                actorId,
                winnerId,
                player1Keys,
                player2Keys,
                decks.player1DeckId,
                decks.player2DeckId
            ]
        );

        const reports = await this.getReports(id);

        if (reports.length < 2) {
            const opponentId = actorId === game.Player1Id ? game.Player2Id : game.Player1Id;

            if (this.notificationService) {
                this.notificationService.notify({
                    userId: opponentId,
                    category: 'game.inperson',
                    title: 'An in-person game is waiting for your report',
                    url: `/play/in-person/${id}`,
                    data: { inPersonGameId: id }
                });
            }

            return { success: true, status: 'pending', waitingOn: opponentId };
        }

        return this.settle(game, reports);
    }

    /**
     * A deck may only be attached if it belongs to the player it is being
     * attached to. Otherwise a report could credit someone else's deck with
     * a win, which would corrupt deck records and SAS performance stats.
     */
    async validateDecks(game, report) {
        const player1DeckId = report.player1DeckId ? parseInt(report.player1DeckId, 10) : null;
        const player2DeckId = report.player2DeckId ? parseInt(report.player2DeckId, 10) : null;

        for (const [deckId, ownerId] of [
            [player1DeckId, game.Player1Id],
            [player2DeckId, game.Player2Id]
        ]) {
            if (!deckId) {
                continue;
            }

            const rows = await this.db.query('SELECT "UserId" FROM "Decks" WHERE "Id" = $1', [
                deckId
            ]);

            if (!rows || rows.length === 0 || rows[0].UserId !== ownerId) {
                return {
                    success: false,
                    message: 'A deck can only be attached to the player who owns it'
                };
            }
        }

        return { success: true, player1DeckId, player2DeckId };
    }

    /** Do the two accounts of the game agree on everything that matters? */
    reportsAgree(a, b) {
        return (
            a.WinnerId === b.WinnerId &&
            a.Player1Keys === b.Player1Keys &&
            a.Player2Keys === b.Player2Keys
        );
    }

    async settle(game, reports) {
        const [first, second] = reports;

        if (!this.reportsAgree(first, second)) {
            await this.db.query(
                'UPDATE "InPersonGames" SET "Status" = \'disputed\', ' +
                    '"DisputedAt" = now() AT TIME ZONE \'utc\' WHERE "Id" = $1',
                [game.Id]
            );

            // Both players hear about it. A dispute one side cannot see is
            // indistinguishable from being ignored.
            if (this.notificationService) {
                for (const userId of [game.Player1Id, game.Player2Id]) {
                    this.notificationService.notify({
                        userId,
                        category: 'game.inperson',
                        title: 'Your in-person reports do not match',
                        url: `/play/in-person/${game.Id}`,
                        data: { inPersonGameId: game.Id, disputed: true }
                    });
                }
            }

            logger.info(`In-person game ${game.Id} disputed: reports disagree`);

            return { success: true, status: 'disputed' };
        }

        return this.commit(game, first);
    }

    /**
     * Materialize an agreed game into the ordinary Games tables, then rate
     * it through the same path as an online game. Everything downstream -
     * match history, deck records, house stats, Elo - reads Games, so a
     * separate store would mean teaching each of them about a second kind
     * of game.
     */
    async commit(game, report) {
        const config = this.getConfig();
        // Elo needs the key differential AND both decks' SAS. Keys are always
        // reported; SAS comes from the attached decks, so a game with no decks
        // attached cannot be rated without inventing an input. It is still
        // recorded - it just does not move Amber, and says why.
        const bothDecksAttached = !!(report.Player1DeckId && report.Player2DeckId);
        let rated = config.rated && bothDecksAttached;
        let unratedReason = null;

        if (!config.rated) {
            unratedReason = 'In-person games are not rated on this site';
        } else if (!bothDecksAttached) {
            unratedReason = 'Both decks must be attached for an in-person game to be rated';
        }

        const gameUuid = `irl-${crypto.randomUUID()}`;
        const client = await this.db.startTransaction();
        let gameDbId;

        try {
            const inserted = await this.db.queryTran(
                client,
                'INSERT INTO "Games" ("GameId", "GameFormat", "StartedAt", "FinishedAt", ' +
                    '"WinnerId", "WinReason", "Source") ' +
                    "VALUES ($1, $2, $3, $3, $4, 'keys', 'irl') RETURNING \"Id\"",
                [gameUuid, game.GameFormat, game.PlayedAt || new Date(), report.WinnerId]
            );

            gameDbId = inserted[0].Id;

            for (const [playerId, deckId, keys] of [
                [game.Player1Id, report.Player1DeckId, report.Player1Keys],
                [game.Player2Id, report.Player2DeckId, report.Player2Keys]
            ]) {
                await this.db.queryTran(
                    client,
                    'INSERT INTO "GamePlayers" ("GameId", "PlayerId", "DeckId", "Keys") ' +
                        'VALUES ($1, $2, $3, $4)',
                    [gameDbId, playerId, deckId, keys]
                );
            }

            await this.db.queryTran(
                client,
                'UPDATE "InPersonGames" SET "Status" = \'confirmed\', "GameId" = $2, ' +
                    '"Rated" = $3, "UnratedReason" = $4, ' +
                    '"ConfirmedAt" = now() AT TIME ZONE \'utc\' WHERE "Id" = $1',
                [game.Id, gameDbId, rated, unratedReason]
            );

            await this.db.queryTran(client, 'COMMIT');
        } catch (err) {
            await this.db.queryTran(client, 'ROLLBACK');
            logger.error(`Failed to commit in-person game ${game.Id}`, err);

            return { success: false, message: 'Could not record the game' };
        } finally {
            if (client.release) {
                client.release();
            }
        }

        logger.info(`In-person game ${game.Id} confirmed as game ${gameUuid} (rated: ${rated})`);

        // Outside the transaction: rating is best-effort and idempotent, and
        // a rating failure must not undo a game both players agreed on.
        if (rated && this.ratingService) {
            await this.ratingService.processGame(gameUuid);
        }

        if (this.notificationService) {
            for (const userId of [game.Player1Id, game.Player2Id]) {
                this.notificationService.notify({
                    userId,
                    category: 'game.inperson',
                    title: 'Your in-person game was confirmed',
                    url: `/play/in-person/${game.Id}`,
                    data: { inPersonGameId: game.Id, rated }
                });
            }
        }

        return { success: true, status: 'confirmed', rated, unratedReason, gameId: gameUuid };
    }

    /**
     * Withdraw a report so a disputed game can be settled by the players
     * rather than by an argument. Only the reporter can withdraw their own,
     * and only while the game is still disputed.
     */
    async withdrawReport(id, actorId) {
        const game = await this.getGameRow(id);

        if (!game) {
            return { success: false, message: 'No such game' };
        }

        if (game.Status !== 'disputed') {
            return { success: false, message: 'Only a disputed game can be re-reported' };
        }

        const deleted = await this.db.query(
            'DELETE FROM "InPersonGameReports" WHERE "InPersonGameId" = $1 AND "ReporterId" = $2 ' +
                'RETURNING "Id"',
            [id, actorId]
        );

        if (!deleted || deleted.length === 0) {
            return { success: false, message: 'You have no report on that game' };
        }

        await this.db.query(
            'UPDATE "InPersonGames" SET "Status" = \'pending\', "DisputedAt" = NULL WHERE "Id" = $1',
            [id]
        );

        return { success: true };
    }

    async cancel(id, actorId) {
        const game = await this.getGameRow(id);

        if (!game) {
            return { success: false, message: 'No such game' };
        }

        if (game.Player1Id !== actorId && game.Player2Id !== actorId) {
            return { success: false, message: 'You were not in that game' };
        }

        if (game.Status === 'confirmed') {
            return {
                success: false,
                message: 'A confirmed game is part of both records and cannot be cancelled'
            };
        }

        await this.db.query('UPDATE "InPersonGames" SET "Status" = \'cancelled\' WHERE "Id" = $1', [
            id
        ]);

        return { success: true };
    }

    mapGame(row, reports = [], actorId = null) {
        return {
            id: row.Id,
            player1: { id: row.Player1Id, username: row.Player1Name },
            player2: { id: row.Player2Id, username: row.Player2Name },
            clubId: row.ClubId,
            clubName: row.ClubName,
            gameFormat: row.GameFormat,
            status: row.Status,
            rated: row.Rated,
            unratedReason: row.UnratedReason,
            // ARCHON (N5): set once the dispute has gone to the moderators,
            // so the UI offers "escalate" exactly once.
            reportId: row.ReportId,
            playedAt: row.PlayedAt,
            confirmedAt: row.ConfirmedAt,
            // Whether THIS player still owes a report is the only thing they
            // can act on, so it is computed rather than left to the client.
            awaitingMyReport: actorId
                ? !reports.some((report) => report.ReporterId === actorId)
                : false,
            reports: reports.map((report) => ({
                reporterId: report.ReporterId,
                winnerId: report.WinnerId,
                player1Keys: report.Player1Keys,
                player2Keys: report.Player2Keys
            }))
        };
    }

    async getDetail(id, actorId) {
        const rows = await this.db.query(
            'SELECT g.*, u1."Username" AS "Player1Name", u2."Username" AS "Player2Name", ' +
                'c."Name" AS "ClubName" FROM "InPersonGames" g ' +
                'JOIN "Users" u1 ON u1."Id" = g."Player1Id" ' +
                'JOIN "Users" u2 ON u2."Id" = g."Player2Id" ' +
                'LEFT JOIN "Clubs" c ON c."Id" = g."ClubId" WHERE g."Id" = $1',
            [id]
        );

        if (!rows || rows.length === 0) {
            return { success: false, message: 'No such game' };
        }

        const row = rows[0];

        if (row.Player1Id !== actorId && row.Player2Id !== actorId) {
            return { success: false, message: 'You were not in that game' };
        }

        const reports = await this.getReports(id);

        return { success: true, game: this.mapGame(row, reports, actorId) };
    }

    /** The player's own paper games, newest first. */
    async listForUser(userId, options = {}) {
        const limit = Math.min(Math.max(1, parseInt(options.limit, 10) || 25), 100);
        const rows = await this.db.query(
            'SELECT g.*, u1."Username" AS "Player1Name", u2."Username" AS "Player2Name", ' +
                'c."Name" AS "ClubName" FROM "InPersonGames" g ' +
                'JOIN "Users" u1 ON u1."Id" = g."Player1Id" ' +
                'JOIN "Users" u2 ON u2."Id" = g."Player2Id" ' +
                'LEFT JOIN "Clubs" c ON c."Id" = g."ClubId" ' +
                'WHERE g."Player1Id" = $1 OR g."Player2Id" = $1 ' +
                'ORDER BY g."Id" DESC LIMIT $2',
            [userId, limit]
        );

        const games = rows || [];

        if (games.length === 0) {
            return [];
        }

        const reportRows = await this.db.query(
            'SELECT * FROM "InPersonGameReports" WHERE "InPersonGameId" = ANY($1)',
            [games.map((row) => row.Id)]
        );

        const byGame = new Map();

        for (const report of reportRows || []) {
            const list = byGame.get(report.InPersonGameId) || [];
            list.push(report);
            byGame.set(report.InPersonGameId, list);
        }

        return games.map((row) => this.mapGame(row, byGame.get(row.Id) || [], userId));
    }

    /** Confirmed paper games played at a club - the club page's activity feed. */
    async listForClub(clubId, options = {}) {
        const limit = Math.min(Math.max(1, parseInt(options.limit, 10) || 25), 100);
        const rows = await this.db.query(
            'SELECT g."Id", g."GameFormat", g."PlayedAt", g."Rated", ' +
                'u1."Username" AS "Player1Name", u2."Username" AS "Player2Name", ' +
                'ga."WinnerId" FROM "InPersonGames" g ' +
                'JOIN "Users" u1 ON u1."Id" = g."Player1Id" ' +
                'JOIN "Users" u2 ON u2."Id" = g."Player2Id" ' +
                'LEFT JOIN "Games" ga ON ga."Id" = g."GameId" ' +
                'WHERE g."ClubId" = $1 AND g."Status" = \'confirmed\' ' +
                'ORDER BY g."Id" DESC LIMIT $2',
            [clubId, limit]
        );

        return (rows || []).map((row) => ({
            id: row.Id,
            gameFormat: row.GameFormat,
            playedAt: row.PlayedAt,
            rated: row.Rated,
            player1: row.Player1Name,
            player2: row.Player2Name,
            winnerId: row.WinnerId
        }));
    }
}

module.exports = InPersonGameService;
module.exports.DEFAULT_IN_PERSON_CONFIG = DEFAULT_IN_PERSON_CONFIG;
