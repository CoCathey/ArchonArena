const {
    deltaFeatures,
    SCALE
} = require('../../../../server/services/championschallenge/labAfterstate');
const {
    decisionRecord,
    stateFeatures
} = require('../../../../server/services/championschallenge/labFeatures');

/**
 * ARCHON (N43): judge a move by the position it produces.
 *
 * The complaint that produced this was "the bots do not seem to think" - and
 * the cause was not randomness. The live driver plays greedily; it explores
 * nothing. It was that `scoreDecision` scores each candidate on its own, as a
 * description of a MOVE, with no representation of what the move does. Reaping
 * scored the same whether it took the seat to a key or spent the last ready
 * creature before a swing.
 *
 * True lookahead is not available: the deep bot searches by replaying a seeded
 * input log from the start, and a live game against a person has no such log.
 * But most of one ply needs no search, because the mechanical effect of a
 * KeyForge action is known exactly.
 *
 * Two properties carry the idea, and both are ways it could go quietly wrong:
 * the deltas must be on the SAME SCALES as the state features they mirror, or
 * one axis silently dominates; and a kind whose effect is card text must emit
 * NOTHING, because a guess is a fiction the loop would train on.
 */
const seat = (amber, keyCost = 6) => ({
    amber,
    getCurrentKeyCost: () => keyCost,
    creaturesInPlay: [],
    hand: [],
    deck: [],
    discard: [],
    getForgedKeys: () => 0,
    cardsInPlay: [],
    archives: []
});

describe('what a move does', function () {
    describe('reaping', function () {
        it('is an amber AND a creature that can no longer act', function () {
            const delta = deltaFeatures({ kind: 'reap' });

            expect(delta['d:amber']).toBeCloseTo(1 / SCALE.amber, 10);
            // The half that makes reaping cost something. Without it the model
            // could only learn that amber is good - which is precisely the
            // bias that was beating it on the calibration ladder.
            expect(delta['d:ready']).toBeCloseTo(-1 / SCALE.ready, 10);
        });

        it('says when it forges, which is not a quantity but a threshold', function () {
            expect(deltaFeatures({ kind: 'reap', player: seat(5, 6) })['d:forges']).toBe(1);
        });

        it('does not claim a key it does not reach', function () {
            expect(deltaFeatures({ kind: 'reap', player: seat(2, 6) })['d:forges']).toBeUndefined();
        });

        it('does not claim a key for a seat that could already forge', function () {
            // Nothing is crossed: they were at the line before the move.
            expect(deltaFeatures({ kind: 'reap', player: seat(6, 6) })['d:forges']).toBeUndefined();
        });

        it('accounts for the rising key cost', function () {
            // Eight amber is one reap from a nine-cost key and four from a
            // twelve-cost one. Comparing amber HELD rather than amber owed
            // would call those the same position.
            expect(deltaFeatures({ kind: 'reap', player: seat(8, 9) })['d:forges']).toBe(1);
            expect(
                deltaFeatures({ kind: 'reap', player: seat(8, 12) })['d:forges']
            ).toBeUndefined();
            // The amber itself is worth the same either way - only the key is
            // contingent on what is owed.
            expect(deltaFeatures({ kind: 'reap', player: seat(8, 12) })['d:amber']).toBeCloseTo(
                deltaFeatures({ kind: 'reap', player: seat(8, 9) })['d:amber'],
                10
            );
        });
    });

    describe('the board', function () {
        it('counts a played creature as board, power and a card spent', function () {
            const delta = deltaFeatures({ kind: 'playCreature', card: { power: 6 } });

            expect(delta['d:creatures']).toBeCloseTo(1 / SCALE.creatures, 10);
            expect(delta['d:power']).toBeCloseTo(6 / SCALE.power, 10);
            expect(delta['d:hand']).toBeCloseTo(-1 / SCALE.hand, 10);
        });

        it('pays the bonus amber a card carries in with it', function () {
            const delta = deltaFeatures({
                kind: 'playCreature',
                card: { power: 3, cardData: { amber: 2 } }
            });

            // A fact about the card, not about its text.
            expect(delta['d:amber']).toBeCloseTo(2 / SCALE.amber, 10);
        });

        it('treats fighting as exhaustion and power at risk', function () {
            const delta = deltaFeatures({ kind: 'fight', card: { power: 4 } });

            expect(delta['d:ready']).toBeLessThan(0);
            // Not a death - this cannot know whether either creature survives,
            // so it models the power on the line rather than inventing a body
            // count the rules would have to agree with.
            expect(delta['d:power']).toBeLessThan(0);
        });
    });

    describe('what it refuses to guess', function () {
        it('says nothing about an action card beyond the card leaving hand', function () {
            const delta = deltaFeatures({ kind: 'playAction', card: { power: 0 } });

            expect(Object.keys(delta)).toEqual(['d:hand']);
        });

        it('says nothing at all about a house call', function () {
            // The biggest decision of a turn, and its consequence is the whole
            // rest of the turn. A one-step effect model must not pretend to it.
            expect(deltaFeatures({ kind: 'houseCall' })).toEqual({});
        });

        it('says nothing about answering a prompt', function () {
            expect(deltaFeatures({ kind: 'select' })).toEqual({});
            expect(deltaFeatures({ kind: 'button' })).toEqual({});
        });

        it('never emits a zero, which would be a claim that nothing happened', function () {
            for (const kind of ['reap', 'fight', 'playCreature', 'playAction', 'discard']) {
                const delta = deltaFeatures({ kind, card: { power: 0 } });

                for (const value of Object.values(delta)) {
                    expect(value).not.toBe(0);
                }
            }
        });
    });

    describe('how it reaches the model', function () {
        it('rides with the action features, so scoring and training both see it', function () {
            const player = seat(5, 6);
            const record = decisionRecord({ round: 3 }, player, { kind: 'reap' });

            // The whole trick: scoreDecision already sums every action feature
            // and trainModel already learns a weight for every one, so judging
            // a move by its consequence needed no change to either.
            expect(record.action['d:amber']).toBeGreaterThan(0);
            expect(record.action['d:forges']).toBe(1);
            // And the move is still described as itself.
            expect(record.action['act:reap']).toBe(1);
        });

        it('leaves the state features untouched', function () {
            const player = seat(5, 6);
            const state = stateFeatures({ round: 3 }, player);

            // A delta belongs to a move. In the state it would be identical
            // across every candidate and cancel out of the ranking.
            expect(Object.keys(state).some((key) => key.startsWith('d:'))).toBe(false);
        });

        it('is commensurate with the state feature it mirrors', function () {
            // A weight learned for `d:amber` has to mean the same kind of
            // quantity as one learned for `s:myAmber`, or one axis silently
            // dominates the other.
            const player = seat(0, 6);
            const before = stateFeatures({ round: 1 }, player);

            player.amber = 1;

            const after = stateFeatures({ round: 1 }, player);
            const delta = deltaFeatures({ kind: 'reap' });

            expect(after.myAmber - before.myAmber).toBeCloseTo(delta['d:amber'], 10);
        });
    });
});
