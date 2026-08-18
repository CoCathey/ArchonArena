const {
    actionFeatures,
    stateFeatures
} = require('../../../../server/services/championschallenge/labFeatures');

/**
 * ARCHON (N45): the race, before anybody is at the line.
 *
 * The calibration ladder found this. A persona flying a flat `reap +0.6` beat
 * the trained champion, and the reason was not that the model cannot cross
 * state with action - it has always emitted `x:kind:context` - but that its
 * context vocabulary had no word for the APPROACH to a key. `keyReady` and
 * `oppAtCheck` are both "already there", and by the time either holds, the
 * decision that produced it was three turns ago.
 *
 * Nothing here could compare the two seats either. Every context described one
 * player, so "they are nearer their key than I am to mine" - the fact that
 * decides whether to race or to disrupt - was not expressible at all, and a
 * fixed bias approximated it better than a model that could not see it.
 *
 * The relative ones are easy to get backwards, and backwards would be worse
 * than absent: the model would learn to race when it should disrupt.
 */
const seat = (amber, keyCost = 6, opponent = null) => ({
    amber,
    getCurrentKeyCost: () => keyCost,
    getForgedKeys: () => 0,
    cardsInPlay: [],
    archives: [],
    creaturesInPlay: [],
    hand: [],
    deck: [],
    discard: [],
    opponent
});

const facing = (mine, theirs) => {
    const me = seat(mine.amber, mine.keyCost);
    const them = seat(theirs.amber, theirs.keyCost);

    me.opponent = them;
    them.opponent = me;

    return me;
};

const contextsOf = (player) =>
    new Set(
        Object.keys(actionFeatures({ kind: 'reap', player }).features)
            .filter((key) => key.startsWith('x:reap:'))
            .map((key) => key.slice('x:reap:'.length))
    );

describe('the race contexts', function () {
    describe('the approach', function () {
        it('sees a key coming before it arrives', function () {
            // Three short of a six-cost key: one good turn away, and the point
            // at which amber stops being a resource and starts being a clock.
            expect(contextsOf(facing({ amber: 3, keyCost: 6 }, { amber: 0 }))).toContain(
                'closingIn'
            );
        });

        it('does not call the opening turns a race', function () {
            expect(contextsOf(facing({ amber: 1, keyCost: 6 }, { amber: 1 }))).not.toContain(
                'closingIn'
            );
        });

        it('holds through the moment of forging, not just before it', function () {
            // A seat that can forge is also closing in; the two contexts stack
            // rather than replacing each other, so the model can weigh "at the
            // line" separately from "approaching it".
            const live = contextsOf(facing({ amber: 6, keyCost: 6 }, { amber: 0 }));

            expect(live).toContain('closingIn');
            expect(live).toContain('keyReady');
        });

        it('sees the opponent approaching too', function () {
            expect(contextsOf(facing({ amber: 0 }, { amber: 4, keyCost: 6 }))).toContain(
                'oppClosingIn'
            );
        });

        it('rises with the key cost, because a key is what is owed not what is held', function () {
            // Five amber against an eleven-cost key still owes six: not a
            // race, however much amber is on the table. The same five against
            // a six-cost key is one reap away.
            expect(contextsOf(facing({ amber: 5, keyCost: 11 }, { amber: 0 }))).not.toContain(
                'closingIn'
            );
            expect(contextsOf(facing({ amber: 5, keyCost: 6 }, { amber: 0 }))).toContain(
                'closingIn'
            );
        });
    });

    describe('who is ahead', function () {
        it('knows when the opponent is nearer their key', function () {
            // They owe two, I owe five. This is the position where a flat
            // "reap" bias was beating the trained model.
            const live = contextsOf(facing({ amber: 1, keyCost: 6 }, { amber: 4, keyCost: 6 }));

            expect(live).toContain('losingRace');
            expect(live).not.toContain('winningRace');
        });

        it('knows when it is ahead', function () {
            const live = contextsOf(facing({ amber: 5, keyCost: 6 }, { amber: 1, keyCost: 6 }));

            expect(live).toContain('winningRace');
            expect(live).not.toContain('losingRace');
        });

        it('calls a dead heat neither', function () {
            // Both owe three. Claiming either would be a lie the model would
            // learn from.
            const live = contextsOf(facing({ amber: 3, keyCost: 6 }, { amber: 3, keyCost: 6 }));

            expect(live).not.toContain('winningRace');
            expect(live).not.toContain('losingRace');
        });

        it('measures what is owed, not what is held', function () {
            // I hold more amber and am FURTHER from a key, because my next key
            // costs more. Comparing raw amber would get this exactly backwards.
            const live = contextsOf(facing({ amber: 7, keyCost: 11 }, { amber: 4, keyCost: 6 }));

            expect(live).toContain('losingRace');
            expect(live).not.toContain('winningRace');
        });
    });

    describe('what the model can now say', function () {
        it('crosses the race with the action, which is the whole point', function () {
            const { features } = actionFeatures({
                kind: 'reap',
                player: facing({ amber: 1, keyCost: 6 }, { amber: 4, keyCost: 6 })
            });

            // "Reaping, while losing the race" is now one weight the loop can
            // learn. Before this it could only learn "reaping", on average,
            // across every position in every game.
            expect(features['x:reap:losingRace']).toBe(1);
        });

        it('gives fighting its own race weights too, not just reaping', function () {
            const { features } = actionFeatures({
                kind: 'fight',
                player: facing({ amber: 1, keyCost: 6 }, { amber: 4, keyCost: 6 })
            });

            // The interesting claim is not "reap more" - it is that the right
            // answer differs by action, which needs both sides represented.
            expect(features['x:fight:losingRace']).toBe(1);
        });

        it('emits only the contexts that hold, keeping a record small', function () {
            const { features } = actionFeatures({
                kind: 'reap',
                player: facing({ amber: 0, keyCost: 6 }, { amber: 0, keyCost: 6 })
            });

            expect(features['x:reap:closingIn']).toBeUndefined();
            expect(features['x:reap:losingRace']).toBeUndefined();
        });
    });

    it('leaves the state features alone - a race context is about a MOVE', function () {
        const game = { round: 4 };
        const player = facing({ amber: 1, keyCost: 6 }, { amber: 4, keyCost: 6 });
        const state = stateFeatures(game, player);

        // A state fact is identical across every candidate at one decision and
        // cancels out of the ranking, so putting the race there could never
        // change a move. It has to be crossed with the kind to do any work.
        expect(Object.keys(state)).not.toContain('losingRace');
    });
});
