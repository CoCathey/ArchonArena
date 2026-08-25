const TournamentService = require('../../../../server/services/tournament/TournamentService');

/**
 * ARCHON (N9): hybrid events, kiosk check-in, Alliance pod legality and
 * Adaptive Bo3.
 */
describe('Tournament hybrid events and paper results', function () {
    let service;
    let db;
    let tournament;
    let match;

    beforeEach(function () {
        tournament = {
            Id: 1,
            Status: 'active',
            OrganizerId: 9,
            Mode: 'online',
            AllowPaperResults: false,
            BestOf: 1
        };
        match = {
            Id: 3,
            TournamentId: 1,
            Player1Id: 1,
            Player2Id: 2,
            BestOf: 1,
            Player1Wins: 0,
            Player2Wins: 0
        };

        db = {
            query: vi.fn().mockImplementation(async (sql) => {
                if (sql.includes('FROM "Tournaments"')) {
                    return [tournament];
                }

                if (sql.includes('FROM "TournamentMatches"')) {
                    return [match];
                }

                return [];
            })
        };

        service = new TournamentService(db, { settingsService: { getSection: () => ({}) } });
    });

    const resultSourceOf = () => {
        const call = db.query.mock.calls.find(([sql]) =>
            sql.includes('UPDATE "TournamentMatches" SET "WinnerId"')
        );

        return call && call[1][6];
    };

    it('refuses a paper result on an event that has not opted in', async function () {
        const result = await service.reportResult(1, 3, 1, { id: 1 }, { source: 'paper' });

        expect(result.success).toBe(false);
        expect(result.message).toMatch(/paper play/i);
    });

    it('accepts a paper result once the event allows it', async function () {
        tournament.AllowPaperResults = true;

        const result = await service.reportResult(1, 3, 1, { id: 1 }, { source: 'paper' });

        expect(result.success).toBe(true);
        expect(resultSourceOf()).toBe('paper');
    });

    it('records an ordinary result as online', async function () {
        const result = await service.reportResult(1, 3, 1, { id: 1 }, {});

        expect(result.success).toBe(true);
        // Worth recording separately: an organizer auditing a standing needs
        // to know which results the platform actually witnessed.
        expect(resultSourceOf()).toBe('online');
    });

    it('turns paper results on automatically for an in-person or hybrid event', function () {
        const errors = [];
        const irl = service.parseEventOptions(
            { name: 'Store night', format: 'swiss', mode: 'irl' },
            {}
        );
        const hybrid = service.parseEventOptions(
            { name: 'Hybrid', format: 'swiss', mode: 'hybrid' },
            {}
        );

        expect(errors).toEqual([]);
        expect(irl.values.allowPaperResults).toBe(true);
        expect(hybrid.values.allowPaperResults).toBe(true);
    });

    it('accepts hybrid as an event mode', function () {
        const parsed = service.parseEventOptions(
            { name: 'Hybrid event', format: 'swiss', mode: 'hybrid' },
            {}
        );

        expect(parsed.errors).toEqual([]);
        expect(parsed.values.mode).toBe('hybrid');
    });
});

describe('Tournament kiosk check-in', function () {
    let service;
    let db;
    let tournament;

    beforeEach(function () {
        tournament = {
            Id: 1,
            Status: 'registration',
            OrganizerId: 9,
            CheckInOpenedAt: new Date(),
            CheckInCode: 'ABCD2345'
        };

        db = {
            query: vi.fn().mockImplementation(async (sql) => {
                if (sql.includes('SELECT "Id" FROM "Tournaments" WHERE "CheckInCode"')) {
                    return [{ Id: 1 }];
                }

                if (sql.includes('FROM "Tournaments"')) {
                    return [tournament];
                }

                if (sql.includes('UPDATE "TournamentPlayers"')) {
                    return [{ Id: 5 }];
                }

                return [];
            })
        };

        service = new TournamentService(db, { settingsService: { getSection: () => ({}) } });
    });

    it('checks in the player who scanned, not anyone named in the code', async function () {
        const result = await service.checkInByCode('ABCD2345', { id: 42 });

        expect(result.success).toBe(true);

        const update = db.query.mock.calls.find(([sql]) =>
            sql.includes('UPDATE "TournamentPlayers"')
        );

        // The actor's own id - the code identifies the event only, so a
        // photographed code cannot check anybody else in.
        expect(update[1][1]).toBe(42);
        expect(update[1][2]).toBe('kiosk');
    });

    it('rejects an unknown code', async function () {
        db.query.mockImplementation(async (sql) => {
            if (sql.includes('WHERE "CheckInCode"')) {
                return [];
            }

            return [];
        });

        const result = await service.checkInByCode('ZZZZ9999', { id: 42 });

        expect(result.success).toBe(false);
    });

    it('rejects a code that is too short to be one', async function () {
        const result = await service.checkInByCode('AB', { id: 42 });

        expect(result.success).toBe(false);
        expect(db.query).not.toHaveBeenCalled();
    });

    it('marks a self check-in differently from a kiosk scan', async function () {
        await service.checkIn(1, { id: 42 });

        const update = db.query.mock.calls.find(([sql]) =>
            sql.includes('UPDATE "TournamentPlayers"')
        );

        expect(update[1][2]).toBe('self');
    });
});

describe('Tournament Alliance pod legality', function () {
    let service;
    let db;
    let tournament;

    beforeEach(function () {
        tournament = { Id: 1, GameFormat: 'alliance', AlliancePolicy: null };
        db = { query: vi.fn().mockResolvedValue([]) };
        service = new TournamentService(db, { settingsService: { getSection: () => ({}) } });
    });

    const deck = (pods) => ({
        Id: 5,
        Name: 'My Alliance',
        IsAlliance: true,
        AlliancePods: pods
    });

    it('allows any Alliance deck when the event sets no pod rules', async function () {
        const result = await service.validateAlliancePods(tournament, 1, deck(null));

        expect(result.success).toBe(true);
    });

    /**
     * Pod provenance only started being recorded in migration 46, and there
     * is no way to backfill it. An event that checks pods therefore has to
     * turn those decks away by name rather than wave through a deck it cannot
     * actually check.
     */
    it('rejects a deck built before pod sources were recorded, when asked to', async function () {
        tournament.AlliancePolicy = { requirePodProvenance: true };

        const result = await service.validateAlliancePods(tournament, 1, deck(null));

        expect(result.success).toBe(false);
        expect(result.message).toMatch(/before pod sources were recorded/i);
    });

    it('lets an unverifiable deck through when the event does not check', async function () {
        tournament.AlliancePolicy = { maxPodsPerSourceDeck: 1 };

        const result = await service.validateAlliancePods(tournament, 1, deck(null));

        expect(result.success).toBe(true);
    });

    it('enforces a limit on pods from one physical deck', async function () {
        tournament.AlliancePolicy = { maxPodsPerSourceDeck: 1 };

        const result = await service.validateAlliancePods(
            tournament,
            1,
            deck([
                { deckUuid: 'a', house: 'dis' },
                { deckUuid: 'a', house: 'logos' },
                { deckUuid: 'b', house: 'mars' }
            ])
        );

        expect(result.success).toBe(false);
        expect(result.message).toMatch(/at most 1 pod/i);
    });

    it('allows repeats up to the configured limit', async function () {
        tournament.AlliancePolicy = { maxPodsPerSourceDeck: 2 };

        const result = await service.validateAlliancePods(
            tournament,
            1,
            deck([
                { deckUuid: 'a', house: 'dis' },
                { deckUuid: 'a', house: 'logos' },
                { deckUuid: 'b', house: 'mars' }
            ])
        );

        expect(result.success).toBe(true);
    });

    it('bans pods of a named house', async function () {
        tournament.AlliancePolicy = { bannedPodHouses: ['dis'] };

        const result = await service.validateAlliancePods(
            tournament,
            1,
            deck([{ deckUuid: 'a', house: 'dis' }])
        );

        expect(result.success).toBe(false);
        expect(result.message).toMatch(/bans dis/i);
    });

    it('restricts pods to allowed sets', async function () {
        tournament.AlliancePolicy = { allowedPodSets: [479] };
        db.query.mockResolvedValue([{ Uuid: 'a', ExpansionId: 500 }]);

        const result = await service.validateAlliancePods(
            tournament,
            1,
            deck([{ deckUuid: 'a', house: 'dis' }])
        );

        expect(result.success).toBe(false);
        expect(result.message).toMatch(/does not allow/i);
    });

    /**
     * At a paper event there is only one physical copy of each Archon on the
     * table, so two players cannot both source a pod from it.
     */
    it('stops two players sourcing pods from the same physical deck', async function () {
        tournament.AlliancePolicy = { exclusiveSourceDecks: true };
        db.query.mockResolvedValue([{ Name: "Someone else's deck" }]);

        const result = await service.validateAlliancePods(
            tournament,
            1,
            deck([{ deckUuid: 'a', house: 'dis' }])
        );

        expect(result.success).toBe(false);
        expect(result.message).toMatch(/already sourced a pod/i);
    });

    it('rejects pod rules on an event that is not Alliance', function () {
        const parsed = service.parseEventOptions(
            {
                name: 'Archon event',
                format: 'swiss',
                gameFormat: 'archon',
                alliancePolicy: { requirePodProvenance: true }
            },
            {}
        );

        expect(parsed.errors.some((error) => /only apply to Alliance/i.test(error))).toBe(true);
    });
});

describe('Tournament Adaptive Bo3', function () {
    let service;
    let db;
    let tournament;
    let match;

    beforeEach(function () {
        tournament = { Id: 1, Status: 'active', OrganizerId: 9, AdaptiveBo3: true };
        // 1-1 going into game three: the only point at which bidding happens.
        match = {
            Id: 3,
            TournamentId: 1,
            Player1Id: 1,
            Player2Id: 2,
            BestOf: 3,
            Player1Wins: 1,
            Player2Wins: 1,
            AdaptiveState: null
        };

        db = {
            query: vi.fn().mockImplementation(async (sql, params) => {
                // Mirrors the real claim UPDATE's jsonb merge, so a deadline
                // stamped by ensureAdaptiveBidDeadline is visible to whatever
                // reads the match next, just as it would be against Postgres.
                if (sql.includes('RETURNING "AdaptiveState"')) {
                    const patch = JSON.parse(params[1]);

                    match.AdaptiveState = { ...(match.AdaptiveState || {}), ...patch };

                    return [{ AdaptiveState: match.AdaptiveState }];
                }

                if (sql.includes('FROM "Tournaments"')) {
                    return [tournament];
                }

                if (sql.includes('FROM "TournamentMatches"')) {
                    return [match];
                }

                return [];
            })
        };

        service = new TournamentService(db, { settingsService: { getSection: () => ({}) } });
    });

    const savedState = () => {
        const call = db.query.mock.calls
            .filter(([sql]) => sql.includes('SET "AdaptiveState"'))
            .pop();

        return call && JSON.parse(call[1][1]);
    };

    it('plays own decks in game one and swaps in game two', async function () {
        match.Player1Wins = 0;
        match.Player2Wins = 0;

        const first = await service.getAdaptiveState(1, 3, { id: 1 });

        expect(first.gameNumber).toBe(1);
        expect(first.decks[1]).toBe('own');
        expect(first.bidding).toBeNull();

        match.Player1Wins = 1;

        const second = await service.getAdaptiveState(1, 3, { id: 1 });

        expect(second.gameNumber).toBe(2);
        expect(second.decks[1]).toBe('opponent');
    });

    it('opens bidding only at one game each', async function () {
        const state = await service.getAdaptiveState(1, 3, { id: 1 });

        expect(state.gameNumber).toBe(3);
        expect(state.bidding).not.toBeNull();
        expect(state.bidding.currentBid).toBe(0);
    });

    it('refuses a bid before game three', async function () {
        match.Player1Wins = 0;
        match.Player2Wins = 0;

        const result = await service.adaptiveBid(1, 3, { id: 1 }, 3);

        expect(result.success).toBe(false);
        expect(result.message).toMatch(/before game three/i);
    });

    it('refuses a bid out of turn', async function () {
        // Player 1 opens (they lost game 2 in this fixture ordering), so
        // player 2 bidding first is out of turn.
        const state = await service.getAdaptiveState(1, 3, { id: 1 });
        const other = state.bidding.turnUserId === 1 ? 2 : 1;

        const result = await service.adaptiveBid(1, 3, { id: other }, 3);

        expect(result.success).toBe(false);
        expect(result.message).toMatch(/not your turn/i);
    });

    it('passes the turn to the opponent after a bid', async function () {
        const state = await service.getAdaptiveState(1, 3, { id: 1 });
        const bidder = state.bidding.turnUserId;

        await service.adaptiveBid(1, 3, { id: bidder }, 3);

        expect(savedState().currentBid).toBe(3);
        expect(savedState().highBidderId).toBe(bidder);
        expect(savedState().turnUserId).not.toBe(bidder);
    });

    /** Chains are a handicap you take on, so a bid only ever goes up. */
    it('refuses a bid that does not beat the standing one', async function () {
        match.AdaptiveState = { currentBid: 5, highBidderId: 1, turnUserId: 2 };

        const result = await service.adaptiveBid(1, 3, { id: 2 }, 5);

        expect(result.success).toBe(false);
        expect(result.message).toMatch(/more than 5 chains/i);
    });

    it('rejects a nonsensical bid', async function () {
        match.AdaptiveState = { currentBid: 0, highBidderId: null, turnUserId: 1 };

        expect((await service.adaptiveBid(1, 3, { id: 1 }, -1)).success).toBe(false);
        expect((await service.adaptiveBid(1, 3, { id: 1 }, 99)).success).toBe(false);
    });

    it('hands the deck to the high bidder when the other player passes', async function () {
        match.AdaptiveState = {
            bidDeckOwnerId: 1,
            currentBid: 4,
            highBidderId: 1,
            turnUserId: 2
        };

        const result = await service.adaptivePass(1, 3, { id: 2 });

        expect(result.resolved).toBe(true);
        expect(result.winnerOfBid).toBe(1);
        expect(result.chains).toBe(4);

        const state = savedState();

        // The bidder carries the chains; the other player takes the remaining
        // deck unchained.
        expect(state.chains['1']).toBe(4);
        expect(state.chains['2']).toBe(0);
        expect(state.decks['1']).toBe(1);
        expect(state.decks['2']).toBe(2);
    });

    it('gives the deck away at zero when the opening player passes', async function () {
        // Otherwise two players who both refuse to open would deadlock the
        // series with no way forward.
        match.AdaptiveState = {
            bidDeckOwnerId: 1,
            currentBid: 0,
            highBidderId: null,
            turnUserId: 1
        };

        const result = await service.adaptivePass(1, 3, { id: 1 });

        expect(result.resolved).toBe(true);
        expect(result.winnerOfBid).toBe(2);
        expect(result.chains).toBe(0);
    });

    it('will not reopen a settled bid', async function () {
        match.AdaptiveState = { resolved: true, currentBid: 4, highBidderId: 1, turnUserId: null };

        expect((await service.adaptiveBid(1, 3, { id: 2 }, 9)).success).toBe(false);
        expect((await service.adaptivePass(1, 3, { id: 2 })).success).toBe(false);
    });

    it('keeps someone outside the match out of the bidding', async function () {
        const result = await service.adaptiveBid(1, 3, { id: 77, permissions: {} }, 3);

        expect(result.success).toBe(false);
    });

    it('forces a three-game series when Adaptive is on', function () {
        const parsed = service.parseEventOptions(
            { name: 'Adaptive event', format: 'swiss', adaptiveBo3: true, bestOf: 1 },
            {}
        );

        expect(parsed.values.bestOf).toBe(3);
    });

    it('refuses to combine Adaptive with Triad', function () {
        const parsed = service.parseEventOptions(
            { name: 'Both', format: 'swiss', adaptiveBo3: true, triad: true },
            {}
        );

        expect(parsed.errors.some((error) => /pick one/i.test(error))).toBe(true);
    });

    it('refuses Adaptive on a sealed event', function () {
        const parsed = service.parseEventOptions(
            { name: 'Sealed adaptive', format: 'swiss', gameFormat: 'sealed', adaptiveBo3: true },
            {}
        );

        expect(parsed.errors.some((error) => /cannot be sealed/i.test(error))).toBe(true);
    });

    it('stamps a bid deadline the first time anyone looks at game three', async function () {
        const state = await service.getAdaptiveState(1, 3, { id: 1 });

        expect(state.bidding.turnDeadlineAt).toBeTruthy();
        expect(new Date(state.bidding.turnDeadlineAt).getTime()).toBeGreaterThan(Date.now());
    });

    it('does not restamp a deadline that is already set', async function () {
        const existing = new Date(Date.now() + 1000).toISOString();
        match.AdaptiveState = { currentBid: 0, highBidderId: null, turnDeadlineAt: existing };

        const state = await service.getAdaptiveState(1, 3, { id: 1 });

        expect(state.bidding.turnDeadlineAt).toBe(existing);
    });

    it('refreshes the deadline when the turn passes after a bid', async function () {
        const state = await service.getAdaptiveState(1, 3, { id: 1 });
        const bidder = state.bidding.turnUserId;

        await service.adaptiveBid(1, 3, { id: bidder }, 3);

        expect(savedState().turnDeadlineAt).toBeTruthy();
    });
});

describe('Tournament Adaptive Bo3 bid timeout', function () {
    let service;
    let db;
    let tournament;
    let match;

    beforeEach(function () {
        tournament = { Id: 1, Status: 'active', OrganizerId: 9, AdaptiveBo3: true, Name: 'Cup' };
        match = {
            Id: 3,
            TournamentId: 1,
            Player1Id: 1,
            Player2Id: 2,
            Player1: 'alice',
            Player2: 'bob',
            AdaptiveState: null
        };

        db = { query: vi.fn() };
        service = new TournamentService(db, { settingsService: { getSection: () => ({}) } });
    });

    const expiredIso = () => new Date(Date.now() - 1000).toISOString();

    const claimedUpdate = () =>
        db.query.mock.calls.find(([sql]) =>
            sql.includes('AND (("AdaptiveState"->>\'turnDeadlineAt\') = $3)')
        );

    it('does nothing when no bid has timed out', async function () {
        db.query.mockResolvedValue([]);

        const result = await service.sweepAdaptiveBidTimeouts();

        expect(result.resolved).toBe(0);
    });

    it('gives the opponent the deck at zero chains when nobody ever bid', async function () {
        const deadline = expiredIso();

        match.AdaptiveState = {
            bidDeckOwnerId: 1,
            currentBid: 0,
            highBidderId: null,
            turnUserId: 1,
            turnDeadlineAt: deadline
        };

        db.query.mockImplementation(async (sql) => {
            if (sql.startsWith('SELECT') && sql.includes('FROM "TournamentMatches"')) {
                return [
                    {
                        ...match,
                        TournamentName: tournament.Name,
                        OrganizerId: tournament.OrganizerId
                    }
                ];
            }

            if (sql.startsWith('UPDATE') && sql.includes('RETURNING "Id"')) {
                return [{ Id: match.Id }];
            }

            return [];
        });

        const result = await service.sweepAdaptiveBidTimeouts();

        expect(result.resolved).toBe(1);

        const update = claimedUpdate();
        const resolved = JSON.parse(update[1][1]);

        expect(resolved.resolved).toBe(true);
        expect(resolved.timedOut).toBe(true);
        // Player 1 (turnUserId) let the clock run out, so player 2 wins the
        // nominated deck at no chains - exactly what a live pass would give.
        expect(resolved.highBidderId).toBe(2);
        expect(resolved.chains['2']).toBe(0);
        expect(resolved.decks['2']).toBe(1);
    });

    it('awards the deck to the standing high bidder when the other side lets the clock run out', async function () {
        const deadline = expiredIso();

        match.AdaptiveState = {
            bidDeckOwnerId: 1,
            currentBid: 6,
            highBidderId: 1,
            turnUserId: 2,
            turnDeadlineAt: deadline
        };

        db.query.mockImplementation(async (sql) => {
            if (sql.startsWith('SELECT') && sql.includes('FROM "TournamentMatches"')) {
                return [
                    {
                        ...match,
                        TournamentName: tournament.Name,
                        OrganizerId: tournament.OrganizerId
                    }
                ];
            }

            if (sql.startsWith('UPDATE') && sql.includes('RETURNING "Id"')) {
                return [{ Id: match.Id }];
            }

            return [];
        });

        const result = await service.sweepAdaptiveBidTimeouts();

        expect(result.resolved).toBe(1);

        const resolved = JSON.parse(claimedUpdate()[1][1]);

        expect(resolved.highBidderId).toBe(1);
        expect(resolved.chains['1']).toBe(6);
        expect(resolved.decks['1']).toBe(1);
    });

    it('leaves it alone when a real bid or pass wins the race', async function () {
        const deadline = expiredIso();

        match.AdaptiveState = {
            bidDeckOwnerId: 1,
            currentBid: 0,
            highBidderId: null,
            turnUserId: 1,
            turnDeadlineAt: deadline
        };

        db.query.mockImplementation(async (sql) => {
            if (sql.startsWith('SELECT') && sql.includes('FROM "TournamentMatches"')) {
                return [
                    {
                        ...match,
                        TournamentName: tournament.Name,
                        OrganizerId: tournament.OrganizerId
                    }
                ];
            }

            if (sql.startsWith('UPDATE') && sql.includes('RETURNING "Id"')) {
                // The real action already flipped the deadline, so the
                // sweep's conditional claim matches nothing.
                return [];
            }

            return [];
        });

        const result = await service.sweepAdaptiveBidTimeouts();

        expect(result.resolved).toBe(0);
    });
});
