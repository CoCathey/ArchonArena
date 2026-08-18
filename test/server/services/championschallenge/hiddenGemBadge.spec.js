const ChampionsChallengeService = require('../../../../server/services/championschallenge/ChampionsChallengeService');

/**
 * ARCHON (N33): the hidden-gem verdict, asked for by the deck list.
 *
 * The claim is the lab's and the threshold is labMath's; this only checks that
 * a second caller gets the SAME verdict from a cheaper read. The risk being
 * covered is a quiet fork - a deck list that says "gem" where the Champion's
 * Challenge says "still proving", which nobody would notice and everybody would
 * believe.
 */
const USER = 7;

describe('hidden gems for the deck list', function () {
    let db;
    let service;

    const configService = { getValue: () => ({}) };
    const settingsService = {
        getSectionWithDefaults: () => ({ enabled: true }),
        getSection: () => ({})
    };

    // One grouped row: this deck against that deck, N games, W of them wins.
    const pair = (DeckId, OpponentDeckId, Played, Wins) => ({
        DeckId,
        OpponentDeckId,
        Played,
        Wins
    });

    const answer = ({ pairs = [], sas = [] }) =>
        db.query.mockImplementation(async (sql) => {
            if (sql.includes('FROM "ProvingGroundsGames"')) {
                return pairs;
            }

            if (sql.includes('FROM "Decks" d')) {
                return sas;
            }

            return [];
        });

    beforeEach(function () {
        db = { query: vi.fn().mockResolvedValue([]) };
        service = new ChampionsChallengeService(configService, db, settingsService);
    });

    it('calls a deck that beats its expectation, with enough games, a gem', async function () {
        // 40 games against an equally rated deck - expectation 50% - won 34.
        answer({
            pairs: [pair(1, 2, 40, 34)],
            sas: [
                { Id: 1, SasRating: 70 },
                { Id: 2, SasRating: 70 }
            ]
        });

        expect([...(await service.hiddenGemsFor(USER))]).toEqual([1]);
    });

    it('does not, on the same record, when the games are too few to mean it', async function () {
        // Same 85% win rate, four games. The interval is the point: 'this deck
        // is underrated' after four games is a coin landing heads twice.
        answer({
            pairs: [pair(1, 2, 4, 4)],
            sas: [
                { Id: 1, SasRating: 70 },
                { Id: 2, SasRating: 70 }
            ]
        });

        expect(await service.hiddenGemsFor(USER)).toEqual(new Set());
    });

    it('does not when the deck was expected to win that much anyway', async function () {
        // 40-10 up on a deck rated far below it. A strong deck beating weak
        // opposition is SAS being right, not SAS being wrong.
        answer({
            pairs: [pair(1, 2, 50, 40)],
            sas: [
                { Id: 1, SasRating: 95 },
                { Id: 2, SasRating: 45 }
            ]
        });

        expect(await service.hiddenGemsFor(USER)).toEqual(new Set());
    });

    it('weighs each opponent by how often it was played', async function () {
        // If the grouped rows were counted once each rather than N times, the
        // one game against the pushover would carry the same weight as the
        // forty against the peer, and the expectation would come out wrong.
        answer({
            pairs: [pair(1, 2, 40, 34), pair(1, 3, 1, 1)],
            sas: [
                { Id: 1, SasRating: 70 },
                { Id: 2, SasRating: 70 },
                { Id: 3, SasRating: 20 }
            ]
        });

        expect([...(await service.hiddenGemsFor(USER))]).toEqual([1]);

        const [, params] = db.query.mock.calls.find(([sql]) => sql.includes('FROM "Decks" d'));

        // Every deck the games mention, opponents included - the expectation
        // cannot be computed without the other side's rating.
        expect(params[0].sort()).toEqual([1, 2, 3]);
    });

    it('says nothing about a deck whose opponents have no SAS', async function () {
        answer({
            pairs: [pair(1, 2, 40, 40)],
            sas: [
                { Id: 1, SasRating: 70 },
                { Id: 2, SasRating: null }
            ]
        });

        // Not a gem and not a mistake: with no expectation there is no claim to
        // make, and 'won every game' against unrated opposition is not one.
        expect(await service.hiddenGemsFor(USER)).toEqual(new Set());
    });

    it('reads nothing more when the member has never sparred', async function () {
        answer({ pairs: [] });

        expect(await service.hiddenGemsFor(USER)).toEqual(new Set());
        expect(db.query).toHaveBeenCalledTimes(1);
    });

    it('costs a badge, not a deck list, when the database says no', async function () {
        db.query.mockRejectedValue(new Error('nope'));

        expect(await service.hiddenGemsFor(USER)).toEqual(new Set());
    });

    it('never touches the official games, players or rating tables', async function () {
        answer({ pairs: [pair(1, 2, 40, 34)], sas: [{ Id: 1, SasRating: 70 }] });

        await service.hiddenGemsFor(USER);

        for (const [sql] of db.query.mock.calls) {
            expect(sql).not.toMatch(/"(Games|GamePlayers|RatingHistory)"/);
        }
    });

    it('counts a deck’s losses as well as its wins', async function () {
        // Both halves of the UNION: a deck that only ever appears as the loser
        // would otherwise have no games at all, and 0-0 is not a gem but it is
        // not a record either.
        answer({ pairs: [pair(1, 2, 40, 6)], sas: [{ Id: 1, SasRating: 70 }] });

        await service.hiddenGemsFor(USER);

        const [sql] = db.query.mock.calls[0];

        expect(sql).toContain('"WinnerDeckId" AS "DeckId"');
        expect(sql).toContain('SELECT "LoserDeckId", "WinnerDeckId", false');
    });
});
