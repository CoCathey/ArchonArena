/**
 * Verifies src/net/jsonpatch.ts against the exact jsondiffpatch version the
 * ArchonArena game node uses (declared in devDependencies). The server diffs
 * successive per-player game states and the app must reproduce the follow-up
 * state exactly, or the board silently corrupts.
 */
import { describe, expect, it } from 'vitest';
import * as jsondiffpatch from 'jsondiffpatch';
import { clone, patch } from '../src/net/jsonpatch';

const differ = (jsondiffpatch as any).create({
    // Must match server/gamenode/gameserver.js
    objectHash: (obj: any, index: number) =>
        obj.uuid || obj.name || obj.id || obj._id || '$$index:' + index
});

function roundTrip(left: unknown, right: unknown) {
    const delta = differ.diff(left, right);
    const patched = patch(left, delta);
    expect(patched).toEqual(right);
}

function card(uuid: string, extra: Record<string, unknown> = {}) {
    return {
        uuid,
        id: `card-${uuid}`,
        image: `img-${uuid}`,
        name: `Card ${uuid}`,
        exhausted: false,
        stunned: false,
        tokens: {},
        upgrades: [],
        childCards: [],
        menu: [{ command: 'useAbility', text: 'Use' }],
        ...extra
    };
}

interface TestState {
    [key: string]: any;
}

function baseState(): TestState {
    return {
        id: 'game-1',
        name: 'test game',
        started: true,
        messages: [
            { date: '2026-01-01T00:00:00Z', message: ['hello'] },
            { date: '2026-01-01T00:00:05Z', message: [{ name: 'p1' }, ' played a card'] }
        ],
        players: {
            p1: {
                name: 'p1',
                activeHouse: 'brobnar',
                houses: ['brobnar', 'dis', 'logos'],
                stats: {
                    amber: 2,
                    chains: 0,
                    keys: { red: false, blue: true, yellow: false },
                    keyCost: 6
                },
                cardPiles: {
                    hand: [card('h1'), card('h2'), card('h3')],
                    cardsInPlay: [card('b1', { tokens: { power: 2 } }), card('b2')],
                    discard: [card('d1')],
                    archives: [],
                    purged: []
                },
                buttons: [
                    { command: 'menuButton', text: 'Done', arg: 'done', uuid: undefined },
                    { command: 'menuButton', text: 'Cancel', arg: 'cancel' }
                ],
                menuTitle: 'Choose a card to play, discard or use',
                promptTitle: 'Play phase',
                phase: 'main',
                numDeckCards: 20
            },
            p2: {
                name: 'p2',
                activeHouse: undefined,
                houses: ['mars', 'shadows', 'untamed'],
                stats: {
                    amber: 5,
                    chains: 1,
                    keys: { red: true, blue: false, yellow: false },
                    keyCost: 6
                },
                cardPiles: {
                    hand: [card('e1'), card('e2')],
                    cardsInPlay: [card('eb1')],
                    discard: [],
                    archives: [card('ea1')],
                    purged: []
                },
                phase: 'main',
                numDeckCards: 18
            }
        }
    };
}

describe('jsonpatch vs jsondiffpatch', () => {
    it('returns the original state for an empty delta', () => {
        const state = baseState();
        expect(patch(state, undefined)).toEqual(state);
        expect(patch(state, null)).toEqual(state);
    });

    it('does not mutate its input', () => {
        const left = baseState();
        const frozen = clone(left);
        const right = baseState();
        right.players.p1.stats.amber = 6;
        right.players.p1.cardPiles.hand.pop();
        const delta = differ.diff(left, right);
        patch(left, delta);
        expect(left).toEqual(frozen);
    });

    it('applies scalar and nested object changes', () => {
        const left = baseState();
        const right = clone(left);
        right.players.p1.stats.amber = 4;
        right.players.p1.stats.keys.red = true;
        right.players.p1.activeHouse = 'dis';
        right.players.p2.stats.chains = 0;
        roundTrip(left, right);
    });

    it('applies key additions and deletions', () => {
        const left = baseState() as any;
        const right = clone(left);
        delete right.players.p1.buttons;
        delete right.players.p1.menuTitle;
        right.players.p1.selectCard = true;
        right.winner = 'p2';
        roundTrip(left, right);
    });

    it('handles a card moving between piles (remove + insert)', () => {
        const left = baseState();
        const right = clone(left);
        const played = right.players.p1.cardPiles.hand.splice(1, 1)[0];
        right.players.p1.cardPiles.cardsInPlay.push({ ...played, exhausted: true });
        roundTrip(left, right);
    });

    it('handles reordering (array moves) with modifications', () => {
        const left = baseState();
        const right = clone(left);
        const play = right.players.p1.cardPiles.cardsInPlay;
        play.reverse();
        play[0].tokens = { power: 1, damage: 2 };
        play[1].stunned = true;
        roundTrip(left, right);
    });

    it('handles message appends', () => {
        const left = baseState();
        const right = clone(left);
        right.messages.push({
            date: '2026-01-01T00:00:10Z',
            message: [{ name: 'p2' }, ' forged a key']
        });
        roundTrip(left, right);
    });

    it('handles long prompt text changes (diff-match-patch text deltas)', () => {
        const left = baseState();
        const right = clone(left);
        left.players.p1.menuTitle =
            'Select a creature to deal 2 damage to, or click Done to skip this ability entirely';
        right.players.p1.menuTitle =
            'Select a creature to deal 4 damage to, or click Cancel to skip this ability entirely and pass';
        roundTrip(left, right);
    });

    it('handles full pile replacement and emptying', () => {
        const left = baseState();
        const right = clone(left);
        right.players.p1.cardPiles.hand = [];
        right.players.p2.cardPiles.discard = [card('x1'), card('x2'), card('x3')];
        roundTrip(left, right);
    });

    it('handles upgrades and child cards nesting', () => {
        const left = baseState();
        const right = clone(left);
        right.players.p1.cardPiles.cardsInPlay[0].upgrades = [card('u9')];
        (right.players.p1.cardPiles.cardsInPlay[1] as any).childCards = [card('c9')];
        roundTrip(left, right);
    });

    it('survives sequential patches across many turns', () => {
        let serverState = baseState();
        let clientState = clone(serverState);
        let serverBaseline = clone(serverState);

        for (let turn = 0; turn < 30; turn++) {
            const next = clone(serverState);
            // rotate active house
            const houses = next.players.p1.houses;
            next.players.p1.activeHouse = houses[turn % houses.length];
            // draw: move a discard card back to hand sometimes, or add messages
            next.messages.push({
                date: `2026-01-01T00:01:${String(turn).padStart(2, '0')}Z`,
                message: [{ name: turn % 2 ? 'p1' : 'p2' }, ` did action ${turn}`]
            });
            if (next.players.p1.cardPiles.hand.length > 0 && turn % 3 === 0) {
                const c = next.players.p1.cardPiles.hand.shift()!;
                next.players.p1.cardPiles.discard.push(c);
            }
            if (turn % 4 === 0) {
                next.players.p1.cardPiles.hand.push(card(`n${turn}`));
                next.players.p1.numDeckCards -= 1;
            }
            next.players.p2.stats.amber = (next.players.p2.stats.amber + 1) % 9;

            const delta = differ.diff(serverBaseline, next);
            serverBaseline = clone(next);
            serverState = next;

            clientState = patch(clientState, delta);
            expect(clientState).toEqual(serverState);
        }
    });
});

describe('jsonpatch fuzz', () => {
    // Deterministic PRNG so CI failures are reproducible.
    function mulberry32(seed: number) {
        return function () {
            let t = (seed += 0x6d2b79f5);
            t = Math.imul(t ^ (t >>> 15), t | 1);
            t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
            return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
        };
    }

    it('matches jsondiffpatch across 300 random mutations', () => {
        const rand = mulberry32(20260721);
        const pick = <T,>(arr: T[]): T => arr[Math.floor(rand() * arr.length)];
        let uuidCounter = 100;

        let state = baseState();
        let clientState = clone(state);
        let baseline = clone(state);

        for (let step = 0; step < 300; step++) {
            const next = clone(state) as any;
            const mutations = 1 + Math.floor(rand() * 4);
            for (let m = 0; m < mutations; m++) {
                const playerName = rand() < 0.5 ? 'p1' : 'p2';
                const player = next.players[playerName];
                const pileNames = ['hand', 'cardsInPlay', 'discard', 'archives', 'purged'];
                const op = Math.floor(rand() * 8);
                switch (op) {
                    case 0: {
                        // move a card between piles
                        const from = player.cardPiles[pick(pileNames)];
                        const to = player.cardPiles[pick(pileNames)];
                        if (from.length > 0) {
                            const idx = Math.floor(rand() * from.length);
                            const c = from.splice(idx, 1)[0];
                            to.splice(Math.floor(rand() * (to.length + 1)), 0, c);
                        }
                        break;
                    }
                    case 1: {
                        // add a new card
                        const to = player.cardPiles[pick(pileNames)];
                        to.splice(
                            Math.floor(rand() * (to.length + 1)),
                            0,
                            card(`f${uuidCounter++}`)
                        );
                        break;
                    }
                    case 2: {
                        // remove a card
                        const from = player.cardPiles[pick(pileNames)];
                        if (from.length > 0) {
                            from.splice(Math.floor(rand() * from.length), 1);
                        }
                        break;
                    }
                    case 3: {
                        // mutate a card in place
                        const pile = player.cardPiles[pick(pileNames)];
                        if (pile.length > 0) {
                            const c = pile[Math.floor(rand() * pile.length)];
                            c.exhausted = rand() < 0.5;
                            c.tokens =
                                rand() < 0.3
                                    ? {}
                                    : {
                                          damage: Math.floor(rand() * 5),
                                          power: Math.floor(rand() * 3)
                                      };
                            if (rand() < 0.2) {
                                c.upgrades = [card(`up${uuidCounter++}`)];
                            }
                        }
                        break;
                    }
                    case 4: {
                        // stats churn
                        player.stats.amber = Math.floor(rand() * 12);
                        player.stats.chains = Math.floor(rand() * 5);
                        player.stats.keys = {
                            red: rand() < 0.5,
                            blue: rand() < 0.5,
                            yellow: rand() < 0.5
                        };
                        break;
                    }
                    case 5: {
                        // prompt changes incl. long text (text-diff territory)
                        if (rand() < 0.5) {
                            player.menuTitle = `Select up to ${Math.floor(
                                rand() * 9
                            )} creatures to deal damage to, then click Done to continue with the ability resolution ${step}-${m}`;
                            player.buttons = [
                                { command: 'menuButton', text: 'Done', arg: 'done' },
                                rand() < 0.5
                                    ? { command: 'menuButton', text: 'Autoresolve', arg: 'auto' }
                                    : { command: 'menuButton', text: 'Cancel', arg: 'cancel' }
                            ];
                        } else {
                            delete player.menuTitle;
                            delete player.buttons;
                        }
                        break;
                    }
                    case 6: {
                        // messages append
                        next.messages.push({
                            date: `2026-01-01T00:02:00Z`,
                            message: [{ name: playerName }, ` acted (${step}.${m})`]
                        });
                        break;
                    }
                    case 7: {
                        // reorder a battleline
                        const pile = player.cardPiles.cardsInPlay;
                        if (pile.length > 1) {
                            const i = Math.floor(rand() * pile.length);
                            const j = Math.floor(rand() * pile.length);
                            const [c] = pile.splice(i, 1);
                            pile.splice(j, 0, c);
                        }
                        break;
                    }
                }
            }

            const delta = differ.diff(baseline, next);
            baseline = clone(next);
            state = next;
            clientState = patch(clientState, delta);
            expect(clientState).toEqual(state);
        }
    });
});
