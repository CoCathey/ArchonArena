describe('Tournament starting chains', function () {
    // ARCHON: tournaments can pre-assign chains (SAS handicap /
    // Chainbound accrual). They behave exactly like adaptive bid
    // chains: applied at initialise, before the setup phase draws
    // hands, so the first hand is drawn short and a chain sheds on
    // that first reduced refill.

    it('applies startingChains to the named player before setup', function () {
        this.game.startingChains = { player1: 7 };
        this.setupTest({
            phase: 'setup',
            player1: {},
            player2: {}
        });

        // The starting refill was reduced (7 chains = 2 fewer cards),
        // which sheds exactly one chain during setup: 7 -> 6. The
        // opponent is untouched.
        expect(this.player1.player.chains).toBe(6);
        expect(this.player2.player.chains).toBe(0);
    });

    it('leaves chains alone when no startingChains are given', function () {
        this.setupTest({
            phase: 'setup',
            player1: {},
            player2: {}
        });

        expect(this.player1.player.chains).toBe(0);
        expect(this.player2.player.chains).toBe(0);
    });

    it('interacts with the chain refill rule on later turns', function () {
        this.game.startingChains = { player1: 6 };
        this.setupTest({
            phase: 'setup',
            player1: {
                hand: ['zorg', 'batdrone', 'dextre']
            },
            player2: {
                inPlay: []
            }
        });
        this.player1.clickPrompt('mars');

        // 6 -> shed to 5 during the setup refill; with 3 cards in hand
        // a 5-chain refill (6 - 1 = 5 cards) draws up to 5 and sheds
        // another chain.
        expect(this.player1.player.chains).toBe(5);
        this.player1.endTurn();
        expect(this.player1.player.chains).toBe(4);
        expect(this.player1.hand.length).toBe(5);
    });
});
