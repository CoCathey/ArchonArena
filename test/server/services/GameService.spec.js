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
