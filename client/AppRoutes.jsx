import React from 'react';
import { Route, Routes, useSearchParams } from 'react-router-dom';

import About from './pages/About';
import Activation from './pages/Activation';
import AllianceBuilderPage from './pages/AllianceBuilder';
import BanlistAdmin from './pages/BanlistAdmin';
import BlockList from './pages/BlockList';
import Decks from './pages/Decks';
import ForgotPassword from './pages/ForgotPassword';
import HowToPlay from './pages/HowToPlay';
import Lobby from './pages/Lobby';
import Login from './pages/LoginContainer';
import Logout from './pages/Logout';
// ARCHON: new navigation targets
import CommunityNews from './pages/CommunityNews';
import ContentPageGuard from './Components/Navigation/ContentPageGuard';
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
import TopPlayers from './pages/TopPlayers';
import Ratings from './pages/Ratings';
import PlayerProfile from './pages/PlayerProfile';
import PlayIrl from './pages/PlayIrl';
import MotdAdmin from './pages/MotdAdmin';
import NewsAdmin from './pages/NewsAdmin';
import NodesAdmin from './pages/NodesAdmin';
import NotFound from './pages/NotFound';
import Patreon from './pages/Patreon';
import Privacy from './pages/Privacy';
import Terms from './pages/Terms';
import Watch from './pages/Watch';
import Profile from './pages/Profile';
import Register from './pages/Register';
import ResetPassword from './pages/ResetPassword';
import Security from './pages/Security.jsx';
import SettingsAdmin from './pages/SettingsAdmin';
import Unauthorised from './pages/Unauthorised';
import UserAdmin from './pages/UserAdmin';
import GameLobby from './Components/Games/GameLobby';
import GameBoard from './Components/GameBoard/GameBoard.jsx';

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
            <Route path='/stats' element={<Stats />} />
            <Route path='/tournaments' element={<Tournaments />} />
            <Route path='/tournaments/:id' element={<TournamentDetail />} />
            <Route
                path='/learn'
                element={
                    <Placeholder
                        title='Learn'
                        description='Guides, strategy content, and interactive learning tools are planned. For now, check How To Play under Other.'
                    />
                }
            />
            <Route path='/watch' element={<Watch />} />
            <Route path='/welcome' element={<Onboarding />} />
            <Route path='/community/friends' element={<Friends />} />
            <Route path='/community/clubs' element={<Clubs />} />
            <Route path='/community/clubs/:id' element={<ClubDetail />} />
            {/* ARCHON (N7): teams */}
            <Route path='/community/teams' element={<Teams />} />
            <Route path='/community/teams/:id' element={<TeamDetail />} />
            <Route path='/community/members' element={<Members />} />
            <Route path='/community/top-players' element={<TopPlayers />} />
            <Route path='/community/ratings' element={<Ratings />} />
            <Route path='/leaderboards' element={<Leaderboards />} />
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
