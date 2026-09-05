const GameRouter = require('../../server/gamerouter.js');

/**
 * ARCHON (N10): the other half of the durable outbox (see
 * test/server/gamenode/gamesocket.durable.spec.js).
 *
 * The node files a GAMEWIN in an outbox hash before publishing it. Redis
 * pub/sub is at-most-once, so a lobby that was restarting when the game
 * finished never saw the message - and before this, that game was never
 * recorded, rated or replayed, with nothing to tell either player.
 *
 * The lobby drains the outbox when it comes back, and clears an entry only
 * once the game is actually recorded. All three consequences are idempotent
 * already - `update` is an UPDATE by GameId, `saveReplay` is ON CONFLICT DO
 * NOTHING, and `processGame` returns early on a game that already rated - so
 * replaying a message the lobby did receive costs nothing.
 */
const buildRouter = ({ update = async () => {} } = {}) => {
    const calls = { update: 0, saveReplay: 0, processGame: 0, hDel: [] };

    // Object.create rather than `new`: the constructor connects to Redis.
    const router = Object.create(GameRouter.prototype);

    router.gameService = {
        update: async (game) => {
            calls.update++;

            return update(game);
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
    router.outbox = {};
    router.publisher = {
        hGetAll: async () => router.outbox,
        hDel: async (key, field) => {
            calls.hDel.push(field);
            delete router.outbox[field];
        }
    };

    return { router, calls };
};

const settle = () => new Promise((resolve) => setTimeout(resolve, 50));

const gameWinMessage = (gameId) =>
    JSON.stringify({
        identity: 'worker-1',
        command: 'GAMEWIN',
        outboxKey: `GAMEWIN:${gameId}`,
        arg: { game: { gameId }, replay: {} }
    });

describe('GAMEWIN durability across a lobby restart', function () {
    it('replays a result the lobby was not running to receive', async function () {
        const { router, calls } = buildRouter();

        // What a deploy leaves behind: the node published into a channel with
        // no subscriber, and only the outbox still has the game.
        router.outbox = { 'GAMEWIN:uuid-1': gameWinMessage('uuid-1') };

        await router.drainOutbox();
        await settle();

        expect(calls.update).toBe(1);
        expect(calls.processGame).toBe(1);
    });

    it('clears the entry once the game is recorded', async function () {
        const { router, calls } = buildRouter();

        router.outbox = { 'GAMEWIN:uuid-1': gameWinMessage('uuid-1') };

        await router.drainOutbox();
        await settle();

        expect(calls.hDel).toEqual(['GAMEWIN:uuid-1']);
    });

    it('keeps the entry when recording the game fails', async function () {
        // A database fault must leave the result queued rather than
        // acknowledged - otherwise the outbox drops exactly the game it exists
        // to protect.
        const { router, calls } = buildRouter({
            update: async () => {
                throw new Error('Failed to update game');
            }
        });

        router.outbox = { 'GAMEWIN:uuid-1': gameWinMessage('uuid-1') };

        await router.drainOutbox();
        await settle();

        expect(calls.hDel).toEqual([]);
    });

    it('retries a failed result on the next drain', async function () {
        let failNext = true;
        const { router, calls } = buildRouter({
            update: async () => {
                if (failNext) {
                    failNext = false;

                    throw new Error('Failed to update game');
                }
            }
        });

        router.outbox = { 'GAMEWIN:uuid-1': gameWinMessage('uuid-1') };

        await router.drainOutbox();
        await settle();
        await router.drainOutbox();
        await settle();

        expect(calls.update).toBe(2);
        expect(calls.hDel).toEqual(['GAMEWIN:uuid-1']);
    });

    it('clears the entry when a message delivered live is recorded', async function () {
        // The ordinary path: the lobby was up, pub/sub delivered, and the
        // outbox entry the node wrote must not be left behind to be replayed
        // on every drain forever.
        const { router, calls } = buildRouter();

        router.outbox = { 'GAMEWIN:uuid-1': gameWinMessage('uuid-1') };
        router.onMessage(gameWinMessage('uuid-1'), 'nodemessage');

        await settle();

        expect(calls.hDel).toEqual(['GAMEWIN:uuid-1']);
    });

    it('keeps draining when one entry cannot be replayed', async function () {
        // A malformed entry must not strand the queue behind it, and its
        // throw must not escape into the drain timer - an unhandled rejection
        // there would kill the lobby and every game running on it, which is
        // the opposite of what a durability net is for.
        const { router, calls } = buildRouter();

        router.outbox = {
            'GAMEWIN:broken': JSON.stringify({
                identity: 'worker-1',
                command: 'GAMEWIN',
                outboxKey: 'GAMEWIN:broken'
            }),
            'GAMEWIN:uuid-2': gameWinMessage('uuid-2')
        };

        await router.drainOutbox();
        await settle();

        expect(calls.update).toBe(1);
        expect(calls.hDel).toEqual(['GAMEWIN:uuid-2']);
    });

    it('drains every queued result, not just the first', async function () {
        const { router, calls } = buildRouter();

        router.outbox = {
            'GAMEWIN:uuid-1': gameWinMessage('uuid-1'),
            'GAMEWIN:uuid-2': gameWinMessage('uuid-2')
        };

        await router.drainOutbox();
        await settle();

        expect(calls.update).toBe(2);
        expect(calls.hDel.sort()).toEqual(['GAMEWIN:uuid-1', 'GAMEWIN:uuid-2']);
    });
});
