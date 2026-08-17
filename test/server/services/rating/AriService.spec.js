const AriService = require('../../../../server/services/rating/AriService');
const { seedAri, effectiveAri, ARI_MAX } = require('../../../../server/services/rating/AriService');

// ARI is the deck-strength number the Amber ladder actually spends, so its
// arithmetic is pinned the way EloCalculator's is: seeds, fallbacks, the
// symmetric update, and every refusal to move.

describe('AriService', function () {
    describe('seedAri', function () {
        it('starts a deck at the SAS/AERC midpoint', function () {
            expect(seedAri(70, 80)).toBe(75);
        });

        it('uses whichever score exists alone', function () {
            expect(seedAri(64, null)).toBe(64);
            expect(seedAri(undefined, 71)).toBe(71);
        });

        it('has no opinion about a deck with neither', function () {
            expect(seedAri(null, null)).toBeNull();
            expect(seedAri(undefined, undefined)).toBeNull();
        });

        it('never seeds outside the band', function () {
            expect(seedAri(4000, 4000)).toBe(ARI_MAX);
        });
    });

    describe('effectiveAri', function () {
        it('prefers the stored, game-adjusted value', function () {
            expect(effectiveAri({ Ari: 82.5, SasRating: 70, AercScore: 80 })).toBe(82.5);
        });

        it('falls back to the seed when no game has touched the deck', function () {
            expect(effectiveAri({ Ari: null, SasRating: 70, AercScore: 80 })).toBe(75);
        });

        it('is null for a deck with nothing to go on', function () {
            expect(effectiveAri({ Ari: null, SasRating: null, AercScore: null })).toBeNull();
            expect(effectiveAri(null)).toBeNull();
        });
    });

    describe('applyGameResult', function () {
        let db;
        let service;
        let sasRows;

        const upserts = () =>
            db.query.mock.calls
                .filter(([sql]) => sql.includes('INSERT INTO "DeckAri"'))
                .map(([, params]) => params);

        beforeEach(function () {
            sasRows = [
                { Uuid: 'w', SasRating: 70, AercScore: 70, Ari: null, RatedGames: 0, SimGames: 0 },
                { Uuid: 'l', SasRating: 70, AercScore: 70, Ari: null, RatedGames: 0, SimGames: 0 }
            ];
            db = {
                query: vi.fn().mockImplementation(async (sql) => {
                    if (sql.includes('FROM "DeckSas"')) {
                        return sasRows;
                    }

                    return [];
                })
            };
            service = new AriService(db);
        });

        it('moves both decks symmetrically: winner up, loser down', async function () {
            const applied = await service.applyGameResult({
                winnerUuid: 'w',
                loserUuid: 'l',
                winnerExpected: 0.5,
                k: 8,
                sasWeight: 4
            });

            expect(applied).toBe(true);

            const rows = upserts();
            const winner = rows.find((params) => params[0] === 'w');
            const loser = rows.find((params) => params[0] === 'l');

            // step = (k / sasWeight) * (1 - expected) = 2 * 0.5 = 1
            expect(winner[1]).toBeCloseTo(71, 5);
            expect(loser[1]).toBeCloseTo(69, 5);
        });

        it('moves less when the result was expected, more when it was not', async function () {
            await service.applyGameResult({
                winnerUuid: 'w',
                loserUuid: 'l',
                winnerExpected: 0.9,
                k: 8,
                sasWeight: 4
            });

            const expectedWin = upserts().find((params) => params[0] === 'w')[1];

            db.query.mockClear();
            await service.applyGameResult({
                winnerUuid: 'w',
                loserUuid: 'l',
                winnerExpected: 0.1,
                k: 8,
                sasWeight: 4
            });

            const upsetWin = upserts().find((params) => params[0] === 'w')[1];

            expect(expectedWin - 70).toBeCloseTo(0.2, 5);
            expect(upsetWin - 70).toBeCloseTo(1.8, 5);
        });

        it('measures a sparring game against the decks’ own ARIs when no expectation is given', async function () {
            sasRows[0].Ari = 80;
            sasRows[1].Ari = 80;

            await service.applyGameResult({
                winnerUuid: 'w',
                loserUuid: 'l',
                k: 4,
                sasWeight: 4,
                sim: true
            });

            const winner = upserts().find((params) => params[0] === 'w');

            // Equal ARIs -> expected 0.5 -> step = (4/4) * 0.5 = 0.5
            expect(winner[1]).toBeCloseTo(80.5, 5);
            // A sparring game increments SimGames, not RatedGames.
            expect(winner[2]).toBe(0);
            expect(winner[3]).toBe(1);
        });

        it('counts a rated real game in RatedGames', async function () {
            await service.applyGameResult({
                winnerUuid: 'w',
                loserUuid: 'l',
                winnerExpected: 0.5,
                k: 8,
                sasWeight: 4
            });

            const winner = upserts().find((params) => params[0] === 'w');

            expect(winner[2]).toBe(1);
            expect(winner[3]).toBe(0);
        });

        it('refuses to move anything when one deck has no rating at all', async function () {
            sasRows = [
                { Uuid: 'w', SasRating: 70, AercScore: null, Ari: null },
                { Uuid: 'l', SasRating: null, AercScore: null, Ari: null }
            ];

            const applied = await service.applyGameResult({
                winnerUuid: 'w',
                loserUuid: 'l',
                winnerExpected: 0.5,
                k: 8,
                sasWeight: 4
            });

            expect(applied).toBe(false);
            expect(upserts()).toEqual([]);
        });

        it('follows deck strength out of the model when sasWeight is 0', async function () {
            const applied = await service.applyGameResult({
                winnerUuid: 'w',
                loserUuid: 'l',
                winnerExpected: 0.5,
                k: 8,
                sasWeight: 0
            });

            expect(applied).toBe(false);
        });

        it('never lets a database failure escape - best-effort by contract', async function () {
            db.query.mockRejectedValue(new Error('boom'));

            await expect(
                service.applyGameResult({
                    winnerUuid: 'w',
                    loserUuid: 'l',
                    winnerExpected: 0.5,
                    k: 8,
                    sasWeight: 4
                })
            ).resolves.toBe(false);
        });
    });
});
