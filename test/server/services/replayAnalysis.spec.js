const ReplayAnalysisService = require('../../../server/services/membership/ReplayAnalysisService');
const { analyseReplay } = require('../../../server/services/membership/ReplayAnalysisService');

/**
 * ARCHON (N12): replay analysis.
 *
 * Two halves, tested two ways. The arithmetic is checked against hand-built
 * recordings, where every number in the answer can be worked out by reading the
 * fixture. The bottom block then plays a real game through the engine and
 * analyses what it actually recorded, which is the only thing that proves the
 * analysis and the capture format agree.
 */
describe('replay analysis', function () {
    /** A board frame: whose turn, and where both players stand. */
    const frame = (messageIndex, round, activePlayer, players) => ({
        messageIndex,
        board: {
            round,
            activePlayer,
            players: Object.entries(players).map(([name, state]) => ({
                name,
                activeHouse: state.house,
                stats: {
                    amber: state.amber ?? 0,
                    chains: state.chains ?? 0,
                    keys: state.keys || { red: false, blue: false, yellow: false }
                },
                numHandCards: state.hand ?? 6,
                numDeckCards: state.deck ?? 20,
                cardPiles: {
                    cardsInPlay: state.creatures || [],
                    discard: state.discard || [],
                    purged: [],
                    archives: []
                }
            }))
        }
    });

    const keys = (count) => ({
        red: count >= 1,
        blue: count >= 2,
        yellow: count >= 3
    });

    // A card table with one creature in it, so `creatures: [0]` in a fixture
    // means "one creature on the board".
    const cards = [{ id: 'troll', name: 'Troll', type: 'creature' }];

    describe('one game', function () {
        it('says so, rather than inventing numbers, when there is nothing to read', function () {
            expect(analyseReplay(null).available).toBe(false);
            expect(analyseReplay({ snapshots: [] }).available).toBe(false);
            // A version 1 recording is the message log alone.
            expect(analyseReplay({ version: 1, messages: [{}], snapshots: [] }).reason).toMatch(
                /before board states were captured/
            );
        });

        it('breaks the game into turns, with the house that was called on each', function () {
            const analysis = analyseReplay({
                version: 3,
                winner: 'alice',
                players: [{ name: 'alice' }, { name: 'bob' }],
                cards,
                snapshots: [
                    frame(0, 1, 'alice', { alice: { house: 'brobnar' }, bob: {} }),
                    frame(5, 1, 'alice', { alice: { house: 'brobnar', amber: 3 }, bob: {} }),
                    frame(9, 1, 'bob', { alice: { amber: 3 }, bob: { house: 'untamed' } }),
                    frame(14, 1, 'bob', {
                        alice: { amber: 3 },
                        bob: { house: 'untamed', amber: 2 }
                    }),
                    frame(20, 2, 'alice', {
                        alice: { house: 'shadows', amber: 3 },
                        bob: { amber: 2 }
                    })
                ]
            });

            expect(analysis.available).toBe(true);
            expect(analysis.turns.map((turn) => [turn.round, turn.player, turn.house])).toEqual([
                [1, 'alice', 'brobnar'],
                [1, 'bob', 'untamed'],
                [2, 'alice', 'shadows']
            ]);
            expect(analysis.turns[0].amberGained).toBe(3);
            expect(analysis.turns[1].amberGained).toBe(2);
        });

        // The house is chosen a moment into the turn, so the frame that opens
        // it usually has none yet.
        it('finds the house even when the turn opened before it was called', function () {
            const analysis = analyseReplay({
                version: 3,
                players: [{ name: 'alice' }, { name: 'bob' }],
                cards,
                snapshots: [
                    frame(0, 1, 'alice', { alice: {}, bob: {} }),
                    frame(4, 1, 'alice', { alice: { house: 'logos' }, bob: {} })
                ]
            });

            expect(analysis.turns[0].house).toBe('logos');
        });

        it('attributes a forge to the turn it happened on', function () {
            const analysis = analyseReplay({
                version: 3,
                winner: 'alice',
                players: [{ name: 'alice' }, { name: 'bob' }],
                cards,
                snapshots: [
                    frame(0, 1, 'alice', { alice: { amber: 6 }, bob: {} }),
                    frame(6, 1, 'bob', { alice: { amber: 6 }, bob: {} }),
                    // Alice's second turn opens with the key already forged and
                    // the amber spent, which is how the engine records it.
                    frame(12, 2, 'alice', { alice: { amber: 0, keys: keys(1) }, bob: {} })
                ]
            });

            const alicesSecond = analysis.turns.find(
                (turn) => turn.player === 'alice' && turn.round === 2
            );

            expect(alicesSecond.forged).toBe(1);
            expect(analysis.keyEvents).toEqual([
                { messageIndex: 12, round: 2, player: 'alice', keys: 1 }
            ]);
            expect(analysis.summary.alice.firstKeyRound).toBe(2);
        });

        // A turn spent forging shows as a large negative swing; averaging it in
        // would turn "amber per turn" into nonsense.
        it('does not count a forging turn against amber per turn', function () {
            const analysis = analyseReplay({
                version: 3,
                players: [{ name: 'alice' }, { name: 'bob' }],
                cards,
                snapshots: [
                    frame(0, 1, 'alice', { alice: { amber: 0 }, bob: {} }),
                    frame(3, 1, 'alice', { alice: { amber: 4 }, bob: {} }),
                    frame(6, 1, 'bob', { alice: { amber: 4 }, bob: {} }),
                    frame(9, 2, 'alice', { alice: { amber: 0, keys: keys(1) }, bob: {} }),
                    frame(12, 2, 'alice', { alice: { amber: 2, keys: keys(1) }, bob: {} })
                ]
            });

            // Turn one gained 4, turn two gained 2. The 6 spent forging is not
            // a turn that "gained -4".
            expect(analysis.summary.alice.amberPerTurn).toBe(3);
        });

        it('counts creatures on the board from the card table', function () {
            const analysis = analyseReplay({
                version: 3,
                players: [{ name: 'alice' }, { name: 'bob' }],
                cards,
                snapshots: [
                    frame(0, 1, 'alice', {
                        alice: { creatures: [{ card: 0 }, { card: 0 }] },
                        bob: { creatures: [{ card: 0 }] }
                    })
                ]
            });

            expect(analysis.turns[0].creatures).toBe(2);
            expect(analysis.turns[0].opponentCreatures).toBe(1);
        });

        // Version 2 recordings hold whole card summaries inline instead of
        // referencing a card table, and are still in the database.
        it('reads a recording written before the compact format', function () {
            const analysis = analyseReplay({
                version: 2,
                players: [{ name: 'alice' }, { name: 'bob' }],
                snapshots: [
                    frame(0, 1, 'alice', {
                        alice: { creatures: [{ name: 'Troll', type: 'creature' }] },
                        bob: {}
                    })
                ]
            });

            expect(analysis.available).toBe(true);
            expect(analysis.turns[0].creatures).toBe(1);
        });

        it('finds the point after which the winner was never headed', function () {
            const analysis = analyseReplay({
                version: 3,
                winner: 'alice',
                players: [{ name: 'alice' }, { name: 'bob' }],
                cards,
                snapshots: [
                    // Bob ahead early.
                    frame(0, 1, 'alice', { alice: { amber: 1 }, bob: { amber: 5 } }),
                    frame(4, 1, 'bob', { alice: { amber: 1 }, bob: { amber: 5 } }),
                    // Alice takes the lead on her second turn and keeps it.
                    frame(8, 2, 'alice', { alice: { amber: 9 }, bob: { amber: 5 } }),
                    frame(12, 2, 'bob', { alice: { amber: 9 }, bob: { amber: 6 } }),
                    frame(16, 3, 'alice', { alice: { amber: 12 }, bob: { amber: 6 } })
                ]
            });

            expect(analysis.decisive.round).toBe(2);
            expect(analysis.decisive.player).toBe('alice');
            expect(analysis.decisive.wireToWire).toBe(false);
        });

        it('calls a game the winner led throughout what it is', function () {
            const analysis = analyseReplay({
                version: 3,
                winner: 'alice',
                players: [{ name: 'alice' }, { name: 'bob' }],
                cards,
                snapshots: [
                    frame(0, 1, 'alice', { alice: { amber: 4 }, bob: { amber: 0 } }),
                    frame(4, 1, 'bob', { alice: { amber: 4 }, bob: { amber: 1 } }),
                    frame(8, 2, 'alice', { alice: { amber: 8 }, bob: { amber: 1 } })
                ]
            });

            expect(analysis.decisive.wireToWire).toBe(true);
        });

        it('has no verdict on a game with no recorded winner', function () {
            const analysis = analyseReplay({
                version: 3,
                players: [{ name: 'alice' }, { name: 'bob' }],
                cards,
                snapshots: [frame(0, 1, 'alice', { alice: {}, bob: {} })]
            });

            expect(analysis.decisive).toBe(null);
            expect(analysis.lead).toEqual([]);
        });
    });

    describe('across a player history', function () {
        const service = new ReplayAnalysisService({ query: async () => [] });

        const game = (winner, aliceHouses, bobHouses) => ({
            GameId: 'g',
            Won: winner === 'alice',
            Data: {
                version: 3,
                winner,
                players: [{ name: 'alice' }, { name: 'bob' }],
                cards,
                snapshots: aliceHouses.flatMap((house, index) => [
                    frame(index * 10, index + 1, 'alice', {
                        alice: { house, amber: index * 3 },
                        bob: { house: bobHouses[index] }
                    }),
                    frame(index * 10 + 5, index + 1, 'bob', {
                        alice: { house, amber: index * 3 },
                        bob: { house: bobHouses[index], amber: index * 2 }
                    })
                ])
            }
        });

        it('reports which houses a player calls, and how they do when they do', function () {
            const insights = service.aggregate('alice', [
                game('alice', ['brobnar', 'brobnar', 'shadows'], ['untamed', 'logos', 'logos']),
                game('bob', ['brobnar', 'shadows', 'shadows'], ['untamed', 'untamed', 'logos'])
            ]);

            expect(insights.available).toBe(true);
            expect(insights.games).toBe(2);
            expect(insights.wins).toBe(1);

            const brobnar = insights.byHouse.find((row) => row.house === 'brobnar');

            // Three brobnar turns across two games, one of which she won.
            expect(brobnar.turns).toBe(3);
            expect(brobnar.games).toBe(2);
            expect(brobnar.winRate).toBe(0.5);
            // Shares are of turns called, and add up.
            expect(insights.byHouse.reduce((sum, row) => sum + row.share, 0)).toBeCloseTo(1, 5);
        });

        it('reports what the other side called against them', function () {
            const insights = service.aggregate('alice', [
                game('alice', ['brobnar'], ['untamed']),
                game('bob', ['brobnar'], ['untamed'])
            ]);

            const untamed = insights.vsHouse.find((row) => row.house === 'untamed');

            expect(untamed.games).toBe(2);
            expect(untamed.winRate).toBe(0.5);
        });

        it('counts what it could not use rather than quietly shrinking the sample', function () {
            const insights = service.aggregate('alice', [
                game('alice', ['brobnar'], ['untamed']),
                { GameId: 'old', Won: false, Data: { version: 1, snapshots: [] } }
            ]);

            expect(insights.games).toBe(1);
            expect(insights.skipped).toBe(1);
        });

        it('is unavailable, with a reason, when nothing could be analysed', function () {
            const insights = service.aggregate('alice', [
                { GameId: 'old', Won: false, Data: { version: 1, snapshots: [] } }
            ]);

            expect(insights.available).toBe(false);
            expect(insights.reason).toMatch(/nothing to analyse/);
        });

        // ARCHON (F3): the misplay review's moments, folded into habits. The
        // fixture plants alice's round-2 turn ending its main phase with two
        // ready brobnar creatures - the same shape the per-game review flags -
        // and only ALICE's moments count towards alice's habits.
        it('folds the misplay review into habits, own side only', function () {
            const idleGame = {
                GameId: 'g2',
                Won: false,
                Data: {
                    version: 6,
                    winner: 'bob',
                    players: [{ name: 'alice' }, { name: 'bob' }],
                    cards: [{ id: 'troll', name: 'Troll', type: 'creature', house: 'brobnar' }],
                    handCards: [],
                    snapshots: [
                        {
                            messageIndex: 10,
                            board: {
                                round: 2,
                                phase: 'main',
                                activePlayer: 'alice',
                                players: [
                                    {
                                        name: 'alice',
                                        activeHouse: 'brobnar',
                                        houses: ['brobnar', 'shadows', 'untamed'],
                                        stats: { amber: 0, chains: 0, keys: {} },
                                        cardPiles: {
                                            cardsInPlay: [
                                                { card: 0, uuid: 't1' },
                                                { card: 0, uuid: 't2' }
                                            ],
                                            discard: [],
                                            purged: [],
                                            archives: []
                                        }
                                    },
                                    {
                                        name: 'bob',
                                        stats: { amber: 0, chains: 0, keys: {} },
                                        cardPiles: {
                                            cardsInPlay: [],
                                            discard: [],
                                            purged: [],
                                            archives: []
                                        }
                                    }
                                ]
                            },
                            hands: { alice: [], bob: [] }
                        },
                        {
                            messageIndex: 20,
                            board: {
                                round: 3,
                                phase: 'house',
                                activePlayer: 'bob',
                                players: [
                                    {
                                        name: 'alice',
                                        stats: { amber: 0, chains: 0, keys: {} },
                                        cardPiles: {
                                            cardsInPlay: [],
                                            discard: [],
                                            purged: [],
                                            archives: []
                                        }
                                    },
                                    {
                                        name: 'bob',
                                        stats: { amber: 0, chains: 0, keys: {} },
                                        cardPiles: {
                                            cardsInPlay: [],
                                            discard: [],
                                            purged: [],
                                            archives: []
                                        }
                                    }
                                ]
                            },
                            hands: { alice: [], bob: [] }
                        }
                    ]
                }
            };

            const insights = service.aggregate('alice', [
                idleGame,
                game('alice', ['brobnar'], ['untamed'])
            ]);

            expect(insights.habits.reviewed).toBe(2);
            expect(insights.habits.withHands).toBe(1);

            const unused = insights.habits.byType.find(
                (entry) => entry.type === 'unused-creatures'
            );

            expect(unused).toEqual({ type: 'unused-creatures', games: 1, moments: 1 });
            expect(insights.habits.reapsLeft).toBe(2);
            expect(insights.habits.perGame).toBe(0.5);
        });
    });
});

/**
 * The analysis against a recording the engine actually produced. The block
 * above proves the arithmetic; this proves the format the capture writes is the
 * format the analysis reads, which no fixture can.
 */
describe('replay analysis of a real game', function () {
    beforeEach(function () {
        this.setupTest({
            player1: {
                house: 'brobnar',
                hand: ['troll', 'groggins'],
                inPlay: ['flaxia']
            },
            player2: {
                house: 'untamed',
                hand: ['dust-pixie'],
                inPlay: ['nexus']
            }
        });
    });

    it('reads the turns, houses and board out of a played game', function () {
        this.player1.player.amber = 4;
        this.player1.endTurn();
        this.player2.clickPrompt('untamed');
        this.player2.player.amber = 2;
        this.player2.endTurn();
        this.player1.clickPrompt('brobnar');
        this.game.continue();

        const analysis = analyseReplay(this.game.getReplay());

        expect(analysis.available).toBe(true);
        expect(analysis.turns.length).toBeGreaterThan(1);

        const houses = analysis.turns.map((turn) => turn.house);

        expect(houses).toContain('brobnar');
        expect(houses).toContain('untamed');

        // The creature counts came through the card table rather than being
        // guessed from the pile length. Read across the turns rather than off
        // the first: the opening frame is recorded before the board is set up.
        expect(Math.max(...analysis.turns.map((turn) => turn.creatures))).toBeGreaterThan(0);
        expect(analysis.summary.player1.turns).toBeGreaterThan(0);
        expect(analysis.summary.player1.houses.brobnar).toBeGreaterThan(0);
    });

    it('reports the winner and the point the game stopped changing hands', function () {
        this.player1.player.amber = 6;
        this.game.continue();
        this.game.recordWinner(this.player1.player, 'keys');

        const analysis = analyseReplay(this.game.getReplay());

        expect(analysis.winner).toBe('player1');
        expect(analysis.decisive).not.toBe(null);
        expect(analysis.decisive.player).toBe('player1');
    });
});
