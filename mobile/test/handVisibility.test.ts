import { describe, expect, it } from 'vitest';
import { isHandHidden, playerNeedsInput, shouldHideHand } from '../src/game/handVisibility';
import type { CardSummary, PlayerState } from '../src/game/types';

const player = (overrides: Partial<PlayerState> = {}): PlayerState =>
    ({
        name: 'me',
        numDeckCards: 20,
        stats: { amber: 0, chains: 0, keyCost: 6, keys: { red: false, blue: false, yellow: false } },
        cardPiles: { archives: [], cardsInPlay: [], discard: [], hand: [], purged: [] },
        ...overrides
    }) as PlayerState;

const card = (overrides: Partial<CardSummary> = {}): CardSummary => ({ uuid: 'c1', ...overrides });

describe('playerNeedsInput', () => {
    it('is false while waiting on the opponent', () => {
        expect(playerNeedsInput(player({ menuTitle: 'Waiting for opponent' }))).toBe(false);
    });

    it('is true when there are buttons to press', () => {
        expect(playerNeedsInput(player({ buttons: [{ text: 'Done' }] }))).toBe(true);
    });

    it('is true when a targeting control is up', () => {
        expect(playerNeedsInput(player({ controls: [{ type: 'targeting' }] }))).toBe(true);
    });

    it('is true when the game is asking for a card', () => {
        expect(playerNeedsInput(player({ selectCard: true }))).toBe(true);
        expect(playerNeedsInput(player({ selectOrder: true }))).toBe(true);
    });

    it('is true when a card in hand is selectable, even with no buttons', () => {
        const state = player({
            cardPiles: {
                archives: [],
                cardsInPlay: [],
                discard: [],
                purged: [],
                hand: [card({ selectable: true })]
            }
        });
        expect(playerNeedsInput(state)).toBe(true);
    });

    it('handles a missing player', () => {
        expect(playerNeedsInput(undefined)).toBe(false);
    });
});

describe('shouldHideHand', () => {
    it('hides on the opponent turn once enabled', () => {
        expect(shouldHideHand({ enabled: true, isMyTurn: false })).toBe(true);
    });

    it('does nothing while the setting is off', () => {
        expect(shouldHideHand({ enabled: false, isMyTurn: false })).toBe(false);
    });

    it('never hides on your own turn', () => {
        expect(shouldHideHand({ enabled: true, isMyTurn: true })).toBe(false);
    });

    it('shows again the moment the game asks for something', () => {
        expect(shouldHideHand({ enabled: true, isMyTurn: false, needsInput: true })).toBe(false);
    });

    it('respects a peek', () => {
        expect(shouldHideHand({ enabled: true, isMyTurn: false, isPeeking: true })).toBe(false);
    });

    it('leaves a spectator alone — the hand on screen is not theirs', () => {
        expect(shouldHideHand({ enabled: true, isMyTurn: false, isSpectator: true })).toBe(false);
    });
});

describe('isHandHidden', () => {
    it('takes the setting from the account as well as the phone', () => {
        const waiting = player({ activePlayer: false });

        expect(isHandHidden({ me: waiting, localSetting: false })).toBe(false);
        expect(isHandHidden({ me: waiting, localSetting: true })).toBe(true);
        expect(
            isHandHidden({
                me: player({ activePlayer: false, optionSettings: { hideHandOnOpponentTurn: true } }),
                localSetting: false
            })
        ).toBe(true);
    });

    it('stays visible on my own turn however it was switched on', () => {
        const mine = player({
            activePlayer: true,
            optionSettings: { hideHandOnOpponentTurn: true }
        });
        expect(isHandHidden({ me: mine, localSetting: true })).toBe(false);
    });

    it('comes back for a prompt that arrives mid opponent-turn', () => {
        // Befuddle and friends prompt the inactive player; a hand they cannot
        // see is a hand they cannot answer with.
        const prompted = player({ activePlayer: false, buttons: [{ text: 'Choose a card' }] });
        expect(isHandHidden({ me: prompted, localSetting: true })).toBe(false);
    });

    it('does nothing at all for a spectator', () => {
        expect(
            isHandHidden({ me: undefined, localSetting: true, isSpectator: true })
        ).toBe(false);
    });
});
