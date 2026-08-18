const { ROLES, classify, rolesFor } = require('../../../server/services/membership/cardKnowledge');

/**
 * ARCHON (F3): the card knowledge the misplay review reads with.
 *
 * Two halves. The patterns are tested against literal card texts, because a
 * pattern that drifts wide starts suppressing real flags or inventing false
 * ones - precision is the whole contract. The bottom block reads the real
 * master-vault packs, which is the only thing that proves the loader, the id
 * scheme and the patterns agree with the actual pool.
 */
describe('card knowledge', function () {
    describe('classify', function () {
        it('reads steal and capture as amber control', function () {
            expect(classify({ text: 'Play: Steal 1<A>.' }).has(ROLES.AMBER_CONTROL)).toBe(true);
            expect(classify({ text: 'After Fight: Capture 2<A>.' }).has(ROLES.AMBER_CONTROL)).toBe(
                true
            );
            expect(classify({ text: 'Play: Gain 2<A>.' }).has(ROLES.AMBER_CONTROL)).toBe(false);
        });

        it('reads wide destruction as a board wipe, but never a self-wipe', function () {
            const wipes = [
                'Play: Destroy each creature.',
                'Play: Destroy each enemy creature.',
                'Play: Destroy each undamaged creature. Gain 3 chains.',
                'Play: Destroy each creature with power 3 or lower.',
                'Play: Deal 2 damage to each enemy creature.'
            ];

            for (const text of wipes) {
                expect(classify({ text }).has(ROLES.BOARD_WIPE), text).toBe(true);
            }

            expect(
                classify({ text: 'Play: Destroy each friendly creature.' }).has(ROLES.BOARD_WIPE)
            ).toBe(false);
            expect(classify({ text: 'Fight: Destroy a creature.' }).has(ROLES.BOARD_WIPE)).toBe(
                false
            );
        });

        it('reads forging outside the forge step as a key cheat, minus negations', function () {
            expect(
                classify({ text: 'Action: Forge a key at +3<A> current cost.' }).has(
                    ROLES.KEY_CHEAT
                )
            ).toBe(true);
            expect(
                classify({ text: 'Your opponent cannot forge a key on their next turn.' }).has(
                    ROLES.KEY_CHEAT
                )
            ).toBe(false);
        });

        it('reads key taxes and opponent forge denial, but never locks and drawbacks', function () {
            const denial = [
                'Action: Keys cost +3<A> during your opponent’s next turn.',
                'Action: Keys cost +3A during your opponent’s next turn.',
                'Play: Keys cost +1 for each Dis creature in play during your opponent’s next turn.',
                'While you control a token creature, your opponent cannot forge keys.',
                'Play: Your opponent skips the “forge a key” step on their next turn.'
            ];

            for (const text of denial) {
                expect(classify({ text }).has(ROLES.FORGE_DENIAL), text).toBe(true);
            }

            // A tool that jams your own forge as hard as theirs is a
            // strategy, not an answer - and a self-drawback is neither.
            expect(classify({ text: 'Players cannot forge keys.' }).has(ROLES.FORGE_DENIAL)).toBe(
                false
            );
            expect(classify({ text: 'You cannot forge keys.' }).has(ROLES.FORGE_DENIAL)).toBe(
                false
            );
        });

        it('does not mistake talk of the forge step for forging a key', function () {
            // Miasma skips the step; it cheats nothing out.
            expect(
                classify({
                    text: 'Play: Your opponent skips the “forge a key” step on their next turn.'
                }).has(ROLES.KEY_CHEAT)
            ).toBe(false);
            // But forging DURING the step, again, is a real extra key.
            expect(
                classify({
                    text:
                        'After you forge a key during your “forge a key” step, you may forge ' +
                        'another key at current cost.'
                }).has(ROLES.KEY_CHEAT)
            ).toBe(true);
        });

        it('reads a creature that forbids its own reap', function () {
            expect(
                classify({ type: 'creature', text: 'This creature cannot reap.' }).has(
                    ROLES.CANNOT_REAP
                )
            ).toBe(true);
            // An artifact taxing the enemy is not a self-restriction.
            expect(
                classify({ type: 'artifact', text: 'Enemy creatures cannot reap.' }).has(
                    ROLES.CANNOT_REAP
                )
            ).toBe(false);
        });

        it('classifies nothing from nothing', function () {
            expect(classify(null).size).toBe(0);
            expect(classify({}).size).toBe(0);
            expect(classify({ text: 'Taunt. Elusive.' }).size).toBe(0);
        });
    });

    // The real pool, through the real loader. These cards' functions are as
    // stable as the cards themselves.
    describe('against the master vault', function () {
        it('knows Urchin steals', function () {
            expect(rolesFor('urchin').has(ROLES.AMBER_CONTROL)).toBe(true);
        });

        it('knows Gateway to Dis clears the board', function () {
            expect(rolesFor('gateway-to-dis').has(ROLES.BOARD_WIPE)).toBe(true);
        });

        it('knows Key Charge forges', function () {
            expect(rolesFor('key-charge').has(ROLES.KEY_CHEAT)).toBe(true);
        });

        it('knows Lash of Broken Dreams taxes keys, and Miasma skips the forge', function () {
            expect(rolesFor('lash-of-broken-dreams').has(ROLES.FORGE_DENIAL)).toBe(true);
            expect(rolesFor('miasma').has(ROLES.FORGE_DENIAL)).toBe(true);
            expect(rolesFor('miasma').has(ROLES.KEY_CHEAT)).toBe(false);
        });

        it('gives a plain card no roles, and an unknown id an empty set', function () {
            expect(rolesFor('troll').size).toBe(0);
            expect(rolesFor('no-such-card').size).toBe(0);
            expect(rolesFor(null).size).toBe(0);
        });
    });
});
