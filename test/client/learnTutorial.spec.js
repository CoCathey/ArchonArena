import { describe, it, expect } from 'vitest';

import { TutorialSteps } from '../../client/Components/Learn/tutorialScript';
import { buildTutorialStates, keyCostFor } from '../../client/Components/Learn/tutorialEngine';
import { TutorialCards } from '../../client/Components/Learn/tutorialCards';
import { RadiantDeck, OnyxDeck } from '../../client/Components/Learn/tutorialDecks';

/**
 * ARCHON (N11): the /learn tutorial replays the demo game from the two-player
 * starter set. These tests are what stop the script drifting away from that
 * game: they check the checkpoints the official walkthrough calls out by name
 * (hand sizes, Aember totals, key costs, which card is drawn when) and the
 * invariant that no step invents a card.
 */

const states = buildTutorialStates(TutorialSteps);

/** The state after the last step whose title matches. */
const after = (title) => {
    const index = TutorialSteps.findIndex((step) => step.title === title);

    expect(index, `no tutorial step titled "${title}"`).toBeGreaterThan(-1);

    return states[index];
};

/** The state at the step that begins the given turn. */
const atTurn = (turn) => {
    const index = TutorialSteps.findIndex((step, i) => states[i].turn === turn);

    return states[index];
};

const ownerOf = (cardId) => (RadiantDeck.cards.includes(cardId) ? 'radiant' : 'onyx');

/** Every card belonging to a deck, wherever it currently sits. */
const accountedFor = (state, side) => {
    const found = [];

    for (const player of Object.values(state.players)) {
        for (const pile of [player.deck, player.hand, player.discard, player.archives]) {
            found.push(...pile);
        }

        for (const permanent of player.creatures.concat(player.artifacts, player.other)) {
            found.push(permanent.id, ...permanent.upgrades);
        }
    }

    return found.filter((cardId) => ownerOf(cardId) === side);
};

describe('Learn tutorial decks', () => {
    it('are the 18-card learning decks, three houses of six', () => {
        for (const deck of [RadiantDeck, OnyxDeck]) {
            expect(deck.cards).toHaveLength(18);
            expect(new Set(deck.cards).size).toBe(18);

            for (const house of deck.houses) {
                const inHouse = deck.cards.filter((id) => TutorialCards[id].house === house);

                expect(inHouse, `${deck.name} house ${house}`).toHaveLength(6);
            }
        }
    });

    it('has card data for every card in both decks', () => {
        for (const cardId of RadiantDeck.cards.concat(OnyxDeck.cards)) {
            expect(TutorialCards[cardId], cardId).toBeTruthy();
        }
    });

    it('numbers the cards the walkthrough calls out by number', () => {
        // The walkthrough names these two by position when Onyx draws them.
        expect(OnyxDeck.cards[5]).toBe('forced-retirement');
        expect(OnyxDeck.cards[9]).toBe('kaupe');
    });
});

describe('Learn tutorial script', () => {
    it('builds a state for every step without a rules error', () => {
        expect(states).toHaveLength(TutorialSteps.length);
    });

    it('gives every step a chapter, a title and body text', () => {
        for (const step of TutorialSteps) {
            expect(step.chapter, step.title).toBeTruthy();
            expect(step.title, step.chapter).toBeTruthy();
            expect(step.body?.length, step.title).toBeGreaterThan(0);
        }
    });

    it('never invents or loses a card', () => {
        const stacked = TutorialSteps.findIndex((step) => step.title === 'Stack the decks');

        for (const [index, state] of states.entries()) {
            for (const side of ['radiant', 'onyx']) {
                const cards = accountedFor(state, side);
                const where = `step ${index} (${TutorialSteps[index].title}), ${side}`;

                expect(cards.length, `${where} lost or duplicated a card`).toBe(
                    index < stacked ? 0 : 18
                );
                expect(new Set(cards).size, `${where} duplicated a card`).toBe(cards.length);
            }
        }
    });

    it('leaves the turn-step strip on the step the narration is describing', () => {
        // Every completed turn ends in its draw step. Turn 13 is the forge that
        // ends the walkthrough, so it stops at step 1.
        for (let turn = 1; turn <= 12; turn++) {
            const last = states.filter((state) => state.turn === turn).pop();

            expect(last?.phase, `turn ${turn} should end on the draw step`).toBe('Draw cards');
        }

        expect(states[states.length - 1].phase).toBe('Forge a key');
    });

    it('only highlights board targets that make sense', () => {
        for (const step of TutorialSteps) {
            for (const target of step.highlight || []) {
                if (target === 'turnsteps' || target === 'log') {
                    continue;
                }

                const [side, kind, name] = target.split('.');

                expect(['radiant', 'onyx'], step.title).toContain(side);
                expect(['card', 'zone', 'stat'], step.title).toContain(kind);

                if (kind === 'card') {
                    expect(TutorialCards[name], `${step.title}: ${target}`).toBeTruthy();
                }
            }
        }
    });
});

describe('Learn tutorial checkpoints', () => {
    it('deals 7 cards to the first player and 6 to the second', () => {
        const state = after('Opening hands');

        expect(state.players.radiant.hand).toHaveLength(7);
        expect(state.players.onyx.hand).toHaveLength(6);
        expect(state.players.radiant.deck).toHaveLength(11);
        expect(state.players.onyx.deck).toHaveLength(12);
    });

    it('draws no cards on the first turn, because the hand is already six', () => {
        const state = after('Step 5 — draw cards');

        expect(state.players.radiant.hand).toHaveLength(6);
        expect(state.players.radiant.deck).toHaveLength(11);
    });

    it('empties the Radiant deck on turn 7, as the walkthrough says', () => {
        const state = after('The deck runs out');

        expect(state.turn).toBe(7);
        expect(state.players.radiant.deck).toHaveLength(0);
        expect(state.players.radiant.hand).toHaveLength(6);
    });

    it('empties the Onyx deck on turn 8', () => {
        const state = after('After Reap abilities');

        expect(state.turn).toBe(8);
        expect(state.players.onyx.deck).toHaveLength(0);
    });

    it('reaches nine cards in hand after emptying the archives on turn 9', () => {
        const state = after('Emptying the archives');

        expect(state.players.radiant.hand).toHaveLength(9);
        expect(state.players.radiant.archives).toHaveLength(0);
    });

    it('has Radiant on 2 Aember at the start of turn 9 and 5 at the start of turn 11', () => {
        expect(atTurn(9).players.radiant.amber).toBe(2);
        expect(atTurn(11).players.radiant.amber).toBe(5);
        expect(keyCostFor(atTurn(11), 'radiant')).toBe(6);
    });

    it('has Onyx on 3 Aember and a key cost of 10 at the start of turn 10', () => {
        const state = atTurn(10);

        expect(state.players.onyx.amber).toBe(3);
        expect(keyCostFor(state, 'onyx')).toBe(10);
    });

    it('brings Radiant to 10 Aember on turn 11', () => {
        expect(after('Zap').players.radiant.amber).toBe(10);
        expect(after('“Check”').players.radiant.amber).toBe(10);
    });

    it('destroys Gemcoat Vendor with Zap plus its own turn 8 self-damage', () => {
        const before = after('After Reap abilities');
        const gemcoat = before.players.onyx.creatures.find((c) => c.id === 'gemcoat-vendor');

        expect(gemcoat.damage).toBe(1);
        expect(after('Zap').players.onyx.creatures.some((c) => c.id === 'gemcoat-vendor')).toBe(
            false
        );
    });

    it('knocks Radiant down to 8 Aember when Grenade Snib dies', () => {
        expect(after('Taunt changes the target').players.radiant.amber).toBe(8);
    });

    it('forges Radiant’s first key on turn 13', () => {
        const state = after('Forge!');

        expect(state.turn).toBe(13);
        expect(state.players.radiant.keys).toBe(1);
        expect(state.players.radiant.amber).toBe(2);
    });

    it('leaves Radiant holding seven cards after drawing on Onyx’s turn 8', () => {
        // Belligerent Guard makes the opponent draw, and a card drawn on your
        // opponent's turn is simply kept - which is where the ninth card on
        // turn 9 comes from once the archives are added.
        expect(after('End of turn').players.radiant.hand.length).toBeGreaterThanOrEqual(6);
        expect(atTurn(9).players.radiant.hand).toHaveLength(7);
    });

    it('runs Radiant out of cards on turn 11, as the walkthrough says', () => {
        const state = after('“Check”');

        expect(state.players.radiant.deck).toHaveLength(0);
        expect(state.players.radiant.discard).toHaveLength(0);
        expect(state.players.radiant.hand).toHaveLength(5);
    });
});
