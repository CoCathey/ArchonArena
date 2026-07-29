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
