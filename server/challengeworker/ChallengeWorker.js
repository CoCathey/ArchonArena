const os = require('node:os');

const logger = require('../log');
const ConfigService = require('../services/ConfigService');
const ChampionsChallengeService = require('../services/championschallenge/ChampionsChallengeService');
const settings = require('../services/settings');

/**
 * ARCHON (N24): the Champion's Challenge on a node of its own.
 *
 * Why this process exists
 * -----------------------
 * A simulated game is about half a second of solid CPU, a deep showcase game is
 * closer to a minute, and the sweep plays them in a loop. Inside the lobby that
 * is CPU taken from the process handling chat, matchmaking and the socket
 * traffic of people playing real games - and the lab is the one workload on the
 * site with nobody waiting on it, so it is exactly the workload that should be
 * somewhere else.
 *
 * Run this on its own machine and the arrangement becomes: the lobby serves
 * people, the game nodes host real games, and this node grinds out sparring
 * games. Set `championsChallenge.sweepOwner` to `worker` and the lobby stands
 * down; the two never both play, because the right to sweep is a database lease
 * (see ChampionsChallengeService.claimSweepLease), so a misconfiguration costs
 * an idle worker rather than a roster played twice as hard as its budget allows.
 *
 * What it needs
 * -------------
 * Postgres, and nothing else. The lab reads its card data from the pack files on
 * disk rather than the Redis-backed CardService (see packCards), it never talks
 * to the game nodes, and it serves no HTTP - so this node needs no Redis, no
 * open ports, and no session secrets. It does make outbound requests to Master
 * Vault and Decks of KeyForge when the Gauntlet pool is growing.
 *
 * Failure behaviour: a sweep that throws is logged and the next tick is
 * scheduled anyway. This process is meant to be restarted by whatever runs it
 * and to be safe to kill at any moment - an interrupted sweep loses at most the
 * game in flight, which is recorded nowhere until it finishes.
 */
class ChallengeWorker {
    constructor({ configService = null, championsChallengeService = null, owner = null } = {}) {
        this.configService = configService || new ConfigService();
        this.service =
            championsChallengeService || new ChampionsChallengeService(this.configService);
        // Identifies this process in the lease row, so an operator looking at the
        // table can see WHICH node is playing rather than just that someone is.
        this.owner = owner || `worker@${os.hostname()}:${process.pid}`;
        this.timer = null;
        this.running = false;
        this.stopped = false;
    }

    /** Load settings, then tick until stopped. */
    async start() {
        // The lab's knobs are runtime admin settings, so the snapshot has to be
        // loaded here the way the lobby loads it at boot.
        if (settings.start) {
            settings.start();
        }

        logger.info(`Champion’s Challenge worker starting as ${this.owner}`);

        this.scheduleNext(0);
    }

    scheduleNext(delayMs) {
        if (this.stopped) {
            return;
        }

        const seconds = Math.max(5, Number(this.intervalSeconds()) || 60);

        this.timer = setTimeout(
            () => this.tick(),
            delayMs === undefined ? seconds * 1000 : delayMs
        );
        // Never hold the process open on the timer alone; stop() decides that.
        if (this.timer.unref) {
            this.timer.unref();
        }
    }

    intervalSeconds() {
        try {
            return this.service.getConfig().sweepIntervalSeconds;
        } catch (err) {
            logger.error('Champion’s Challenge worker could not read its interval', err);

            return 60;
        }
    }

    /**
     * One pass: claim the lease, sweep, log, schedule the next.
     *
     * Overlap is impossible by construction - the next tick is only scheduled
     * once this one has finished - so a sweep that takes longer than the
     * interval slows the cadence instead of stacking up.
     */
    async tick() {
        if (this.stopped || this.running) {
            return;
        }

        this.running = true;

        try {
            const result = await this.service.runSweepAs('worker', this.owner);

            if (result.skipped === 'not-this-node') {
                // Loud, and only here: an operator who started this node while
                // the lobby still owns the sweep needs to know why it is idle.
                logger.warn(
                    'Champion’s Challenge worker is idle: championsChallenge.sweepOwner is ' +
                        `'${this.service.getConfig().sweepOwner || 'lobby'}'. Set it to 'worker' ` +
                        "(or 'any') for this node to play."
                );
            } else if (result.played > 0 || result.abandoned > 0) {
                logger.info(
                    `Champion’s Challenge worker played ${result.played} game(s), ` +
                        `abandoned ${result.abandoned}`
                );
            }
        } catch (err) {
            logger.error('Champion’s Challenge worker sweep failed', err);
        } finally {
            this.running = false;
            this.scheduleNext();
        }
    }

    /** Stop ticking. A sweep already in flight is left to finish. */
    stop() {
        this.stopped = true;

        if (this.timer) {
            clearTimeout(this.timer);
            this.timer = null;
        }

        logger.info('Champion’s Challenge worker stopped');
    }
}

module.exports = ChallengeWorker;
