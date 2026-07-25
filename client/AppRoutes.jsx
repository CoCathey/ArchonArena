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
import Onboarding from './pages/Onboarding';
import TopPlayers from './pages/TopPlayers';
import Ratings from './pages/Ratings';
import PlayIrl from './pages/PlayIrl';
import MotdAdmin from './pages/MotdAdmin';
import NewsAdmin from './pages/NewsAdmin';
import NodesAdmin from './pages/NodesAdmin';
import NotFound from './pages/NotFound';
import Patreon from './pages/Patreon';
import Privacy from './pages/Privacy';
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
            <Route path='/patreon' element={<Patreon code={getParam('code')} />} />
            {/* ARCHON: game history + community news are live features */}
            <Route path='/matches' element={<Matches />} />
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
            <Route
                path='/stats'
                element={
                    <Placeholder
                        title='Stats'
                        description='Win rates by house and set, key rates, deck performance, and meta dashboards are coming with the statistics engine.'
                    />
                }
            />
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
            <Route
                path='/watch'
                element={
                    <Placeholder
                        title='Watch'
                        description='Spectating live games, featured matches, and replays are coming with the replay system.'
                    />
                }
            />
            <Route path='/welcome' element={<Onboarding />} />
            <Route path='/community/friends' element={<Friends />} />
            <Route path='/community/clubs' element={<Clubs />} />
            <Route path='/community/clubs/:id' element={<ClubDetail />} />
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
