const AriService = require('../../../../server/services/rating/AriService');
const {
    SEED_DEVIATION,
    MIN_DEVIATION
} = require('../../../../server/services/rating/ariConfidence');

/**
 * ARCHON (N34): the two halves of "what does 78 mean".
 *
 * HOW SURE the platform is - a provisional deck moves further on the same
 * result than a settled one, so a new deck finds its level in a few dozen games
 * instead of creeping away from its card-math seed one twitch at a time.
 *
 * WHERE IT SITS - the percentile and rank among rated decks, without which a
 * rating is a number rather than a ranking. That is read from a snapshot, and
 * the snapshot's failure modes are what most of this file is about: a stale
 * distribution is a fine answer, a wrong one is not, and a missing one must say
 * "unranked" rather than quietly claim the middle of the field.
 */
describe('ARI in the field', function () {
    let db;
    let service;
    let sasRows;

    const upserts = () =>
        db.query.mock.calls
            .filter(([sql]) => sql.includes('INSERT INTO "DeckAri"'))
            .map(([, params]) => params);

    const deckRow = (Uuid, overrides = {}) => ({
        Uuid,
        SasRating: 70,
        AercScore: 70,
        Ari: 70,
        RatedGames: 0,
        SimGames: 0,
        LastGameAt: new Date(),
        ...overrides
    });

    beforeEach(function () {
        sasRows = [deckRow('w'), deckRow('l')];
        db = {
            query: vi
                .fn()
                .mockImplementation(async (sql) => (sql.includes('FROM "DeckSas"') ? sasRows : []))
        };
        service = new AriService(db, null);
    });

    describe('confidence in the step', function () {
        const move = async () => {
            db.query.mockClear();

            await service.applyGameResult({
                winnerUuid: 'w',
                loserUuid: 'l',
                winnerExpected: 0.5,
                k: 8,
                sasWeight: 4
            });

            return upserts().find((params) => params[0] === 'w')[1] - 70;
        };

        it('moves a provisional deck further than a settled one on the same result', async function () {
            sasRows = [deckRow('w'), deckRow('l')];

            const provisional = await move();

            sasRows = [deckRow('w', { RatedGames: 2000 }), deckRow('l', { RatedGames: 2000 })];

            const settled = await move();

            expect(provisional).toBeGreaterThan(3 * settled);
        });

        it('settles toward the configured K, so tuning it still means something', async function () {
            sasRows = [deckRow('w', { RatedGames: 100000 }), deckRow('l', { RatedGames: 100000 })];

            // step = (k / sasWeight) * (1 - expected) = (8/4) * 0.5 = 1
            expect(await move()).toBeCloseTo(1, 1);
        });

        it('scales each side by its OWN confidence, not a shared one', async function () {
            // A new deck beating a veteran should move a long way while the
            // veteran barely notices. If one multiplier were applied to both,
            // the two would move by the same amount and this passes only by
            // accident of the fixture - so the assertion is on the DIFFERENCE.
            sasRows = [deckRow('w', { RatedGames: 0 }), deckRow('l', { RatedGames: 5000 })];

            await service.applyGameResult({
                winnerUuid: 'w',
                loserUuid: 'l',
                winnerExpected: 0.5,
                k: 8,
                sasWeight: 4
            });

            const rows = upserts();
            const winnerMove = rows.find((params) => params[0] === 'w')[1] - 70;
            const loserMove = 70 - rows.find((params) => params[0] === 'l')[1];

            expect(winnerMove).toBeGreaterThan(3 * loserMove);
        });

        it('cannot be settled by sparring alone as fast as by real games', async function () {
            sasRows = [deckRow('w', { SimGames: 200 }), deckRow('l', { SimGames: 200 })];

            const bySparring = await move();

            sasRows = [deckRow('w', { RatedGames: 200 }), deckRow('l', { RatedGames: 200 })];

            const byPlaying = await move();

            expect(bySparring).toBeGreaterThan(byPlaying);
        });

        it('writes the deviation the game just earned, not the one before it', async function () {
            sasRows = [deckRow('w'), deckRow('l')];

            await service.applyGameResult({
                winnerUuid: 'w',
                loserUuid: 'l',
                winnerExpected: 0.5,
                k: 8,
                sasWeight: 4
            });

            const deviation = upserts().find((params) => params[0] === 'w')[4];

            expect(deviation).toBeLessThan(SEED_DEVIATION);
            expect(deviation).toBeGreaterThanOrEqual(MIN_DEVIATION);
        });
    });

    describe('placeIn', function () {
        const snapshot = {
            total: 1000,
            buckets: [
                { bucket: 50, atOrBelow: 100 },
                { bucket: 60, atOrBelow: 400 },
                { bucket: 70, atOrBelow: 800 },
                { bucket: 80, atOrBelow: 990 },
                { bucket: 90, atOrBelow: 1000 }
            ]
        };

        it('places a deck by the highest bucket at or below it', function () {
            expect(AriService.placeIn(70, snapshot)).toEqual({
                percentile: 80,
                rank: 201,
                of: 1000
            });
        });

        it('uses the bucket below when the rating falls between two', function () {
            // 75 has no bucket of its own; it is at least as good as everything
            // in 70 and cannot claim the decks in 80.
            expect(AriService.placeIn(75, snapshot).percentile).toBe(80);
        });

        it('puts the best deck at the top and the worst at the bottom', function () {
            expect(AriService.placeIn(95, snapshot).rank).toBe(1);
            expect(AriService.placeIn(10, snapshot)).toEqual({
                percentile: 0,
                rank: 1000,
                of: 1000
            });
        });

        it('says nothing rather than guessing when there is no snapshot', function () {
            expect(AriService.placeIn(70, { total: 0, buckets: [] })).toBeNull();
            expect(AriService.placeIn(70, null)).toBeNull();
        });

        it('says nothing about a deck with no rating', function () {
            expect(AriService.placeIn(null, snapshot)).toBeNull();
            expect(AriService.placeIn(undefined, snapshot)).toBeNull();
        });
    });

    describe('refreshDistribution', function () {
        it('stores a running total, not just per-bucket counts', async function () {
            db.query = vi.fn(async (sql) =>
                sql.includes('GROUP BY 1')
                    ? [
                          { Bucket: 50, Decks: 10 },
                          { Bucket: 60, Decks: 30 },
                          { Bucket: 70, Decks: 60 }
                      ]
                    : []
            );
            service = new AriService(db, null);

            expect(await service.refreshDistribution()).toBe(100);

            const [, params] = db.query.mock.calls.find(([sql]) => sql.includes('INSERT INTO'));

            expect(params[0]).toEqual([50, 60, 70]);
            expect(params[1]).toEqual([10, 30, 60]);
            expect(params[2]).toEqual([10, 40, 100]);
        });

        it('replaces the whole snapshot in one transaction', async function () {
            db.query = vi.fn(async () => []);
            service = new AriService(db, null);

            await service.refreshDistribution();

            const statements = db.query.mock.calls.map(([sql]) => sql);

            expect(statements).toContain('BEGIN');
            expect(statements).toContain('COMMIT');
            // A half-written distribution would quote percentiles from two
            // different days.
            expect(statements.indexOf('BEGIN')).toBeLessThan(
                statements.findIndex((sql) => sql.includes('DELETE FROM "AriDistribution"'))
            );
        });

        it('rolls back rather than leaving a partial field', async function () {
            let seen = 0;

            db.query = vi.fn(async (sql) => {
                if (sql.includes('DELETE FROM "AriDistribution"')) {
                    seen++;

                    throw new Error('nope');
                }

                return sql.includes('GROUP BY 1') ? [{ Bucket: 50, Decks: 10 }] : [];
            });
            service = new AriService(db, null);

            expect(await service.refreshDistribution()).toBe(0);
            expect(seen).toBe(1);
            expect(db.query.mock.calls.map(([sql]) => sql)).toContain('ROLLBACK');
        });

        it('counts a deck by its effective ARI, so unplayed decks are in the field too', async function () {
            db.query = vi.fn(async () => []);
            service = new AriService(db, null);

            await service.refreshDistribution();

            const [sql] = db.query.mock.calls.find(([statement]) =>
                statement.includes('GROUP BY 1')
            );

            // The seed fallback, not just stored ratings: a platform where only
            // played decks were ranked would tell every new deck it was last.
            expect(sql).toContain('"SasRating"');
            expect(sql).toContain('LEFT JOIN "DeckAri"');
            expect(sql).toContain('"Banned"');
        });
    });

    describe('attachPlaces', function () {
        beforeEach(function () {
            db.query = vi.fn(async (sql) => {
                if (sql.includes('FROM "AriDistribution" ORDER BY')) {
                    return [
                        { Bucket: 60, AtOrBelow: 500 },
                        { Bucket: 80, AtOrBelow: 1000 }
                    ];
                }

                if (sql.includes('AriDistributionState')) {
                    return [{ TotalDecks: 1000, UpdatedAt: new Date() }];
                }

                return [];
            });
            service = new AriService(db, null);
        });

        it('places every row from one snapshot read', async function () {
            const decks = [{ ari: 85 }, { ari: 65 }, { ari: 10 }];

            await service.attachPlaces(decks);

            expect(decks[0].ariPlace.percentile).toBe(100);
            expect(decks[1].ariPlace.percentile).toBe(50);
            expect(decks[2].ariPlace.percentile).toBe(0);

            const reads = db.query.mock.calls.filter(([sql]) =>
                sql.includes('FROM "AriDistribution" ORDER BY')
            );

            // One read for the page, not one per deck: this runs on every deck
            // list, for every member, on every page.
            expect(reads).toHaveLength(1);
        });

        it('leaves an unrated deck unplaced', async function () {
            const decks = [{ ari: null }];

            await service.attachPlaces(decks);

            expect(decks[0].ariPlace).toBeNull();
        });

        it('does not fail a deck list when the snapshot cannot be read', async function () {
            db.query = vi.fn(async () => {
                throw new Error('nope');
            });
            service = new AriService(db, null);

            const decks = [{ ari: 70 }];

            await service.attachPlaces(decks);

            expect(decks[0].ariPlace).toBeNull();
        });
    });
});
