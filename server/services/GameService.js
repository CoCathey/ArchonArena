const crypto = require('crypto');
const _ = require('underscore');

const logger = require('../log.js');
const db = require('../db');
const { stripReplayHands } = require('./replayPrivacy');

class GameService {
    // ARCHON: db is injectable (defaults to the shared PG pool) so the
    // service is unit-testable, matching RatingService/TournamentService.
    // settingsService likewise, so retention and capture limits can be driven
    // from the admin panel without the service reaching for a singleton.
    constructor(database = db, settingsService = require('./settings')) {
        this.db = database;
        this.settingsService = settingsService;
    }

    /** Replay settings (registry defaults with admin overrides applied). */
    getReplayConfig() {
        return this.settingsService.getSectionWithDefaults('replay');
    }

    async create(game) {
        let gameId;

        await this.db.query('BEGIN');

        try {
            let newGame = await this.db.query(
                // ARCHON (F9): practice games are recorded so a player can
                // find them again and watch the replay - and flagged, because
                // a recorded game is not a result. Every aggregate on this
                // site excludes the flagged ones.
                // ARCHON (N41): and WHICH pilot, when there was one. The style
                // was chosen on the pending screen and then forgotten by
                // everything downstream, so "which one keeps beating me" had
                // no answer for the player and no answer for the site.
                'INSERT INTO "Games" ("GameId", "GameFormat", "StartedAt", "BotGame", ' +
                    '"BotStyle") VALUES ($1, $2, $3, $4, $5) RETURNING "Id"',
                [
                    game.gameId,
                    game.gameFormat,
                    game.startedAt,
                    !!game.botGame,
                    game.botStyle || null
                ]
            );

            if (!newGame || newGame.length === 0) {
                logger.error('Failed to create game');
                await this.db.query('ROLLBACK');

                throw new Error('Failed to create game');
            }

            gameId = newGame[0].Id;
        } catch (err) {
            logger.error('Failed to create game', err);

            await this.db.query('ROLLBACK');

            throw new Error('Failed to create game');
        }

        for (let player of game.players) {
            try {
                await this.db.query(
                    // ARCHON: the deck lookup is scoped to the player who owns
                    // it. "Decks" is unique on ("Identity","UserId"), not on
                    // "Identity" alone - a deck identity is shared by every
                    // player who imports that deck - so the unscoped subquery
                    // returned more than one row as soon as two people owned
                    // the same deck, and the INSERT errored out. That aborted
                    // the transaction and lost the whole game record.
                    //
                    // This is the form update() has always used; create() was
                    // simply missing the second condition.
                    //
                    // "DeckUuid" is recorded alongside the row id because the
                    // id is a link into a mutable collection and the uuid is
                    // the deck itself. "DeckId" is ON DELETE SET NULL, so
                    // deleting a deck used to erase its games from every stat
                    // that counted them; the uuid survives that and re-links
                    // them when the deck is imported again.
                    'INSERT INTO "GamePlayers" ("GameId", "PlayerId", "DeckId", "DeckUuid") VALUES ' +
                        '($1, (SELECT "Id" FROM "Users" WHERE "Username" = $2), ' +
                        '(SELECT "Id" FROM "Decks" WHERE "Identity" = $3 AND "UserId" = (SELECT "Id" FROM "Users" WHERE "Username" = $2)), ' +
                        '(SELECT "Uuid" FROM "Decks" WHERE "Identity" = $3 AND "UserId" = (SELECT "Id" FROM "Users" WHERE "Username" = $2)))',
                    [gameId, player.name, player.deck]
                );
            } catch (err) {
                logger.error('Failed to create game player', err);

                await this.db.query('ROLLBACK');

                throw new Error('Failed to create game player');
            }
        }

        await this.db.query('COMMIT');
    }

    async update(game) {
        await this.db.query('BEGIN');

        try {
            await this.db.query(
                'UPDATE "Games" SET "StartedAt" = $2, "WinnerId" = (SELECT "Id" FROM "Users" WHERE "Username" = $3), "WinReason" = $4, "FinishedAt" = $5 WHERE "GameId" = $1',
                [game.gameId, game.startedAt, game.winner, game.winReason, game.finishedAt]
            );
        } catch (err) {
            await this.db.query('ROLLBACK');

            throw new Error('Failed to update game');
        }

        for (let player of game.players) {
            let keys = 0;

            if (player.keys && player.keys.red !== undefined) {
                if (player.keys.red) {
                    keys++;
                }

                if (player.keys.yellow) {
                    keys++;
                }

                if (player.keys.blue) {
                    keys++;
                }
            }

            try {
                await this.db.query(
                    'UPDATE "GamePlayers" SET "Keys" = $1, ' +
                        '"DeckId" = (SELECT "Id" FROM "Decks" WHERE "Identity" = $5 AND "UserId" = (SELECT "Id" FROM "Users" WHERE "Username" = $4)), ' +
                        // COALESCE for the same reason as "WentFirst": if the
                        // deck row has gone by the time the game is saved, keep
                        // whatever create() recorded rather than blanking the
                        // only durable link the game has to its deck.
                        '"DeckUuid" = COALESCE((SELECT "Uuid" FROM "Decks" WHERE "Identity" = $5 AND "UserId" = (SELECT "Id" FROM "Users" WHERE "Username" = $4)), "GamePlayers"."DeckUuid"), ' +
                        // ARCHON (N12): turn order, for the going-first split in
                        // Archon Intelligence. COALESCE keeps a replayed or
                        // partial save from overwriting a value already
                        // recorded, and an undefined here writes NULL, which
                        // the analytics treat as "not recorded" rather than
                        // "went second".
                        '"WentFirst" = COALESCE($6, "GamePlayers"."WentFirst"), ' +
                        '"Turn" = $2 WHERE "GameId" = (SELECT "Id" FROM "Games" WHERE "GameId" = $3) AND "PlayerId" = (SELECT "Id" FROM "Users" WHERE "Username" = $4)',
                    [
                        keys,
                        player.turn,
                        game.gameId,
                        player.name,
                        player.deck,
                        player.wentFirst === undefined ? null : !!player.wentFirst
                    ]
                );
            } catch (err) {
                logger.error(
                    `Failed to update game player ${game.gameId}, ${player.name} ${player.deck}`,
                    err
                );

                await this.db.query('ROLLBACK');

                throw new Error('Failed to update game player');
            }
        }

        await this.db.query('COMMIT');
    }

    getAllGames(from, to) {
        return this.games
            .find()
            .then((games) => {
                return _.filter(games, (game) => {
                    return game.startedAt >= from && game.startedAt < to;
                });
            })
            .catch((err) => {
                logger.error('Unable to get all games from', from, 'to', to, err);
                throw new Error('Unable to get all games');
            });
    }

    /**
     * ARCHON: a player's recent finished games for the Game History page.
     * Rewritten from the legacy MongoDB aggregation onto PostgreSQL
     * (Games / GamePlayers / Decks) - `this.games` never existed on the
     * PG-backed service, so this used to throw and blank the page.
     *
     * Returns games newest-first with position zero always the requested
     * player (and their deck), matching what the client expects:
     * { gameId, gameFormat, startedAt, finishedAt, winReason,
     *   winner, players: [{ name, deck, keys }], decks: [{ name, identity }] }.
     */
    async findByUserName(username, filters = {}) {
        // ARCHON: filters (deck / opponent / format / result) are applied
        // inside the CTE, before the row limit - filtering the last 30 games
        // client-side would silently answer "you have never played that deck"
        // for anyone with a longer history.
        const params = [username];
        const conditions = [];

        if (filters.format) {
            params.push(filters.format);
            conditions.push(`g."GameFormat" = $${params.length}`);
        }

        if (filters.deck) {
            params.push(String(filters.deck));
            conditions.push(
                `EXISTS (SELECT 1 FROM "Decks" fd WHERE fd."Id" = gp."DeckId" ` +
                    `AND (fd."Identity" = $${params.length} OR fd."Name" ILIKE '%' || $${params.length} || '%'))`
            );
        }

        if (filters.opponent) {
            params.push(String(filters.opponent));
            conditions.push(
                `EXISTS (SELECT 1 FROM "GamePlayers" ogp ` +
                    `JOIN "Users" ou ON ou."Id" = ogp."PlayerId" ` +
                    `WHERE ogp."GameId" = g."Id" AND ogp."PlayerId" <> u."Id" ` +
                    `AND lower(ou."Username") = lower($${params.length}))`
            );
        }

        if (filters.result === 'win') {
            conditions.push('g."WinnerId" = u."Id"');
        } else if (filters.result === 'loss') {
            conditions.push('g."WinnerId" IS NOT NULL AND g."WinnerId" <> u."Id"');
        }

        // Bounded so a crafted limit cannot ask for the whole game log.
        const requested = parseInt(filters.limit, 10);
        const limit = Number.isFinite(requested) ? Math.min(Math.max(requested, 1), 200) : 30;

        const rows = await this.db.query(
            'WITH user_games AS (' +
                'SELECT g."Id", g."GameId", g."GameFormat", g."StartedAt", ' +
                'g."FinishedAt", g."WinReason", g."WinnerId" ' +
                'FROM "Games" g ' +
                'JOIN "GamePlayers" gp ON gp."GameId" = g."Id" ' +
                'JOIN "Users" u ON u."Id" = gp."PlayerId" ' +
                'WHERE u."Username" = $1 AND g."FinishedAt" IS NOT NULL ' +
                (conditions.length ? `AND ${conditions.join(' AND ')} ` : '') +
                `ORDER BY g."FinishedAt" DESC LIMIT ${limit}` +
                ') ' +
                'SELECT ug."GameId", ug."GameFormat", ug."StartedAt", ' +
                'ug."FinishedAt", ug."WinReason", wu."Username" AS "Winner", gp."Keys", ' +
                'pu."Username" AS "PlayerName", d."Name" AS "DeckName", ' +
                'd."Identity" AS "DeckIdentity" ' +
                'FROM user_games ug ' +
                'JOIN "GamePlayers" gp ON gp."GameId" = ug."Id" ' +
                'JOIN "Users" pu ON pu."Id" = gp."PlayerId" ' +
                'LEFT JOIN "Decks" d ON d."Id" = gp."DeckId" ' +
                'LEFT JOIN "Users" wu ON wu."Id" = ug."WinnerId" ' +
                'ORDER BY ug."FinishedAt" DESC, gp."Id"',
            params
        );

        // Group the flat rows (one per player) into game objects, keeping
        // the FinishedAt-DESC order the query emits.
        const byGame = new Map();

        for (const row of rows || []) {
            if (!byGame.has(row.GameId)) {
                byGame.set(row.GameId, {
                    gameId: row.GameId,
                    gameFormat: row.GameFormat,
                    startedAt: row.StartedAt,
                    finishedAt: row.FinishedAt,
                    winReason: row.WinReason,
                    winner: row.Winner,
                    players: [],
                    decks: []
                });
            }

            const game = byGame.get(row.GameId);
            // players[i] and decks[i] are pushed together so they stay
            // aligned; reversing later keeps that alignment.
            game.players.push({ name: row.PlayerName, deck: row.DeckIdentity, keys: row.Keys });
            game.decks.push({ name: row.DeckName, identity: row.DeckIdentity });
        }

        const games = [...byGame.values()];

        // Position zero is always the requesting player and their deck.
        for (const game of games) {
            if (game.players.length === 2 && game.players[1].name === username) {
                game.players.reverse();
                game.decks.reverse();
            }
        }

        return games;
    }

    /**
     * ARCHON: the values that actually appear in this player's history, so the
     * filter controls offer real choices instead of the site-wide list of every
     * format and a free-text box you have to guess into.
     */
    async getGameFilterOptions(username) {
        const [formatRows, deckRows, opponentRows] = await Promise.all([
            this.db.query(
                'SELECT DISTINCT g."GameFormat" AS "format" FROM "Games" g ' +
                    'JOIN "GamePlayers" gp ON gp."GameId" = g."Id" ' +
                    'JOIN "Users" u ON u."Id" = gp."PlayerId" ' +
                    'WHERE u."Username" = $1 AND g."FinishedAt" IS NOT NULL ' +
                    'AND g."GameFormat" IS NOT NULL ORDER BY 1',
                [username]
            ),
            this.db.query(
                'SELECT d."Identity" AS "identity", d."Name" AS "name", COUNT(*) AS "games" ' +
                    'FROM "Games" g ' +
                    'JOIN "GamePlayers" gp ON gp."GameId" = g."Id" ' +
                    'JOIN "Users" u ON u."Id" = gp."PlayerId" ' +
                    'JOIN "Decks" d ON d."Id" = gp."DeckId" ' +
                    'WHERE u."Username" = $1 AND g."FinishedAt" IS NOT NULL ' +
                    'GROUP BY d."Identity", d."Name" ORDER BY COUNT(*) DESC, d."Name" LIMIT 100',
                [username]
            ),
            this.db.query(
                'SELECT ou."Username" AS "username", COUNT(*) AS "games" FROM "Games" g ' +
                    'JOIN "GamePlayers" gp ON gp."GameId" = g."Id" ' +
                    'JOIN "Users" u ON u."Id" = gp."PlayerId" ' +
                    'JOIN "GamePlayers" ogp ON ogp."GameId" = g."Id" AND ogp."PlayerId" <> u."Id" ' +
                    'JOIN "Users" ou ON ou."Id" = ogp."PlayerId" ' +
                    'WHERE u."Username" = $1 AND g."FinishedAt" IS NOT NULL ' +
                    'GROUP BY ou."Username" ORDER BY COUNT(*) DESC, ou."Username" LIMIT 100',
                [username]
            )
        ]);

        return {
            formats: (formatRows || []).map((row) => row.format),
            decks: (deckRows || []).map((row) => ({
                identity: row.identity,
                name: row.name,
                games: Number(row.games) || 0
            })),
            opponents: (opponentRows || []).map((row) => ({
                username: row.username,
                games: Number(row.games) || 0
            }))
        };
    }

    /**
     * ARCHON: persist a finished game's replay (structured play-by-play),
     * keyed to the game's DB row. Best-effort and idempotent (one replay per
     * game); oversized captures are skipped rather than stored.
     *
     * The size cap and the recording switch are admin-configurable
     * (Site Settings > Replays). A skip used to be a bare log line, which read
     * from the outside exactly like "this game was never recorded"; the return
     * value now says which happened so callers - and the tests - can tell.
     */
    async saveReplay(gameUuid, replay) {
        if (!gameUuid || !replay) {
            return { stored: false, reason: 'no-replay' };
        }

        const config = this.getReplayConfig();

        if (!config.enabled) {
            return { stored: false, reason: 'disabled' };
        }

        const data = JSON.stringify(replay);
        // Guard against a pathologically large log bloating storage. Configured
        // in KB because that is the unit an operator sizing a disk thinks in.
        const maxBytes = Math.max(1, Number(config.maxCaptureKb) || 2000) * 1000;

        if (data.length > maxBytes) {
            logger.warn(
                `Skipping oversized replay for game ${gameUuid} (${data.length} bytes, ` +
                    `limit ${maxBytes}). Raise Site Settings > Replays > largest replay to keep these.`
            );

            return { stored: false, reason: 'too-large', bytes: data.length, limit: maxBytes };
        }

        await this.db.query(
            'INSERT INTO "GameReplays" ("GameDbId", "Data", "CreatedAt") ' +
                'SELECT "Id", $2::jsonb, now() AT TIME ZONE \'utc\' FROM "Games" WHERE "GameId" = $1 ' +
                'ON CONFLICT ("GameDbId") DO NOTHING',
            [gameUuid, data]
        );

        return { stored: true, bytes: data.length };
    }

    /**
     * ARCHON: the stored replay for a finished game (by external GameId), or
     * null if none was recorded.
     */
    async getReplay(gameUuid) {
        const rows = await this.db.query(
            'SELECT gr."Data", gr."ShareToken" FROM "GameReplays" gr ' +
                'JOIN "Games" g ON g."Id" = gr."GameDbId" WHERE g."GameId" = $1',
            [gameUuid]
        );

        if (!rows || !rows[0]) {
            return null;
        }

        return { ...rows[0].Data, shareToken: rows[0].ShareToken || null };
    }

    /**
     * ARCHON: why is there no replay for this game?
     *
     * There are four answers and they used to be one: "No replay is available
     * for this game", which is true of a game played before recording existed,
     * a game whose capture blew the size limit, a site with recording switched
     * off, and a deployment whose "GameReplays" table was never created. A
     * player cannot act on any of those and neither can an operator reading a
     * bug report, which is how "replays don't work" arrives with nothing to go
     * on.
     *
     * Only called once a replay has already come back empty.
     *
     * @returns {Promise<'no-such-game'|'storage-missing'|'recording-disabled'|'not-recorded'>}
     */
    async describeMissingReplay(gameUuid) {
        // A table that does not exist is the one cause that makes every replay
        // on the site missing at once, so it is worth naming separately - it is
        // an operator problem, not a per-game one.
        try {
            await this.db.query('SELECT 1 FROM "GameReplays" LIMIT 1');
        } catch (err) {
            logger.error('Replay storage is unavailable', err);

            return 'storage-missing';
        }

        const game = await this.db.query('SELECT 1 FROM "Games" WHERE "GameId" = $1', [gameUuid]);

        if (!game || game.length === 0) {
            return 'no-such-game';
        }

        if (!this.getReplayConfig().enabled) {
            return 'recording-disabled';
        }

        return 'not-recorded';
    }

    /**
     * ARCHON: delete replays older than the configured retention window.
     *
     * Returns the number of rows removed. `retentionDays` of 0 means keep
     * everything, which is the default - a site that has not thought about
     * retention should not silently start destroying game history.
     */
    async purgeExpiredReplays(retentionDays = this.getReplayConfig().retentionDays) {
        const days = Number(retentionDays);

        if (!Number.isFinite(days) || days <= 0) {
            return 0;
        }

        const rows = await this.db.query(
            'DELETE FROM "GameReplays" ' +
                "WHERE \"CreatedAt\" < (now() AT TIME ZONE 'utc') - ($1 || ' days')::interval " +
                'RETURNING "GameDbId"',
            [String(Math.floor(days))]
        );

        const removed = rows ? rows.length : 0;

        if (removed > 0) {
            logger.info(`Replay retention: removed ${removed} replay(s) older than ${days} days`);
        }

        return removed;
    }

    /**
     * ARCHON: was this user one of the two players in this game?
     *
     * Sharing is a player's call about their own game, so the answer has to
     * come from the game record rather than from whoever happens to be able to
     * read the replay (which today is every logged-in account).
     */
    async isGameParticipant(gameUuid, userId) {
        if (!gameUuid || !userId) {
            return false;
        }

        const rows = await this.db.query(
            'SELECT 1 FROM "Games" g JOIN "GamePlayers" gp ON gp."GameId" = g."Id" ' +
                'WHERE g."GameId" = $1 AND gp."PlayerId" = $2',
            [gameUuid, userId]
        );

        return !!(rows && rows.length > 0);
    }

    /**
     * ARCHON: mint (or return) the public share link token for a replay.
     *
     * Idempotent: asking twice hands back the same token, so a player who
     * shares a game, loses the link and shares again does not invalidate the
     * link they already sent someone. 32 hex characters from the CSPRNG - the
     * token is the whole credential, so it has to be unguessable.
     */
    async createShareToken(gameUuid, userId) {
        if (!this.getReplayConfig().allowSharing) {
            return { success: false, message: 'Replay sharing is disabled on this site' };
        }

        if (!(await this.isGameParticipant(gameUuid, userId))) {
            return { success: false, message: 'Only the players in a game can share it' };
        }

        const existing = await this.db.query(
            'SELECT gr."ShareToken" FROM "GameReplays" gr ' +
                'JOIN "Games" g ON g."Id" = gr."GameDbId" WHERE g."GameId" = $1',
            [gameUuid]
        );

        if (!existing || existing.length === 0) {
            return { success: false, message: 'No replay was recorded for that game' };
        }

        if (existing[0].ShareToken) {
            return { success: true, shareToken: existing[0].ShareToken };
        }

        const token = crypto.randomBytes(16).toString('hex');

        await this.db.query(
            'UPDATE "GameReplays" SET "ShareToken" = $2, ' +
                '"SharedAt" = now() AT TIME ZONE \'utc\', "SharedBy" = $3 ' +
                'WHERE "GameDbId" = (SELECT "Id" FROM "Games" WHERE "GameId" = $1)',
            [gameUuid, token, userId]
        );

        return { success: true, shareToken: token };
    }

    /** Revoke a share link. The replay itself is untouched. */
    async revokeShareToken(gameUuid, userId) {
        if (!(await this.isGameParticipant(gameUuid, userId))) {
            return { success: false, message: 'Only the players in a game can unshare it' };
        }

        await this.db.query(
            'UPDATE "GameReplays" SET "ShareToken" = NULL, "SharedAt" = NULL, "SharedBy" = NULL ' +
                'WHERE "GameDbId" = (SELECT "Id" FROM "Games" WHERE "GameId" = $1)',
            [gameUuid]
        );

        return { success: true };
    }

    /**
     * ARCHON: a shared replay, looked up by its token. This is the only path
     * that serves a replay to an anonymous caller, and it can only ever return
     * a recording someone deliberately shared.
     *
     * The recording's board frames are spectator-safe by construction
     * (snapshots are rendered through AnonymousSpectator), and the one thing a
     * version 4 recording holds beyond that - each player's hand, for the
     * misplay review - is stripped HERE rather than in the route, so no future
     * caller of this method can forget to. A share link cannot reveal more
     * than watching the game would have.
     */
    async getReplayByShareToken(token) {
        if (!token || typeof token !== 'string') {
            return null;
        }

        if (!this.getReplayConfig().allowSharing) {
            return null;
        }

        const rows = await this.db.query(
            'SELECT gr."Data", g."GameId" FROM "GameReplays" gr ' +
                'JOIN "Games" g ON g."Id" = gr."GameDbId" WHERE gr."ShareToken" = $1',
            [token]
        );

        if (!rows || !rows[0]) {
            return null;
        }

        return {
            ...stripReplayHands(rows[0].Data),
            gameId: rows[0].GameId,
            shared: true
        };
    }
}

module.exports = GameService;
