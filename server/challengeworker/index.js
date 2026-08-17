const logger = require('../log');
const ChallengeWorker = require('./ChallengeWorker');

/**
 * ARCHON (N24): entrypoint for the Champion's Challenge worker node.
 *
 *   npm run challenge
 *
 * See ChallengeWorker for what this node is for and what it needs. Set
 * `championsChallenge.sweepOwner` to `worker` in site settings so the lobby
 * stops sweeping and this node takes over.
 */
const worker = new ChallengeWorker();

for (const signal of ['SIGTERM', 'SIGINT']) {
    process.on(signal, () => {
        worker.stop();
        // Exit on the next turn so an in-flight sweep's logging lands first.
        setTimeout(() => process.exit(0), 0);
    });
}

worker.start().catch((err) => {
    logger.error('Champion’s Challenge worker failed to start', err);
    process.exit(1);
});
