/**
 * ARCHON (N15): why is that creature bigger?
 *
 * A persistent effect changes the board without ever prompting anybody. The
 * player sees a creature printed at 8 sitting at 9 and the interface says
 * nothing about which card is responsible - not in a prompt, because none
 * fires, and not in the log, because only a few hundred of the 2,600 card
 * scripts define a message.
 *
 * The engine has always known: every effect carries the context of the card
 * that applied it. This pins the fact that the card summary now carries it too,
 * against the real engine and real cards rather than a hand-built effect.
 */
describe('effect attribution in the card summary', function () {
    describe('a creature under a persistent effect', function () {
        beforeEach(function () {
            this.setupTest({
                player1: {
                    house: 'brobnar',
                    hand: ['banner-of-battle'],
                    inPlay: ['troll']
                },
                player2: {
                    inPlay: ['hunting-witch']
                }
            });
        });

        it('names the card responsible once the effect is in play', function () {
            const before = this.troll.getSummary(this.player1.player);

            expect(before.modifiedPower).toBe(before.powerPrinted);
            expect(before.effectSources).toEqual([]);

            // Banner of Battle is an artifact with a persistent effect: it
            // asks nobody anything, it just makes friendly creatures bigger.
            this.player1.play(this.bannerOfBattle);

            const after = this.troll.getSummary(this.player1.player);

            // The board shows the new number...
            expect(after.modifiedPower).toBe(after.powerPrinted + 1);
            // ...and now says where it came from.
            expect(after.effectSources).toEqual(['Banner of Battle']);
        });

        it('leaves a creature the effect does not reach unattributed', function () {
            this.player1.play(this.bannerOfBattle);

            // The banner only buffs its controller's creatures, so the
            // opponent's creature is untouched - which is the control proving
            // this reports the effects actually applied rather than everything
            // in play.
            const enemy = this.huntingWitch.getSummary(this.player2.player);

            expect(enemy.effectSources).toEqual([]);
        });

        it('drops the attribution when the effect leaves', function () {
            this.player1.play(this.bannerOfBattle);
            expect(this.troll.getSummary(this.player1.player).effectSources).toEqual([
                'Banner of Battle'
            ]);

            this.player1.moveCard(this.bannerOfBattle, 'discard');

            const summary = this.troll.getSummary(this.player1.player);

            expect(summary.modifiedPower).toBe(summary.powerPrinted);
            expect(summary.effectSources).toEqual([]);
        });
    });

    describe('two cards acting on the same creature', function () {
        beforeEach(function () {
            this.setupTest({
                player1: {
                    house: 'brobnar',
                    hand: ['banner-of-battle', 'blood-of-titans'],
                    inPlay: ['troll']
                },
                player2: {}
            });
        });

        // A turn where three things resolve is exactly when a player loses
        // track, so both have to be named rather than the most recent one.
        it('names both, without repeating either', function () {
            this.player1.play(this.bannerOfBattle);
            this.player1.playUpgrade(this.bloodOfTitans, this.troll);

            const sources = this.troll.getSummary(this.player1.player).effectSources;

            expect(sources).toContain('Banner of Battle');
            expect(sources).toContain('Blood of Titans');
            expect(new Set(sources).size).toBe(sources.length);
        });
    });
});
