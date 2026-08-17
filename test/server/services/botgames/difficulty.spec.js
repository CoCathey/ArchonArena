const {
    BOT_DIFFICULTIES,
    DEFAULT_DIFFICULTY,
    difficultyBand,
    normalizeDifficulty
} = require('../../../../server/services/botgames/difficulty');
const DeckService = require('../../../../server/services/DeckService');

/**
 * ARCHON (F9): Easy, Medium and Hard - the bands, and the pool they cut.
 *
 * Difficulty is the deck the bot brings, so two things have to hold. The
 * bands must be the ones a player was promised, and the query behind them
 * must cut the pool by ARI, by house, and by DECK rather than by copy -
 * otherwise a deck twenty people own is twenty tickets in the hat and the
 * "large pool" is mostly the same few decks.
 *
 * The pool query is asserted as SQL rather than against a database because
 * that is where the mistakes live: a filter dropped, a band compared against
 * the wrong column, a parameter numbered by hand.
 */

describe('the practice difficulty bands', function () {
    it('is the three settings a player is offered, in order', function () {
        expect(BOT_DIFFICULTIES.map((entry) => [entry.key, entry.minAri, entry.maxAri])).toEqual([
            ['easy', 45, 65],
            ['medium', 66, 89],
            ['hard', 90, 125]
        ]);
    });

    it('defaults to the middle of the field', function () {
        expect(DEFAULT_DIFFICULTY).toBe('medium');
        expect(difficultyBand().key).toBe('medium');
    });

    it('plays a Medium game rather than failing on anything it cannot read', function () {
        // An old client, a hand-made socket message, a setting removed from
        // the registry: none of these should cost somebody a table.
        for (const nonsense of ['', null, undefined, 'IMPOSSIBLE', 42, {}]) {
            expect(normalizeDifficulty(nonsense)).toBe('medium');
        }
    });

    it('reads a setting whatever case it arrives in', function () {
        expect(normalizeDifficulty('HARD')).toBe('hard');
        expect(difficultyBand('Easy').maxAri).toBe(65);
    });
});

describe('the deck pool a difficulty draws from', function () {
    const service = new DeckService();
    const poolFor = (options) => service.practiceDeckPool(options);

    it('counts a deck once however many people own a copy', function () {
        const { sql } = poolFor({ house: 'logos' });

        // DISTINCT ON the deck's identity - its Master Vault uuid, falling
        // back to the row id for the rows imported before uuids existed.
        expect(sql).toContain('SELECT DISTINCT ON (COALESCE(d."Uuid"');
        expect(sql).toContain('\'row:\' || d."Id"::text');
    });

    it("only offers decks containing the bot's house", function () {
        const { sql, params } = poolFor({ house: 'Untamed' });

        expect(sql).toContain('FROM "DeckHouses" dh JOIN "Houses" h ON h."Id" = dh."HouseId"');
        expect(params).toEqual(['untamed']);
    });

    it('bands on ARI, seeded from SAS and AERC when the engine has never moved it', function () {
        const { sql, params } = poolFor({ house: 'dis', minAri: 66, maxAri: 89 });

        expect(params).toEqual(['dis', 66, 89]);
        expect(sql).toContain('COALESCE(da."Ari"');
        expect(sql).toContain('(ds."SasRating" + ds."AercScore") / 2.0');
        expect(sql).toContain('>= $2');
        expect(sql).toContain('<= $3');
    });

    it('leaves out the decks nobody should be dealt', function () {
        const { sql } = poolFor({ house: 'mars' });

        expect(sql).toContain('d."IsAlliance" = false');
        expect(sql).toContain('d."Banned" = false');
        expect(sql).toContain('COALESCE(d."Flagged", false) = false');
    });

    it('drops the band cleanly when there is none', function () {
        const { sql, params } = poolFor({ house: 'sanctum' });

        expect(params).toEqual(['sanctum']);
        expect(sql).not.toContain('da."Ari"');
    });

    it('can be narrowed to one account, for a bot stocked by hand', function () {
        const { sql, params } = poolFor({ house: 'shadows', userId: 42 });

        expect(sql).toContain('d."UserId" = $1');
        expect(params).toEqual([42, 'shadows']);
    });
});
