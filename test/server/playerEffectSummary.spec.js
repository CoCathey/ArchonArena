describe('player effect summary', function () {
    describe('a lasting effect aimed at a player', function () {
        beforeEach(function () {
            this.setupTest({
                player1: {
                    house: 'unfathomable',
                    amber: 4,
                    inPlay: ['yanthi-ghostfin'],
                    hand: ['befuddle']
                },
                player2: {
                    amber: 3,
                    inPlay: ['batdrone'],
                    hand: ['helper-bot', 'dimension-door']
                }
            });
        });

        it('is empty while nothing constrains either player', function () {
            expect(this.game.effectEngine.getPlayerEffectSummary()).toEqual([]);
        });

        it('reports a pending effect as soon as it is applied', function () {
            this.player1.play(this.befuddle);
            this.player1.clickPrompt('logos');

            const summary = this.game.effectEngine.getPlayerEffectSummary();

            expect(summary.length).toBe(1);
            expect(summary[0].source.name).toBe('Befuddle');
            expect(summary[0].duration).toBe('duringOpponentNextTurn');
            expect(summary[0].pending).toBe(true);
            expect(summary[0].controller).toBe('player1');
            // Aimed at the opponent, who has not started their turn yet.
            expect(summary[0].targets).toEqual(['player2']);
        });

        it('still reports the effect once it is live on the opponent turn', function () {
            this.player1.play(this.befuddle);
            this.player1.clickPrompt('logos');
            this.player1.endTurn();
            this.player2.clickPrompt('logos');

            const summary = this.game.effectEngine.getPlayerEffectSummary();

            expect(summary.length).toBe(1);
            expect(summary[0].source.name).toBe('Befuddle');
            expect(summary[0].pending).toBe(false);
            expect(summary[0].targets).toEqual(['player2']);
            // Re-labelled by the engine when the opponent's turn began.
            expect(summary[0].duration).toBe('untilPlayerTurnEnd');
        });

        it('drops the effect once the constrained turn is over', function () {
            this.player1.play(this.befuddle);
            this.player1.clickPrompt('logos');
            this.player1.endTurn();
            this.player2.clickPrompt('logos');
            this.player2.endTurn();

            expect(this.game.effectEngine.getPlayerEffectSummary()).toEqual([]);
        });

        it('is carried on the game state sent to the client', function () {
            this.player1.play(this.befuddle);
            this.player1.clickPrompt('logos');

            const state = this.game.getState('player2');

            expect(state.effects.length).toBe(1);
            expect(state.effects[0].source.name).toBe('Befuddle');
        });
    });

    describe('creature-only lasting effects', function () {
        beforeEach(function () {
            this.setupTest({
                player1: {
                    house: 'brobnar',
                    hand: ['relentless-assault'],
                    inPlay: ['troll']
                },
                player2: {
                    inPlay: ['batdrone']
                }
            });
        });

        it('are left out — the card on the board already shows them', function () {
            this.player1.play(this.relentlessAssault);

            const summary = this.game.effectEngine.getPlayerEffectSummary();
            const sources = summary.map((entry) => entry.source && entry.source.name);

            expect(sources).not.toContain('Troll');
        });
    });
});
