import { apiFetch, rawApiFetch } from './client';
import type { ApiResponse } from './types';

/**
 * ARCHON: the community half of the platform, which the app has never had.
 *
 * Public player profiles, the player directory, clubs (the Grand Alliance
 * Council), teams, the season archive and the badges that go next to a name
 * were all website-only — the phone could see numbers about people and never
 * the people. Every endpoint here is one the website already calls, so a club
 * joined on a phone is the same membership as one joined in a browser.
 *
 * Reads are unauthenticated where the server allows it (profiles, the
 * directory, club and team lists), because the same pages are public on the
 * site and a signed-out app should not be a worse citizen than a browser.
 */

// ---- Badges (N12) ----

/**
 * What goes next to a name: staff role, paid tier, and the cosmetics a member
 * has bought. Fields are omitted rather than sent empty — an account with
 * nothing to say is absent from the response entirely.
 */
export interface PlayerBadgeData {
    role?: string;
    tier?: string;
    tierName?: string | null;
    isBot?: boolean;
    isNew?: boolean;
    cosmetics?: Record<string, unknown>;
}

export interface BadgesResult extends ApiResponse {
    badges?: Record<string, PlayerBadgeData>;
}

/**
 * Badges for a page of names, in one request. Public, and deliberately
 * failure-tolerant on the server: a list with no badges is a list that still
 * works, so nothing here should ever be awaited before rendering names.
 */
export async function fetchBadges(usernames: string[]) {
    const wanted = [...new Set(usernames.filter(Boolean))].slice(0, 100);
    if (wanted.length === 0) {
        return { success: true, badges: {} } as BadgesResult;
    }

    return rawApiFetch<BadgesResult>(
        `/api/membership/badges?usernames=${encodeURIComponent(wanted.join(','))}`
    );
}

// ---- Public player profile ----

export interface ProfileClub {
    id: number;
    name: string;
    role?: string;
}

export interface ProfileGame {
    gameId?: string;
    finishedAt?: string;
    won?: boolean;
    keys?: number;
    opponentKeys?: number;
    opponent?: string;
    deckName?: string;
}

export interface PlayerProfile {
    username: string;
    avatar?: string;
    country?: string;
    state?: string;
    bio?: string | null;
    joined?: string;
    role?: string;
    tier?: string;
    tierName?: string | null;
    cosmetics?: Record<string, unknown>;
    clubs?: ProfileClub[];
    recentGames?: ProfileGame[];
}

export interface PlayerProfileResult extends ApiResponse {
    profile?: PlayerProfile;
}

export async function fetchPlayerProfile(username: string) {
    return rawApiFetch<PlayerProfileResult>(
        `/api/players/${encodeURIComponent(username)}`
    );
}

// ---- Member directory ----

export interface DirectoryMember {
    username: string;
    country?: string;
    state?: string;
    joined?: string;
    rating?: number;
    gamesPlayed?: number;
}

export interface MembersResult extends ApiResponse {
    members?: DirectoryMember[];
    stats?: { total?: number; active?: number; [key: string]: unknown };
}

export async function fetchMembers(
    options: { query?: string; country?: string; limit?: number; offset?: number } = {}
) {
    const params = new URLSearchParams();
    if (options.query) {
        params.set('query', options.query);
    }
    if (options.country) {
        params.set('country', options.country);
    }
    params.set('limit', String(options.limit ?? 50));
    params.set('offset', String(options.offset ?? 0));

    return rawApiFetch<MembersResult>(`/api/members?${params.toString()}`);
}

// ---- Clubs ----

export interface ClubSummary {
    id: number;
    name: string;
    description?: string;
    owner?: string;
    joinPolicy?: 'open' | 'request' | 'invite' | string;
    memberCount?: number;
}

export interface ClubMember {
    userId: number;
    username: string;
    role?: string;
    country?: string;
    requestedAt?: string;
}

export interface ClubDetail extends ClubSummary {
    ownerId?: number;
    isMember?: boolean;
    isPending?: boolean;
    isInvited?: boolean;
    isOwner?: boolean;
    joinCode?: string;
    pendingCount?: number;
}

export interface ClubDetailResult extends ApiResponse {
    club?: ClubDetail;
    members?: ClubMember[];
    pendingMembers?: ClubMember[];
    invitedMembers?: ClubMember[];
}

export async function fetchClubs(query?: string) {
    const suffix = query ? `?query=${encodeURIComponent(query)}` : '';

    return rawApiFetch<ApiResponse & { clubs?: ClubSummary[] }>(`/api/clubs${suffix}`);
}

export async function fetchClub(id: number | string) {
    return apiFetch<ClubDetailResult>(`/api/clubs/${id}`);
}

export async function joinClub(id: number | string) {
    return apiFetch<ApiResponse>(`/api/clubs/${id}/join`, { method: 'POST' });
}

export async function leaveClub(id: number | string) {
    return apiFetch<ApiResponse>(`/api/clubs/${id}/leave`, { method: 'POST' });
}

/** Join by the code a club owner hands out, rather than by browsing. */
export async function joinClubByCode(code: string) {
    return apiFetch<ApiResponse & { clubId?: number }>('/api/clubs/join-by-code', {
        method: 'POST',
        body: { code }
    });
}

/** Answer an invitation (the owner's, not an application of ours). */
export async function respondToClubInvitation(id: number | string, accept: boolean) {
    return apiFetch<ApiResponse>(`/api/clubs/${id}/invitation`, {
        method: 'POST',
        body: { accept }
    });
}

export async function fetchClubInvitations() {
    return apiFetch<ApiResponse & { invitations?: ClubSummary[] }>('/api/clubs/invitations');
}

export interface ClubLeaderboardRow {
    username: string;
    rating?: number;
    gamesPlayed?: number;
    rank?: number;
}

export async function fetchClubLeaderboard(id: number | string) {
    return rawApiFetch<ApiResponse & { leaderboard?: ClubLeaderboardRow[] }>(
        `/api/clubs/${id}/leaderboard`
    );
}

// ---- Teams (N7) ----

export interface TeamSummary {
    id: number;
    name: string;
    description?: string;
    captain?: string;
    clubName?: string;
    memberCount?: number;
    rating?: number;
}

export interface TeamMember {
    userId: number;
    username: string;
    role?: string;
}

export interface TeamDetail extends TeamSummary {
    clubId?: number;
    isMember?: boolean;
    isCaptain?: boolean;
    joinCode?: string;
}

export interface TeamDetailResult extends ApiResponse {
    team?: TeamDetail;
    members?: TeamMember[];
    ratings?: { pool: string; rating: number; gamesPlayed?: number }[];
}

export async function fetchTeams(query?: string) {
    const suffix = query ? `?query=${encodeURIComponent(query)}` : '';

    return rawApiFetch<ApiResponse & { teams?: TeamSummary[] }>(`/api/teams${suffix}`);
}

export async function fetchMyTeams() {
    return apiFetch<ApiResponse & { teams?: TeamSummary[] }>('/api/teams/mine');
}

export async function fetchTeam(id: number | string) {
    return apiFetch<TeamDetailResult>(`/api/teams/${id}`);
}

export async function leaveTeam(id: number | string) {
    return apiFetch<ApiResponse>(`/api/teams/${id}/leave`, { method: 'POST' });
}

export async function joinTeamByCode(code: string) {
    return apiFetch<ApiResponse & { teamId?: number }>('/api/teams/join-by-code', {
        method: 'POST',
        body: { code }
    });
}

export async function fetchTeamLeaderboard(pool = 'archon') {
    return rawApiFetch<ApiResponse & { teams?: TeamSummary[] }>(
        `/api/teams/leaderboard?pool=${encodeURIComponent(pool)}`
    );
}

// ---- Season archive (N4) ----

export interface SeasonSummary {
    number: number;
    startedAt?: string;
    endedAt?: string;
    rankedPlayers?: number;
    current?: boolean;
}

export interface SeasonStandingRow {
    rank?: number;
    username: string;
    rating?: number;
    gamesPlayed?: number;
    wins?: number;
    losses?: number;
}

export async function fetchSeasons() {
    return rawApiFetch<ApiResponse & { seasons?: SeasonSummary[] }>('/api/ratings/seasons');
}

export async function fetchSeasonStandings(
    season: number | string,
    options: { pool?: string; limit?: number } = {}
) {
    const params = new URLSearchParams();
    params.set('pool', options.pool ?? 'archon');
    params.set('limit', String(options.limit ?? 50));

    return rawApiFetch<
        ApiResponse & { standings?: SeasonStandingRow[]; season?: SeasonSummary }
    >(`/api/ratings/seasons/${season}?${params.toString()}`);
}
