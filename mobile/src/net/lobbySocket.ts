import { io, Socket } from 'socket.io-client';
import { refreshAuthToken } from '../api/client';
import type { DirectMessage } from '../api/messages';
import type {
    GameSummary,
    HandoffMessage,
    LobbyMessage,
    LobbyNotice,
    NewGameRequest
} from '../api/types';
import { useAuthStore } from '../stores/authStore';
import { useGameStore } from '../stores/gameStore';
import { useLobbyStore, type MatchmakingState } from '../stores/lobbyStore';
import { useMessagesStore, otherPartyOf } from '../stores/messagesStore';
import { useSettingsStore } from '../stores/settingsStore';
import { connectToGame } from './gameSocket';

const CLIENT_VERSION = 'archon-arena-mobile';

let socket: Socket | undefined;

export function getLobbySocket(): Socket | undefined {
    return socket;
}

/**
 * Connect (or reuse) the lobby socket. Safe to call repeatedly — an existing
 * live connection is kept.
 */
export async function connectLobby(): Promise<void> {
    const lobby = useLobbyStore.getState();

    if (socket) {
        if (socket.connected) {
            return;
        }
        socket.connect();
        return;
    }

    // Make sure we hold a fresh JWT before the handshake; the server auths the
    // socket from auth.token at connect time.
    if (!useAuthStore.getState().token) {
        await refreshAuthToken();
    }

    const serverUrl = useSettingsStore.getState().serverUrl;
    lobby.setStatus('connecting');

    socket = io(serverUrl, {
        reconnection: true,
        reconnectionDelay: 1000,
        reconnectionDelayMax: 5000,
        reconnectionAttempts: Infinity,
        transports: ['websocket'],
        auth: (cb) => {
            cb({
                token: useAuthStore.getState().token || undefined,
                version: CLIENT_VERSION
            });
        }
    });

    socket.on('connect', () => {
        useLobbyStore.getState().setStatus('connected');
    });

    socket.on('disconnect', () => {
        useLobbyStore.getState().setStatus('disconnected');
    });

    socket.io.on('reconnect_attempt', () => {
        useLobbyStore.getState().setStatus('connecting');
    });

    socket.on('authfailed', async () => {
        const token = await refreshAuthToken();
        if (token && socket) {
            socket.emit('authenticate', token);
        }
    });

    socket.on('games', (games: GameSummary[]) => {
        useLobbyStore.getState().setGames(games ?? []);
    });

    socket.on('newgame', (games: GameSummary[]) => {
        useLobbyStore.getState().addGames(games ?? []);
    });

    socket.on('updategame', (games: GameSummary[]) => {
        // Named, because the update is also how we learn our own seat is gone
        // — and a spectator, who never had one, must not be treated the same.
        useLobbyStore.getState().updateGames(games ?? [], useAuthStore.getState().user?.username);
    });

    socket.on('removegame', (games: GameSummary[]) => {
        useLobbyStore.getState().removeGames(games ?? []);
    });

    socket.on('users', (users: { name: string; avatar?: string }[]) => {
        useLobbyStore.getState().setUsers(users ?? []);
    });

    socket.on('gamestate', (game: GameSummary) => {
        useLobbyStore.getState().setCurrentGame(game ?? undefined);
    });

    socket.on('cleargamestate', () => {
        useLobbyStore.getState().setCurrentGame(undefined);
    });

    socket.on('passworderror', (message: string) => {
        useLobbyStore.getState().setPasswordError(message);
    });

    socket.on('gameerror', (message: string) => {
        useLobbyStore.getState().setGameError(message);
    });

    socket.on('matchmaking', (state: MatchmakingState) => {
        const store = useLobbyStore.getState();
        store.setMatchmaking(state ?? { status: 'idle' });

        // A match hands the pair a pending game the normal way (`gamestate`),
        // so there is nothing to navigate to from here — the queue simply
        // stops. Leaving it on 'matched' would keep a dead panel on screen
        // behind the pending screen the player has just been given.
        if (state?.status === 'matched') {
            store.setMatchmaking({ status: 'idle' });
        }
    });

    socket.on('lobbymessages', (messages: LobbyMessage[]) => {
        useLobbyStore.getState().setChat(Array.isArray(messages) ? messages : []);
    });

    socket.on('lobbychat', (message: LobbyMessage) => {
        useLobbyStore.getState().addChatMessage(message);
    });

    socket.on('nochat', (details?: { message?: string }) => {
        useLobbyStore
            .getState()
            .setChatRefusal(
                details?.message ??
                    'New accounts cannot use lobby chat yet. Play a few games first.'
            );
    });

    socket.on('banner', (notice: string) => {
        useLobbyStore.getState().setBanner(notice);
    });

    /**
     * ARCHON: the lobby's only way of saying something to one named player
     * wherever they are (server/lobby.js `notifyPlayers`).
     *
     * Everything else the lobby says privately — 'gameerror', 'passworderror'
     * — renders inside a pending table, and the players these notices are for
     * have just been cleared out of one: "that game decided your match", "your
     * last result is still being recorded", "join your table from the event
     * page". Dropping them, which is what the app did until now, is exactly
     * the button-did-nothing complaint this work exists to end.
     *
     * The store holds it and LobbyNotices, mounted at the root, says it.
     */
    socket.on('lobbynotice', (notice: LobbyNotice) => {
        if (notice?.message) {
            useLobbyStore.getState().setNotice(notice);
        }
    });

    /**
     * ARCHON: a direct message for (or from) this player arrived live.
     *
     * The lobby sends it to both ends, so a message sent from a browser shows
     * up in the thread open on the phone. One that is not already on screen
     * becomes a notice, which is how a message reaches somebody sitting on the
     * game list — the same choice the web client makes, and the same route the
     * push notification for it opens.
     */
    socket.on('directmessage', (message: DirectMessage) => {
        const me = useAuthStore.getState().user?.username;
        const messages = useMessagesStore.getState();
        const other = otherPartyOf(message, me);

        messages.receive(message, me);

        if (!other || !me || message.senderUsername === me) {
            return;
        }

        if (messages.viewing?.toLowerCase() === other.toLowerCase()) {
            return;
        }

        const text = String(message.text ?? '');
        const excerpt = text.length > 120 ? `${text.slice(0, 117)}...` : text;

        useLobbyStore.getState().setNotice({
            tone: 'info',
            message: `${message.senderUsername}: ${excerpt}`,
            url: `/messages/${encodeURIComponent(message.senderUsername ?? '')}`
        });
    });

    socket.on('motd', (motd: { message?: string }) => {
        useLobbyStore.getState().setMotd(motd);
    });

    socket.on('handoff', (handoff: HandoffMessage) => {
        const gameStore = useGameStore.getState();

        // The handoff carries a fresh game-node JWT; adopt it for future
        // requests too (it is a normal user JWT).
        useAuthStore.getState().setAuth({ token: handoff.authToken, user: handoff.user });

        gameStore.setHandoff(handoff);
        connectToGame(handoff);
    });
}

export function disconnectLobby(): void {
    if (socket) {
        socket.removeAllListeners();
        socket.disconnect();
        socket = undefined;
    }
    useLobbyStore.getState().reset();
}

function emit(message: string, ...args: unknown[]): void {
    if (socket) {
        socket.emit(message, ...args);
    }
}

export const lobby = {
    newGame(details: NewGameRequest): void {
        useLobbyStore.getState().setGameError(undefined);
        emit('newgame', details);
    },
    joinGame(gameId: string, password?: string): void {
        useLobbyStore.getState().setPasswordError(undefined);
        emit('joingame', gameId, password);
    },
    watchGame(gameId: string, password?: string): void {
        useLobbyStore.getState().setPasswordError(undefined);
        emit('watchgame', gameId, password);
    },
    leaveGame(gameId: string): void {
        emit('leavegame', gameId);
        useLobbyStore.getState().setCurrentGame(undefined);
    },
    startGame(gameId: string): void {
        emit('startgame', gameId);
    },
    selectDeck(gameId: string, deckId: string | number, isStandalone: boolean): void {
        emit('selectdeck', gameId, deckId, isStandalone);
    },
    /**
     * Ask the lobby to deal this player a sealed deck. Sealed games have no
     * deck choice — the server builds one from the game's allowed sets and
     * assigns it — so the pending screen requests it on arrival.
     */
    getSealedDeck(gameId: string): void {
        emit('getsealeddeck', gameId);
    },
    /**
     * Lucky Dice: let the server pick a random deck. It rolls over the whole
     * collection — which the app only ever holds a page of — and applies the
     * game's own rules (alliance, SAS bound) to the roll.
     */
    selectRandomDeck(gameId: string): void {
        useLobbyStore.getState().setGameError(undefined);
        emit('selectrandomdeck', gameId);
    },
    pendingChat(message: string): void {
        emit('chat', message);
    },
    /**
     * Site-wide lobby chat. The server answers a refused message with
     * `nochat` rather than an error, so nothing here throws.
     */
    lobbyChat(message: string): void {
        useLobbyStore.getState().setChatRefusal(undefined);
        emit('lobbychat', message);
    },
    /**
     * Quick Match: join the queue for a format and let the lobby pair you
     * with someone of similar Amber. Distinct from the `quickJoin` flag on
     * newGame, which only takes the first open table it can find.
     */
    joinQueue(gameFormat: string): void {
        useLobbyStore.getState().setMatchmaking({ status: 'searching', format: gameFormat });
        emit('joinqueue', { gameFormat });
    },
    leaveQueue(): void {
        useLobbyStore.getState().setMatchmaking({ status: 'idle' });
        emit('leavequeue');
    },
    /** Practice tables: what the bot brings, and how it plays. */
    setBotDifficulty(gameId: string, difficulty: string): void {
        emit('botdifficulty', gameId, difficulty);
    },
    selectBotStyle(gameId: string, styleKey: string): void {
        emit('selectbotstyle', gameId, styleKey);
    },
    removeGame(gameId: string): void {
        emit('removegame', gameId);
    },
    connectFailed(): void {
        emit('connectfailed');
    }
};
