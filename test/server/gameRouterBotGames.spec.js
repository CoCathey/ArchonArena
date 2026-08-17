const GameRouter = require('../../server/gamerouter.js');

/**
 * ARCHON (F9): Helper Bot practice games are invisible to the rest of the
 * platform - the Proving Grounds doctrine, applied to the router. Every
 * official statistic filters only on FinishedAt/WinnerId, so one bot row in
 * "Games" would be a real result in thirty queries at once; and rating reads
 * the rows persistence writes, so keeping the row out keeps the ladder clean.
 *
 * What these specs pin is that every path a finished game can take to the
 * database checks the flag: creation at start, GAMEWIN, and the
 * persistFinishedGame paths (REMATCH / PLAYERLEFT / TOURNAMENTNEXTGAME).
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
        saveReplay: async () => {
            calls.saveReplay++;
        }
    };
    router.ratingService = {
        processGame: async () => {
            calls.processGame++;
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
    it('creates a database row when an ordinary game starts', function () {
        const { router, calls } = buildRouter();

        const node = router.startGame(pendingGame(false));

        expect(node).toBeDefined();
        expect(calls.create).toBe(1);
        expect(calls.commands.map((entry) => entry.command)).toEqual(['STARTGAME']);
    });

    it('creates no row when a bot game starts, but still starts it', function () {
        const { router, calls } = buildRouter();

        const node = router.startGame(pendingGame(true));

        expect(node).toBeDefined();
        expect(calls.create).toBe(0);
        expect(calls.commands.map((entry) => entry.command)).toEqual(['STARTGAME']);
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

    it('neither persists, replays nor rates a bot GAMEWIN', async function () {
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

        expect(calls.update).toBe(0);
        expect(calls.saveReplay).toBe(0);
        expect(calls.processGame).toBe(0);

        // The lobby still hears about it - closing tables and tournament
        // bookkeeping listen to onGameWin, and both no-op safely for bots.
        expect(announced).toEqual({
            event: 'onGameWin',
            game: { gameId: 'uuid-1', botGame: true }
        });
    });

    it('persistFinishedGame skips bot games on every departure path', async function () {
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

        expect(calls.update).toBe(0);

        // And the guard is the flag, not the path: the same messages for an
        // ordinary game all reach the database.
        router.onMessage(
            JSON.stringify({
                identity: 'worker-1',
                command: 'PLAYERLEFT',
                arg: { gameId: 'uuid-2', player: 'somebody', game: { gameId: 'uuid-2' } }
            }),
            'nodemessage'
        );
        await settle();

        expect(calls.update).toBe(1);
    });
});
