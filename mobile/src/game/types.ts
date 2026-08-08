import type { ChatMessage } from '../api/types';

/** Card summary as serialized by the game engine (server/game/Card.js). */
export interface CardSummary {
    uuid: string;
    id?: string;
    image?: string;
    name?: string;
    label?: string;
    type?: string;
    printedHouse?: string;
    maverick?: string;
    anomaly?: string;
    enhancements?: string[];
    facedown?: boolean;
    exhausted?: boolean;
    stunned?: boolean;
    taunt?: boolean;
    gigantic?: boolean;
    isToken?: boolean;
    /**
     * For a token creature, the real deck card sitting under the token. Only
     * sent to the card's controller (server/game/Card.js getSummary).
     */
    versusCard?: CardSummary;
    canPlay?: boolean;
    controlled?: boolean;
    new?: boolean;
    location?: string;
    cardback?: string;
    cardPrintedAmber?: number;
    powerPrinted?: number;
    armorPrinted?: number;
    modifiedPower?: number;
    tokens?: Record<string, number>;
    upgrades?: CardSummary[];
    childCards?: CardSummary[];
    menu?: CardMenuItem[];
    selected?: boolean;
    selectable?: boolean;
    unselectable?: boolean;
    pseudoDamage?: number;
    wardBroken?: boolean;
    canPlayHouse?: boolean;
    activeProphecy?: boolean;
    canActivateProphecy?: boolean;
    [key: string]: unknown;
}

export interface CardMenuItem {
    command?: string;
    method?: string;
    text?: string;
    menu?: string;
    anyPlayer?: boolean;
    [key: string]: unknown;
}

export interface PromptButton {
    command?: string;
    text?: string | { text?: string; values?: Record<string, unknown> };
    arg?: unknown;
    uuid?: string;
    method?: string;
    disabled?: boolean;
    icon?: string;
    /** Serialized short summary of the card this button plays/uses. */
    card?: CardSummary;
    /** i18n interpolation values for `{{key}}` placeholders in `text`. */
    values?: Record<string, unknown>;
    [key: string]: unknown;
}

export interface PromptControl {
    type: string;
    /** Short summary of the card whose effect is being resolved. */
    source?: CardSummary;
    /** Short summaries of the cards the effect is aimed at. */
    targets?: CardSummary[];
    [key: string]: unknown;
}

export interface PlayerStats {
    amber: number;
    chains: number;
    keys: { red: boolean; blue: boolean; yellow: boolean };
    houses?: string[];
    keyCost: number;
    tide?: string;
    tideRequired?: boolean;
}

export interface CardPiles {
    archives: CardSummary[];
    cardsInPlay: CardSummary[];
    discard: CardSummary[];
    hand: CardSummary[];
    purged: CardSummary[];
    deck?: CardSummary[];
}

export interface PlayerState {
    name: string;
    id?: string;
    activeHouse?: string;
    activePlayer?: boolean;
    cardPiles: CardPiles;
    cardback?: string;
    canRaiseTide?: boolean;
    disconnected?: boolean;
    houses?: string[];
    inactive?: boolean;
    left?: boolean;
    numDeckCards: number;
    numArchivesCards?: number;
    optionSettings?: Record<string, boolean>;
    phase?: string;
    stats: PlayerStats;
    deckData?: { cardback?: string; [key: string]: unknown };
    deckTopCard?: CardSummary;
    tokenCard?: CardSummary;
    prophecyCards?: CardSummary[];
    user?: { id?: string; username?: string; avatar?: string; [key: string]: unknown };
    wins?: number;
    clock?: { mode?: string; timeLeft?: number; [key: string]: unknown };
    // Prompt state (only present for the player themselves)
    selectCard?: boolean;
    selectOrder?: boolean;
    menuTitle?: string | { text?: string; values?: Record<string, unknown> };
    promptTitle?: string | { text?: string; values?: Record<string, unknown> };
    buttons?: PromptButton[];
    controls?: PromptControl[];
    promptedPiles?: string[];
    [key: string]: unknown;
}

/**
 * A lasting effect aimed at a player rather than a card, summarized by the
 * engine (server/game/effectengine.js getPlayerEffectSummary).
 */
export interface PlayerEffectSummary {
    source?: CardSummary;
    /** Raw engine duration, e.g. 'duringOpponentNextTurn'. */
    duration?: string;
    effectType?: string;
    /** Player who applied it. */
    controller?: string;
    /** Players it constrains. */
    targets?: string[];
    /** Declared but not yet in force (starts on the opponent's next turn). */
    pending?: boolean;
}

/** Root in-game state as sent by the game node (server/game/game.js getState). */
export interface GameState {
    id: string;
    name: string;
    started: boolean;
    owner?: string | { username?: string };
    players: Record<string, PlayerState>;
    messages: ChatMessage[];
    effects?: PlayerEffectSummary[];
    spectators?: { id?: string; name: string }[];
    winner?: string;
    cancelPromptUsed?: boolean;
    forcePassAvailable?: boolean;
    gameFormat?: string;
    gamePrivate?: boolean;
    gameTimeLimitStarted?: boolean;
    gameTimeLimitStartedAt?: number | string;
    gameTimeLimitTime?: number;
    hideDeckLists?: boolean;
    manualMode?: boolean;
    muteSpectators?: boolean;
    previousWinner?: string;
    showHand?: boolean;
    useGameTimeLimit?: boolean;
    adaptive?: unknown;
    swap?: boolean;
    [key: string]: unknown;
}
