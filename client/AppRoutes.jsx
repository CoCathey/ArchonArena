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
import Matches from './pages/Matches';
import Placeholder from './pages/Placeholder';
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
import TournamentLobby from './Components/Games/TournamentLobby';
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
            <Route
                path='/tournamentlobby'
                element={requirePermission('canManageTournaments', <TournamentLobby />)}
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
            <Route path='/patreon' element={<Patreon code={getParam('code')} />} />
            {/* ARCHON: game history + community news are live features */}
            <Route path='/matches' element={<Matches />} />
            <Route path='/community/news' element={<CommunityNews />} />
            {/* ARCHON: placeholders for roadmap features (see ROADMAP.md) */}
            <Route
                path='/play-irl'
                element={
                    <Placeholder
                        title='Play IRL'
                        description='In-person play tools - result slips, QR join codes, and paired seating for live events - arrive with the tournament engine.'
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
            <Route
                path='/tournaments'
                element={
                    <Placeholder
                        title='Tournaments'
                        description='Swiss and bracket events, online and in person, with automatic pairings and results are on the way.'
                    />
                }
            />
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
            <Route
                path='/community/friends'
                element={
                    <Placeholder
                        title='Friends'
                        description='Friends lists and presence are coming with player profiles.'
                    />
                }
            />
            <Route
                path='/community/clubs'
                element={
                    <Placeholder
                        title='Clubs'
                        description='Clubs for local scenes and stores - membership, club pages, and club leaderboards - are on the roadmap.'
                    />
                }
            />
            <Route
                path='/community/members'
                element={
                    <Placeholder
                        title='Members'
                        description='A searchable member directory is coming with player profiles.'
                    />
                }
            />
            <Route
                path='/community/top-players'
                element={
                    <Placeholder
                        title='Top Players'
                        description='The best Archon Arena players by rating, updated live, arrive with rankings.'
                    />
                }
            />
            <Route
                path='/community/ratings'
                element={
                    <Placeholder
                        title='Ratings'
                        description='How the Archon Arena rating system works: chess-style Elo adjusted by deck SAS and key differential. A full explainer is coming.'
                    />
                }
            />
            <Route
                path='/leaderboards'
                element={
                    <Placeholder
                        title='Leaderboards'
                        description='Worldwide, regional, country, and state rankings are being built right now.'
                    />
                }
            />
            <Route
                path='/community/articles'
                element={
                    <Placeholder
                        title='Articles'
                        description='Strategy articles and community content are planned.'
                    />
                }
            />
            <Route
                path='/community/blogs'
                element={
                    <Placeholder
                        title='Blogs'
                        description='Player blogs are planned as part of community features.'
                    />
                }
            />
            <Route
                path='/community/forums'
                element={
                    <Placeholder
                        title='Forums'
                        description='Discussion forums are planned as part of community features.'
                    />
                }
            />
            <Route path='*' element={<NotFound />} />
        </Routes>
    );
};

export default AppRoutes;
