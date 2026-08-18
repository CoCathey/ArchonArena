const GameRouter = require('../../server/gamerouter.js');

/**
 * ARCHON (F9): a practice game is recorded, and is never a result.
 *
 * The two halves are separate on purpose, and this is where they part:
 *
 *  - **Recorded.** The row is written and the replay is saved, because a
 *    player wants to find the game again, watch it back, and show somebody
 *    the turn that won it. A game that was never written down can do none of
 *    that.
 *  - **Never a result.** The rating engine is never called for it, so no
 *    Amber moves and no record changes. The row carries `botGame` so every
 *    aggregate can exclude it (see botGamesAreNotResults.spec.js, which
 *    reads the source to prove none of them forgets).
 */
const buildRouter = () => {
    const calls = { create: 0, update: 0, saveReplay: 0, processGame: 0, commands: [] };

    // Object.create rather than `new`: the constructor connects to Redis.
    const router = Object.create(GameRouter.prototype);

    router.gameService = {
        create: (state) => {
            calls.create++;
            calls.createdWith = state;
        },
        update: async (game) => {
            calls.update++;
            calls.updatedWith = game;
        },
        saveReplay: async (gameId) => {
            calls.saveReplay++;
            calls.replayFor = gameId;
        }
    };
    router.ratingService = {
        processGame: async (gameId) => {
            calls.processGame++;
            calls.ratedGame = gameId;
        }
    };
    router.emit = () => {};
    router.workers = { 'worker-1': { numGames: 1 } };
    router.sendCommand = (channel, command, arg) => {
        calls.commands.push({ channel, command, arg });
    };
    router.getNextAvailableGameNode = () => router.workers['worker-1'];

    return { router, calls };
};

const settle = () => new Promise((resolve) => setTimeout(resolve, 50));

const pendingGame = (botGame) => ({
    botGame,
    getSaveState: () => ({ gameId: 'uuid-1', botGame: botGame || undefined }),
    getStartGameDetails: () => ({ id: 'uuid-1', botGame: botGame || undefined })
});

describe('bot games and the router', function () {
    it('records a bot game like any other, carrying the flag', function () {
        const { router, calls } = buildRouter();

        const node = router.startGame(pendingGame(true));

        expect(node).toBeDefined();
        expect(calls.create).toBe(1);
        // The flag rides with the row, which is what lets every aggregate
        // leave it out later.
        expect(calls.createdWith.botGame).toBe(true);
        expect(calls.commands.map((entry) => entry.command)).toEqual(['STARTGAME']);
    });

    it('records an ordinary game with no flag at all', function () {
        const { router, calls } = buildRouter();

        router.startGame(pendingGame(false));

        expect(calls.create).toBe(1);
        expect(calls.createdWith.botGame).toBeUndefined();
    });

    it('persists, replays and rates an ordinary GAMEWIN', async function () {
        const { router, calls } = buildRouter();

        router.onMessage(
            JSON.stringify({
                identity: 'worker-1',
                command: 'GAMEWIN',
                arg: { game: { gameId: 'uuid-1' }, replay: {} }
            }),
            'nodemessage'
        );
        await settle();

        expect(calls.update).toBe(1);
        expect(calls.saveReplay).toBe(1);
        expect(calls.processGame).toBe(1);
    });

    it('persists and replays a bot GAMEWIN, but never rates it', async function () {
        const { router, calls } = buildRouter();
        let announced = null;

        router.emit = (event, game) => {
            announced = { event, game };
        };

        router.onMessage(
            JSON.stringify({
                identity: 'worker-1',
                command: 'GAMEWIN',
                arg: { game: { gameId: 'uuid-1', botGame: true }, replay: {} }
            }),
            'nodemessage'
        );
        await settle();

        // Findable and watchable...
        expect(calls.update).toBe(1);
        expect(calls.saveReplay).toBe(1);
        expect(calls.replayFor).toBe('uuid-1');
        // ...and it moved nobody's Amber.
        expect(calls.processGame).toBe(0);

        expect(announced).toEqual({
            event: 'onGameWin',
            game: { gameId: 'uuid-1', botGame: true }
        });
    });

    it('records a bot game that ended by rematch or a player leaving', async function () {
        const { router, calls } = buildRouter();

        for (const command of ['REMATCH', 'TOURNAMENTNEXTGAME', 'REMATCHWITHNEWDECKS']) {
            router.onMessage(
                JSON.stringify({
                    identity: 'worker-1',
                    command,
                    arg: { game: { gameId: 'uuid-1', botGame: true } }
                }),
                'nodemessage'
            );
        }

        router.onMessage(
            JSON.stringify({
                identity: 'worker-1',
                command: 'PLAYERLEFT',
                arg: { gameId: 'uuid-1', player: 'somebody', game: { botGame: true } }
            }),
            'nodemessage'
        );
        await settle();

        // A game somebody walked out of is still a game they played.
        expect(calls.update).toBe(4);
        // And still not a result: the rating engine was never asked.
        expect(calls.processGame).toBe(0);
    });
});
