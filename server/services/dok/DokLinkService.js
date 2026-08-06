const logger = require('../../log');
const SecretBox = require('../crypto/secretBox');

/**
 * ARCHON: a player's remembered Decks of KeyForge account.
 *
 * Importing a collection needs the player's DoK key, and buying a deck happens
 * more often than anyone wants to go and find that key again. So a player may
 * ask us to keep it and refresh their collection on a schedule.
 *
 * Three things shape this:
 *
 *  - The key is somebody else's credential, so it is sealed at rest
 *    (crypto/secretBox.js) and this is the only place that unseals it. If the
 *    site secret has been rotated the unseal fails, which is treated as "we do
 *    not have a key" - the player is asked for it again rather than shown a
 *    broken sync.
 *  - DoK issues ONE key per account and generating a new one voids the old
 *    instantly. A stored key therefore dies whenever the player generates
 *    another anywhere, and it has already happened once on this deployment.
 *    So a rejection is a terminal state, not a retry: the schedule stops, the
 *    dead key is dropped, and the UI asks for a new one. Retrying a key DoK has
 *    refused cannot ever succeed and spends a rate limit finding that out.
 *  - Syncing produces a JOB rather than importing anything here. The worker
 *    already paces Master Vault, holds the circuit breaker and survives a
 *    restart; a second importer would be a second thing to get that right.
 */
class DokLinkService {
    constructor(configService, { dokService, deckService, userService, deckImportService } = {}) {
        this.configService = configService;
        this.dokService = dokService;
        this.deckService = deckService;
        this.userService = userService;
        this.deckImportService = deckImportService;
        this.secretBox = new SecretBox(configService.getValue('secret'));
    }

    getConfig() {
        return this.configService.getValue('dok') || {};
    }

    /** Hours between automatic syncs. */
    getSyncIntervalHours() {
        const hours = parseInt(this.getConfig().autoSyncIntervalHours, 10);

        return Number.isFinite(hours) && hours > 0 ? hours : 24;
    }

    /** What the UI may know: never the key, only its state. */
    async getLinkStatus(userId) {
        try {
            const link = await this.userService.getDokLink(userId);

            if (!link) {
                return { hasKey: false, autoSync: false, keyRejected: false, lastSyncAt: null };
            }

            return {
                hasKey: link.hasKey,
                autoSync: link.autoSync,
                keyRejected: !!link.keyRejectedAt,
                lastSyncAt: link.lastSyncAt
            };
        } catch (err) {
            logger.warn(`Failed to read the DoK link for user ${userId}: ${err.message}`);

            return { hasKey: false, autoSync: false, keyRejected: false, lastSyncAt: null };
        }
    }

    /**
     * Remember this key. Returns false when it could not be sealed, and the
     * caller must treat that as "not stored" rather than storing the plaintext:
     * a site with no secret configured should decline to keep credentials, not
     * keep them in the clear.
     */
    async rememberKey(userId, apiKey, { autoSync = true } = {}) {
        const sealedApiKey = this.secretBox.encrypt(String(apiKey || '').trim());

        if (!sealedApiKey) {
            logger.warn(
                `Refusing to store a DoK key for user ${userId}: no site secret to seal it with`
            );

            return false;
        }

        try {
            await this.userService.setDokLink(userId, { sealedApiKey, autoSync });

            return true;
        } catch (err) {
            logger.warn(`Failed to store the DoK key for user ${userId}: ${err.message}`);

            return false;
        }
    }

    async forget(userId) {
        try {
            await this.userService.clearDokLink(userId);

            return true;
        } catch (err) {
            logger.warn(`Failed to forget the DoK key for user ${userId}: ${err.message}`);

            return false;
        }
    }

    /**
     * Sync one player from a key we already hold.
     *
     * `user` is { id, username }. Returns a result the API can send as-is, with
     * `job` set when there is something to import. Never throws: this runs from
     * a lobby sweep as well as a request.
     */
    async syncUser(user) {
        let link;

        try {
            link = await this.userService.getDokLink(user.id);
        } catch (err) {
            logger.warn(`Failed to read the DoK link for user ${user.id}: ${err.message}`);

            return { success: false, message: 'Could not read your Decks of KeyForge link.' };
        }

        if (!link || !link.sealedApiKey) {
            return {
                success: false,
                message: 'No Decks of KeyForge key is stored. Paste one to sync.'
            };
        }

        const apiKey = this.secretBox.decrypt(link.sealedApiKey);

        if (!apiKey) {
            // The site secret changed under us, or the row is damaged. Either
            // way the stored value is unusable, so stop pretending we have one.
            logger.warn(`Stored DoK key for user ${user.id} could not be unsealed; clearing it`);
            await this.forget(user.id);

            return {
                success: false,
                message:
                    'Your stored Decks of KeyForge key could not be read. Please paste it again.'
            };
        }

        return this.syncWithKey(user, apiKey);
    }

    /**
     * The shared body of every sync, whoever supplied the key. Kept separate
     * from syncUser so the interactive import - where the player pastes a key
     * that may not be stored at all - runs exactly the same path.
     */
    async syncWithKey(user, apiKey) {
        const ownedUuids = new Set(await this.deckService.getOwnedDeckUuids(user.id));
        let result;

        try {
            result = await this.dokService.listMyDecks(apiKey, { skipUuids: ownedUuids });
        } catch (err) {
            logger.error(`DoK sync failed for user ${user.username}`, err);

            return {
                success: false,
                message: 'Something went wrong talking to Decks of KeyForge. Please try again.'
            };
        }

        if (result.error) {
            // A refused key can never start working again, so this is where the
            // schedule stops rather than something to retry tomorrow.
            if (result.errorCode === 'key_rejected') {
                await this.markRejected(user.id);

                return {
                    success: false,
                    keyRejected: true,
                    message:
                        'Decks of KeyForge rejected your key. Generate a new one and paste it here — ' +
                        'note that generating a key replaces any previous one.'
                };
            }

            return {
                success: false,
                message: result.errorDetail
                    ? `Decks of KeyForge request failed: ${result.errorDetail}`
                    : 'Could not reach Decks of KeyForge. Please try again in a moment.'
            };
        }

        // Reaching DoK at all proves the key works, so the sync clock moves even
        // when there was nothing new - otherwise an up-to-date collection would
        // be re-listed on every single sweep.
        await this.markSynced(user.id);

        if (!result.decks.length) {
            return {
                success: true,
                total: result.skipped || 0,
                ownedCount: result.skipped || 0,
                queued: 0,
                job: null
            };
        }

        const job = await this.deckImportService.createJob({
            userId: user.id,
            username: user.username,
            uuids: result.decks.map((deck) => deck.uuid)
        });

        if (!job) {
            return { success: false, message: 'Could not start the import. Please try again.' };
        }

        return {
            success: true,
            total: result.decks.length + (result.skipped || 0),
            ownedCount: result.skipped || 0,
            truncated: !!result.truncated,
            partial: !!result.partial,
            queued: result.decks.length,
            job
        };
    }

    async markSynced(userId) {
        try {
            await this.userService.markDokSynced(userId);
        } catch (err) {
            logger.warn(`Failed to stamp the DoK sync time for user ${userId}: ${err.message}`);
        }
    }

    async markRejected(userId) {
        try {
            await this.userService.markDokKeyRejected(userId);
        } catch (err) {
            logger.warn(`Failed to record a rejected DoK key for user ${userId}: ${err.message}`);
        }
    }

    /**
     * One pass of the automatic sync. Deliberately tiny per run - the decks it
     * queues are imported by the deck-import worker at that worker's pace, so
     * listing more collections faster would only lengthen a queue somebody else
     * is already waiting in.
     */
    async syncDue({ limit } = {}) {
        const config = this.getConfig();
        const batch = Math.max(1, parseInt(limit ?? config.autoSyncPerRun, 10) || 3);
        const olderThan = new Date(Date.now() - this.getSyncIntervalHours() * 60 * 60 * 1000);
        let due;

        try {
            due = await this.userService.findDokAutoSyncDue(olderThan, batch);
        } catch (err) {
            logger.warn(`Could not list players due a DoK sync: ${err.message}`);

            return { synced: 0, queued: 0 };
        }

        let synced = 0;
        let queued = 0;

        for (const candidate of due || []) {
            const result = await this.syncUser({
                id: candidate.id,
                username: candidate.username
            });

            synced++;
            queued += (result && result.queued) || 0;

            if (result && result.keyRejected) {
                logger.info(
                    `DoK auto-sync stopped for ${candidate.username}: their key was rejected`
                );
            }
        }

        return { synced, queued };
    }
}

module.exports = DokLinkService;
