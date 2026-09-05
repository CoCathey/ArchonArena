const TournamentService = require('../../../../server/services/tournament/TournamentService');

/**
 * ARCHON: the pairing the lobby builds a table from names each seat's deck.
 *
 * The lobby pins a seat to a deck ID and only learns the deck's NAME by
 * loading the whole deck into the seat - so until that finished, and forever
 * if it failed, a locked seat had nothing to show. The name is cheap to carry
 * with the pairing, and the same query already ran for the SAS handicap.
 */
describe('getMatchesNeedingGames deck names', function () {
    let service;
    let db;
    let tournament;
    let match;
    let players;
    let decks;

    beforeEach(function () {
        tournament = {
            Id: 1,
            Name: 'Friday Night',
            Status: 'active',
            OrganizerId: 9,
            Mode: 'online',
            GameFormat: 'archon',
            CurrentRound: 1,
            BestOf: 3,
            SasChainHandicap: false
        };
        match = {
            Id: 3,
            TournamentId: 1,
            Round: 1,
            TableNumber: 1,
            Player1Id: 1,
            Player2Id: 2,
            BestOf: 3,
            Player1Wins: 0,
            Player2Wins: 0
        };
        players = [
            { UserId: 1, Username: 'alice', DeckId: 101 },
            { UserId: 2, Username: 'bob', DeckId: 201 }
        ];
        decks = [
            { Id: 101, Name: 'Alpha Deck', SasRating: 70 },
            { Id: 201, Name: 'Bravo Deck', SasRating: 60 }
        ];

        db = {
            query: vi.fn().mockImplementation(async (sql, params = []) => {
                if (sql.includes('FROM "Tournaments"')) {
                    return [tournament];
                }

                if (sql.includes('FROM "TournamentMatchGames"')) {
                    return [];
                }

                if (sql.includes('FROM "TournamentMatches"')) {
                    return [match];
                }

                if (sql.includes('FROM "TournamentPlayers"')) {
                    return players;
                }

                if (sql.includes('FROM "Decks" d')) {
                    return decks.filter((deck) => params[0].includes(deck.Id));
                }

                return [];
            })
        };

        service = new TournamentService(db, { settingsService: { getSection: () => ({}) } });
    });

    it('names the deck each seat will be pinned to', async function () {
        const [info] = await service.getMatchesNeedingGames(1);

        expect(info.players).toEqual([
            { userId: 1, username: 'alice', deckId: 101, deckName: 'Alpha Deck' },
            { userId: 2, username: 'bob', deckId: 201, deckName: 'Bravo Deck' }
        ]);
    });

    it('leaves the name empty for a seat with no registered deck', async function () {
        players[1].DeckId = null;

        const [info] = await service.getMatchesNeedingGames(1);

        expect(info.players[1]).toEqual({
            userId: 2,
            username: 'bob',
            deckId: null,
            deckName: null
        });
    });

    it('looks the decks up once, whether or not the event handicaps by SAS', async function () {
        await service.getMatchesNeedingGames(1);

        const deckReads = db.query.mock.calls.filter(([sql]) => sql.includes('FROM "Decks" d'));

        expect(deckReads).toHaveLength(1);
        expect(deckReads[0][1][0].sort()).toEqual([101, 201]);
    });

    it('still applies the SAS handicap from the same read', async function () {
        tournament.SasChainHandicap = true;

        const [info] = await service.getMatchesNeedingGames(1);

        // 70 vs 60 at the default 5 SAS per chain: alice starts on two.
        expect(info.startingChains).toEqual({ alice: 2 });
        expect(info.players[0].deckName).toBe('Alpha Deck');
    });
});
