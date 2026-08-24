const GameSocket = require('../../server/gamenode/gamesocket.js');

/**
 * The admin "Restart" button sent a RESTART command that the node handled by
 * shelling out to `pm2 restart` - and pm2 is not installed anywhere in this
 * stack (production runs each node as its own `restart: unless-stopped`
 * Docker container). `spawnSync` failing does not throw, so the handler
 * silently did nothing: the one control an operator reaches for during an
 * incident had no effect. It now exits the process so the container's
 * restart policy relaunches it, matching `docker restart` by hand.
 */
describe('GameSocket RESTART command', function () {
    const buildSocket = () => {
        // Object.create rather than `new`: the constructor connects to Redis.
        const socket = Object.create(GameSocket.prototype);
        socket.nodeName = 'node-0';

        return socket;
    };

    it('exits the process instead of shelling out to pm2', function () {
        const socket = buildSocket();
        const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {});

        socket.onMessage(JSON.stringify({ command: 'RESTART' }), 'node-0');

        expect(exitSpy).toHaveBeenCalledWith(1);

        exitSpy.mockRestore();
    });
});
