const _ = require('underscore');

const logger = require('../log.js');
const db = require('../db');

class GameService {
    // ARCHON: db is injectable (defaults to the shared PG pool) so the
    // service is unit-testable, matching RatingService/TournamentService.
    constructor(database = db) {
        this.db = database;
    }

    async create(game) {
        let gameId;

        await this.db.query('BEGIN');

        try {
            let newGame = await this.db.query(
                'INSERT INTO "Games" ("GameId", "GameFormat", "StartedAt") VALUES ($1, $2, $3) RETURNING "Id"',
                [game.gameId, game.gameFormat, game.startedAt]
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
                    'INSERT INTO "GamePlayers" ("GameId", "PlayerId", "DeckId") VALUES ' +
                        '($1, (SELECT "Id" FROM "Users" WHERE "Username" = $2), (SELECT "Id" FROM "Decks" WHERE "Identity" = $3))',
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
                        '"Turn" = $2 WHERE "GameId" = (SELECT "Id" FROM "Games" WHERE "GameId" = $3) AND "PlayerId" = (SELECT "Id" FROM "Users" WHERE "Username" = $4)',
                    [keys, player.turn, game.gameId, player.name, player.deck]
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
    async findByUserName(username) {
        const rows = await this.db.query(
            'WITH user_games AS (' +
                'SELECT g."Id", g."GameId", g."GameFormat", g."StartedAt", ' +
                'g."FinishedAt", g."WinReason", g."WinnerId" ' +
                'FROM "Games" g ' +
                'JOIN "GamePlayers" gp ON gp."GameId" = g."Id" ' +
                'JOIN "Users" u ON u."Id" = gp."PlayerId" ' +
                'WHERE u."Username" = $1 AND g."FinishedAt" IS NOT NULL ' +
                'ORDER BY g."FinishedAt" DESC LIMIT 30' +
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
            [username]
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
     * ARCHON: persist a finished game's replay (structured play-by-play),
     * keyed to the game's DB row. Best-effort and idempotent (one replay per
     * game); oversized captures are skipped rather than stored.
     */
    async saveReplay(gameUuid, replay) {
        if (!gameUuid || !replay) {
            return;
        }

        const data = JSON.stringify(replay);
        // Guard against a pathologically large log bloating storage.
        if (data.length > 2000000) {
            logger.warn(`Skipping oversized replay for game ${gameUuid} (${data.length} bytes)`);
            return;
        }

        await this.db.query(
            'INSERT INTO "GameReplays" ("GameDbId", "Data", "CreatedAt") ' +
                'SELECT "Id", $2::jsonb, now() AT TIME ZONE \'utc\' FROM "Games" WHERE "GameId" = $1 ' +
                'ON CONFLICT ("GameDbId") DO NOTHING',
            [gameUuid, data]
        );
    }

    /**
     * ARCHON: the stored replay for a finished game (by external GameId), or
     * null if none was recorded.
     */
    async getReplay(gameUuid) {
        const rows = await this.db.query(
            'SELECT gr."Data" FROM "GameReplays" gr ' +
                'JOIN "Games" g ON g."Id" = gr."GameDbId" WHERE g."GameId" = $1',
            [gameUuid]
        );

        return rows && rows[0] ? rows[0].Data : null;
    }
}

module.exports = GameService;
