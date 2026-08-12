import { apiFetch } from './client';
import type { ApiResponse } from './types';

/**
 * The native tournament engine, as the app talks to it. Mirrors
 * server/api/tournaments.js — reads are public (with the caller's own flags
 * filled in when authenticated), every mutation is a POST.
 */

export type TournamentStatus = 'registration' | 'active' | 'complete' | 'cancelled';
export type TournamentPacing = 'live' | 'async';

/** One row of the tournament list. */
export interface TournamentSummary {
    id: number;
    name: string;
    format: string;
    gameFormat?: string;
    mode?: string;
    status: TournamentStatus;
    stage?: string;
    currentRound?: number;
    roundCount?: number;
    startTime?: string;
    playerCap?: number;
    playerCount?: number;
    bestOf?: number;
    cutTo?: number;
    visibility?: string;
    rated?: boolean;
    pacing?: TournamentPacing;
    roundDeadlineDays?: number;
    roundEndsAt?: string;
    sasMin?: number | null;
    sasMax?: number | null;
    entryFeeCents?: number | null;
    prizeCurrency?: string;
    organizer?: string;
    [key: string]: unknown;
}

/** The event itself, from GET /api/tournaments/:id. */
export interface TournamentDetail extends TournamentSummary {
    description?: string;
    announcement?: string;
    seedMethod?: string;
    joinCode?: string;
    roundTimerMinutes?: number;
    roundStartedAt?: string;
    checkInOpen?: boolean;
    checkInCode?: string;
    allowPaperResults?: boolean;
    adaptiveBo3?: boolean;
    teamEvent?: boolean;
    teamSize?: number;
    requireDeckRegistration?: boolean;
    hideDecklists?: boolean;
    gameTimeLimit?: number;
    deckSwapPolicy?: string;
    allowedSets?: number[] | null;
    requiredHouses?: string[] | null;
    bannedHouses?: string[] | null;
    sasChainHandicap?: boolean;
    chainsPerMatchWin?: number;
    triad?: boolean;
    playoffBestOf?: number;
    prizeSplits?: unknown;
    prizeNote?: string;
    /** Flags for the caller — the server decides these, the app never infers them. */
    canManage?: boolean;
    isOrganizer?: boolean;
    isRegistered?: boolean;
    isWaitlisted?: boolean;
    isCheckedIn?: boolean;
    myDeckId?: number | null;
    canSwapDeck?: boolean;
}

export interface TournamentPlayer {
    userId: number;
    username: string;
    dropped?: boolean;
    seed?: number;
    checkedIn?: boolean;
    waitlisted?: boolean;
    finalRank?: number | null;
    amber?: number | null;
    eventChains?: number;
    deckId?: number;
    deckName?: string;
    deckSas?: number;
    hasDeck?: boolean;
    triadDecks?: { deckId: number; name?: string }[];
}

export interface TournamentMatch {
    id: number;
    round: number;
    table?: number;
    bracket?: string;
    bracketRound?: number;
    bracketPos?: number;
    player1Id?: number | null;
    player2Id?: number | null;
    player1?: string | null;
    player2?: string | null;
    winnerId?: number | null;
    player1Wins?: number;
    player2Wins?: number;
    bestOf?: number;
    resultType?: string;
    reportedBy?: number | null;
    /** False on a decided match means the opponent has not agreed yet. */
    confirmed?: boolean;
    disputedBy?: number | null;
    disputeNote?: string;
    scheduledAt?: string | null;
    proposedTime?: string | null;
    proposedBy?: number | null;
    scheduleNote?: string | null;
    p1BannedDeckId?: number | null;
    p2BannedDeckId?: number | null;
    p1DeckId?: number | null;
    p2DeckId?: number | null;
    games?: { gameNumber: number; gameId: string; winnerId?: number | null }[];
}

export interface StandingRow {
    id: number;
    username?: string;
    rank: number;
    wins?: number;
    losses?: number;
    draws?: number;
    points?: number;
    dropped?: boolean;
    finalRank?: number | null;
    [key: string]: unknown;
}

export interface TournamentDetailResult extends ApiResponse {
    tournament?: TournamentDetail;
    staff?: { userId: number; username: string; role: string }[];
    players?: TournamentPlayer[];
    matches?: TournamentMatch[];
    standings?: StandingRow[];
}

/**
 * An open match the caller owes, across every live event. `needsAction` is
 * decided server-side so every surface showing this list agrees about it.
 */
export interface OpenMatch {
    matchId: number;
    tournamentId: number;
    tournamentName: string;
    pacing?: TournamentPacing;
    mode?: string;
    round: number;
    bestOf?: number;
    opponentId?: number | null;
    opponent?: string | null;
    scheduledAt?: string | null;
    proposedTime?: string | null;
    proposedBy?: number | null;
    scheduleNote?: string | null;
    roundEndsAt?: string | null;
    needsAction: 'propose' | 'respond' | 'waiting' | 'play';
}

// ---- Reads ----

export async function fetchTournaments(status?: string) {
    const query = status ? `?status=${encodeURIComponent(status)}` : '';
    return apiFetch<ApiResponse & { tournaments?: TournamentSummary[] }>(
        `/api/tournaments${query}`
    );
}

export async function fetchTournament(id: number) {
    return apiFetch<TournamentDetailResult>(`/api/tournaments/${id}`);
}

export async function fetchMyMatches() {
    return apiFetch<ApiResponse & { matches?: OpenMatch[] }>('/api/tournaments/my-matches');
}

export async function fetchTournamentHistory(username: string) {
    return apiFetch<ApiResponse & { events?: unknown[] }>(
        `/api/tournaments/history/${encodeURIComponent(username)}`
    );
}

export async function fetchAdaptiveState(tournamentId: number, matchId: number) {
    return apiFetch<ApiResponse & { adaptive?: Record<string, unknown> }>(
        `/api/tournaments/${tournamentId}/matches/${matchId}/adaptive`
    );
}

// ---- Writes ----

function post<T extends ApiResponse = ApiResponse>(path: string, body?: unknown) {
    return apiFetch<T>(path, { method: 'POST', body: body ?? {} });
}

export function createTournament(details: Record<string, unknown>) {
    return post<ApiResponse & { tournamentId?: number; id?: number }>('/api/tournaments', details);
}

export function updateTournament(id: number, details: Record<string, unknown>) {
    return post(`/api/tournaments/${id}/update`, details);
}

export function registerForTournament(
    id: number,
    options: { joinCode?: string; deckId?: number | null; teamId?: number | null } = {}
) {
    return post(`/api/tournaments/${id}/register`, options);
}

export function registerTournamentDeck(id: number, deckId: number | null, userId?: number) {
    return post(`/api/tournaments/${id}/register-deck`, { deckId, userId });
}

export function registerTriadDecks(id: number, deckIds: number[]) {
    return post(`/api/tournaments/${id}/register-triad-decks`, { deckIds });
}

export function dropFromTournament(id: number, userId?: number) {
    return post(`/api/tournaments/${id}/drop`, { userId });
}

export function checkIn(id: number, userId?: number) {
    return post(`/api/tournaments/${id}/check-in`, { userId });
}

export function checkInByCode(code: string) {
    return post('/api/tournaments/check-in-by-code', { code });
}

export function openCheckIn(id: number) {
    return post(`/api/tournaments/${id}/open-check-in`);
}

export function startTournament(id: number, dropNoShows = false) {
    return post(`/api/tournaments/${id}/start`, { dropNoShows });
}

export function nextRound(id: number) {
    return post(`/api/tournaments/${id}/next-round`);
}

export function cutToPlayoff(id: number) {
    return post(`/api/tournaments/${id}/cut`);
}

export function resolveUnfinished(id: number, tieBreak?: string) {
    return post(`/api/tournaments/${id}/resolve-unfinished`, { tieBreak });
}

export function adjustRoundClock(id: number, minutes: number) {
    return post(`/api/tournaments/${id}/round-clock`, { minutes });
}

export function finishTournament(id: number, force = false) {
    return post(`/api/tournaments/${id}/finish`, { force });
}

export function cancelTournament(id: number) {
    return post(`/api/tournaments/${id}/cancel`);
}

export function addStaff(id: number, username: string) {
    return post(`/api/tournaments/${id}/staff/add`, { username });
}

export function removeStaff(id: number, userId: number) {
    return post(`/api/tournaments/${id}/staff/remove`, { userId });
}

// ---- Match actions ----

export function reportResult(
    id: number,
    matchId: number,
    winnerId: number,
    scores: { player1Wins?: number; player2Wins?: number; source?: string } = {}
) {
    return post(`/api/tournaments/${id}/matches/${matchId}/result`, { winnerId, ...scores });
}

export function confirmResult(id: number, matchId: number) {
    return post(`/api/tournaments/${id}/matches/${matchId}/confirm`);
}

export function disputeResult(id: number, matchId: number, note?: string) {
    return post(`/api/tournaments/${id}/matches/${matchId}/dispute`, { note });
}

export function awardWin(id: number, matchId: number, winnerId: number, resultType = 'forfeit') {
    return post(`/api/tournaments/${id}/matches/${matchId}/award`, { winnerId, resultType });
}

export function doubleLoss(id: number, matchId: number) {
    return post(`/api/tournaments/${id}/matches/${matchId}/double-loss`);
}

/** Opens (or re-opens) the lobby table for a match and returns its game id. */
export function openMatchGame(id: number, matchId: number) {
    return post<ApiResponse & { gameId?: string }>(
        `/api/tournaments/${id}/matches/${matchId}/open-game`
    );
}

export function proposeMatchTime(id: number, matchId: number, time: string, note?: string) {
    return post(`/api/tournaments/${id}/matches/${matchId}/propose-time`, { time, note });
}

export function acceptMatchTime(id: number, matchId: number) {
    return post(`/api/tournaments/${id}/matches/${matchId}/accept-time`);
}

export function clearMatchTime(id: number, matchId: number) {
    return post(`/api/tournaments/${id}/matches/${matchId}/clear-time`);
}

export function triadBan(id: number, matchId: number, deckId: number) {
    return post(`/api/tournaments/${id}/matches/${matchId}/triad-ban`, { deckId });
}

export function triadPick(id: number, matchId: number, deckId: number) {
    return post(`/api/tournaments/${id}/matches/${matchId}/triad-pick`, { deckId });
}

export function adaptiveBid(id: number, matchId: number, chains: number) {
    return post(`/api/tournaments/${id}/matches/${matchId}/adaptive-bid`, { chains });
}

export function adaptivePass(id: number, matchId: number) {
    return post(`/api/tournaments/${id}/matches/${matchId}/adaptive-pass`);
}
