import { describe, expect, it } from 'vitest';
import {
    allPlayersReady,
    canStartGame,
    choosesOwnDeck,
    deckStatusLabel,
    startHint
} from '../src/game/pendingGame';
import type { GameSummary } from '../src/api/types';

const game = (overrides: Partial<GameSummary> = {}): GameSummary =>
    ({
        id: 'g1',
        name: 'a game',
        owner: 'host',
        gameFormat: 'normal',
        players: {
            host: { name: 'host', deck: { selected: true } },
            guest: { name: 'guest', deck: { selected: true } }
        },
        ...overrides
    }) as GameSummary;

const seats = (hostReady: boolean, guestReady: boolean) => ({
    host: { name: 'host', deck: hostReady ? { selected: true } : undefined },
    guest: { name: 'guest', deck: guestReady ? { selected: true } : undefined }
});

describe('allPlayersReady', () => {
    it('needs both seats filled', () => {
        expect(
            allPlayersReady(game({ players: { host: { name: 'host', deck: { selected: true } } } as never }))
        ).toBe(false);
    });

    it('needs every deck selected in an ordinary game', () => {
        expect(allPlayersReady(game({ players: seats(true, false) as never }))).toBe(false);
        expect(allPlayersReady(game({ players: seats(true, true) as never }))).toBe(true);
    });

    it('is ready with no decks at all in a Lucky Dice game', () => {
        // The lobby rolls both decks when the owner presses Start
        // (server/lobby.js onStartGame), so waiting for them here waits for
        // something that cannot happen — which left Lucky Dice unplayable.
        expect(
            allPlayersReady(game({ luckyDice: true, players: seats(false, false) as never }))
        ).toBe(true);
    });

    it('still needs an opponent in a Lucky Dice game', () => {
        expect(
            allPlayersReady(
                game({ luckyDice: true, players: { host: { name: 'host' } } as never })
            )
        ).toBe(false);
    });
});

describe('canStartGame', () => {
    it('is the owner only', () => {
        const ready = game();
        expect(canStartGame({ game: ready, isOwner: false })).toBe(false);
        expect(canStartGame({ game: ready, isOwner: true })).toBe(true);
    });

    it('lets the owner start a deckless Lucky Dice game', () => {
        const dice = game({ luckyDice: true, players: seats(false, false) as never });
        expect(canStartGame({ game: dice, isOwner: true })).toBe(true);
    });
});

describe('choosesOwnDeck', () => {
    it('is false where the game hands out the decks', () => {
        expect(choosesOwnDeck(game())).toBe(true);
        expect(choosesOwnDeck(game({ gameFormat: 'sealed' }))).toBe(false);
        expect(choosesOwnDeck(game({ luckyDice: true }))).toBe(false);
    });
});

describe('startHint', () => {
    it('explains what is being waited on', () => {
        expect(startHint(game({ players: { host: { name: 'host' } } as never }))).toMatch(
            /opponent/i
        );
        expect(startHint(game({ players: seats(true, false) as never }))).toMatch(/1 player/);
        expect(startHint(game({ players: seats(false, false) as never }))).toMatch(/2 players/);
        expect(startHint(game())).toMatch(/Ready/);
    });

    it('explains an enabled button nobody has picked a deck for', () => {
        expect(
            startHint(game({ luckyDice: true, players: seats(false, false) as never }))
        ).toMatch(/dice/i);
    });
});

describe('deckStatusLabel', () => {
    it('says what a seat without a deck is waiting on', () => {
        expect(deckStatusLabel(game())).toMatch(/Choosing/);
        expect(deckStatusLabel(game({ gameFormat: 'sealed' }))).toMatch(/sealed/i);
        expect(deckStatusLabel(game({ luckyDice: true }))).toMatch(/Rolls/);
    });
});
