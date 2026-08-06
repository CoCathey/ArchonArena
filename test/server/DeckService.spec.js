const DeckService = require('../../server/services/DeckService');

describe('DeckService alliance restricted list', function () {
    let service;

    beforeEach(function () {
        service = new DeckService({}, {});
    });

    it('allows alliance decks to include Reiteration', function () {
        expect(() =>
            service.validateAllianceRestrictedList(
                [
                    { id: 'reiteration', count: 2 },
                    { id: 'flaxia', count: 1 }
                ],
                886
            )
        ).not.toThrow();
    });

    it('allows alliance decks to include Strategic Feint', function () {
        expect(() =>
            service.validateAllianceRestrictedList(
                [
                    { id: 'strategic-feint', count: 2 },
                    { id: 'dextre', count: 1 }
                ],
                886
            )
        ).not.toThrow();
    });

    it('rejects alliance decks that include multiple restricted card names', function () {
        expect(() =>
            service.validateAllianceRestrictedList(
                [
                    { id: 'reiteration', count: 1 },
                    { id: 'strategic-feint', count: 1 }
                ],
                886
            )
        ).toThrow('Alliance deck may include cards from only one restricted card name');
    });

    it('keeps Key Abduction at one copy per deck', function () {
        expect(() =>
            service.validateAllianceRestrictedList(
                [
                    { id: 'key-abduction', count: 2 },
                    { id: 'dust-pixie', count: 1 }
                ],
                341
            )
        ).toThrow('Alliance restricted card key-abduction exceeds quantity limit of 1');
    });

    it('allows a single unchanged alliance deck even if it contains multiple restricted card names', async function () {
        const sourceDeck = {
            uuid: 'deck-1',
            expansion: 886,
            houses: ['logos', 'staralliance', 'untamed'],
            cards: [
                { id: 'reiteration', count: 1, house: 'logos' },
                { id: 'dextre', count: 1, house: 'logos' },
                { id: 'strategic-feint', count: 1, house: 'staralliance' },
                { id: 'medic-ingram', count: 1, house: 'staralliance' },
                { id: 'flaxia', count: 1, house: 'untamed' },
                { id: 'dust-pixie', count: 1, house: 'untamed' }
            ]
        };

        service.cardService = {
            getAllCards: vi.fn().mockResolvedValue({}),
            getCardsForExpansionById: vi.fn().mockResolvedValue({})
        };
        service.getByUuidForUser = vi.fn().mockResolvedValue(sourceDeck);
        service.insertDeck = vi.fn().mockImplementation(async (deck) => deck);
        service.validateAllianceRestrictedList = vi.fn(() => {
            throw new Error('restricted list should not be checked for an unchanged single deck');
        });

        const allianceDeck = await service.createAlliance(
            { id: 1 },
            {
                name: 'Single Deck Alliance',
                pods: ['deck-1:logos', 'deck-1:staralliance', 'deck-1:untamed']
            }
        );

        expect(service.validateAllianceRestrictedList).not.toHaveBeenCalled();
        expect(service.insertDeck).toHaveBeenCalledOnce();
        expect(allianceDeck.isAlliance).toBe(true);
        expect(allianceDeck.cards.map((card) => card.id)).toContain('reiteration');
        expect(allianceDeck.cards.map((card) => card.id)).toContain('strategic-feint');
    });

    it('no longer treats Hallafest as an alliance restricted card', function () {
        expect(() =>
            service.validateAllianceRestrictedList(
                [
                    { id: 'hallafest', count: 1 },
                    { id: 'befuddle', count: 1 }
                ],
                600
            )
        ).not.toThrow();
    });
});

// ARCHON: a whole-collection import has to be able to tell "Master Vault is
// throttling us" from "this deck is no good". Without that distinction the
// importer cannot back off, which is how a 257-deck sync once imported 3 and
// failed the other 254 in a few seconds.
describe('DeckService.create upstream failure classification', function () {
    const util = require('../../server/util');

    let service;
    let httpRequest;

    beforeEach(function () {
        service = new DeckService({}, {});
        httpRequest = vi.spyOn(util, 'httpRequest');
    });

    afterEach(function () {
        httpRequest.mockRestore();
    });

    const createFails = async () => {
        try {
            await service.create({ id: 1, username: 'p' }, { uuid: 'deck-uuid', username: 'p' });
        } catch (err) {
            return err;
        }

        throw new Error('expected create to throw');
    };

    it('marks a Master Vault rate limit as retryable, with a message that says so', async function () {
        const tooMany = new Error('Request failed');
        tooMany.statusCode = 429;
        httpRequest.mockRejectedValue(tooMany);

        const err = await createFails();

        expect(err.code).toBe('upstream_rate_limited');
        expect(err.statusCode).toBe(429);
        expect(err.message).toMatch(/rate limiting/i);
    });

    it('marks any other upstream failure as a plain error', async function () {
        const serverError = new Error('Request failed');
        serverError.statusCode = 500;
        httpRequest.mockRejectedValue(serverError);

        const err = await createFails();

        expect(err.code).toBe('upstream_error');
        expect(err.message).not.toMatch(/rate limiting/i);
    });

    // An HTML body is Master Vault serving an error page rather than JSON.
    it('does not mistake an HTML error page for a rate limit', async function () {
        httpRequest.mockResolvedValue('<html>nope</html>');

        const err = await createFails();

        expect(err.code).toBe('upstream_error');
    });
});
