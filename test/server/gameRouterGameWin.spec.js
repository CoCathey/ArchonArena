const GameRouter = require('../../server/gamerouter.js');

/**
 * When a game finishes, the node sends GAMEWIN and the lobby does three things:
 * persist the result, save the replay, and rate the game.
 *
 * Those used to be one promise chain - `update -> saveReplay -> processGame` -
 * which quietly made rating conditional on the replay succeeding. A production
 * database missing the "GameReplays" table hit exactly that: saveReplay
 * rejected, the chain jumped to its catch, and a month of games finished
 * normally without ever reaching the ladder. Nothing was wrong with rating, and
 * no test failed, because nothing tested the two together.
 *
 * These are that test.
 */
const drive = async ({ saveReplay, update = async () => {} }) => {
    const calls = { update: 0, saveReplay: 0, processGame: 0 };

    // Object.create rather than `new`: the constructor connects to Redis.
    const router = Object.create(GameRouter.prototype);

    router.gameService = {
        update: async (game) => {
            calls.update++;

            return update(game);
        },
        saveReplay: async () => {
            calls.saveReplay++;

            return saveReplay();
        }
    };
    router.ratingService = {
        processGame: async () => {
            calls.processGame++;
        }
    };
    router.emit = () => {};
    router.workers = { 'worker-1': { numGames: 1 } };

    router.onMessage(
        JSON.stringify({
            identity: 'worker-1',
            command: 'GAMEWIN',
            arg: { game: { gameId: 'uuid-1' }, replay: {} }
        }),
        'nodemessage'
    );

    // GAMEWIN handling is deliberately fire-and-forget so it never blocks the
    // game flow, so there is nothing to await but a turn of the event loop.
    await new Promise((resolve) => setTimeout(resolve, 50));

    return calls;
};

describe('GAMEWIN handling', function () {
    it('persists, saves the replay and rates the game', async function () {
        const calls = await drive({ saveReplay: async () => 'stored' });

        expect(calls.update).toBe(1);
        expect(calls.saveReplay).toBe(1);
        expect(calls.processGame).toBe(1);
    });

    // The regression. Before the fix this asserted 0.
    it('still rates the game when saving the replay fails', async function () {
        const calls = await drive({
            saveReplay: async () => {
                throw new Error('relation "GameReplays" does not exist');
            }
        });

        expect(calls.saveReplay).toBe(1);
        expect(calls.processGame).toBe(1);
    });

    it('still saves the replay when rating throws', async function () {
        const calls = { saveReplay: 0 };
        const router = Object.create(GameRouter.prototype);

        router.gameService = {
            update: async () => {},
            saveReplay: async () => {
                calls.saveReplay++;

                return 'stored';
            }
        };
        router.ratingService = {
            processGame: async () => {
                throw new Error('rating exploded');
            }
        };
        router.emit = () => {};
        router.workers = {};

        router.onMessage(
            JSON.stringify({
                identity: 'worker-1',
                command: 'GAMEWIN',
                arg: { game: { gameId: 'uuid-1' }, replay: {} }
            }),
            'nodemessage'
        );

        await new Promise((resolve) => setTimeout(resolve, 50));

        expect(calls.saveReplay).toBe(1);
    });

    // Not merely "does not rate" - it must not even try, because there is no
    // persisted game to rate. This is what keeps the first two tests honest:
    // a handler that never ran at all would also report processGame === 0.
    it('does not rate when the game could not be persisted', async function () {
        const calls = await drive({
            saveReplay: async () => 'stored',
            update: async () => {
                throw new Error('database down');
            }
        });

        expect(calls.update).toBe(1);
        expect(calls.saveReplay).toBe(0);
        expect(calls.processGame).toBe(0);
    });
});
