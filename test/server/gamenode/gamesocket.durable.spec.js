const RedisClientFactory = require('../../../server/services/RedisClientFactory');
const GameSocket = require('../../../server/gamenode/gamesocket');
const ConfigService = require('../../../server/services/ConfigService');

/**
 * ARCHON (N10): `nodemessage` is a Redis pub/sub channel, and pub/sub is
 * at-most-once. A deploy restarts the lobby, the lobby is the only subscriber,
 * and Redis drops anything published while it is down - so a game that
 * finished in that window was never recorded, rated or replayed, and nothing
 * told either player.
 *
 * A durable send writes the message to an outbox hash BEFORE publishing it.
 * Redis outlives the lobby (its own container, `appendonly yes` on a named
 * volume), so the record survives the restart and the lobby replays it.
 *
 * These pin the node's half: the write happens, it happens first, and it can
 * never itself become a new way to lose a result.
 */
describe('GameSocket durable sends', function () {
    let gameSocket;
    let createClientSpy;
    let client;
    let calls;

    beforeEach(function () {
        calls = [];
        client = {
            on: vi.fn(),
            connect: vi.fn().mockResolvedValue(undefined),
            get: vi.fn().mockResolvedValue(null),
            subscribe: vi.fn().mockResolvedValue(undefined),
            hSet: vi.fn().mockImplementation(async (...args) => {
                calls.push(['hSet', ...args]);
            }),
            publish: vi.fn().mockImplementation(async (...args) => {
                calls.push(['publish', ...args]);
            })
        };

        createClientSpy = vi
            .spyOn(RedisClientFactory.prototype, 'createClient')
            .mockImplementation(() => client);

        gameSocket = new GameSocket(new ConfigService(), undefined, 'http', 'test');
    });

    afterEach(function () {
        createClientSpy.mockRestore();
    });

    it('writes the message to the outbox before publishing it', async function () {
        await gameSocket.sendDurable('GAMEWIN', { game: { gameId: 'uuid-1' } }, 'GAMEWIN:uuid-1');

        expect(calls.map(([method]) => method)).toEqual(['hSet', 'publish']);
    });

    it('files the outbox entry under the key it was given', async function () {
        await gameSocket.sendDurable('GAMEWIN', { game: { gameId: 'uuid-1' } }, 'GAMEWIN:uuid-1');

        const [, , field] = calls.find(([method]) => method === 'hSet');

        expect(field).toBe('GAMEWIN:uuid-1');
    });

    it('carries the outbox key in the envelope so the lobby can acknowledge it', async function () {
        await gameSocket.sendDurable('GAMEWIN', { game: { gameId: 'uuid-1' } }, 'GAMEWIN:uuid-1');

        const [, , payload] = calls.find(([method]) => method === 'publish');

        expect(JSON.parse(payload).outboxKey).toBe('GAMEWIN:uuid-1');
    });

    it('still publishes when the outbox write fails', async function () {
        // The outbox is a safety net for the transport. If Redis rejects the
        // write we are no worse off than before it existed - but only if the
        // publish still goes out, so the net can never become the hole.
        client.hSet.mockRejectedValue(new Error('READONLY'));

        await gameSocket.sendDurable('GAMEWIN', { game: { gameId: 'uuid-1' } }, 'GAMEWIN:uuid-1');

        expect(client.publish).toHaveBeenCalledTimes(1);
    });
});
