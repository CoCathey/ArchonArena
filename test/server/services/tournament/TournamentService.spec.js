const TournamentService = require('../../../../server/services/tournament/TournamentService');

/**
 * Lightweight in-memory fake of the db module: just enough SQL routing
 * to exercise the service's lifecycle logic end to end.
 */
const createFakeDb = () => {
    const state = {
        tournaments: [],
        players: [],
        matches: [],
        nextId: 1
    };

    const db = {
        state,
        query: vi.fn(async (sql, params = []) => {
            if (sql.includes('INSERT INTO "Tournaments"')) {
                const row = {
                    Id: state.nextId++,
                    Name: params[0],
                    Description: params[1],
                    OrganizerId: params[2],
                    Format: params[3],
                    GameFormat: params[4],
                    Mode: params[5],
                    RoundCount: params[6],
                    Status: 'registration',
                    CurrentRound: 0
                };
                state.tournaments.push(row);
                return [{ Id: row.Id }];
            }

            if (sql.startsWith('SELECT * FROM "Tournaments"')) {
                return state.tournaments.filter((row) => row.Id === params[0]);
            }

            if (sql.includes('UPDATE "Tournaments"')) {
                const row = state.tournaments.find((entry) => entry.Id === params[0]);
                if (row) {
                    if (sql.includes("'active'")) {
                        row.Status = 'active';
                        row.CurrentRound = 1;
                        row.RoundCount = params[1];
                    } else if (sql.includes("'complete'")) {
                        row.Status = 'complete';
                    } else if (sql.includes("'cancelled'")) {
                        row.Status = 'cancelled';
                    } else if (sql.includes('"CurrentRound" = $2')) {
                        row.CurrentRound = params[1];
                    }
                }
                return [];
            }

            if (sql.includes('INSERT INTO "TournamentPlayers"')) {
                const existing = state.players.find(
                    (player) => player.TournamentId === params[0] && player.UserId === params[1]
                );
                if (existing) {
                    existing.Dropped = false;
                } else {
                    state.players.push({
                        TournamentId: params[0],
                        UserId: params[1],
                        Dropped: false,
                        Username: `user${params[1]}`
                    });
                }
                return [];
            }

            if (sql.includes('DELETE FROM "TournamentPlayers"')) {
                state.players = state.players.filter(
                    (player) => !(player.TournamentId === params[0] && player.UserId === params[1])
                );
                return [];
            }

            if (sql.includes('UPDATE "TournamentPlayers" SET "Dropped"')) {
                const player = state.players.find(
                    (entry) => entry.TournamentId === params[0] && entry.UserId === params[1]
                );
                if (player) {
                    player.Dropped = true;
                }
                return [];
            }

            if (sql.includes('FROM "TournamentPlayers" tp')) {
                return state.players
                    .filter((player) => player.TournamentId === params[0])
                    .map((player) => ({
                        UserId: player.UserId,
                        Dropped: player.Dropped,
                        Seed: null,
                        Username: player.Username
                    }));
            }

            if (sql.includes('INSERT INTO "TournamentMatches"')) {
                const withOpponent = sql.includes('"Player2Id"');
                state.matches.push({
                    Id: state.nextId++,
                    TournamentId: params[0],
                    Round: params[1],
                    TableNumber: withOpponent ? params[2] : null,
                    Player1Id: withOpponent ? params[3] : params[2],
                    Player2Id: withOpponent ? params[4] : null,
                    WinnerId: withOpponent ? null : params[2]
                });
                return [];
            }

            if (sql.includes('SELECT COUNT(*) AS "Unreported"')) {
                const unreported = state.matches.filter(
                    (match) =>
                        match.TournamentId === params[0] &&
                        match.Round === params[1] &&
                        !match.WinnerId
                );
                return [{ Unreported: String(unreported.length) }];
            }

            if (sql.includes('FROM "TournamentMatches" m')) {
                return state.matches
                    .filter((match) => match.TournamentId === params[0])
                    .map((match) => ({
                        ...match,
                        Player1: `user${match.Player1Id}`,
                        Player2: match.Player2Id ? `user${match.Player2Id}` : null
                    }));
            }

            if (sql.includes('SELECT * FROM "TournamentMatches"')) {
                return state.matches.filter(
                    (match) => match.Id === params[0] && match.TournamentId === params[1]
                );
            }

            if (sql.includes('UPDATE "TournamentMatches" SET "WinnerId"')) {
                const match = state.matches.find((entry) => entry.Id === params[0]);
                if (match) {
                    match.WinnerId = params[1];
                }
                return [];
            }

            if (sql.includes('SELECT "Username" FROM "Users"')) {
                return [{ Username: `user${params[0]}` }];
            }

            return [];
        })
    };

    return db;
};

describe('TournamentService', function () {
    let db;
    let service;
    const organizer = { id: 1, permissions: {} };
    const stranger = { id: 99, permissions: {} };
    const siteTo = { id: 50, permissions: { canManageTournaments: true } };

    beforeEach(function () {
        db = createFakeDb();
        service = new TournamentService(db);
    });

    const createSwiss = async (playerCount, options = {}) => {
        const created = await service.create(organizer, {
            name: 'Weekly Archon',
            format: 'swiss',
            ...options
        });
        for (let index = 0; index < playerCount; index++) {
            await service.register(created.id, { id: index + 1 });
        }
        return created.id;
    };

    describe('create', function () {
        it('validates name, format, mode and round count', async function () {
            expect((await service.create(organizer, { name: 'ab', format: 'swiss' })).success).toBe(
                false
            );
            expect(
                (await service.create(organizer, { name: 'Valid Name', format: 'ladder' })).success
            ).toBe(false);
            expect(
                (
                    await service.create(organizer, {
                        name: 'Valid Name',
                        format: 'swiss',
                        mode: 'astral'
                    })
                ).success
            ).toBe(false);
            expect(
                (
                    await service.create(organizer, {
                        name: 'Valid Name',
                        format: 'swiss',
                        roundCount: 99
                    })
                ).success
            ).toBe(false);

            const ok = await service.create(organizer, { name: 'Valid Name', format: 'swiss' });
            expect(ok.success).toBe(true);
            expect(ok.id).toBeDefined();
        });
    });

    describe('registration', function () {
        it('registers players only while registration is open', async function () {
            const id = await createSwiss(4);

            await service.start(id, organizer);

            const late = await service.register(id, stranger);
            expect(late.success).toBe(false);
        });

        it('re-registering after a drop restores the player', async function () {
            const id = await createSwiss(2);

            await service.drop(id, null, { id: 2 });
            expect(db.state.players.length).toBe(1);

            await service.register(id, { id: 2 });
            expect(db.state.players.length).toBe(2);
        });

        it('only the organizer can drop other players', async function () {
            const id = await createSwiss(3);

            const denied = await service.drop(id, 2, stranger);
            expect(denied.success).toBe(false);

            const allowed = await service.drop(id, 2, organizer);
            expect(allowed.success).toBe(true);
        });
    });

    describe('lifecycle', function () {
        it('requires the organizer (or site TO) and 2+ players to start', async function () {
            const id = await createSwiss(1);

            expect((await service.start(id, stranger)).success).toBe(false);
            expect((await service.start(id, organizer)).success).toBe(false); // 1 player

            await service.register(id, { id: 2 });
            expect((await service.start(id, siteTo)).success).toBe(true);
        });

        it('creates round 1 pairings with a bye on odd counts', async function () {
            const id = await createSwiss(5);
            await service.start(id, organizer);

            const round1 = db.state.matches.filter((match) => match.Round === 1);
            const byes = round1.filter((match) => !match.Player2Id);

            expect(round1.length).toBe(3); // 2 pairings + 1 bye
            expect(byes.length).toBe(1);
            expect(byes[0].WinnerId).toBe(byes[0].Player1Id); // auto-win
        });

        it('refuses the next round while results are missing, then pairs it', async function () {
            const id = await createSwiss(4, { roundCount: 3 });
            await service.start(id, organizer);

            const blocked = await service.nextRound(id, organizer);
            expect(blocked.success).toBe(false);

            for (const match of db.state.matches.filter((m) => m.Round === 1)) {
                await service.reportResult(id, match.Id, match.Player1Id, organizer);
            }

            const next = await service.nextRound(id, organizer);
            expect(next.success).toBe(true);
            expect(next.round).toBe(2);
            expect(db.state.matches.filter((m) => m.Round === 2).length).toBe(2);
        });

        it('stops swiss at the planned round count', async function () {
            const id = await createSwiss(2, { roundCount: 1 });
            await service.start(id, organizer);

            const match = db.state.matches[0];
            await service.reportResult(id, match.Id, match.Player1Id, organizer);

            const refused = await service.nextRound(id, organizer);
            expect(refused.success).toBe(false);
            expect(refused.message).toMatch(/finish/i);

            expect((await service.finish(id, organizer)).success).toBe(true);
            expect(db.state.tournaments[0].Status).toBe('complete');
        });

        it('single-elim halves the field each round', async function () {
            const created = await service.create(organizer, {
                name: 'Cut to Top',
                format: 'single-elim'
            });
            for (let index = 0; index < 4; index++) {
                await service.register(created.id, { id: index + 1 });
            }
            await service.start(created.id, organizer);

            const round1 = db.state.matches.filter((m) => m.Round === 1);
            expect(round1.length).toBe(2);

            for (const match of round1) {
                await service.reportResult(created.id, match.Id, match.Player1Id, organizer);
            }

            const next = await service.nextRound(created.id, organizer);
            expect(next.success).toBe(true);

            const final = db.state.matches.filter((m) => m.Round === 2);
            expect(final.length).toBe(1);

            const finalists = [final[0].Player1Id, final[0].Player2Id].sort();
            const winners = round1.map((m) => m.WinnerId).sort();
            expect(finalists).toEqual(winners);
        });
    });

    describe('reportResult', function () {
        it('lets participants report open results but not change recorded ones', async function () {
            const id = await createSwiss(2);
            await service.start(id, organizer);
            const match = db.state.matches[0];
            const participant = { id: match.Player1Id, permissions: {} };
            const opponent = { id: match.Player2Id, permissions: {} };

            const denied = await service.reportResult(id, match.Id, match.Player1Id, stranger);
            expect(denied.success).toBe(false);

            const reported = await service.reportResult(id, match.Id, match.Player1Id, participant);
            expect(reported.success).toBe(true);

            const change = await service.reportResult(id, match.Id, opponent.id, opponent);
            expect(change.success).toBe(false);

            const corrected = await service.reportResult(id, match.Id, opponent.id, organizer);
            expect(corrected.success).toBe(true);
        });

        it('rejects winners who are not in the match', async function () {
            const id = await createSwiss(2);
            await service.start(id, organizer);
            const match = db.state.matches[0];

            const result = await service.reportResult(id, match.Id, 777, organizer);
            expect(result.success).toBe(false);
        });
    });

    describe('getDetail', function () {
        it('returns players, matches, standings and actor flags', async function () {
            const id = await createSwiss(4);
            await service.start(id, organizer);

            for (const match of db.state.matches.filter((m) => m.Round === 1)) {
                await service.reportResult(id, match.Id, match.Player1Id, organizer);
            }

            const detail = await service.getDetail(id, { id: 1, permissions: {} });

            expect(detail.success).toBe(true);
            expect(detail.tournament.canManage).toBe(true);
            expect(detail.tournament.isRegistered).toBe(true);
            expect(detail.players.length).toBe(4);
            expect(detail.matches.length).toBe(2);
            expect(detail.standings[0].points).toBe(1);
            expect(detail.standings[0].rank).toBe(1);
        });
    });
});
