const { Server } = require('socket.io');
const Socket = require('./socket.js');
const jwt = require('jsonwebtoken');
const _ = require('underscore');

const logger = require('./log');
const PendingGame = require('./pendinggame');
const GameRouter = require('./gamerouter');
const ServiceFactory = require('./services/ServiceFactory');
const DeckService = require('./services/DeckService');
const GameService = require('./services/GameService');
// ARCHON: in-app/email notifications (N2)
const sharedNotificationService = require('./services/notifications');
const tournamentNotifications = require('./services/notifications/tournamentNotifications');
const DokService = require('./services/dok/DokService');
const CatalogService = require('./services/catalog/CatalogService');
const DeckImportJobService = require('./services/deckimport/DeckImportJobService');
const DokLinkService = require('./services/dok/DokLinkService');
const UserService = require('./services/UserService');
const ConfigService = require('./services/ConfigService');
// ARCHON: native tournaments create/report lobby games automatically
const TournamentService = require('./services/tournament/TournamentService');
const tournamentEvents = require('./services/tournament/tournamentEvents');
// ARCHON: Quick Match matchmaking queue (Amber-based pairing)
const MatchmakingService = require('./services/matchmaking/MatchmakingService');
const RatingService = require('./services/rating/RatingService');
const User = require('./models/User');
const { sortBy } = require('./Array');

// ARCHON: game formats a player can queue for in Quick Match.
const MATCHMAKING_FORMATS = [
    'normal',
    'sealed',
    'reversal',
    'adaptive-bo1',
    'alliance',
    'unchained'
];

class Lobby {
    constructor(server, options = {}) {
        this.sockets = {};
        this.socketsByName = {};
        this.users = {};
        this.games = {};
        this.configService = options.configService || new ConfigService();
        this.messageService = options.messageService || ServiceFactory.messageService();
        this.cardService = options.cardService || ServiceFactory.cardService(options.configService);
        this.userService = options.userService || new UserService(options.configService);
        this.deckService =
            options.deckService || new DeckService(this.configService, this.cardService);
        // ARCHON: SAS lookup for the pre-game screen. Cached reads only - the
        // deck-selection path must never wait on an outbound DoK call.
        this.dokService = options.dokService || new DokService(this.configService);
        // ARCHON: Master Vault name -> uuid index. The lobby holds it only to
        // run the crawl below; searching it is an API concern.
        this.catalogService = options.catalogService || new CatalogService(this.configService);
        // ARCHON: bulk collection import as a resumable job. The lobby holds it
        // to run the sweep below; creating and reporting jobs is an API concern.
        this.deckImportService =
            options.deckImportService || new DeckImportJobService(this.configService);
        this.router = options.router || new GameRouter(this.configService);

        this.router.on('onGameClosed', this.onGameClosed.bind(this));
        this.router.on('onGameRematch', this.onGameRematch.bind(this));
        this.router.on('onGameRematchWithNewDecks', this.onGameRematchWithNewDecks.bind(this));
        // ARCHON: a tournament series continuing at the table it is already at.
        this.router.on('onTournamentNextGame', this.onTournamentNextGame.bind(this));
        this.router.on('onPlayerLeft', this.onPlayerLeft.bind(this));
        this.router.on('onWorkerTimedOut', this.onWorkerTimedOut.bind(this));
        this.router.on('onNodeReconnected', this.onNodeReconnected.bind(this));
        this.router.on('onWorkerStarted', this.onWorkerStarted.bind(this));

        // ARCHON: tournament engine integration - auto-created table
        // games per pairing and auto-reported results (Phase 7 inc. 2)
        this.tournamentService = options.tournamentService || new TournamentService();
        this.router.on('onGameWin', this.onTournamentGameWin.bind(this));
        tournamentEvents.on('roundPaired', this.onTournamentRoundPaired.bind(this));
        tournamentEvents.on('ensureMatchGame', this.onTournamentEnsureMatchGame.bind(this));
        tournamentEvents.on('deckRegistered', this.onTournamentDeckRegistered.bind(this));

        // ARCHON: tell paired players their round is up (N2). A separate
        // listener on the same bridge, so a notification failure cannot affect
        // table creation and vice versa.
        this.notificationService = options.notificationService || sharedNotificationService;
        // ARCHON (N8): matchmaking queue metrics. Optional - a lobby built
        // without one simply records nothing.
        this.analyticsService = options.analyticsService || null;
        // ARCHON (N5): mute and timeout enforcement on the chat paths.
        // Optional for the same reason: a lobby built without one enforces
        // nothing rather than failing to start.
        this.moderationService = options.moderationService || null;
        tournamentNotifications.install({
            tournamentService: this.tournamentService,
            notificationService: this.notificationService
        });

        // ARCHON: Quick Match matchmaking - queue players and pair them by Amber.
        this.ratingService = options.ratingService || new RatingService(this.configService);
        this.matchmaking = options.matchmaking || new MatchmakingService();
        // Re-attempt pairings periodically so waiting players match as their
        // Amber tolerance widens, even when nobody new joins. Unref'd so it
        // never keeps the process (or a test runner) alive on its own.
        this.matchmakingSweep = setInterval(() => this.runMatchmaking(), 3000);
        if (this.matchmakingSweep && this.matchmakingSweep.unref) {
            this.matchmakingSweep.unref();
        }

        // Automatic inactive-player rating decay. Ticks hourly but only applies
        // as often as the admin-configured cadence (decay.autoApplyHours), and
        // is a no-op while decay is disabled. applyDecay is idempotent (it
        // writes absolute ratings gated by LastDecayAt), so a tick with nothing
        // due - or one overlapping another lobby instance - is harmless.
        this.lastDecayRunMs = 0;
        this.decaySweep = setInterval(() => this.runDecaySweep(), 60 * 60 * 1000);
        if (this.decaySweep && this.decaySweep.unref) {
            this.decaySweep.unref();
        }

        // ARCHON: replay retention (N1). Ticks hourly and only deletes once the
        // admin-configured cadence is due; a retention of 0 days (the default)
        // keeps everything, so a site that has not decided on a policy never
        // silently destroys game history.
        this.gameService = options.gameService || new GameService();
        this.lastReplayPurgeMs = 0;
        this.replayPurgeSweep = setInterval(() => this.runReplayPurge(), 60 * 60 * 1000);
        if (this.replayPurgeSweep && this.replayPurgeSweep.unref) {
            this.replayPurgeSweep.unref();
        }

        // ARCHON: periodic SAS refresh (N3). Refresh used to happen only when
        // someone opened a deck, so a deck nobody looked at kept a stale score
        // forever and the whole site's SAS drifted with the DoK model. The
        // sweep spends only what this minute's DoK budget leaves over.
        this.sasSweep = setInterval(() => this.runSasRefreshSweep(), 15 * 60 * 1000);
        if (this.sasSweep && this.sasSweep.unref) {
            this.sasSweep.unref();
        }

        // ARCHON: Master Vault catalog crawl. Ticks every minute and consults
        // the configured cadence on each tick, the way decay and replay
        // retention do, because that cadence is an admin setting: the reason an
        // operator reaches for it is that Master Vault is unhappy with us, and
        // a value baked into setInterval would not take effect until the lobby
        // was restarted.
        this.lastCatalogCrawlMs = 0;
        this.catalogSweep = setInterval(() => this.runCatalogCrawl(), 60 * 1000);
        if (this.catalogSweep && this.catalogSweep.unref) {
            this.catalogSweep.unref();
        }

        // ARCHON: collection import worker. Ticks far more often than the other
        // sweeps because a tick is local work plus a handful of paced requests,
        // and a player is watching the progress bar it moves. The cadence it
        // actually runs at is read from config on each tick, the way the crawl's
        // is: the reason an operator reaches for it is that Master Vault is
        // unhappy with us, and a value baked into setInterval would not take
        // effect until the lobby was restarted.
        this.lastDeckImportSweepMs = 0;
        this.deckImportSweep = setInterval(() => this.runDeckImportSweep(), 5 * 1000);
        if (this.deckImportSweep && this.deckImportSweep.unref) {
            this.deckImportSweep.unref();
        }

        // ARCHON: refresh remembered Decks of KeyForge collections. This only
        // LISTS collections and queues jobs; the deck-import sweep above is
        // what actually talks to Master Vault, so auto-sync inherits its pacing
        // and its circuit breaker instead of becoming a second importer with
        // its own opinions about how fast is polite.
        this.dokLinkService =
            options.dokLinkService ||
            new DokLinkService(this.configService, {
                dokService: this.dokService,
                deckService: this.deckService,
                userService: this.userService,
                deckImportService: this.deckImportService
            });
        this.lastDokAutoSyncMs = 0;
        this.dokAutoSyncSweep = setInterval(() => this.runDokAutoSync(), 60 * 1000);
        if (this.dokAutoSyncSweep && this.dokAutoSyncSweep.unref) {
            this.dokAutoSyncSweep.unref();
        }

        // ARCHON (N14): asynchronous tournaments are paced in days, so their
        // round deadlines pass while nobody is looking at the page. This is
        // the only clock that notices - it flags a passed deadline once and
        // tells the organizer (and the players still holding the round up).
        // A minute of granularity is ample for a deadline measured in days.
        this.roundDeadlineSweep = setInterval(() => this.runRoundDeadlineSweep(), 60 * 1000);
        if (this.roundDeadlineSweep && this.roundDeadlineSweep.unref) {
            this.roundDeadlineSweep.unref();
        }

        this.userService.on('onBlocklistChanged', this.onBlocklistChanged.bind(this));

        this.io =
            options.io ||
            new Server(server, {
                perMessageDeflate: false,
                pingTimeout: 30000
            });
        this.io.use(this.handshake.bind(this));
        this.io.on('connection', this.onConnection.bind(this));

        this.messageService.on('messageDeleted', (messageId, user) => {
            for (let socket of Object.values(this.sockets)) {
                if (socket.user === user || (socket.user && socket.user.hasUserBlocked(user))) {
                    continue;
                }

                if (
                    socket.user &&
                    socket.user.permissions &&
                    socket.user.permissions.canModerateChat
                ) {
                    socket.send('removemessage', messageId, user.username);
                } else {
                    socket.send('removemessage', messageId);
                }
            }
        });

        setInterval(() => this.clearStalePendingGames(), 60 * 1000); // every minute
        setInterval(() => this.clearOldRefreshTokens(), 2 * 60 * 60 * 1000); // every 2 hours
    }

    // Periodic (hourly-checked) automatic rating decay, gated by the
    // admin-configured cadence. See the constructor for why this is safe.
    async runDecaySweep() {
        if (!this.ratingService) {
            return;
        }

        try {
            const decay = this.ratingService.getConfig().decay || {};
            const hours = decay.enabled ? decay.autoApplyHours || 0 : 0;

            if (hours <= 0) {
                return;
            }

            const now = Date.now();
            if (now - this.lastDecayRunMs < hours * 60 * 60 * 1000) {
                return;
            }

            this.lastDecayRunMs = now;
            const result = await this.ratingService.applyDecay(now);

            if (result && result.decayed > 0) {
                logger.info(`Rating decay auto-applied to ${result.decayed} rating(s)`);
            }
        } catch (err) {
            logger.error('Rating decay sweep failed', err);
        }
    }

    /**
     * ARCHON: replay retention (N1). Hourly tick, gated by the admin-configured
     * purge cadence; deleting is idempotent (rows past the window are simply
     * gone the second time), so an overlapping run on another lobby instance is
     * harmless.
     */
    async runReplayPurge() {
        try {
            const config = this.gameService.getReplayConfig();
            const hours = Number(config.purgeIntervalHours) || 0;
            const retentionDays = Number(config.retentionDays) || 0;

            if (hours <= 0 || retentionDays <= 0) {
                return;
            }

            const now = Date.now();
            if (now - this.lastReplayPurgeMs < hours * 60 * 60 * 1000) {
                return;
            }

            this.lastReplayPurgeMs = now;
            await this.gameService.purgeExpiredReplays(retentionDays);
        } catch (err) {
            logger.error('Replay retention sweep failed', err);
        }
    }

    /**
     * ARCHON: periodic SAS refresh (N3).
     *
     * Deliberately opportunistic. It asks the DoK service to refresh the
     * stalest decks and stops the moment this minute's shared request budget is
     * spent, so a live deck import or a pre-game SAS lookup is never queued
     * behind the sweep. Whatever it does not reach this pass, it reaches on the
     * next one.
     */
    async runSasRefreshSweep() {
        if (!this.dokService) {
            return;
        }

        try {
            const result = await this.dokService.refreshStaleDecks();

            if (result && result.refreshed > 0) {
                logger.info(
                    `SAS refresh sweep updated ${result.refreshed} deck(s)` +
                        (result.budgetExhausted ? ' (DoK budget reached, will continue later)' : '')
                );
            }
        } catch (err) {
            logger.error('SAS refresh sweep failed', err);
        }
    }

    /**
     * ARCHON: Master Vault catalog crawl.
     *
     * This is only the clock. Where the walk has got to, how hard it may push
     * Master Vault and when its circuit breaker has parked it all live in the
     * crawler, so the lobby's whole job is to decide that a run is due and to
     * survive whatever comes back. Silence on a run that indexed nothing is
     * deliberate: once the walk catches up with Master Vault most runs find no
     * new decks, and an hourly line saying so would only train people to
     * ignore the log.
     */
    async runCatalogCrawl() {
        if (!this.catalogService) {
            return;
        }

        try {
            const minutes = Number(this.catalogService.getConfig().crawlIntervalMinutes) || 0;

            if (minutes <= 0) {
                return;
            }

            const now = Date.now();
            if (now - this.lastCatalogCrawlMs < minutes * 60 * 1000) {
                return;
            }

            this.lastCatalogCrawlMs = now;
            const result = await this.catalogService.crawlOnce();

            if (result && result.indexed > 0) {
                logger.info(
                    `Master Vault catalog crawl indexed ${result.indexed} deck(s)` +
                        (result.paused ? ' (Master Vault failing, crawl now backing off)' : '')
                );
            }
        } catch (err) {
            logger.error('Master Vault catalog crawl failed', err);
        }
    }

    sleep(ms) {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }

    /**
     * ARCHON: import a few decks of one player's collection, then stop.
     *
     * This loop used to live in the browser. The server listed the collection
     * and handed back uuids; the client posted them back a deck at a time. That
     * made the import a property of a modal being open - and since Master Vault
     * meters hard enough that 250 decks takes minutes, closing the modal or
     * following a link part-way through was the ordinary outcome rather than
     * the exceptional one. The import died wherever it had got to, with nothing
     * recording which decks had landed, so the retry started from the top.
     *
     * Moving it here also paces Master Vault far better than the client could,
     * however politely each client behaved. Ten browsers each spacing their own
     * requests still arrive at one origin as ten times one browser's traffic,
     * and no browser can see the other nine; one worker with one queue is the
     * only place that rate is a number anyone can hold.
     *
     * The lobby contributes the clock and the batch. Everything that has to
     * survive a restart - the remaining uuids, the cursor, the counts, the
     * circuit breaker - is a row, so a deploy mid-import costs at most the
     * decks in flight.
     *
     * Silence is deliberate: a sweep that imported 5 decks of 250 says nothing.
     * Only finishing a job or parking one is worth a line, because a log that
     * narrates every batch of a long import is a log nobody reads.
     */
    async runDeckImportSweep() {
        if (!this.deckImportService) {
            return;
        }

        // ARCHON: one sweep body at a time in this process.
        //
        // The cadence gate stamps lastDeckImportSweepMs before awaiting Master
        // Vault, so it spaces sweep STARTS only - a batch slower than the
        // cadence had the next tick begin on top of it. Both runs then claimed
        // the same job, requested every deck twice, and the later run's
        // absolute counters overwrote the earlier one's, so five imported decks
        // could be recorded as "0 imported, 5 already owned". Not exotic
        // either: a tick is decksPerTick decks plus their spacing, so any
        // per-deck cost over about 1.7s overruns the default 10s cadence -
        // which is exactly when Master Vault is slow, and doubling our request
        // rate is the worst available response to that. The claim lease is the
        // cross-process half of this; the flag is the cheap in-process half.
        if (this.deckImportSweepRunning) {
            return;
        }

        this.deckImportSweepRunning = true;

        try {
            if (!this.deckImportService.isEnabled()) {
                return;
            }

            const config = this.deckImportService.getConfig();
            // An unset or zero cadence means "every tick", not "never": the
            // switch for stopping this work is `enabled`, and a worker silently
            // parked by a stray 0 looks to the player like an import that hung.
            const seconds = Math.max(0, Number(config.sweepIntervalSeconds) || 0);
            const now = Date.now();

            if (now - this.lastDeckImportSweepMs < seconds * 1000) {
                return;
            }

            this.lastDeckImportSweepMs = now;

            const job = await this.deckImportService.claimNextJob();

            if (!job) {
                return;
            }

            const uuids = this.deckImportService.parseUuids(job);
            const reasons = this.deckImportService.parseReasons(job);
            const spacingMs = Number(config.requestSpacingMs) || 0;
            const cursor = Math.max(0, job.Cursor || 0);
            const batch = uuids.slice(cursor, cursor + this.deckImportService.getDecksPerTick());

            let imported = job.Imported || 0;
            let alreadyOwned = job.AlreadyOwned || 0;
            let failed = job.Failed || 0;
            // Decks this batch actually dealt with, which is what the cursor
            // advances by. A rate limit leaves the deck it interrupted unread,
            // so it is deliberately not counted.
            let consumed = 0;
            let throttled = null;

            // Failure reasons are aggregated per job: the player reads them once
            // as a summary ("12 decks are from an unsupported expansion"), and
            // the same refusal repeated 200 times is one line, not 200.
            const countReason = (reason) => {
                reasons[reason] = (reasons[reason] || 0) + 1;
            };

            for (const uuid of batch) {
                // Between decks, never before the first: the spacing exists to
                // stagger requests, and the first one of a batch has nothing to
                // be staggered from.
                if (consumed > 0 && spacingMs > 0) {
                    await this.sleep(spacingMs);
                }

                let result = null;
                let error = null;

                try {
                    result = await this.deckService.create(
                        { id: job.UserId, username: job.Username },
                        { uuid, username: job.Username }
                    );
                } catch (err) {
                    // ARCHON: a 429 is not this deck's fault, it is the origin
                    // telling us to stop, so the batch ends here and the cursor
                    // stays on the deck we never read. Skipping past it would
                    // silently lose a deck the player owns to a failure that had
                    // nothing to do with it, and carrying on through the rest of
                    // the batch would spend more requests from an address Master
                    // Vault has just asked to be quiet.
                    if (err && err.code === 'upstream_rate_limited') {
                        throttled = err.message || 'Master Vault is rate limiting deck imports';

                        break;
                    }

                    error = err;
                }

                if (error) {
                    failed++;
                    countReason(error.message || 'Import failed');
                } else if (result && result.success) {
                    imported++;
                } else {
                    // A resolved refusal is business, not breakage: this player
                    // already owns the deck, or it is from an expansion the
                    // engine does not implement. Already-owned is counted apart
                    // from failures because re-running an import over a
                    // collection that is mostly already here is the normal case,
                    // and calling that 200 failures reads as a broken feature.
                    const message = (result && result.message) || 'Import failed';

                    if (/already exists/i.test(message)) {
                        alreadyOwned++;
                    } else {
                        failed++;
                        countReason(message);
                    }
                }

                consumed++;
            }

            const progress = {
                cursor: cursor + consumed,
                imported,
                alreadyOwned,
                failed,
                reasons
            };

            if (throttled) {
                const failures = (job.ConsecutiveFailures || 0) + 1;
                const backoff = this.deckImportService.backoffMs(failures);

                await this.deckImportService.pauseJob(job.Id, {
                    ...progress,
                    // Measured from the refusal rather than from the top of the
                    // sweep: the batch that got here spent real time being
                    // paced, and that time is not part of the backoff.
                    untilMs: Date.now() + backoff,
                    error: throttled,
                    consecutiveFailures: failures
                });

                logger.info(
                    `Deck import job ${job.Id} (${job.Username}) paused for ` +
                        `${Math.round(backoff / 1000)}s at deck ${progress.cursor} of ` +
                        `${uuids.length}: Master Vault is rate limiting`
                );

                return;
            }

            await this.deckImportService.recordProgress(job.Id, progress);

            // >= rather than ===: a job whose uuid list is empty, or whose
            // cursor is somehow past the end, must still retire. Waiting for an
            // exact landing would leave it claimable forever, and a job nobody
            // can finish is a job that blocks this player's next import.
            if (progress.cursor >= uuids.length) {
                await this.deckImportService.finishJob(job.Id, 'done');

                logger.info(
                    `Deck import job ${job.Id} (${job.Username}) finished: ${imported} imported, ` +
                        `${alreadyOwned} already owned, ${failed} failed`
                );
            }
        } catch (err) {
            logger.error('Deck import sweep failed', err);
        } finally {
            // finally, not the end of try: a sweep that threw must still
            // release the flag, or one bad tick stops every import on this
            // lobby until it restarts.
            this.deckImportSweepRunning = false;
        }
    }

    /**
     * ARCHON: refresh the collections of players who asked us to remember their
     * Decks of KeyForge key.
     *
     * This does the cheap half of an import - list the collection, subtract
     * what they already own, queue a job - and nothing else. The decks are
     * fetched by runDeckImportSweep, so however many collections are listed
     * here, Master Vault still sees one paced queue.
     *
     * Deliberately a handful of players per run, least recently synced first.
     * The work this creates is not the listing, it is the queue behind it, and
     * a sweep that enrolled fifty collections at once would just make every
     * player's import slower without anyone's finishing sooner.
     *
     * A key DoK has rejected takes itself out of the rotation inside syncDue,
     * so a dead credential costs one request once rather than one per cycle
     * forever.
     */
    async runDokAutoSync() {
        if (!this.dokLinkService || !this.dokService || !this.dokService.isImportEnabled()) {
            return;
        }

        if (this.dokAutoSyncRunning) {
            return;
        }

        try {
            const config = this.configService.getValue('dok') || {};

            if (config.autoSyncEnabled === false) {
                return;
            }

            const minutes = Math.max(1, Number(config.autoSyncSweepMinutes) || 15);
            const now = Date.now();

            if (now - this.lastDokAutoSyncMs < minutes * 60 * 1000) {
                return;
            }

            this.lastDokAutoSyncMs = now;
            this.dokAutoSyncRunning = true;

            const result = await this.dokLinkService.syncDue();

            if (result && result.queued > 0) {
                logger.info(
                    `DoK auto-sync queued ${result.queued} new deck(s) across ` +
                        `${result.synced} collection(s)`
                );
            }
        } catch (err) {
            logger.error('DoK auto-sync sweep failed', err);
        } finally {
            this.dokAutoSyncRunning = false;
        }
    }

    /**
     * ARCHON (N14): flag asynchronous tournament rounds whose deadline has
     * passed.
     *
     * The service does the deciding (and claims each event with a write, so
     * several lobby instances stay one voice); this only provides the tick and
     * keeps a failure from taking the interval down with it. Nothing is
     * forfeited here - a passed deadline is the organizer's cue, not a verdict.
     */
    async runRoundDeadlineSweep() {
        if (!this.tournamentService || this.roundDeadlineSweepRunning) {
            return;
        }

        try {
            this.roundDeadlineSweepRunning = true;

            const result = await this.tournamentService.sweepRoundDeadlines();

            if (result && result.notified > 0) {
                logger.info(`Flagged ${result.notified} tournament round deadline(s) as passed`);
            }

            // ARCHON: the same tick also fires the reminders that go out
            // BEFORE a deadline or an agreed match time - on the same
            // schedule, because they are the same kind of clock-watching and
            // a second timer would be a second thing to get wrong.
            const reminders = await this.tournamentService.sweepScheduleReminders();

            if (reminders && (reminders.warned > 0 || reminders.reminded > 0)) {
                logger.info(
                    `Tournament reminders: ${reminders.warned} round deadline(s) approaching, ` +
                        `${reminders.reminded} match(es) starting soon`
                );
            }
        } catch (err) {
            logger.error('Tournament round deadline sweep failed', err);
        } finally {
            this.roundDeadlineSweepRunning = false;
        }
    }

    async init() {
        // pre cache card list so the first user to the site doesn't have a slowdown
        await this.cardService.getAllCards();
        this.cardService.subscribeToUpdates(() => {
            logger.info('Card data updated by fetchdata, clearing cache');
            this.cardService.clearCache();
        });
    }

    // External methods
    getStatus() {
        return this.router.getNodeStatus();
    }

    disableNode(nodeName) {
        return this.router.disableNode(nodeName);
    }

    enableNode(nodeName) {
        return this.router.enableNode(nodeName);
    }

    debugDump() {
        let games = Object.values(this.games).map((game) => {
            let players = Object.values(game.players).map((player) => {
                return {
                    name: player.name,
                    left: player.left,
                    disconnected: player.disconnected,
                    id: player.id
                };
            });

            let spectators = Object.values(game.spectators).map((spectator) => {
                return {
                    name: spectator.name,
                    id: spectator.id
                };
            });

            return {
                name: game.name,
                players: players,
                spectators: spectators,
                id: game.id,
                started: game.started,
                node: game.node ? game.node.identity : 'None',
                startedAt: game.createdAt
            };
        });

        let nodes = this.router.getNodeStatus();

        return {
            games: games,
            nodes: nodes,
            socketCount: Object.values(this.sockets).length,
            userCount: Object.values(this.users).length
        };
    }

    // Helpers
    findGameForUser(user) {
        return Object.values(this.games).find((game) => {
            if (game.spectators[user]) {
                return true;
            }

            let player = game.players[user];

            if (!player || player.left) {
                return false;
            }

            return true;
        });
    }

    getUserList() {
        let userList = Object.values(this.users).map((user) => {
            return user.getShortSummary();
        });

        userList = sortBy(userList, (user) => {
            return user.name.toLowerCase();
        });

        return userList;
    }

    handshake(ioSocket, next) {
        const token = ioSocket.handshake.auth?.token || ioSocket.handshake.query?.token;
        if (token && token !== 'undefined') {
            jwt.verify(token, this.configService.getValue('secret'), (err, user) => {
                if (err) {
                    ioSocket.emit('authfailed');
                    return;
                }

                this.userService
                    .getUserById(user.id)
                    .then((dbUser) => {
                        let socket = this.sockets[ioSocket.id];
                        if (!socket) {
                            logger.error(
                                'Tried to authenticate socket for %s but could not find it',
                                dbUser?.username || user?.username || user?.id
                            );
                            return;
                        }

                        if (!dbUser) {
                            logger.error(
                                'Tried to authenticate socket for %s but user lookup returned no result',
                                user?.username || user?.id
                            );
                            ioSocket.emit('authfailed');
                            ioSocket.disconnect();
                            return;
                        }

                        if (dbUser.disabled) {
                            ioSocket.disconnect();
                            return;
                        }

                        ioSocket.request.user = dbUser.getWireSafeDetails();
                        socket.user = dbUser;
                        this.users[dbUser.username] = socket.user;
                        this.socketsByName[dbUser.username] = socket;

                        this.doPostAuth(socket);
                    })
                    .catch((err) => {
                        logger.error(err);
                    });
            });
        }

        const serverVersion = process.env.VERSION;
        const clientVersion = ioSocket.handshake.auth?.version || ioSocket.handshake.query?.version;
        if (serverVersion && clientVersion && serverVersion !== clientVersion) {
            ioSocket.emit(
                'banner',
                'Your client version is out of date, please refresh or clear your cache to get the latest version'
            );
        }

        next();
    }

    // Actions
    mapGamesToGameSummaries(games) {
        return _.chain(games)
            .map((game) => game.getSummary())
            .sortBy('createdAt')
            .sortBy('started')
            .reverse()
            .value();
    }

    broadcastGameMessage(message, games) {
        if (!Array.isArray(games)) {
            games = [games];
        }

        for (let socket of Object.values(this.sockets)) {
            if (!socket) {
                continue;
            }

            let filteredGames = Object.values(games).filter((game) =>
                game.isVisibleFor(socket.user)
            );
            let gameSummaries = filteredGames.map((game) => game.getSummary());

            socket.send(message, gameSummaries);
        }
    }

    broadcastGameList(socket) {
        let sockets = {};

        if (socket) {
            sockets[socket.id] = socket;
        } else {
            sockets = this.sockets;
        }

        for (let socket of Object.values(sockets)) {
            if (!socket) {
                continue;
            }

            let filteredGames = Object.values(this.games).filter((game) =>
                game.isVisibleFor(socket.user)
            );
            let gameSummaries = this.mapGamesToGameSummaries(filteredGames);

            socket.send('games', gameSummaries);
        }
    }

    sendUserListFilteredWithBlockList(socket, userList) {
        let filteredUsers = userList;

        if (socket.user) {
            filteredUsers = userList.filter((user) => {
                return !socket.user.hasUserBlocked(user);
            });
        }

        socket.send('users', filteredUsers);
    }

    broadcastUserMessage(user, message) {
        // The same summary for every recipient - only the block check varies.
        // Built once because `role` now resolves entitlements to decide the
        // supporter badge, and rebuilding it per socket made one player joining
        // cost one resolution per connection.
        const summary = user.getShortSummary();

        for (let socket of Object.values(this.sockets)) {
            if (socket.user === user || (socket.user && socket.user.hasUserBlocked(user))) {
                continue;
            }

            socket.send(message, summary);
        }
    }

    sendGameState(game) {
        if (game.started) {
            return;
        }

        for (let player of Object.values(game.getPlayersAndSpectators())) {
            if (!this.sockets[player.id]) {
                logger.info(`Wanted to send to ${player.id} but have no socket`);
                continue;
            }

            this.sockets[player.id].send('gamestate', game.getSummary(player.name));
        }
    }

    clearGamesForNode(nodeName) {
        for (let game of Object.values(this.games)) {
            if (game.node && game.node.identity === nodeName) {
                delete this.games[game.id];
            }
        }

        this.broadcastGameList();
    }

    async clearStalePendingGames() {
        const timeout = 15 * 60 * 1000;
        let staleGames = Object.values(this.games).filter(
            (game) => !game.started && !game.tournament && Date.now() - game.createdAt > timeout
        );

        for (let game of staleGames) {
            logger.info(`closed pending game ${game.id} due to inactivity`);
            delete this.games[game.id];
        }

        // ARCHON: tournament tables wait much longer for their players,
        // but disappear once their match is decided (TO award, forfeit)
        // or the round has moved on.
        const tournamentGames = Object.values(this.games).filter(
            (game) => !game.started && game.tournament
        );

        for (let game of tournamentGames) {
            const age = Date.now() - game.createdAt;
            let stale = age > 6 * 60 * 60 * 1000;

            if (!stale && age > 60 * 1000) {
                try {
                    stale = !(await this.tournamentService.isMatchOpen(
                        game.tournament.tournamentId,
                        game.tournament.matchId
                    ));
                } catch (err) {
                    logger.error('Failed to check tournament match state', err);
                }
            }

            if (stale) {
                logger.info(`closed tournament pending game ${game.id} (match resolved or stale)`);
                delete this.games[game.id];
                staleGames.push(game);
            }
        }

        if (staleGames.length > 0) {
            this.broadcastGameMessage('removegame', staleGames);
        }
    }

    clearOldRefreshTokens() {
        logger.info('Starting refresh token cleanup...');

        this.userService.cleanupRefreshTokens().then(() => {
            logger.info('Refresh token cleanup completed.');
        });
    }

    sendFilteredMessages(socket) {
        this.messageService
            .getLastMessagesForUser(socket.user)
            .then((messages) => {
                let messagesToSend = this.filterMessages(messages, socket);
                socket.send('lobbymessages', messagesToSend.reverse());
            })
            .catch((err) => {
                logger.error('Unable to send lobby messages', err);
                socket.send('lobbymessages', []);
            });
    }

    filterMessages(messages, socket) {
        if (!socket.user) {
            return messages;
        }

        return messages.filter((message) => {
            return !socket.user.hasUserBlocked(message.user);
        });
    }

    // Events
    onConnection(ioSocket) {
        let socket = new Socket(ioSocket, { configService: this.configService });

        socket.registerEvent('chat', this.onPendingGameChat.bind(this));
        socket.registerEvent('clearsessions', this.onClearSessions.bind(this));
        socket.registerEvent('connectfailed', this.onConnectFailed.bind(this));
        socket.registerEvent('getnodestatus', this.onGetNodeStatus.bind(this));
        socket.registerEvent('getsealeddeck', this.onGetSealedDeck.bind(this));
        socket.registerEvent('joingame', this.onJoinGame.bind(this));
        socket.registerEvent('joinqueue', this.onJoinQueue.bind(this));
        socket.registerEvent('leavegame', this.onLeaveGame.bind(this));
        socket.registerEvent('leavequeue', this.onLeaveQueue.bind(this));
        socket.registerEvent('lobbychat', this.onLobbyChat.bind(this));
        socket.registerEvent('motd', this.onMotdChange.bind(this));
        socket.registerEvent('newgame', this.onNewGame.bind(this));
        socket.registerEvent('removegame', this.onRemoveGame.bind(this));
        socket.registerEvent('restartnode', this.onRestartNode.bind(this));
        socket.registerEvent('selectdeck', this.onSelectDeck.bind(this));
        socket.registerEvent('selectrandomdeck', this.onSelectRandomDeck.bind(this));
        socket.registerEvent('startgame', this.onStartGame.bind(this));
        socket.registerEvent('togglenode', this.onToggleNode.bind(this));
        socket.registerEvent('watchgame', this.onWatchGame.bind(this));

        socket.on('authenticate', this.onAuthenticated.bind(this));
        socket.on('disconnect', this.onSocketDisconnected.bind(this));

        this.sockets[ioSocket.id] = socket;

        if (socket.user) {
            this.users[socket.user.username] = socket.user;
            this.socketsByName[socket.user.username] = socket;

            this.broadcastUserMessage(socket.user, 'newuser');
        }

        this.sendUserListFilteredWithBlockList(socket, this.getUserList());
        this.sendFilteredMessages(socket);
        this.broadcastGameList(socket);

        this.messageService
            .getMotdMessage()
            .then((message) => {
                if (message) {
                    socket.send('motd', message);
                }
            })
            .catch((err) => {
                logger.error(err);
            });

        if (!socket.user) {
            return;
        }

        let game = this.findGameForUser(socket.user.username);
        if (game && game.started) {
            this.sendHandoff(socket, game.node, game.id);
        }
    }

    doPostAuth(socket) {
        let user = socket.user;

        if (!user) {
            return;
        }

        this.broadcastUserMessage(user, 'newuser');
        this.sendFilteredMessages(socket);
        this.sendUserListFilteredWithBlockList(socket, this.getUserList());

        this.broadcastGameList(socket);

        let game = this.findGameForUser(user.username);
        if (game && game.started) {
            this.sendHandoff(socket, game.node, game.id);
        }
    }

    onAuthenticated(socket, user) {
        if (socket.user) {
            return;
        }

        this.userService
            .getUserById(user.id)
            .then((dbUser) => {
                if (!dbUser) {
                    logger.error(
                        'Tried to authenticate socket for %s but user lookup returned no result',
                        user?.username || user?.id
                    );
                    socket.send('authfailed');
                    socket.disconnect();
                    return;
                }

                this.users[dbUser.username] = dbUser;
                this.socketsByName[dbUser.username] = socket;

                socket.user = dbUser;

                this.doPostAuth(socket);
            })
            .catch((err) => {
                logger.error(err);
            });
    }

    onSocketDisconnected(socket, reason) {
        if (!socket) {
            return;
        }

        delete this.sockets[socket.id];

        if (!socket.user) {
            return;
        }

        this.matchmaking?.dequeue(socket.user.username);

        this.broadcastUserMessage(socket.user, 'userleft');

        delete this.users[socket.user.username];
        delete this.socketsByName[socket.user.username];

        logger.info(`user '${socket.user.username}' disconnected from the lobby: ${reason}`);

        let game = this.findGameForUser(socket.user.username);
        if (!game) {
            return;
        }

        game.disconnect(socket.user.username);

        if (game.isEmpty() && !game.tournament) {
            this.broadcastGameMessage('removegame', game);
            delete this.games[game.id];
        } else {
            this.broadcastGameMessage('updategame', game);
            this.sendGameState(game);
        }
    }

    // ARCHON: Quick Match - enter the matchmaking queue for a format. We look
    // up the player's Amber for that format's pool so pairing favours opponents
    // of a similar rating, then try to pair immediately.
    async onJoinQueue(socket, details) {
        if (!socket.user) {
            return;
        }

        const username = socket.user.username;

        if (this.findGameForUser(username)) {
            socket.send('matchmaking', {
                status: 'error',
                message: 'Leave your current game before finding a match'
            });

            return;
        }

        const format =
            details && MATCHMAKING_FORMATS.includes(details.gameFormat)
                ? details.gameFormat
                : 'normal';
        const amber = await this.getMatchmakingAmber(username, format);

        this.matchmaking.enqueue({ username, format, amber, joinedAt: Date.now() });
        socket.send('matchmaking', {
            status: 'searching',
            format,
            queued: this.matchmaking.size(format)
        });

        this.runMatchmaking();
    }

    // Tell everyone still waiting how many players are in their format's queue,
    // so the "searching…" UI can show a live count. Runs after each sweep.
    broadcastQueueSizes() {
        if (!this.matchmaking) {
            return;
        }

        for (const entry of this.matchmaking.list()) {
            const socket = this.socketsByName[entry.username];
            if (socket) {
                socket.send('matchmaking', {
                    status: 'searching',
                    format: entry.format,
                    queued: this.matchmaking.size(entry.format)
                });
            }
        }
    }

    onLeaveQueue(socket) {
        if (!socket.user) {
            return;
        }

        this.matchmaking.dequeue(socket.user.username);
        socket.send('matchmaking', { status: 'idle' });
    }

    async getMatchmakingAmber(username, format) {
        try {
            const pool = this.ratingService.normalizePool(format);
            const ratings = await this.ratingService.getRatingsForUsername(username);
            const entry = (ratings || []).find((rating) => rating.pool === pool);

            return entry ? entry.rating : MatchmakingService.DEFAULT_AMBER;
        } catch (err) {
            logger.error('Failed to look up matchmaking Amber', err);

            return MatchmakingService.DEFAULT_AMBER;
        }
    }

    runMatchmaking() {
        if (!this.matchmaking) {
            return;
        }

        const canPair = (a, b) => {
            const socketA = this.socketsByName[a.username];
            const socketB = this.socketsByName[b.username];

            if (!socketA || !socketB) {
                return false;
            }

            if (this.findGameForUser(a.username) || this.findGameForUser(b.username)) {
                return false;
            }

            // Respect block-lists in both directions.
            return (
                !socketA.user.hasUserBlocked(socketB.user) &&
                !socketB.user.hasUserBlocked(socketA.user)
            );
        };

        const now = Date.now();
        // Depth BEFORE pairing: after the sweep the matched players are gone,
        // so sampling afterwards would report a queue that always looks empty.
        const depthBefore = this.matchmaking.list().length;

        for (const [a, b] of this.matchmaking.collectMatches(now, canPair)) {
            // ARCHON (N8): the queue is in-memory and leaves no trace, so how
            // long anyone waited is unanswerable an hour later unless it is
            // written down as it happens. Fire-and-forget - a metrics write
            // must never delay or fail a player getting a game.
            if (this.analyticsService) {
                for (const entry of [a, b]) {
                    this.analyticsService.record({
                        format: entry.format,
                        queueDepth: depthBefore,
                        waitSeconds: Math.max(0, Math.round((now - entry.joinedAt) / 1000))
                    });
                }
            }

            this.createMatchedGame(a, b);
        }

        this.broadcastQueueSizes();
    }

    createMatchedGame(a, b) {
        const socketA = this.socketsByName[a.username];
        const socketB = this.socketsByName[b.username];

        const requeue = (entry, socket) => {
            if (socket) {
                this.matchmaking.enqueue({
                    username: entry.username,
                    format: entry.format,
                    amber: entry.amber,
                    joinedAt: Date.now()
                });
            }
        };

        // A player may have disconnected or entered another game between
        // pairing and creation; requeue whoever is still available.
        if (!socketA || !socketB) {
            requeue(a, socketA);
            requeue(b, socketB);

            return;
        }

        const game = new PendingGame(socketA.user, {
            allowSpectators: true,
            gameFormat: a.format,
            name: `Quick Match: ${a.username} vs ${b.username}`,
            quickMatch: true
        });

        game.newGame(socketA.id, socketA.user, null, true);
        const joinError = game.join(socketB.id, socketB.user);

        if (joinError) {
            logger.info(`Quick Match join failed (${a.username} vs ${b.username}): ${joinError}`);
            requeue(a, socketA);
            requeue(b, socketB);

            return;
        }

        socketA.joinChannel(game.id);
        socketB.joinChannel(game.id);
        this.games[game.id] = game;

        this.sendGameState(game);
        this.broadcastGameMessage('newgame', game);

        socketA.send('matchmaking', { status: 'matched', gameId: game.id });
        socketB.send('matchmaking', { status: 'matched', gameId: game.id });

        logger.info(
            `Quick Match created ${game.id}: ${a.username} (${a.amber}) vs ${b.username} (${b.amber})`
        );
    }

    onNewGame(socket, gameDetails) {
        // Creating a game means leaving any matchmaking queue.
        this.matchmaking?.dequeue(socket.user.username);

        if (!socket.user.permissions.canManageTournaments || !gameDetails.tournament) {
            let existingGame = this.findGameForUser(socket.user.username);
            if (existingGame) {
                return;
            }
        }

        if (gameDetails.quickJoin) {
            let sortedGames = sortBy(Object.values(this.games), (game) => game.createdAt);
            let gameToJoin = sortedGames.find(
                (game) =>
                    !game.started &&
                    !game.tournament &&
                    game.gameFormat === gameDetails.gameFormat &&
                    Object.values(game.players).length < 2 &&
                    !game.password &&
                    !game.gamePrivate &&
                    // Quick join promises a plain game of the chosen format.
                    // Deck-rule games (a SAS bound the joiner's collection may
                    // not satisfy, a Lucky Dice roll they did not ask for) are
                    // opted into from the game list, never matched into.
                    !game.sasBound &&
                    !game.luckyDice &&
                    game.isVisibleFor(socket.user)
            );

            if (gameToJoin) {
                let message = gameToJoin.join(socket.id, socket.user);
                if (message) {
                    socket.send('passworderror', message);

                    return;
                }

                socket.joinChannel(gameToJoin.id);

                this.sendGameState(gameToJoin);
                this.broadcastGameMessage('updategame', gameToJoin);

                return;
            }
        }

        let game = new PendingGame(socket.user, gameDetails);
        game.newGame(socket.id, socket.user, gameDetails.password, true);
        socket.joinChannel(game.id);

        this.sendGameState(game);

        this.games[game.id] = game;
        this.broadcastGameMessage('newgame', game);
    }

    onJoinGame(socket, gameId, password) {
        // Joining a game means leaving any matchmaking queue.
        this.matchmaking?.dequeue(socket.user.username);

        let existingGame = this.findGameForUser(socket.user.username);
        if (existingGame) {
            return;
        }

        let game = this.games[gameId];
        if (!game) {
            return;
        }

        let message = game.join(socket.id, socket.user, password);
        if (message) {
            socket.send('passworderror', message);

            return;
        }

        socket.joinChannel(game.id);

        this.sendGameState(game);
        this.broadcastGameMessage('updategame', game);

        // ARCHON: joining your tournament table auto-selects your
        // registered deck and starts the game once both players are in.
        if (game.tournament) {
            const deckId = game.tournament.decks?.[socket.user.username];
            const selection = deckId
                ? this.applyDeckSelection(game, socket.user.username, deckId, false)
                : Promise.resolve();

            selection
                .catch((err) => logger.error('Failed to auto-select tournament deck', err))
                .then(() => this.startTournamentGameIfReady(game));
        }
    }

    onStartGame(socket, gameId) {
        let game = this.games[gameId];

        if (!game || game.started) {
            return;
        }

        // ARCHON: KeyForge is a two-player game - starting solo used to be
        // allowed and stranded the owner in a board with no opponent.
        if (Object.values(game.getPlayers()).length < 2) {
            socket.send('gameerror', 'You need an opponent before the game can start');
            return;
        }

        if (!game.isOwner(socket.user.username)) {
            return;
        }

        // ARCHON: Lucky Dice games roll their decks HERE, not when players
        // join - a roll at join could be rerolled forever by leaving and
        // rejoining until a favourite came up. At start there is exactly one
        // roll and it is final.
        if (game.luckyDice) {
            if (game.luckyDiceRolling) {
                return;
            }

            game.luckyDiceRolling = true;

            return this.rollLuckyDiceDecks(game, socket)
                .then((rolled) => {
                    if (rolled) {
                        this.launchGame(socket, gameId);
                    }
                })
                .catch((err) => {
                    logger.error('Failed to roll Lucky Dice decks', err);
                })
                .finally(() => {
                    game.luckyDiceRolling = false;
                });
        }

        this.launchGame(socket, gameId);
    }

    /**
     * ARCHON: one random eligible deck for every player who has not selected
     * one. Players who already hold a deck keep it - that is what lets a
     * "Rematch: Same Decks" of a Lucky Dice game actually keep the decks.
     *
     * Returns false (with the owner told why) as soon as any player has
     * nothing the dice could land on; the game stays pending and un-rolled.
     */
    async rollLuckyDiceDecks(game, socket) {
        for (const player of Object.values(game.getPlayers())) {
            if (player.deck) {
                continue;
            }

            const deckId = await this.deckService.getRandomDeckIdForUser(
                player.user.id,
                this.deckConstraintsFor(game)
            );

            if (!deckId) {
                socket.send(
                    'gameerror',
                    game.sasBound
                        ? `${player.name} has no decks with a SAS rating between ${game.sasBound.min} and ${game.sasBound.max}`
                        : `${player.name} has no decks the Lucky Dice could land on`
                );
                game.addMessage(
                    '{0} has no eligible decks for the Lucky Dice roll, so the game cannot start',
                    player.name
                );
                this.sendGameState(game);

                return false;
            }

            await this.applyDeckSelection(game, player.name, deckId, false);
            game.addMessage('The Lucky Dice rolled a deck for {0}', player.name);
        }

        this.sendGameState(game);

        return true;
    }

    /**
     * The node handoff, split from onStartGame so the Lucky Dice roll can sit
     * in between. Everything is re-checked from the live game rather than
     * trusted from before the roll: players can leave, admins can remove the
     * game, and a second start click can land while the dice were rolling.
     */
    launchGame(socket, gameId) {
        const game = this.games[gameId];

        if (!game || game.started) {
            return;
        }

        if (Object.values(game.getPlayers()).length < 2) {
            return;
        }

        if (
            Object.values(game.getPlayers()).some((player) => {
                return !player.deck;
            })
        ) {
            return;
        }

        // ARCHON: the deck lock. A tournament table's owner is player one of
        // the pairing, so this owner-driven path can start an event game too -
        // it is not only startTournamentGameIfReady.
        if (this.refuseUnpinnedStart(game)) {
            return;
        }

        let gameNode = this.router.startGame(game);
        if (!gameNode) {
            socket.send('gameerror', 'No game nodes available. Try again later.');
            return;
        }

        game.node = gameNode;
        game.started = true;

        this.broadcastGameMessage('updategame', game);

        for (let player of Object.values(game.getPlayersAndSpectators())) {
            let socket = this.sockets[player.id];

            if (!socket || !socket.user) {
                logger.error(`Wanted to handoff to ${player.name}, but couldn't find a socket`);
                continue;
            }

            this.sendHandoff(socket, gameNode, game.id);
        }
    }

    sendHandoff(socket, gameNode, gameId) {
        let user = socket.user.getWireSafeDetails();
        let authToken = jwt.sign(user, this.configService.getValue('secret'), { expiresIn: '5m' });

        const handoffData = {
            authToken: authToken,
            gameId: gameId,
            name: gameNode.identity,
            port: gameNode.port,
            protocol: gameNode.protocol,
            user: user
        };

        if (gameNode.address) {
            handoffData.address = gameNode.address;
        }

        socket.send('handoff', handoffData);
    }

    onWatchGame(socket, gameId, password) {
        let existingGame = this.findGameForUser(socket.user.username);
        if (existingGame) {
            return;
        }

        let game = this.games[gameId];
        if (!game) {
            return;
        }

        let message = game.watch(socket.id, socket.user, password);
        if (message) {
            socket.send('passworderror', message);

            return;
        }

        socket.joinChannel(game.id);

        if (game.started) {
            this.router.addSpectator(game, socket.user.getDetails());
            this.sendHandoff(socket, game.node, game.id);
        } else {
            this.sendGameState(game);
        }
    }

    onLeaveGame(socket) {
        let game = this.findGameForUser(socket.user.username);
        if (!game) {
            return;
        }

        game.leave(socket.user.username);
        socket.send('cleargamestate');
        socket.leaveChannel(game.id);

        // ARCHON: leaving a *started* game over the lobby socket is the fallback
        // escape hatch when a player's game-node socket is dead (they were
        // stranded at a rendered-but-unresponsive board). The node still
        // believes the player is present, so once every player has left from the
        // lobby's authoritative view, force the node to tear the game down —
        // otherwise the finished game lingers as a ghost in the lobby list until
        // the node's stale-game sweep, or forever if the dead socket never
        // times out. When the opponent is still playing we only broadcast the
        // update and let the node keep running the live game.
        if (game.started && !game.tournament) {
            if (game.isEmpty()) {
                if (game.node && game.node.identity) {
                    this.router.closeGame(game);
                }
                delete this.games[game.id];
                this.broadcastGameMessage('removegame', game);
            } else {
                this.broadcastGameMessage('updategame', game);
            }
            return;
        }

        if (game.isEmpty() && !game.tournament) {
            delete this.games[game.id];
            this.broadcastGameMessage('removegame', game);
        } else {
            this.sendGameState(game);
            this.broadcastGameMessage('updategame', game);
        }
    }

    async onPendingGameChat(socket, message) {
        let game = this.findGameForUser(socket.user.username);
        if (!game) {
            return;
        }

        // ARCHON (N5): the same mute applies at the table. Muting someone in
        // the lobby while leaving them free to talk in a game they are
        // sitting in would not be the sanction the moderator chose.
        if (this.moderationService) {
            const check = await this.moderationService.checkRestriction(socket.user.id, 'chat');

            if (!check.allowed) {
                socket.send('nochat', {
                    message: check.message,
                    reason: check.reason,
                    expiresAt: check.expiresAt
                });

                return;
            }
        }

        game.chat(socket.user.username, message);
        this.sendGameState(game);
    }

    async onLobbyChat(socket, message) {
        if (
            Date.now() - socket.user.registered <
            this.configService.getValue('minLobbyChatTime') * 1000
        ) {
            socket.send('nochat');
            return;
        }

        // ARCHON (N5): a mute has to actually stop the message, and the
        // player has to be told why and until when - a message that silently
        // vanishes is indistinguishable from the site being broken, and the
        // player just says it again.
        if (this.moderationService) {
            const check = await this.moderationService.checkRestriction(socket.user.id, 'chat');

            if (!check.allowed) {
                socket.send('nochat', {
                    message: check.message,
                    reason: check.reason,
                    expiresAt: check.expiresAt
                });

                return;
            }
        }

        let chatMessage = {
            message: message.substring(0, Math.min(512, message.length)),
            time: new Date()
        };
        let newMessage = await this.messageService.addMessage(chatMessage, socket.user);
        newMessage.user = socket.user.getShortSummary();

        for (let s of Object.values(this.sockets)) {
            if (s.user && s.user.hasUserBlocked(socket.user)) {
                continue;
            }

            s.send('lobbychat', newMessage);
        }
    }

    onGetSealedDeck(socket, gameId) {
        let game = this.games[gameId];
        if (!game) {
            return;
        }

        Promise.all([
            this.cardService.getAllCards(),
            this.deckService.getSealedDeck(game.expansions)
        ])
            .then((results) => {
                let [cards, deck] = results;

                for (let card of deck.cards) {
                    card.card = cards[card.id];
                }

                deck.status = {
                    basicRules: true,
                    extendedStatus: [],
                    flagged: false,
                    noUnreleasedCards: true,
                    officialRole: true,
                    usageLevel: 0,
                    verified: true
                };

                game.selectDeck(socket.user.username, deck);

                this.sendGameState(game);
            })
            .catch((err) => {
                logger.info(err);

                return;
            });
    }

    /**
     * ARCHON: the deck a player is pinned to at a tournament table, or null
     * when the event pins nothing (deck registration is optional, and sealed
     * events build their decks at the table).
     *
     * An event either locks a player to one deck for the whole run or lets
     * them bring a different one between rounds. Either way the deck that
     * reaches the table is the one the event recorded for this pairing - and
     * the pre-game deck picker is sitting right there, so if it is not
     * refused here the policy is decoration.
     */
    tournamentDeckFor(game, username) {
        const pinned = game && game.tournament && game.tournament.decks;

        return (pinned && pinned[username]) || null;
    }

    /**
     * Why the table is refusing this deck. The two policies need different
     * instructions: under 'locked' there is nothing the player can do, under
     * 'between-rounds' there is, and it is on the event page.
     */
    pinnedDeckMessage(game) {
        return game.tournament?.deckSwapPolicy === 'between-rounds'
            ? 'This event runs on the deck you registered for this round. Change it on the event page before your match starts.'
            : 'This event locks you to the deck you registered. Ask the organizer if you need to change it.';
    }

    /**
     * ARCHON: the deck lock, second gate.
     *
     * onSelectDeck refuses a deck the event did not pin, but a deck can reach
     * a player by other routes, so the check is repeated where a game actually
     * starts. There are TWO such places, not one: tournament tables normally
     * launch themselves through startTournamentGameIfReady, but player one of
     * a pairing is also the table's owner (ensureTournamentGame builds the
     * PendingGame from users[0]), so the ordinary owner-driven Start button
     * reaches launchGame as well. Both call this.
     *
     * Returns true when the start was refused.
     */
    refuseUnpinnedStart(game) {
        if (!game || !game.tournament) {
            return false;
        }

        const wrongSeat = Object.values(game.getPlayers()).find((player) => {
            const pinned = this.tournamentDeckFor(game, player.name);

            return pinned && player.deck && Number(player.deck.id) !== Number(pinned);
        });

        if (!wrongSeat) {
            return false;
        }

        // Never a silent hang: the players are sitting there waiting for a
        // table that has decided not to start.
        logger.error(
            `Tournament game ${game.id} not started: ${wrongSeat.name} is holding deck ${
                wrongSeat.deck.id
            }, not the registered ${this.tournamentDeckFor(game, wrongSeat.name)}`
        );

        for (const player of Object.values(game.getPlayers())) {
            this.sockets[player.id]?.send('gameerror', this.pinnedDeckMessage(game));
        }

        return true;
    }

    onSelectDeck(socket, gameId, deckId, isStandalone) {
        let game = this.games[gameId];
        if (!game) {
            return;
        }

        // ARCHON: the deck lock. A tournament seat plays the event's deck.
        const pinnedDeckId = this.tournamentDeckFor(game, socket.user.username);

        if (pinnedDeckId && (isStandalone || Number(deckId) !== Number(pinnedDeckId))) {
            socket.send('gameerror', this.pinnedDeckMessage(game));

            // Put the pinned deck back on screen, so the refusal leaves the
            // player looking at what they are actually playing rather than at
            // a picker that appears to have half-worked.
            this.sendGameState(game);

            return;
        }

        return this.applyDeckSelection(game, socket.user.username, deckId, isStandalone)
            .then(() => {
                // ARCHON: tournament tables launch as soon as both
                // players are seated with decks.
                if (game.tournament) {
                    this.startTournamentGameIfReady(game);
                }
            })
            .catch((err) => {
                // A rejection with a playerMessage is the game refusing the
                // deck (SAS bound), not a fault - tell the player why instead
                // of leaving the click silently dead.
                if (err && err.playerMessage) {
                    socket.send('gameerror', err.playerMessage);

                    return;
                }

                logger.info(err);

                return;
            });
    }

    /**
     * ARCHON: Lucky Dice - select a random deck from everything the player
     * owns that this game would accept. The pick happens server side so it
     * really is drawn from the whole collection (the client only ever holds a
     * page of it) and so a SAS bound is applied by the same rules that will
     * validate the selection.
     */
    onSelectRandomDeck(socket, gameId) {
        let game = this.games[gameId];

        if (!game || game.started || game.gameFormat === 'sealed' || game.tournament) {
            return;
        }

        if (!game.getPlayerByName(socket.user.username)) {
            return;
        }

        return this.deckService
            .getRandomDeckIdForUser(socket.user.id, this.deckConstraintsFor(game))
            .then((deckId) => {
                if (!deckId) {
                    socket.send(
                        'gameerror',
                        game.sasBound
                            ? `You have no decks with a SAS rating between ${game.sasBound.min} and ${game.sasBound.max}`
                            : 'You have no decks the dice could land on for this game'
                    );

                    return;
                }

                return this.onSelectDeck(socket, gameId, deckId, false);
            })
            .catch((err) => {
                logger.error('Failed to select a random deck', err);
            });
    }

    /**
     * What the game allows a player's deck to be, in the terms
     * DeckService.getRandomDeckIdForUser understands. Mirrors the filter the
     * deck-select modal applies for the same game, so the dice and the list
     * agree about what is playable.
     */
    deckConstraintsFor(game) {
        const constraints = { unchainedOnly: game.gameFormat === 'unchained' };

        if (game.gameFormat !== 'alliance') {
            constraints.isAlliance = false;
        }

        if (game.sasBound) {
            constraints.sasMin = game.sasBound.min;
            constraints.sasMax = game.sasBound.max;
        }

        return constraints;
    }

    /**
     * ARCHON: deck loading/status logic shared by manual selection and
     * tournament auto-selection (which has a username but no socket).
     *
     * In a SAS-bound game the deck must prove its rating before it is
     * accepted: rejections throw with a playerMessage so the selecting
     * socket can be told why, and nothing about the game changes.
     */
    async applyDeckSelection(game, username, deckId, isStandalone) {
        const [cards, deck] = await Promise.all([
            this.cardService.getAllCards(),
            isStandalone
                ? this.deckService.getStandaloneDeckById(deckId)
                : this.deckService.getById(deckId)
        ]);

        if (game.sasBound) {
            await this.checkSasBound(game, deck, isStandalone);
        }

        for (let card of deck.cards) {
            let house = card.house;

            card.card = cards[card.id];
            if (house) {
                card.house = house;
            }
        }

        let deckUsageLevel = 0;
        if (
            deck.usageCount > this.configService.getValueForSection('lobby', 'lowerDeckThreshold')
        ) {
            deckUsageLevel = 1;
        }

        if (
            deck.usageCount > this.configService.getValueForSection('lobby', 'middleDeckThreshold')
        ) {
            deckUsageLevel = 2;
        }

        if (
            deck.usageCount > this.configService.getValueForSection('lobby', 'upperDeckThreshold')
        ) {
            deckUsageLevel = 3;
        }

        let hasEnhancementsSet = true;
        if (deck.cards.some((c) => c.enhancements && c.enhancements[0] === '')) {
            hasEnhancementsSet = false;
        }

        if (isStandalone) {
            deck.verified = true;
        }

        deck.status = {
            basicRules: hasEnhancementsSet,
            extendedStatus: [],
            noUnreleasedCards: true,
            officialRole: true,
            usageLevel: deckUsageLevel,
            verified: !!deck.verified,
            impossible: isStandalone && deck.id >= 5
        };

        deck.usageCount = 0;

        if (game.gameFormat === 'alliance') {
            deck.name = 'Alliance Deck';
        }

        game.selectDeck(username, deck);
        this.sendGameState(game);

        // ARCHON: attach SAS after the deck is already selected and the
        // state sent, so a slow or missing DeckSas row can never delay
        // someone picking their deck. When it resolves, the pre-game
        // screen simply updates. (A SAS-bound game has already attached and
        // checked it above - this re-attach is then a cheap cache read.)
        return this.dokService
            .attachStats([deck])
            .then(() => this.sendGameState(game))
            .catch(() => {});
    }

    /**
     * ARCHON: the SAS-bound gate. Throws (with a playerMessage) unless the
     * deck has a cached SAS rating inside the game's range.
     *
     * The attach is awaited here - the one selection path that is allowed to
     * wait on SAS, because the answer decides whether the selection happens at
     * all. It reads the local DeckSas cache; a deck DoK has not rated yet is
     * rejected rather than guessed at, and the attach itself queues the
     * background fetch that will fill the cache for a retry.
     *
     * Standalone decks have no Master Vault identity and so no SAS - in a
     * bounded game they are refused outright rather than treated as any
     * particular number.
     */
    async checkSasBound(game, deck, isStandalone) {
        const rejection = (message) => {
            const err = new Error(message);
            err.playerMessage = message;

            return err;
        };

        if (isStandalone) {
            throw rejection('Standalone decks have no SAS rating and cannot be used in this game');
        }

        if (!deck) {
            return;
        }

        await this.dokService.attachStats([deck]).catch(() => {});

        if (deck.sasRating == null) {
            throw rejection(
                'This deck has no SAS rating yet - it may still be syncing from Decks of KeyForge. Try again shortly or pick another deck.'
            );
        }

        if (deck.sasRating < game.sasBound.min || deck.sasRating > game.sasBound.max) {
            throw rejection(
                `${deck.name} is SAS ${deck.sasRating}, outside this game's SAS ${game.sasBound.min}-${game.sasBound.max} bound`
            );
        }
    }

    onConnectFailed(socket) {
        let game = this.findGameForUser(socket.user.username);
        if (!game) {
            return;
        }

        logger.info("user '%s' failed to handoff to game server", socket.user.username);
        this.router.notifyFailedConnect(game, socket.user.username);
    }

    onRemoveGame(socket, gameId) {
        if (!socket.user.permissions.canManageGames) {
            return;
        }

        let game = this.games[gameId];
        if (!game) {
            return;
        }

        logger.info(`${socket.user.username} closed game ${game.id} (${game.name}) forcefully`);

        if (!game.started) {
            delete this.games[game.id];
        } else {
            this.router.closeGame(game);
        }

        this.broadcastGameMessage('removegame', game);
    }

    onGetNodeStatus(socket) {
        if (!socket.user.permissions.canManageNodes) {
            return;
        }

        socket.send('nodestatus', this.router.getNodeStatus());
    }

    onToggleNode(socket, node) {
        if (!socket.user.permissions.canManageNodes) {
            return;
        }

        this.router.toggleNode(node);

        socket.send('nodestatus', this.router.getNodeStatus());
    }

    onRestartNode(socket, node) {
        if (!socket.user.permissions.canManageNodes) {
            return;
        }

        this.router.restartNode(node);

        socket.send('nodestatus', this.router.getNodeStatus());
    }

    onMotdChange(socket, motd) {
        if (!socket.user.permissions.canManageMotd) {
            return;
        }

        let newMotd =
            motd && motd.message
                ? {
                      message: motd.message,
                      motdType: motd.motdType,
                      type: 'motd',
                      time: new Date()
                  }
                : {};

        this.messageService
            .setMotdMessage(newMotd, socket.user)
            .then(() => {
                this.io.emit('motd', { message: newMotd.message, motdType: newMotd.motdType });
            })
            .catch((err) => {
                logger.error(err);
            });
    }

    // router Events
    onGameClosed(gameId) {
        let game = this.games[gameId];

        if (!game) {
            return;
        }

        this.broadcastGameMessage('removegame', game);
        delete this.games[gameId];
    }

    // ARCHON: tournament engine integration ---------------------------------
    // Online events get their table games created automatically per
    // pairing; GAMEWIN results flow back into the tournament service;
    // best-of series spin up their next game.

    /**
     * ARCHON: a tournament table is identified by MATCH AND GAME NUMBER, never
     * by the match alone.
     *
     * A best-of-three match has up to three tables over its life and the
     * finished ones stay in `this.games` until they are reaped, so "the game
     * for match 7" is an ambiguous question with a misleading answer: it
     * returns whichever was inserted first, which after game one is always the
     * FINISHED game one.
     *
     * That single ambiguity produced all three symptoms of a live Bo3 that went
     * wrong. The guard in ensureTournamentGame compared that stale table's game
     * number against the one being asked for, found them different, and built
     * another table - every single time anything asked, which is how one match
     * ended up with four tables for game two. The player's own match panel
     * looked up the same way and pointed them back at the game they had just
     * finished, so the button appeared to do nothing and they clicked again,
     * making yet another.
     *
     * @param {number} matchId
     * @param {number} [gameNumber] omit to find any table for the match
     */
    findTournamentGame(matchId, gameNumber) {
        return Object.values(this.games).find(
            (game) =>
                game.tournament &&
                game.tournament.matchId === matchId &&
                (gameNumber === undefined || game.tournament.gameNumber === gameNumber)
        );
    }

    /**
     * Every table for a match other than the one being kept.
     *
     * A finished game's table lingers so its players can read the result and
     * leave in their own time, and that is worth keeping. What is not worth
     * keeping is an UNSTARTED table for a game that is no longer next - a
     * duplicate somebody's second click created, or the previous game's table
     * when the series has moved on. Those are indistinguishable from the real
     * one in the lobby list, and joining the wrong one means sitting at a table
     * the event will never look at.
     */
    staleTournamentTables(matchId, keepGameId) {
        return Object.values(this.games).filter(
            (game) =>
                game.tournament &&
                game.tournament.matchId === matchId &&
                game.id !== keepGameId &&
                !game.started
        );
    }

    async onTournamentRoundPaired({ tournamentId }) {
        try {
            // forPairing: async events skip the bulk table creation here and
            // open tables on demand instead - see getMatchesNeedingGames.
            const matches = await this.tournamentService.getMatchesNeedingGames(tournamentId, {
                forPairing: true
            });

            for (const matchInfo of matches) {
                await this.ensureTournamentGame(matchInfo);
            }
        } catch (err) {
            logger.error(`Failed to create games for tournament ${tournamentId}`, err);
        }
    }

    /**
     * Answers `ensureMatchGame`, which is a REQUEST rather than an
     * announcement: a player is waiting on the table this returns. The game is
     * handed back so the service can give its id to the client, which then
     * walks straight to the table instead of waiting to notice it appear.
     */
    async onTournamentEnsureMatchGame({ tournamentId, matchId }) {
        try {
            const matches = await this.tournamentService.getMatchesNeedingGames(tournamentId);
            const matchInfo = matches.find((entry) => entry.matchId === matchId);

            if (matchInfo) {
                return await this.ensureTournamentGame(matchInfo);
            }

            // Nothing needs a game: the match already has its table, and the
            // player should be sent to it rather than told nothing happened.
            return this.findTournamentGame(matchId);
        } catch (err) {
            logger.error(`Failed to open game for tournament match ${matchId}`, err);

            return null;
        }
    }

    /**
     * ARCHON: a player changed the deck they are registered with, and the
     * event allowed it.
     *
     * Their table for this round may already be open - asynchronous events
     * open theirs on demand, often long before either player sits down - and
     * it was built with the deck they had at the time. The seat is pinned to
     * that deck, so leaving it alone would pin them to the deck they just
     * replaced: a swap the event permitted, refused by the table. Re-pin the
     * open table and put the new deck in the seat.
     *
     * Only tables that have not started: once the game is under way the deck
     * is part of it, and the service will not have allowed the swap anyway.
     */
    async onTournamentDeckRegistered({ tournamentId, username, deckId }) {
        const tables = Object.values(this.games).filter(
            (game) =>
                !game.started &&
                game.tournament &&
                game.tournament.tournamentId === tournamentId &&
                Object.prototype.hasOwnProperty.call(game.tournament.decks || {}, username)
        );

        for (const game of tables) {
            game.tournament.decks[username] = deckId || null;

            const player = game.getPlayerByName(username);

            if (!player || !deckId) {
                // Not seated yet (or they cleared their deck): the pin is
                // updated, and joining will select it.
                this.sendGameState(game);
                continue;
            }

            try {
                await this.applyDeckSelection(game, username, deckId, false);
                this.startTournamentGameIfReady(game);
            } catch (err) {
                logger.error(
                    `Failed to re-select deck ${deckId} for ${username} at tournament table ${game.id}`,
                    err
                );
            }
        }
    }

    async onTournamentGameWin(gameSave) {
        if (!gameSave || !gameSave.tournament) {
            return;
        }

        try {
            const result = await this.tournamentService.recordGameWin(gameSave);

            if (result?.handled && result.matchComplete === false && result.nextGameNumber) {
                // Series continues: put the next game up right away so
                // the players find their table when they leave this one.
                const matches = await this.tournamentService.getMatchesNeedingGames(
                    gameSave.tournament.tournamentId
                );
                const matchInfo = matches.find(
                    (entry) => entry.matchId === gameSave.tournament.matchId
                );

                if (matchInfo) {
                    await this.ensureTournamentGame(matchInfo);
                }
            }
        } catch (err) {
            logger.error('Failed to process tournament game result', err);
        }
    }

    /**
     * Create the lobby game for a tournament pairing unless one is
     * already up. Players who are online and idle are seated
     * immediately with their registered decks; everyone else joins
     * from the lobby or the event page. The game starts itself once
     * both players are seated with decks.
     */
    async ensureTournamentGame(matchInfo) {
        // The table for THIS game of the match. Anything else - the finished
        // previous game, a duplicate - is not it. See findTournamentGame.
        const existing = this.findTournamentGame(matchInfo.matchId, matchInfo.gameNumber);

        if (existing) {
            return existing;
        }

        /**
         * ARCHON: one creation at a time per game of a match.
         *
         * There is real work between the check above and the insert below - two
         * user lookups - and every one of the several things that can ask for a
         * table can ask at the same moment: a player pressing the button twice
         * because nothing visibly happened, the automatic open after a game is
         * won, and the round-paired sweep. Without this they each find nothing,
         * each wait on the database, and each create a table.
         */
        this.pendingTournamentTables = this.pendingTournamentTables || new Set();

        const key = `${matchInfo.matchId}:${matchInfo.gameNumber}`;

        if (this.pendingTournamentTables.has(key)) {
            return null;
        }

        this.pendingTournamentTables.add(key);

        try {
            return await this.createTournamentGame(matchInfo);
        } finally {
            this.pendingTournamentTables.delete(key);
        }
    }

    async createTournamentGame(matchInfo) {
        const users = await Promise.all(
            matchInfo.players.map((player) => this.userService.getUserByUsername(player.username))
        );

        if (users.some((user) => !user)) {
            logger.error(
                `Tournament match ${matchInfo.matchId}: could not load players ${matchInfo.players
                    .map((player) => player.username)
                    .join(', ')}`
            );

            return null;
        }

        const tableLabel = matchInfo.table ? ` T${matchInfo.table}` : '';
        const seriesLabel = matchInfo.bestOf > 1 ? ` (game ${matchInfo.gameNumber})` : '';
        const name =
            `${matchInfo.tournamentName} R${matchInfo.round}${tableLabel}: ${matchInfo.players[0].username} vs ${matchInfo.players[1].username}${seriesLabel}`.slice(
                0,
                255
            );

        const game = new PendingGame(users[0], {
            allowSpectators: true,
            gameFormat: matchInfo.gameFormat,
            gameTimeLimit: matchInfo.gameTimeLimit || undefined,
            useGameTimeLimit: !!matchInfo.gameTimeLimit,
            // ARCHON: a sealed event deals its decks at the table, so the
            // table needs the event's legal sets. Without this the pool was
            // `undefined`, which getSealedDeck used to throw on - an online
            // sealed event could never deal a deck and so never start a game.
            expansions: DeckService.sealedExpansionsFromIds(matchInfo.allowedSets),
            hideDeckLists: matchInfo.hideDecklists,
            muteSpectators: true,
            name: name,
            showHand: false,
            previousWinner: matchInfo.previousWinner || undefined,
            tournament: {
                tournamentId: matchInfo.tournamentId,
                matchId: matchInfo.matchId,
                gameNumber: matchInfo.gameNumber,
                bestOf: matchInfo.bestOf,
                round: matchInfo.round,
                table: matchInfo.table,
                players: matchInfo.players.map((player) => player.username),
                // The deck each seat is pinned to for this pairing, and the
                // policy that decides what the table says when it refuses
                // anything else. See Lobby.tournamentDeckFor.
                deckSwapPolicy: matchInfo.deckSwapPolicy || 'locked',
                decks: Object.fromEntries(
                    matchInfo.players.map((player) => [player.username, player.deckId])
                )
            }
        });

        // ARCHON: pre-assigned chains (SAS handicap / Chainbound accrual)
        // ride the pending game into the engine's setup phase.
        if (matchInfo.startingChains) {
            game.startingChains = matchInfo.startingChains;
        }

        this.games[game.id] = game;

        await this.tournamentService.attachGame(
            matchInfo.tournamentId,
            matchInfo.matchId,
            matchInfo.gameNumber,
            game.id
        );

        await this.seatTournamentPlayers(game, matchInfo);

        /**
         * Clear away any unstarted table left over for this match.
         *
         * Belt and braces next to the guards above, and it also repairs a
         * lobby that already has duplicates from before those guards existed -
         * which is not hypothetical, since that is how this was reported. A
         * started table is never touched: its players are in it.
         */
        for (const stale of this.staleTournamentTables(matchInfo.matchId, game.id)) {
            logger.info(
                `Removing duplicate tournament table ${stale.id} for match ${matchInfo.matchId}`
            );
            this.broadcastGameMessage('removegame', stale);
            delete this.games[stale.id];
        }

        this.broadcastGameMessage('newgame', game);
        this.sendGameState(game);

        logger.info(`Created tournament game ${game.id} for match ${matchInfo.matchId} (${name})`);

        this.startTournamentGameIfReady(game);

        return game;
    }

    /**
     * Put the pairing in their seats with the decks the event pinned.
     *
     * Shared by table creation and by a series continuing at the table it is
     * already at: in the second case the table already exists and only the
     * seating is wanted, so this cannot live inside the creation path.
     *
     * Anyone already in another game is left alone - they will be seated when
     * they leave it, and dragging somebody out of a game they are playing to
     * sit them at another is never right.
     */
    async seatTournamentPlayers(game, matchInfo) {
        for (const player of matchInfo.players) {
            const socket = this.socketsByName[player.username];

            if (!socket || game.getPlayerByName(player.username)) {
                continue;
            }

            const busyIn = this.findGameForUser(player.username);

            if (busyIn && busyIn.id !== game.id) {
                continue;
            }

            const joinError = game.join(socket.id, socket.user);

            if (joinError) {
                continue;
            }

            socket.joinChannel(game.id);

            if (player.deckId) {
                try {
                    await this.applyDeckSelection(game, player.username, player.deckId, false);
                } catch (err) {
                    logger.error(
                        `Failed to auto-select deck ${player.deckId} for ${player.username}`,
                        err
                    );
                }
            }
        }
    }

    /**
     * ARCHON: both players agreed to play the next game of their match at the
     * table they just finished on.
     *
     * The node has already cleared them out and let its game go. What is left
     * is to retire the finished table and seat them at the one the event
     * opened for the next game - which exists already, because opening it is
     * the first thing that happens when a result is recorded.
     *
     * Everything about the event travels with them: the match, the pinned
     * decks, the series number. That is the whole reason this is not a
     * rematch, which would have built a table the event knows nothing about.
     */
    async onTournamentNextGame(oldGame) {
        const finished = this.games[oldGame.gameId];

        if (!finished || !finished.tournament) {
            return;
        }

        const { tournamentId, matchId } = finished.tournament;

        // The finished table has done its job. Removing it first also frees
        // both players from it, so the seating below can find them idle.
        this.broadcastGameMessage('removegame', finished);
        delete this.games[finished.id];

        try {
            const matches = await this.tournamentService.getMatchesNeedingGames(tournamentId);
            const matchInfo = matches.find((entry) => entry.matchId === matchId);

            if (!matchInfo) {
                // The match is over - the game just played decided it. Nothing
                // to open, and the event page has the result.
                logger.info(`Match ${matchId} needs no further game; not continuing the series`);

                return;
            }

            const game = await this.ensureTournamentGame(matchInfo);

            if (!game) {
                return;
            }

            await this.seatTournamentPlayers(game, matchInfo);

            this.sendGameState(game);
            this.broadcastGameMessage('updategame', game);
            this.startTournamentGameIfReady(game);
        } catch (err) {
            logger.error(`Failed to continue tournament match ${matchId} at its table`, err);
        }
    }

    /**
     * Tournament games skip the owner-driven start: as soon as both
     * paired players are seated with decks, the game launches and both
     * players are handed off to the game node.
     */
    startTournamentGameIfReady(game) {
        if (!game || game.started || !game.tournament) {
            return;
        }

        const players = Object.values(game.getPlayers());

        if (players.length < 2 || players.some((player) => !player.deck)) {
            return;
        }

        // ARCHON: the deck lock, second gate - see refuseUnpinnedStart.
        if (this.refuseUnpinnedStart(game)) {
            return;
        }

        const gameNode = this.router.startGame(game);

        if (!gameNode) {
            logger.error(`No game nodes available for tournament game ${game.id}`);

            return;
        }

        game.node = gameNode;
        game.started = true;

        this.broadcastGameMessage('updategame', game);

        for (const player of Object.values(game.getPlayersAndSpectators())) {
            const socket = this.sockets[player.id];

            if (!socket || !socket.user) {
                logger.error(`Wanted to handoff to ${player.name}, but couldn't find a socket`);
                continue;
            }

            this.sendHandoff(socket, gameNode, game.id);
        }
    }

    onGameRematch(oldGame) {
        let gameId = oldGame.gameId;
        let game = this.games[gameId];

        if (!game) {
            return;
        }

        // ARCHON: a tournament table is not ours to replace. The chat command
        // already refuses, but this handler is the destructive half - it drops
        // the table out of this.games - and a table the event is still
        // tracking must not disappear because a message arrived.
        if (game.tournament) {
            logger.warn(`Ignored a rematch request for tournament table ${gameId}`);

            return;
        }

        this.broadcastGameMessage('removegame', game);
        delete this.games[gameId];

        let newGame = new PendingGame(game.owner, {
            adaptive: game.adaptive,
            gameFormat: game.gameFormat,
            gameTimeLimit: game.gameTimeLimit,
            hideDeckLists: game.hideDeckLists,
            // A rematch is the same game again: its deck rules come too.
            luckyDice: game.luckyDice,
            sasBound: game.sasBound,
            showHand: game.showHand,
            allowSpectators: game.allowSpectators,
            spectators: game.spectators,
            swap: oldGame.swap,
            useGameTimeLimit: game.useGameTimeLimit
        });
        newGame.rematch = true;
        newGame.previousWinner = oldGame.winner;

        let owner = game.getPlayerOrSpectator(game.owner.username);
        if (!owner) {
            logger.error("Tried to rematch but the owner wasn't in the game");
            return;
        }

        let socket = this.socketsByName[owner.name];
        if (!socket) {
            logger.error("Tried to rematch but the owner's socket has gone away");
            return;
        }

        this.games[newGame.id] = newGame;
        newGame.newGame(socket.id, socket.user);

        socket.joinChannel(newGame.id);
        this.sendGameState(newGame);
        this.broadcastGameMessage('newgame', newGame);

        const ownerDeck =
            owner.deck || (oldGame.players || []).find((x) => x.name === owner.name)?.deck;

        if (!ownerDeck || !ownerDeck.id) {
            logger.error(`Tried to rematch but ${owner.name} has no deck selected`);
            return;
        }

        let promises = [
            this.onSelectDeck(
                socket,
                newGame.id,
                ownerDeck.id,
                ownerDeck.isStandalone || ownerDeck.is_standalone
            )
        ];

        for (let player of Object.values(game.getPlayers()).filter(
            (player) => player.name !== owner.username && !player.left
        )) {
            let socket = this.socketsByName[player.name];

            if (!socket) {
                logger.warn(
                    `Tried to add ${player.name} to a rematch but couldn't find their socket`
                );
                continue;
            }

            const playerDeck =
                player.deck || (oldGame.players || []).find((x) => x.name === player.name)?.deck;

            if (!playerDeck || !playerDeck.id) {
                logger.warn(`Tried to rematch but ${player.name} has no deck selected`);
                continue;
            }

            newGame.join(socket.id, player.user);
            promises.push(
                this.onSelectDeck(
                    socket,
                    newGame.id,
                    playerDeck.id,
                    playerDeck.isStandalone || playerDeck.is_standalone
                )
            );
        }

        for (let player of Object.values(game.getPlayers())) {
            let oldPlayer = oldGame.players.find((x) => x.name === player.name);

            if (oldPlayer && oldPlayer.wins) {
                if (!newGame.players[player.name]) {
                    logger.warn(
                        `Tried to set ${player.name} wins but couldn't find them in the game`
                    );
                    continue;
                }

                newGame.players[player.name].wins = oldPlayer.wins;
            }
        }

        for (let spectator of game.getSpectators()) {
            let socket = this.socketsByName[spectator.name];

            if (!socket) {
                logger.warn(
                    `Tried to add ${spectator.name} to spectate a rematch but couldn't find their socket`
                );
                continue;
            }

            newGame.watch(socket.id, spectator.user);
        }

        // Set the password after everyone has joined, so we don't need to worry about overriding the password, or storing it unencrypted/hashed
        newGame.password = game.password;

        Promise.all(promises).then(() => {
            this.onStartGame(socket, newGame.id);
        });
    }

    onGameRematchWithNewDecks(oldGame) {
        let gameId = oldGame.gameId;
        let game = this.games[gameId];

        if (!game) {
            return;
        }

        // ARCHON: a tournament table is not ours to replace. The chat command
        // already refuses, but this handler is the destructive half - it drops
        // the table out of this.games - and a table the event is still
        // tracking must not disappear because a message arrived.
        if (game.tournament) {
            logger.warn(`Ignored a rematch request for tournament table ${gameId}`);

            return;
        }

        this.broadcastGameMessage('removegame', game);
        delete this.games[gameId];

        let newGame = new PendingGame(game.owner, {
            adaptive: game.adaptive,
            gameFormat: game.gameFormat,
            gameTimeLimit: game.gameTimeLimit,
            hideDeckLists: game.hideDeckLists,
            // A rematch is the same game again: its deck rules come too.
            luckyDice: game.luckyDice,
            sasBound: game.sasBound,
            showHand: game.showHand,
            allowSpectators: game.allowSpectators,
            spectators: game.spectators,
            swap: false,
            useGameTimeLimit: game.useGameTimeLimit
        });
        newGame.rematch = true;
        newGame.previousWinner = oldGame.winner;

        let owner = game.getPlayerOrSpectator(game.owner.username);
        if (!owner) {
            logger.error("Tried to rematch but the owner wasn't in the game");
            return;
        }

        let socket = this.socketsByName[owner.name];
        if (!socket) {
            logger.error("Tried to rematch but the owner's socket has gone away");
            return;
        }

        this.games[newGame.id] = newGame;
        newGame.newGame(socket.id, socket.user);

        socket.joinChannel(newGame.id);
        this.sendGameState(newGame);
        this.broadcastGameMessage('newgame', newGame);

        // ARCHON: in a Lucky Dice game "new decks" means new ROLLS - nobody
        // picks, so the owner's old deck is not re-selected either. Everyone
        // starts deckless and the dice fall at start.
        if (!newGame.luckyDice) {
            const ownerDeck =
                owner.deck || (oldGame.players || []).find((x) => x.name === owner.name)?.deck;

            if (!ownerDeck || !ownerDeck.id) {
                logger.error(
                    `Tried to rematch with new decks but ${owner.name} has no deck selected`
                );
                return;
            }

            this.onSelectDeck(
                socket,
                newGame.id,
                ownerDeck.id,
                ownerDeck.isStandalone || ownerDeck.is_standalone
            );
        }

        for (let player of Object.values(game.getPlayers()).filter(
            (player) => player.name !== owner.username && !player.left
        )) {
            let socket = this.socketsByName[player.name];

            if (!socket) {
                logger.warn(
                    `Tried to add ${player.name} to a rematch but couldn't find their socket`
                );
                continue;
            }
            player.deck = [];

            newGame.join(socket.id, player.user);
            socket.joinChannel(newGame.id);
        }

        for (let player of Object.values(game.getPlayers())) {
            let oldPlayer = oldGame.players.find((x) => x.name === player.name);

            if (oldPlayer && oldPlayer.wins) {
                if (!newGame.players[player.name]) {
                    logger.warn(
                        `Tried to set ${player.name} wins but couldn't find them in the game`
                    );
                    continue;
                }

                newGame.players[player.name].wins = oldPlayer.wins;
            }
        }

        for (let spectator of game.getSpectators()) {
            let socket = this.socketsByName[spectator.name];

            if (!socket) {
                logger.warn(
                    `Tried to add ${spectator.name} to spectate a rematch but couldn't find their socket`
                );
                continue;
            }

            newGame.watch(socket.id, spectator.user);
        }

        // Set the password after everyone has joined, so we don't need to worry about overriding the password, or storing it unencrypted/hashed
        newGame.password = game.password;

        this.sendGameState(newGame);
        this.broadcastGameMessage('updategame', newGame);
    }

    onPlayerLeft(gameId, player) {
        let game = this.games[gameId];

        if (!game) {
            return;
        }

        game.leave(player);

        if (game.isEmpty()) {
            this.broadcastGameMessage('removegame', game);
            delete this.games[gameId];
        } else {
            this.broadcastGameMessage('updategame', game);
        }
    }

    onBlocklistChanged(user) {
        const updatedUser = this.users[user.username];

        if (!updatedUser) {
            return;
        }

        const socket = this.socketsByName[user.username];
        if (!socket) {
            updatedUser.blockList = user.blockList;
            return;
        }

        const oldBlockList = updatedUser.blockList || [];
        const newBlockList = user.blockList || [];

        const added = newBlockList.filter((entry) => !oldBlockList.includes(entry));
        const removed = oldBlockList.filter((entry) => !newBlockList.includes(entry));

        // Snapshot game visibility before the update
        let gameVisibilityBefore = {};
        for (let game of Object.values(this.games)) {
            gameVisibilityBefore[game.id] = game.isVisibleFor(updatedUser);
        }

        updatedUser.blockList = user.blockList;

        // Send targeted removals for newly blocked users
        for (let blockedName of added) {
            let blockedUser = Object.values(this.users).find(
                (u) => u.username.toLowerCase() === blockedName
            );
            if (blockedUser) {
                socket.send('userleft', blockedUser.getShortSummary());
            }
        }

        // Send targeted additions for newly unblocked users
        for (let unblockedName of removed) {
            let unblockedUser = Object.values(this.users).find(
                (u) => u.username.toLowerCase() === unblockedName
            );
            if (unblockedUser) {
                socket.send('newuser', unblockedUser.getShortSummary());
            }
        }

        // Send targeted game removals/additions based on visibility changes
        let gamesToRemove = [];
        let gamesToAdd = [];
        for (let game of Object.values(this.games)) {
            let wasVisible = gameVisibilityBefore[game.id];
            let isVisible = game.isVisibleFor(updatedUser);

            if (wasVisible && !isVisible) {
                gamesToRemove.push(game);
            } else if (!wasVisible && isVisible) {
                gamesToAdd.push(game);
            }
        }

        if (gamesToRemove.length > 0) {
            socket.send(
                'removegame',
                gamesToRemove.map((game) => game.getSummary())
            );
        }

        if (gamesToAdd.length > 0) {
            socket.send(
                'newgame',
                gamesToAdd.map((game) => game.getSummary())
            );
        }
    }

    onWorkerTimedOut(nodeName) {
        this.clearGamesForNode(nodeName);
    }

    onWorkerStarted() {}

    onClearSessions(socket, username) {
        this.userService.clearUserSessions(username).then((success) => {
            if (!success) {
                logger.error(`Failed to clear sessions for user ${username}`);
                return;
            }

            let game = this.findGameForUser(username);

            if (game) {
                logger.info(
                    `closed game ${game.id} (${game.name}) forcefully due to clear session on ${username}`
                );

                if (!game.started) {
                    delete this.games[game.id];
                } else {
                    this.router.closeGame(game);
                }
            }

            let socket = Object.values(this.sockets).find((socket) => {
                return socket.user && socket.user.username === username;
            });

            if (socket) {
                socket.disconnect();
            }
        });
    }

    onNodeReconnected(nodeName, games) {
        for (let game of Object.values(games)) {
            let owner = game.players[game.owner];

            if (!owner) {
                logger.error("Got a game where the owner %s wasn't a player", game.owner);
                continue;
            }

            let syncGame = new PendingGame(new User(owner.user), {
                spectators: game.allowSpectators,
                name: game.name
            });
            syncGame.adaptive = game.adaptive;
            syncGame.createdAt = game.startedAt;
            syncGame.gameFormat = game.gameFormat;
            syncGame.gamePrivate = game.gamePrivate;
            syncGame.id = game.id;
            syncGame.node = this.router.workers[nodeName];
            syncGame.password = game.password;
            syncGame.started = game.started;

            for (let player of Object.values(game.players)) {
                syncGame.players[player.name] = {
                    id: player.id,
                    name: player.name,
                    owner: game.owner === player.name,
                    user: new User(player.user)
                };
            }

            for (let player of Object.values(game.spectators)) {
                syncGame.spectators[player.name] = {
                    id: player.id,
                    name: player.name,
                    user: new User(player.user)
                };
            }

            this.games[syncGame.id] = syncGame;
        }

        for (let game of Object.values(this.games)) {
            if (
                game.node &&
                game.node.identity === nodeName &&
                Object.values(games).find((nodeGame) => {
                    return nodeGame.id === game.id;
                })
            ) {
                this.games[game.id] = game;
            } else if (game.node && game.node.identity === nodeName) {
                delete this.games[game.id];
            }
        }

        this.broadcastGameList();
    }
}

module.exports = Lobby;
