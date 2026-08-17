const {
    findMisplays,
    filterMisplaysTo,
    housesOf
} = require('../../../server/services/membership/replayMisplays');

/**
 * ARCHON (F3): the misplay review.
 *
 * Same two halves as the analysis spec, for the same reason. The arithmetic is
 * checked against hand-built recordings where every flagged moment - and every
 * deliberately unflagged one - can be verified by reading the fixture. The
 * bottom block plays a real game through the engine and reviews what it
 * actually recorded, which is the only thing that proves the review and the
 * capture format agree.
 *
 * The unflagged cases matter as much as the flagged ones here: this feature's
 * failure mode is not a crash, it is a review that second-guesses reasonable
 * play until nobody opens it.
 */
describe('replay misplay review', function () {
    // The public card table: what showed in open zones.
    const cards = [
        { id: 'troll', name: 'Troll', type: 'creature', house: 'brobnar' }, // 0
        { id: 'urchin', name: 'Urchin', type: 'creature', house: 'shadows' }, // 1
        { id: 'dust-pixie', name: 'Dust Pixie', type: 'creature', house: 'untamed' }, // 2
        { id: 'mimicry', name: 'Mimicry', type: 'action', house: 'shadows' } // 3
    ];

    // The hand-card table: what the recorded hands index into.
    const handCards = [
        { id: 'anger', name: 'Anger', type: 'action', house: 'brobnar' }, // 0
        { id: 'urchin', name: 'Urchin', type: 'creature', house: 'shadows' }, // 1
        { id: 'dust-pixie', name: 'Dust Pixie', type: 'creature', house: 'untamed' }, // 2
        // A house pip among the enhancements: playable as brobnar too.
        {
            id: 'flaxia',
            name: 'Flaxia',
            type: 'creature',
            house: 'untamed',
            enhancements: ['brobnar']
        } // 3
    ];

    const HOUSES = ['brobnar', 'shadows', 'untamed'];

    /**
     * A frame: whose turn, the phase, both players' boards, and (optionally)
     * the recorded hands beside the board - exactly the shape
     * `recordBoardSnapshot` writes.
     */
    const frame = (messageIndex, round, activePlayer, players, { phase = 'main', hands } = {}) => ({
        messageIndex,
        board: {
            round,
            phase,
            activePlayer,
            players: Object.entries(players).map(([name, state]) => ({
                name,
                activeHouse: state.house,
                houses: state.houses || HOUSES,
                ...(state.callable ? { callableHouses: state.callable } : {}),
                turn: state.turn,
                stats: {
                    amber: state.amber ?? 0,
                    chains: state.chains ?? 0,
                    ...(state.keyCost != null ? { keyCost: state.keyCost } : {}),
                    keys: state.keys || { red: false, blue: false, yellow: false }
                },
                numHandCards: state.handCount ?? 6,
                numDeckCards: 20,
                cardPiles: {
                    cardsInPlay: state.creatures || [],
                    discard: [],
                    purged: [],
                    archives: state.archives || []
                }
            }))
        },
        ...(hands ? { hands } : {})
    });

    const recording = (snapshots, extra = {}) => ({
        version: 4,
        players: [{ name: 'alice' }, { name: 'bob' }],
        cards,
        handCards,
        snapshots,
        ...extra
    });

    describe('what a card counts as', function () {
        it('reads the in-deck house, plus any house pip enhancement', function () {
            expect([...housesOf(handCards[0])]).toEqual(['brobnar']);
            expect([...housesOf(handCards[3])].sort()).toEqual(['brobnar', 'untamed']);
            expect(housesOf(null).size).toBe(0);
            expect(housesOf({ house: 'not-a-house' }).size).toBe(0);
        });
    });

    describe('nothing to read', function () {
        it('says so rather than inventing moments', function () {
            expect(findMisplays(null).available).toBe(false);
            expect(findMisplays({ snapshots: [] }).available).toBe(false);
            expect(findMisplays({ version: 1, messages: [{}], snapshots: [] }).reason).toMatch(
                /before board states/
            );
        });

        it('reviews a handless (v3) recording with the board checks only', function () {
            // Bob ends a round-2 main phase with two ready untamed creatures.
            const review = findMisplays({
                version: 3,
                players: [{ name: 'alice' }, { name: 'bob' }],
                cards,
                snapshots: [
                    frame(0, 1, 'alice', { alice: { house: 'brobnar' }, bob: {} }),
                    frame(10, 2, 'bob', {
                        alice: {},
                        bob: {
                            house: 'untamed',
                            creatures: [
                                { card: 2, uuid: 'p1' },
                                { card: 2, uuid: 'p2' }
                            ]
                        }
                    })
                ]
            });

            expect(review.available).toBe(true);
            expect(review.handsRecorded).toBe(false);
            expect(review.moments.map((moment) => moment.type)).toEqual(['unused-creatures']);
        });
    });

    describe('the house call', function () {
        // Alice, on the frame where she is choosing a house, holds four
        // Shadows cards and nothing else; her board has one ready Troll.
        // Calling brobnar acts on 1 card; shadows offered 4.
        const chooseHouse = (called, { round = 2, creatures } = {}) => [
            frame(
                18,
                round,
                'alice',
                {
                    alice: {
                        creatures: creatures ?? [{ card: 0, uuid: 't1' }]
                    },
                    bob: {}
                },
                { phase: 'house', hands: { alice: [1, 1, 1, 1], bob: [2] } }
            ),
            frame(22, round, 'alice', {
                alice: { house: called, creatures: creatures ?? [{ card: 0, uuid: 't1' }] },
                bob: {}
            })
        ];

        it('flags a call that had almost nothing to act on when another house was full', function () {
            const review = findMisplays(recording(chooseHouse('brobnar')));
            const moment = review.moments.find((entry) => entry.type === 'house-call');

            expect(moment).toBeDefined();
            expect(moment.player).toBe('alice');
            expect(moment.round).toBe(2);
            expect(moment.house).toBe('brobnar');
            expect(moment.potential).toBe(1);
            expect(moment.bestHouse).toBe('shadows');
            expect(moment.bestPotential).toBe(4);
            // Jumps to the frame the choice was made on, hand visible.
            expect(moment.messageIndex).toBe(18);
        });

        it('does not flag the call that took the full house', function () {
            const review = findMisplays(recording(chooseHouse('shadows')));

            expect(review.moments.filter((entry) => entry.type === 'house-call')).toEqual([]);
        });

        it('does not count an exhausted or stunned creature as potential', function () {
            // The Troll is exhausted: calling brobnar now acts on 0 cards, and
            // the flagged moment says so.
            const review = findMisplays(
                recording(
                    chooseHouse('brobnar', {
                        creatures: [{ card: 0, uuid: 't1', exhausted: true }]
                    })
                )
            );
            const moment = review.moments.find((entry) => entry.type === 'house-call');

            expect(moment.potential).toBe(0);
        });

        it('counts a house pip enhancement towards the enhanced house', function () {
            // Alice holds four Flaxias (untamed, brobnar pip) and calls
            // brobnar: the pips make brobnar worth 4 + the Troll = 5. No flag.
            const review = findMisplays(
                recording([
                    frame(
                        18,
                        2,
                        'alice',
                        { alice: { creatures: [{ card: 0, uuid: 't1' }] }, bob: {} },
                        { phase: 'house', hands: { alice: [3, 3, 3, 3], bob: [] } }
                    ),
                    frame(22, 2, 'alice', {
                        alice: { house: 'brobnar', creatures: [{ card: 0, uuid: 't1' }] },
                        bob: {}
                    })
                ])
            );

            expect(review.moments.filter((entry) => entry.type === 'house-call')).toEqual([]);
        });

        it('skips round one: the opening turn is rule-limited, not misplayed', function () {
            const review = findMisplays(recording(chooseHouse('brobnar', { round: 1 })));

            expect(review.moments.filter((entry) => entry.type === 'house-call')).toEqual([]);
        });

        it('does not read a turn whose opening frame is already mid-main', function () {
            // Thinning dropped the choose-house frame: the recorded "opening"
            // hand may already be part-spent, so no judgement is made.
            const snapshots = chooseHouse('brobnar');

            snapshots[0].board.phase = 'main';

            const review = findMisplays(recording(snapshots));

            expect(review.moments.filter((entry) => entry.type === 'house-call')).toEqual([]);
        });

        const forgedKeys = (count) => ({
            red: count >= 1,
            blue: count >= 2,
            yellow: count >= 3
        });

        // ------------------------------------------------------------------
        // The good reasons a thin call is NOT flagged for.
        // ------------------------------------------------------------------

        it('never second-guesses a forced or restricted call (v5 callableHouses)', function () {
            // Control the Weak: brobnar was the only legal call, whatever the
            // hand looked like.
            const review = findMisplays(
                recording([
                    frame(
                        18,
                        2,
                        'alice',
                        { alice: { callable: ['brobnar'] }, bob: {} },
                        { phase: 'house', hands: { alice: [1, 1, 1, 1], bob: [] } }
                    ),
                    frame(22, 2, 'alice', { alice: { house: 'brobnar' }, bob: {} })
                ])
            );

            expect(review.moments.filter((entry) => entry.type === 'house-call')).toEqual([]);
        });

        it('does not judge a call made with a stocked archive - those cards are unseen', function () {
            const snapshots = chooseHouse('brobnar');

            snapshots[0].board.players[0].cardPiles.archives = [0, 3];

            const review = findMisplays(recording(snapshots));

            expect(review.moments.filter((entry) => entry.type === 'house-call')).toEqual([]);
        });

        it('does not flag a call that forged a key mid-turn', function () {
            const review = findMisplays(
                recording([
                    frame(
                        18,
                        2,
                        'alice',
                        { alice: {} },
                        { phase: 'house', hands: { alice: [1, 1, 1, 1], bob: [] } }
                    ),
                    // The key cheat came off: whatever the card count said,
                    // the call produced a key.
                    frame(22, 2, 'alice', {
                        alice: { house: 'brobnar', keys: forgedKeys(1) }
                    })
                ])
            );

            expect(review.moments.filter((entry) => entry.type === 'house-call')).toEqual([]);
        });

        it('does not flag a call that out-earned the fuller house', function () {
            const review = findMisplays(
                recording([
                    frame(
                        18,
                        2,
                        'alice',
                        { alice: { amber: 0 } },
                        { phase: 'house', hands: { alice: [1, 1, 1, 1], bob: [] } }
                    ),
                    // Shadows offered 4 cards; the brobnar turn made 4 amber
                    // anyway (pips, steals - the recording cannot tell, and
                    // does not need to).
                    frame(22, 2, 'alice', { alice: { house: 'brobnar', amber: 4 } })
                ])
            );

            expect(review.moments.filter((entry) => entry.type === 'house-call')).toEqual([]);
        });

        it('does not flag the turn that denied a check', function () {
            // Bob sat at forge amber. Alice called her thin house - and on
            // bob's next turn, no key: whatever she did with it worked.
            const review = findMisplays(
                recording([
                    frame(
                        18,
                        2,
                        'alice',
                        { alice: {}, bob: { amber: 6 } },
                        { phase: 'house', hands: { alice: [1, 1, 1, 1], bob: [] } }
                    ),
                    frame(22, 2, 'alice', { alice: { house: 'brobnar' }, bob: { amber: 6 } }),
                    frame(30, 2, 'bob', { alice: {}, bob: { house: 'untamed', amber: 3 } })
                ])
            );

            expect(review.moments.filter((entry) => entry.type === 'house-call')).toEqual([]);
        });

        it('still flags the thin call when the check came in anyway', function () {
            const review = findMisplays(
                recording([
                    frame(
                        18,
                        2,
                        'alice',
                        { alice: {}, bob: { amber: 6 } },
                        { phase: 'house', hands: { alice: [1, 1, 1, 1], bob: [] } }
                    ),
                    frame(22, 2, 'alice', { alice: { house: 'brobnar' }, bob: { amber: 6 } }),
                    // Bob forged regardless: the call neither played cards nor
                    // stopped the key.
                    frame(30, 2, 'bob', {
                        alice: {},
                        bob: { house: 'untamed', amber: 0, keys: forgedKeys(1) }
                    })
                ])
            );

            const moment = review.moments.find((entry) => entry.type === 'house-call');

            expect(moment).toBeDefined();
            expect(moment.bestHouse).toBe('shadows');
        });
    });

    describe('unused creatures', function () {
        // Bob's round-2 turn ends its main phase with three ready, unstunned
        // untamed creatures: three reaps - three amber - left on the table.
        const idleBoard = (extra = {}) =>
            recording(
                [
                    frame(10, 2, 'bob', {
                        alice: {},
                        bob: {
                            house: 'untamed',
                            creatures: [
                                { card: 2, uuid: 'p1' },
                                { card: 2, uuid: 'p2' },
                                { card: 2, uuid: 'p3' }
                            ]
                        }
                    }),
                    // The game moves on: the run above is not the last one.
                    frame(20, 3, 'alice', { alice: {}, bob: {} })
                ],
                extra
            );

        it('flags them, with the count and the names', function () {
            const review = findMisplays(idleBoard());
            const moment = review.moments.find((entry) => entry.type === 'unused-creatures');

            expect(moment).toBeDefined();
            expect(moment.player).toBe('bob');
            expect(moment.count).toBe(3);
            expect(moment.creatures).toEqual(['Dust Pixie', 'Dust Pixie', 'Dust Pixie']);
            expect(moment.messageIndex).toBe(10);
        });

        it('does not count exhausted, stunned or off-house creatures', function () {
            const review = findMisplays(
                recording([
                    frame(10, 2, 'bob', {
                        alice: {},
                        bob: {
                            house: 'untamed',
                            creatures: [
                                { card: 2, uuid: 'p1', exhausted: true },
                                { card: 2, uuid: 'p2', stunned: true },
                                // A ready creature of another house is not a
                                // wasted use - it was never usable.
                                { card: 1, uuid: 'u1' },
                                { card: 2, uuid: 'p3' }
                            ]
                        }
                    }),
                    frame(20, 3, 'alice', { alice: {}, bob: {} })
                ])
            );

            // One genuinely idle untamed creature is below the threshold.
            expect(review.moments.filter((entry) => entry.type === 'unused-creatures')).toEqual([]);
        });

        it('does not read the last turn of a decided game', function () {
            const snapshots = idleBoard().snapshots.slice(0, 1);
            const review = findMisplays(recording(snapshots, { winner: 'bob' }));

            expect(review.moments.filter((entry) => entry.type === 'unused-creatures')).toEqual([]);
        });

        it('does not read end-of-turn state out of a thinned recording', function () {
            const review = findMisplays(idleBoard({ thinned: true }));

            expect(review.thinned).toBe(true);
            expect(review.moments.filter((entry) => entry.type === 'unused-creatures')).toEqual([]);
        });

        it('only counts creatures that had the whole turn - not ones that arrived ready', function () {
            const review = findMisplays(
                recording([
                    // The turn opens with one dust pixie on the board...
                    frame(
                        8,
                        2,
                        'bob',
                        {
                            alice: {},
                            bob: { creatures: [{ card: 2, uuid: 'p1' }] }
                        },
                        { phase: 'house' }
                    ),
                    // ...and ends its main with three, two of which entered
                    // ready mid-turn (an effect; they never had a full turn).
                    frame(14, 2, 'bob', {
                        alice: {},
                        bob: {
                            house: 'untamed',
                            creatures: [
                                { card: 2, uuid: 'p1' },
                                { card: 2, uuid: 'p2' },
                                { card: 2, uuid: 'p3' }
                            ]
                        }
                    }),
                    frame(20, 3, 'alice', { alice: {}, bob: {} })
                ])
            );

            // One idle creature that had the whole turn is below the threshold.
            expect(review.moments.filter((entry) => entry.type === 'unused-creatures')).toEqual([]);
        });

        it('does not flag the winner coasting home from a decided position', function () {
            // Bob ends the turn with two keys forged and the third paid for:
            // reaps changed nothing, and the game says so - he won.
            const review = findMisplays(
                recording(
                    [
                        frame(10, 5, 'bob', {
                            alice: {},
                            bob: {
                                house: 'untamed',
                                amber: 7,
                                keyCost: 6,
                                keys: { red: true, blue: true, yellow: false },
                                creatures: [
                                    { card: 2, uuid: 'p1' },
                                    { card: 2, uuid: 'p2' },
                                    { card: 2, uuid: 'p3' }
                                ]
                            }
                        }),
                        frame(20, 6, 'bob', {
                            alice: {},
                            bob: { keys: { red: true, blue: true, yellow: true } }
                        })
                    ],
                    { winner: 'bob' }
                )
            );

            expect(review.moments.filter((entry) => entry.type === 'unused-creatures')).toEqual([]);
        });
    });

    describe('held cards', function () {
        // Alice ends her round-2 main phase still holding two Angers (her
        // called house) in a three-card hand: discarding them was two more
        // fresh draws. Her next two turns are recorded too, because the flag
        // now depends on what became of the hold.
        const heldHand = (hands, { chains = 0, laterHands } = {}) =>
            recording([
                frame(30, 2, 'alice', { alice: { house: 'brobnar', chains }, bob: {} }, { hands }),
                frame(40, 2, 'bob', { alice: {}, bob: { house: 'untamed' } }),
                frame(
                    50,
                    3,
                    'alice',
                    { alice: { house: 'brobnar', chains }, bob: {} },
                    { hands: laterHands ? laterHands[0] : hands }
                ),
                frame(60, 3, 'bob', { alice: {}, bob: { house: 'untamed' } }),
                frame(
                    70,
                    4,
                    'alice',
                    { alice: { house: 'brobnar', chains }, bob: {} },
                    { hands: laterHands ? laterHands[1] : hands }
                ),
                frame(80, 4, 'bob', { alice: {}, bob: { house: 'untamed' } })
            ]);

        it('flags a hold that was still sitting in hand two turns later', function () {
            const review = findMisplays(heldHand({ alice: [0, 0, 2], bob: [] }));
            const moment = review.moments.find((entry) => entry.type === 'held-cards');

            expect(moment).toBeDefined();
            expect(moment.player).toBe('alice');
            expect(moment.round).toBe(2);
            expect(moment.house).toBe('brobnar');
            expect(moment.missedDraws).toBe(2);
            expect(moment.held.map((card) => card.name)).toEqual(['Anger', 'Anger']);
        });

        // The plan test: a held card that got used was being saved, and the
        // lost draws were its price, not a mistake.
        it('does not flag a hold that got played on a later turn', function () {
            const review = findMisplays(
                heldHand(
                    { alice: [0, 0, 2], bob: [] },
                    // One Anger left the hand on her next turn.
                    {
                        laterHands: [
                            { alice: [0, 2], bob: [] },
                            { alice: [0, 2], bob: [] }
                        ]
                    }
                )
            );

            expect(review.moments.filter((entry) => entry.type === 'held-cards')).toEqual([]);
        });

        it('gives a hold the benefit of the doubt when the game ended first', function () {
            const review = findMisplays(
                recording([
                    frame(
                        30,
                        2,
                        'alice',
                        { alice: { house: 'brobnar' }, bob: {} },
                        { hands: { alice: [0, 0, 2], bob: [] } }
                    ),
                    frame(40, 3, 'bob', { alice: {}, bob: { house: 'untamed' } })
                ])
            );

            expect(review.moments.filter((entry) => entry.type === 'held-cards')).toEqual([]);
        });

        it('does not flag holding cards of the other houses - those were not playable', function () {
            const review = findMisplays(heldHand({ alice: [1, 1, 2, 2], bob: [] }));

            expect(review.moments.filter((entry) => entry.type === 'held-cards')).toEqual([]);
        });

        it('respects chains: a reduced refill can make holding free', function () {
            // Two held among five: at twelve chains the refill target is four,
            // so only one fresh draw was displaced - below the threshold.
            const review = findMisplays(
                heldHand({ alice: [0, 0, 1, 2, 2], bob: [] }, { chains: 12 })
            );

            expect(review.moments.filter((entry) => entry.type === 'held-cards')).toEqual([]);
        });
    });

    describe('the clogged hand', function () {
        // Alice opens turns 2, 3 and 4 holding four untamed cards and calls
        // something else every time.
        const cloggedTurns = () => [
            ...[2, 3, 4].flatMap((round) => [
                frame(
                    round * 10,
                    round,
                    'alice',
                    { alice: { turn: round }, bob: {} },
                    { phase: 'house', hands: { alice: [2, 2, 2, 2, 0], bob: [] } }
                ),
                frame(round * 10 + 2, round, 'alice', {
                    alice: { house: 'brobnar', turn: round },
                    bob: {}
                }),
                frame(round * 10 + 5, round, 'bob', {
                    alice: {},
                    bob: { house: 'shadows' }
                })
            ])
        ];

        it('flags a house held at strength across consecutive turns', function () {
            const review = findMisplays(recording(cloggedTurns()));
            const moment = review.moments.find((entry) => entry.type === 'clogged-hand');

            expect(moment).toBeDefined();
            expect(moment.player).toBe('alice');
            expect(moment.house).toBe('untamed');
            expect(moment.turnsHeld).toBe(3);
            expect(moment.peak).toBe(4);
            // Placed on the last turn of the streak.
            expect(moment.round).toBe(4);
        });

        it('calling the house ends the streak before it counts', function () {
            const snapshots = cloggedTurns();

            // Turn 3 calls untamed after all.
            snapshots[4].board.players[0].activeHouse = 'untamed';

            const review = findMisplays(recording(snapshots));

            expect(review.moments.filter((entry) => entry.type === 'clogged-hand')).toEqual([]);
        });

        // A long hold that finally cashes out was assembly, not a clog.
        const resolvedAfterStreak = (amberEnd) => [
            ...cloggedTurns(),
            frame(
                50,
                5,
                'alice',
                { alice: { turn: 5, amber: 0 } },
                { phase: 'house', hands: { alice: [2, 2, 2, 2, 0], bob: [] } }
            ),
            frame(52, 5, 'alice', { alice: { house: 'untamed', turn: 5, amber: amberEnd } }),
            frame(55, 5, 'bob', { alice: {}, bob: { house: 'shadows' } })
        ];

        it('drops the streak when the house finally lands a big turn', function () {
            const review = findMisplays(recording(resolvedAfterStreak(5)));

            expect(review.moments.filter((entry) => entry.type === 'clogged-hand')).toEqual([]);
        });

        it('keeps the streak when the long-awaited call bought nothing', function () {
            const review = findMisplays(recording(resolvedAfterStreak(0)));
            const moment = review.moments.find((entry) => entry.type === 'clogged-hand');

            expect(moment).toBeDefined();
            expect(moment.turnsHeld).toBe(3);
        });
    });

    describe('whose moments a reader gets', function () {
        const both = {
            available: true,
            handsRecorded: true,
            thinned: false,
            moments: [
                { type: 'unused-creatures', player: 'alice', messageIndex: 4 },
                { type: 'held-cards', player: 'bob', messageIndex: 9 }
            ]
        };

        it('filters to one player for a player read', function () {
            const filtered = filterMisplaysTo(both, 'alice');

            expect(filtered.moments.map((moment) => moment.player)).toEqual(['alice']);
            // The original is untouched - it may be filtered again for the
            // other reader.
            expect(both.moments.length).toBe(2);
        });

        it('keeps everything for the admin read', function () {
            expect(filterMisplaysTo(both, null).moments.length).toBe(2);
        });

        it('passes an unavailable review through', function () {
            const unavailable = { available: false, reason: 'nothing' };

            expect(filterMisplaysTo(unavailable, 'alice')).toBe(unavailable);
        });
    });
});

describe('misplay review of a real game', function () {
    beforeEach(function () {
        this.setupTest({
            player1: {
                house: 'brobnar',
                hand: ['anger', 'punch'],
                inPlay: ['troll', 'groggins']
            },
            player2: {
                house: 'untamed',
                hand: ['dust-pixie'],
                inPlay: ['nexus']
            }
        });
    });

    it('reads an idle round-two board out of what the engine recorded', function () {
        // Round one for both sides, then player1 calls brobnar again and ends
        // the turn without using the two ready brobnar creatures.
        this.player1.endTurn();
        this.player2.clickPrompt('untamed');
        this.player2.endTurn();
        this.player1.clickPrompt('brobnar');
        this.player1.endTurn();
        this.player2.clickPrompt('untamed');
        this.game.continue();

        const review = findMisplays(this.game.getReplay());

        expect(review.available).toBe(true);
        expect(review.handsRecorded).toBe(true);

        const idle = review.moments.find(
            (moment) => moment.type === 'unused-creatures' && moment.player === 'player1'
        );

        expect(idle).toBeDefined();
        expect(idle.count).toBeGreaterThanOrEqual(2);
        expect(idle.creatures).toContain('Troll');
        expect(idle.creatures).toContain('Groggins');
    });

    it('never flags the opponent-only view with the player filter on', function () {
        this.player1.endTurn();
        this.player2.clickPrompt('untamed');
        this.player2.endTurn();
        this.player1.clickPrompt('brobnar');
        this.player1.endTurn();
        this.player2.clickPrompt('untamed');
        this.game.continue();

        const review = filterMisplaysTo(findMisplays(this.game.getReplay()), 'player2');

        expect(review.available).toBe(true);
        expect(review.moments.every((moment) => moment.player === 'player2')).toBe(true);
    });
});
