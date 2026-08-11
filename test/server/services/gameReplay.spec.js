/**
 * ARCHON: replays, against a real database.
 *
 * "Replays don't work" was the report, and the interface could not distinguish
 * the four reasons a replay might be missing: never recorded, recording turned
 * off, capture too large for the limit, or the game predating the feature. Every
 * one of them arrived as the same "No replay is available for this game", which
 * is why the report could not be narrowed down from the outside.
 *
 * These run the real GameService against a real PostgreSQL loaded with the
 * whole of server/db/schema, because the failure that started this is exactly
 * the kind a fake database cannot have: a table that is not there.
 */
import { it } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

import scratchPostgres from '../../helpers/scratchPostgres.js';

const require_ = createRequire(import.meta.url);
const GameService = require_(
    path.join(path.dirname(fileURLToPath(import.meta.url)), '../../../server/services/GameService')
);

const DB = 'archonarena_replay_test';

describe('game replays', function () {
    let pg;
    let service;
    let settings;

    /** A finished game with two players, as gamerouter would have left it. */
    const createFinishedGame = async (gameId, playerIds) => {
        const rows = await pg.query(
            DB,
            `INSERT INTO "Games" ("GameId", "GameFormat", "StartedAt", "FinishedAt", "WinReason")
             VALUES ('${gameId}', 'archon', NOW(), NOW(), 'keys') RETURNING "Id"`
        );
        const dbId = Number(rows);

        for (const playerId of playerIds) {
            await pg.query(
                DB,
                `INSERT INTO "GamePlayers" ("GameId", "PlayerId", "DeckId")
                 VALUES (${dbId}, ${playerId}, NULL)`
            );
        }

        return dbId;
    };

    beforeAll(async function () {
        pg = await scratchPostgres.start();

        if (!pg) {
            return;
        }

        pg.createDatabase(DB);
        pg.loadSchema(DB);
        pg.psql(
            DB,
            `INSERT INTO "Users" ("Id", "Username", "Email", "Password", "Registered", "Verified")
             VALUES (1, 'playerone', 'one@example.com', 'x', NOW(), true),
                    (2, 'playertwo', 'two@example.com', 'x', NOW(), true),
                    (3, 'nosydave', 'three@example.com', 'x', NOW(), true)`
        );

        // A query interface shaped like server/db: query(sql, params) -> rows.
        const { Client } = require_('pg');
        const client = new Client({ connectionString: `${pg.uri}/${DB}` });

        await client.connect();

        pg.query = async (_db, sql) => {
            const result = await client.query(sql);

            return result.rows[0] ? Object.values(result.rows[0])[0] : null;
        };
        pg.close = () => client.end();

        settings = { replay: { enabled: true, maxCaptureKb: 2000, retentionDays: 0 } };
        service = new GameService(
            {
                query: async (sql, params) => (await client.query(sql, params)).rows
            },
            { getSectionWithDefaults: () => settings.replay }
        );
    }, 180000);

    afterAll(async function () {
        await pg?.close?.();
        pg?.stop();
    });

    const withPostgres = (name, fn, timeout) =>
        it(
            name,
            async function (ctx) {
                if (!pg) {
                    ctx.skip('no PostgreSQL available (set ARCHON_TEST_PG_URI)');

                    return;
                }

                await fn();
            },
            timeout
        );

    withPostgres(
        'stores a replay at game end and reads it back',
        async function () {
            await createFinishedGame('game-basic', [1, 2]);

            const stored = await service.saveReplay('game-basic', {
                header: { winner: 'playerone' },
                messages: [{ text: 'playerone forges a key' }]
            });

            expect(stored.stored).toBe(true);

            const replay = await service.getReplay('game-basic');

            expect(replay.header.winner).toBe('playerone');
            expect(replay.messages).toHaveLength(1);
            // Never shared, so no token.
            expect(replay.shareToken).toBe(null);
        },
        60000
    );

    withPostgres(
        'knows who was in the game',
        async function () {
            await createFinishedGame('game-participants', [1, 2]);

            expect(await service.isGameParticipant('game-participants', 1)).toBe(true);
            expect(await service.isGameParticipant('game-participants', 2)).toBe(true);
            expect(await service.isGameParticipant('game-participants', 3)).toBe(false);
            expect(await service.isGameParticipant('game-participants', null)).toBe(false);
            expect(await service.isGameParticipant('no-such-game', 1)).toBe(false);
        },
        60000
    );

    // The four ways a replay goes missing. They were indistinguishable from the
    // outside, which is what made "replays don't work" impossible to act on.
    withPostgres(
        'says why a replay is missing rather than only that it is',
        async function () {
            await createFinishedGame('game-never-recorded', [1, 2]);

            expect(await service.getReplay('game-never-recorded')).toBe(null);
            expect(await service.describeMissingReplay('game-never-recorded')).toBe('not-recorded');

            // A game that is not ours to look at at all.
            expect(await service.describeMissingReplay('no-such-game')).toBe('no-such-game');

            // Recording switched off in site settings.
            settings.replay = { ...settings.replay, enabled: false };
            expect(await service.describeMissingReplay('game-never-recorded')).toBe(
                'recording-disabled'
            );
            settings.replay = { ...settings.replay, enabled: true };
        },
        60000
    );

    withPostgres(
        'refuses to store a capture larger than the configured limit, and says so',
        async function () {
            await createFinishedGame('game-huge', [1, 2]);

            settings.replay = { ...settings.replay, maxCaptureKb: 1 };

            const result = await service.saveReplay('game-huge', {
                messages: new Array(500).fill({ text: 'a message long enough to matter' })
            });

            expect(result).toMatchObject({ stored: false, reason: 'too-large' });
            expect(await service.getReplay('game-huge')).toBe(null);

            settings.replay = { ...settings.replay, maxCaptureKb: 2000 };
        },
        60000
    );

    withPostgres(
        'saving twice keeps the first recording rather than erroring',
        async function () {
            await createFinishedGame('game-twice', [1, 2]);

            await service.saveReplay('game-twice', { header: { winner: 'first' } });
            const second = await service.saveReplay('game-twice', { header: { winner: 'second' } });

            expect(second.stored).toBe(true);
            expect((await service.getReplay('game-twice')).header.winner).toBe('first');
        },
        60000
    );
});
