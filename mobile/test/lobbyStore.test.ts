import { beforeEach, describe, expect, it } from 'vitest';
import type { GameSummary } from '../src/api/types';
import { useLobbyStore } from '../src/stores/lobbyStore';

const game = (id: string, name = id): GameSummary =>
    ({ id, name, players: {}, started: false } as unknown as GameSummary);

describe('lobbyStore.addGames', () => {
    beforeEach(() => {
        useLobbyStore.getState().setGames([]);
    });

    it('puts a new game at the top of the list', () => {
        useLobbyStore.getState().setGames([game('a')]);
        useLobbyStore.getState().addGames([game('b')]);

        expect(useLobbyStore.getState().games.map((entry) => entry.id)).toEqual(['b', 'a']);
    });

    // The lobby announces a game to everyone, its creator included, and the
    // creator's list may already hold it from the last full refresh. Listing
    // it twice put two identical rows on the Play tab and tripped React's
    // duplicate-key warning on the game id.
    it('replaces a game already in the list instead of listing it twice', () => {
        useLobbyStore.getState().setGames([game('a', 'old name'), game('c')]);
        useLobbyStore.getState().addGames([game('a', 'new name')]);

        const games = useLobbyStore.getState().games;
        expect(games.map((entry) => entry.id)).toEqual(['a', 'c']);
        expect(games[0].name).toBe('new name');
    });
});

/**
 * ARCHON: the table the player is actually sitting at.
 *
 * `updategame` used to move the lobby list and leave `currentGame` alone, so
 * `currentGame.started` was structurally false and the pending screen kept
 * drawing whatever the last `gamestate` had said — both seats occupied at a
 * table the server had already emptied.
 *
 * The two summaries are not the same summary: `gamestate` is built for one
 * viewer and carries the chat and each seat's deck, while the `updategame`
 * broadcast is built for nobody and carries neither (server/pendinggame.js
 * getSummary). So the update is adopted for what it knows and the rest is
 * kept.
 */
const table = (overrides: Partial<GameSummary> = {}): GameSummary =>
    ({
        id: 't1',
        name: 'round 1, table 4',
        started: false,
        messages: [{ message: 'good luck' }],
        players: {
            me: { name: 'me', deck: { name: 'Miss Onyx', selected: true } },
            them: { name: 'them', deck: { selected: true } }
        },
        ...overrides
    }) as unknown as GameSummary;

/** What the lobby-wide broadcast looks like: no chat, no deck detail. */
const broadcastOf = (game: GameSummary, overrides: Partial<GameSummary> = {}): GameSummary =>
    ({
        ...game,
        messages: undefined,
        players: Object.fromEntries(
            Object.keys(game.players ?? {}).map((name) => [name, { name, deck: {} }])
        ),
        ...overrides
    }) as unknown as GameSummary;

describe('lobbyStore.updateGames', () => {
    beforeEach(() => {
        useLobbyStore.getState().reset();
    });

    it('replaces the table we are sitting at', () => {
        const seated = table();
        useLobbyStore.getState().setCurrentGame(seated);
        useLobbyStore.getState().updateGames([broadcastOf(seated, { started: true })], 'me');

        expect(useLobbyStore.getState().currentGame?.started).toBe(true);
    });

    it('keeps the chat and the decks the broadcast cannot carry', () => {
        // Adopting the broadcast whole emptied the pending chat and un-readied
        // both players, because readiness is deck.selected — so the Start
        // button died every time anything in the lobby changed.
        const seated = table();
        useLobbyStore.getState().setCurrentGame(seated);
        useLobbyStore.getState().updateGames([broadcastOf(seated)], 'me');

        const current = useLobbyStore.getState().currentGame;
        expect(current?.messages).toHaveLength(1);
        expect(current?.players.me.deck?.selected).toBe(true);
        expect(current?.players.me.deck?.name).toBe('Miss Onyx');
    });

    it('drops the table when the update no longer seats us', () => {
        // What a foreground reconnect looks like after the server has given
        // our seat away: the screen used to keep drawing two full seats.
        const seated = table();
        useLobbyStore.getState().setCurrentGame(seated);
        useLobbyStore
            .getState()
            .updateGames(
                [broadcastOf(seated, { players: { them: { name: 'them' } } as never })],
                'me'
            );

        expect(useLobbyStore.getState().currentGame).toBeUndefined();
    });

    it('leaves a spectator watching', () => {
        // A spectator was never in `players`, so "not seated any more" must not
        // be read off a table they were only ever watching.
        const seated = table();
        useLobbyStore.getState().setCurrentGame(seated);
        useLobbyStore.getState().updateGames([broadcastOf(seated)], 'onlooker');

        expect(useLobbyStore.getState().currentGame?.id).toBe('t1');
    });

    it('ignores updates about other tables', () => {
        const seated = table();
        useLobbyStore.getState().setGames([game('other')]);
        useLobbyStore.getState().setCurrentGame(seated);
        useLobbyStore.getState().updateGames([game('other', 'renamed')], 'me');

        expect(useLobbyStore.getState().currentGame).toBe(seated);
        expect(useLobbyStore.getState().games[0].name).toBe('renamed');
    });
});

/**
 * A tournament table, as the two summaries carry it. `deckLocked` is computed
 * for whoever the summary was built for and a seat's deck name is withheld
 * from everyone but its own player under `hideDeckLists` — so the broadcast,
 * built for nobody, carries neither (server/pendinggame.js getSummary,
 * getTournamentSeats).
 */
const pinnedTable = (overrides: Record<string, unknown> = {}): GameSummary =>
    table({
        tournament: {
            tournamentId: 7,
            matchId: 21,
            gameNumber: 2,
            bestOf: 3,
            deckSwapPolicy: 'locked',
            deckLocked: true,
            seats: {
                me: { locked: true, deckName: 'Miss Onyx' },
                them: { locked: true, deckName: 'Ancient Bringer of Judgment' }
            },
            ...overrides
        }
    } as unknown as Partial<GameSummary>);

describe('lobbyStore.updateGames at a tournament table', () => {
    beforeEach(() => {
        useLobbyStore.getState().reset();
    });

    // Where the server sends no seats map, `deckLocked` is the only lock there
    // is — and taking the broadcast's false for it put the deck picker and the
    // Lucky Dice roll back on a pinned seat, the two controls the lobby can
    // only refuse, on every lobby event.
    it('keeps our seat pinned when the broadcast cannot say it is', () => {
        const seated = pinnedTable({ seats: undefined });
        useLobbyStore.getState().setCurrentGame(seated);
        useLobbyStore
            .getState()
            .updateGames(
                [
                    broadcastOf(seated, {
                        tournament: { ...seated.tournament, deckLocked: false }
                    } as unknown as Partial<GameSummary>)
                ],
                'me'
            );

        expect(useLobbyStore.getState().currentGame?.tournament?.deckLocked).toBe(true);
    });

    // The event's deck name for a seat is decklist information: under
    // hideDeckLists the broadcast withholds it from everybody, so adopting it
    // wiped the deck named against both seats seconds after the table opened.
    it('keeps the event deck names the broadcast withholds', () => {
        const seated = pinnedTable();
        useLobbyStore.getState().setCurrentGame(seated);
        useLobbyStore.getState().updateGames(
            [
                broadcastOf(seated, {
                    tournament: {
                        ...seated.tournament,
                        deckLocked: false,
                        seats: { me: { locked: true }, them: { locked: true } }
                    }
                } as unknown as Partial<GameSummary>)
            ],
            'me'
        );

        const seats = useLobbyStore.getState().currentGame?.tournament?.seats;
        expect(seats?.me.deckName).toBe('Miss Onyx');
        expect(seats?.them.deckName).toBe('Ancient Bringer of Judgment');
    });

    // Everything else about the match is the broadcast's to say: it is how a
    // seat that has gone is heard about at all.
    it('still takes what the update genuinely knows', () => {
        const seated = pinnedTable();
        useLobbyStore.getState().setCurrentGame(seated);
        useLobbyStore.getState().updateGames(
            [
                broadcastOf(seated, {
                    started: true,
                    tournament: { ...seated.tournament, gameNumber: 3, deckLocked: false }
                } as unknown as Partial<GameSummary>)
            ],
            'me'
        );

        const current = useLobbyStore.getState().currentGame;
        expect(current?.started).toBe(true);
        expect(current?.tournament?.gameNumber).toBe(3);
    });
});

describe('lobbyStore.removeGames', () => {
    beforeEach(() => {
        useLobbyStore.getState().reset();
    });

    it('says a table that never started has timed out', () => {
        const seated = table();
        useLobbyStore.getState().setCurrentGame(seated);
        useLobbyStore.getState().removeGames([seated]);

        expect(useLobbyStore.getState().currentGame).toBeUndefined();
        expect(useLobbyStore.getState().gameError).toMatch(/timed out/i);
    });

    it('says nothing when a finished game is retired', () => {
        // A tournament series removes the finished table before opening the
        // next game's (server/lobby.js onTournamentNextGame). Calling that a
        // timeout put a false error on screen the moment a game ENDED — and it
        // then rode along to the next table of the same match.
        const seated = table();
        useLobbyStore.getState().setCurrentGame(seated);
        useLobbyStore.getState().updateGames([broadcastOf(seated, { started: true })], 'me');
        useLobbyStore.getState().removeGames([broadcastOf(seated, { started: true })]);

        expect(useLobbyStore.getState().currentGame).toBeUndefined();
        expect(useLobbyStore.getState().gameError).toBeUndefined();
    });

    it('trusts the removed summary even if our copy never saw the start', () => {
        const seated = table();
        useLobbyStore.getState().setCurrentGame(seated);
        useLobbyStore.getState().removeGames([broadcastOf(seated, { started: true })]);

        expect(useLobbyStore.getState().gameError).toBeUndefined();
    });
});

describe('lobbyStore.setCurrentGame', () => {
    beforeEach(() => {
        useLobbyStore.getState().reset();
    });

    it('does not carry an error over to the next table', () => {
        // Game two of a tournament match is a different table. The error
        // raised against game one stuck to it and read as a fault at a table
        // where nothing had gone wrong.
        useLobbyStore.getState().setCurrentGame(table());
        useLobbyStore.getState().setGameError('The game has timed out and is no longer available.');
        useLobbyStore.getState().setCurrentGame(table({ id: 't2' }));

        expect(useLobbyStore.getState().gameError).toBeUndefined();
    });

    it('keeps an error raised about the table we are still at', () => {
        // The lobby answers a refused deck with `gameerror` and then pushes the
        // same table's state straight back (server/lobby.js onSelectDeck), so
        // clearing on every state would swallow the refusal.
        const seated = table();
        useLobbyStore.getState().setCurrentGame(seated);
        useLobbyStore.getState().setGameError('This event locks you to one deck.');
        useLobbyStore.getState().setCurrentGame(table());

        expect(useLobbyStore.getState().gameError).toBe('This event locks you to one deck.');
    });
});
