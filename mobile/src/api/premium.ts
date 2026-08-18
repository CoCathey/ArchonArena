import { apiFetch } from './client';
import type { ApiResponse } from './types';

/**
 * ARCHON (N12/N18): the Archon+ tools the app carried no surface for.
 *
 * The Intelligence screen already covers rating history, the performance
 * dashboard, deck rankings, matchups and the meta. Three things it never
 * carried: side-by-side deck comparison (Archon), AERC analytics (Archon), and
 * the Champion's Challenge (Vault Master) — so a member paying the top tier on
 * their phone had one of its headline features only in a browser.
 *
 * Every endpoint here carries `requireCapability` server-side. A patched build
 * can unhide a panel; it cannot make one of these answer.
 */

// ---- Deck comparison ----

export interface ComparedDeck {
    deckId: number;
    deckName: string;
    uuid?: string;
    sas?: number;
    set?: { id?: number; label?: string } | null;
    overview: {
        games: number;
        wins: number;
        losses: number;
        winRate?: number | null;
        [key: string]: unknown;
    };
    /** False when the sample is too thin to lean on — the server decides. */
    confident?: boolean;
    [key: string]: unknown;
}

export interface DeckComparisonResult extends ApiResponse {
    decks?: ComparedDeck[];
    minConfidentGames?: number;
}

/** Two to four of the caller's own decks, side by side on their real record. */
export async function fetchDeckComparison(deckIds: number[]) {
    return apiFetch<DeckComparisonResult>(
        `/api/intelligence/deck-comparison?decks=${deckIds.join(',')}`
    );
}

// ---- AERC analytics ----

export interface AercTrait {
    key: string;
    label: string;
    short: string;
}

export interface AercBand {
    band: string;
    from?: number | null;
    to?: number | null;
    games: number;
    wins: number;
    losses: number;
    winRate?: number | null;
    confident?: boolean;
}

export interface AercFinding {
    side: 'own' | 'opponent' | string;
    trait: string;
    label: string;
    short: string;
    gap: number;
    best: AercBand;
    worst: AercBand;
    games: number;
}

export interface AercAnalyticsResult extends ApiResponse {
    trait?: string;
    traits?: AercTrait[];
    minConfidentGames?: number;
    /** Your record split by a trait of YOUR deck: which kind you play well. */
    own?: { trait: string; bands: AercBand[] } | null;
    /** The same split by the OPPONENT's deck: which kind beats you. */
    opponent?: { trait: string; bands: AercBand[] } | null;
    houses?: unknown;
    findings?: AercFinding[];
    meta?: unknown;
    cards?: unknown;
}

export async function fetchAercAnalytics(trait: string, options: { days?: number } = {}) {
    const params = new URLSearchParams();
    params.set('trait', trait);
    params.set('days', String(options.days ?? 30));

    return apiFetch<AercAnalyticsResult>(`/api/intelligence/aerc?${params.toString()}`);
}

// ---- Champion's Challenge (N18) ----

export interface ChallengeDeck {
    deckId: number;
    name: string;
    sas?: number;
    games: number;
    wins: number;
    losses: number;
    winRate?: number | null;
    expectedWinRate?: number | null;
    delta?: number | null;
    ari?: number | null;
    confident?: boolean;
    avgTurns?: number | null;
    avgKeysFor?: number | null;
    avgKeysAgainst?: number | null;
    firstPlayerWinRate?: number | null;
    secondPlayerWinRate?: number | null;
    bestOpening?: { house: string; games: number; winRate: number } | null;
    hiddenGem?: boolean;
    random?: boolean;
    lastPlayedAt?: string;
    [key: string]: unknown;
}

export interface ChallengeCandidate {
    deckId: number;
    name: string;
    sas?: number;
}

export interface ChallengeFinding {
    text?: string;
    [key: string]: unknown;
}

export interface ChallengeReport extends ApiResponse {
    running?: boolean;
    maxEnrolled?: number;
    gamesPerDeckPerDay?: number;
    unlimited?: boolean;
    minConfidentGames?: number;
    totals?: { games: number; today: number };
    candidates?: ChallengeCandidate[];
    decks?: ChallengeDeck[];
    findings?: ChallengeFinding[];
    calibration?: unknown;
}

/**
 * The member's own lab. Strictly their own: there is no route that reads
 * another member's, because simulated results are a private analysis of your
 * own decks.
 */
export async function fetchChallengeReport() {
    return apiFetch<ChallengeReport>('/api/champions-challenge');
}

export async function enrollChallengeDeck(deckId: number) {
    return apiFetch<ApiResponse>('/api/champions-challenge/decks', {
        method: 'POST',
        body: { deckId }
    });
}

export async function withdrawChallengeDeck(deckId: number) {
    return apiFetch<ApiResponse>(`/api/champions-challenge/decks/${deckId}`, {
        method: 'DELETE'
    });
}

/**
 * Fill free slots with random eligible decks. `count` is clamped to the slots
 * actually free rather than refused — "add 5" with 3 free plainly means "add
 * what fits".
 */
export async function addRandomChallengeDecks(count = 1) {
    return apiFetch<ApiResponse & { added?: number }>('/api/champions-challenge/decks/random', {
        method: 'POST',
        body: { count }
    });
}
