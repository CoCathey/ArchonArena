const DokLinkService = require('../../../../server/services/dok/DokLinkService');
const SecretBox = require('../../../../server/services/crypto/secretBox');

describe('DokLinkService', function () {
    let userService;
    let dokService;
    let deckService;
    let deckImportService;
    let service;

    const SITE_SECRET = 'a-site-secret';
    const sealed = (value) => new SecretBox(SITE_SECRET).encrypt(value);

    const configService = (dok = {}) => ({
        getValue: (key) => (key === 'secret' ? SITE_SECRET : key === 'dok' ? dok : undefined)
    });

    const user = { id: 7, username: 'player' };

    beforeEach(function () {
        userService = {
            getDokLink: vi.fn().mockResolvedValue(null),
            setDokLink: vi.fn().mockResolvedValue(),
            clearDokLink: vi.fn().mockResolvedValue(),
            markDokSynced: vi.fn().mockResolvedValue(),
            markDokKeyRejected: vi.fn().mockResolvedValue(),
            findDokAutoSyncDue: vi.fn().mockResolvedValue([])
        };
        dokService = { listMyDecks: vi.fn().mockResolvedValue({ configured: true, decks: [] }) };
        deckService = { getOwnedDeckUuids: vi.fn().mockResolvedValue([]) };
        deckImportService = { createJob: vi.fn().mockResolvedValue({ Id: 1 }) };

        service = new DokLinkService(configService(), {
            dokService,
            deckService,
            userService,
            deckImportService
        });
    });

    describe('storing a key', function () {
        it('seals the key before it reaches the database', async function () {
            expect(await service.rememberKey(7, 'my-dok-key', { autoSync: true })).toBe(true);

            const [, stored] = userService.setDokLink.mock.calls[0];

            expect(stored.sealedApiKey).not.toContain('my-dok-key');
            expect(stored.sealedApiKey.startsWith('v1.')).toBe(true);
            expect(stored.autoSync).toBe(true);
        });

        // Fail closed. A site with no secret must decline to keep credentials,
        // not keep them where anyone with the database can read them.
        it('refuses to store anything when there is no site secret to seal with', async function () {
            const noSecret = new DokLinkService(
                { getValue: () => undefined },
                { dokService, deckService, userService, deckImportService }
            );

            expect(await noSecret.rememberKey(7, 'my-dok-key')).toBe(false);
            expect(userService.setDokLink).not.toHaveBeenCalled();
        });

        // The key is a credential for somebody else's account; the UI is told
        // whether we hold one, never what it is.
        it('never reports the key itself in the link status', async function () {
            userService.getDokLink.mockResolvedValue({
                sealedApiKey: sealed('my-dok-key'),
                hasKey: true,
                autoSync: true,
                lastSyncAt: null,
                keyRejectedAt: null
            });

            const status = await service.getLinkStatus(7);

            expect(JSON.stringify(status)).not.toContain('my-dok-key');
            expect(status).toEqual({
                hasKey: true,
                autoSync: true,
                keyRejected: false,
                lastSyncAt: null
            });
        });
    });

    describe('syncing from a stored key', function () {
        const withStoredKey = (overrides = {}) =>
            userService.getDokLink.mockResolvedValue({
                sealedApiKey: sealed('my-dok-key'),
                hasKey: true,
                autoSync: true,
                lastSyncAt: null,
                keyRejectedAt: null,
                ...overrides
            });

        it('unseals the key and lists with it', async function () {
            withStoredKey();
            dokService.listMyDecks.mockResolvedValue({
                configured: true,
                decks: [{ uuid: 'a' }],
                skipped: 2
            });

            const result = await service.syncUser(user);

            expect(dokService.listMyDecks.mock.calls[0][0]).toBe('my-dok-key');
            expect(result.success).toBe(true);
            expect(result.queued).toBe(1);
            expect(deckImportService.createJob).toHaveBeenCalled();
        });

        it('says so rather than syncing when no key is stored', async function () {
            userService.getDokLink.mockResolvedValue({ sealedApiKey: null, hasKey: false });

            const result = await service.syncUser(user);

            expect(result.success).toBe(false);
            expect(dokService.listMyDecks).not.toHaveBeenCalled();
        });

        // Rotating the site secret makes stored keys unreadable. Asking for it
        // again is right; pretending we still have one is not.
        it('forgets a key it can no longer unseal', async function () {
            withStoredKey({ sealedApiKey: new SecretBox('a-different-secret').encrypt('x') });

            const result = await service.syncUser(user);

            expect(result.success).toBe(false);
            expect(userService.clearDokLink).toHaveBeenCalledWith(7);
            expect(dokService.listMyDecks).not.toHaveBeenCalled();
        });

        // DoK voids the old key whenever a new one is generated, so a refusal
        // is terminal: retrying it daily can never succeed and only burns the
        // rate limit discovering that.
        it('stops the schedule for good when DoK rejects the key', async function () {
            withStoredKey();
            dokService.listMyDecks.mockResolvedValue({
                configured: true,
                error: true,
                errorCode: 'key_rejected',
                errorDetail: 'HTTP 401 (API key rejected)',
                decks: []
            });

            const result = await service.syncUser(user);

            expect(result.keyRejected).toBe(true);
            expect(userService.markDokKeyRejected).toHaveBeenCalledWith(7);
            expect(userService.markDokSynced).not.toHaveBeenCalled();
        });

        // A bad minute at DoK is not a bad key: the schedule must survive it.
        it('leaves the key alone when DoK merely failed', async function () {
            withStoredKey();
            dokService.listMyDecks.mockResolvedValue({
                configured: true,
                error: true,
                errorCode: 'upstream_error',
                errorDetail: 'HTTP 500',
                decks: []
            });

            const result = await service.syncUser(user);

            expect(result.success).toBe(false);
            expect(result.keyRejected).toBeUndefined();
            expect(userService.markDokKeyRejected).not.toHaveBeenCalled();
        });

        // Otherwise an already-current collection is re-listed on every sweep.
        it('stamps the sync clock even when nothing was new', async function () {
            withStoredKey();
            dokService.listMyDecks.mockResolvedValue({
                configured: true,
                decks: [],
                skipped: 40
            });

            const result = await service.syncUser(user);

            expect(result.success).toBe(true);
            expect(result.queued).toBe(0);
            expect(userService.markDokSynced).toHaveBeenCalledWith(7);
            expect(deckImportService.createJob).not.toHaveBeenCalled();
        });
    });

    describe('the automatic sweep', function () {
        it('syncs the players it is given and reports what it queued', async function () {
            userService.findDokAutoSyncDue.mockResolvedValue([
                { id: 7, username: 'player', sealedApiKey: sealed('k') }
            ]);
            userService.getDokLink.mockResolvedValue({
                sealedApiKey: sealed('k'),
                hasKey: true
            });
            dokService.listMyDecks.mockResolvedValue({ configured: true, decks: [{ uuid: 'a' }] });

            expect(await service.syncDue()).toEqual({ synced: 1, queued: 1 });
        });

        it('asks only for collections older than the interval, newest last', async function () {
            await service.syncDue({ limit: 5 });

            const [olderThan, limit] = userService.findDokAutoSyncDue.mock.calls[0];

            expect(limit).toBe(5);
            expect(Date.now() - olderThan.getTime()).toBeGreaterThanOrEqual(23 * 60 * 60 * 1000);
        });

        it('never throws when the lookup fails', async function () {
            userService.findDokAutoSyncDue.mockRejectedValue(new Error('db down'));

            await expect(service.syncDue()).resolves.toEqual({ synced: 0, queued: 0 });
        });
    });
});
