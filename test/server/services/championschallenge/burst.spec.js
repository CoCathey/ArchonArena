const BurstService = require('../../../../server/services/championschallenge/BurstService');
const ChampionsChallengeService = require('../../../../server/services/championschallenge/ChampionsChallengeService');
const { PLAYER_ONE } = require('../../../../server/services/championschallenge/SimulatedGame');

/**
 * ARCHON (N40): answers in minutes.
 *
 * The lab answered in days - twelve games a deck against a twenty-game
 * confidence threshold - so a member enrolled, read "still proving", and had to
 * remember to come back. A burst is the same games, asked for.
 *
 * What has to hold, and each is a way this could be worse than not having it:
 *
 *  - it must be a QUEUE, not work in the request, or thirty games freeze every
 *    live table on the site for half a minute;
 *  - it must be bounded per member, or one person's curiosity is everybody
 *    else's sweep budget;
 *  - a claim must be atomic, or two nodes play the same run and a member's
 *    daily allowance buys one answer twice;
 *  - and a run that stops short must SAY why, because "2 of 30" with no
 *    explanation reads as the feature being broken.
 */
const USER = 11;

describe('running a batch on demand', function () {
    let db;
    let service;
    let config;

    const configService = { getValue: () => ({}) };
    const settingsService = {
        getSectionWithDefaults: (name) => (name === 'championsChallenge' ? { ...config } : {}),
        getSection: () => ({})
    };

    beforeEach(function () {
        config = {
            enabled: true,
            burstEnabled: true,
            burstGames: 30,
            burstRunsPerDay: 2,
            maxTurnsPerGame: 80
        };
        db = { query: vi.fn().mockResolvedValue([]) };
        service = new BurstService(configService, db, settingsService);
    });

    const answer = (handlers) =>
        db.query.mockImplementation(async (sql) => {
            for (const [fragment, rows] of handlers) {
                if (sql.includes(fragment)) {
                    return typeof rows === 'function' ? rows() : rows;
                }
            }

            return [];
        });

    describe('asking for one', function () {
        const owned = ['FROM "Decks" WHERE "Id"', [{ Id: 5 }]];

        it('queues a run rather than playing it in the request', async function () {
            answer([
                owned,
                ['COUNT(*)::int AS "Started"', [{ Started: 0 }]],
                ['INSERT INTO "ChallengeBurstRuns"', [{ Id: 1, Requested: 30, Status: 'queued' }]]
            ]);

            const result = await service.enqueue(USER, { deckId: 5, opposition: 'field' });

            expect(result.run.status).toBe('queued');
            // The whole reason it is a queue: simulated games are CPU, and the
            // lobby serves live tables on the same event loop.
            expect(result.run.requested).toBe(30);
        });

        it('refuses a deck the member does not own', async function () {
            answer([['FROM "Decks" WHERE "Id"', []]]);

            const result = await service.enqueue(USER, { deckId: 5, opposition: 'field' });

            expect(result.error).toContain('not yours');
        });

        it('refuses an opposition it does not have', async function () {
            const result = await service.enqueue(USER, { deckId: 5, opposition: 'everyone' });

            expect(result.error).toBeTruthy();
            expect(db.query).not.toHaveBeenCalled();
        });

        it('stops at the daily allowance', async function () {
            answer([owned, ['COUNT(*)::int AS "Started"', [{ Started: 2 }]]]);

            const result = await service.enqueue(USER, { deckId: 5, opposition: 'field' });

            expect(result.error).toContain('today');
        });

        it('lets an admin past the allowance', async function () {
            answer([
                owned,
                ['COUNT(*)::int AS "Started"', [{ Started: 99 }]],
                ['INSERT INTO "ChallengeBurstRuns"', [{ Id: 2, Requested: 30, Status: 'queued' }]]
            ]);

            const result = await service.enqueue(USER, {
                deckId: 5,
                opposition: 'roster',
                isAdmin: true
            });

            expect(result.run).toBeTruthy();
        });

        it('allows one run at a time, so a queue cannot form behind one member', async function () {
            answer([
                owned,
                ['COUNT(*)::int AS "Started"', [{ Started: 0 }]],
                ["\"Status\" IN ('queued', 'running')", [{ Id: 9, Status: 'running' }]]
            ]);

            const result = await service.enqueue(USER, { deckId: 5, opposition: 'field' });

            expect(result.error).toContain('already going');
        });

        it('counts a run when it is asked for, not when it finishes', async function () {
            answer([owned, ['COUNT(*)::int AS "Started"', [{ Started: 0 }]]]);

            await service.budgetFor(USER);

            const [sql] = db.query.mock.calls.find(([statement]) =>
                statement.includes('COUNT(*)::int AS "Started"')
            );

            // Counting finished runs would reward cancelling.
            expect(sql).toContain('"CreatedAt" >=');
        });

        it('treats an unreadable budget as spent, not as unlimited', async function () {
            db.query = vi.fn(async () => {
                throw new Error('nope');
            });
            service = new BurstService(configService, db, settingsService);

            expect((await service.budgetFor(USER)).remaining).toBe(0);
        });

        it('can be switched off entirely', async function () {
            config.burstEnabled = false;

            const result = await service.enqueue(USER, { deckId: 5, opposition: 'field' });

            expect(result.error).toContain('switched off');
        });
    });

    describe('claiming one', function () {
        it('takes it in a single statement, so two nodes cannot claim the same run', async function () {
            answer([
                ['UPDATE "ChallengeBurstRuns"', [{ Id: 3, Status: 'running', Requested: 30 }]]
            ]);

            const run = await service.claimNext();

            expect(run.status).toBe('running');

            const [sql] = db.query.mock.calls[0];

            // A read then a write leaves a window; SKIP LOCKED closes it.
            expect(sql).toContain('FOR UPDATE SKIP LOCKED');
            expect(sql.startsWith('UPDATE')).toBe(true);
        });

        it('reclaims a run a restart left mid-flight', async function () {
            answer([['SET "Status" = \'failed\'', [{ Id: 4 }]]]);

            expect(await service.releaseStuck()).toBe(1);

            const [sql] = db.query.mock.calls[0];

            expect(sql).toContain('"Status" = \'running\'');
            expect(sql).toContain('StartedAt');
        });
    });

    describe('progress', function () {
        it('measures against what was asked for', function () {
            const run = service.mapRun({
                Id: 1,
                Requested: 30,
                Played: 15,
                Wins: 9,
                Losses: 6,
                Status: 'running'
            });

            expect(run.progress).toBe(0.5);
            expect(run.winRate).toBeCloseTo(0.6, 5);
        });

        it('never runs past the end of the bar', function () {
            const run = service.mapRun({ Id: 1, Requested: 10, Played: 12, Status: 'running' });

            expect(run.progress).toBe(1);
        });

        it('has no win rate before there is a game', function () {
            expect(service.mapRun({ Id: 1, Requested: 30, Played: 0 }).winRate).toBeNull();
        });
    });

    describe('playing one', function () {
        let lab;

        beforeEach(function () {
            lab = new ChampionsChallengeService(configService, db, settingsService);
            lab.rosterAccess = vi.fn(async () => ({ mayUse: true, isAdmin: false }));
            lab.burstService.releaseStuck = vi.fn(async () => 0);
        });

        const styling = { next: () => null, model: () => null, active: false };

        it('plays the requested number of games and closes the run', async function () {
            const run = { id: 7, userId: USER, deckId: 5, opposition: 'vaulttour', requested: 3 };

            lab.burstService.claimNext = vi.fn(async () => run);
            lab.burstService.noteGame = vi.fn(async () => true);
            lab.burstService.finish = vi.fn(async () => true);
            lab.playVaultTourGame = vi.fn(async ({ onResult }) => {
                onResult({ won: true });

                return 'played';
            });

            expect(await lab.runBurstStep(config, { championModel: null, styling })).toBe(3);
            expect(lab.burstService.noteGame).toHaveBeenCalledTimes(3);
            expect(lab.burstService.finish).toHaveBeenCalledWith(7, {
                status: 'done',
                note: null
            });
        });

        it('stops and says why when there is nothing to play against', async function () {
            const run = { id: 8, userId: USER, deckId: 5, opposition: 'field', requested: 30 };

            lab.burstService.claimNext = vi.fn(async () => run);
            lab.burstService.finish = vi.fn(async () => true);
            lab.gauntletService = { settingsFor: vi.fn(async () => ({})) };
            lab.playFieldGame = vi.fn(async () => 'no-opponent');

            await lab.runBurstStep(config, { championModel: null, styling });

            // "2 of 30" with no explanation reads as the feature being broken.
            const [, closed] = lab.burstService.finish.mock.calls[0];

            expect(closed.status).toBe('done');
            expect(closed.note).toContain('pool');
            // And it does not keep asking for an opponent that is not there.
            expect(lab.playFieldGame).toHaveBeenCalledTimes(1);
        });

        it('counts an abandoned game without counting it as a loss', async function () {
            const run = { id: 9, userId: USER, deckId: 5, opposition: 'vaulttour', requested: 2 };

            lab.burstService.claimNext = vi.fn(async () => run);
            lab.burstService.noteGame = vi.fn(async () => true);
            lab.burstService.finish = vi.fn(async () => true);
            lab.playVaultTourGame = vi.fn(async () => 'abandoned');

            await lab.runBurstStep(config, { championModel: null, styling });

            expect(lab.burstService.noteGame).toHaveBeenCalledWith(9, { abandoned: true });
        });

        it('re-checks entitlement at play time, not only when it was asked for', async function () {
            const run = { id: 10, userId: USER, deckId: 5, opposition: 'roster', requested: 5 };

            lab.burstService.claimNext = vi.fn(async () => run);
            lab.burstService.finish = vi.fn(async () => true);
            lab.rosterAccess = vi.fn(async () => ({ mayUse: false, isAdmin: false }));
            lab.playBurstMirrorGame = vi.fn();

            await lab.runBurstStep(config, { championModel: null, styling });

            // A membership can lapse between asking and running.
            expect(lab.playBurstMirrorGame).not.toHaveBeenCalled();
            expect(lab.burstService.finish.mock.calls[0][1].status).toBe('failed');
        });

        it('does nothing when there is nothing queued', async function () {
            lab.burstService.claimNext = vi.fn(async () => null);

            expect(await lab.runBurstStep(config, { championModel: null, styling })).toBe(0);
        });
    });

    describe('the mirror burst', function () {
        let lab;

        beforeEach(function () {
            lab = new ChampionsChallengeService(configService, db, settingsService);
        });

        it('needs a second deck on the roster', async function () {
            db.query = vi.fn(async () => []);
            lab = new ChampionsChallengeService(configService, db, settingsService);

            const outcome = await lab.playBurstMirrorGame(
                { userId: USER, deckId: 5, requested: 1 },
                config,
                { styling: { model: () => null }, persona: null }
            );

            expect(outcome).toBe('no-opponent');
        });

        it('records the game and reports who won', async function () {
            db.query = vi.fn(async (sql) =>
                sql.includes('FROM "ProvingGroundsDecks"') ? [{ DeckId: 6 }] : []
            );
            lab = new ChampionsChallengeService(configService, db, settingsService);
            lab.loadEngineDeck = vi.fn(async () => ({
                missing: [],
                deck: { houses: ['a', 'b', 'c'] }
            }));
            lab.runMatch = vi.fn(async () => ({ completed: true, winner: PLAYER_ONE, turns: 12 }));
            lab.recordGame = vi.fn(async () => true);

            const outcome = await lab.playBurstMirrorGame({ userId: USER, deckId: 5 }, config, {
                styling: { model: () => null },
                persona: null
            });

            expect(outcome).toBe('won');
            expect(lab.recordGame).toHaveBeenCalled();
        });

        it('is a measurement, so it neither explores nor feeds the diary', async function () {
            db.query = vi.fn(async (sql) =>
                sql.includes('FROM "ProvingGroundsDecks"') ? [{ DeckId: 6 }] : []
            );
            lab = new ChampionsChallengeService(configService, db, settingsService);
            lab.loadEngineDeck = vi.fn(async () => ({
                missing: [],
                deck: { houses: ['a', 'b', 'c'] }
            }));
            lab.runMatch = vi.fn(async () => ({ completed: true, winner: PLAYER_ONE }));
            lab.recordGame = vi.fn(async () => true);

            await lab.playBurstMirrorGame({ userId: USER, deckId: 5 }, config, {
                styling: { model: () => null },
                persona: null
            });

            const [, , options] = lab.runMatch.mock.calls[0];

            // The training loop's pacing belongs to the background sweep, not
            // to a member's request for an answer.
            expect(options.temperature).toBe(0);
            expect(options.recordDecisions).toBe(false);
        });
    });

    it('never touches the official games, players or rating tables', async function () {
        answer([['FROM "Decks" WHERE "Id"', [{ Id: 5 }]]]);

        await service.enqueue(USER, { deckId: 5, opposition: 'field' });
        await service.claimNext();
        await service.latestFor(USER);
        await service.releaseStuck();

        for (const [sql] of db.query.mock.calls) {
            expect(sql).not.toMatch(/"(Games|GamePlayers|RatingHistory)"/);
        }
    });
});
