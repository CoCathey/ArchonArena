const fs = require('fs');
const path = require('path');

const RatingService = require('../../../../server/services/rating/RatingService');

const SCHEMA = path.join(__dirname, '..', '..', '..', '..', 'server', 'db', 'schema');

/**
 * ARCHON (N49): the deck-strength term the Amber ladder actually rates with.
 *
 * Two things are pinned here, and they are the two halves of one bug.
 *
 * WHAT IT READS. The ladder is back on raw SAS. ARI still exists, still moves
 * with every result and is still what the deck lists show - what changed is
 * that pointing the Elo deck term at it is now its own switch
 * (rating.ari.useForElo) rather than a consequence of the index being on.
 *
 * WHAT IT CAN STORE. "RatingHistory"."OwnSas"/"OpponentSas" hold the value the
 * rating USED, and while that was an ARI it was routinely fractional - the
 * seed is the SAS/AERC midpoint, so a 72/63 deck seeds at 67.5. The columns
 * were `integer`, and a bound parameter is sent as text and parsed by the
 * column's input function, so 67.5 was not rounded but REJECTED:
 * `invalid input syntax for type integer: "67.5"`. That rolled back the rating
 * transaction, processGame swallowed the error by design, and the game was
 * left silently unrated - which is what a player saw as a post-game panel
 * stuck on "Rating this game..." and an Amber total that never moved.
 *
 * The existing RatingService fixtures never caught it because they carry a
 * whole-number SAS and no AERC, which seeds an ARI of exactly 70.
 */
describe('the Amber ladder’s deck-strength term', function () {
    let service;
    let db;
    let client;
    let ratingConfig;

    const GAME_UUID = 'game-uuid-1';

    // A deck whose card scores disagree, which is the ordinary case: SAS 72
    // and AERC 63 seed an ARI of 67.5. The fractional seed is the point.
    const gameRows = (overrides = {}) => [
        {
            GameDbId: 10,
            GameFormat: 'archon',
            WinnerId: 1,
            WinReason: 'keys',
            PlayerId: 1,
            Keys: 3,
            DeckUuid: 'deck-a',
            SasRating: 72,
            AercScore: 63,
            Ari: null,
            ...overrides.winner
        },
        {
            GameDbId: 10,
            GameFormat: 'archon',
            WinnerId: 1,
            WinReason: 'keys',
            PlayerId: 2,
            Keys: 1,
            DeckUuid: 'deck-b',
            SasRating: 64,
            AercScore: 61,
            Ari: null,
            ...overrides.loser
        }
    ];

    const configService = () => ({
        getValue: (key) => (key === 'rating' ? ratingConfig : undefined)
    });

    const historyParams = () =>
        db.queryTran.mock.calls
            .filter(([, sql]) => (sql || '').includes('INSERT INTO "RatingHistory"'))
            .map(([, , params]) => params);

    beforeEach(function () {
        ratingConfig = {};
        client = { release: vi.fn() };
        db = {
            query: vi.fn().mockResolvedValue([]),
            queryTran: vi.fn().mockImplementation(async (c, sql) => {
                if (sql && sql.includes('INSERT INTO "RatingHistory"')) {
                    return [{ Id: 1 }];
                }
                return [];
            }),
            startTransaction: vi.fn().mockResolvedValue(client)
        };
        service = new RatingService(configService(), db);
        service.ariService.applyGameResult = vi.fn().mockResolvedValue(true);

        db.query.mockImplementation(async (sql) => {
            if (sql.includes('FROM "Games"')) {
                return gameRows();
            }
            return [];
        });
    });

    it('rates from raw SAS, not from the deck’s ARI', async function () {
        await service.processGame(GAME_UUID);

        const [winner, loser] = historyParams();

        // OwnSas / OpponentSas: the numbers the calculator was handed. The
        // ARI seeds here would be 67.5 and 62.5.
        expect(winner[8]).toBe(72);
        expect(winner[9]).toBe(64);
        expect(loser[8]).toBe(64);
        expect(loser[9]).toBe(72);
    });

    it('rates from raw SAS even for a deck the index has already moved', async function () {
        db.query.mockImplementation(async (sql) => {
            if (sql.includes('FROM "Games"')) {
                return gameRows({ winner: { Ari: 81.4 }, loser: { Ari: 58.2 } });
            }
            return [];
        });

        await service.processGame(GAME_UUID);

        expect(historyParams()[0][8]).toBe(72);
    });

    // Switching the ladder back must not also stop the index learning -
    // otherwise every ARI freezes at its card-math seed and the column the
    // deck lists, Deep Probe and the Challenge all read quietly goes dead.
    it('still folds the result into both decks’ ratings', async function () {
        await service.processGame(GAME_UUID);

        expect(service.ariService.applyGameResult).toHaveBeenCalledTimes(1);
        expect(service.ariService.applyGameResult.mock.calls[0][0]).toMatchObject({
            winnerUuid: 'deck-a',
            loserUuid: 'deck-b',
            sim: false
        });
    });

    it('stops the index learning when an operator switches ARI off entirely', async function () {
        ratingConfig = { ari: { enabled: false } };

        await service.processGame(GAME_UUID);

        expect(service.ariService.applyGameResult).not.toHaveBeenCalled();
        expect(historyParams()[0][8]).toBe(72);
    });

    describe('when an operator points the ladder at ARI', function () {
        beforeEach(function () {
            ratingConfig = { ari: { useForElo: true } };
        });

        it('reads the deck’s ARI instead of its SAS', async function () {
            await service.processGame(GAME_UUID);

            const [winner] = historyParams();

            // The seeds: (72 + 63) / 2 and (64 + 61) / 2.
            expect(winner[8]).toBe(67.5);
            expect(winner[9]).toBe(62.5);
        });

        // Not rounded on the way in. recalculateRatings replays these exact
        // numbers back through the calculator, so a rounded column would make
        // a replay disagree with the ratings it is meant to reproduce - which
        // is why the fix was to widen the column rather than to round the
        // value that would not fit in it.
        it('stores the ARI it rated with, to the precision it rated with', async function () {
            db.query.mockImplementation(async (sql) => {
                if (sql.includes('FROM "Games"')) {
                    return gameRows({ winner: { Ari: 81.4 }, loser: { Ari: 58.2 } });
                }
                return [];
            });

            await service.processGame(GAME_UUID);

            const [winner, loser] = historyParams();

            expect(winner[8]).toBeCloseTo(81.4, 5);
            expect(winner[9]).toBeCloseTo(58.2, 5);
            expect(loser[8]).toBeCloseTo(58.2, 5);
            expect(loser[9]).toBeCloseTo(81.4, 5);
        });

        it('still rates the game rather than rolling it back', async function () {
            await service.processGame(GAME_UUID);

            expect(db.queryTran).toHaveBeenCalledWith(client, 'COMMIT');
            expect(db.queryTran).not.toHaveBeenCalledWith(client, 'ROLLBACK');
        });
    });

    // The unit tests above run against a fake database that will store
    // anything, so they cannot see the column type - and the column type was
    // the bug. This is the guard that would actually have failed.
    describe('the columns those values are written to', function () {
        const columnType = (source, column) => {
            const match = source.match(new RegExp(`"${column}"\\s+([a-z ]+?)[,\\n]`));

            return match ? match[1].trim() : null;
        };

        it('can hold a fractional deck rating', function () {
            const source = fs.readFileSync(path.join(SCHEMA, '27 - RatingHistory.sql'), 'utf8');

            // `integer` here rejects every ARI that is not a whole number, and
            // takes the whole rating transaction down with it.
            expect(columnType(source, 'OwnSas')).toBe('real');
            expect(columnType(source, 'OpponentSas')).toBe('real');
        });

        it('is widened for databases that already exist', function () {
            const migration = fs.readFileSync(
                path.join(SCHEMA, 'migrations', '90 - RatingHistoryDeckStrength.sql'),
                'utf8'
            );

            expect(migration).toContain('ALTER COLUMN "OwnSas" TYPE real');
            expect(migration).toContain('ALTER COLUMN "OpponentSas" TYPE real');
        });
    });
});
