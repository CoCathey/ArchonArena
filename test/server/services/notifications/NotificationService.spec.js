const NotificationService = require('../../../../server/services/notifications/NotificationService');
const {
    categoryDefaults,
    isKnownCategory
} = require('../../../../server/services/notifications/taxonomy');

describe('NotificationService', function () {
    let db;
    let emailService;
    let service;

    beforeEach(function () {
        db = { query: vi.fn().mockResolvedValue([]) };
        emailService = {
            isConfigured: vi.fn().mockReturnValue(true),
            sendEmail: vi.fn().mockResolvedValue(true)
        };
        service = new NotificationService(db, { emailService, siteUrl: 'https://example.test' });
    });

    const pairingEvent = (overrides = {}) => ({
        userId: 7,
        category: 'tournament.pairing',
        title: 'Round 2 pairing',
        body: 'You are playing bob.',
        url: '/tournaments/3',
        ...overrides
    });

    describe('delivery', function () {
        it('records the notification and mails it when both are on', async function () {
            db.query
                .mockResolvedValueOnce([]) // no stored preference -> defaults
                .mockResolvedValueOnce([{ Id: 99 }]) // insert
                .mockResolvedValueOnce([{ Email: 'p@example.test', Username: 'alice' }])
                .mockResolvedValueOnce([]); // EmailedAt stamp

            const result = await service.notify(pairingEvent());

            expect(result).toEqual(
                expect.objectContaining({ delivered: true, notificationId: 99, emailed: true })
            );
            expect(emailService.sendEmail).toHaveBeenCalledTimes(1);
        });

        it('links absolutely in email so a background-raised notification is clickable', async function () {
            db.query
                .mockResolvedValueOnce([])
                .mockResolvedValueOnce([{ Id: 1 }])
                .mockResolvedValueOnce([{ Email: 'p@example.test', Username: 'alice' }])
                .mockResolvedValueOnce([]);

            await service.notify(pairingEvent());

            const [, , text, html] = emailService.sendEmail.mock.calls[0];
            expect(text).toContain('https://example.test/tournaments/3');
            expect(html).toContain('https://example.test/tournaments/3');
        });

        it('sends both a plain-text and an HTML body', async function () {
            db.query
                .mockResolvedValueOnce([])
                .mockResolvedValueOnce([{ Id: 1 }])
                .mockResolvedValueOnce([{ Email: 'p@example.test', Username: 'alice' }])
                .mockResolvedValueOnce([]);

            await service.notify(pairingEvent());

            const [, subject, text, html] = emailService.sendEmail.mock.calls[0];
            expect(subject).toContain('Round 2 pairing');
            expect(text).not.toContain('<');
            expect(html).toContain('<!doctype html>');
        });

        it('ignores an incomplete event rather than writing a blank notification', async function () {
            expect(await service.notify({ userId: 1 })).toEqual({
                delivered: false,
                reason: 'incomplete'
            });
            expect(await service.notify(null)).toEqual({ delivered: false, reason: 'incomplete' });
            expect(db.query).not.toHaveBeenCalled();
        });
    });

    describe('opt-out', function () {
        it('honours a stored opt-out for both channels', async function () {
            db.query.mockResolvedValueOnce([{ InApp: false, Email: false }]);

            const result = await service.notify(pairingEvent());

            expect(result).toEqual({ delivered: false, reason: 'opted-out' });
            expect(emailService.sendEmail).not.toHaveBeenCalled();
            // Only the preference read; nothing was written.
            expect(db.query).toHaveBeenCalledTimes(1);
        });

        it('still shows in-app when only email is off', async function () {
            db.query
                .mockResolvedValueOnce([{ InApp: true, Email: false }])
                .mockResolvedValueOnce([{ Id: 12 }]);

            const result = await service.notify(pairingEvent());

            expect(result.delivered).toBe(true);
            expect(emailService.sendEmail).not.toHaveBeenCalled();
        });

        it('still emails when only in-app is off', async function () {
            db.query
                .mockResolvedValueOnce([{ InApp: false, Email: true }])
                .mockResolvedValueOnce([{ Email: 'p@example.test', Username: 'alice' }]);

            const result = await service.notify(pairingEvent());

            expect(result.delivered).toBe(true);
            expect(result.notificationId).toBeNull();
            expect(emailService.sendEmail).toHaveBeenCalledTimes(1);
        });

        it('applies the category default when nothing is stored', async function () {
            // friend.accepted is pleasant but never urgent, so it does not mail.
            expect(categoryDefaults('friend.accepted')).toEqual({
                inApp: true,
                email: false,
                push: false
            });

            db.query.mockResolvedValueOnce([]).mockResolvedValueOnce([{ Id: 5 }]);

            await service.notify(pairingEvent({ category: 'friend.accepted' }));

            expect(emailService.sendEmail).not.toHaveBeenCalled();
        });

        it('rejects a preference for a category that does not exist', async function () {
            const result = await service.setPreference(1, 'not.a.category', { inApp: false });

            expect(result.success).toBe(false);
            expect(db.query).not.toHaveBeenCalled();
        });
    });

    describe('failure containment', function () {
        // The load-bearing property: pairing a round must never fail because a
        // notification could not be written or an email could not be sent.
        it('never throws when the database is down', async function () {
            db.query.mockRejectedValue(new Error('connection refused'));

            const result = await service.notify(pairingEvent());

            expect(result).toEqual({ delivered: false, error: true });
        });

        it('never throws when SES rejects the send', async function () {
            db.query
                .mockResolvedValueOnce([])
                .mockResolvedValueOnce([{ Id: 3 }])
                .mockResolvedValueOnce([{ Email: 'p@example.test', Username: 'alice' }]);
            emailService.sendEmail.mockRejectedValue(new Error('SES down'));

            expect(await service.notify(pairingEvent())).toEqual({
                delivered: false,
                error: true
            });
        });

        it('degrades to in-app only when no sender is configured', async function () {
            emailService.isConfigured.mockReturnValue(false);
            db.query.mockResolvedValueOnce([]).mockResolvedValueOnce([{ Id: 8 }]);

            const result = await service.notify(pairingEvent());

            expect(result.delivered).toBe(true);
            expect(result.emailed).toBe(false);
            expect(emailService.sendEmail).not.toHaveBeenCalled();
        });

        it('does not mail an account with no address', async function () {
            db.query
                .mockResolvedValueOnce([])
                .mockResolvedValueOnce([{ Id: 4 }])
                .mockResolvedValueOnce([{ Email: null, Username: 'alice' }]);

            const result = await service.notify(pairingEvent());

            expect(result.delivered).toBe(true);
            expect(result.emailed).toBe(false);
        });
    });

    describe('idempotency', function () {
        it('is a no-op when the dedupe key already exists', async function () {
            // The pairing hook fires more than once per round; a player must
            // get one notification, not one per fire.
            db.query
                .mockResolvedValueOnce([]) // preference
                .mockResolvedValueOnce([]); // insert hit ON CONFLICT DO NOTHING

            const result = await service.notify(pairingEvent({ dedupeKey: 'pairing:3:2' }));

            expect(result).toEqual({ delivered: false, reason: 'duplicate' });
            // Crucially the email is skipped too - the first delivery sent it.
            expect(emailService.sendEmail).not.toHaveBeenCalled();
        });

        it('scopes the conflict target to the partial index', async function () {
            db.query.mockResolvedValueOnce([]).mockResolvedValueOnce([{ Id: 1 }]);

            await service.notify(pairingEvent({ dedupeKey: 'pairing:3:2' }));

            const [sql] = db.query.mock.calls[1];
            expect(sql).toContain('ON CONFLICT ("UserId", "DedupeKey")');
            expect(sql).toContain('WHERE "DedupeKey" IS NOT NULL');
        });
    });

    describe('reading', function () {
        it('scopes mark-read to the caller, so someone else id is a no-op', async function () {
            db.query.mockResolvedValueOnce([{ Id: 1 }]);

            await service.markRead(7, [1, 2]);

            const [sql, params] = db.query.mock.calls[0];
            expect(sql).toContain('"UserId" = $1');
            expect(params[0]).toBe(7);
        });

        it('ignores non-numeric ids without falling through to mark-all', async function () {
            // The dangerous bug: junk ids emptying the whole unread list.
            const result = await service.markRead(7, ['nonsense']);

            expect(result).toEqual({ success: true, updated: 0 });
            expect(db.query).not.toHaveBeenCalled();
        });

        it('marks everything read when no ids are given', async function () {
            db.query.mockResolvedValueOnce([{ Id: 1 }, { Id: 2 }]);

            expect(await service.markRead(7)).toEqual({ success: true, updated: 2 });
            expect(db.query.mock.calls[0][0]).not.toContain('= ANY');
        });

        it('caps the page size however large a limit is asked for', async function () {
            await service.list(7, { limit: 99999 });

            expect(db.query.mock.calls[0][0]).toContain('LIMIT 100');
        });
    });

    describe('preferences', function () {
        it('reports every category with the effective setting', async function () {
            db.query.mockResolvedValueOnce([
                { Category: 'tournament.pairing', InApp: true, Email: false }
            ]);

            const preferences = await service.getPreferences(7);
            const pairing = preferences.find((entry) => entry.category === 'tournament.pairing');

            expect(pairing.email).toBe(false);
            // Categories with nothing stored still appear, at their defaults.
            expect(preferences.length).toBeGreaterThan(1);
            expect(preferences.every((entry) => isKnownCategory(entry.category))).toBe(true);
        });
    });
});

describe('NotificationService push channel', function () {
    let db;
    let pushService;
    let service;

    beforeEach(function () {
        db = { query: vi.fn().mockResolvedValue([]) };
        pushService = { send: vi.fn().mockResolvedValue({ sent: 1, failed: 0, removed: 0 }) };
        service = new NotificationService(db, { pushService });
    });

    const pairing = {
        userId: 7,
        category: 'tournament.pairing',
        title: 'Round 2 pairing',
        body: 'You are playing bob.',
        url: '/tournaments/3',
        data: { tournamentId: 3 }
    };

    it('pushes a pairing by default', async function () {
        db.query.mockResolvedValueOnce([]).mockResolvedValueOnce([{ Id: 1 }]);

        const result = await service.notify(pairing);

        expect(result.pushed).toBe(1);
        expect(pushService.send).toHaveBeenCalledWith(
            expect.objectContaining({
                userId: 7,
                title: 'Round 2 pairing',
                url: '/tournaments/3',
                category: 'tournament.pairing',
                data: { tournamentId: 3 }
            })
        );
    });

    it('does not push a category that is not worth interrupting for', async function () {
        db.query.mockResolvedValueOnce([]).mockResolvedValueOnce([{ Id: 1 }]);

        await service.notify({ ...pairing, category: 'friend.accepted' });

        expect(pushService.send).not.toHaveBeenCalled();
    });

    it('honours an explicit push opt-out', async function () {
        db.query
            .mockResolvedValueOnce([{ InApp: true, Email: true, Push: false }])
            .mockResolvedValueOnce([{ Id: 1 }]);

        await service.notify(pairing);

        expect(pushService.send).not.toHaveBeenCalled();
    });

    // The upgrade case: rows written before push existed carry Push = NULL.
    it('pushes for a pre-push row that left the category on', async function () {
        db.query
            .mockResolvedValueOnce([{ InApp: true, Email: false, Push: null }])
            .mockResolvedValueOnce([{ Id: 1 }]);

        await service.notify(pairing);

        expect(pushService.send).toHaveBeenCalledTimes(1);
    });

    it('stays silent for a pre-push row that had silenced the category', async function () {
        // They turned this category off before push existed. Buzzing their
        // phone because a new channel appeared is exactly what they said no to.
        db.query.mockResolvedValueOnce([{ InApp: false, Email: false, Push: null }]);

        const result = await service.notify(pairing);

        expect(result).toEqual({ delivered: false, reason: 'opted-out' });
        expect(pushService.send).not.toHaveBeenCalled();
    });

    it('delivers by push alone when both other channels are off', async function () {
        db.query.mockResolvedValueOnce([{ InApp: false, Email: false, Push: true }]);

        const result = await service.notify(pairing);

        expect(result.delivered).toBe(true);
        expect(result.notificationId).toBeNull();
        expect(pushService.send).toHaveBeenCalledTimes(1);
    });

    it('reports the push preference to the preferences page', async function () {
        db.query.mockResolvedValueOnce([
            { Category: 'tournament.pairing', InApp: true, Email: false, Push: null }
        ]);

        const preferences = await service.getPreferences(7);
        const pairingRow = preferences.find((row) => row.category === 'tournament.pairing');

        expect(pairingRow.push).toBe(true);
    });

    it('still delivers when there is no push service at all', async function () {
        const withoutPush = new NotificationService(db);
        db.query.mockResolvedValueOnce([]).mockResolvedValueOnce([{ Id: 1 }]);

        const result = await withoutPush.notify(pairing);

        expect(result.delivered).toBe(true);
        expect(result.pushed).toBe(0);
    });

    it('writes push alongside the other channels', async function () {
        await service.setPreference(7, 'tournament.pairing', {
            inApp: true,
            email: false,
            push: false
        });

        const [sql, params] = db.query.mock.calls[0];

        expect(sql).toContain('"Push" = $5');
        expect(params).toEqual([7, 'tournament.pairing', true, false, false]);
    });
});
