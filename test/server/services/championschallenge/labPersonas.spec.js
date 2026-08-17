const {
    PERSONAS,
    PERSONA_KEYS,
    personaByKey,
    personaModel,
    personaFor,
    personaPairs,
    personaPairFor,
    duelPairKey
} = require('../../../../server/services/championschallenge/labPersonas');
const {
    actionFeatures,
    stateFeaturesFrom,
    ACTION_KINDS
} = require('../../../../server/services/championschallenge/labFeatures');
const {
    emptyModel,
    scoreDecision,
    chooseDecision
} = require('../../../../server/services/championschallenge/labPolicy');

/**
 * ARCHON (N28): three sparring pilots.
 *
 * The load-bearing test in this file is the FIRST one. A persona is a set of
 * biases keyed by the model's own weight names, and a name that does not match
 * anything the feature extractor emits is silently inert - the weight applies to
 * a feature that never appears, so the persona is simply the champion with extra
 * steps. Nothing errors, nothing logs, and the lab reports three styles while
 * playing one. So every bias key is checked against the extractor's real output.
 *
 * The second property worth pinning is that a persona actually changes what the
 * bot does, because "diversity that does not diversify" is the same failure
 * wearing a different hat.
 */
describe('sparring personas', function () {
    // A card as the feature extractor touches it.
    const card = (props = {}) => ({
        id: props.id || 'card-1',
        type: props.type || 'creature',
        power: props.power || 3,
        armor: props.armor || 0,
        exhausted: !!props.exhausted,
        stunned: !!props.stunned,
        location: props.location || 'play area',
        tokens: props.tokens || {},
        cardData: props.cardData || { amber: 1 },
        controller: props.controller || { name: 'them' }
    });

    const player = { name: 'me', hand: [], cardsInPlay: [] };

    /**
     * Every weight key the model can ever see: `a:` for the action extractor's
     * output over every kind it knows, `s:` for the state's. Built by CALLING the
     * extractor rather than by listing keys, so a rename in labFeatures shows up
     * here as a failing persona rather than as a persona that quietly stops
     * meaning anything.
     */
    const producibleKeys = () => {
        const keys = new Set();

        for (const kind of ACTION_KINDS) {
            for (const subject of [
                card(),
                card({ type: 'artifact' }),
                card({ controller: player, location: 'hand' })
            ]) {
                const { features } = actionFeatures({
                    kind,
                    card: subject,
                    house: 'brobnar',
                    player
                });

                for (const key of Object.keys(features)) {
                    keys.add(`a:${key}`);
                }
            }
        }

        const seat = { amber: 3, keys: 1, keyCost: 6, creatures: [], artifacts: 0, hand: 5 };

        for (const key of Object.keys(stateFeaturesFrom({ round: 2, me: seat, them: seat }))) {
            keys.add(`s:${key}`);
        }

        return keys;
    };

    it('biases only features the model can actually see', function () {
        const keys = producibleKeys();

        for (const persona of PERSONAS) {
            for (const key of Object.keys(persona.bias)) {
                expect(keys.has(key), `${persona.key} biases unknown feature ${key}`).toBe(true);
            }
        }
    });

    /**
     * State features are identical for every candidate at one decision point, so
     * a state weight cannot change which move ranks first. A persona built out of
     * them would look meaningful on the page and do nothing at the table.
     */
    it('biases action features only, because state biases cannot change a choice', function () {
        for (const persona of PERSONAS) {
            for (const key of Object.keys(persona.bias)) {
                expect(key.startsWith('a:')).toBe(true);
            }
        }
    });

    it('is three distinct, named styles', function () {
        expect(PERSONAS).toHaveLength(3);
        expect(new Set(PERSONA_KEYS).size).toBe(3);

        for (const persona of PERSONAS) {
            expect(persona.label).toBeTruthy();
            expect(persona.description).toBeTruthy();
            expect(Object.keys(persona.bias).length).toBeGreaterThan(2);
        }
    });

    describe('the styled model', function () {
        const base = { ...emptyModel(), version: 4, weights: { 'a:act:reap': 0.1 } };

        it('adds the bias to the champion rather than replacing it', function () {
            const racer = personaModel(base, personaByKey('racer'));

            expect(racer.weights['a:act:reap']).toBeCloseTo(
                0.1 + PERSONAS[0].bias['a:act:reap'],
                6
            );
            expect(racer.version).toBe(4);
            expect(racer.persona).toBe('racer');
        });

        // The champion is shared across every game of a sweep; a persona that
        // mutated it would restyle the whole lab, quietly and permanently.
        it('never touches the champion it was built from', function () {
            personaModel(base, personaByKey('bruiser'));

            expect(base.weights['a:act:reap']).toBe(0.1);
            expect(base.persona).toBeUndefined();
        });

        it('scales with strength, and at zero is the champion itself', function () {
            const half = personaModel(base, personaByKey('racer'), 0.5);

            expect(half.weights['a:act:reap']).toBeCloseTo(
                0.1 + PERSONAS[0].bias['a:act:reap'] / 2,
                6
            );
            expect(personaModel(base, personaByKey('racer'), 0)).toBe(base);
        });

        // No trained brain means the heuristics play, as they always have. A
        // bias-only model would be a fourth kind of player nobody asked for.
        it('stays out of the way when there is no model', function () {
            expect(personaModel(null, personaByKey('racer'))).toBeNull();
        });

        it('is the model itself for an unknown persona', function () {
            expect(personaModel(base, null)).toBe(base);
            expect(personaByKey('nonesuch')).toBeNull();
        });
    });

    /**
     * The point of the whole feature: two pilots, one position, different move.
     * Reap and fight are the same decision to the champion here (no weights), so
     * whichever way it breaks the tie, the two personas must break it differently.
     */
    it('changes which move the bot picks', function () {
        const decisionFor = (kind) => {
            const { features, cardId } = actionFeatures({ kind, card: card(), player });

            return {
                state: stateFeaturesFrom({
                    round: 3,
                    me: { amber: 2, keys: 0, keyCost: 6, creatures: [], artifacts: 0, hand: 4 },
                    them: { amber: 2, keys: 0, keyCost: 6, creatures: [], artifacts: 0, hand: 4 }
                }),
                action: features,
                cardId
            };
        };
        const options = [decisionFor('reap'), decisionFor('fight')];
        const champion = emptyModel();

        const racer = chooseDecision(
            personaModel({ ...champion }, personaByKey('racer')),
            options,
            0,
            () => 0
        );
        const bruiser = chooseDecision(
            personaModel({ ...champion }, personaByKey('bruiser')),
            options,
            0,
            () => 0
        );

        expect(options[racer].action['act:reap']).toBe(1);
        expect(options[bruiser].action['act:fight']).toBe(1);
    });

    it('leaves the score in (0, 1), bias and all', function () {
        const { features, cardId } = actionFeatures({ kind: 'reap', card: card(), player });
        const score = scoreDecision(personaModel(emptyModel(), personaByKey('racer'), 3), {
            state: {},
            action: features,
            cardId
        });

        expect(score).toBeGreaterThan(0);
        expect(score).toBeLessThan(1);
    });

    describe('the rotation', function () {
        // Round-robin, not a coin: with three pilots and a few dozen games a day
        // per deck, a coin leaves one pilot with half the games of another often
        // enough to matter, and the per-style records are the point.
        it('hands out the pilots in turn', function () {
            expect([0, 1, 2, 3, 4, 5].map((index) => personaFor(index).key)).toEqual([
                ...PERSONA_KEYS,
                ...PERSONA_KEYS
            ]);
        });

        it('survives a nonsense cursor', function () {
            expect(personaFor(-1).key).toBeTruthy();
            expect(personaFor(undefined).key).toBe(PERSONA_KEYS[0]);
        });

        it('duels every pair, in turn', function () {
            expect(personaPairs()).toHaveLength(3);
            expect([0, 1, 2, 3].map((index) => personaPairFor(index).map((p) => p.key))).toEqual([
                ['racer', 'bruiser'],
                ['racer', 'schemer'],
                ['bruiser', 'schemer'],
                ['racer', 'bruiser']
            ]);
        });

        // One pair, one row - not two halves of the same record filed under
        // different names.
        it('names a duel the same way round either way', function () {
            expect(duelPairKey('racer', 'schemer')).toEqual(duelPairKey('schemer', 'racer'));
        });
    });
});
