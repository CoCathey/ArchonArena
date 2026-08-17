import React from 'react';
import { Navigate, Route, Routes, useSearchParams } from 'react-router-dom';

import About from './pages/About';
import Activation from './pages/Activation';
import AllianceBuilderPage from './pages/AllianceBuilder';
import BanlistAdmin from './pages/BanlistAdmin';
import BlockList from './pages/BlockList';
import Decks from './pages/Decks';
import ForgotPassword from './pages/ForgotPassword';
import HowToPlay from './pages/HowToPlay';
// ARCHON (N11): the Learn hub and its interactive Learn-to-Play tutorial
import Learn from './pages/Learn';
import Lobby from './pages/Lobby';
import Login from './pages/LoginContainer';
import Logout from './pages/Logout';
// ARCHON: new navigation targets
import CommunityNews from './pages/CommunityNews';
import ContentPageGuard from './Components/Navigation/ContentPageGuard';
// ARCHON (N9): the kiosk QR's landing page - see pages/CheckIn.jsx
import CheckIn from './pages/CheckIn';
import Replay from './pages/Replay';
import SharedReplay from './pages/SharedReplay';
import Stats from './pages/Stats';
import Leaderboards from './pages/Leaderboards';
import Matches from './pages/Matches';
import Placeholder from './pages/Placeholder';
import BugReportsAdmin from './pages/BugReportsAdmin';
import Tournaments from './pages/Tournaments';
import TournamentDetail from './pages/TournamentDetail';
import Friends from './pages/Friends';
import Members from './pages/Members';
import Clubs from './pages/Clubs';
import ClubDetail from './pages/ClubDetail';
// ARCHON (N7): teams and team events
import Teams from './pages/Teams';
import TeamDetail from './pages/TeamDetail';
// ARCHON (N13): in-person (paper) game tracking
import InPersonGames from './pages/InPersonGames';
// ARCHON (N8): admin operations dashboard
import AnalyticsAdmin from './pages/AnalyticsAdmin';
// ARCHON (N5): reports and the moderation queue
import ModerationQueue from './pages/ModerationQueue';
import Onboarding from './pages/Onboarding';
import PlayerProfile from './pages/PlayerProfile';
import PlayIrl from './pages/PlayIrl';
import MotdAdmin from './pages/MotdAdmin';
import NewsAdmin from './pages/NewsAdmin';
import NodesAdmin from './pages/NodesAdmin';
import NotFound from './pages/NotFound';
import Patreon from './pages/Patreon';
// ARCHON (N12): premium membership
import Membership from './pages/Membership';
import ArchonIntelligence from './pages/ArchonIntelligence';
import DeepProbe from './pages/DeepProbe';
// ARCHON (N18): the Champion’s Challenge - Vault Master background deck testing
import ChampionsChallenge from './pages/ChampionsChallenge';
import Privacy from './pages/Privacy';
import Terms from './pages/Terms';
import Watch from './pages/Watch';
import Profile from './pages/Profile';
import Register from './pages/Register';
import ResetPassword from './pages/ResetPassword';
import Security from './pages/Security.jsx';
import SettingsAdmin from './pages/SettingsAdmin';
import BotAdmin from './pages/BotAdmin';
import Unauthorised from './pages/Unauthorised';
import UserAdmin from './pages/UserAdmin';
import GameLobby from './Components/Games/GameLobby';
import GameBoard from './Components/GameBoard/GameBoard.jsx';

/**
 * The leaderboards live under /community now (they were briefly under
 * /stats). Season history links carry `?season=N`, so this preserves the
 * query rather than dropping a player on the live ladder when they asked for
 * an archived one.
 */
const LeaderboardsRedirect = () => {
    const [searchParams] = useSearchParams();
    const search = searchParams.toString();

    return <Navigate to={`/community/leaderboards${search ? `?${search}` : ''}`} replace />;
};

LeaderboardsRedirect.displayName = 'LeaderboardsRedirect';

const AppRoutes = ({ currentGame, user }) => {
    const [searchParams] = useSearchParams();
    const getParam = (key) => searchParams.get(key) || undefined;

    const requirePermission = (permission, element) => {
        if (!permission) {
            return element;
        }

        if (!user || !user.permissions?.[permission]) {
            return <Unauthorised />;
        }

        return element;
    };

    return (
        <Routes>
            <Route path='/' element={<Lobby />} />
            <Route path='/about' element={<About />} />
            <Route
                path='/activation'
                element={<Activation id={getParam('id')} token={getParam('token')} />}
            />
            <Route path='/blocklist' element={<BlockList />} />
            <Route path='/decks' element={<Decks />} />
            <Route path='/decks/alliance' element={<AllianceBuilderPage />} />
            <Route path='/forgot' element={<ForgotPassword />} />
            <Route path='/how-to-play' element={<HowToPlay />} />
            <Route path='/login' element={<Login />} />
            <Route path='/logout' element={<Logout />} />
            <Route path='/news' element={requirePermission('canEditNews', <NewsAdmin />)} />
            <Route
                path='/play'
                element={
                    currentGame?.started ? <GameBoard /> : <GameLobby gameId={getParam('gameId')} />
                }
            />
            <Route path='/profile' element={<Profile />} />
            <Route path='/register' element={<Register />} />
            <Route
                path='/reset-password'
                element={<ResetPassword id={getParam('id')} token={getParam('token')} />}
            />
            <Route path='/security' element={<Security />} />
            <Route path='/users' element={requirePermission('canManageUsers', <UserAdmin />)} />
            <Route path='/nodes' element={requirePermission('canManageNodes', <NodesAdmin />)} />
            <Route path='/privacy' element={<Privacy />} />
            <Route path='/terms' element={<Terms />} />
            <Route
                path='/banlist'
                element={requirePermission(
                    'canManageBanlist',
                    <BanlistAdmin permission='canManageBanlist' />
                )}
            />
            <Route path='/admin/motd' element={requirePermission('canManageMotd', <MotdAdmin />)} />
            <Route
                path='/admin/bug-reports'
                element={requirePermission('isAdmin', <BugReportsAdmin />)}
            />
            {/* ARCHON: runtime site settings (admin only) */}
            <Route
                path='/admin/settings'
                element={requirePermission('isAdmin', <SettingsAdmin />)}
            />
            {/* ARCHON (F9): the practice bot roster (admin only) */}
            <Route path='/admin/bots' element={requirePermission('isAdmin', <BotAdmin />)} />
            {/* ARCHON (N8): operations dashboard (admin only) */}
            <Route
                path='/admin/analytics'
                element={requirePermission('isAdmin', <AnalyticsAdmin />)}
            />
            {/* ARCHON (N5): the moderation queue. canModerateChat, not
                isAdmin - the whole point is that moderation can be delegated
                without handing over the site. */}
            <Route
                path='/admin/moderation'
                element={requirePermission('canModerateChat', <ModerationQueue />)}
            />
            {/* ARCHON (N12): membership pricing + the premium tools. All three
                render for everyone; the premium ones show their value
                proposition and a locked state rather than 404ing, which is
                what makes them an upgrade moment instead of a dead end. */}
            <Route path='/membership' element={<Membership />} />
            <Route path='/intelligence' element={<ArchonIntelligence />} />
            <Route path='/deep-probe' element={<DeepProbe />} />
            <Route path='/champions-challenge' element={<ChampionsChallenge />} />
            {/* ARCHON (N12): Patreon's OAuth callback. `state` is checked
                server-side against a signed cookie; `error` is set when the
                player declined on Patreon's consent screen. */}
            <Route
                path='/patreon'
                element={
                    <Patreon
                        code={getParam('code')}
                        state={getParam('state')}
                        error={getParam('error')}
                    />
                }
            />
            {/* ARCHON: game history + community news are live features */}
            <Route path='/matches' element={<Matches />} />
            {/* ARCHON: public player profile - every username on the site links here */}
            <Route path='/players/:username' element={<PlayerProfile />} />
            {/* ARCHON (N1): public share link. Registered before the
                parameterised replay route so 'shared' is never read as a
                game id. */}
            <Route path='/replay/shared/:token' element={<SharedReplay />} />
            <Route path='/replay/:gameId' element={<Replay />} />
            <Route
                path='/community/news'
                element={
                    <ContentPageGuard pageKey='news'>
                        <CommunityNews />
                    </ContentPageGuard>
                }
            />
            {/* ARCHON: placeholders for roadmap features (see ROADMAP.md) */}
            <Route path='/play-irl' element={<PlayIrl />} />
            {/* ARCHON (N13): record a game played across a table */}
            <Route path='/play/in-person' element={<InPersonGames />} />
            <Route path='/play/in-person/:id' element={<InPersonGames />} />
            <Route
                path='/mobile/ios'
                element={
                    <Placeholder
                        title='iPhone App'
                        description='The Archon Arena iPhone app is on its way to the App Store. Until then, the site works great in Safari on your phone.'
                    />
                }
            />
            <Route
                path='/mobile/android'
                element={
                    <Placeholder
                        title='Android App'
                        description='The Archon Arena Android app is on its way to Google Play. Until then, the site works great in Chrome on your phone.'
                    />
                }
            />
            {/* ARCHON: the statistics pages - site stats, your own Amber, and
                the rankings - used to be scattered across Play, Community and
                two top-level tabs. Your Amber and the meta are one page now
                (/stats, opening on your own numbers), and the rankings sit in
                Community with the other people-shaped pages.

                Every former path still resolves: they are linked from
                profiles, the About page and anywhere a player has bookmarked
                them, and a dead link is a worse outcome than a redirect nobody
                notices. `replace` keeps the old URL out of history, so Back
                does not bounce through it. /stats/me is not a redirect - it
                still names a real view, the overview's first tab. */}
            <Route path='/stats' element={<Stats />} />
            <Route path='/stats/me' element={<Stats />} />
            <Route path='/stats/leaderboards' element={<LeaderboardsRedirect />} />
            <Route path='/stats/top-players' element={<LeaderboardsRedirect />} />
            <Route path='/tournaments' element={<Tournaments />} />
            <Route path='/tournaments/:id' element={<TournamentDetail />} />
            {/* ARCHON (N9): what the printed check-in QR points at. Both
                forms exist because the poster advertises both: the scan
                carries the code, and the card next to it tells players
                they can type it instead. */}
            <Route path='/check-in' element={<CheckIn />} />
            <Route path='/check-in/:code' element={<CheckIn />} />
            <Route path='/learn' element={<Learn />} />
            <Route path='/watch' element={<Watch />} />
            <Route path='/welcome' element={<Onboarding />} />
            <Route path='/community/friends' element={<Friends />} />
            <Route path='/community/clubs' element={<Clubs />} />
            <Route path='/community/clubs/:id' element={<ClubDetail />} />
            {/* ARCHON (N7): teams */}
            <Route path='/community/teams' element={<Teams />} />
            <Route path='/community/teams/:id' element={<TeamDetail />} />
            <Route path='/community/members' element={<Members />} />
            <Route path='/community/leaderboards' element={<Leaderboards />} />
            {/* Former homes of the ranking pages. A query string on a
                leaderboard link (?season=3, from the season history) has to
                survive the move, so those carry their search through. */}
            <Route path='/community/top-players' element={<LeaderboardsRedirect />} />
            <Route path='/community/ratings' element={<Navigate to='/stats/me' replace />} />
            <Route path='/leaderboards' element={<LeaderboardsRedirect />} />
            <Route
                path='/community/articles'
                element={
                    <ContentPageGuard pageKey='articles'>
                        <Placeholder
                            title='Articles'
                            description='Strategy articles and community content are planned.'
                        />
                    </ContentPageGuard>
                }
            />
            <Route
                path='/community/blogs'
                element={
                    <ContentPageGuard pageKey='blogs'>
                        <Placeholder
                            title='Blogs'
                            description='Player blogs are planned as part of community features.'
                        />
                    </ContentPageGuard>
                }
            />
            <Route
                path='/community/forums'
                element={
                    <ContentPageGuard pageKey='forums'>
                        <Placeholder
                            title='Forums'
                            description='Discussion forums are planned as part of community features.'
                        />
                    </ContentPageGuard>
                }
            />
            <Route path='*' element={<NotFound />} />
        </Routes>
    );
};

export default AppRoutes;
