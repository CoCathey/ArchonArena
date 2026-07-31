const ModerationService = require('../../../server/services/ModerationService');

/**
 * ARCHON (N5): moderation.
 *
 * The properties worth pinning down are the ones that stop the toolkit from
 * becoming a liability: sanctions that cannot be explained, actions nobody
 * can audit, and moderators acting on each other.
 */
describe('ModerationService', function () {
    let service;
    let db;
    let settings;
    let notifications;
    let queryHandler;

    const MODERATOR = { id: 9, username: 'mod', permissions: { canModerateChat: true } };
    const ADMIN = { id: 8, username: 'admin', permissions: { isAdmin: true } };
    const PLAYER = { id: 5, username: 'player', permissions: {} };

    beforeEach(function () {
        settings = {};
        notifications = { notify: vi.fn() };
        queryHandler = () => [];

        db = {
            query: vi.fn().mockImplementation(async (sql, params = []) => queryHandler(sql, params))
        };

        service = new ModerationService(db, {
            settingsService: { getSection: () => settings },
            notificationService: notifications
        });
    });

    const insertedAction = () => {
        const call = db.query.mock.calls.find(([sql]) =>
            sql.includes('INSERT INTO "ModerationActions"')
        );

        return call && call[1];
    };

    const auditEntries = () =>
        db.query.mock.calls
            .filter(([sql]) => sql.includes('INSERT INTO "ModerationAuditLog"'))
            .map(([, params]) => ({ actor: params[1], action: params[2], targetName: params[5] }));

    describe('permission', function () {
        it('lets a chat moderator in', function () {
            expect(service.canModerate(MODERATOR)).toBe(true);
        });

        it('lets an admin in', function () {
            expect(service.canModerate(ADMIN)).toBe(true);
        });

        it('keeps an ordinary player out', function () {
            expect(service.canModerate(PLAYER)).toBe(false);
            expect(service.canModerate(null)).toBe(false);
        });

        it('refuses every moderator-only operation to a player', async function () {
            expect((await service.getQueue(PLAYER)).success).toBe(false);
            expect((await service.claim(1, PLAYER)).success).toBe(false);
            expect((await service.resolve(1, PLAYER, { resolution: 'x' })).success).toBe(false);
            expect((await service.act(PLAYER, { action: 'ban' })).success).toBe(false);
            expect((await service.revoke(1, PLAYER)).success).toBe(false);
            expect((await service.getAuditLog(PLAYER)).success).toBe(false);
        });
    });

    describe('filing a report', function () {
        beforeEach(function () {
            queryHandler = (sql) => {
                if (sql.includes('FROM "Users" WHERE lower("Username")')) {
                    return [{ Id: 7, Username: 'target' }];
                }

                if (sql.includes('INSERT INTO "Reports"')) {
                    return [{ Id: 42 }];
                }

                return [];
            };
        });

        it('files a player report by username', async function () {
            const result = await service.report(5, {
                targetType: 'player',
                targetUsername: 'target',
                reason: 'harassment',
                details: 'They followed me between games saying the same thing.'
            });

            expect(result).toMatchObject({ success: true, id: 42 });
        });

        it('rejects an unknown target type', async function () {
            const result = await service.report(5, {
                targetType: 'spaceship',
                reason: 'spam',
                details: 'Something happened here.'
            });

            expect(result.success).toBe(false);
        });

        it('rejects an unknown reason', async function () {
            const result = await service.report(5, {
                targetType: 'player',
                targetUsername: 'target',
                reason: 'vibes',
                details: 'Something happened here.'
            });

            expect(result.success).toBe(false);
        });

        // Empty reports are the bulk of a queue's noise.
        it('requires the reporter to describe what happened', async function () {
            const result = await service.report(5, {
                targetType: 'player',
                targetUsername: 'target',
                reason: 'spam',
                details: 'bad'
            });

            expect(result.success).toBe(false);
            expect(result.message).toMatch(/at least 10 characters/i);
        });

        it('honours a configured minimum length', async function () {
            settings = { minDetailLength: 40 };

            const result = await service.report(5, {
                targetType: 'player',
                targetUsername: 'target',
                reason: 'spam',
                details: 'Twenty characters ok'
            });

            expect(result.success).toBe(false);
            expect(result.message).toMatch(/at least 40/i);
        });

        it('refuses a report about yourself', async function () {
            queryHandler = (sql) => {
                if (sql.includes('FROM "Users" WHERE lower("Username")')) {
                    return [{ Id: 5, Username: 'me' }];
                }

                return [];
            };

            const result = await service.report(5, {
                targetType: 'player',
                targetUsername: 'me',
                reason: 'spam',
                details: 'I am reporting myself for science.'
            });

            expect(result.success).toBe(false);
            expect(result.message).toMatch(/yourself/i);
        });

        it('refuses a report about something that no longer exists', async function () {
            queryHandler = () => [];

            const result = await service.report(5, {
                targetType: 'deck',
                targetId: 1,
                reason: 'inappropriate-name',
                details: 'The deck name is a slur.'
            });

            expect(result.success).toBe(false);
            expect(result.message).toMatch(/no longer exists/i);
        });

        it('refuses a second open report of the same thing', async function () {
            queryHandler = (sql) => {
                if (sql.includes('FROM "Users" WHERE lower("Username")')) {
                    return [{ Id: 7, Username: 'target' }];
                }

                if (sql.startsWith('SELECT "Id" FROM "Reports"')) {
                    return [{ Id: 1 }];
                }

                return [];
            };

            const result = await service.report(5, {
                targetType: 'player',
                targetUsername: 'target',
                reason: 'spam',
                details: 'Saying the same thing again here.'
            });

            expect(result.success).toBe(false);
            expect(result.message).toMatch(/already reported/i);
        });

        /**
         * Players carry no TargetId - they are addressed by name - so keying
         * the duplicate check on TargetId alone would make every player report
         * a duplicate of the first, and a player who reported one person could
         * never report another.
         */
        it('keys the duplicate check on the reported account, not just the row id', async function () {
            await service.report(5, {
                targetType: 'player',
                targetUsername: 'target',
                reason: 'spam',
                details: 'Describing the problem at length.'
            });

            const check = db.query.mock.calls.find(([sql]) =>
                sql.startsWith('SELECT "Id" FROM "Reports"')
            );

            expect(check[0]).toContain('"TargetUserId" IS NOT DISTINCT FROM');
            expect(check[1]).toContain(7);
        });
    });

    describe('capturing evidence', function () {
        // Deleting the message is the first thing a bad actor does.
        it('snapshots the reported message text', async function () {
            queryHandler = (sql) => {
                if (sql.includes('FROM "Messages"')) {
                    return [
                        {
                            Id: 3,
                            Text: 'something abusive',
                            PostedTime: '2026-07-01',
                            PosterId: 7,
                            Username: 'target'
                        }
                    ];
                }

                return [];
            };

            const captured = await service.captureContext('message', 3);

            expect(captured.context.text).toBe('something abusive');
            expect(captured.targetUserId).toBe(7);
        });

        it('makes a deck report a report about its owner', async function () {
            queryHandler = (sql) =>
                sql.includes('FROM "Decks"')
                    ? [{ Id: 4, Name: 'Bad Name', UserId: 7, Username: 'target' }]
                    : [];

            const captured = await service.captureContext('deck', 4);

            expect(captured.context.name).toBe('Bad Name');
            expect(captured.targetUserId).toBe(7);
        });

        // A disagreement is not an accusation against either player.
        it('names nobody as the subject of an in-person dispute', async function () {
            queryHandler = (sql) => {
                if (sql.includes('FROM "InPersonGames"')) {
                    return [
                        {
                            Id: 2,
                            Status: 'disputed',
                            Player1Id: 1,
                            Player2Id: 2,
                            Player1Name: 'a',
                            Player2Name: 'b'
                        }
                    ];
                }

                if (sql.includes('FROM "InPersonGameReports"')) {
                    return [
                        { ReporterId: 1, WinnerId: 1, Player1Keys: 3, Player2Keys: 1 },
                        { ReporterId: 2, WinnerId: 2, Player1Keys: 1, Player2Keys: 3 }
                    ];
                }

                return [];
            };

            const captured = await service.captureContext('inPersonGame', 2);

            expect(captured.targetUserId).toBeNull();
            // Both accounts of the game, which is the whole reason a moderator
            // was called in.
            expect(captured.context.reports).toHaveLength(2);
        });
    });

    describe('the queue', function () {
        it('claims a report only while it is still open', async function () {
            queryHandler = (sql) => (sql.includes('UPDATE "Reports"') ? [] : []);

            const result = await service.claim(1, MODERATOR);

            expect(result.success).toBe(false);
            expect(result.message).toMatch(/already been claimed/i);
        });

        it('records the claim in the audit log', async function () {
            queryHandler = (sql) => (sql.includes('UPDATE "Reports"') ? [{ Id: 1 }] : []);

            await service.claim(1, MODERATOR);

            expect(auditEntries().map((entry) => entry.action)).toContain('report.claim');
        });

        // A closed report with no reasoning is indistinguishable from one that
        // was ignored.
        it('will not resolve a report without saying how', async function () {
            const result = await service.resolve(1, MODERATOR, { resolution: '   ' });

            expect(result.success).toBe(false);
            expect(result.message).toMatch(/how the report was resolved/i);
        });

        it('tells the reporter their report was reviewed', async function () {
            queryHandler = (sql) =>
                sql.includes('UPDATE "Reports"') ? [{ TargetUserId: 7, ReporterId: 5 }] : [];

            await service.resolve(1, MODERATOR, { resolution: 'Warned them.' });

            expect(notifications.notify).toHaveBeenCalledWith(
                expect.objectContaining({ userId: 5, category: 'moderation.update' })
            );
        });

        it('never tells the reporter what was done to the other account', async function () {
            queryHandler = (sql) =>
                sql.includes('UPDATE "Reports"') ? [{ TargetUserId: 7, ReporterId: 5 }] : [];

            await service.resolve(1, MODERATOR, { resolution: 'Banned for three days.' });

            const [call] = notifications.notify.mock.calls[0];

            expect(JSON.stringify(call)).not.toMatch(/banned/i);
        });
    });

    describe('graduated actions', function () {
        beforeEach(function () {
            queryHandler = (sql) => {
                if (sql.includes('SELECT "Id", "Username", "Disabled" FROM "Users"')) {
                    return [{ Id: 7, Username: 'target', Disabled: false }];
                }

                if (sql.includes('INSERT INTO "ModerationActions"')) {
                    return [{ Id: 11 }];
                }

                return [];
            };
        });

        it('rejects an unknown action', async function () {
            const result = await service.act(MODERATOR, {
                targetUserId: 7,
                action: 'defenestrate',
                reason: 'x'
            });

            expect(result.success).toBe(false);
        });

        // Without one, the player cannot be told why, and the audit log
        // records a decision nobody can review.
        it('requires a reason for every action', async function () {
            const result = await service.act(MODERATOR, {
                targetUserId: 7,
                action: 'warn',
                reason: '   '
            });

            expect(result.success).toBe(false);
            expect(result.message).toMatch(/needs a reason/i);
        });

        it('gives a mute the configured default duration', async function () {
            settings = { defaultMuteHours: 12 };

            const result = await service.act(MODERATOR, {
                targetUserId: 7,
                action: 'mute',
                reason: 'Abusive in lobby chat'
            });

            expect(result.success).toBe(true);

            const hours = (new Date(result.expiresAt) - Date.now()) / 3600000;

            expect(Math.round(hours)).toBe(12);
        });

        it('lets a moderator set the duration explicitly', async function () {
            const result = await service.act(MODERATOR, {
                targetUserId: 7,
                action: 'timeout',
                reason: 'Repeated dodging',
                hours: 6
            });

            expect(Math.round((new Date(result.expiresAt) - Date.now()) / 3600000)).toBe(6);
        });

        it('allows an indefinite restriction when asked for deliberately', async function () {
            const result = await service.act(MODERATOR, {
                targetUserId: 7,
                action: 'mute',
                reason: 'Persistent',
                indefinite: true
            });

            expect(result.expiresAt).toBeNull();
        });

        it('makes a ban indefinite unless a duration is given', async function () {
            const result = await service.act(MODERATOR, {
                targetUserId: 7,
                action: 'ban',
                reason: 'Cheating'
            });

            expect(result.expiresAt).toBeNull();
        });

        it('rejects a nonsensical duration', async function () {
            expect(
                (
                    await service.act(MODERATOR, {
                        targetUserId: 7,
                        action: 'mute',
                        reason: 'x',
                        hours: -1
                    })
                ).success
            ).toBe(false);
        });

        // The login path checks Disabled and knows nothing about the actions
        // table, so a ban has to set it.
        it('disables the account on a ban', async function () {
            await service.act(MODERATOR, { targetUserId: 7, action: 'ban', reason: 'Cheating' });

            expect(
                db.query.mock.calls.some(
                    ([sql]) => sql.includes('UPDATE "Users"') && sql.includes('"Disabled" = true')
                )
            ).toBe(true);
        });

        it('does not disable the account for a mute', async function () {
            await service.act(MODERATOR, { targetUserId: 7, action: 'mute', reason: 'Rude' });

            expect(db.query.mock.calls.some(([sql]) => sql.includes('"Disabled" = true'))).toBe(
                false
            );
        });

        it('tells the player what happened and until when', async function () {
            const result = await service.act(MODERATOR, {
                targetUserId: 7,
                action: 'mute',
                reason: 'Rude',
                hours: 24
            });

            expect(notifications.notify).toHaveBeenCalledWith(
                expect.objectContaining({
                    userId: 7,
                    category: 'moderation.action',
                    title: expect.stringMatching(/muted until/i)
                })
            );
            expect(result.expiresAt).toBeTruthy();
        });

        it('says nothing to the player for an internal note', async function () {
            await service.act(MODERATOR, {
                targetUserId: 7,
                action: 'note',
                reason: 'Watch this account'
            });

            expect(notifications.notify).not.toHaveBeenCalled();
        });

        it('refuses to let a moderator act on themselves', async function () {
            queryHandler = (sql) =>
                sql.includes('SELECT "Id", "Username", "Disabled" FROM "Users"')
                    ? [{ Id: 9, Username: 'mod', Disabled: false }]
                    : [];

            const result = await service.act(MODERATOR, {
                targetUserId: 9,
                action: 'ban',
                reason: 'x'
            });

            expect(result.success).toBe(false);
            expect(result.message).toMatch(/yourself/i);
        });

        /** A moderator who can be sanctioned by a peer is a moderation war. */
        it('will not let one moderator sanction another', async function () {
            queryHandler = (sql) => {
                if (sql.includes('SELECT "Id", "Username", "Disabled" FROM "Users"')) {
                    return [{ Id: 7, Username: 'othermod', Disabled: false }];
                }

                if (sql.includes('FROM "UserRoles"')) {
                    return [{ exists: 1 }];
                }

                return [];
            };

            const result = await service.act(MODERATOR, {
                targetUserId: 7,
                action: 'mute',
                reason: 'Disagreed with me'
            });

            expect(result.success).toBe(false);
            expect(result.message).toMatch(/only an admin/i);
        });

        it('but an admin can', async function () {
            queryHandler = (sql) => {
                if (sql.includes('SELECT "Id", "Username", "Disabled" FROM "Users"')) {
                    return [{ Id: 7, Username: 'othermod', Disabled: false }];
                }

                if (sql.includes('FROM "UserRoles"')) {
                    return [{ exists: 1 }];
                }

                if (sql.includes('INSERT INTO "ModerationActions"')) {
                    return [{ Id: 11 }];
                }

                return [];
            };

            const result = await service.act(ADMIN, {
                targetUserId: 7,
                action: 'mute',
                reason: 'Abusing the tools'
            });

            expect(result.success).toBe(true);
        });

        it('writes every action to the audit log with the actor by name', async function () {
            await service.act(MODERATOR, { targetUserId: 7, action: 'warn', reason: 'Rude' });

            expect(auditEntries()).toContainEqual({
                actor: 'mod',
                action: 'moderation.warn',
                targetName: 'target'
            });
        });

        it('links the action back to the report it came from', async function () {
            await service.act(MODERATOR, {
                targetUserId: 7,
                action: 'warn',
                reason: 'Rude',
                reportId: 42
            });

            expect(insertedAction()[5]).toBe(42);
        });
    });

    describe('revoking', function () {
        it('re-enables the account when a ban is lifted', async function () {
            queryHandler = (sql) =>
                sql.includes('UPDATE "ModerationActions"')
                    ? [{ TargetUserId: 7, Action: 'ban' }]
                    : [];

            const result = await service.revoke(11, MODERATOR, 'Appeal upheld');

            expect(result.success).toBe(true);
            // Otherwise the row says revoked while the player still cannot
            // log in.
            expect(
                db.query.mock.calls.some(
                    ([sql]) => sql.includes('UPDATE "Users"') && sql.includes('"Disabled" = false')
                )
            ).toBe(true);
        });

        // Revoking is a timestamp, not a delete: the history should show that
        // a mute happened and was lifted, not that it never existed.
        it('marks the action revoked rather than deleting it', async function () {
            queryHandler = (sql) =>
                sql.includes('UPDATE "ModerationActions"')
                    ? [{ TargetUserId: 7, Action: 'mute' }]
                    : [];

            await service.revoke(11, MODERATOR, 'Mistake');

            expect(
                db.query.mock.calls.some(([sql]) => sql.includes('DELETE FROM "ModerationActions"'))
            ).toBe(false);
        });

        it('refuses to revoke twice', async function () {
            queryHandler = () => [];

            const result = await service.revoke(11, MODERATOR, 'again');

            expect(result.success).toBe(false);
        });
    });

    describe('enforcement', function () {
        const activeRestrictions = (rows) => {
            queryHandler = (sql) =>
                sql.includes('FROM "ModerationActions"') && sql.includes('"RevokedAt" IS NULL')
                    ? rows
                    : [];
        };

        it('allows everything when there are no restrictions', async function () {
            activeRestrictions([]);

            expect((await service.checkRestriction(7, 'chat')).allowed).toBe(true);
            expect((await service.checkRestriction(7, 'play')).allowed).toBe(true);
        });

        it('blocks chat for a muted player, with a reason and an expiry', async function () {
            const expires = new Date(Date.now() + 3600000);

            activeRestrictions([{ Id: 1, Action: 'mute', Reason: 'Abusive', ExpiresAt: expires }]);

            const check = await service.checkRestriction(7, 'chat');

            expect(check.allowed).toBe(false);
            expect(check.reason).toBe('Abusive');
            expect(check.expiresAt).toBe(expires);
            expect(check.message).toMatch(/muted until/i);
        });

        it('leaves a muted player able to play', async function () {
            activeRestrictions([{ Id: 1, Action: 'mute', Reason: 'Abusive', ExpiresAt: null }]);

            expect((await service.checkRestriction(7, 'play')).allowed).toBe(true);
        });

        /**
         * Being unable to play while still free to talk is not the sanction a
         * moderator picked when they chose a timeout.
         */
        it('takes chat away from a timed-out player too', async function () {
            activeRestrictions([{ Id: 1, Action: 'timeout', Reason: 'Dodging', ExpiresAt: null }]);

            expect((await service.checkRestriction(7, 'play')).allowed).toBe(false);
            expect((await service.checkRestriction(7, 'chat')).allowed).toBe(false);
        });

        it('blocks everything for a banned player', async function () {
            activeRestrictions([{ Id: 1, Action: 'ban', Reason: 'Cheating', ExpiresAt: null }]);

            expect((await service.checkRestriction(7, 'chat')).allowed).toBe(false);
            expect((await service.checkRestriction(7, 'play')).allowed).toBe(false);
        });

        it('asks the database only for live, unrevoked restrictions', async function () {
            activeRestrictions([]);

            await service.getActiveRestrictions(7);

            const [sql] = db.query.mock.calls[0];

            expect(sql).toContain('"RevokedAt" IS NULL');
            expect(sql).toContain('"ExpiresAt" IS NULL OR "ExpiresAt" >');
        });

        it('treats a signed-out viewer as unrestricted rather than querying', async function () {
            expect(await service.getActiveRestrictions(null)).toEqual([]);
            expect(db.query).not.toHaveBeenCalled();
        });
    });

    describe('the audit log', function () {
        // A moderator who saw an error would very reasonably do the action
        // again, so a logging failure must never surface as a failed action.
        it('never throws when the write fails', async function () {
            db.query.mockRejectedValue(new Error('disk full'));

            await expect(service.audit(MODERATOR, 'moderation.warn', {})).resolves.toBeUndefined();
        });

        it('keeps the actor name so the trail survives account deletion', async function () {
            await service.audit(MODERATOR, 'moderation.warn', { targetName: 'target' });

            const call = db.query.mock.calls.find(([sql]) =>
                sql.includes('INSERT INTO "ModerationAuditLog"')
            );

            expect(call[1][0]).toBe(9);
            expect(call[1][1]).toBe('mod');
        });
    });

    describe('queue health', function () {
        it('reports null rather than zero when nothing has been resolved', async function () {
            queryHandler = (sql) =>
                sql.includes('FROM "Reports"')
                    ? [{ Open: '3', Claimed: '1', Closed: '0', AvgHours: null, OldestOpen: null }]
                    : [];

            const stats = await service.getStats(30);

            // "0 hours to resolve" would read as excellent when it means never.
            expect(stats.averageResolutionHours).toBeNull();
            expect(stats.open).toBe(3);
        });

        it('counts actions by kind', async function () {
            queryHandler = (sql) => {
                if (sql.includes('FROM "Reports"')) {
                    return [
                        { Open: '0', Claimed: '0', Closed: '2', AvgHours: 5, OldestOpen: null }
                    ];
                }

                if (sql.includes('FROM "ModerationActions"')) {
                    return [
                        { Action: 'warn', Count: '4' },
                        { Action: 'mute', Count: '1' }
                    ];
                }

                return [];
            };

            const stats = await service.getStats(30);

            expect(stats.actions).toEqual({ warn: 4, mute: 1 });
            expect(stats.averageResolutionHours).toBe(5);
        });
    });
});
