const InPersonGameService = require('../../../server/services/InPersonGameService');

/**
 * ARCHON (N13): in-person games.
 *
 * The tests that matter here are all about trust. A paper game is witnessed
 * by two people who may disagree, so the properties worth pinning down are
 * the ones that stop one person's word from becoming a result.
 */
describe('InPersonGameService', function () {
    let service;
    let db;
    let client;
    let gameRow;
    let reports;
    let settings;
    let ratingService;
    let notifications;

    const REPORT = {
        winnerId: 1,
        player1Keys: 3,
        player2Keys: 1,
        player1DeckId: 10,
        player2DeckId: 20
    };

    beforeEach(function () {
        gameRow = {
            Id: 5,
            CreatedById: 1,
            Player1Id: 1,
            Player2Id: 2,
            ClubId: null,
            GameFormat: 'archon',
            Status: 'pending',
            PlayedAt: new Date('2026-07-01T00:00:00Z')
        };
        reports = [];
        settings = { rated: true };
        client = { release: vi.fn() };
        ratingService = { processGame: vi.fn().mockResolvedValue(undefined) };
        notifications = { notify: vi.fn() };

        // `reports` models the rows actually in the table: the pre-check that
        // stops a double report and the read that settles the game are
        // different queries against it, so the mock has to tell them apart or
        // the "already reported" guard swallows every second report.
        db = {
            query: vi.fn().mockImplementation(async (sql, params = []) => {
                if (sql.includes('FROM "InPersonGames"')) {
                    return [gameRow];
                }

                if (sql.startsWith('SELECT 1 FROM "InPersonGameReports"')) {
                    return reports.filter((report) => report.ReporterId === params[1]);
                }

                if (sql.includes('INSERT INTO "InPersonGameReports"')) {
                    reports.push({
                        ReporterId: params[1],
                        WinnerId: params[2],
                        Player1Keys: params[3],
                        Player2Keys: params[4],
                        Player1DeckId: params[5],
                        Player2DeckId: params[6]
                    });

                    return [];
                }

                if (sql.includes('FROM "InPersonGameReports"')) {
                    return reports;
                }

                if (sql.includes('FROM "Decks"')) {
                    // Deck 10 belongs to player 1, deck 20 to player 2.
                    return [{ UserId: 10 }];
                }

                return [];
            }),
            queryTran: vi.fn().mockImplementation(async (c, sql) => {
                if (sql.includes('INSERT INTO "Games"')) {
                    return [{ Id: 99 }];
                }

                return [];
            }),
            startTransaction: vi.fn().mockResolvedValue(client)
        };

        service = new InPersonGameService(db, {
            settingsService: { getSection: () => settings },
            notificationService: notifications,
            ratingService
        });

        // Deck ownership is checked separately below; default to "owned".
        vi.spyOn(service, 'validateDecks').mockImplementation(async (game, report) => ({
            success: true,
            player1DeckId: report.player1DeckId ? Number(report.player1DeckId) : null,
            player2DeckId: report.player2DeckId ? Number(report.player2DeckId) : null
        }));
    });

    const committedGames = () =>
        db.queryTran.mock.calls.filter(([, sql]) => sql.includes('INSERT INTO "Games"'));

    /** Player 1's account of the game, already on file. */
    const firstReport = (overrides = {}) => ({
        ReporterId: 1,
        WinnerId: 1,
        Player1Keys: 3,
        Player2Keys: 1,
        Player1DeckId: 10,
        Player2DeckId: 20,
        ...overrides
    });

    describe('two-sided confirmation', function () {
        it('does not commit anything on the first report', async function () {
            const result = await service.report(5, 1, REPORT);

            expect(result.status).toBe('pending');
            expect(committedGames()).toHaveLength(0);
            expect(ratingService.processGame).not.toHaveBeenCalled();
        });

        it('tells the opponent a report is waiting on them', async function () {
            await service.report(5, 1, REPORT);

            expect(notifications.notify).toHaveBeenCalledWith(
                expect.objectContaining({ userId: 2, category: 'game.inperson' })
            );
        });

        it('commits when the second report agrees', async function () {
            reports = [firstReport()];

            const result = await service.report(5, 2, REPORT);

            expect(result.status).toBe('confirmed');
            expect(committedGames()).toHaveLength(1);
        });

        // The property the whole feature exists to guarantee.
        it('never picks a winner when the two reports disagree', async function () {
            reports = [firstReport()];

            const result = await service.report(5, 2, {
                ...REPORT,
                winnerId: 2,
                player1Keys: 1,
                player2Keys: 3
            });

            expect(result.status).toBe('disputed');
            expect(committedGames()).toHaveLength(0);
            expect(ratingService.processGame).not.toHaveBeenCalled();
        });

        it('disputes on a key mismatch even when both name the same winner', async function () {
            reports = [firstReport()];

            // Keys are a direct Elo input, so agreeing on the winner is not
            // agreeing on the result.
            const result = await service.report(5, 2, { ...REPORT, player2Keys: 2 });

            expect(result.status).toBe('disputed');
        });

        it('tells both players about a dispute', async function () {
            reports = [firstReport()];

            await service.report(5, 2, {
                ...REPORT,
                winnerId: 2,
                player1Keys: 1,
                player2Keys: 3
            });

            const notified = notifications.notify.mock.calls.map(([call]) => call.userId);

            expect(notified).toContain(1);
            expect(notified).toContain(2);
        });

        it('refuses a second report from the same player', async function () {
            reports = [firstReport()];

            const result = await service.report(5, 1, REPORT);

            expect(result.success).toBe(false);
            expect(result.message).toMatch(/already reported/i);
        });

        it('refuses a report from someone who was not in the game', async function () {
            const result = await service.report(5, 77, REPORT);

            expect(result.success).toBe(false);
            expect(result.message).toMatch(/not in that game/i);
        });
    });

    describe('report validation', function () {
        it('rejects a winner who is not one of the two players', async function () {
            const result = await service.report(5, 1, { ...REPORT, winnerId: 42 });

            expect(result.success).toBe(false);
        });

        it('rejects a winner who forged fewer keys than the loser', async function () {
            // Not a rules engine - a floor. Committing this would hand the Elo
            // engine a key differential with the wrong sign.
            const result = await service.report(5, 1, {
                ...REPORT,
                winnerId: 1,
                player1Keys: 1,
                player2Keys: 3
            });

            expect(result.success).toBe(false);
            expect(result.message).toMatch(/fewer keys/i);
        });

        it('rejects impossible key counts', async function () {
            expect((await service.report(5, 1, { ...REPORT, player1Keys: -1 })).success).toBe(
                false
            );
            expect((await service.report(5, 1, { ...REPORT, player2Keys: 99 })).success).toBe(
                false
            );
        });

        it('refuses to attach a deck the player does not own', async function () {
            service.validateDecks.mockRestore();
            db.query.mockImplementation(async (sql) => {
                if (sql.includes('FROM "InPersonGames"')) {
                    return [gameRow];
                }

                if (sql.includes('SELECT "UserId" FROM "Decks"')) {
                    // Deck belongs to somebody else entirely.
                    return [{ UserId: 999 }];
                }

                return [];
            });

            const result = await service.report(5, 1, REPORT);

            expect(result.success).toBe(false);
            expect(result.message).toMatch(/owns it/i);
        });
    });

    describe('rating a confirmed game', function () {
        beforeEach(function () {
            reports = [firstReport()];
        });

        it('rates through the ordinary game path', async function () {
            const result = await service.report(5, 2, REPORT);

            expect(result.rated).toBe(true);
            // The same entry point an online game uses - not a parallel one.
            expect(ratingService.processGame).toHaveBeenCalledWith(expect.stringMatching(/^irl-/));
        });

        it('marks the game as in-person on the Games row', async function () {
            await service.report(5, 2, REPORT);

            const [, sql] = committedGames()[0];

            expect(sql).toContain("'irl'");
        });

        it('records but does not rate when the site has IRL rating off', async function () {
            settings = { rated: false };

            const result = await service.report(5, 2, REPORT);

            expect(result.status).toBe('confirmed');
            expect(result.rated).toBe(false);
            expect(result.unratedReason).toMatch(/not rated/i);
            expect(ratingService.processGame).not.toHaveBeenCalled();
        });

        // Elo needs both decks' SAS. Without them the input would have to be
        // invented, so the game is recorded unrated and says why.
        it('records but does not rate when a deck is missing', async function () {
            reports = [firstReport({ Player2DeckId: null })];

            const result = await service.report(5, 2, { ...REPORT, player2DeckId: null });

            expect(result.status).toBe('confirmed');
            expect(result.rated).toBe(false);
            expect(result.unratedReason).toMatch(/both decks/i);
            expect(ratingService.processGame).not.toHaveBeenCalled();
        });

        it('rolls back and reports failure if the commit goes wrong', async function () {
            db.queryTran.mockImplementation(async (c, sql) => {
                if (sql.includes('INSERT INTO "GamePlayers"')) {
                    throw new Error('connection lost');
                }

                if (sql.includes('INSERT INTO "Games"')) {
                    return [{ Id: 99 }];
                }

                return [];
            });

            const result = await service.report(5, 2, REPORT);

            expect(result.success).toBe(false);
            expect(db.queryTran.mock.calls.some(([, sql]) => sql === 'ROLLBACK')).toBe(true);
            expect(ratingService.processGame).not.toHaveBeenCalled();
        });
    });

    // ARCHON (N5): escalating a dispute the two players cannot settle.
    describe('escalation', function () {
        let moderation;

        beforeEach(function () {
            moderation = { report: vi.fn().mockResolvedValue({ success: true, id: 77 }) };
            service.moderationService = moderation;
            gameRow.Status = 'disputed';
            gameRow.ReportId = null;
        });

        it('only escalates a disputed game', async function () {
            gameRow.Status = 'pending';

            const result = await service.escalate(5, 1, 'help');

            expect(result.success).toBe(false);
            expect(moderation.report).not.toHaveBeenCalled();
        });

        it('only lets the two players escalate', async function () {
            const result = await service.escalate(5, 99, 'help');

            expect(result.success).toBe(false);
        });

        it('files a report and links it to the game', async function () {
            const result = await service.escalate(5, 1, 'We cannot agree on the keys.');

            expect(result).toMatchObject({ success: true, reportId: 77 });
            expect(moderation.report).toHaveBeenCalledWith(
                1,
                expect.objectContaining({ targetType: 'inPersonGame', targetId: 5 })
            );
            expect(
                db.query.mock.calls.some(
                    ([sql]) => sql.includes('UPDATE "InPersonGames"') && sql.includes('"ReportId"')
                )
            ).toBe(true);
        });

        it('will not escalate the same dispute twice', async function () {
            gameRow.ReportId = 77;

            const result = await service.escalate(5, 1, 'again');

            expect(result.success).toBe(false);
            expect(moderation.report).not.toHaveBeenCalled();
        });

        // Escalating behind one player's back is a worse process than none.
        it('tells both players it has gone to the moderators', async function () {
            await service.escalate(5, 1, 'We cannot agree.');

            const notified = notifications.notify.mock.calls.map(([call]) => call.userId);

            expect(notified).toContain(1);
            expect(notified).toContain(2);
        });

        it('still disputes correctly with no moderation service wired in', async function () {
            service.moderationService = null;

            const result = await service.escalate(5, 1, 'help');

            expect(result.success).toBe(false);
            expect(result.message).toMatch(/not available/i);
        });
    });

    describe('lifecycle', function () {
        it('refuses to report against a confirmed game', async function () {
            gameRow.Status = 'confirmed';

            const result = await service.report(5, 1, REPORT);

            expect(result.success).toBe(false);
        });

        it('refuses to cancel a confirmed game', async function () {
            gameRow.Status = 'confirmed';

            const result = await service.cancel(5, 1);

            expect(result.success).toBe(false);
            expect(result.message).toMatch(/cannot be cancelled/i);
        });

        it('only allows withdrawing a report while the game is disputed', async function () {
            gameRow.Status = 'pending';

            expect((await service.withdrawReport(5, 1)).success).toBe(false);
        });

        it('reopens a disputed game when a report is withdrawn', async function () {
            gameRow.Status = 'disputed';
            db.query.mockImplementation(async (sql) => {
                if (sql.includes('FROM "InPersonGames"')) {
                    return [gameRow];
                }

                if (sql.includes('DELETE FROM "InPersonGameReports"')) {
                    return [{ Id: 1 }];
                }

                return [];
            });

            const result = await service.withdrawReport(5, 1);

            expect(result.success).toBe(true);
            expect(
                db.query.mock.calls.some(
                    ([sql]) => sql.includes('UPDATE "InPersonGames"') && sql.includes("'pending'")
                )
            ).toBe(true);
        });

        it('will not open a game against yourself', async function () {
            db.query.mockImplementation(async (sql) => {
                if (sql.includes('FROM "Users"')) {
                    return [{ Id: 1, Username: 'alice', Disabled: false }];
                }

                return [];
            });

            const result = await service.create(1, { opponentUsername: 'alice' });

            expect(result.success).toBe(false);
            expect(result.message).toMatch(/against yourself/i);
        });
    });
});
