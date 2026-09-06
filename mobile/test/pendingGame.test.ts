import { describe, expect, it } from 'vitest';
import {
    allPlayersReady,
    canStartGame,
    choosesOwnDeck,
    deckStatusLabel,
    offersLuckyDice,
    pinnedDeckHint,
    seatDeckLabel,
    seatIsLocked,
    startHint,
    tournamentHeadline,
    tournamentPlacement
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

describe('startHint when a sealed deal has stalled', () => {
    // The lobby deals sealed decks in the background and, when it cannot (no
    // sealed pool, an exception on its side), says nothing at all. Without a
    // time limit the screen sat on "Dealing sealed decks…" for good.
    it('keeps the dealing line while the deal is still young', () => {
        expect(startHint(game({ gameFormat: 'sealed', players: seats(false, false) }))).toBe(
            'Dealing sealed decks…'
        );
        expect(
            startHint(game({ gameFormat: 'sealed', players: seats(false, false) }), {
                sealedStalled: false
            })
        ).toBe('Dealing sealed decks…');
    });

    it('says the deal is not coming once it has stalled', () => {
        expect(
            startHint(game({ gameFormat: 'sealed', players: seats(false, false) }), {
                sealedStalled: true
            })
        ).toMatch(/could not deal/i);
    });

    it('ignores the stall flag outside sealed games', () => {
        expect(
            startHint(game({ players: seats(false, true) }), { sealedStalled: true })
        ).toBe('Waiting for 1 player to select a deck.');
    });
});

/**
 * ARCHON: tournament tables. The app knew nothing about them — it offered a
 * deck picker and a Lucky Dice roll on a seat the event had locked, both of
 * which the lobby refuses (server/lobby.js onSelectDeck, onSelectRandomDeck),
 * and said nothing about which game of which match the table was.
 */
const tournamentTable = (overrides: Record<string, unknown> = {}) => ({
    tournamentId: 7,
    matchId: 21,
    gameNumber: 2,
    bestOf: 3,
    round: 1,
    table: 4,
    players: ['host', 'guest'],
    deckSwapPolicy: 'locked',
    deckLocked: true,
    seats: {
        host: { locked: true, deckName: 'Ancient Bringer of Judgment' },
        guest: { locked: true, deckName: 'Miss Onyx' }
    },
    ...overrides
});

const tournament = (
    overrides: Partial<GameSummary> = {},
    table: Record<string, unknown> = {}
): GameSummary => game({ tournament: tournamentTable(table) as never, ...overrides });

describe('choosesOwnDeck at a tournament table', () => {
    it('is false on a seat the event pinned a deck to', () => {
        expect(choosesOwnDeck(tournament(), 'host')).toBe(false);
    });

    it('trusts deckLocked even when nobody names the seat', () => {
        // The server computes deckLocked for whoever asked for the summary, so
        // it is the answer for this viewer's own seat with or without a name.
        expect(choosesOwnDeck(tournament())).toBe(false);
    });

    it('is true for a tournament player the event registered no deck for', () => {
        // onSelectDeck only refuses a deck where one is pinned, so this player
        // really does have to pick, and hiding the picker would strand them.
        const open = tournament(
            {},
            { deckLocked: false, seats: { host: { locked: false }, guest: { locked: false } } }
        );

        expect(choosesOwnDeck(open, 'host')).toBe(true);
    });
});

describe('offersLuckyDice', () => {
    it('is offered in an ordinary game where you choose your own deck', () => {
        expect(offersLuckyDice(game(), 'host')).toBe(true);
        expect(offersLuckyDice(game({ gameFormat: 'sealed' }), 'host')).toBe(false);
    });

    it('is never offered at a tournament table, pinned or not', () => {
        // onSelectRandomDeck refuses every `game.tournament` outright: a random
        // deck is not the deck the event registered.
        expect(offersLuckyDice(tournament(), 'host')).toBe(false);
        expect(
            offersLuckyDice(
                tournament({}, { deckLocked: false, seats: { host: { locked: false } } }),
                'host'
            )
        ).toBe(false);
    });
});

describe('seatIsLocked', () => {
    it('reads the seats map for either player', () => {
        expect(seatIsLocked(tournament(), 'guest')).toBe(true);
        expect(seatIsLocked(game(), 'guest')).toBe(false);
    });

    it('falls back to the viewer’s own deckLocked when there is no seats map', () => {
        const noSeats = tournament({}, { seats: undefined });

        expect(seatIsLocked(noSeats, 'host', 'host')).toBe(true);
        expect(seatIsLocked(noSeats, 'guest', 'host')).toBe(false);
    });
});

describe('deck labels at a tournament table', () => {
    it('names the event deck for both seats before either has loaded', () => {
        // The table knows both names from the moment the pairing is made. It
        // used to read "Choosing a deck…" on both sides of a table where
        // neither player had anything to choose.
        const table = tournament({ players: seats(false, false) as never });

        expect(seatDeckLabel(table, { name: 'host' }, 'host')).toBe(
            'Ancient Bringer of Judgment'
        );
        expect(seatDeckLabel(table, { name: 'guest' }, 'host')).toBe('Miss Onyx');
    });

    it('says a locked seat is loading rather than choosing', () => {
        const unnamed = tournament({}, { seats: { host: { locked: true } } });

        expect(deckStatusLabel(unnamed, 'host')).toMatch(/event deck/i);
        expect(deckStatusLabel(unnamed, 'guest')).toMatch(/Choosing/);
    });

    it('leaves an ordinary seat’s label alone', () => {
        const mine = { name: 'host', deck: { selected: true, name: 'Nature' } };

        expect(seatDeckLabel(game(), mine, 'host')).toBe('Nature');
        // Only your own summary carries the deck's name.
        expect(seatDeckLabel(game(), { name: 'guest', deck: { selected: true } }, 'host')).toBe(
            'Deck selected'
        );
        expect(seatDeckLabel(game(), { name: 'guest' }, 'host')).toMatch(/Choosing/);
    });
});

describe('tournament header', () => {
    it('says which game of which match this table is', () => {
        expect(tournamentHeadline(tournament())).toBe('Game 2 of 3 — tournament match');
    });

    it('does not count games in a single-game match', () => {
        expect(tournamentHeadline(tournament({}, { bestOf: 1 }))).toBe('Tournament match');
        expect(tournamentHeadline(game())).toBeUndefined();
    });

    it('locates the pairing in the event when the event says where', () => {
        expect(tournamentPlacement(tournament())).toBe('Round 1 · Table 4');
        expect(tournamentPlacement(tournament({}, { round: undefined, table: undefined }))).toBe(
            undefined
        );
    });

    it('words the two deck-swap policies differently', () => {
        // Under 'locked' there is nothing the player can do; under
        // 'between-rounds' there is, and it is on the event page.
        expect(pinnedDeckHint(tournament())).toMatch(/whole run/i);
        expect(pinnedDeckHint(tournament({}, { deckSwapPolicy: 'between-rounds' }))).toMatch(
            /event page/i
        );
    });
});

describe('startHint at a tournament table', () => {
    it('does not count a locked seat as a player who has not chosen', () => {
        expect(startHint(tournament({ players: seats(false, false) as never }))).toMatch(
            /Loading the decks/i
        );
    });

    it('still waits on a tournament player who has to pick', () => {
        const open = tournament(
            { players: seats(true, false) as never },
            { seats: { host: { locked: true }, guest: { locked: false } } }
        );

        expect(startHint(open)).toBe('Waiting for 1 player to select a deck.');
    });

    it('says the table starts itself once both seats hold their decks', () => {
        // server/lobby.js startTournamentGameIfReady - nobody is waiting on the
        // host to press anything.
        expect(startHint(tournament())).toMatch(/starts on its own/i);
    });
});
