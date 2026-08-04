const TournamentService = require('../../../../server/services/tournament/TournamentService');

/**
 * Lightweight in-memory fake of the db module: just enough SQL routing
 * to exercise the service's lifecycle logic end to end. Usernames are
 * derived from ids ("user<N>"); decks and ratings are injectable via
 * state.decks / state.ratings.
 */
const createFakeDb = () => {
    const state = {
        tournaments: [],
        players: [],
        matches: [],
        staff: [],
        matchGames: [],
        decks: [],
        ratings: [],
        nextId: 1
    };

    const playerDefaults = () => ({
        Dropped: false,
        Seed: null,
        DeckId: null,
        CheckedIn: false,
        Waitlisted: false,
        FinalRank: null,
        EventChains: 0
    });

    const db = {
        state,
        query: vi.fn(async (sql, params = []) => {
            // ---- Tournaments -------------------------------------------------
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
                    StartTime: params[7],
                    PlayerCap: params[8],
                    BestOf: params[9],
                    PlayoffBestOf: params[10],
                    CutTo: params[11],
                    SeedMethod: params[12],
                    Visibility: params[13],
                    JoinCode: params[14],
                    RoundTimerMinutes: params[15],
                    RatedGames: params[16],
                    RequireDeckRegistration: params[17],
                    SasMin: params[18],
                    SasMax: params[19],
                    HideDecklists: params[20],
                    GameTimeLimit: params[21],
                    DeckSwapPolicy: params[22],
                    AllowedSets: params[23],
                    RequiredHouses: params[24],
                    BannedHouses: params[25],
                    SasChainHandicap: params[26],
                    ChainsPerMatchWin: params[27],
                    Triad: params[28],
                    Status: 'registration',
                    Stage: 'main',
                    CurrentRound: 0,
                    CheckInOpenedAt: null,
                    Announcement: null,
                    RoundStartedAt: null
                };
                state.tournaments.push(row);
                return [{ Id: row.Id }];
            }

            if (sql.startsWith('SELECT * FROM "Tournaments"')) {
                return state.tournaments.filter((row) => row.Id === params[0]);
            }

            if (sql.includes('UPDATE "Tournaments" SET "Announcement"')) {
                const row = state.tournaments.find((entry) => entry.Id === params[0]);
                if (row) {
                    row.Announcement = params[1];
                }
                return [];
            }

            if (sql.includes('UPDATE "Tournaments" SET "Name"')) {
                const row = state.tournaments.find((entry) => entry.Id === params[0]);
                if (row) {
                    Object.assign(row, {
                        Name: params[1],
                        Description: params[2],
                        Format: params[3],
                        GameFormat: params[4],
                        Mode: params[5],
                        RoundCount: params[6],
                        StartTime: params[7],
                        PlayerCap: params[8],
                        BestOf: params[9],
                        PlayoffBestOf: params[10],
                        CutTo: params[11],
                        SeedMethod: params[12],
                        Visibility: params[13],
                        JoinCode: params[14],
                        RoundTimerMinutes: params[15],
                        RatedGames: params[16],
                        RequireDeckRegistration: params[17],
                        SasMin: params[18],
                        SasMax: params[19],
                        HideDecklists: params[20],
                        GameTimeLimit: params[21],
                        DeckSwapPolicy: params[22],
                        AllowedSets: params[23],
                        RequiredHouses: params[24],
                        BannedHouses: params[25],
                        SasChainHandicap: params[26],
                        ChainsPerMatchWin: params[27],
                        Triad: params[28]
                    });
                }
                return [];
            }

            if (sql.includes('UPDATE "Tournaments" SET "RoundTimerMinutes"')) {
                const row = state.tournaments.find((entry) => entry.Id === params[0]);
                if (row) {
                    row.RoundTimerMinutes = params[1];
                }
                return [];
            }

            if (sql.includes('UPDATE "Tournaments" SET "CheckInOpenedAt"')) {
                const row = state.tournaments.find((entry) => entry.Id === params[0]);
                if (row) {
                    row.CheckInOpenedAt = new Date();
                }
                return [];
            }

            if (sql.includes('UPDATE "Tournaments" SET "Stage" = \'playoff\'')) {
                const row = state.tournaments.find((entry) => entry.Id === params[0]);
                if (row) {
                    row.Stage = 'playoff';
                    row.CurrentRound = params[1];
                    row.RoundCount = params[2];
                    row.RoundStartedAt = new Date();
                    row.RoundEndsAt = row.RoundTimerMinutes
                        ? new Date(Date.now() + row.RoundTimerMinutes * 60 * 1000)
                        : null;
                }
                return [];
            }

            if (sql.includes('UPDATE "Tournaments" SET "RoundCount" = GREATEST')) {
                const row = state.tournaments.find((entry) => entry.Id === params[0]);
                if (row) {
                    row.RoundCount = Math.max(row.RoundCount || 0, params[1]);
                }
                return [];
            }

            // The round clock, adjusted rather than restarted.
            if (sql.includes('SET "RoundEndsAt" = COALESCE')) {
                const row = state.tournaments.find((entry) => entry.Id === params[0]);
                if (row) {
                    const from = row.RoundEndsAt ? row.RoundEndsAt.getTime() : Date.now();
                    row.RoundEndsAt = new Date(from + params[1] * 60 * 1000);
                }
                return [];
            }

            if (sql.includes('UPDATE "Tournaments"')) {
                const row = state.tournaments.find((entry) => entry.Id === params[0]);
                // Starting a round sets its deadline from the event's timer.
                const startClock = () => {
                    row.RoundStartedAt = new Date();
                    row.RoundEndsAt = row.RoundTimerMinutes
                        ? new Date(Date.now() + row.RoundTimerMinutes * 60 * 1000)
                        : null;
                };
                if (row) {
                    if (sql.includes("'active'")) {
                        row.Status = 'active';
                        row.CurrentRound = 1;
                        row.RoundCount = params[1];
                        startClock();
                    } else if (sql.includes("'complete'")) {
                        row.Status = 'complete';
                        row.FinishedAt = new Date();
                    } else if (sql.includes("'cancelled'")) {
                        row.Status = 'cancelled';
                    } else if (sql.includes('"CurrentRound" = $2')) {
                        row.CurrentRound = params[1];
                        startClock();
                    }
                }
                return [];
            }

            if (sql.includes('FROM "Tournaments" t JOIN "Users" u')) {
                let rows = [...state.tournaments];
                let cursor = 0;

                if (sql.includes('t."Status" = $1')) {
                    rows = rows.filter((row) => row.Status === params[0]);
                    cursor = 1;
                }

                if (sql.includes('EXISTS')) {
                    const actorId = params[cursor];
                    rows = rows.filter(
                        (row) =>
                            row.Visibility === 'public' ||
                            row.OrganizerId === actorId ||
                            state.staff.some(
                                (entry) => entry.TournamentId === row.Id && entry.UserId === actorId
                            ) ||
                            state.players.some(
                                (entry) => entry.TournamentId === row.Id && entry.UserId === actorId
                            )
                    );
                } else if (sql.includes(`t."Visibility" = 'public'`)) {
                    rows = rows.filter((row) => row.Visibility === 'public');
                }

                return rows.map((row) => ({
                    ...row,
                    Organizer: `user${row.OrganizerId}`,
                    PlayerCount: String(
                        state.players.filter(
                            (player) => player.TournamentId === row.Id && !player.Waitlisted
                        ).length
                    )
                }));
            }

            // ---- TournamentPlayers ------------------------------------------
            if (sql.includes('INSERT INTO "TournamentPlayers"')) {
                const existing = state.players.find(
                    (player) => player.TournamentId === params[0] && player.UserId === params[1]
                );
                if (existing) {
                    existing.Dropped = false;
                    if (params[3]) {
                        existing.DeckId = params[3];
                    }
                } else {
                    state.players.push({
                        Id: state.nextId++,
                        TournamentId: params[0],
                        UserId: params[1],
                        ...playerDefaults(),
                        Waitlisted: !!params[2],
                        DeckId: params[3] || null,
                        Username: `user${params[1]}`
                    });
                }
                return [];
            }

            if (sql.includes('SELECT COUNT(*) AS "Count" FROM "TournamentPlayers"')) {
                const excludeUser = sql.includes('"UserId" <> $2') ? params[1] : null;
                const count = state.players.filter(
                    (player) =>
                        player.TournamentId === params[0] &&
                        !player.Waitlisted &&
                        (excludeUser === null || player.UserId !== excludeUser)
                ).length;
                return [{ Count: String(count) }];
            }

            if (sql.startsWith('SELECT * FROM "TournamentPlayers"')) {
                return state.players.filter(
                    (player) => player.TournamentId === params[0] && player.UserId === params[1]
                );
            }

            if (sql.includes('UPDATE "TournamentPlayers" SET "DeckId" = NULL')) {
                const player = state.players.find(
                    (entry) => entry.TournamentId === params[0] && entry.UserId === params[1]
                );
                if (player) {
                    player.DeckId = null;
                }
                return [];
            }

            if (sql.includes('UPDATE "TournamentPlayers" SET "DeckId" = $3')) {
                const player = state.players.find(
                    (entry) => entry.TournamentId === params[0] && entry.UserId === params[1]
                );
                if (player) {
                    player.DeckId = params[2];
                }
                return [];
            }

            if (sql.includes('UPDATE "TournamentPlayers" SET "CheckedIn" = true')) {
                const player = state.players.find(
                    (entry) =>
                        entry.TournamentId === params[0] &&
                        entry.UserId === params[1] &&
                        !entry.Dropped
                );
                if (player) {
                    player.CheckedIn = true;
                    return [{ Id: player.Id }];
                }
                return [];
            }

            if (sql.includes('UPDATE "TournamentPlayers" SET "Seed"')) {
                const player = state.players.find(
                    (entry) => entry.TournamentId === params[0] && entry.UserId === params[1]
                );
                if (player) {
                    player.Seed = params[2];
                }
                return [];
            }

            if (sql.includes('UPDATE "TournamentPlayers" SET "Waitlisted" = false WHERE "Id"')) {
                const candidate = state.players
                    .filter(
                        (entry) =>
                            entry.TournamentId === params[0] && entry.Waitlisted && !entry.Dropped
                    )
                    .sort((a, b) => a.Id - b.Id)[0];
                if (candidate) {
                    candidate.Waitlisted = false;
                    return [{ Id: candidate.Id }];
                }
                return [];
            }

            if (sql.includes('UPDATE "TournamentPlayers" SET "Waitlisted" = false')) {
                for (const player of state.players) {
                    if (player.TournamentId === params[0] && player.Waitlisted) {
                        player.Waitlisted = false;
                    }
                }
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

            if (sql.includes('UPDATE "TournamentPlayers" SET "FinalRank"')) {
                const player = state.players.find(
                    (entry) => entry.TournamentId === params[0] && entry.UserId === params[1]
                );
                if (player) {
                    player.FinalRank = params[2];
                }
                return [];
            }

            if (sql.includes('SET "EventChains" = "EventChains" + $3')) {
                const player = state.players.find(
                    (entry) => entry.TournamentId === params[0] && entry.UserId === params[1]
                );
                if (player) {
                    player.EventChains = (player.EventChains || 0) + params[2];
                }
                return [];
            }

            if (sql.includes('DELETE FROM "TournamentPlayerDecks"')) {
                state.playerDecks = (state.playerDecks || []).filter(
                    (entry) => !(entry.TournamentId === params[0] && entry.UserId === params[1])
                );
                return [];
            }

            if (sql.includes('INSERT INTO "TournamentPlayerDecks"')) {
                state.playerDecks = state.playerDecks || [];
                state.playerDecks.push({
                    Id: state.nextId++,
                    TournamentId: params[0],
                    UserId: params[1],
                    DeckId: params[2],
                    Slot: params[3]
                });
                return [];
            }

            if (sql.includes('FROM "TournamentPlayerDecks" tpd JOIN "Decks" du2')) {
                // uniqueness probe across pools
                return (state.playerDecks || [])
                    .filter(
                        (entry) => entry.TournamentId === params[0] && entry.UserId !== params[1]
                    )
                    .map((entry) => state.decks.find((deck) => deck.Id === entry.DeckId))
                    .filter((deck) => deck && deck.Uuid === params[2])
                    .slice(0, 1)
                    .map(() => ({ '?column?': 1 }));
            }

            if (sql.includes('FROM "TournamentPlayerDecks" tpd')) {
                return (state.playerDecks || [])
                    .filter((entry) => entry.TournamentId === params[0])
                    .sort((a, b) => a.UserId - b.UserId || a.Slot - b.Slot)
                    .map((entry) => {
                        const deck = state.decks.find((row) => row.Id === entry.DeckId);
                        return {
                            UserId: entry.UserId,
                            DeckId: entry.DeckId,
                            Slot: entry.Slot,
                            DeckName: deck ? deck.Name : null,
                            DeckUuid: deck ? deck.Uuid : null,
                            SasRating: deck ? deck.SasRating : null
                        };
                    });
            }

            if (sql.includes('FROM "TournamentPlayers" tp JOIN "Decks" du')) {
                // uniqueness probe against single-deck registrations
                return state.players
                    .filter(
                        (player) =>
                            player.TournamentId === params[0] &&
                            player.UserId !== params[1] &&
                            player.DeckId
                    )
                    .map((player) => state.decks.find((deck) => deck.Id === player.DeckId))
                    .filter((deck) => deck && deck.Uuid === params[2])
                    .slice(0, 1)
                    .map(() => ({ '?column?': 1 }));
            }

            if (sql.includes('DELETE FROM "TournamentPlayers"')) {
                state.players = state.players.filter(
                    (player) => !(player.TournamentId === params[0] && player.UserId === params[1])
                );
                return [];
            }

            if (
                sql.includes('FROM "TournamentPlayers" tp') &&
                sql.includes('JOIN "Tournaments" t ON')
            ) {
                // history query
                return state.players
                    .filter((player) => player.Username === params[0])
                    .map((player) => {
                        const tournament = state.tournaments.find(
                            (row) => row.Id === player.TournamentId
                        );
                        return { player, tournament };
                    })
                    .filter(({ tournament }) => tournament && tournament.Status === 'complete')
                    .map(({ player, tournament }) => ({
                        Id: tournament.Id,
                        Name: tournament.Name,
                        Format: tournament.Format,
                        GameFormat: tournament.GameFormat,
                        Mode: tournament.Mode,
                        FinishedAt: tournament.FinishedAt,
                        FinalRank: player.FinalRank,
                        PlayerCount: String(
                            state.players.filter(
                                (entry) => entry.TournamentId === tournament.Id && !entry.Waitlisted
                            ).length
                        )
                    }));
            }

            if (sql.includes('FROM "TournamentPlayers" tp')) {
                return state.players
                    .filter((player) => player.TournamentId === params[0])
                    .sort((a, b) => a.Id - b.Id)
                    .map((player) => {
                        const deck = state.decks.find((entry) => entry.Id === player.DeckId);
                        return {
                            UserId: player.UserId,
                            Dropped: player.Dropped,
                            Seed: player.Seed,
                            DeckId: player.DeckId,
                            CheckedIn: player.CheckedIn,
                            Waitlisted: player.Waitlisted,
                            FinalRank: player.FinalRank,
                            EventChains: player.EventChains || 0,
                            Username: player.Username,
                            DeckName: deck ? deck.Name : null,
                            DeckUuid: deck ? deck.Uuid : null,
                            SasRating: deck ? deck.SasRating : null
                        };
                    });
            }

            // ---- TournamentMatches ------------------------------------------
            if (sql.includes('INSERT INTO "TournamentMatches"')) {
                if (sql.includes('"BracketPos"') && sql.includes('RETURNING')) {
                    // bracket template slot
                    const row = {
                        Id: state.nextId++,
                        TournamentId: params[0],
                        Round: params[1],
                        TableNumber: null,
                        Player1Id: params[2],
                        Player2Id: params[3],
                        WinnerId: params[4],
                        ResultType: params[5],
                        Bracket: params[6],
                        BracketRound: params[7],
                        BracketPos: params[8],
                        P1SourceMatchId: params[9],
                        P1SourceIsLoser: params[10],
                        P2SourceMatchId: params[11],
                        P2SourceIsLoser: params[12],
                        BestOf: params[13],
                        Player1Wins: 0,
                        Player2Wins: 0
                    };
                    state.matches.push(row);
                    return [{ Id: row.Id }];
                }

                if (sql.includes("'GF', 2, 0")) {
                    const row = {
                        Id: state.nextId++,
                        TournamentId: params[0],
                        Round: params[1],
                        TableNumber: null,
                        Player1Id: params[2],
                        Player2Id: params[3],
                        WinnerId: null,
                        ResultType: null,
                        Bracket: 'GF',
                        BracketRound: 2,
                        BracketPos: 0,
                        P1SourceMatchId: null,
                        P1SourceIsLoser: false,
                        P2SourceMatchId: null,
                        P2SourceIsLoser: false,
                        BestOf: params[4],
                        Player1Wins: 0,
                        Player2Wins: 0
                    };
                    state.matches.push(row);
                    return [];
                }

                if (sql.includes("'bye'")) {
                    state.matches.push({
                        Id: state.nextId++,
                        TournamentId: params[0],
                        Round: params[1],
                        TableNumber: null,
                        Player1Id: params[2],
                        Player2Id: null,
                        WinnerId: params[2],
                        ResultType: 'bye',
                        Bracket: null,
                        BracketRound: null,
                        BracketPos: null,
                        P1SourceMatchId: null,
                        P1SourceIsLoser: false,
                        P2SourceMatchId: null,
                        P2SourceIsLoser: false,
                        BestOf: params[3],
                        Player1Wins: 0,
                        Player2Wins: 0
                    });
                    return [];
                }

                state.matches.push({
                    Id: state.nextId++,
                    TournamentId: params[0],
                    Round: params[1],
                    TableNumber: params[2],
                    Player1Id: params[3],
                    Player2Id: params[4],
                    WinnerId: null,
                    ResultType: null,
                    Bracket: null,
                    BracketRound: null,
                    BracketPos: null,
                    P1SourceMatchId: null,
                    P1SourceIsLoser: false,
                    P2SourceMatchId: null,
                    P2SourceIsLoser: false,
                    BestOf: params[5],
                    Player1Wins: 0,
                    Player2Wins: 0
                });
                return [];
            }

            if (sql.includes('SELECT COUNT(*) AS "Unreported"')) {
                const unreported = state.matches.filter(
                    (match) =>
                        match.TournamentId === params[0] &&
                        match.Round === params[1] &&
                        !match.WinnerId &&
                        !match.ResultType
                );
                return [{ Unreported: String(unreported.length) }];
            }

            if (sql.includes('"Bracket" IS NOT NULL LIMIT 1')) {
                return state.matches.some(
                    (match) => match.TournamentId === params[0] && match.Bracket
                )
                    ? [{ '?column?': 1 }]
                    : [];
            }

            if (sql.includes('FROM "TournamentMatches" m')) {
                return state.matches
                    .filter((match) => match.TournamentId === params[0])
                    .sort((a, b) => a.Round - b.Round || a.Id - b.Id)
                    .map((match) => ({
                        ...match,
                        Player1: match.Player1Id ? `user${match.Player1Id}` : null,
                        Player2: match.Player2Id ? `user${match.Player2Id}` : null
                    }));
            }

            if (sql.includes('SELECT * FROM "TournamentMatches"')) {
                return state.matches.filter(
                    (match) => match.Id === params[0] && match.TournamentId === params[1]
                );
            }

            if (sql.includes('SET "WinnerId" = $2, "ResultType" = $3')) {
                const match = state.matches.find((entry) => entry.Id === params[0]);
                if (match) {
                    match.WinnerId = params[1];
                    match.ResultType = params[2];
                    match.ReportedBy = params[3];
                    match.Player1Wins = params[4];
                    match.Player2Wins = params[5];
                    match.ResultSource = params[6];
                    match.ConfirmedBy = params[7];
                    match.ConfirmedAt = params[8];
                    // Writing a result always retires any objection to the
                    // result it replaced.
                    match.DisputedBy = null;
                    match.DisputedAt = null;
                    match.DisputeNote = null;
                    match.ReportedAt = new Date();
                }
                return [];
            }

            if (sql.includes('SET "ConfirmedBy" = $2')) {
                const match = state.matches.find((entry) => entry.Id === params[0]);
                if (match) {
                    match.ConfirmedBy = params[1];
                    match.ConfirmedAt = new Date();
                    match.DisputedBy = null;
                    match.DisputedAt = null;
                    match.DisputeNote = null;
                }
                return [];
            }

            if (sql.includes('SET "DisputedBy" = $2')) {
                const match = state.matches.find((entry) => entry.Id === params[0]);
                if (match) {
                    match.DisputedBy = params[1];
                    match.DisputedAt = new Date();
                    match.DisputeNote = params[2];
                    match.ConfirmedBy = null;
                    match.ConfirmedAt = null;
                }
                return [];
            }

            if (sql.includes(`SET "WinnerId" = $2, "ResultType" = 'bye'`)) {
                const match = state.matches.find((entry) => entry.Id === params[0]);
                if (match) {
                    match.WinnerId = params[1];
                    match.ResultType = 'bye';
                    match.ReportedAt = new Date();
                }
                return [];
            }

            if (sql.includes('SET "WinnerId" = NULL, "ResultType" = NULL')) {
                const match = state.matches.find((entry) => entry.Id === params[0]);
                if (match) {
                    match.WinnerId = null;
                    match.ResultType = null;
                    match.ReportedAt = null;
                }
                return [];
            }

            if (
                sql.includes('SET "P1BannedDeckId"') ||
                sql.includes('SET "P2BannedDeckId"') ||
                sql.includes('SET "P1DeckId"') ||
                sql.includes('SET "P2DeckId"')
            ) {
                const match = state.matches.find((entry) => entry.Id === params[0]);
                if (match) {
                    const column = /SET "(P[12](?:Banned)?DeckId)"/.exec(sql)[1];
                    match[column] = params[1];
                }
                return [];
            }

            if (sql.includes('SET "Player1Wins" = $2, "Player2Wins" = $3')) {
                const match = state.matches.find((entry) => entry.Id === params[0]);
                if (match) {
                    match.Player1Wins = params[1];
                    match.Player2Wins = params[2];
                }
                return [];
            }

            if (sql.includes('SET "Player1Id" = NULL')) {
                const match = state.matches.find((entry) => entry.Id === params[0]);
                if (match) {
                    match.Player1Id = null;
                }
                return [];
            }

            if (sql.includes('SET "Player2Id" = NULL')) {
                const match = state.matches.find((entry) => entry.Id === params[0]);
                if (match) {
                    match.Player2Id = null;
                }
                return [];
            }

            if (sql.includes('SET "Player1Id" = $2')) {
                const match = state.matches.find((entry) => entry.Id === params[0]);
                if (match) {
                    match.Player1Id = params[1];
                }
                return [];
            }

            if (sql.includes('SET "Player2Id" = $2')) {
                const match = state.matches.find((entry) => entry.Id === params[0]);
                if (match) {
                    match.Player2Id = params[1];
                }
                return [];
            }

            // ---- TournamentStaff --------------------------------------------
            if (sql.includes('SELECT 1 FROM "TournamentStaff"')) {
                return state.staff.filter(
                    (entry) => entry.TournamentId === params[0] && entry.UserId === params[1]
                );
            }

            if (sql.includes('FROM "TournamentStaff" ts')) {
                return state.staff
                    .filter((entry) => entry.TournamentId === params[0])
                    .map((entry) => ({
                        UserId: entry.UserId,
                        Role: entry.Role,
                        Username: `user${entry.UserId}`
                    }));
            }

            if (sql.includes('INSERT INTO "TournamentStaff"')) {
                const exists = state.staff.some(
                    (entry) => entry.TournamentId === params[0] && entry.UserId === params[1]
                );
                if (!exists) {
                    state.staff.push({
                        Id: state.nextId++,
                        TournamentId: params[0],
                        UserId: params[1],
                        Role: 'judge'
                    });
                }
                return [];
            }

            if (sql.includes('DELETE FROM "TournamentStaff"')) {
                state.staff = state.staff.filter(
                    (entry) => !(entry.TournamentId === params[0] && entry.UserId === params[1])
                );
                return [];
            }

            // ---- TournamentMatchGames ---------------------------------------
            if (sql.includes('INSERT INTO "TournamentMatchGames"')) {
                const existing = state.matchGames.find(
                    (entry) => entry.MatchId === params[1] && entry.GameNumber === params[2]
                );
                if (existing) {
                    if (!existing.WinnerId) {
                        existing.GameUuid = params[3];
                    }
                } else {
                    state.matchGames.push({
                        Id: state.nextId++,
                        TournamentId: params[0],
                        MatchId: params[1],
                        GameNumber: params[2],
                        GameUuid: params[3],
                        WinnerId: null
                    });
                }
                return [];
            }

            if (sql.includes('UPDATE "TournamentMatchGames" SET "WinnerId"')) {
                const row = state.matchGames.find(
                    (entry) =>
                        entry.MatchId === params[0] &&
                        entry.GameUuid === params[1] &&
                        !entry.WinnerId
                );
                if (row) {
                    row.WinnerId = params[2];
                    return [{ Id: row.Id }];
                }
                return [];
            }

            if (sql.includes('FROM "TournamentMatchGames"')) {
                return state.matchGames
                    .filter((entry) => entry.TournamentId === params[0])
                    .sort((a, b) => a.MatchId - b.MatchId || a.GameNumber - b.GameNumber)
                    .map((entry) => ({ ...entry }));
            }

            // ---- Users / Ratings / Decks ------------------------------------
            if (sql.includes('SELECT "Username" FROM "Users"')) {
                return [{ Username: `user${params[0]}` }];
            }

            if (sql.includes('SELECT "Id" FROM "Users" WHERE "Username"')) {
                const match = /^user(\d+)$/.exec(params[0] || '');
                return match ? [{ Id: parseInt(match[1], 10) }] : [];
            }

            if (sql.includes('FROM "Ratings"')) {
                return state.ratings.filter(
                    (entry) => entry.Pool === params[0] && params[1].includes(entry.UserId)
                );
            }

            if (sql.includes('FROM "Decks" d') && sql.includes('ANY($1)')) {
                return state.decks
                    .filter((deck) => params[0].includes(deck.Id))
                    .map((deck) => ({
                        Id: deck.Id,
                        SasRating: deck.SasRating === undefined ? null : deck.SasRating
                    }));
            }

            if (sql.includes('FROM "Decks" d')) {
                return state.decks
                    .filter((deck) => deck.Id === params[0])
                    .map((deck) => ({
                        Id: deck.Id,
                        UserId: deck.UserId,
                        Name: deck.Name,
                        Uuid: deck.Uuid,
                        ExpansionId: deck.ExpansionId || null,
                        SasRating: deck.SasRating === undefined ? null : deck.SasRating,
                        Houses: deck.Houses ? JSON.stringify(deck.Houses) : null
                    }));
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

    const reportAll = async (id, round, pickWinner = (match) => match.Player1Id) => {
        for (const match of db.state.matches.filter(
            (m) => m.Round === round && m.TournamentId === id && !m.WinnerId && !m.ResultType
        )) {
            await service.reportResult(id, match.Id, pickWinner(match), organizer);
        }
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

        it('validates the extended options', async function () {
            const bad = async (options) =>
                (
                    await service.create(organizer, {
                        name: 'Valid Name',
                        format: 'swiss',
                        ...options
                    })
                ).success;

            expect(await bad({ bestOf: 2 })).toBe(false);
            expect(await bad({ playerCap: 1 })).toBe(false);
            expect(await bad({ sasMin: 90, sasMax: 60 })).toBe(false);
            expect(await bad({ roundTimerMinutes: 2 })).toBe(false);
            expect(await bad({ cutTo: 1 })).toBe(false);
            expect(await bad({ format: 'single-elim', cutTo: 8 })).toBe(false);
            expect(await bad({ seedMethod: 'coin-flip' })).toBe(false);

            const ok = await service.create(organizer, {
                name: 'Big Event',
                format: 'swiss',
                bestOf: 3,
                playerCap: 16,
                cutTo: 4,
                playoffBestOf: 3,
                seedMethod: 'rating',
                roundTimerMinutes: 50,
                visibility: 'private',
                sasMin: 55,
                sasMax: 90
            });
            expect(ok.success).toBe(true);
            expect(db.state.tournaments[0].JoinCode).toHaveLength(8);
        });

        it('supports double-elim and round-robin formats', async function () {
            expect(
                (await service.create(organizer, { name: 'DE Night', format: 'double-elim' }))
                    .success
            ).toBe(true);
            expect(
                (await service.create(organizer, { name: 'RR League', format: 'round-robin' }))
                    .success
            ).toBe(true);
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

        it('waitlists players beyond the cap and promotes them on drops', async function () {
            const id = await createSwiss(2, { playerCap: 2 });

            const third = await service.register(id, { id: 3 });
            expect(third.success).toBe(true);
            expect(third.waitlisted).toBe(true);

            await service.drop(id, null, { id: 2 });

            const promoted = db.state.players.find((player) => player.UserId === 3);
            expect(promoted.Waitlisted).toBe(false);
        });

        it('requires the join code for private events', async function () {
            const created = await service.create(organizer, {
                name: 'Invite Only',
                format: 'swiss',
                visibility: 'private'
            });
            const code = db.state.tournaments[0].JoinCode;

            const noCode = await service.register(created.id, stranger, {});
            expect(noCode.success).toBe(false);

            const wrong = await service.register(created.id, stranger, { joinCode: 'NOPE1234' });
            expect(wrong.success).toBe(false);

            const right = await service.register(created.id, stranger, { joinCode: code });
            expect(right.success).toBe(true);
        });

        it('hides private events from the public list but not from participants', async function () {
            await service.create(organizer, {
                name: 'Invite Only',
                format: 'swiss',
                visibility: 'private'
            });
            const eventId = db.state.tournaments[0].Id;
            await service.register(
                eventId,
                { id: 7 },
                { joinCode: db.state.tournaments[0].JoinCode }
            );

            const anonymous = await service.list(null, null);
            expect(anonymous.length).toBe(0);

            const participant = await service.list(null, { id: 7, permissions: {} });
            expect(participant.length).toBe(1);

            const organizerList = await service.list(null, organizer);
            expect(organizerList.length).toBe(1);
        });
    });

    describe('check-in', function () {
        it('runs the check-in flow and sheds no-shows on start', async function () {
            const id = await createSwiss(4);

            const early = await service.checkIn(id, { id: 1 });
            expect(early.success).toBe(false);

            expect((await service.openCheckIn(id, stranger)).success).toBe(false);
            expect((await service.openCheckIn(id, organizer)).success).toBe(true);

            expect((await service.checkIn(id, { id: 1 })).success).toBe(true);
            expect((await service.checkIn(id, { id: 2 })).success).toBe(true);
            expect((await service.checkIn(id, stranger)).success).toBe(false); // not registered

            const started = await service.start(id, organizer, { dropNoShows: true });
            expect(started.success).toBe(true);

            expect(db.state.players.length).toBe(2);
            expect(db.state.matches.filter((match) => match.Round === 1).length).toBe(1);
        });
    });

    describe('deck registration', function () {
        it('validates ownership and SAS bounds', async function () {
            db.state.decks.push(
                { Id: 11, UserId: 2, Name: 'Mine', Uuid: 'u-11', SasRating: 70 },
                { Id: 12, UserId: 3, Name: 'Not Mine', Uuid: 'u-12', SasRating: 70 },
                { Id: 13, UserId: 2, Name: 'Too Strong', Uuid: 'u-13', SasRating: 95 },
                { Id: 14, UserId: 2, Name: 'No SAS', Uuid: 'u-14', SasRating: null }
            );

            const id = await createSwiss(2, { sasMin: 60, sasMax: 80 });

            expect((await service.registerDeck(id, { id: 2 }, 12)).success).toBe(false);
            expect((await service.registerDeck(id, { id: 2 }, 13)).success).toBe(false);
            expect((await service.registerDeck(id, { id: 2 }, 14)).success).toBe(false);
            expect((await service.registerDeck(id, { id: 2 }, 11)).success).toBe(true);

            const player = db.state.players.find((entry) => entry.UserId === 2);
            expect(player.DeckId).toBe(11);
        });

        it('blocks the start until required decks are registered', async function () {
            db.state.decks.push(
                { Id: 21, UserId: 1, Name: 'One', Uuid: 'u-21', SasRating: 60 },
                { Id: 22, UserId: 2, Name: 'Two', Uuid: 'u-22', SasRating: 65 }
            );

            const id = await createSwiss(2, { requireDeckRegistration: true });

            const blocked = await service.start(id, organizer);
            expect(blocked.success).toBe(false);
            expect(blocked.message).toMatch(/user1/);

            await service.registerDeck(id, { id: 1 }, 21);
            await service.registerDeck(id, { id: 2 }, 22);

            expect((await service.start(id, organizer)).success).toBe(true);
        });

        it('locks decks once the event starts', async function () {
            db.state.decks.push({ Id: 31, UserId: 1, Name: 'One', Uuid: 'u-31', SasRating: 60 });

            const id = await createSwiss(2);
            await service.start(id, organizer);

            expect((await service.registerDeck(id, { id: 1 }, 31)).success).toBe(false);
        });
    });

    describe('staff', function () {
        it('staff can manage the event but not its staff list', async function () {
            const id = await createSwiss(4);

            expect((await service.addStaff(id, stranger, 'user7')).success).toBe(false);
            expect((await service.addStaff(id, organizer, 'user7')).success).toBe(true);

            const judge = { id: 7, permissions: {} };
            expect(
                (await service.updateSettings(id, judge, { announcement: 'Round soon' })).success
            ).toBe(true);
            expect((await service.addStaff(id, judge, 'user8')).success).toBe(false);

            await service.removeStaff(id, organizer, 7);
            expect(
                (await service.updateSettings(id, judge, { announcement: 'Nope' })).success
            ).toBe(false);
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

        it('folds the seeded first round (top half vs bottom half)', async function () {
            const id = await createSwiss(4);
            await service.start(id, organizer);

            const round1 = db.state.matches.filter((match) => match.Round === 1);
            const asSets = round1.map((match) =>
                [match.Player1Id, match.Player2Id].sort().join('-')
            );

            expect(asSets).toContain('1-3');
            expect(asSets).toContain('2-4');
        });

        it('refuses the next round while results are missing, then pairs it', async function () {
            const id = await createSwiss(4, { roundCount: 3 });
            await service.start(id, organizer);

            const blocked = await service.nextRound(id, organizer);
            expect(blocked.success).toBe(false);

            await reportAll(id, 1);

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

        it('single-elim builds a full bracket and fills it from results', async function () {
            const created = await service.create(organizer, {
                name: 'Cut to Top',
                format: 'single-elim'
            });
            for (let index = 0; index < 4; index++) {
                await service.register(created.id, { id: index + 1 });
            }
            await service.start(created.id, organizer);

            const round1 = db.state.matches.filter((m) => m.Round === 1);
            const final = db.state.matches.find((m) => m.Round === 2);

            expect(round1.length).toBe(2);
            expect(final).toBeTruthy();
            expect(final.Player1Id).toBeNull(); // waits on sources
            expect(final.P1SourceMatchId).toBe(round1[0].Id);

            // Standard seeding: 1 v 4, 2 v 3.
            expect([round1[0].Player1Id, round1[0].Player2Id]).toEqual([1, 4]);
            expect([round1[1].Player1Id, round1[1].Player2Id]).toEqual([2, 3]);

            await reportAll(created.id, 1);

            expect(final.Player1Id).toBe(round1[0].WinnerId);
            expect(final.Player2Id).toBe(round1[1].WinnerId);

            const next = await service.nextRound(created.id, organizer);
            expect(next.success).toBe(true);
            expect(next.round).toBe(2);
        });

        it('gives bracket byes a walkover and pre-fills the next round', async function () {
            const created = await service.create(organizer, {
                name: 'Odd Cut',
                format: 'single-elim'
            });
            for (let index = 0; index < 3; index++) {
                await service.register(created.id, { id: index + 1 });
            }
            await service.start(created.id, organizer);

            const walkover = db.state.matches.find((m) => m.ResultType === 'bye');
            expect(walkover).toBeTruthy();
            expect(walkover.WinnerId).toBe(1); // top seed walks over

            const final = db.state.matches.find((m) => m.Round === 2);
            expect(final.Player1Id).toBe(1); // pre-filled from the walkover
        });

        it('round robin schedules every pairing up front', async function () {
            const created = await service.create(organizer, {
                name: 'League Night',
                format: 'round-robin'
            });
            for (let index = 0; index < 4; index++) {
                await service.register(created.id, { id: index + 1 });
            }
            await service.start(created.id, organizer);

            expect(db.state.tournaments[0].RoundCount).toBe(3);
            expect(db.state.matches.length).toBe(6);

            const uniquePairs = db.state.matches
                .map((m) => [m.Player1Id, m.Player2Id].sort().join('-'))
                .filter((pair, index, all) => all.indexOf(pair) === index);
            expect(uniquePairs.length).toBe(6);

            await reportAll(created.id, 1);
            const next = await service.nextRound(created.id, organizer);
            expect(next.success).toBe(true);
            expect(next.round).toBe(2);

            // No new matches were created - the schedule already existed.
            expect(db.state.matches.length).toBe(6);
        });
    });

    describe('double elimination', function () {
        const setupFour = async () => {
            const created = await service.create(organizer, {
                name: 'DE Weekly',
                format: 'double-elim'
            });
            for (let index = 0; index < 4; index++) {
                await service.register(created.id, { id: index + 1 });
            }
            await service.start(created.id, organizer);
            return created.id;
        };

        it('runs winners, losers and grand final waves', async function () {
            const id = await setupFour();

            const w1 = db.state.matches.filter((m) => m.Bracket === 'W' && m.BracketRound === 1);
            expect(w1.length).toBe(2);

            // W1: 1 beats 4, 2 beats 3.
            await service.reportResult(id, w1[0].Id, 1, organizer);
            await service.reportResult(id, w1[1].Id, 2, organizer);

            expect((await service.nextRound(id, organizer)).round).toBe(2);

            const w2 = db.state.matches.find((m) => m.Bracket === 'W' && m.BracketRound === 2);
            const l1 = db.state.matches.find((m) => m.Bracket === 'L' && m.BracketRound === 1);

            expect([w2.Player1Id, w2.Player2Id]).toEqual([1, 2]);
            expect([l1.Player1Id, l1.Player2Id].sort()).toEqual([3, 4]);

            // W2: 1 beats 2 (2 drops to L final); L1: 3 beats 4.
            await service.reportResult(id, w2.Id, 1, organizer);
            await service.reportResult(id, l1.Id, 3, organizer);

            expect((await service.nextRound(id, organizer)).round).toBe(3);

            const l2 = db.state.matches.find((m) => m.Bracket === 'L' && m.BracketRound === 2);
            expect([l2.Player1Id, l2.Player2Id].sort()).toEqual([2, 3]);

            // L final: 2 beats 3 and reaches the grand final.
            await service.reportResult(id, l2.Id, 2, organizer);
            expect((await service.nextRound(id, organizer)).round).toBe(4);

            const gf = db.state.matches.find((m) => m.Bracket === 'GF');
            expect([gf.Player1Id, gf.Player2Id]).toEqual([1, 2]);

            // Winners champion takes GF1 - no reset.
            await service.reportResult(id, gf.Id, 1, organizer);
            expect(
                db.state.matches.filter((m) => m.Bracket === 'GF' && m.BracketRound === 2).length
            ).toBe(0);

            expect((await service.finish(id, organizer)).success).toBe(true);

            const ranks = Object.fromEntries(
                db.state.players.map((player) => [player.UserId, player.FinalRank])
            );
            expect(ranks[1]).toBe(1);
            expect(ranks[2]).toBe(2);
            expect(ranks[3]).toBe(3);
            expect(ranks[4]).toBe(4);
        });

        it('creates the grand final reset when the losers champion wins GF1', async function () {
            const id = await setupFour();

            const w1 = db.state.matches.filter((m) => m.Bracket === 'W' && m.BracketRound === 1);
            await service.reportResult(id, w1[0].Id, 1, organizer);
            await service.reportResult(id, w1[1].Id, 2, organizer);
            await service.nextRound(id, organizer);

            const w2 = db.state.matches.find((m) => m.Bracket === 'W' && m.BracketRound === 2);
            const l1 = db.state.matches.find((m) => m.Bracket === 'L' && m.BracketRound === 1);
            await service.reportResult(id, w2.Id, 1, organizer);
            await service.reportResult(id, l1.Id, 3, organizer);
            await service.nextRound(id, organizer);

            const l2 = db.state.matches.find((m) => m.Bracket === 'L' && m.BracketRound === 2);
            await service.reportResult(id, l2.Id, 2, organizer);
            await service.nextRound(id, organizer);

            const gf = db.state.matches.find((m) => m.Bracket === 'GF');
            await service.reportResult(id, gf.Id, 2, organizer); // losers side wins

            const gf2 = db.state.matches.find((m) => m.Bracket === 'GF' && m.BracketRound === 2);
            expect(gf2).toBeTruthy();
            expect([gf2.Player1Id, gf2.Player2Id]).toEqual([1, 2]);

            // Cannot finish until the reset resolves.
            expect((await service.finish(id, organizer)).success).toBe(false);

            await service.nextRound(id, organizer);
            await service.reportResult(id, gf2.Id, 2, organizer);

            expect((await service.finish(id, organizer)).success).toBe(true);

            const ranks = Object.fromEntries(
                db.state.players.map((player) => [player.UserId, player.FinalRank])
            );
            expect(ranks[2]).toBe(1);
            expect(ranks[1]).toBe(2);
        });

        it('cascades byes through the losers bracket at runtime (3 players)', async function () {
            const created = await service.create(organizer, {
                name: 'Odd DE',
                format: 'double-elim'
            });
            for (let index = 0; index < 3; index++) {
                await service.register(created.id, { id: index + 1 });
            }
            await service.start(created.id, organizer);

            // Seed 1 walks over W1-0; the L1 slot fed by that walkover's
            // "loser" stays a pending walkover until W1-1 resolves.
            const w11 = db.state.matches.find(
                (m) => m.Bracket === 'W' && m.BracketRound === 1 && m.Player2Id
            );
            await service.reportResult(created.id, w11.Id, 2, organizer);

            // Loser of W1-1 (3) advances through L1 as a walkover.
            const l1 = db.state.matches.find((m) => m.Bracket === 'L' && m.BracketRound === 1);
            expect(l1.Player1Id).toBe(3);
            expect(l1.ResultType).toBe('bye');
            expect(l1.WinnerId).toBe(3);

            expect((await service.nextRound(created.id, organizer)).round).toBe(2);

            const w2 = db.state.matches.find((m) => m.Bracket === 'W' && m.BracketRound === 2);
            expect([w2.Player1Id, w2.Player2Id]).toEqual([1, 2]);
            await service.reportResult(created.id, w2.Id, 1, organizer);

            expect((await service.nextRound(created.id, organizer)).round).toBe(3);

            const l2 = db.state.matches.find((m) => m.Bracket === 'L' && m.BracketRound === 2);
            expect([l2.Player1Id, l2.Player2Id].sort()).toEqual([2, 3]);
            await service.reportResult(created.id, l2.Id, 3, organizer);

            expect((await service.nextRound(created.id, organizer)).round).toBe(4);

            const gf = db.state.matches.find((m) => m.Bracket === 'GF');
            expect([gf.Player1Id, gf.Player2Id]).toEqual([1, 3]);
            await service.reportResult(created.id, gf.Id, 1, organizer);

            expect((await service.finish(created.id, organizer)).success).toBe(true);

            const ranks = Object.fromEntries(
                db.state.players.map((player) => [player.UserId, player.FinalRank])
            );
            expect(ranks[1]).toBe(1);
            expect(ranks[3]).toBe(2);
            expect(ranks[2]).toBe(3);
        });
    });

    describe('playoff cut', function () {
        it('cuts a finished swiss stage to a seeded single-elim playoff', async function () {
            const id = await createSwiss(4, { roundCount: 2, cutTo: 2, playoffBestOf: 3 });
            await service.start(id, organizer);

            const early = await service.cutToPlayoff(id, organizer);
            expect(early.success).toBe(false);

            await reportAll(id, 1);
            await service.nextRound(id, organizer);
            await reportAll(id, 2);

            const refusedNext = await service.nextRound(id, organizer);
            expect(refusedNext.success).toBe(false);
            expect(refusedNext.message).toMatch(/cut/i);

            const cut = await service.cutToPlayoff(id, organizer);
            expect(cut.success).toBe(true);
            expect(cut.cutSize).toBe(2);

            expect(db.state.tournaments[0].Stage).toBe('playoff');

            const playoff = db.state.matches.find((m) => m.Bracket === 'W' && m.Round === 3);
            expect(playoff).toBeTruthy();
            expect(playoff.BestOf).toBe(3);

            const reported = await service.reportResult(
                id,
                playoff.Id,
                playoff.Player1Id,
                organizer,
                { player1Wins: 2, player2Wins: 1 }
            );
            expect(reported.success).toBe(true);

            expect((await service.finish(id, organizer)).success).toBe(true);

            const champion = db.state.players.find((player) => player.UserId === playoff.Player1Id);
            expect(champion.FinalRank).toBe(1);
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

        it('validates best-of series scores', async function () {
            const id = await createSwiss(2, { bestOf: 3 });
            await service.start(id, organizer);
            const match = db.state.matches[0];

            const short = await service.reportResult(id, match.Id, match.Player1Id, organizer, {
                player1Wins: 1,
                player2Wins: 0
            });
            expect(short.success).toBe(false);

            const both = await service.reportResult(id, match.Id, match.Player1Id, organizer, {
                player1Wins: 2,
                player2Wins: 2
            });
            expect(both.success).toBe(false);

            const ok = await service.reportResult(id, match.Id, match.Player1Id, organizer, {
                player1Wins: 2,
                player2Wins: 1
            });
            expect(ok.success).toBe(true);
            expect(match.Player1Wins).toBe(2);
            expect(match.Player2Wins).toBe(1);
        });

        it('locks corrected bracket results once later matches are played', async function () {
            const created = await service.create(organizer, {
                name: 'Bracket Lock',
                format: 'single-elim'
            });
            for (let index = 0; index < 4; index++) {
                await service.register(created.id, { id: index + 1 });
            }
            await service.start(created.id, organizer);

            const round1 = db.state.matches.filter((m) => m.Round === 1);
            await reportAll(created.id, 1);
            await service.nextRound(created.id, organizer);

            // Correcting round 1 is fine while the final is unplayed...
            const correct = await service.reportResult(
                created.id,
                round1[0].Id,
                round1[0].Player2Id,
                organizer
            );
            expect(correct.success).toBe(true);

            const final = db.state.matches.find((m) => m.Round === 2);
            expect(final.Player1Id).toBe(round1[0].WinnerId); // re-propagated

            await service.reportResult(created.id, final.Id, final.Player1Id, organizer);

            // ...but locked once the final has a played result.
            const locked = await service.reportResult(
                created.id,
                round1[0].Id,
                round1[0].Player1Id,
                organizer
            );
            expect(locked.success).toBe(false);
        });
    });

    describe('organizer tools', function () {
        it('awards forfeit and no-show wins', async function () {
            const id = await createSwiss(4);
            await service.start(id, organizer);
            const match = db.state.matches.find((m) => m.Player2Id);

            expect((await service.awardWin(id, match.Id, match.Player1Id, stranger)).success).toBe(
                false
            );

            const award = await service.awardWin(
                id,
                match.Id,
                match.Player1Id,
                organizer,
                'no-show'
            );
            expect(award.success).toBe(true);
            expect(match.WinnerId).toBe(match.Player1Id);
            expect(match.ResultType).toBe('no-show');

            const again = await service.awardWin(id, match.Id, match.Player2Id, organizer);
            expect(again.success).toBe(false); // already decided
        });

        it('records double losses in swiss but never in brackets', async function () {
            const id = await createSwiss(4);
            await service.start(id, organizer);
            const match = db.state.matches.find((m) => m.Player2Id);

            const result = await service.doubleLoss(id, match.Id, organizer);
            expect(result.success).toBe(true);
            expect(match.WinnerId).toBeNull();
            expect(match.ResultType).toBe('double-loss');

            const bracket = await service.create(organizer, {
                name: 'No Double Loss',
                format: 'single-elim'
            });
            await service.register(bracket.id, { id: 1 });
            await service.register(bracket.id, { id: 2 });
            await service.start(bracket.id, organizer);

            const bracketMatch = db.state.matches.find(
                (m) => m.TournamentId === bracket.id && m.Bracket
            );
            expect((await service.doubleLoss(bracket.id, bracketMatch.Id, organizer)).success).toBe(
                false
            );
        });

        it('forfeits open matches when a player drops mid-event', async function () {
            const id = await createSwiss(4);
            await service.start(id, organizer);

            const match = db.state.matches.find((m) => m.Player2Id);
            await service.drop(id, null, { id: match.Player1Id });

            expect(match.WinnerId).toBe(match.Player2Id);
            expect(match.ResultType).toBe('forfeit');
        });
    });

    /**
     * Before this, any participant could type in any result on their own
     * match and it was final - the opponent's only recourse was to find the
     * organizer, and nothing in the record showed they had never agreed.
     */
    describe('result confirmation', function () {
        // Deliberately not ids 1 and 2: the organizer is user 1, and an
        // organizer who is also a player would be adjudicating their own
        // match, which is the one case these rules do not cover.
        const playerOne = { id: 10, permissions: {} };
        const playerTwo = { id: 11, permissions: {} };

        const liveMatch = async () => {
            const created = await service.create(organizer, {
                name: 'Confirmation',
                format: 'swiss'
            });
            await service.register(created.id, playerOne);
            await service.register(created.id, playerTwo);
            await service.start(created.id, organizer);

            return { id: created.id, match: db.state.matches[0] };
        };

        it('takes a player at their word when they report their own loss', async function () {
            const { id, match } = await liveMatch();

            const result = await service.reportResult(id, match.Id, playerTwo.id, playerOne);

            expect(result.success).toBe(true);
            expect(result.confirmed).toBe(true);
            expect(db.state.matches[0].ConfirmedBy).toBe(playerOne.id);
        });

        it('leaves a self-reported win waiting for the opponent', async function () {
            const { id, match } = await liveMatch();

            const result = await service.reportResult(id, match.Id, playerOne.id, playerOne);

            expect(result.success).toBe(true);
            expect(result.confirmed).toBe(false);
            // It still counts - withholding the standings would hand any
            // sore loser a veto over the round.
            expect(db.state.matches[0].WinnerId).toBe(playerOne.id);
            expect(db.state.matches[0].ConfirmedAt).toBe(null);
        });

        it('lets the opponent confirm it', async function () {
            const { id, match } = await liveMatch();
            await service.reportResult(id, match.Id, playerOne.id, playerOne);

            const confirmed = await service.confirmResult(id, match.Id, playerTwo);

            expect(confirmed.success).toBe(true);
            expect(db.state.matches[0].ConfirmedBy).toBe(playerTwo.id);
        });

        it('will not let the reporter confirm their own report', async function () {
            const { id, match } = await liveMatch();
            await service.reportResult(id, match.Id, playerOne.id, playerOne);

            const selfConfirm = await service.confirmResult(id, match.Id, playerOne);

            expect(selfConfirm.success).toBe(false);
            expect(db.state.matches[0].ConfirmedAt).toBe(null);
        });

        it('lets the opponent dispute it without reversing anything', async function () {
            const { id, match } = await liveMatch();
            await service.reportResult(id, match.Id, playerOne.id, playerOne);

            const disputed = await service.disputeResult(id, match.Id, playerTwo, 'I won 2-1');

            expect(disputed.success).toBe(true);
            expect(db.state.matches[0].DisputedBy).toBe(playerTwo.id);
            expect(db.state.matches[0].DisputeNote).toBe('I won 2-1');
            // A dispute is a claim, not a ruling: the recorded result stands
            // until an organizer changes it.
            expect(db.state.matches[0].WinnerId).toBe(playerOne.id);
        });

        it('clears the dispute when the organizer records the real result', async function () {
            const { id, match } = await liveMatch();
            await service.reportResult(id, match.Id, playerOne.id, playerOne);
            await service.disputeResult(id, match.Id, playerTwo, 'I won 2-1');

            await service.reportResult(id, match.Id, playerTwo.id, organizer);

            expect(db.state.matches[0].WinnerId).toBe(playerTwo.id);
            expect(db.state.matches[0].DisputedBy).toBe(null);
            expect(db.state.matches[0].ConfirmedBy).toBe(organizer.id);
        });

        it('keeps outsiders out of both', async function () {
            const { id, match } = await liveMatch();
            await service.reportResult(id, match.Id, playerOne.id, playerOne);

            expect((await service.confirmResult(id, match.Id, stranger)).success).toBe(false);
            expect((await service.disputeResult(id, match.Id, stranger, 'x')).success).toBe(false);
        });

        it('has nothing to confirm before a result exists', async function () {
            const { id, match } = await liveMatch();

            expect((await service.confirmResult(id, match.Id, playerTwo)).success).toBe(false);
            expect((await service.disputeResult(id, match.Id, playerTwo, 'x')).success).toBe(false);
        });

        it('treats an organizer entry as adjudicated on the spot', async function () {
            const { id, match } = await liveMatch();

            await service.reportResult(id, match.Id, playerOne.id, organizer);

            expect(db.state.matches[0].ConfirmedBy).toBe(organizer.id);
        });

        it('reports confirmation state on the detail payload', async function () {
            const { id, match } = await liveMatch();
            await service.reportResult(id, match.Id, playerOne.id, playerOne);

            const detail = await service.getDetail(id, playerTwo);
            const row = detail.matches.find((entry) => entry.id === match.Id);

            expect(row.confirmed).toBe(false);
            expect(row.reportedBy).toBe(playerOne.id);
        });
    });

    /**
     * The round clock used to be a picture of a clock, while pairing the next
     * round refuses to run with a result missing. One player closing their
     * laptop stopped the event permanently.
     */
    describe('round clock', function () {
        it('gives the round a deadline from the event timer', async function () {
            const id = await createSwiss(2, { roundTimerMinutes: 50 });
            await service.start(id, organizer);

            const row = db.state.tournaments[0];

            expect(row.RoundEndsAt).toBeTruthy();
            expect(row.RoundEndsAt.getTime()).toBeGreaterThan(Date.now() + 49 * 60 * 1000);
        });

        it('leaves the deadline unset when the event has no timer', async function () {
            const id = await createSwiss(2);
            await service.start(id, organizer);

            expect(db.state.tournaments[0].RoundEndsAt).toBe(null);
        });

        it('extends the current round without restarting it', async function () {
            const id = await createSwiss(2, { roundTimerMinutes: 50 });
            await service.start(id, organizer);

            const before = db.state.tournaments[0].RoundEndsAt.getTime();
            const extended = await service.adjustRoundClock(id, organizer, 5);

            expect(extended.success).toBe(true);
            expect(db.state.tournaments[0].RoundEndsAt.getTime()).toBe(before + 5 * 60 * 1000);
        });

        it('only the organizer can move the clock', async function () {
            const id = await createSwiss(2, { roundTimerMinutes: 50 });
            await service.start(id, organizer);

            expect((await service.adjustRoundClock(id, stranger, 5)).success).toBe(false);
        });

        it('awards an unfinished match to whoever leads on games', async function () {
            const id = await createSwiss(2, { bestOf: 3 });
            await service.start(id, organizer);

            const match = db.state.matches[0];
            match.Player1Wins = 1;
            match.Player2Wins = 0;

            const resolved = await service.resolveUnfinished(id, organizer);

            expect(resolved.success).toBe(true);
            expect(resolved.resolved).toBe(1);
            expect(db.state.matches[0].WinnerId).toBe(match.Player1Id);
            expect(db.state.matches[0].ResultType).toBe('time');
        });

        it('makes a level unfinished match a draw', async function () {
            const id = await createSwiss(2, { bestOf: 3 });
            await service.start(id, organizer);

            await service.resolveUnfinished(id, organizer);

            expect(db.state.matches[0].ResultType).toBe('double-loss');
            expect(db.state.matches[0].WinnerId).toBe(null);
        });

        it('unblocks the next round', async function () {
            const id = await createSwiss(4, { roundCount: 2 });
            await service.start(id, organizer);

            // One table reports; the other never does.
            const first = db.state.matches.filter((match) => match.Round === 1)[0];
            await service.reportResult(id, first.Id, first.Player1Id, organizer);

            expect((await service.nextRound(id, organizer)).success).toBe(false);

            await service.resolveUnfinished(id, organizer);

            expect((await service.nextRound(id, organizer)).success).toBe(true);
        });

        it('will not invent a bracket winner from a level match', async function () {
            const created = await service.create(organizer, {
                name: 'Cut',
                format: 'single-elim'
            });
            for (let index = 0; index < 4; index++) {
                await service.register(created.id, { id: index + 1 });
            }
            await service.start(created.id, organizer);

            const resolved = await service.resolveUnfinished(created.id, organizer);

            // Somebody has to advance, and it is not the clock's call.
            expect(resolved.success).toBe(true);
            expect(resolved.resolved).toBe(0);
            expect(resolved.undecidable.length).toBe(2);
        });

        it('only the organizer can call time', async function () {
            const id = await createSwiss(2);
            await service.start(id, organizer);

            expect((await service.resolveUnfinished(id, stranger)).success).toBe(false);
        });
    });

    describe('online automation', function () {
        it('lists matches needing games and attaches created ones', async function () {
            db.state.decks.push(
                { Id: 41, UserId: 1, Name: 'One', Uuid: 'u-41', SasRating: 61 },
                { Id: 42, UserId: 2, Name: 'Two', Uuid: 'u-42', SasRating: 62 }
            );

            const id = await createSwiss(2, { bestOf: 3 });
            await service.registerDeck(id, { id: 1 }, 41);
            await service.registerDeck(id, { id: 2 }, 42);
            await service.start(id, organizer);

            const needing = await service.getMatchesNeedingGames(id);
            expect(needing.length).toBe(1);
            expect(needing[0].gameNumber).toBe(1);
            expect(needing[0].bestOf).toBe(3);
            expect(needing[0].players.map((player) => player.deckId).sort()).toEqual([41, 42]);

            await service.attachGame(id, needing[0].matchId, 1, 'game-uuid-1');

            const after = await service.getMatchesNeedingGames(id);
            expect(after[0].knownGameUuids).toContain('game-uuid-1');
        });

        it('auto-reports series games from GAMEWIN and completes the match', async function () {
            const id = await createSwiss(2, { bestOf: 3 });
            await service.start(id, organizer);
            const match = db.state.matches[0];

            await service.attachGame(id, match.Id, 1, 'g1');

            const first = await service.recordGameWin({
                gameId: 'g1',
                winner: `user${match.Player1Id}`,
                tournament: { tournamentId: id, matchId: match.Id }
            });
            expect(first.handled).toBe(true);
            expect(first.matchComplete).toBe(false);
            expect(first.nextGameNumber).toBe(2);

            // A duplicate GAMEWIN for the same game is ignored.
            const dup = await service.recordGameWin({
                gameId: 'g1',
                winner: `user${match.Player1Id}`,
                tournament: { tournamentId: id, matchId: match.Id }
            });
            expect(dup.duplicate).toBe(true);
            expect(match.Player1Wins).toBe(1);

            await service.attachGame(id, match.Id, 2, 'g2');
            const second = await service.recordGameWin({
                gameId: 'g2',
                winner: `user${match.Player1Id}`,
                tournament: { tournamentId: id, matchId: match.Id }
            });
            expect(second.matchComplete).toBe(true);
            expect(match.WinnerId).toBe(match.Player1Id);
            expect(match.ResultType).toBe('played');
            expect(match.Player1Wins).toBe(2);
        });

        it('ignores GAMEWIN for decided matches and unknown winners', async function () {
            const id = await createSwiss(2);
            await service.start(id, organizer);
            const match = db.state.matches[0];

            await service.attachGame(id, match.Id, 1, 'g1');
            await service.reportResult(id, match.Id, match.Player1Id, organizer);

            const late = await service.recordGameWin({
                gameId: 'g1',
                winner: `user${match.Player2Id}`,
                tournament: { tournamentId: id, matchId: match.Id }
            });
            expect(late.handled).toBe(false);
        });
    });

    describe('completion', function () {
        it('stamps final ranks and serves player history', async function () {
            const id = await createSwiss(4, { roundCount: 1 });
            await service.start(id, organizer);
            await reportAll(id, 1);

            await service.finish(id, organizer);

            const ranks = db.state.players.map((player) => player.FinalRank).sort();
            expect(ranks).toEqual([1, 2, 3, 4]);

            const winner = db.state.players.find((player) => player.FinalRank === 1);
            const history = await service.history(`user${winner.UserId}`);

            expect(history.length).toBe(1);
            expect(history[0].finalRank).toBe(1);
            expect(history[0].playerCount).toBe(4);
        });
    });

    describe('KeyForge deck rules', function () {
        it('validates create options for the KeyForge conditions', async function () {
            const bad = async (options) =>
                (
                    await service.create(organizer, {
                        name: 'Valid Name',
                        format: 'swiss',
                        ...options
                    })
                ).success;

            expect(await bad({ gameFormat: 'ladder' })).toBe(false);
            expect(await bad({ deckSwapPolicy: 'anytime' })).toBe(false);
            expect(await bad({ requiredHouses: ['atlantis'] })).toBe(false);
            expect(await bad({ requiredHouses: ['dis'], bannedHouses: ['dis'] })).toBe(false);
            expect(await bad({ chainsPerMatchWin: 9 })).toBe(false);
            expect(await bad({ triad: true, deckSwapPolicy: 'between-rounds' })).toBe(false);
            expect(await bad({ gameFormat: 'sealed', triad: true })).toBe(false);

            const ok = await service.create(organizer, {
                name: 'Reversal Chains',
                format: 'swiss',
                gameFormat: 'reversal',
                deckSwapPolicy: 'between-rounds',
                allowedSets: [341, 435],
                bannedHouses: ['dis'],
                sasChainHandicap: true,
                chainsPerMatchWin: 1
            });
            expect(ok.success).toBe(true);

            const row = db.state.tournaments.find((entry) => entry.Id === ok.id);
            expect(JSON.parse(row.AllowedSets)).toEqual([341, 435]);
            expect(JSON.parse(row.BannedHouses)).toEqual(['dis']);
        });

        it('enforces set legality and house conditions on decks', async function () {
            db.state.decks.push(
                {
                    Id: 61,
                    UserId: 2,
                    Name: 'CotA Dis',
                    Uuid: 'u-61',
                    ExpansionId: 341,
                    SasRating: 65,
                    Houses: ['dis', 'logos', 'shadows']
                },
                {
                    Id: 62,
                    UserId: 2,
                    Name: 'WC Brobnar',
                    Uuid: 'u-62',
                    ExpansionId: 452,
                    SasRating: 66,
                    Houses: ['brobnar', 'logos', 'untamed']
                },
                {
                    Id: 63,
                    UserId: 2,
                    Name: 'CotA Brobnar',
                    Uuid: 'u-63',
                    ExpansionId: 341,
                    SasRating: 67,
                    Houses: ['brobnar', 'sanctum', 'untamed']
                }
            );

            const id = await createSwiss(2, {
                allowedSets: [341],
                bannedHouses: ['dis'],
                requiredHouses: ['brobnar']
            });

            // Wrong set
            expect((await service.registerDeck(id, { id: 2 }, 62)).success).toBe(false);
            // Banned house
            expect((await service.registerDeck(id, { id: 2 }, 61)).success).toBe(false);
            // Legal: CotA, has brobnar, no dis
            expect((await service.registerDeck(id, { id: 2 }, 63)).success).toBe(true);
        });

        it('rejects the same physical Archon registered by two players', async function () {
            db.state.decks.push(
                { Id: 71, UserId: 1, Name: 'Same Deck', Uuid: 'shared-uuid', SasRating: 60 },
                { Id: 72, UserId: 2, Name: 'Same Deck', Uuid: 'shared-uuid', SasRating: 60 }
            );

            const id = await createSwiss(2);

            expect((await service.registerDeck(id, { id: 1 }, 71)).success).toBe(true);

            const clash = await service.registerDeck(id, { id: 2 }, 72);
            expect(clash.success).toBe(false);
            expect(clash.message).toMatch(/already registered/i);
        });

        it('locks decks mid-event unless the swap policy allows changes', async function () {
            db.state.decks.push(
                { Id: 81, UserId: 1, Name: 'First', Uuid: 'u-81', SasRating: 60 },
                { Id: 82, UserId: 1, Name: 'Second', Uuid: 'u-82', SasRating: 61 }
            );

            const locked = await createSwiss(2);
            await service.registerDeck(locked, { id: 1 }, 81);
            await service.start(locked, organizer);
            expect((await service.registerDeck(locked, { id: 1 }, 82)).success).toBe(false);

            db.state.decks.push(
                { Id: 83, UserId: 3, Name: 'Third', Uuid: 'u-83', SasRating: 62 },
                { Id: 84, UserId: 3, Name: 'Fourth', Uuid: 'u-84', SasRating: 63 }
            );

            const open = await service.create(organizer, {
                name: 'Swappable',
                format: 'swiss',
                deckSwapPolicy: 'between-rounds'
            });
            await service.register(open.id, { id: 3 });
            await service.register(open.id, { id: 4 });
            await service.registerDeck(open.id, { id: 3 }, 83);
            await service.start(open.id, organizer);

            expect((await service.registerDeck(open.id, { id: 3 }, 84)).success).toBe(true);

            const player = db.state.players.find(
                (entry) => entry.TournamentId === open.id && entry.UserId === 3
            );
            expect(player.DeckId).toBe(84);
        });
    });

    describe('chains', function () {
        it('computes SAS handicap starting chains for the stronger deck', async function () {
            db.state.decks.push(
                { Id: 91, UserId: 1, Name: 'Strong', Uuid: 'u-91', SasRating: 78 },
                { Id: 92, UserId: 2, Name: 'Fair', Uuid: 'u-92', SasRating: 61 }
            );

            const created = await service.create(organizer, {
                name: 'Handicapped',
                format: 'swiss',
                sasChainHandicap: true
            });
            await service.register(created.id, { id: 1 });
            await service.register(created.id, { id: 2 });
            await service.registerDeck(created.id, { id: 1 }, 91);
            await service.registerDeck(created.id, { id: 2 }, 92);
            await service.start(created.id, organizer);

            const needing = await service.getMatchesNeedingGames(created.id);
            expect(needing.length).toBe(1);
            // 17 SAS apart at 5 SAS per chain = 3 chains for the strong deck.
            expect(needing[0].startingChains).toEqual({ user1: 3 });
            expect(needing[0].gameFormat).toBe('normal'); // archon -> lobby format
        });

        it('accrues Chainbound event chains on played wins only', async function () {
            const created = await service.create(organizer, {
                name: 'Chainbound Night',
                format: 'swiss',
                chainsPerMatchWin: 2
            });
            for (let index = 0; index < 4; index++) {
                await service.register(created.id, { id: index + 1 });
            }
            await service.start(created.id, organizer);

            const [matchA, matchB] = db.state.matches.filter((m) => m.Player2Id);

            await service.reportResult(created.id, matchA.Id, matchA.Player1Id, organizer);
            await service.awardWin(created.id, matchB.Id, matchB.Player1Id, organizer, 'no-show');

            const playedWinner = db.state.players.find(
                (entry) => entry.UserId === matchA.Player1Id
            );
            const awardWinner = db.state.players.find((entry) => entry.UserId === matchB.Player1Id);

            expect(playedWinner.EventChains).toBe(2);
            expect(awardWinner.EventChains).toBe(0); // no-shows earn nothing

            const next = await service.nextRound(created.id, organizer);
            expect(next.success).toBe(true);

            const needing = await service.getMatchesNeedingGames(created.id);
            const withChains = needing.find(
                (entry) => entry.startingChains && entry.startingChains.user1
            );
            expect(withChains.startingChains.user1).toBe(2);
        });
    });

    describe('triad', function () {
        const triadDecks = (userId, base) => [
            {
                Id: base,
                UserId: userId,
                Name: `Deck A${userId}`,
                Uuid: `u-${base}`,
                SasRating: 60
            },
            {
                Id: base + 1,
                UserId: userId,
                Name: `Deck B${userId}`,
                Uuid: `u-${base + 1}`,
                SasRating: 65
            },
            {
                Id: base + 2,
                UserId: userId,
                Name: `Deck C${userId}`,
                Uuid: `u-${base + 2}`,
                SasRating: 70
            }
        ];

        const setupTriad = async () => {
            db.state.decks.push(...triadDecks(1, 101), ...triadDecks(2, 201));

            const created = await service.create(organizer, {
                name: 'Triad Trial',
                format: 'swiss',
                triad: true
            });
            await service.register(created.id, { id: 1 });
            await service.register(created.id, { id: 2 });
            await service.registerTriadDecks(created.id, { id: 1 }, [101, 102, 103]);
            await service.registerTriadDecks(created.id, { id: 2 }, [201, 202, 203]);
            return created.id;
        };

        it('requires exactly three distinct decks per pool', async function () {
            db.state.decks.push(...triadDecks(1, 101));

            const created = await service.create(organizer, {
                name: 'Triad Trial',
                format: 'swiss',
                triad: true
            });
            await service.register(created.id, { id: 1 });

            expect(
                (await service.registerTriadDecks(created.id, { id: 1 }, [101, 102])).success
            ).toBe(false);
            expect(
                (await service.registerTriadDecks(created.id, { id: 1 }, [101, 101, 102])).success
            ).toBe(false);
            expect(
                (await service.registerTriadDecks(created.id, { id: 1 }, [101, 102, 103])).success
            ).toBe(true);

            const start = await service.start(created.id, organizer);
            expect(start.success).toBe(false); // player 1 fine but only 1 player
        });

        it('blocks the start until every player has a full pool', async function () {
            db.state.decks.push(...triadDecks(1, 101));

            const created = await service.create(organizer, {
                name: 'Triad Trial',
                format: 'swiss',
                triad: true
            });
            await service.register(created.id, { id: 1 });
            await service.register(created.id, { id: 2 });
            await service.registerTriadDecks(created.id, { id: 1 }, [101, 102, 103]);

            const blocked = await service.start(created.id, organizer);
            expect(blocked.success).toBe(false);
            expect(blocked.message).toMatch(/user2/);
        });

        it('runs the ban/pick flow and only then creates the game', async function () {
            const id = await setupTriad();
            await service.start(id, organizer);

            const match = db.state.matches[0];
            const p1 = { id: match.Player1Id };
            const p2 = { id: match.Player2Id };

            // No game until decks are chosen.
            expect((await service.getMatchesNeedingGames(id)).length).toBe(0);

            // Picking before your opponent has banned is rejected.
            expect((await service.triadPick(id, match.Id, p1, 101)).success).toBe(false);

            // Bans target the opponent's pool.
            expect((await service.triadBan(id, match.Id, p1, 102)).success).toBe(false); // own deck
            expect((await service.triadBan(id, match.Id, p1, 203)).success).toBe(true);
            expect((await service.triadBan(id, match.Id, p1, 202)).success).toBe(false); // already banned
            expect((await service.triadBan(id, match.Id, p2, 101)).success).toBe(true);

            // Picks come from your own unbanned decks.
            expect((await service.triadPick(id, match.Id, p1, 101)).success).toBe(false); // banned
            expect((await service.triadPick(id, match.Id, p1, 201)).success).toBe(false); // not yours
            expect((await service.triadPick(id, match.Id, p1, 102)).success).toBe(true);
            expect((await service.triadPick(id, match.Id, p2, 202)).success).toBe(true);

            const needing = await service.getMatchesNeedingGames(id);
            expect(needing.length).toBe(1);
            expect(needing[0].players.map((player) => player.deckId).sort()).toEqual([102, 202]);

            const detail = await service.getDetail(id, { id: 1, permissions: {} });
            expect(detail.tournament.triad).toBe(true);
            expect(detail.players.find((player) => player.userId === 1).triadDecks.length).toBe(3);
        });
    });

    describe('getDetail', function () {
        it('returns players, matches, standings and actor flags', async function () {
            const id = await createSwiss(4);
            await service.start(id, organizer);

            await reportAll(id, 1);

            const detail = await service.getDetail(id, { id: 1, permissions: {} });

            expect(detail.success).toBe(true);
            expect(detail.tournament.canManage).toBe(true);
            expect(detail.tournament.isRegistered).toBe(true);
            expect(detail.players.length).toBe(4);
            expect(detail.matches.length).toBe(2);
            expect(detail.standings[0].points).toBe(1);
            expect(detail.standings[0].rank).toBe(1);
        });

        it('only reveals the join code to managers', async function () {
            const created = await service.create(organizer, {
                name: 'Invite Only',
                format: 'swiss',
                visibility: 'private'
            });

            const asOrganizer = await service.getDetail(created.id, organizer);
            expect(asOrganizer.tournament.joinCode).toHaveLength(8);

            const asStranger = await service.getDetail(created.id, stranger);
            expect(asStranger.tournament.joinCode).toBeUndefined();
        });
    });
});
