const GameService = require('../../../server/services/GameService');

describe('GameService.findByUserName', function () {
    let db;
    let service;

    beforeEach(function () {
        db = { query: vi.fn() };
        service = new GameService(db);
    });

    // Flat player-rows the PG query emits (one per player per game).
    const row = (game, player, deck, keys, winner) => ({
        GameId: game,
        GameFormat: 'archon',
        StartedAt: '2026-07-01T10:00:00Z',
        FinishedAt: '2026-07-01T10:20:00Z',
        WinReason: 'keys',
        Winner: winner,
        Keys: keys,
        PlayerName: player,
        DeckName: `${deck} name`,
        DeckIdentity: deck
    });

    it('groups player rows into games with the requester at position zero', async function () {
        // alice is player 2 in the row order; she must be reordered to slot 0.
        db.query.mockResolvedValue([
            row('g1', 'bob', 'bob-deck', 2, 'alice'),
            row('g1', 'alice', 'alice-deck', 3, 'alice')
        ]);

        const games = await service.findByUserName('alice');

        expect(games.length).toBe(1);
        const game = games[0];
        expect(game.players.map((p) => p.name)).toEqual(['alice', 'bob']);
        expect(game.decks.map((d) => d.identity)).toEqual(['alice-deck', 'bob-deck']);
        expect(game.players[0].keys).toBe(3);
        expect(game.winner).toBe('alice');
        expect(game.gameFormat).toBe('archon');
    });

    it('keeps the requester in place when they are already player one', async function () {
        db.query.mockResolvedValue([
            row('g2', 'alice', 'alice-deck', 3, 'bob'),
            row('g2', 'bob', 'bob-deck', 3, 'bob')
        ]);

        const games = await service.findByUserName('alice');

        expect(games[0].players.map((p) => p.name)).toEqual(['alice', 'bob']);
        expect(games[0].decks[0].identity).toBe('alice-deck');
    });

    it('preserves the newest-first order across multiple games', async function () {
        db.query.mockResolvedValue([
            row('g-new', 'alice', 'd1', 3, 'alice'),
            row('g-new', 'bob', 'd2', 1, 'alice'),
            row('g-old', 'alice', 'd3', 2, 'carol'),
            row('g-old', 'carol', 'd4', 3, 'carol')
        ]);

        const games = await service.findByUserName('alice');

        expect(games.map((g) => g.gameId)).toEqual(['g-new', 'g-old']);
        expect(games[1].players[0].name).toBe('alice'); // reordered in the older game too
    });

    it('returns an empty list when the player has no finished games', async function () {
        db.query.mockResolvedValue([]);

        expect(await service.findByUserName('nobody')).toEqual([]);
    });

    it('queries by username and finished games only', async function () {
        db.query.mockResolvedValue([]);

        await service.findByUserName('alice');

        const [sql, params] = db.query.mock.calls[0];
        expect(sql).toContain('"FinishedAt" IS NOT NULL');
        expect(sql).toContain('LIMIT 30');
        expect(params).toEqual(['alice']);
    });
});

describe('GameService replays', function () {
    let db;
    let service;

    beforeEach(function () {
        db = { query: vi.fn().mockResolvedValue([]) };
        service = new GameService(db);
    });

    it('saveReplay does nothing without a game id or replay', async function () {
        await service.saveReplay(null, { messages: [] });
        await service.saveReplay('g1', null);

        expect(db.query).not.toHaveBeenCalled();
    });

    it('saveReplay persists the serialized replay keyed to the game', async function () {
        const replay = { messages: [{ id: 1 }], winner: 'alice' };

        await service.saveReplay('game-uuid', replay);

        expect(db.query).toHaveBeenCalledTimes(1);
        const [sql, params] = db.query.mock.calls[0];
        expect(sql).toContain('INSERT INTO "GameReplays"');
        expect(params[0]).toBe('game-uuid');
        expect(params[1]).toBe(JSON.stringify(replay));
    });

    it('saveReplay skips an oversized replay', async function () {
        await service.saveReplay('game-uuid', { messages: 'x'.repeat(2000001) });

        expect(db.query).not.toHaveBeenCalled();
    });

    it('getReplay returns the stored data, or null when absent', async function () {
        db.query.mockResolvedValueOnce([{ Data: { messages: [], winner: 'bob' } }]);
        expect(await service.getReplay('game-uuid')).toEqual({
            messages: [],
            winner: 'bob',
            shareToken: null
        });

        db.query.mockResolvedValueOnce([]);
        expect(await service.getReplay('missing')).toBeNull();
    });

    it('saveReplay reports why it skipped rather than looking like "never recorded"', async function () {
        // A silent skip and a game that was never recorded were indistinguishable
        // from the outside; the caller can now tell them apart.
        const tooBig = await service.saveReplay('g', { messages: 'x'.repeat(2000001) });
        expect(tooBig).toEqual(
            expect.objectContaining({ stored: false, reason: 'too-large', limit: 2000000 })
        );

        expect(await service.saveReplay('g', null)).toEqual({
            stored: false,
            reason: 'no-replay'
        });
    });

    it('honours an admin-raised capture limit', async function () {
        // The same capture that was refused at the default 2000 KB is stored
        // once an admin raises the cap - i.e. the limit really is the setting.
        const settings = { getSectionWithDefaults: () => ({ enabled: true, maxCaptureKb: 8000 }) };
        const configured = new GameService(db, settings);

        const result = await configured.saveReplay('g', { messages: 'x'.repeat(2000001) });

        expect(result.stored).toBe(true);
        expect(db.query).toHaveBeenCalledTimes(1);
    });

    it('records nothing at all when replays are switched off', async function () {
        const settings = { getSectionWithDefaults: () => ({ enabled: false }) };
        const off = new GameService(db, settings);

        expect(await off.saveReplay('g', { messages: [] })).toEqual({
            stored: false,
            reason: 'disabled'
        });
        expect(db.query).not.toHaveBeenCalled();
    });
});

describe('GameService replay retention', function () {
    let db;
    let service;

    beforeEach(function () {
        db = { query: vi.fn().mockResolvedValue([]) };
        service = new GameService(db);
    });

    it('keeps everything when no retention window is set', async function () {
        // The default. A site that has not chosen a policy must never silently
        // start destroying game history.
        expect(await service.purgeExpiredReplays(0)).toBe(0);
        expect(await service.purgeExpiredReplays(undefined)).toBe(0);
        expect(db.query).not.toHaveBeenCalled();
    });

    it('deletes only replays past the window and reports the count', async function () {
        db.query.mockResolvedValueOnce([{ GameDbId: 1 }, { GameDbId: 2 }]);

        expect(await service.purgeExpiredReplays(30)).toBe(2);

        const [sql, params] = db.query.mock.calls[0];
        expect(sql).toContain('DELETE FROM "GameReplays"');
        expect(sql).toContain('interval');
        expect(params).toEqual(['30']);
    });
});

describe('GameService replay sharing', function () {
    let db;
    let service;

    beforeEach(function () {
        db = { query: vi.fn().mockResolvedValue([]) };
        service = new GameService(db);
    });

    it('refuses to share a game the caller did not play in', async function () {
        db.query.mockResolvedValueOnce([]); // participant check: no rows

        const result = await service.createShareToken('game-uuid', 42);

        expect(result.success).toBe(false);
        expect(result.message).toMatch(/only the players/i);
    });

    it('mints an unguessable token and hands back the same one next time', async function () {
        db.query
            .mockResolvedValueOnce([{ '?column?': 1 }]) // participant
            .mockResolvedValueOnce([{ ShareToken: null }]) // existing replay, unshared
            .mockResolvedValueOnce([]); // the UPDATE

        const first = await service.createShareToken('game-uuid', 42);

        expect(first.success).toBe(true);
        expect(first.shareToken).toMatch(/^[0-9a-f]{32}$/);

        db.query
            .mockResolvedValueOnce([{ '?column?': 1 }])
            .mockResolvedValueOnce([{ ShareToken: first.shareToken }]);

        // Idempotent: a player who shares twice must not invalidate the link
        // they already sent someone.
        const second = await service.createShareToken('game-uuid', 42);
        expect(second.shareToken).toBe(first.shareToken);
    });

    it('will not share a game with no recorded replay', async function () {
        db.query.mockResolvedValueOnce([{ '?column?': 1 }]).mockResolvedValueOnce([]);

        const result = await service.createShareToken('game-uuid', 42);

        expect(result.success).toBe(false);
        expect(result.message).toMatch(/no replay/i);
    });

    it('serves a shared replay by token and nothing without one', async function () {
        db.query.mockResolvedValueOnce([
            { Data: { messages: [], winner: 'bob' }, GameId: 'game-uuid' }
        ]);

        const replay = await service.getReplayByShareToken('a'.repeat(32));
        expect(replay).toEqual(
            expect.objectContaining({ winner: 'bob', gameId: 'game-uuid', shared: true })
        );

        expect(await service.getReplayByShareToken('')).toBeNull();
        expect(await service.getReplayByShareToken(null)).toBeNull();
    });

    it('serves nothing by token while sharing is switched off site-wide', async function () {
        // Turning sharing off has to close existing links too, not just stop
        // new ones being minted.
        const settings = { getSectionWithDefaults: () => ({ allowSharing: false }) };
        const off = new GameService(db, settings);

        expect(await off.getReplayByShareToken('a'.repeat(32))).toBeNull();
        expect(db.query).not.toHaveBeenCalled();
    });
});

describe('GameService match history filters', function () {
    let db;
    let service;

    beforeEach(function () {
        db = { query: vi.fn().mockResolvedValue([]) };
        service = new GameService(db);
    });

    it('filters in SQL, before the row limit', async function () {
        // The point of the whole feature: filtering the last 30 games
        // client-side would answer "you never played that deck" for anyone
        // with a longer history.
        await service.findByUserName('alice', { format: 'sealed' });

        const [sql] = db.query.mock.calls[0];
        const whereClause = sql.slice(0, sql.indexOf('LIMIT'));
        expect(whereClause).toContain('"GameFormat" = $2');
    });

    it('builds each filter as a bound parameter', async function () {
        await service.findByUserName('alice', {
            format: 'normal',
            deck: 'Some Deck',
            opponent: 'bob',
            result: 'win'
        });

        const [sql, params] = db.query.mock.calls[0];
        expect(params).toEqual(['alice', 'normal', 'Some Deck', 'bob']);
        expect(sql).toContain('g."WinnerId" = u."Id"');
    });

    it('treats a loss as decided-and-not-mine, not merely not-won', async function () {
        // An abandoned game has no winner; it is not a loss.
        await service.findByUserName('alice', { result: 'loss' });

        const [sql] = db.query.mock.calls[0];
        expect(sql).toContain('g."WinnerId" IS NOT NULL AND g."WinnerId" <> u."Id"');
    });

    it('caps the row limit however large a value is asked for', async function () {
        await service.findByUserName('alice', { limit: 100000 });

        expect(db.query.mock.calls[0][0]).toContain('LIMIT 200');
    });

    it('is unchanged when no filters are given', async function () {
        await service.findByUserName('alice');

        const [sql, params] = db.query.mock.calls[0];
        expect(sql).toContain('LIMIT 30');
        expect(params).toEqual(['alice']);
    });
});

describe('GameService deck recording', function () {
    let db;
    let service;

    beforeEach(function () {
        // Both writes run inside a transaction on one held connection, so the
        // statements arrive through queryTran (client, sql, params).
        db = {
            query: vi.fn().mockResolvedValue([]),
            startTransaction: vi.fn().mockResolvedValue({ release: vi.fn() }),
            queryTran: vi.fn(async (client, sql) =>
                /INSERT INTO "Games"/.test(sql) ? [{ Id: 99 }] : []
            )
        };
        service = new GameService(db);
    });

    const sqlFor = (pattern) =>
        db.queryTran.mock.calls.map((call) => call[1]).find((sql) => pattern.test(sql));

    /*
     * ARCHON: a game's record of which deck was played must outlive the deck
     * row. "GamePlayers"."DeckId" is ON DELETE SET NULL, so deleting a deck did
     * not archive its games - it erased them from every stat that counted them,
     * and re-importing the deck could not undo it, because nothing on the game
     * said which deck it had been.
     */
    it('records the deck uuid alongside the row id when a game starts', async function () {
        await service.create({
            gameId: 'game-1',
            gameFormat: 'normal',
            startedAt: new Date(),
            players: [{ name: 'alice', deck: 'Test Deck' }]
        });

        const insert = sqlFor(/INSERT INTO "GamePlayers"/);

        expect(insert).toContain('"DeckUuid"');
        expect(insert).toContain('SELECT "Uuid" FROM "Decks"');
        // Still scoped to the owner: "Decks" is unique on ("Identity","UserId"),
        // so an unscoped subquery returns a row per owner and the insert errors.
        expect(insert).toContain('"UserId" = (SELECT "Id" FROM "Users" WHERE "Username" = $2)');
    });

    it('keeps the recorded uuid if the deck is gone by the time the game is saved', async function () {
        await service.update({
            gameId: 'game-1',
            finishedAt: new Date(),
            players: [{ name: 'alice', deck: 'Test Deck', turn: 5, keys: {} }]
        });

        const update = sqlFor(/UPDATE "GamePlayers" SET "Keys"/);

        // Without the COALESCE the save would blank the only durable link the
        // game has to its deck.
        expect(update).toContain('"DeckUuid" = COALESCE(');
        expect(update).toContain('"GamePlayers"."DeckUuid"');
    });
});

/**
 * ARCHON: `create` and `update` used to run `BEGIN`, their writes and `COMMIT`
 * through `db.query`, which is `pool.query` - a different pooled connection per
 * statement. So there was no transaction: the writes auto-committed one at a
 * time, the COMMIT went somewhere else, and the BEGIN's own connection went
 * back to the pool with a transaction left open on it, for the next unrelated
 * request to inherit. These are the two writes on the game path, so what that
 * cost was games whose winner never got recorded (the post-game panel sits on
 * "Rating this game..." because rating runs after that write) and exceptions on
 * the start path.
 */
describe('GameService game records are written in one transaction', function () {
    let db;
    let client;
    let service;

    const game = {
        gameId: 'game-uuid',
        gameFormat: 'archon',
        startedAt: '2026-07-01T10:00:00Z',
        finishedAt: '2026-07-01T10:20:00Z',
        winner: 'alice',
        winReason: 'keys',
        players: [
            { name: 'alice', deck: 'alice-identity', keys: { red: true, yellow: true }, turn: 9 },
            { name: 'bob', deck: 'bob-identity', keys: { red: true }, turn: 9 }
        ]
    };

    beforeEach(function () {
        client = { id: 'client-1', release: vi.fn() };
        db = {
            query: vi.fn().mockResolvedValue([]),
            startTransaction: vi.fn().mockResolvedValue(client),
            queryTran: vi.fn().mockResolvedValue([{ Id: 7 }])
        };
        service = new GameService(db);
    });

    /** Every statement the call issued, in order. */
    const statements = () => db.queryTran.mock.calls.map((call) => call[1]);

    describe('create', function () {
        it('runs every statement on the one connection it took', async function () {
            await service.create(game);

            expect(db.startTransaction).toHaveBeenCalledTimes(1);
            // Nothing on the pool: a BEGIN sent that way is the whole bug.
            expect(db.query).not.toHaveBeenCalled();
            expect(db.queryTran.mock.calls.every((call) => call[0] === client)).toBe(true);
        });

        it('inserts the game and a row per player, then commits', async function () {
            await service.create(game);

            const sent = statements();

            expect(sent.filter((sql) => sql.includes('INSERT INTO "Games"')).length).toBe(1);
            expect(sent.filter((sql) => sql.includes('INSERT INTO "GamePlayers"')).length).toBe(2);
            expect(sent[sent.length - 1]).toBe('COMMIT');
        });

        it('rolls back and hands the connection back when a write fails', async function () {
            db.queryTran
                .mockResolvedValueOnce([{ Id: 7 }])
                .mockRejectedValueOnce(new Error('deadlock'))
                .mockResolvedValue([]);

            await expect(service.create(game)).rejects.toThrow('Failed to create game');

            expect(statements()).toContain('ROLLBACK');
            expect(client.release).toHaveBeenCalled();
        });

        it('hands the connection back after a successful write too', async function () {
            await service.create(game);

            expect(client.release).toHaveBeenCalledTimes(1);
        });
    });

    describe('update', function () {
        it('runs every statement on the one connection it took', async function () {
            await service.update(game);

            expect(db.startTransaction).toHaveBeenCalledTimes(1);
            expect(db.query).not.toHaveBeenCalled();
            expect(db.queryTran.mock.calls.every((call) => call[0] === client)).toBe(true);
        });

        it('records the result and both players, then commits', async function () {
            await service.update(game);

            const sent = statements();

            expect(sent.filter((sql) => sql.includes('UPDATE "Games"')).length).toBe(1);
            expect(sent.filter((sql) => sql.includes('UPDATE "GamePlayers"')).length).toBe(2);
            expect(sent[sent.length - 1]).toBe('COMMIT');
        });

        it('counts the keys each player finished on', async function () {
            await service.update(game);

            const playerWrites = db.queryTran.mock.calls.filter((call) =>
                String(call[1]).includes('UPDATE "GamePlayers"')
            );

            expect(playerWrites.map((call) => call[2][0])).toEqual([2, 1]);
        });

        it('rolls back and hands the connection back when a write fails', async function () {
            db.queryTran.mockRejectedValueOnce(new Error('connection reset'));

            await expect(service.update(game)).rejects.toThrow('Failed to update game');

            expect(statements()).toContain('ROLLBACK');
            expect(client.release).toHaveBeenCalled();
        });

        it('still reports the failure when the rollback cannot be sent either', async function () {
            // The connection is already gone; the caller still needs the error
            // that started it, not a second one from the tidying up.
            db.queryTran
                .mockRejectedValueOnce(new Error('connection reset'))
                .mockRejectedValueOnce(new Error('connection reset'));

            await expect(service.update(game)).rejects.toThrow('Failed to update game');

            expect(client.release).toHaveBeenCalled();
        });
    });
});
