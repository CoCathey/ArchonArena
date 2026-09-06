import { create } from 'zustand';
import type {
    GameSummary,
    LobbyMessage,
    LobbyNotice,
    TournamentSeat,
    TournamentTable
} from '../api/types';

export type LobbyStatus = 'disconnected' | 'connecting' | 'connected';

/**
 * ARCHON: Quick Match, as the lobby reports it.
 *
 * 'searching' is the server's own word and carries the live queue size, which
 * is the only honest thing to show somebody waiting — "3 players looking" is
 * information, a spinner is not.
 */
export interface MatchmakingState {
    status: 'idle' | 'searching' | 'matched' | 'error';
    format?: string;
    queued?: number;
    message?: string;
}

/**
 * The tournament block has the same "built for nobody" problem as the decks,
 * in the two fields the table's own screen is driven by.
 *
 * `deckLocked` is computed for whoever the summary was made for — the
 * broadcast was made for no one, so it arrives false for a seat the event has
 * pinned; where the server sends no `seats` map (an older one), that is the
 * only lock signal there is, and adopting it puts the deck picker and the
 * Lucky Dice roll back on a pinned seat, the two controls the lobby can only
 * refuse. A seat's `deckName` is withheld from anyone but its own player under
 * `hideDeckLists`, so the broadcast withholds it from everybody: the event
 * deck named on the pending screen would vanish on the next lobby event.
 *
 * A lock that genuinely goes away (the event let a player change deck, or they
 * cleared it) arrives as a `gamestate` of its own — server/lobby.js
 * onTournamentDeckRegistered calls sendGameState — which replaces this
 * wholesale. So keeping what the broadcast cannot carry never keeps it long.
 */
function reconcileTournament(
    current: TournamentTable | undefined,
    incoming: TournamentTable | undefined
): TournamentTable | undefined {
    if (!incoming || !current) {
        return incoming;
    }

    const seats: Record<string, TournamentSeat> = {};

    for (const [name, seat] of Object.entries(incoming.seats ?? {})) {
        const known = current.seats?.[name];

        seats[name] =
            seat.deckName || !known?.deckName ? seat : { ...seat, deckName: known.deckName };
    }

    return {
        ...incoming,
        // False here means "not told", not "not pinned".
        deckLocked: incoming.deckLocked || current.deckLocked,
        seats: incoming.seats ? seats : current.seats
    };
}

/**
 * ARCHON: reconcile the table we are sitting at with the lobby-wide update
 * the server has just broadcast about it.
 *
 * The two summaries are not the same summary. `gamestate` is built for one
 * viewer (server/pendinggame.js getSummary, with an activePlayer) and carries
 * the pending chat and what each seat holds; the `updategame` broadcast is
 * built for nobody, so every seat's deck arrives as `{}` and the messages as
 * undefined. Adopting the broadcast whole would empty the chat and un-ready
 * both players — readiness is `deck.selected` — every time anything at all
 * changed in the lobby. So the update wins on everything it genuinely knows
 * (who is seated, whether the game started, which game of which match this is)
 * and the fields it cannot carry — the chat, the decks, and the two
 * viewer-specific tournament fields above — are kept from the copy we hold.
 */
function reconcilePendingGame(current: GameSummary, incoming: GameSummary): GameSummary {
    const players: GameSummary['players'] = {};

    for (const [name, player] of Object.entries(incoming.players ?? {})) {
        // An empty deck means "not told", not "no deck": only a summary built
        // for a viewer ever names one.
        const namesTheDeck = !!player.deck && Object.keys(player.deck).length > 0;
        const known = current.players?.[name];

        players[name] = namesTheDeck || !known?.deck ? player : { ...player, deck: known.deck };
    }

    return {
        ...incoming,
        players,
        tournament: reconcileTournament(current.tournament, incoming.tournament),
        messages: incoming.messages ?? current.messages
    };
}

interface LobbyState {
    status: LobbyStatus;
    games: GameSummary[];
    /** The pending (not yet started) game this user sits in, if any. */
    currentGame?: GameSummary;
    users: { name: string; avatar?: string }[];
    motd?: { message?: string; [key: string]: unknown };
    banner?: string;
    passwordError?: string;
    gameError?: string;
    /** Quick Match: the state of this account's place in the queue. */
    matchmaking: MatchmakingState;
    /** Site-wide lobby chat, oldest first. */
    chat: LobbyMessage[];
    /**
     * Why the server refused a chat message (too new an account, or a mute).
     * Held rather than shown as an error banner because it is an explanation,
     * not a failure of the app.
     */
    chatRefusal?: string;
    /**
     * The last notice the lobby addressed to this player, waiting to be said.
     *
     * Serialised because two identical notices in a row are two things that
     * happened — press "Join your table" twice while still seated elsewhere
     * and the second refusal must be shown too, which a view watching the
     * object's text alone would swallow.
     */
    notice?: LobbyNotice & { id: number };
    setStatus: (status: LobbyStatus) => void;
    setGames: (games: GameSummary[]) => void;
    addGames: (games: GameSummary[]) => void;
    updateGames: (games: GameSummary[], viewer?: string) => void;
    removeGames: (games: GameSummary[]) => void;
    setCurrentGame: (game?: GameSummary) => void;
    setUsers: (users: { name: string; avatar?: string }[]) => void;
    setMotd: (motd?: LobbyState['motd']) => void;
    setBanner: (banner?: string) => void;
    setPasswordError: (error?: string) => void;
    setGameError: (error?: string) => void;
    setMatchmaking: (state: MatchmakingState) => void;
    setChat: (messages: LobbyMessage[]) => void;
    addChatMessage: (message: LobbyMessage) => void;
    setChatRefusal: (message?: string) => void;
    setNotice: (notice: LobbyNotice) => void;
    clearNotice: () => void;
    reset: () => void;
}

export const useLobbyStore = create<LobbyState>((set, get) => ({
    status: 'disconnected',
    games: [],
    currentGame: undefined,
    users: [],
    matchmaking: { status: 'idle' },
    chat: [],
    setStatus: (status) => set({ status }),
    setGames: (games) => {
        const { currentGame } = get();
        // If our pending game vanished from the authoritative list, drop it.
        if (currentGame && !games.some((game) => game.id === currentGame.id)) {
            set({ games, currentGame: undefined });
        } else {
            set({ games });
        }
    },
    // The lobby announces a game to everyone, its creator included, and the
    // creator's list may already hold it from the last full refresh - so an
    // arriving game replaces its own earlier entry rather than joining it.
    addGames: (games) => {
        const arriving = new Set(games.map((game) => game.id));
        set({ games: [...games, ...get().games.filter((game) => !arriving.has(game.id))] });
    },
    /**
     * `updategame` is also how we hear that OUR table changed — that it
     * started, or that the server dropped our seat while the app was asleep in
     * the background. Updating only the list and leaving `currentGame` alone
     * (the old behaviour) made `currentGame.started` structurally false, and
     * left the pending screen drawing two occupied seats at a table we were no
     * longer seated at.
     *
     * `viewer` is the signed-in username. It is what tells a seat that has
     * gone from a table we are merely watching: a spectator was never in
     * `players`, and must not be thrown off the screen by that.
     */
    updateGames: (games, viewer) => {
        const { currentGame } = get();
        const next: Partial<LobbyState> = {
            games: get().games.map((existing) => {
                const updated = games.find((game) => game.id === existing.id);
                return updated ?? existing;
            })
        };
        const mine = currentGame && games.find((game) => game.id === currentGame.id);

        if (currentGame && mine) {
            const lostOurSeat =
                !!viewer && !!currentGame.players?.[viewer] && !mine.players?.[viewer];

            next.currentGame = lostOurSeat ? undefined : reconcilePendingGame(currentGame, mine);
        }

        set(next);
    },
    removeGames: (games) => {
        const { currentGame } = get();
        const removed = currentGame && games.find((game) => game.id === currentGame.id);
        const next: Partial<LobbyState> = {
            games: get().games.filter(
                (existing) => !games.some((game) => game.id === existing.id)
            )
        };
        if (currentGame && removed) {
            next.currentGame = undefined;

            // A table that has been PLAYED is retired by the same broadcast as
            // one nobody ever started: a tournament series removes the finished
            // table before opening the next game's (server/lobby.js
            // onTournamentNextGame). Calling that a timeout put a false error on
            // screen at the moment a game ended, and it then rode along to the
            // next table of the same match.
            if (!currentGame.started && !removed.started) {
                next.gameError = 'The game has timed out and is no longer available.';
            }
        }
        set(next);
    },
    // A gameerror belongs to the table it was raised at. Arriving at a
    // different one - the next game of a tournament series, say - must not
    // inherit it; being handed the same table again must not swallow it, since
    // the lobby answers a refused deck with `gameerror` and then pushes the
    // state back (server/lobby.js onSelectDeck).
    setCurrentGame: (game) =>
        set({
            currentGame: game,
            passwordError: undefined,
            ...(game && game.id !== get().currentGame?.id ? { gameError: undefined } : {})
        }),
    setUsers: (users) => set({ users }),
    setMotd: (motd) => set({ motd }),
    setBanner: (banner) => set({ banner }),
    setPasswordError: (error) => set({ passwordError: error }),
    setGameError: (error) => set({ gameError: error }),
    setMatchmaking: (matchmaking) => set({ matchmaking }),
    setChat: (chat) => set({ chat }),
    // Capped: the lobby has been talking since long before this session, and a
    // phone has no use for more scrollback than a person will read.
    addChatMessage: (message) => set({ chat: [...get().chat, message].slice(-200) }),
    setChatRefusal: (chatRefusal) => set({ chatRefusal }),
    setNotice: (notice) => set({ notice: { ...notice, id: (get().notice?.id ?? 0) + 1 } }),
    clearNotice: () => set({ notice: undefined }),
    reset: () =>
        set({
            status: 'disconnected',
            games: [],
            currentGame: undefined,
            users: [],
            passwordError: undefined,
            gameError: undefined,
            matchmaking: { status: 'idle' },
            chat: [],
            chatRefusal: undefined,
            notice: undefined
        })
}));
