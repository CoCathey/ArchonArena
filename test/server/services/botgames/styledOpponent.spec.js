const BotService = require('../../../../server/services/botgames/BotService');
const {
    PERSONA_KEYS,
    personaByKey
} = require('../../../../server/services/championschallenge/labPersonas');

/**
 * ARCHON (N31): choosing who you practise against.
 *
 * The lab measures decks against three sparring pilots (N28). The same three are
 * now offered as the practice opponent in the lobby, which is the whole point of
 * having built them as a bias on one learned brain rather than as three separate
 * bots: the Racer a member plays is the Racer their decks were measured against.
 *
 * The properties worth pinning are the refusals. A style is a bias on the
 * champion's weights, so with no champion there is nothing to bias - and a
 * picker that changes nothing is worse than no picker, because it looks like it
 * worked. Everything else is one rotation and one lookup.
 */
describe('the practice bot’s style', function () {
    let service;
    let config;
    let champion;

    const settingsService = {
        getSectionWithDefaults: () => ({ ...config })
    };

    beforeEach(function () {
        config = { useLearnedPolicy: true, styledOpponents: true, styleStrength: 1 };
        champion = { version: 5, weights: { 'a:act:reap': 0.2 }, cardWeights: {} };
        service = new BotService({ settingsService, db: { query: vi.fn() } });
        service.policyService = { champion: vi.fn().mockResolvedValue(champion) };
    });

    afterEach(function () {
        vi.restoreAllMocks();
    });

    describe('the model it hands the table', function () {
        it('is the champion itself with no style', async function () {
            expect(await service.championModel()).toBe(champion);
        });

        it('is the champion wearing the style when one is chosen', async function () {
            const model = await service.championModel(personaByKey('bruiser'));

            expect(model.persona).toBe('bruiser');
            expect(model.weights['a:act:fight']).toBeCloseTo(
                personaByKey('bruiser').bias['a:act:fight'],
                6
            );
            // The champion it was built from is untouched: one model is shared
            // by every table, and a style that mutated it would restyle the lobby.
            expect(champion.weights['a:act:fight']).toBeUndefined();
        });

        it('takes the strength from the bots’ own dial', async function () {
            config.styleStrength = 0.5;

            const model = await service.championModel(personaByKey('racer'));

            expect(model.weights['a:act:reap']).toBeCloseTo(
                0.2 + personaByKey('racer').bias['a:act:reap'] / 2,
                6
            );
        });

        // The heuristics are what a site plays before the lab crowns a champion,
        // and what an admin gets when they switch learned play off.
        it('is nothing at all when learned play is off', async function () {
            config.useLearnedPolicy = false;

            expect(await service.championModel(personaByKey('racer'))).toBeNull();
        });

        it('never fails a table over a model it could not read', async function () {
            service.policyService.champion = vi.fn().mockRejectedValue(new Error('db down'));

            expect(await service.championModel(personaByKey('racer'))).toBeNull();
        });
    });

    describe('what the picker offers', function () {
        it('offers all three styles', async function () {
            const styles = await service.availableStyles();

            expect(styles.map((style) => style.key)).toEqual(PERSONA_KEYS);
            expect(styles.every((style) => style.label && style.description)).toBe(true);
        });

        it('offers nothing when styled opponents are switched off', async function () {
            config.styledOpponents = false;

            expect(await service.availableStyles()).toEqual([]);
            expect(service.nextStyle()).toBeNull();
        });

        /**
         * The load-bearing refusal. A persona is a bias ON the champion's
         * weights, so with no champion a style changes nothing whatsoever - and
         * a picker that visibly does nothing is worse than one that is absent,
         * because the player cannot tell which they are looking at.
         */
        it('offers nothing when there is no champion to dress', async function () {
            service.policyService.champion = vi.fn().mockResolvedValue(null);

            expect(await service.availableStyles()).toEqual([]);
        });

        it('rotates the style each table opens with', function () {
            const opened = [service.nextStyle(), service.nextStyle(), service.nextStyle()];

            expect(opened.map((style) => style.key)).toEqual(PERSONA_KEYS);
        });

        it('reads a chosen key back, and an unknown one as no style', function () {
            expect(service.styleFor('schemer').key).toBe('schemer');
            expect(service.styleFor('')).toBeNull();
            expect(service.styleFor('wishful-thinking')).toBeNull();
        });
    });
});
