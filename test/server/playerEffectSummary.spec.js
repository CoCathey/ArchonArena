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

    describe('key-cost effects aimed at both players', function () {
        beforeEach(function () {
            this.setupTest({
                player1: {
                    house: 'unfathomable',
                    hand: ['crushing-deep']
                },
                player2: {
                    inPlay: ['batdrone']
                }
            });
        });

        // Crushing Deep uses targetController 'any', so the raised key cost
        // applies to everyone - the summary has to say so rather than assuming
        // the opponent.
        it('names both players', function () {
            this.player1.play(this.crushingDeep);

            const summary = this.game.effectEngine.getPlayerEffectSummary();
            const entry = summary.find((row) => row.source.name === 'Crushing Deep');

            expect(entry).toBeDefined();
            expect(entry.targets.slice().sort()).toEqual(['player1', 'player2']);
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

// The pending (`duringOpponentNextTurn`) list holds effects that have not been
// applied to anything yet, so a card effect and a player effect are
// indistinguishable by their targets. Exercised directly because no card in
// the current pool queues a plain card effect that way — one may tomorrow.
describe('player effect summary classification', function () {
    const EffectEngine = require('../../server/game/effectengine.js');
    const CardEffect = require('../../server/game/Effects/CardEffect');
    const PlayerEffect = require('../../server/game/Effects/PlayerEffect');
    const StaticEffect = require('../../server/game/Effects/StaticEffect');

    let engine;
    let players;

    beforeEach(function () {
        players = [{ name: 'player1' }, { name: 'player2' }];
        const game = {
            on: () => {},
            removeListener: () => {},
            getPlayers: () => players
        };
        engine = new EffectEngine(game);
    });

    const source = {
        id: 'a-card',
        name: 'A Card',
        getShortSummary: () => ({ id: 'a-card', name: 'A Card' })
    };

    const makeEffect = (Klass, targetController) =>
        new Klass(
            { getPlayers: () => players },
            source,
            {
                duration: 'duringOpponentNextTurn',
                targetController,
                // Supplied so the constructor does not reach for a framework
                // context off a real game.
                context: { player: players[0] }
            },
            new StaticEffect('someRestriction', true)
        );

    it('reports a pending player effect', function () {
        const effect = makeEffect(PlayerEffect, 'opponent');
        effect.effectController = players[0];
        engine.duringOpponentNextTurnEffects.push(effect);

        const summary = engine.getPlayerEffectSummary();

        expect(summary).toHaveLength(1);
        expect(summary[0].targets).toEqual(['player2']);
        expect(summary[0].pending).toBe(true);
    });

    it('ignores a pending card effect', function () {
        const effect = makeEffect(CardEffect, 'opponent');
        effect.effectController = players[0];
        engine.duringOpponentNextTurnEffects.push(effect);

        expect(engine.getPlayerEffectSummary()).toEqual([]);
    });

    it('collapses several effects from one card into a single entry', function () {
        for (const Klass of [PlayerEffect, PlayerEffect]) {
            const effect = makeEffect(Klass, 'opponent');
            effect.effectController = players[0];
            engine.duringOpponentNextTurnEffects.push(effect);
        }

        expect(engine.getPlayerEffectSummary()).toHaveLength(1);
    });
});
