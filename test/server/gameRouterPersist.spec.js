const GameRouter = require('../../server/gamerouter.js');

/**
 * ARCHON: a failed write must not take the lobby with it.
 *
 * `gameService.update()` is a promise that rejects on any database fault. Four
 * of the five commands that called it did so bare - no await, no catch - which
 * is an unhandled rejection, and under Node's default policy an unhandled
 * rejection terminates the process. So a transient database problem while
 * somebody pressed Rematch, finished a tournament game, or simply left one did
 * not cost a row: it killed the lobby, and every game running on it. GAMEWIN
 * was the only one written defensively, and gameRouterGameWin.spec.js is why.
 *
 * Losing the row is the right failure. The game is over either way, and what
 * the players do next matters more than the record of what they just did.
 */
const drive = async (command, { update = async () => {} } = {}) => {
    const calls = { update: 0, emitted: [] };

    // Object.create rather than `new`: the constructor connects to Redis.
    const router = Object.create(GameRouter.prototype);

    router.gameService = {
        update: async (game) => {
            calls.update++;

            return update(game);
        }
    };
    router.emit = (...args) => calls.emitted.push(args[0]);
    router.workers = { 'worker-1': { numGames: 1 } };

    router.onMessage(
        JSON.stringify({
            identity: 'worker-1',
            command,
            arg: { game: { gameId: 'uuid-1' }, gameId: 'uuid-1', player: 'alice' }
        }),
        'nodemessage'
    );

    // Let the rejection, if there is one, reach its handler.
    await new Promise((resolve) => setImmediate(resolve));

    return { calls, router };
};

describe('GameRouter persisting a finished game', function () {
    // `freesWorker` is false for PLAYERLEFT on purpose: one player walking out
    // does not end the game, so the node is still running it and its slot is
    // still taken.
    const COMMANDS = [
        ['REMATCH', 'onGameRematch', true],
        ['REMATCHWITHNEWDECKS', 'onGameRematchWithNewDecks', true],
        ['TOURNAMENTNEXTGAME', 'onTournamentNextGame', true],
        ['PLAYERLEFT', 'onPlayerLeft', false]
    ];

    for (const [command, event, freesWorker] of COMMANDS) {
        describe(command, function () {
            it('persists the game', async function () {
                const { calls } = await drive(command);

                expect(calls.update).toBe(1);
                expect(calls.emitted).toContain(event);
            });

            it('survives the write failing, and still hands the game on', async function () {
                const { calls } = await drive(command, {
                    update: async () => {
                        throw new Error('database is down');
                    }
                });

                expect(calls.update).toBe(1);
                // The important half: the lobby still gets told, so the players
                // are seated at whatever comes next rather than stranded.
                expect(calls.emitted).toContain(event);
            });

            it('accounts for the worker slot even when the write failed', async function () {
                const { router } = await drive(command, {
                    update: async () => {
                        throw new Error('database is down');
                    }
                });

                expect(router.workers['worker-1'].numGames).toBe(freesWorker ? 0 : 1);
            });
        });
    }

    it('reports the failure against the game it could not write', async function () {
        // A rejected update is invisible otherwise - the whole point is that
        // nothing downstream waits on it.
        const logger = require('../../server/log');
        const errors = [];
        const original = logger.error;

        logger.error = (...args) => errors.push(args.join(' '));

        try {
            await drive('REMATCH', {
                update: async () => {
                    throw new Error('database is down');
                }
            });
        } finally {
            logger.error = original;
        }

        expect(errors.some((line) => line.includes('uuid-1'))).toBe(true);
    });
});
