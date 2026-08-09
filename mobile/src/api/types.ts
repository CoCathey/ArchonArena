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

/**
 * Card dictionary entry from GET /api/cards (short form). Keyed by the card
 * id slug; used to give deck lists names/types, since deck cards from the
 * API only carry ids.
 */
export interface ShortCard {
    id: string;
    name: string;
    type?: string;
    house?: string;
    rarity?: string;
    number?: number | string;
    image?: string;
    amber?: number;
    traits?: string[];
    locale?: Record<string, { name?: string }>;
    [key: string]: unknown;
}

export interface DeckCard {
    count: number;
    id: string;
    dbId?: number;
    house?: string;
    image?: string;
    maverick?: string;
    anomaly?: string;
    enhancements?: string[];
    isNonDeck?: boolean;
    prophecyId?: number;
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
    isAlliance?: boolean;
    wins?: number;
    losses?: number;
    winRate?: number;
    usageLevel?: number;
    lastUpdated?: string;
    /**
     * Decks of KeyForge stats, attached by the server (DokService.attachStats).
     * Flat fields — there is no nested stats object on the wire.
     */
    sasRating?: number;
    aercScore?: number;
    [key: string]: unknown;
}

/** One AERC component of a deck's SAS score, from GET /api/decks/:id. */
export interface AercComponent {
    key: string;
    label: string;
    value: number;
}

export interface AercBreakdown {
    sasRating?: number;
    aercScore?: number;
    aercVersion?: string;
    fetchedAt?: string;
    components?: AercComponent[];
    sasPercentile?: number | null;
    synergyRating?: number | null;
    antisynergyRating?: number | null;
}

/** Game summary shown in the lobby game list / pending game screen. */
export interface GamePlayerSummary {
    name: string;
    emailHash?: string;
    owner?: boolean;
    left?: boolean;
    wins?: number;
    deck?: { name?: string; selected?: boolean; status?: unknown; sasRating?: number };
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
    /** Both players are dealt a random deck when the owner starts the game. */
    luckyDice?: boolean;
    /** Only decks whose SAS sits in this range may be played. */
    sasBound?: { min: number; max: number };
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

// ---- Friends (server/services/community/FriendService.js) ----

export interface Friend {
    userId: number;
    username: string;
}

/**
 * GET /api/friends. `incoming` are requests waiting on the caller, `outgoing`
 * are the ones the caller has sent — in both cases `userId` is the other
 * person, which is what the respond/remove endpoints take.
 */
export interface FriendsResult extends ApiResponse {
    friends?: Friend[];
    incoming?: Friend[];
    outgoing?: Friend[];
}

export interface LobbyUserSummary {
    name: string;
    avatar?: string;
    role?: string;
    [key: string]: unknown;
}

// ---- Rankings / stats / match history (server/api/ratings.js, stats.js, games.js) ----

export interface LeaderboardEntry {
    rank: number;
    username: string;
    country?: string | null;
    state?: string | null;
    avatar?: string | null;
    rating: number;
    gamesPlayed: number;
    provisional?: boolean;
    wins?: number;
    losses?: number;
}

export interface LeaderboardResult extends ApiResponse {
    pool?: string;
    scope?: string;
    entries?: LeaderboardEntry[];
    regions?: string[];
}

/** One pool's rating summary for a player, from GET /api/ratings/:username. */
export interface PlayerRating {
    pool: string;
    rating: number;
    gamesPlayed: number;
    provisional?: boolean;
    rank?: number;
    totalRated?: number;
    wins?: number;
    losses?: number;
}

export interface PlayerRatingsResult extends ApiResponse {
    ratings?: PlayerRating[];
}

export interface PlayerStatsResult extends ApiResponse {
    stats?: {
        username: string;
        overall?: {
            games: number;
            wins: number;
            losses: number;
            winRate?: number;
            avgKeys?: number;
            avgDurationSec?: number;
        };
        formats?: {
            format: string;
            games: number;
            wins: number;
            losses: number;
            winRate?: number;
        }[];
        houses?: { house: string; games: number; wins: number; winRate?: number }[];
    };
}

// ---- Meta / deck statistics (server/services/StatisticsService.js) ----

/** A win-rate slice — one house, set, format or SAS band. */
export interface MetaSlice {
    games: number;
    wins?: number;
    /** Percent, or null when there are too few games to be meaningful. */
    winRate?: number | null;
}

export interface MetaStats {
    generatedAt?: string;
    totals?: {
        finishedGames: number;
        decidedGames: number;
        avgDurationSec?: number | null;
        avgKeys?: number | null;
    };
    houses?: (MetaSlice & { house: string })[];
    /** Share is a percentage of all finished games. */
    formats?: { format: string; games: number; share?: number | null }[];
    sasBands?: (MetaSlice & { band: string })[];
    sets?: (MetaSlice & { set: string; expansionId?: number | null })[];
    houseMatchups?: {
        houses: string[];
        cells: Record<string, MetaSlice & { house: string; opponent: string }>;
        minGames: number;
    };
}

export interface MetaStatsResult extends ApiResponse {
    stats?: MetaStats;
}

/** One of the caller's decks, with how it did against what its SAS predicted. */
export interface DeckPerformance {
    deckId: number | string;
    name: string;
    identity?: string;
    sasRating?: number | null;
    sasBand?: string | null;
    games: number;
    wins: number;
    losses: number;
    winRate?: number | null;
    expectedWinRate?: number | null;
    /** Percentage points above (positive) or below what the SAS band achieves. */
    sasDelta?: number | null;
    lastPlayed?: string | null;
}

export interface HouseMatchup {
    opponentHouse: string;
    games: number;
    wins: number;
    losses: number;
    winRate?: number | null;
}

export interface DeckStatsResult extends ApiResponse {
    stats?: {
        username: string;
        decks?: DeckPerformance[];
        matchups?: HouseMatchup[];
        bestMatchup?: HouseMatchup | null;
        worstMatchup?: HouseMatchup | null;
        bestDeck?: DeckPerformance | null;
        worstDeck?: DeckPerformance | null;
        calloutMinGames?: number;
    };
}

/** A finished game from GET /api/games — players[0] is always the caller. */
export interface PastGame {
    gameId: string;
    gameFormat?: string;
    startedAt?: string;
    finishedAt?: string;
    winReason?: string;
    winner?: string | null;
    players: {
        name: string;
        deck?: string | null;
        keys?: number | Record<string, boolean> | null;
    }[];
    decks?: { name?: string | null; identity?: string | null }[];
}

export interface MatchHistoryResult extends ApiResponse {
    games?: PastGame[];
}

export interface GameRatingResult extends ApiResponse {
    rated?: boolean;
    pool?: string;
    players?: {
        username: string;
        opponent?: string;
        won?: boolean;
        ratingBefore?: number;
        ratingAfter?: number;
        change?: number;
        provisional?: boolean;
        [key: string]: unknown;
    }[];
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
    /** Deal both players a random deck when the game starts. */
    luckyDice?: boolean;
    /** Restrict playable decks to this SAS range. */
    sasBound?: { min: number; max: number };
    expansions: Record<string, boolean>;
    [key: string]: unknown;
}
