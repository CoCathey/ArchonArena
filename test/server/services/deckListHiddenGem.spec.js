const db = require('../../../server/db');

/**
 * ARCHON (N33): the hidden-gem badge on "My Decks".
 *
 * The verdict belongs to the lab. What this pins is the wiring: the deck list
 * ASKS for it rather than computing its own version, marks the right rows, and
 * still returns decks on a site that has no lab at all - the Champion's
 * Challenge is a paid feature and the deck list is not.
 */
describe('the deck list badge', function () {
    let DeckService;
    let originalQuery;

    const deckRow = (Id, Name) => ({
        Id,
        Name,
        Uuid: `uuid-${Id}`,
        UserId: 3,
        Username: 'someone',
        Expansion: 341,
        ExpansionId: 341
    });

    beforeEach(function () {
        originalQuery = db.query;
        db.query = vi.fn(async (sql) =>
            /FROM "Decks" d/.test(sql) && /LIMIT/.test(sql)
                ? [deckRow(1, 'One'), deckRow(2, 'Two')]
                : []
        );

        DeckService = require('../../../server/services/DeckService');
    });

    afterEach(function () {
        db.query = originalQuery;
        vi.restoreAllMocks();
    });

    const listFor = async (lab) => {
        const service = new DeckService({}, {});

        service.championsChallengeService = lab;

        return service.findForUser({ id: 3 }, { page: 1, pageSize: 15, sort: 'name' });
    };

    it('marks the decks the lab named and no others', async function () {
        const decks = await listFor({ hiddenGemsFor: async () => new Set([2]) });

        expect(decks.map((deck) => [deck.id, !!deck.hiddenGem])).toEqual([
            [1, false],
            [2, true]
        ]);
    });

    it('asks the lab once for the page, not once per deck', async function () {
        const hiddenGemsFor = vi.fn(async () => new Set());

        await listFor({ hiddenGemsFor });

        expect(hiddenGemsFor).toHaveBeenCalledTimes(1);
        expect(hiddenGemsFor).toHaveBeenCalledWith(3);
    });

    it('lists decks on a site with no lab wired up', async function () {
        const decks = await listFor(undefined);

        expect(decks).toHaveLength(2);
        expect(decks.every((deck) => deck.hiddenGem === false)).toBe(true);
    });

    it('does not compute its own verdict - the threshold lives in one place', async function () {
        await listFor({ hiddenGemsFor: async () => new Set() });

        // The list query joins SAS and ARI, and it must not have grown a
        // second, subtly different definition of "wins more than expected".
        for (const [sql] of db.query.mock.calls) {
            expect(sql).not.toContain('ProvingGroundsGames');
        }
    });
});
