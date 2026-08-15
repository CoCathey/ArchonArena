const http = require('http');
const logger = require('../log.js');

/**
 * The game node's out-of-band control and health surface, on its own port so it
 * is reachable when the socket.io port is busy and so it can be kept off the
 * public reverse proxy entirely.
 *
 * ARCHON: this port is what makes a zero-downtime deploy possible. A game lives
 * in one node process's memory and cannot be moved, so the only way to replace a
 * node without ending anyone's game is to stop giving it new games and wait for
 * the ones it has to finish. That is two different operations, and conflating
 * them is what made the old drain unusable:
 *
 *   quiesce  (POST /health/drain)  - stop accepting new games, keep serving the
 *                                    current ones, stay up. Reversible.
 *   drain    (SIGTERM, RESTART)    - quiesce, then exit once the last game ends.
 *
 * The deploy script needs the first. If asking a node to stand down also made it
 * exit, Docker's restart policy would immediately bring it back on the *old*
 * image and it would start taking games again in the window before the script
 * could replace it - the exact race a rolling deploy must not have.
 */
class HealthServer {
    /**
     * @param {import("./gameserver")} gameServer
     * @param {number | { port?: number, drainTimeoutMs?: number,
     *                    drainPollMs?: number, exit?: (code: number) => void }} [options]
     *   A bare number is accepted for the original `(gameServer, port)` signature.
     */
    constructor(gameServer, options = {}) {
        const opts = typeof options === 'number' ? { port: options } : options;
        const envPort = Number(process.env.HEALTH_PORT);

        this.gameServer = gameServer;
        // Explicit undefined check rather than `||`: port 0 means "any free
        // port", which the tests rely on and which `||` would silently turn
        // into 9000.
        this.port =
            opts.port !== undefined
                ? opts.port
                : Number.isFinite(envPort) && envPort > 0
                ? envPort
                : 9000;

        // How long a drain waits for games to finish before giving up on them.
        // Matched by stop_grace_period in docker-compose.prod.yml and by
        // terminationGracePeriodSeconds in the Helm chart - if the orchestrator's
        // patience is shorter than this the drain is decoration.
        this.drainTimeoutMs = opts.drainTimeoutMs || 90 * 60 * 1000;
        this.drainPollMs = opts.drainPollMs || 10 * 1000;
        this.exit = opts.exit || ((code) => process.exit(code));

        // Quiesced: the lobby has been told to stop placing games here.
        this.isDraining = false;
        // Additionally exiting once the last game ends. One-way - a node on its
        // way out must not be talked back into service half way.
        this.willExit = false;

        this.server = null;
        this.drainCheckInterval = null;
        this.drainTimeout = null;

        this.setupSignalHandlers();
    }

    setupSignalHandlers() {
        // In scenario dev mode the CLI owns the lifecycle and sends SIGINT
        // when the user wants to exit. Skip the graceful drain — there's a
        // permanent scenario game that will keep the drain spinning forever.
        if (process.env.SCENARIO) {
            return;
        }
        process.on('SIGTERM', () => {
            logger.info('Received SIGTERM - starting graceful shutdown');
            this.startDraining();
        });
    }

    /**
     * Stop accepting new games without shutting down. Reversible with resume().
     *
     * @returns {boolean} whether this changed anything
     */
    quiesce() {
        if (this.isDraining) {
            return false;
        }

        this.isDraining = true;
        logger.info('Node is now draining - will not accept new games');

        this.publishDrainState();

        return true;
    }

    /**
     * Take a quiesced node back into service. Refused once it is on its way out:
     * the games it is waiting on are the only reason it is still running.
     *
     * @returns {boolean} whether this changed anything
     */
    resume() {
        if (this.willExit || !this.isDraining) {
            return false;
        }

        this.isDraining = false;
        logger.info('Node resumed - accepting new games again');

        this.publishDrainState();

        return true;
    }

    /** Tell the lobby, via the next HELLO, whether to place games here. */
    publishDrainState() {
        if (this.gameServer && this.gameServer.gameSocket) {
            this.gameServer.gameSocket.setDraining(this.isDraining);
        }
    }

    /**
     * Quiesce and then exit once the last game finishes, or when patience runs
     * out. Used by SIGTERM and by the admin Restart command; Docker's restart
     * policy is what brings the node back after the exit.
     */
    startDraining() {
        if (this.willExit) {
            return false;
        }

        this.willExit = true;
        this.quiesce();

        const finishIfEmpty = () => {
            const numGames = this.getNumGames();

            if (numGames === 0) {
                logger.info('All games finished. Shutting down now.');
                this.clearDrainTimers();
                this.exit(0);

                return true;
            }

            return false;
        };

        // Check immediately: a node with nothing running should not sit through
        // a poll interval, which is dead time in the middle of every deploy.
        if (finishIfEmpty()) {
            return true;
        }

        this.drainCheckInterval = setInterval(() => {
            const numGames = this.getNumGames();
            logger.info(`Draining: ${numGames} games still active`);

            finishIfEmpty();
        }, this.drainPollMs);

        this.drainTimeout = setTimeout(() => {
            logger.warn(
                `Drain timeout (${Math.round(
                    this.drainTimeoutMs / 60000
                )} minutes) exceeded. Forcing shutdown.`
            );
            this.clearDrainTimers();
            this.exit(1);
        }, this.drainTimeoutMs);

        // The http server keeps the process alive on its own; unref'd timers
        // mean a drain can never be the only reason a process lingers.
        this.drainCheckInterval.unref?.();
        this.drainTimeout.unref?.();

        return true;
    }

    clearDrainTimers() {
        if (this.drainCheckInterval) {
            clearInterval(this.drainCheckInterval);
            this.drainCheckInterval = null;
        }

        if (this.drainTimeout) {
            clearTimeout(this.drainTimeout);
            this.drainTimeout = null;
        }
    }

    start() {
        this.server = http.createServer((req, res) => {
            const url = (req.url || '').split('?')[0];
            const method = (req.method || 'GET').toUpperCase();

            if (url === '/health/alive') {
                this.handleAlive(res);
            } else if (url === '/health/ready') {
                this.handleReady(res);
            } else if (url === '/health/games') {
                this.handleGames(res);
            } else if (url === '/health/status') {
                this.handleStatus(res);
            } else if (url === '/health/drain') {
                // POST-only: draining a node is a state change, and a GET route
                // that stands a node down is one crawler or misconfigured
                // uptime check away from taking games off a live server.
                this.requirePost(method, res, () => {
                    this.quiesce();
                    this.handleStatus(res);
                });
            } else if (url === '/health/resume') {
                this.requirePost(method, res, () => {
                    this.resume();
                    this.handleStatus(res);
                });
            } else {
                res.writeHead(404, { 'Content-Type': 'text/plain' });
                res.end('Not Found');
            }
        });

        this.server.listen(this.port, () => {
            logger.info(`Health check server listening on port ${this.port}`);
        });
    }

    requirePost(method, res, handler) {
        if (method !== 'POST') {
            res.writeHead(405, { 'Content-Type': 'application/json', Allow: 'POST' });
            res.end(JSON.stringify({ error: 'method not allowed', allow: 'POST' }));

            return;
        }

        handler();
    }

    handleAlive(res) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
            JSON.stringify({
                status: 'alive',
                uptime: process.uptime()
            })
        );
    }

    handleReady(res) {
        const isReady = !this.isDraining;
        const statusCode = isReady ? 200 : 503;

        res.writeHead(statusCode, { 'Content-Type': 'application/json' });
        res.end(
            JSON.stringify({
                ready: isReady,
                draining: this.isDraining,
                numGames: this.getNumGames()
            })
        );
    }

    handleGames(res) {
        const numGames = this.getNumGames();

        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end(String(numGames));
    }

    /**
     * Everything a deploy needs in one call: is this the node I just replaced
     * (identity/version), has it stood down (draining), and is it safe to
     * replace now (numGames).
     */
    handleStatus(res) {
        const gameSocket = this.gameServer && this.gameServer.gameSocket;

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
            JSON.stringify({
                identity: gameSocket ? gameSocket.nodeName : undefined,
                version: gameSocket ? gameSocket.version : undefined,
                draining: this.isDraining,
                shuttingDown: this.willExit,
                numGames: this.getNumGames(),
                uptime: process.uptime()
            })
        );
    }

    getNumGames() {
        if (!this.gameServer || !this.gameServer.games) {
            return 0;
        }
        return Object.keys(this.gameServer.games).length;
    }

    stop() {
        this.clearDrainTimers();
        if (this.server) {
            this.server.close();
        }
    }
}

module.exports = HealthServer;
