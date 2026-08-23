const { randomUUID } = require('crypto');
const Game = require('../../../server/game/game.js');
const Settings = require('../../../server/settings.js');
const { withRandomSource, seededSource } = require('../../../server/game/secureRandom.js');
const {
    capture,
    fingerprint,
    fork,
    refusalReason,
    restore
} = require('../../../server/game/positionSnapshot.js');
const {
    SimulatedGame,
    PLAYER_ONE,
    PLAYER_TWO
} = require('../../../server/services/championschallenge/SimulatedGame');
const {
    getCardIndex,
    cloneCard
} = require('../../../server/services/championschallenge/packCards');
const { BotPolicy } = require('../../../server/services/botplayer/BotPolicy');

/**
 * ARCHON (N51): a position that can be copied.
 *
 * This is the keystone the planning work sits on, and the only thing that
 * makes it safe to build on is that a copy which is not exact says so. A fork
 * that is subtly wrong does not plan badly - it plans confidently about a game
 * nobody is playing, and nothing in the output says which.
 *
 * So the test is not "the fields match". Two positions can carry identical
 * numbers and diverge on the very next input, and both of the bugs this
 * caught were of exactly that shape:
 *
 *  - cards UNDER a card (what a prophecy buries) were captured and never put
 *    back, so a board quietly forgot what it was carrying, and
 *  - `controller` was restored where `defaultController` is the field that
 *    matters - `Game.checkGameState` re-derives control on every state change
 *    and physically moves a card whose controller disagrees with the board it
 *    is on, so a Treachery card migrated back to its owner's side on the first
 *    check. The copy was a legal, plausible position, and it was not the one
 *    being played.
 *
 * Both were found by comparing fingerprints over real games, which is why the
 * expensive end-to-end cases below are the ones that earn their keep.
 */

function buildDeck(name, houses, offset) {
    const byHouse = {};

    for (const card of Object.values(getCardIndex())) {
        if (
            houses.includes(card.house) &&
            !card.isNonDeck &&
            ['creature', 'artifact', 'action', 'upgrade'].includes(card.type)
        ) {
            (byHouse[card.house] = byHouse[card.house] || []).push(card);
        }
    }

    const cards = [];

    for (const house of houses) {
        const pool = byHouse[house];

        for (let i = 0; i < 12; i++) {
            const card = pool[(i * 7 + offset) % pool.length];

            cards.push({ id: card.id, count: 1, card: cloneCard(card.id) });
        }
    }

    return { name, uuid: `spec-${name}`, expansion: 341, houses, cards };
}

const makeUser = (username) =>
    Settings.getUserWithDefaultsSet({
        username,
        settings: { optionSettings: { orderForcedAbilities: false, confirmOneClick: false } }
    });

/** A game with both decks selected and deliberately NOT initialised. */
function freshGame(deckA, deckB) {
    const alpha = makeUser(PLAYER_ONE);
    const omega = makeUser(PLAYER_TWO);
    const game = new Game(
        {
            id: randomUUID(),
            name: 'restore target',
            owner: alpha,
            savedGameId: 0,
            players: [
                { id: 'spec-1', user: alpha },
                { id: 'spec-2', user: omega }
            ]
        },
        {
            router: {
                gameWon: () => true,
                playerLeft: () => true,
                handleError: (_game, error) => {
                    throw error;
                }
            },
            cardData: {}
        }
    );

    game.started = true;
    game.recordBoardSnapshot = () => true;
    game.selectDeck(PLAYER_ONE, deckA);
    game.selectDeck(PLAYER_TWO, deckB);

    return game;
}

/** Play a seeded game, handing every house call to `atHouseCall`. */
async function playGame(deckA, deckB, seed, atHouseCall, maxTurns = 30) {
    const sim = new SimulatedGame(deckA, deckB, {
        seed,
        maxTurns,
        analyzer: async (context) => {
            if (context.kind === 'house') {
                await atHouseCall(context.game);
            }

            return null;
        }
    });

    return sim.run();
}

const seededRng = (n) => {
    let state = n | 0;

    return () => {
        state = (state + 0x6d2b79f5) | 0;

        let t = Math.imul(state ^ (state >>> 15), 1 | state);

        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;

        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
};

/** Roll a snapshot forward under one controlled random source. */
async function rollForward(snapshot, deckA, deckB, seed, plies) {
    const engine = seededSource(seed);

    return withRandomSource({ next: () => engine.next() }, async () => {
        const game = restore(snapshot, freshGame(deckA, deckB));
        const policy = new BotPolicy({ rng: seededRng(seed) });
        const client = {
            cardClicked: (name, uuid) => game.cardClicked(name, uuid),
            menuButton: (name, arg, uuid, method) => game.menuButton(name, arg, uuid, method),
            clickProphecy: (name, uuid) => game.clickProphecy(name, uuid)
        };

        for (let ply = 0; ply < plies && !game.winner; ply++) {
            let acted = false;

            for (const player of game.getPlayers()) {
                if (policy.respond(client, player)) {
                    acted = true;
                    game.continue();
                    break;
                }
            }

            if (!acted) {
                break;
            }
        }

        return fingerprint(game);
    });
}

describe('copying a position', function () {
    // Three pairs spanning every house, because both bugs this caught lived in
    // cards a narrower sample never dealt.
    const alpha = buildDeck('alpha', ['brobnar', 'dis', 'logos'], 0);
    const omega = buildDeck('omega', ['sanctum', 'shadows', 'untamed'], 3);
    const gamma = buildDeck('gamma', ['mars', 'saurian', 'staralliance'], 5);
    const delta = buildDeck('delta', ['ekwidon', 'geistoid', 'skyborn'], 2);
    const epsilon = buildDeck('epsilon', ['unfathomable', 'brobnar', 'sanctum'], 6);

    describe('a fork is the position it was taken from', function () {
        it('reproduces every house call it accepts, exactly', async function () {
            const pairs = [
                [alpha, omega],
                [gamma, delta],
                [delta, epsilon]
            ];
            let forked = 0;
            let refused = 0;
            const wrong = [];

            for (let index = 0; index < pairs.length; index++) {
                await playGame(pairs[index][0], pairs[index][1], 2200 + index, async (game) => {
                    const copy = fork(game);

                    if (!copy.ok) {
                        refused++;

                        return;
                    }

                    forked++;

                    if (fingerprint(copy.game) !== fingerprint(game)) {
                        wrong.push({
                            original: fingerprint(game),
                            copy: fingerprint(copy.game)
                        });
                    }
                });
            }

            // Not "some of them": a fork it ACCEPTED and got wrong is the
            // failure this whole facility exists to make impossible.
            expect(wrong).toEqual([]);
            expect(forked).toBeGreaterThan(30);
            // And it must not be buying that record by refusing everything.
            expect(forked).toBeGreaterThan(refused);
        }, 240000);
    });

    describe('a fork is a playable game', function () {
        it('rolls forward identically under the same random source', async function () {
            const snapshots = [];

            await playGame(alpha, omega, 3300, async (game) => {
                if (snapshots.length < 4 && !refusalReason(game)) {
                    snapshots.push(capture(game).snapshot);
                }
            });

            expect(snapshots.length).toBeGreaterThan(0);

            for (const snapshot of snapshots) {
                const first = await rollForward(snapshot, alpha, omega, 4242, 30);
                const second = await rollForward(snapshot, alpha, omega, 4242, 30);

                // Same position, same source, same play: a planner comparing
                // two lines has to know the difference it measures is the
                // move and not the deal.
                expect(first).toBe(second);
            }
        }, 240000);

        it('faces a different future under a different source', async function () {
            const snapshots = [];

            // Late enough that a deck is near running out, because a reshuffle
            // is the randomness this is about - and across seeds, because
            // whether a given game reaches one is exactly the thing that
            // varies.
            for (let seed = 3400; seed < 3406 && !snapshots.length; seed++) {
                await playGame(gamma, delta, seed, async (game) => {
                    if (!snapshots.length && !refusalReason(game) && game.round >= 6) {
                        snapshots.push(capture(game).snapshot);
                    }
                });
            }

            expect(snapshots.length).toBe(1);

            const one = await rollForward(snapshots[0], gamma, delta, 11, 40);
            const two = await rollForward(snapshots[0], gamma, delta, 9999, 40);

            // The point of sampling: what the fork cannot know - the shuffle
            // when a deck runs out, an ability that discards at random - has
            // to actually vary, or every "sample" is one sample.
            expect(one).not.toBe(two);
        }, 240000);
    });

    describe('refusing rather than guessing', function () {
        it('refuses a position holding an effect it cannot rebuild', function () {
            const game = { started: true, winner: null, getPlayers: () => [] };

            game.effectEngine = {
                effects: [{ duration: 'untilPlayerTurnEnd', source: { name: 'Framework effect' } }],
                delayedEffects: [],
                duringOpponentNextTurnEffects: []
            };

            const reason = refusalReason(game);

            // Named, because the refusals turned out to be a short list of
            // specific cards rather than anything structural - which is the
            // difference between "this cannot be done" and "this card is next".
            expect(reason).toContain('Framework effect');
            expect(capture(game).ok).toBe(false);
        });

        it('refuses a delayed effect and one held for the opponent’s turn', function () {
            const base = () => ({
                started: true,
                winner: null,
                getPlayers: () => [],
                effectEngine: {
                    effects: [],
                    delayedEffects: [],
                    duringOpponentNextTurnEffects: []
                }
            });
            const delayed = base();
            const held = base();

            delayed.effectEngine.delayedEffects = [{}];
            held.effectEngine.duringOpponentNextTurnEffects = [{}];

            expect(refusalReason(delayed)).toContain('delayed');
            expect(refusalReason(held)).toContain('opponent');
        });

        it('accepts a persistent effect, which a rebuild puts back by itself', function () {
            // A persistent effect is declared by the card and re-registered by
            // `moveTo` when it lands in a location, so a rebuilt board gets it
            // for nothing. Refusing on it would refuse nearly every position.
            const game = {
                started: true,
                winner: null,
                getPlayers: () => [],
                effectEngine: {
                    effects: [{ duration: 'persistentEffect', source: { name: 'anything' } }],
                    delayedEffects: [],
                    duringOpponentNextTurnEffects: []
                }
            };

            expect(refusalReason(game)).toBe(null);
        });

        it('refuses a game that is over or has not started', function () {
            const engine = { effects: [], delayedEffects: [], duringOpponentNextTurnEffects: [] };

            expect(
                refusalReason({ started: false, getPlayers: () => [], effectEngine: engine })
            ).toBeTruthy();
            expect(
                refusalReason({
                    started: true,
                    winner: { name: 'someone' },
                    getPlayers: () => [],
                    effectEngine: engine
                })
            ).toBeTruthy();
        });

        it('refuses a body the decklist cannot supply', async function () {
            // A token creature is the case this exists for: a rebuild deals
            // from the decklist and has nowhere to take an extra body from, so
            // a snapshot that shrugged would hand a planner a board with a
            // creature missing.
            let checked = false;

            await playGame(alpha, omega, 3500, async (game) => {
                // Only on a position that is otherwise capturable, or the
                // refusal being asserted might be some other refusal.
                if (checked || refusalReason(game)) {
                    return;
                }

                const player = game.getPlayers()[0];
                const extra = player.cardsInPlay[0] || player.hand[0];

                if (!extra) {
                    return;
                }

                checked = true;

                const copy = Object.create(Object.getPrototypeOf(extra));

                Object.assign(copy, extra, { uuid: 'a-token' });
                player.cardsInPlay.push(copy);

                expect(refusalReason(game)).toContain('token');

                player.cardsInPlay.pop();

                // And the position is capturable again once it is gone, so the
                // refusal is about the extra body and nothing else.
                expect(refusalReason(game)).toBe(null);
            });

            expect(checked).toBe(true);
        }, 120000);
    });

    describe('the fingerprint', function () {
        it('refuses to pretend about a position it cannot read', function () {
            const game = {
                started: true,
                winner: null,
                getPlayers: () => [],
                effectEngine: {
                    effects: [{ duration: 'custom', source: { name: 'x' } }],
                    delayedEffects: [],
                    duringOpponentNextTurnEffects: []
                }
            };

            expect(fingerprint(game)).toBe('<uncapturable>');
        });

        it('will not restore a snapshot from another version', function () {
            expect(() => restore({ version: 999 }, null)).toThrow(/version/);
        });
    });
});
