const passport = require('passport');
const { randomUUID } = require('node:crypto');

const ConfigService = require('../services/ConfigService');
const DeckService = require('../services/DeckService.js');
const { wrapAsync } = require('../util.js');
const logger = require('../log.js');
const ServiceFactory = require('../services/ServiceFactory');
const configService = new ConfigService();
const cardService = ServiceFactory.cardService(configService);

const deckService = new DeckService(configService, cardService);

// ARCHON: Decks of KeyForge SAS enrichment (see docs/design/deck-sas.md)
const DokService = require('../services/dok/DokService');
const dokService = new DokService(configService);

// ARCHON: Master Vault name -> uuid index (see docs/design/deck-catalog.md)
const CatalogService = require('../services/catalog/CatalogService');
const catalogService = new CatalogService(configService);

// ARCHON: collection imports run as a resumable server-side job so closing the
// modal no longer abandons them half-done (docs/design/dok-import.md).
const DeckImportJobService = require('../services/deckimport/DeckImportJobService');
const deckImportService = new DeckImportJobService(configService);

const UUID_PATTERN =
    /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/**
 * A job row as the client needs it: totals, progress, and the failure reasons
 * ranked so the UI can show the one sentence that explains 200 failures rather
 * than a list of 200. Returns null for "this user has never run an import",
 * which the UI treats as an empty state rather than an error.
 */
function mapImportJob(job) {
    if (!job) {
        return null;
    }

    const reasons = deckImportService.parseReasons(job);

    return {
        id: job.Id,
        status: job.Status,
        total: deckImportService.parseUuids(job).length,
        done: job.Cursor,
        imported: job.Imported,
        alreadyOwned: job.AlreadyOwned,
        failed: job.Failed,
        reasons: Object.entries(reasons)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 3),
        pausedUntil: job.PausedUntil,
        lastError: job.LastError,
        updatedAt: job.UpdatedAt
    };
}

// ARCHON: the DoK collection-import "prepare" step can drive many outbound
// requests. Those now spend the *user's* DoK quota rather than the site's, so
// this cap is about protecting DoK from us hammering them on a user's behalf
// rather than about protecting our own SAS budget.
const { rateLimit } = require('./rateLimit');
const dokPrepareLimit = rateLimit({
    name: 'dok-prepare',
    windowMs: 10 * 60 * 1000,
    max: 10,
    message: 'Too many Decks of KeyForge import attempts. Please wait a few minutes and try again.'
});

// ARCHON: catalog search runs a leading-wildcard LIKE over a table that grows to
// millions of rows. It is a cheap query with a trigram index and an expensive
// one without (the index is best-effort - see the migration), so it gets a
// limit generous enough for type-ahead and tight enough to bound the damage.
const catalogSearchLimit = rateLimit({
    name: 'catalog-search',
    windowMs: 60 * 1000,
    max: 60,
    message: 'Too many deck searches. Please slow down a moment.'
});

module.exports.init = function (server) {
    server.get(
        '/api/standalone-decks',
        wrapAsync(async function (req, res) {
            let decks;

            try {
                decks = await deckService.getStandaloneDecks();
            } catch (err) {
                logger.error('Failed to get standalone decks', err);

                throw new Error('Failed to get standalone decks');
            }

            res.send({ success: true, decks: decks });
        })
    );

    server.get(
        '/api/decks/:id',
        passport.authenticate('jwt', { session: false }),
        wrapAsync(async function (req, res) {
            if (!req.params.id || req.params.id === '') {
                return res.status(404).send({ message: 'No such deck' });
            }

            let deck = await deckService.getById(req.params.id);

            if (!deck) {
                return res.status(404).send({ message: 'No such deck' });
            }

            if (deck.username !== req.user.username) {
                return res.status(401).send({ message: 'Unauthorized' });
            }

            // ARCHON: attach cached SAS stats (best effort, non-blocking refresh)
            await dokService.attachStats([deck]);

            // ARCHON: the AERC component breakdown behind the SAS number. Comes
            // from the DoK payload already stored on the deck, so it costs one
            // local read and never an outbound call.
            const aerc = await dokService.getAercBreakdown(deck.uuid);

            res.send({ success: true, deck: deck, aerc: aerc });
        })
    );

    server.get(
        '/api/decks',
        passport.authenticate('jwt', { session: false }),
        wrapAsync(async function (req, res) {
            let numDecks = await deckService.getNumDecksForUser(req.user, req.query);
            let decks = [];

            if (numDecks > 0) {
                decks = (await deckService.findForUser(req.user, req.query)).map((deck) => {
                    let deckUsageLevel = 0;
                    if (
                        deck.usageCount >
                        configService.getValueForSection('lobby', 'lowerDeckThreshold')
                    ) {
                        deckUsageLevel = 1;
                    }

                    if (
                        deck.usageCount >
                        configService.getValueForSection('lobby', 'middleDeckThreshold')
                    ) {
                        deckUsageLevel = 2;
                    }

                    if (
                        deck.usageCount >
                        configService.getValueForSection('lobby', 'upperDeckThreshold')
                    ) {
                        deckUsageLevel = 3;
                    }

                    deck.usageLevel = deckUsageLevel;
                    deck.usageCount = undefined;

                    return deck;
                });

                // ARCHON: attach cached SAS stats (best effort, non-blocking refresh)
                await dokService.attachStats(decks);
            }

            res.send({ success: true, numDecks: numDecks, decks: decks });
        })
    );

    server.post(
        '/api/decks',
        passport.authenticate('jwt', { session: false }),
        wrapAsync(async function (req, res) {
            if (!req.body.uuid) {
                return res.send({ success: false, message: 'uuid must be specified' });
            }

            let deck = Object.assign({}, { uuid: req.body.uuid, username: req.user.username });
            let createResult;

            try {
                createResult = await deckService.create(req.user, deck);
            } catch (error) {
                logger.error('Failed to import deck', error);

                // ARCHON: pass the failure KIND through, not just prose. A bulk
                // import has to be able to tell "slow down" from "this deck is
                // no good" - the first is worth waiting out, the second never
                // will be, and treating them alike means retrying what cannot
                // succeed while giving up on what would have.
                return res.send({
                    success: false,
                    code: error.code || 'import_failed',
                    message:
                        error.code === 'upstream_rate_limited'
                            ? error.message
                            : 'An error occurred importing your deck.  Please check the Url or try again later.'
                });
            }

            if (!createResult || !createResult.success) {
                return res.send({
                    success: false,
                    message:
                        createResult && createResult.message
                            ? createResult.message
                            : 'An error occurred importing your deck.  Please check the Url or try again later.'
                });
            }

            // ARCHON: fire-and-forget SAS fetch for the newly imported deck
            dokService.enrichDeck(req.body.uuid);

            res.send({ success: true, deck: createResult.deck });
        })
    );

    // ARCHON: bulk import from Decks of KeyForge. This "prepare" step lists
    // the user's whole DoK collection, drops decks they already own, and
    // returns the remainder; the client then imports each id through the
    // ordinary /api/decks path (which handles Master Vault fetch + SAS), so
    // one proven import path serves both single and bulk. See
    // docs/design/dok-import.md.
    //
    // The caller supplies their OWN DoK API key. It is used for this request
    // and then dropped: this codebase has no encryption-at-rest helper, and
    // holding a third party's credential in plaintext to save the user a paste
    // is a bad trade. Nothing about the key is logged, ever.
    server.post(
        '/api/decks/import/dok/prepare',
        passport.authenticate('jwt', { session: false }),
        dokPrepareLimit,
        wrapAsync(async function (req, res) {
            const dokApiKey = (req.body.dokApiKey || '').trim();

            if (!dokApiKey) {
                return res.send({
                    success: false,
                    message: 'Enter your Decks of KeyForge API key.'
                });
            }

            // Note this is isImportEnabled, not isEnabled: listing a user's own
            // decks needs only their key, so collection import works on a server
            // that has no site-wide DOK_API_KEY (SAS enrichment still would not).
            if (!dokService.isImportEnabled()) {
                return res.send({
                    success: false,
                    message: 'Decks of KeyForge import is turned off on this server.'
                });
            }

            logger.info(`DoK collection import: user ${req.user.username} preparing import`);

            // Read what they already have BEFORE listing, and let the service
            // skip those decks as it pages. The safety cap then bounds decks
            // that still need importing rather than decks DoK reported, which
            // is what makes re-running a capped sync pick up where it left off
            // instead of returning the same first batch forever.
            const ownedUuids = new Set(await deckService.getOwnedDeckUuids(req.user.id));

            let result;
            try {
                result = await dokService.listMyDecks(dokApiKey, { skipUuids: ownedUuids });
            } catch (err) {
                // listMyDecks is designed never to throw; if it somehow does,
                // log loudly and answer cleanly instead of a bare 500.
                logger.error(
                    `DoK collection import prepare failed for user ${req.user.username}`,
                    err
                );

                return res.send({
                    success: false,
                    message: 'Something went wrong talking to Decks of KeyForge. Please try again.'
                });
            }

            logger.info(
                `DoK collection import: user ${req.user.username} -> ` +
                    `configured=${result.configured !== false} error=${!!result.error} ` +
                    `new=${result.decks.length} owned=${result.skipped || 0} ` +
                    `truncated=${!!result.truncated} partial=${!!result.partial}`
            );

            if (result.error) {
                return res.send({
                    success: false,
                    message: result.errorDetail
                        ? `Decks of KeyForge request failed: ${result.errorDetail}`
                        : 'Could not reach Decks of KeyForge. Please try again in a moment.'
                });
            }

            // Nothing new AND nothing recognised means the key gave us an empty
            // collection. Nothing new but decks already owned is a successful
            // no-op sync, which is what every run after the first one looks like.
            if (!result.decks.length && !result.skipped) {
                return res.send({
                    success: false,
                    message:
                        'That key returned no decks. Check the key, and that your decks are marked as owned on Decks of KeyForge.'
                });
            }

            // Hand the uuids to a server-side job rather than back to the
            // browser. The listing needed the key; importing does not - Master
            // Vault has never heard of it - so the job carries uuids only and
            // the key goes out of scope here, exactly as before.
            const job = await deckImportService.createJob({
                userId: req.user.id,
                username: req.user.username,
                uuids: result.decks.map((deck) => deck.uuid)
            });

            // ARCHON: a job that was not created is a failed import, not a
            // successful one with nothing to watch. Reporting success here left
            // the modal saying "Importing 200 decks" over a job that did not
            // exist, polling nothing, forever - and createJob supersedes the
            // previous job before it inserts, so the player could be left with
            // neither the new import nor the one they already had.
            if (!job) {
                return res.send({
                    success: false,
                    message: 'Could not start the import. Please try again in a moment.'
                });
            }

            res.send({
                success: true,
                total: result.decks.length + (result.skipped || 0),
                ownedCount: result.skipped || 0,
                truncated: !!result.truncated,
                partial: !!result.partial,
                queued: result.decks.length,
                job: mapImportJob(job)
            });
        })
    );

    // ARCHON: queue an arbitrary list of Master Vault ids - the CSV upload and
    // the paste box. Same job machinery as the DoK sync, so every route into a
    // bulk import gets the same pacing, resumability and progress.
    server.post(
        '/api/decks/import/queue',
        passport.authenticate('jwt', { session: false }),
        dokPrepareLimit,
        wrapAsync(async function (req, res) {
            const uuids = Array.isArray(req.body.uuids)
                ? req.body.uuids.filter((uuid) => UUID_PATTERN.test(String(uuid || '')))
                : [];

            if (uuids.length === 0) {
                return res.send({ success: false, message: 'No deck ids to import.' });
            }

            // Drop what they already own here rather than making the worker
            // discover it one 'Deck already exists' at a time.
            const ownedUuids = new Set(await deckService.getOwnedDeckUuids(req.user.id));
            const toImport = [...new Set(uuids.map((uuid) => uuid.toLowerCase()))].filter(
                (uuid) => !ownedUuids.has(uuid)
            );

            if (toImport.length === 0) {
                return res.send({
                    success: true,
                    total: uuids.length,
                    ownedCount: uuids.length,
                    queued: 0,
                    job: null
                });
            }

            const job = await deckImportService.createJob({
                userId: req.user.id,
                username: req.user.username,
                uuids: toImport
            });

            if (!job) {
                return res.send({
                    success: false,
                    message: 'Could not start the import. Please try again in a moment.'
                });
            }

            res.send({
                success: true,
                total: uuids.length,
                ownedCount: uuids.length - toImport.length,
                queued: toImport.length,
                job: mapImportJob(job)
            });
        })
    );

    // Progress for the import that is running, or the summary of the last one
    // that finished - a player who closed the modal mid-import needs to be able
    // to reopen it and find out what happened.
    server.get(
        '/api/decks/import/status',
        passport.authenticate('jwt', { session: false }),
        wrapAsync(async function (req, res) {
            const job =
                (await deckImportService.getActiveJob(req.user.id)) ||
                (await deckImportService.getLatestJob(req.user.id));

            res.send({ success: true, job: mapImportJob(job) });
        })
    );

    server.post(
        '/api/decks/import/cancel',
        passport.authenticate('jwt', { session: false }),
        wrapAsync(async function (req, res) {
            const cancelled = await deckImportService.cancelActive(req.user.id);

            res.send({ success: true, cancelled });
        })
    );

    // ARCHON: find a deck by name in the Master Vault catalog (see
    // docs/design/deck-catalog.md). This is the half of deck discovery that
    // works for players who do not use Decks of KeyForge at all - they know
    // their deck's name, not its uuid, and Master Vault has no way to look one
    // up. Results carry `owned` so the UI can grey out decks already imported.
    server.get(
        '/api/decks/catalog/search',
        passport.authenticate('jwt', { session: false }),
        catalogSearchLimit,
        wrapAsync(async function (req, res) {
            if (!catalogService.isSearchEnabled()) {
                return res.send({ success: false, message: 'Deck search is turned off.' });
            }

            const query = (req.query.q || '').trim();

            if (query.length < 2) {
                return res.send({ success: true, decks: [] });
            }

            const expansion = parseInt(req.query.expansion, 10);
            const limit = parseInt(req.query.limit, 10);

            const decks = await catalogService.search(query, {
                expansion: Number.isFinite(expansion) ? expansion : undefined,
                limit: Number.isFinite(limit) ? limit : undefined
            });

            // Nothing found is ambiguous on a server whose crawl has never been
            // switched on - which is the default - so say which kind of nothing
            // this is rather than letting the UI imply the deck might turn up
            // later. Only checked when there are no results, so the ordinary
            // path pays nothing for it.
            if (decks.length === 0) {
                return res.send({
                    success: true,
                    decks: [],
                    catalogEmpty: !(await catalogService.hasIndexedDecks())
                });
            }

            // One extra query rather than a join: the catalog lives in its own
            // table precisely so it never has to know about user-owned decks.
            const ownedUuids = new Set(await deckService.getOwnedDeckUuids(req.user.id));

            res.send({
                success: true,
                decks: decks.map((deck) => ({ ...deck, owned: ownedUuids.has(deck.uuid) }))
            });
        })
    );

    server.post(
        '/api/decks/alliance',
        passport.authenticate('jwt', { session: false }),
        wrapAsync(async function (req, res) {
            if (!req.body.name) {
                return res.send({ success: false, message: 'name must be specified' });
            }

            if (!req.body.pods) {
                return res.send({ success: false, message: 'pods must be specified' });
            }

            let deck = Object.assign(
                {},
                {
                    name: req.body.name,
                    uuid: randomUUID(),
                    username: req.user.username,
                    pods: req.body.pods,
                    tokenCard: req.body.token,
                    tokenSourceDeck: req.body.tokenSourceDeck,
                    prophecySourceDeck: req.body.prophecySourceDeck
                }
            );
            let savedDeck;

            try {
                savedDeck = await deckService.createAlliance(req.user, deck);
            } catch (error) {
                return res.send({
                    success: false,
                    message: error.message
                });
            }

            if (!savedDeck) {
                return res.send({
                    success: false,
                    message:
                        'An error occurred importing your deck.  Please check the Url or try again later.'
                });
            }

            res.send({ success: true, deck: savedDeck });
        })
    );

    server.delete(
        '/api/decks/:id',
        passport.authenticate('jwt', { session: false }),
        wrapAsync(async function (req, res) {
            let id = req.params.id;

            let deck = await deckService.getById(id);

            if (!deck) {
                return res.status(404).send({ success: false, message: 'No such deck' });
            }

            if (deck.username !== req.user.username) {
                return res.status(401).send({ message: 'Unauthorized' });
            }

            await deckService.delete(id);
            res.send({ success: true, message: 'Deck deleted successfully', deckId: id });
        })
    );

    server.post(
        '/api/decks/bulk-delete',
        passport.authenticate('jwt', { session: false }),
        wrapAsync(async function (req, res) {
            const deckIds = Array.isArray(req.body.deckIds)
                ? req.body.deckIds.map((id) => parseInt(id, 10)).filter((id) => !isNaN(id))
                : [];

            if (deckIds.length === 0) {
                return res.status(400).send({
                    success: false,
                    message: 'deckIds must be a non-empty array'
                });
            }

            const ownershipCheck = await deckService.checkDeckOwnershipForUser(
                req.user.id,
                deckIds
            );
            if (!ownershipCheck.allExist) {
                return res.status(404).send({ success: false, message: 'No such deck' });
            }

            if (!ownershipCheck.allOwned) {
                return res.status(401).send({ message: 'Unauthorized' });
            }

            await deckService.deleteMany(deckIds);

            res.send({
                success: true,
                message: 'Decks deleted successfully',
                deckIds: deckIds
            });
        })
    );

    server.post(
        '/api/decks/:id/verify',
        passport.authenticate('jwt', { session: false }),
        wrapAsync(async function (req, res) {
            if (!req.user.permissions || !req.user.permissions.canVerifyDecks) {
                return res.status(403).send({ success: false, message: 'Forbidden' });
            }

            let id = req.params.id;

            let deck = await deckService.getById(id);

            if (!deck) {
                return res.status(404).send({ success: false, message: 'No such deck' });
            }

            deck.verified = true;
            deck.id = id;

            await deckService.update(deck);
            res.send({ success: true, message: 'Deck verified successfully', deckId: id });
        })
    );

    server.post(
        '/api/decks/:id/refresh-accolades',
        passport.authenticate('jwt', { session: false }),
        wrapAsync(async function (req, res) {
            let id = req.params.id;

            let deck = await deckService.getById(id);

            if (!deck) {
                return res.status(404).send({ success: false, message: 'No such deck' });
            }

            if (deck.username !== req.user.username) {
                return res.status(401).send({ message: 'Unauthorized' });
            }

            try {
                const accolades = await deckService.refreshAccolades(id, req.user);
                res.send({ success: true, accolades: accolades });
            } catch (error) {
                logger.error('Failed to refresh accolades', error);
                return res.send({
                    success: false,
                    message: error.message || 'Failed to refresh accolades'
                });
            }
        })
    );

    server.post(
        '/api/decks/:id/accolades/:accoladeId/shown',
        passport.authenticate('jwt', { session: false }),
        wrapAsync(async function (req, res) {
            let id = req.params.id;
            let accoladeId = req.params.accoladeId;
            let shown = req.body.shown === true;

            let deck = await deckService.getById(id);

            if (!deck) {
                return res.status(404).send({ success: false, message: 'No such deck' });
            }

            if (deck.username !== req.user.username) {
                return res.status(401).send({ message: 'Unauthorized' });
            }

            try {
                await deckService.updateAccoladeShown(id, accoladeId, shown, req.user);
                res.send({ success: true });
            } catch (error) {
                logger.error('Failed to update accolade shown status', error);
                return res.send({
                    success: false,
                    message: error.message || 'Failed to update accolade shown status'
                });
            }
        })
    );
};
