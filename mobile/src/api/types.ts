/** Shapes returned by the ArchonArena lobby REST API and sockets. */

export interface UserDetails {
    id: string;
    username: string;
    email?: string;
    emailHash?: string;
    settings?: Record<string, unknown>;
    permissions?: Record<string, boolean>;
    role?: string;
    avatar?: string;
    [key: string]: unknown;
}

/** Opaque refresh-token object returned by /api/account/login. */
export interface RefreshToken {
    id: string;
    username: string;
    token?: string;
    [key: string]: unknown;
}

export interface LoginResponse {
    success: boolean;
    message?: string;
    user?: UserDetails;
    token?: string;
    refreshToken?: RefreshToken;
}

export interface ApiResponse {
    success: boolean;
    message?: string;
    [key: string]: unknown;
}

export interface DeckCard {
    count: number;
    id: string;
    card?: {
        id: string;
        name: string;
        image?: string;
        house?: string;
        type?: string;
        [key: string]: unknown;
    };
    [key: string]: unknown;
}

export interface Deck {
    id: number | string;
    name: string;
    uuid?: string;
    identity?: string;
    expansion?: number;
    houses?: string[];
    cards?: DeckCard[];
    verified?: boolean;
    wins?: number;
    losses?: number;
    winRate?: number;
    usageLevel?: number;
    lastUpdated?: string;
    dokStats?: {
        sas?: number;
        aercScore?: number;
        sasPercentile?: number;
        [key: string]: unknown;
    } | null;
    [key: string]: unknown;
}

/** Game summary shown in the lobby game list / pending game screen. */
export interface GamePlayerSummary {
    name: string;
    emailHash?: string;
    owner?: boolean;
    left?: boolean;
    wins?: number;
    deck?: { name?: string; selected?: boolean; status?: unknown };
    user?: unknown;
    [key: string]: unknown;
}

export interface GameSummary {
    id: string;
    name: string;
    owner: string | { username?: string };
    started?: boolean;
    allowSpectators?: boolean;
    gameFormat?: string;
    gamePrivate?: boolean;
    needsPassword?: boolean;
    showHand?: boolean;
    useGameTimeLimit?: boolean;
    gameTimeLimit?: number;
    adaptive?: boolean;
    createdAt?: string;
    players: Record<string, GamePlayerSummary>;
    spectators?: { id?: string; name: string }[];
    messages?: ChatMessage[];
    node?: string;
    [key: string]: unknown;
}

export interface ChatMessage {
    date?: string;
    message: MessageFragment | MessageFragment[];
    [key: string]: unknown;
}

/**
 * A game-log fragment: plain text, a player/card reference, an alert wrapper,
 * or an i18n-style interpolation object.
 */
export type MessageFragment =
    | string
    | number
    | MessageFragment[]
    | {
          alert?: { type: string; message: MessageFragment | MessageFragment[] };
          message?: MessageFragment | MessageFragment[];
          name?: string;
          label?: string;
          argType?: string;
          image?: string;
          id?: string;
          code?: string;
          [key: string]: unknown;
      }
    | null
    | undefined;

export interface HandoffMessage {
    address?: string;
    authToken: string;
    gameId: string;
    name: string;
    port?: number;
    protocol?: string;
    user: UserDetails;
}

export interface LobbyUserSummary {
    name: string;
    avatar?: string;
    role?: string;
    [key: string]: unknown;
}

export interface NewGameRequest {
    name: string;
    password?: string;
    allowSpectators: boolean;
    gameFormat: string;
    gamePrivate?: boolean;
    hideDeckLists?: boolean;
    showHand?: boolean;
    muteSpectators?: boolean;
    useGameTimeLimit?: boolean;
    gameTimeLimit?: number;
    quickJoin?: boolean;
    expansions: Record<string, boolean>;
    [key: string]: unknown;
}
