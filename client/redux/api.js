import { createApi, fetchBaseQuery } from '@reduxjs/toolkit/query/react';
import { TAG_TYPES } from './apiTags';
import { setAuthTokens, authActions } from './slices/authSlice';
import { lobbyAuthenticateRequested } from './socketActions';

const getRefreshTokenFromStorage = () => {
    if (typeof localStorage === 'undefined') {
        return undefined;
    }

    const storedToken = localStorage.getItem('refreshToken');
    if (!storedToken) {
        return undefined;
    }

    try {
        return JSON.parse(storedToken);
    } catch (_error) {
        return undefined;
    }
};

/**
 * `sets=800,928`, or nothing at all for an empty list.
 *
 * Leaving the parameter off rather than sending `sets=` keeps the unfiltered
 * request on a single cache key no matter how the caller spelled "no filter",
 * and means an accidental empty array can never read as "no sets are allowed".
 */
const setsParam = (sets, prefix = '?') => {
    const codes = (Array.isArray(sets) ? sets : [sets])
        .map((set) => parseInt(set, 10))
        .filter((set) => Number.isFinite(set) && set > 0);

    return codes.length ? `${prefix}sets=${codes.join(',')}` : '';
};

const isUnauthorizedError = (error = {}) => {
    const rawStatus = [error.status, error.originalStatus, error.data?.status]
        .filter((entry) => entry !== undefined && entry !== null)
        .find((entry) => String(entry) === '401');

    return Boolean(
        rawStatus ||
            error.status === 401 ||
            error.originalStatus === 401 ||
            error.data?.status === 401 ||
            error.message === 'Unauthorized' ||
            error.data?.message === 'Unauthorized'
    );
};

const NEWS_LIST_ID = 'LIST';
const DECKS_LIST_ID = 'LIST';
const BANLIST_ID = 'LIST';
const SESSIONS_ID = 'LIST';
const BLOCKLIST_ID = 'LIST';
const GAMES_ID = 'LIST';

const getNewsTags = (result) => {
    const items = result?.news || [];
    return [
        { type: TAG_TYPES.NEWS, id: NEWS_LIST_ID },
        ...items.map((item) => ({ type: TAG_TYPES.NEWS, id: item.id }))
    ];
};

const baseQuery = fetchBaseQuery({
    baseUrl: '/api',
    prepareHeaders: (headers, { getState }) => {
        const token = getState()?.auth?.token;
        if (token) {
            headers.set('Authorization', `Bearer ${token}`);
        }
        return headers;
    },
    validateStatus: (response, result) => {
        if (response.status !== 200) {
            return false;
        }
        return !(result && result.success === false);
    }
});

const baseQueryWithReauth = async (args, api, extraOptions) => {
    let result = await baseQuery(args, api, extraOptions);
    if (result.error && isUnauthorizedError(result.error)) {
        const refreshToken = api.getState()?.auth?.refreshToken || getRefreshTokenFromStorage();
        if (!refreshToken) {
            return result;
        }

        if (args.url === '/account/token') {
            return result;
        }

        const refreshResult = await baseQuery(
            {
                url: '/account/token',
                method: 'POST',
                body: { token: refreshToken }
            },
            api,
            extraOptions
        );

        if (refreshResult.data?.success) {
            api.dispatch(
                setAuthTokens({
                    token: refreshResult.data.token,
                    refreshToken,
                    user: refreshResult.data.user
                })
            );
            api.dispatch(lobbyAuthenticateRequested());
            result = await baseQuery(args, api, extraOptions);
        } else {
            api.dispatch(authActions.clearAuthTokens());
            const currentPath = window.location?.pathname || '';
            if (
                currentPath !== '/login' &&
                currentPath !== '/register' &&
                currentPath !== '/forgot' &&
                currentPath !== '/reset-password' &&
                // ARCHON: the route is /activation - '/activate' matched
                // nothing, so a stale refresh token could bounce someone off
                // the activation page before their link was processed.
                currentPath !== '/activation'
            ) {
                window.location.assign('/login');
            }
        }
    }

    return result;
};

export const api = createApi({
    reducerPath: 'rtkApi',
    baseQuery: baseQueryWithReauth,
    tagTypes: Object.values(TAG_TYPES),
    endpoints: (builder) => ({
        getNews: builder.query({
            query: ({ limit } = {}) => ({
                url: '/news',
                params: limit ? { limit } : undefined
            }),
            providesTags: getNewsTags,
            serializeQueryArgs: ({ queryArgs }) => {
                const limit =
                    queryArgs && typeof queryArgs.limit === 'number' ? queryArgs.limit : undefined;
                return limit ? `news-limit-${limit}` : 'news';
            }
        }),
        addNews: builder.mutation({
            query: (text) => ({
                url: '/news',
                method: 'POST',
                body: { text }
            }),
            invalidatesTags: [{ type: TAG_TYPES.NEWS, id: NEWS_LIST_ID }]
        }),
        saveNews: builder.mutation({
            query: ({ id, text }) => ({
                url: `/news/${id}`,
                method: 'PUT',
                body: { text }
            }),
            invalidatesTags: (result, error, { id }) => [
                { type: TAG_TYPES.NEWS, id: NEWS_LIST_ID },
                { type: TAG_TYPES.NEWS, id }
            ]
        }),
        deleteNews: builder.mutation({
            query: (id) => ({
                url: `/news/${id}`,
                method: 'DELETE'
            }),
            invalidatesTags: (result, error, id) => [
                { type: TAG_TYPES.NEWS, id: NEWS_LIST_ID },
                { type: TAG_TYPES.NEWS, id }
            ]
        }),
        loginAccount: builder.mutation({
            query: ({ username, password }) => ({
                url: '/account/login',
                method: 'POST',
                body: { username, password }
            }),
            async onQueryStarted(_arg, { dispatch, queryFulfilled }) {
                try {
                    const { data } = await queryFulfilled;
                    dispatch(
                        setAuthTokens({
                            token: data.token,
                            refreshToken: data.refreshToken,
                            user: data.user
                        })
                    );
                } catch {
                    // ignore
                }
            }
        }),
        registerAccount: builder.mutation({
            query: ({ username, password, email }) => ({
                url: '/account/register',
                method: 'POST',
                body: { username, password, email }
            })
        }),
        logoutAccount: builder.mutation({
            query: ({ tokenId }) => ({
                url: '/account/logout',
                method: 'POST',
                body: { tokenId }
            }),
            async onQueryStarted(_arg, { dispatch, queryFulfilled }) {
                try {
                    await queryFulfilled;
                } finally {
                    dispatch(authActions.clearAuthTokens());
                }
            }
        }),
        forgotPassword: builder.mutation({
            query: ({ username, captcha }) => ({
                url: '/account/password-reset',
                method: 'POST',
                body: { username, captcha }
            })
        }),
        resetPassword: builder.mutation({
            query: ({ id, token, newPassword }) => ({
                url: '/account/password-reset-finish',
                method: 'POST',
                body: { id, token, newPassword }
            })
        }),
        activateAccount: builder.mutation({
            query: ({ id, token }) => ({
                url: '/account/activate',
                method: 'POST',
                body: { id, token }
            })
        }),
        // ARCHON: the server answers this identically whether or not the
        // account exists, so there is nothing useful in the response and the
        // UI must not pretend there is - see the endpoint for why.
        resendActivation: builder.mutation({
            query: ({ username }) => ({
                url: '/account/resend-activation',
                method: 'POST',
                body: { username }
            })
        }),
        verifyAuthentication: builder.mutation({
            query: () => ({
                url: '/account/checkauth',
                method: 'POST'
            })
        }),
        // ARCHON (N12): the tier price list and capability copy. Public, so the
        // membership page renders for a logged-out visitor deciding to sign up.
        getMembershipCatalog: builder.query({
            query: () => '/membership/catalog'
        }),
        // The caller's own resolved entitlements. The user object already
        // carries `capabilities`; this is for the membership page, which also
        // wants provider/status/expiry detail.
        getMyMembership: builder.query({
            query: () => '/membership/me',
            providesTags: [TAG_TYPES.MEMBERSHIP]
        }),
        // ARCHON (N12): the preview programme. Returns only previews this
        // account's tier can reach, including ones whose window has not opened
        // yet - "you get this on the 14th" is what a head start looks like.
        getMembershipPreviews: builder.query({
            query: () => '/membership/previews',
            providesTags: [{ type: TAG_TYPES.MEMBERSHIP, id: 'PREVIEWS' }]
        }),
        setMembershipPreview: builder.mutation({
            query: (body) => ({ url: '/membership/previews', method: 'POST', body }),
            // Also invalidates intelligence: a preview switch changes which
            // sections that payload contains, and leaving the old one cached
            // would make the switch look broken until a reload.
            invalidatesTags: [
                { type: TAG_TYPES.MEMBERSHIP, id: 'PREVIEWS' },
                TAG_TYPES.INTELLIGENCE
            ]
        }),
        getAdminMemberships: builder.query({
            query: () => '/admin/memberships',
            providesTags: [TAG_TYPES.MEMBERSHIP]
        }),
        grantMembership: builder.mutation({
            query: (body) => ({ url: '/admin/memberships/grant', method: 'POST', body }),
            invalidatesTags: [TAG_TYPES.MEMBERSHIP, TAG_TYPES.INTELLIGENCE]
        }),
        // ARCHON (N12): Archon Intelligence.
        //
        // The set filter travels as `sets=800,928` - set codes, the same
        // numbers an event's allowed-sets list holds. An empty list is left off
        // the URL entirely so "no filter" and "filter for nothing" stay
        // distinguishable, and so the unfiltered query keeps one cache key.
        getDeckIntelligence: builder.query({
            query: (deckId) => `/intelligence/deck/${deckId}`,
            providesTags: [TAG_TYPES.INTELLIGENCE]
        }),
        getPlayerIntelligence: builder.query({
            query: (sets = []) => `/intelligence/player${setsParam(sets)}`,
            providesTags: [TAG_TYPES.INTELLIGENCE]
        }),
        getMetaIntelligence: builder.query({
            // Called with a bare number for a long time; still is, in places.
            query: (arg = 30) => {
                const { days = 30, sets = [] } =
                    typeof arg === 'object' && arg ? arg : { days: arg };

                return `/intelligence/meta?days=${days}${setsParam(sets, '&')}`;
            },
            providesTags: [TAG_TYPES.INTELLIGENCE]
        }),
        // ARCHON (N12): Replay Intelligence - what a player's recorded games
        // say about how they play. Archon+ only, enforced at the endpoint.
        getReplayIntelligence: builder.query({
            query: (limit = 25) => `/intelligence/replays?limit=${limit}`,
            providesTags: [TAG_TYPES.INTELLIGENCE]
        }),
        // ARCHON: the same record read in AERC terms. One request draws the
        // whole panel - the bands, the findings and the meta profile all share
        // the trait and the set filter, and splitting them would make the
        // panels disagree while they arrived.
        getAercIntelligence: builder.query({
            query: ({ trait = 'amberControl', sets = [], days = 30 } = {}) =>
                `/intelligence/aerc?trait=${encodeURIComponent(trait)}&days=${days}` +
                setsParam(sets, '&'),
            providesTags: [TAG_TYPES.INTELLIGENCE]
        }),
        getTournamentLab: builder.query({
            query: (arg = []) => {
                const {
                    decks = [],
                    sets = [],
                    tournament = null
                } = Array.isArray(arg) ? { decks: arg } : arg || {};

                return (
                    `/intelligence/tournament-lab?decks=${encodeURIComponent(decks.join(','))}` +
                    setsParam(sets, '&') +
                    (tournament ? `&tournament=${encodeURIComponent(tournament)}` : '')
                );
            },
            providesTags: [TAG_TYPES.INTELLIGENCE]
        }),
        // ARCHON (N18): the Proving Grounds - background simulated deck
        // testing for Vault Master. One request draws the whole page: the
        // roster, every deck's simulated record, and the findings all read
        // the same games, and splitting them would let the panels disagree.
        getProvingGrounds: builder.query({
            query: () => '/proving-grounds',
            providesTags: [TAG_TYPES.PROVING_GROUNDS]
        }),
        enrollProvingGroundsDeck: builder.mutation({
            query: (deckId) => ({
                url: '/proving-grounds/decks',
                method: 'POST',
                body: { deckId }
            }),
            invalidatesTags: [TAG_TYPES.PROVING_GROUNDS]
        }),
        withdrawProvingGroundsDeck: builder.mutation({
            query: (deckId) => ({
                url: `/proving-grounds/decks/${deckId}`,
                method: 'DELETE'
            }),
            invalidatesTags: [TAG_TYPES.PROVING_GROUNDS]
        }),
        // ARCHON (N12): is Patreon configured on this deployment, and where is
        // the campaign page. Public - the client renders no Patreon UI at all
        // when it comes back disabled.
        getPatreonStatus: builder.query({
            query: () => '/account/patreon/status'
        }),
        // The caller's own pledge status and entitled tiers.
        getPatreonMembership: builder.query({
            query: () => '/account/patreon/me',
            providesTags: [TAG_TYPES.PATREON]
        }),
        // Returns the Patreon authorization URL to navigate to. Built by the
        // server so the client id and scopes live in one place, and so the
        // one-shot `state` can be bound to a signed cookie.
        startPatreonLink: builder.mutation({
            query: () => ({
                url: '/account/patreon/link/start',
                method: 'POST'
            })
        }),
        linkPatreon: builder.mutation({
            query: ({ code, state }) => ({
                url: '/account/linkPatreon',
                method: 'POST',
                body: { code, state }
            }),
            invalidatesTags: [TAG_TYPES.PATREON, TAG_TYPES.MEMBERSHIP, TAG_TYPES.INTELLIGENCE]
        }),
        unlinkPatreon: builder.mutation({
            query: () => ({
                url: '/account/unlinkPatreon',
                method: 'POST'
            }),
            invalidatesTags: [TAG_TYPES.PATREON, TAG_TYPES.MEMBERSHIP, TAG_TYPES.INTELLIGENCE]
        }),
        // ARCHON: OIDC (Keybringer) linked identities for account settings
        getOidcIdentities: builder.query({
            query: () => '/account/oidc/identities',
            providesTags: [TAG_TYPES.OIDC]
        }),
        getOidcStatus: builder.query({
            query: () => '/account/oidc/status'
        }),
        startOidcLink: builder.mutation({
            query: () => ({
                url: '/account/oidc/link/start',
                method: 'POST'
            })
        }),
        unlinkOidc: builder.mutation({
            query: (provider) => ({
                url: '/account/oidc/unlink',
                method: 'POST',
                body: { provider }
            }),
            invalidatesTags: [TAG_TYPES.OIDC]
        }),
        // ARCHON: rankings (Phase 6): player location + leaderboards
        getLocation: builder.query({
            query: () => '/account/location',
            providesTags: [TAG_TYPES.LOCATION]
        }),
        setLocation: builder.mutation({
            query: ({ country, state }) => ({
                url: '/account/location',
                method: 'PUT',
                body: { country, state }
            }),
            invalidatesTags: [TAG_TYPES.LOCATION]
        }),
        // ARCHON (I3): optional player bio.
        getBio: builder.query({
            query: () => '/account/bio',
            providesTags: [TAG_TYPES.BIO]
        }),
        setBio: builder.mutation({
            query: (bio) => ({
                url: '/account/bio',
                method: 'PUT',
                body: { bio }
            }),
            invalidatesTags: [TAG_TYPES.BIO]
        }),
        // ARCHON (N12): profile cosmetics. One GET for the editor - the whole
        // catalogue with each option marked locked or not, plus this account's
        // current selection - so the page needs no second request to know what
        // it may offer.
        getCosmetics: builder.query({
            query: () => '/account/cosmetics',
            providesTags: [TAG_TYPES.COSMETICS]
        }),
        setCosmetics: builder.mutation({
            query: (cosmetics) => ({
                url: '/account/cosmetics',
                method: 'PUT',
                body: { cosmetics }
            }),
            // The bio limit rises with the same capability, and the public
            // profile is what the editor is previewing.
            invalidatesTags: [TAG_TYPES.COSMETICS, TAG_TYPES.USER]
        }),
        getLeaderboard: builder.query({
            query: (params) => ({
                url: '/ratings/leaderboard',
                params
            }),
            providesTags: [TAG_TYPES.RATINGS]
        }),
        getRatings: builder.query({
            query: (username) => `/ratings/${encodeURIComponent(username)}`,
            providesTags: [TAG_TYPES.RATINGS]
        }),
        // ARCHON (N4): season list and archived final standings (public).
        getSeasons: builder.query({
            query: () => '/ratings/seasons',
            providesTags: [TAG_TYPES.RATINGS]
        }),
        getSeasonStandings: builder.query({
            query: ({ season, pool, limit, offset }) => ({
                url: `/ratings/seasons/${encodeURIComponent(season)}`,
                params: { pool, limit, offset }
            }),
            providesTags: [TAG_TYPES.RATINGS]
        }),
        // ARCHON: platform statistics & analytics (public aggregate lookups)
        // ARCHON (N12): these three payloads are filtered by membership tier
        // (server/api/statsGating.js), so a cached copy fetched while free is
        // WRONG the moment the account upgrades - the premium fields would stay
        // missing until the cache expired, which reads as the upgrade not
        // having worked. Tagging them MEMBERSHIP makes a membership change
        // refetch them.
        getMetaStats: builder.query({
            query: () => '/stats/meta',
            providesTags: [TAG_TYPES.MEMBERSHIP]
        }),
        getPlayerStats: builder.query({
            query: (username) => `/stats/player/${encodeURIComponent(username)}`,
            providesTags: [TAG_TYPES.MEMBERSHIP]
        }),
        // ARCHON: per-deck record with SAS-vs-performance delta.
        getDeckStats: builder.query({
            query: (username) => `/stats/decks/${encodeURIComponent(username)}`,
            providesTags: [TAG_TYPES.MEMBERSHIP]
        }),
        // ARCHON: public player profile header, clubs and recent games. Amber,
        // stats and trophies come from their own public endpoints above.
        getPlayerProfile: builder.query({
            query: (username) => `/players/${encodeURIComponent(username)}`
        }),
        // ARCHON: native tournament engine (in-platform events)
        listEvents: builder.query({
            query: (params) => ({ url: '/tournaments', params }),
            providesTags: [TAG_TYPES.TOURNAMENTS]
        }),
        getEventDetail: builder.query({
            query: (id) => `/tournaments/${id}`,
            providesTags: (result, error, id) => [{ type: TAG_TYPES.TOURNAMENTS, id }]
        }),
        createTournament: builder.mutation({
            query: (body) => ({ url: '/tournaments', method: 'POST', body }),
            invalidatesTags: [TAG_TYPES.TOURNAMENTS]
        }),
        tournamentAction: builder.mutation({
            query: ({ id, action, body }) => ({
                url: `/tournaments/${id}/${action}`,
                method: 'POST',
                body
            }),
            invalidatesTags: (result, error, { id }) => [
                TAG_TYPES.TOURNAMENTS,
                { type: TAG_TYPES.TOURNAMENTS, id }
            ]
        }),
        getTournamentHistory: builder.query({
            query: (username) => `/tournaments/history/${encodeURIComponent(username)}`,
            providesTags: [TAG_TYPES.TOURNAMENTS]
        }),
        /**
         * ARCHON (N12): pull an event's data down as CSV (ORGANIZER_TOOLS).
         *
         * A mutation rather than a query because it is an action with a side
         * effect on the user's machine, not cacheable data - and caching a file
         * somebody asked to download is exactly the wrong behaviour.
         *
         * `responseHandler: 'text'` because the response is a CSV body, not
         * JSON. Without it RTK Query would try to parse it and hand back a
         * parse error for a request that succeeded.
         */
        exportTournament: builder.mutation({
            query: ({ id, dataset }) => ({
                url: `/tournaments/${id}/export`,
                method: 'GET',
                params: { dataset },
                responseHandler: 'text'
            })
        }),
        // ARCHON (N14): the caller's open matches across every event they are
        // in - what an async player needs and no single event page can answer.
        getMyTournamentMatches: builder.query({
            query: () => '/tournaments/my-matches',
            providesTags: [TAG_TYPES.TOURNAMENTS]
        }),
        // ARCHON: beta bug reports
        submitBugReport: builder.mutation({
            query: (body) => ({ url: '/bug-reports', method: 'POST', body }),
            invalidatesTags: [TAG_TYPES.BUG_REPORTS]
        }),
        getBugReports: builder.query({
            query: (params) => ({ url: '/bug-reports', params }),
            providesTags: [TAG_TYPES.BUG_REPORTS]
        }),
        setBugReportStatus: builder.mutation({
            query: ({ id, status }) => ({
                url: `/bug-reports/${id}/status`,
                method: 'POST',
                body: { status }
            }),
            invalidatesTags: [TAG_TYPES.BUG_REPORTS]
        }),
        // ARCHON: community (friends, members, clubs)
        getFriends: builder.query({
            query: () => '/friends',
            providesTags: [TAG_TYPES.FRIENDS]
        }),
        friendAction: builder.mutation({
            query: ({ action, body }) => ({
                url: `/friends/${action}`,
                method: 'POST',
                body
            }),
            invalidatesTags: [TAG_TYPES.FRIENDS]
        }),
        getMembers: builder.query({
            query: (params) => ({ url: '/members', params })
        }),
        getClubs: builder.query({
            query: (params) => ({ url: '/clubs', params }),
            providesTags: [TAG_TYPES.CLUBS]
        }),
        getClub: builder.query({
            query: (id) => `/clubs/${id}`,
            providesTags: (result, error, id) => [{ type: TAG_TYPES.CLUBS, id }]
        }),
        createClub: builder.mutation({
            query: (body) => ({ url: '/clubs', method: 'POST', body }),
            invalidatesTags: [TAG_TYPES.CLUBS]
        }),
        clubAction: builder.mutation({
            query: ({ id, action, body }) => ({
                url: `/clubs/${id}/${action}`,
                method: 'POST',
                body
            }),
            invalidatesTags: (result, error, { id }) => [
                TAG_TYPES.CLUBS,
                { type: TAG_TYPES.CLUBS, id }
            ]
        }),
        joinClubByCode: builder.mutation({
            query: (code) => ({
                url: '/clubs/join-by-code',
                method: 'POST',
                body: { code }
            }),
            invalidatesTags: [TAG_TYPES.CLUBS]
        }),
        // ARCHON: named club invitations, as opposed to the shareable code.
        getClubInvitations: builder.query({
            query: () => '/clubs/invitations',
            providesTags: [TAG_TYPES.CLUBS]
        }),
        inviteToClub: builder.mutation({
            query: ({ id, username }) => ({
                url: `/clubs/${id}/invite`,
                method: 'POST',
                body: { username }
            }),
            invalidatesTags: (result, error, { id }) => [
                TAG_TYPES.CLUBS,
                { type: TAG_TYPES.CLUBS, id }
            ]
        }),
        respondToClubInvitation: builder.mutation({
            query: ({ id, accept }) => ({
                url: `/clubs/${id}/invitation`,
                method: 'POST',
                body: { accept }
            }),
            invalidatesTags: (result, error, { id }) => [
                TAG_TYPES.CLUBS,
                { type: TAG_TYPES.CLUBS, id }
            ]
        }),
        // ARCHON (N7): club competition
        getClubLeaderboard: builder.query({
            query: ({ id, pool }) => ({ url: `/clubs/${id}/leaderboard`, params: { pool } }),
            providesTags: (result, error, { id }) => [{ type: TAG_TYPES.CLUBS, id }]
        }),
        decideClubJoinRequest: builder.mutation({
            query: ({ id, userId, approve }) => ({
                url: `/clubs/${id}/requests/${userId}`,
                method: 'POST',
                body: { approve }
            }),
            invalidatesTags: (result, error, { id }) => [
                TAG_TYPES.CLUBS,
                { type: TAG_TYPES.CLUBS, id }
            ]
        }),
        // ARCHON (N7): teams
        getTeams: builder.query({
            query: (params) => ({ url: '/teams', params }),
            providesTags: [TAG_TYPES.TEAMS]
        }),
        getTeam: builder.query({
            query: (id) => `/teams/${id}`,
            providesTags: (result, error, id) => [{ type: TAG_TYPES.TEAMS, id }]
        }),
        getMyTeams: builder.query({
            query: () => '/teams/mine',
            providesTags: [TAG_TYPES.TEAMS]
        }),
        getTeamLeaderboard: builder.query({
            query: (params) => ({ url: '/teams/leaderboard', params }),
            providesTags: [TAG_TYPES.TEAMS]
        }),
        createTeam: builder.mutation({
            query: (body) => ({ url: '/teams', method: 'POST', body }),
            invalidatesTags: [TAG_TYPES.TEAMS]
        }),
        joinTeamByCode: builder.mutation({
            query: (code) => ({ url: '/teams/join-by-code', method: 'POST', body: { code } }),
            invalidatesTags: [TAG_TYPES.TEAMS]
        }),
        teamAction: builder.mutation({
            query: ({ id, action, body }) => ({
                url: `/teams/${id}/${action}`,
                method: 'POST',
                body
            }),
            invalidatesTags: (result, error, { id }) => [
                TAG_TYPES.TEAMS,
                { type: TAG_TYPES.TEAMS, id }
            ]
        }),
        // ARCHON (N13): in-person (paper) games
        getInPersonGames: builder.query({
            query: (params) => ({ url: '/in-person-games', params }),
            providesTags: [TAG_TYPES.IN_PERSON_GAMES]
        }),
        getInPersonGame: builder.query({
            query: (id) => `/in-person-games/${id}`,
            providesTags: (result, error, id) => [{ type: TAG_TYPES.IN_PERSON_GAMES, id }]
        }),
        createInPersonGame: builder.mutation({
            query: (body) => ({ url: '/in-person-games', method: 'POST', body }),
            invalidatesTags: [TAG_TYPES.IN_PERSON_GAMES]
        }),
        inPersonGameAction: builder.mutation({
            query: ({ id, action, body }) => ({
                url: `/in-person-games/${id}/${action}`,
                method: 'POST',
                body
            }),
            // A confirmed report writes a real game, so match history and
            // ratings are stale the moment it lands.
            invalidatesTags: (result, error, { id }) => [
                TAG_TYPES.IN_PERSON_GAMES,
                { type: TAG_TYPES.IN_PERSON_GAMES, id },
                TAG_TYPES.GAMES,
                TAG_TYPES.RATINGS
            ]
        }),
        getClubInPersonGames: builder.query({
            query: ({ id, limit }) => ({ url: `/clubs/${id}/in-person-games`, params: { limit } }),
            providesTags: [TAG_TYPES.IN_PERSON_GAMES]
        }),
        // ARCHON (N5): reports and moderation
        getModerationOptions: builder.query({
            query: () => '/moderation/options'
        }),
        submitReport: builder.mutation({
            query: (body) => ({ url: '/reports', method: 'POST', body }),
            invalidatesTags: [TAG_TYPES.MODERATION]
        }),
        getMyRestrictions: builder.query({
            query: () => '/moderation/me',
            providesTags: [TAG_TYPES.MODERATION]
        }),
        getModerationQueue: builder.query({
            query: (params) => ({ url: '/moderation/queue', params }),
            providesTags: [TAG_TYPES.MODERATION]
        }),
        moderationReportAction: builder.mutation({
            query: ({ id, action, body }) => ({
                url: `/moderation/reports/${id}/${action}`,
                method: 'POST',
                body
            }),
            // A resolution usually comes with a sanction, so the dashboard's
            // moderation counts go stale at the same moment.
            invalidatesTags: [TAG_TYPES.MODERATION, TAG_TYPES.ANALYTICS]
        }),
        moderationAct: builder.mutation({
            query: (body) => ({ url: '/moderation/actions', method: 'POST', body }),
            invalidatesTags: [TAG_TYPES.MODERATION, TAG_TYPES.ANALYTICS]
        }),
        revokeModerationAction: builder.mutation({
            query: ({ id, reason }) => ({
                url: `/moderation/actions/${id}/revoke`,
                method: 'POST',
                body: { reason }
            }),
            invalidatesTags: [TAG_TYPES.MODERATION, TAG_TYPES.ANALYTICS]
        }),
        getPlayerModerationHistory: builder.query({
            query: (username) => `/moderation/players/${encodeURIComponent(username)}`,
            providesTags: [TAG_TYPES.MODERATION]
        }),
        getModerationAudit: builder.query({
            query: (params) => ({ url: '/moderation/audit', params }),
            providesTags: [TAG_TYPES.MODERATION]
        }),
        // ARCHON (N8): admin operations dashboard
        getAnalytics: builder.query({
            query: (params) => ({ url: '/admin/analytics', params }),
            providesTags: [TAG_TYPES.ANALYTICS]
        }),
        // ARCHON (N9): Adaptive Bo3 chain bidding
        getAdaptiveState: builder.query({
            query: ({ id, matchId }) => `/tournaments/${id}/matches/${matchId}/adaptive`,
            providesTags: (result, error, { id }) => [{ type: TAG_TYPES.TOURNAMENTS, id }]
        }),
        checkInByCode: builder.mutation({
            query: (code) => ({
                url: '/tournaments/check-in-by-code',
                method: 'POST',
                body: { code }
            }),
            invalidatesTags: [TAG_TYPES.TOURNAMENTS]
        }),
        // ARCHON: local stores / venues for in-person play (Play IRL)
        getStores: builder.query({
            query: (params) => ({ url: '/stores', params }),
            providesTags: [TAG_TYPES.STORES]
        }),
        addStore: builder.mutation({
            query: (body) => ({ url: '/stores', method: 'POST', body }),
            invalidatesTags: [TAG_TYPES.STORES]
        }),
        removeStore: builder.mutation({
            query: (id) => ({ url: `/stores/${id}/remove`, method: 'POST' }),
            invalidatesTags: [TAG_TYPES.STORES]
        }),
        // ARCHON: first-run onboarding wizard (Phase 9)
        completeOnboarding: builder.mutation({
            query: () => ({
                url: '/account/onboarded',
                method: 'POST'
            })
        }),
        setAvatar: builder.mutation({
            query: (avatar) => ({
                url: '/account/avatar',
                method: 'PUT',
                body: { avatar }
            })
        }),
        // ARCHON: admin-authored About/Privacy overrides (public)
        getSiteContent: builder.query({
            query: () => '/content'
        }),
        // ARCHON: admin rating tools
        adminSetRating: builder.mutation({
            query: ({ username, pool, rating, gamesPlayed }) => ({
                url: `/admin/ratings/${encodeURIComponent(username)}`,
                method: 'PUT',
                body: { pool, rating, gamesPlayed }
            }),
            invalidatesTags: [TAG_TYPES.RATINGS]
        }),
        adminResetRatings: builder.mutation({
            query: ({ username, pool }) => ({
                url: `/admin/ratings/${encodeURIComponent(username)}/reset`,
                method: 'POST',
                body: { pool }
            }),
            invalidatesTags: [TAG_TYPES.RATINGS]
        }),
        // ARCHON: seasons & rating decay (site-wide admin operations)
        getRatingSeason: builder.query({
            query: () => '/admin/ratings/season'
        }),
        applyRatingDecay: builder.mutation({
            query: () => ({ url: '/admin/ratings/decay', method: 'POST' }),
            invalidatesTags: [TAG_TYPES.RATINGS]
        }),
        startNewSeason: builder.mutation({
            query: () => ({ url: '/admin/ratings/new-season', method: 'POST' }),
            invalidatesTags: [TAG_TYPES.RATINGS]
        }),
        // ARCHON (N4): rebuild the ladder from RatingHistory. Dry run unless
        // `confirm` is true; the caller is expected to show the report first.
        recalculateRatings: builder.mutation({
            query: (body) => ({ url: '/admin/ratings/recalculate', method: 'POST', body }),
            invalidatesTags: (result) => (result?.committed ? [TAG_TYPES.RATINGS] : [])
        }),
        // ARCHON: runtime admin settings
        getAdminSettings: builder.query({
            query: () => '/admin/settings'
        }),
        saveAdminSettings: builder.mutation({
            query: ({ section, value }) => ({
                url: `/admin/settings/${section}`,
                method: 'PUT',
                body: { value }
            })
        }),
        resetAdminSettings: builder.mutation({
            query: (section) => ({
                url: `/admin/settings/${section}`,
                method: 'DELETE'
            })
        }),
        getCards: builder.query({
            query: () => '/cards',
            providesTags: [{ type: TAG_TYPES.CARDS, id: 'LIST' }]
        }),
        getFactions: builder.query({
            query: () => '/factions',
            providesTags: [{ type: TAG_TYPES.FACTIONS, id: 'LIST' }]
        }),
        getDecks: builder.query({
            query: (options = {}) => {
                const sortFromState = Array.isArray(options.sorting)
                    ? options.sorting[0]
                    : undefined;
                const sort = options.sort || sortFromState?.id;
                const sortDir =
                    options.sortDir ||
                    (sortFromState ? (sortFromState.desc ? 'desc' : 'asc') : undefined);
                const page = options.page || options.pageIndex;

                return {
                    url: '/decks',
                    params: {
                        filter: options.filter ? JSON.stringify(options.filter) : undefined,
                        page,
                        pageSize: options.pageSize,
                        sort,
                        sortDir
                    }
                };
            },
            transformResponse: (response) => ({
                ...response,
                totalCount: response?.numDecks ?? 0
            }),
            providesTags: [{ type: TAG_TYPES.DECKS, id: DECKS_LIST_ID }]
        }),
        getDeck: builder.query({
            query: (deckId) => `/decks/${deckId}`,
            providesTags: (result, error, deckId) => [{ type: TAG_TYPES.DECKS, id: deckId }]
        }),
        deleteDeck: builder.mutation({
            query: (deckId) => ({
                url: `/decks/${deckId}`,
                method: 'DELETE'
            }),
            invalidatesTags: [{ type: TAG_TYPES.DECKS, id: DECKS_LIST_ID }]
        }),
        deleteDecks: builder.mutation({
            query: (deckIds) => ({
                url: '/decks/bulk-delete',
                method: 'POST',
                body: { deckIds }
            }),
            invalidatesTags: [{ type: TAG_TYPES.DECKS, id: DECKS_LIST_ID }]
        }),
        saveDeck: builder.mutation({
            query: ({ uuid }) => ({
                url: '/decks/',
                method: 'POST',
                body: { uuid }
            }),
            invalidatesTags: [{ type: TAG_TYPES.DECKS, id: DECKS_LIST_ID }]
        }),
        // ARCHON: bulk import from Decks of KeyForge - lists the collection to
        // import; the client then imports each uuid via saveDeck. Takes the
        // user's own DoK API key, which the server uses for the one request and
        // never stores.
        prepareDokImport: builder.mutation({
            query: ({ dokApiKey, remember, autoSync }) => ({
                url: '/decks/import/dok/prepare',
                method: 'POST',
                body: { dokApiKey, remember, autoSync }
            })
        }),
        // ARCHON: find decks by name in the Master Vault catalog, for players
        // who know what their deck is called but not its uuid.
        searchDeckCatalog: builder.query({
            query: ({ q, expansion, limit }) => ({
                url: '/decks/catalog/search',
                params: { q, expansion, limit }
            })
        }),
        // ARCHON: the collection import runs on the server as a resumable job,
        // so these three are the whole client side of it - hand over a list of
        // uuids, watch the job, abandon it if you change your mind. Closing the
        // modal is no longer an action that cancels anything.
        queueDeckImport: builder.mutation({
            query: (uuids) => ({
                url: '/decks/import/queue',
                method: 'POST',
                body: { uuids }
            })
        }),
        getDeckImportStatus: builder.query({
            query: () => ({ url: '/decks/import/status' })
        }),
        cancelDeckImport: builder.mutation({
            query: () => ({ url: '/decks/import/cancel', method: 'POST' })
        }),
        // ARCHON: the remembered DoK account. The key is never returned by any
        // of these - only whether one is held and whether DoK last refused it.
        getDokLink: builder.query({
            query: () => ({ url: '/decks/import/dok/link' })
        }),
        syncDokNow: builder.mutation({
            query: () => ({ url: '/decks/import/dok/sync', method: 'POST' })
        }),
        forgetDokLink: builder.mutation({
            query: () => ({ url: '/decks/import/dok/link', method: 'DELETE' })
        }),
        saveAllianceDeck: builder.mutation({
            query: (deck) => ({
                url: '/decks/alliance',
                method: 'POST',
                body: deck
            }),
            invalidatesTags: [{ type: TAG_TYPES.DECKS, id: DECKS_LIST_ID }]
        }),
        getStandaloneDecks: builder.query({
            query: () => '/standalone-decks',
            providesTags: [{ type: TAG_TYPES.DECKS, id: 'STANDALONE' }]
        }),
        refreshAccolades: builder.mutation({
            query: (deckId) => ({
                url: `/decks/${deckId}/refresh-accolades`,
                method: 'POST'
            }),
            invalidatesTags: (result, error, deckId) => [
                { type: TAG_TYPES.DECKS, id: DECKS_LIST_ID },
                { type: TAG_TYPES.DECKS, id: deckId }
            ]
        }),
        updateAccoladeShown: builder.mutation({
            query: ({ deckId, accoladeId, shown }) => ({
                url: `/decks/${deckId}/accolades/${accoladeId}/shown`,
                method: 'POST',
                body: { shown }
            }),
            invalidatesTags: (result, error, { deckId }) => [
                { type: TAG_TYPES.DECKS, id: DECKS_LIST_ID },
                { type: TAG_TYPES.DECKS, id: deckId }
            ]
        }),
        getActiveSessions: builder.query({
            query: (username) => `/account/${username}/sessions`,
            providesTags: [{ type: TAG_TYPES.SESSIONS, id: SESSIONS_ID }]
        }),
        removeSession: builder.mutation({
            query: ({ username, sessionId }) => ({
                url: `/account/${username}/sessions/${sessionId}`,
                method: 'DELETE'
            }),
            invalidatesTags: [{ type: TAG_TYPES.SESSIONS, id: SESSIONS_ID }]
        }),
        getBlockList: builder.query({
            query: (username) => `/account/${username}/blocklist`,
            providesTags: [{ type: TAG_TYPES.BLOCKLIST, id: BLOCKLIST_ID }]
        }),
        addBlockListEntry: builder.mutation({
            query: ({ username, blockee }) => ({
                url: `/account/${username}/blocklist`,
                method: 'POST',
                body: { username: blockee }
            }),
            invalidatesTags: [{ type: TAG_TYPES.BLOCKLIST, id: BLOCKLIST_ID }]
        }),
        removeBlockListEntry: builder.mutation({
            query: ({ username, blockee }) => ({
                url: `/account/${username}/blocklist/${blockee}`,
                method: 'DELETE'
            }),
            invalidatesTags: [{ type: TAG_TYPES.BLOCKLIST, id: BLOCKLIST_ID }]
        }),
        saveProfile: builder.mutation({
            query: ({ username, details }) => ({
                url: `/account/${username}`,
                method: 'PUT',
                body: { data: details }
            }),
            invalidatesTags: [{ type: TAG_TYPES.USER, id: 'PROFILE' }]
        }),
        deleteAccount: builder.mutation({
            query: ({ username, password }) => ({
                url: `/account/${username}/delete`,
                method: 'POST',
                body: { password }
            })
        }),
        findUser: builder.query({
            query: (username) => `/user/${username}`,
            providesTags: [{ type: TAG_TYPES.ADMIN, id: 'USER' }]
        }),
        saveUser: builder.mutation({
            query: (user) => ({
                url: `/user/${user.username}`,
                method: 'PUT',
                body: { userToChange: user }
            }),
            invalidatesTags: [{ type: TAG_TYPES.ADMIN, id: 'USER' }]
        }),
        // ARCHON: admin account tools
        adminResetPassword: builder.mutation({
            query: ({ username, newPassword }) => ({
                url: `/user/${encodeURIComponent(username)}/reset-password`,
                method: 'POST',
                body: { newPassword }
            })
        }),
        adminDeleteUser: builder.mutation({
            query: (username) => ({
                url: `/user/${encodeURIComponent(username)}`,
                method: 'DELETE'
            }),
            invalidatesTags: [{ type: TAG_TYPES.ADMIN, id: 'USER' }]
        }),
        verifyDeck: builder.mutation({
            query: (deckId) => ({
                url: `/decks/${deckId}/verify`,
                method: 'POST'
            }),
            invalidatesTags: [{ type: TAG_TYPES.ADMIN, id: 'USER' }]
        }),
        verifyAllDecks: builder.mutation({
            query: (username) => ({
                url: `/user/${username}/verifyDecks`,
                method: 'POST'
            }),
            invalidatesTags: [{ type: TAG_TYPES.ADMIN, id: 'USER' }]
        }),
        getBanlist: builder.query({
            query: () => '/banlist/',
            providesTags: [{ type: TAG_TYPES.BANLIST, id: BANLIST_ID }]
        }),
        addBanlist: builder.mutation({
            query: (ip) => ({
                url: '/banlist',
                method: 'POST',
                body: { ip }
            }),
            invalidatesTags: [{ type: TAG_TYPES.BANLIST, id: BANLIST_ID }]
        }),
        deleteBanlist: builder.mutation({
            query: (id) => ({
                url: `/banlist/${id}`,
                method: 'DELETE'
            }),
            invalidatesTags: [{ type: TAG_TYPES.BANLIST, id: BANLIST_ID }]
        }),
        getUserGames: builder.query({
            // ARCHON (N1): filters are applied server-side, before the row
            // limit, so a filtered view searches the whole history.
            query: (params) => ({ url: '/games', params }),
            providesTags: [{ type: TAG_TYPES.GAMES, id: GAMES_ID }]
        }),
        // ARCHON (N1): the decks, opponents and formats that actually appear in
        // this player's history, so the filter controls offer real choices.
        getGameFilters: builder.query({
            query: () => '/games/filters',
            providesTags: [{ type: TAG_TYPES.GAMES, id: 'FILTERS' }]
        }),
        getGameReplay: builder.query({
            query: (gameId) => `/games/${encodeURIComponent(gameId)}/replay`,
            providesTags: (result, error, gameId) => [{ type: TAG_TYPES.GAMES, id: gameId }]
        }),
        // ARCHON (N1): a replay someone shared. Public - no auth header is
        // needed and none is required by the endpoint.
        getSharedReplay: builder.query({
            query: (token) => `/replays/shared/${encodeURIComponent(token)}`
        }),
        // ARCHON (N12): the analysis of one game. Archon+ only, and your own
        // game (or one shared with you) - both enforced at the endpoint.
        getGameReplayAnalysis: builder.query({
            query: (gameId) => `/games/${encodeURIComponent(gameId)}/replay/analysis`,
            providesTags: (result, error, gameId) => [{ type: TAG_TYPES.GAMES, id: gameId }]
        }),
        getSharedReplayAnalysis: builder.query({
            query: (token) => `/replays/shared/${encodeURIComponent(token)}/analysis`
        }),
        shareReplay: builder.mutation({
            query: (gameId) => ({
                url: `/games/${encodeURIComponent(gameId)}/share`,
                method: 'POST'
            }),
            invalidatesTags: (result, error, gameId) => [{ type: TAG_TYPES.GAMES, id: gameId }]
        }),
        unshareReplay: builder.mutation({
            query: (gameId) => ({
                url: `/games/${encodeURIComponent(gameId)}/share`,
                method: 'DELETE'
            }),
            invalidatesTags: (result, error, gameId) => [{ type: TAG_TYPES.GAMES, id: gameId }]
        }),
        // ARCHON (N2): in-app notification centre.
        getNotifications: builder.query({
            query: (params) => ({ url: '/notifications', params }),
            providesTags: [{ type: TAG_TYPES.NOTIFICATIONS, id: 'LIST' }]
        }),
        getUnreadNotificationCount: builder.query({
            query: () => '/notifications/unread-count',
            providesTags: [{ type: TAG_TYPES.NOTIFICATIONS, id: 'UNREAD' }]
        }),
        markNotificationsRead: builder.mutation({
            // No ids means "all of them".
            query: (ids) => ({ url: '/notifications/read', method: 'POST', body: { ids } }),
            invalidatesTags: [
                { type: TAG_TYPES.NOTIFICATIONS, id: 'LIST' },
                { type: TAG_TYPES.NOTIFICATIONS, id: 'UNREAD' }
            ]
        }),
        getNotificationPreferences: builder.query({
            query: () => '/notifications/preferences',
            providesTags: [{ type: TAG_TYPES.NOTIFICATIONS, id: 'PREFS' }]
        }),
        setNotificationPreference: builder.mutation({
            query: (body) => ({ url: '/notifications/preferences', method: 'POST', body }),
            invalidatesTags: [{ type: TAG_TYPES.NOTIFICATIONS, id: 'PREFS' }]
        }),
        // ARCHON: Amber change for a finished game (post-game result screen).
        getGameRating: builder.query({
            query: (gameId) => `/games/${encodeURIComponent(gameId)}/rating`
        }),
        removeLobbyMessage: builder.mutation({
            query: (messageId) => ({
                url: `/messages/${messageId}`,
                method: 'DELETE'
            }),
            invalidatesTags: [{ type: TAG_TYPES.LOBBY, id: 'MESSAGES' }]
        })
    })
});

export const {
    useGetNewsQuery,
    useAddNewsMutation,
    useSaveNewsMutation,
    useDeleteNewsMutation,
    useLoginAccountMutation,
    useRegisterAccountMutation,
    useLogoutAccountMutation,
    useForgotPasswordMutation,
    useResetPasswordMutation,
    useActivateAccountMutation,
    useResendActivationMutation,
    useVerifyAuthenticationMutation,
    // ARCHON (N12): premium membership + Archon Intelligence
    useGetMembershipCatalogQuery,
    useGetMyMembershipQuery,
    useGetAdminMembershipsQuery,
    useGrantMembershipMutation,
    // ARCHON (N12): Vault Master - the preview programme and cosmetics
    useGetMembershipPreviewsQuery,
    useSetMembershipPreviewMutation,
    useGetDeckIntelligenceQuery,
    useGetPlayerIntelligenceQuery,
    useGetMetaIntelligenceQuery,
    useGetAercIntelligenceQuery,
    useGetTournamentLabQuery,
    // ARCHON (N18): the Proving Grounds.
    useGetProvingGroundsQuery,
    useEnrollProvingGroundsDeckMutation,
    useWithdrawProvingGroundsDeckMutation,
    // ARCHON (N12): Patreon supporter linking
    useGetPatreonStatusQuery,
    useGetPatreonMembershipQuery,
    useStartPatreonLinkMutation,
    useLinkPatreonMutation,
    useGetOidcIdentitiesQuery,
    useGetOidcStatusQuery,
    useStartOidcLinkMutation,
    useUnlinkOidcMutation,
    useGetLocationQuery,
    useSetLocationMutation,
    useGetBioQuery,
    useSetBioMutation,
    // ARCHON (N12): profile cosmetics.
    useGetCosmeticsQuery,
    useSetCosmeticsMutation,
    useGetSiteContentQuery,
    useAdminSetRatingMutation,
    useAdminResetRatingsMutation,
    useGetRatingSeasonQuery,
    useApplyRatingDecayMutation,
    useStartNewSeasonMutation,
    useGetLeaderboardQuery,
    useGetRatingsQuery,
    useGetSeasonsQuery,
    useGetSeasonStandingsQuery,
    useRecalculateRatingsMutation,
    useGetMetaStatsQuery,
    useGetPlayerStatsQuery,
    useGetDeckStatsQuery,
    useGetPlayerProfileQuery,
    useGetAdminSettingsQuery,
    useSaveAdminSettingsMutation,
    useResetAdminSettingsMutation,
    useListEventsQuery,
    useGetEventDetailQuery,
    useCreateTournamentMutation,
    useTournamentActionMutation,
    useGetTournamentHistoryQuery,
    useExportTournamentMutation,
    useGetMyTournamentMatchesQuery,
    useSubmitBugReportMutation,
    useGetBugReportsQuery,
    useSetBugReportStatusMutation,
    useGetFriendsQuery,
    useFriendActionMutation,
    useGetMembersQuery,
    useGetClubsQuery,
    useGetClubQuery,
    useCreateClubMutation,
    useClubActionMutation,
    useJoinClubByCodeMutation,
    // ARCHON: named club invitations
    useGetClubInvitationsQuery,
    useInviteToClubMutation,
    useRespondToClubInvitationMutation,
    // ARCHON (N7): club competition and teams
    useGetClubLeaderboardQuery,
    useDecideClubJoinRequestMutation,
    useGetTeamsQuery,
    useGetTeamQuery,
    useGetMyTeamsQuery,
    useGetTeamLeaderboardQuery,
    useCreateTeamMutation,
    useJoinTeamByCodeMutation,
    useTeamActionMutation,
    // ARCHON (N13): in-person games
    useGetInPersonGamesQuery,
    useGetInPersonGameQuery,
    useCreateInPersonGameMutation,
    useInPersonGameActionMutation,
    useGetClubInPersonGamesQuery,
    // ARCHON (N5): reports and moderation
    useGetModerationOptionsQuery,
    useSubmitReportMutation,
    useGetMyRestrictionsQuery,
    useGetModerationQueueQuery,
    useModerationReportActionMutation,
    useModerationActMutation,
    useRevokeModerationActionMutation,
    useGetPlayerModerationHistoryQuery,
    useGetModerationAuditQuery,
    // ARCHON (N8): admin analytics
    useGetAnalyticsQuery,
    // ARCHON (N9): Adaptive Bo3 and kiosk check-in
    useGetAdaptiveStateQuery,
    useCheckInByCodeMutation,
    useGetStoresQuery,
    useAddStoreMutation,
    useRemoveStoreMutation,
    useCompleteOnboardingMutation,
    useSetAvatarMutation,
    useUnlinkPatreonMutation,
    useGetCardsQuery,
    useGetFactionsQuery,
    useGetDecksQuery,
    useGetDeckQuery,
    useDeleteDeckMutation,
    useDeleteDecksMutation,
    useSaveDeckMutation,
    usePrepareDokImportMutation,
    useSearchDeckCatalogQuery,
    useQueueDeckImportMutation,
    useGetDeckImportStatusQuery,
    useCancelDeckImportMutation,
    useGetDokLinkQuery,
    useSyncDokNowMutation,
    useForgetDokLinkMutation,
    useSaveAllianceDeckMutation,
    useGetStandaloneDecksQuery,
    useRefreshAccoladesMutation,
    useUpdateAccoladeShownMutation,
    useGetActiveSessionsQuery,
    useRemoveSessionMutation,
    useGetBlockListQuery,
    useAddBlockListEntryMutation,
    useRemoveBlockListEntryMutation,
    useSaveProfileMutation,
    useDeleteAccountMutation,
    useFindUserQuery,
    useSaveUserMutation,
    useAdminResetPasswordMutation,
    useAdminDeleteUserMutation,
    useVerifyDeckMutation,
    useVerifyAllDecksMutation,
    useGetBanlistQuery,
    useAddBanlistMutation,
    useDeleteBanlistMutation,
    useGetUserGamesQuery,
    useGetGameFiltersQuery,
    useGetGameReplayQuery,
    useGetSharedReplayQuery,
    useGetGameReplayAnalysisQuery,
    useGetSharedReplayAnalysisQuery,
    useGetReplayIntelligenceQuery,
    useShareReplayMutation,
    useUnshareReplayMutation,
    useGetNotificationsQuery,
    useGetUnreadNotificationCountQuery,
    useMarkNotificationsReadMutation,
    useGetNotificationPreferencesQuery,
    useSetNotificationPreferenceMutation,
    useGetGameRatingQuery,
    useRemoveLobbyMessageMutation
} = api;

export default api;
