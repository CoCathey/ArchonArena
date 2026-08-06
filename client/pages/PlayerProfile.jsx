import React from 'react';
import { useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import moment from 'moment';

import Panel from '../Components/Site/Panel';
import Link from '../Components/Navigation/Link';
import Avatar from '../Components/Site/Avatar';
import AmberValue from '../Components/Site/AmberValue';
// ARCHON (N5): reporting
import ReportButton from '../Components/Site/ReportButton';
import {
    useGetPlayerProfileQuery,
    useGetPlayerStatsQuery,
    useGetRatingsQuery,
    useGetTournamentHistoryQuery
} from '../redux/api';

const POOL_LABELS = {
    archon: 'Archon',
    sealed: 'Sealed',
    alliance: 'Alliance'
};

const MEDALS = { 1: '🥇', 2: '🥈', 3: '🥉' };
// ARCHON (N4): the same medals for season podiums; everything else gets a dot.
const SEASON_MEDALS = MEDALS;
// A finish outside this many places is a line in the season table rather than
// a badge on the profile - a wall of "#312 in season 4" is not an achievement.
const SEASON_BADGE_LIMIT = 10;

/**
 * ARCHON: public player profile (`/players/:username`).
 *
 * The platform had no player page at all, so no username anywhere on the site
 * was clickable - a competitive community with leaderboards, tournaments and
 * clubs that you could not click through from. This is the page every one of
 * those surfaces now links to.
 *
 * It composes four already-public endpoints rather than adding a new aggregate:
 * profile header + clubs + recent games (/api/players), Amber (/api/ratings),
 * win rates (/api/stats) and trophies (/api/tournaments/history). Each panel
 * renders as soon as its own query lands and degrades on its own if that data
 * is missing, so a brand-new player with no games still gets a working page.
 */
const PlayerProfile = () => {
    const { t } = useTranslation();
    const { username } = useParams();

    const { data, isFetching, isError } = useGetPlayerProfileQuery(username, { skip: !username });
    const { data: ratingsData } = useGetRatingsQuery(username, { skip: !username });
    const { data: statsData } = useGetPlayerStatsQuery(username, { skip: !username });
    const { data: historyData } = useGetTournamentHistoryQuery(username, { skip: !username });

    const profile = data?.profile;
    const ratings = ratingsData?.ratings || [];
    const stats = statsData?.stats;
    const events = historyData?.events || [];

    if (isFetching) {
        return <div className='py-10 text-center text-muted'>{t('Loading…')}</div>;
    }

    if (isError || !profile) {
        return (
            <div className='mx-auto w-full max-w-3xl'>
                <Panel title={t('Player')}>
                    <p className='text-sm text-muted'>
                        {t('No player named {{username}}.', { username })}{' '}
                        <Link href='/community/members' className='text-amber-300 underline'>
                            {t('Browse members')}
                        </Link>
                    </p>
                </Panel>
            </div>
        );
    }

    const location = [profile.state, profile.country].filter(Boolean).join(', ');
    const podiums = events.filter((event) => event.placement && event.placement <= 3);
    // Ranked top finishes only, newest season first.
    const seasonBadges = (ratingsData?.seasonHistory || []).filter(
        (entry) => entry.rank && entry.rank <= SEASON_BADGE_LIMIT
    );

    return (
        <div className='mx-auto w-full max-w-3xl space-y-4'>
            <Panel title={profile.username}>
                <div className='flex items-center gap-3'>
                    <Avatar imgPath={profile.avatar} />
                    <div className='min-w-0'>
                        <div className='text-lg font-semibold text-foreground'>
                            {profile.username}
                        </div>
                        <div className='flex flex-wrap gap-x-3 text-xs text-muted'>
                            {location && <span>{location}</span>}
                            {profile.joined && (
                                <span>
                                    {t('Joined {{date}}', {
                                        date: moment(profile.joined).format('MMMM YYYY')
                                    })}
                                </span>
                            )}
                            {profile.clubs?.length > 0 && (
                                <span>
                                    {profile.clubs.map((club, index) => (
                                        <React.Fragment key={club.id}>
                                            {index > 0 && ', '}
                                            <Link
                                                href={`/community/clubs/${club.id}`}
                                                className='text-amber-300 hover:underline'
                                            >
                                                {club.name}
                                            </Link>
                                        </React.Fragment>
                                    ))}
                                </span>
                            )}
                        </div>
                    </div>
                </div>
                {/* ARCHON (I3): optional short bio */}
                {profile.bio && (
                    <p className='mt-3 whitespace-pre-wrap text-sm text-foreground'>
                        {profile.bio}
                    </p>
                )}
                {/* ARCHON (N5): report from the surface where the problem
                    appears. Below the header row rather than inside it, so the
                    form has the full panel width when it opens. */}
                <div className='mt-2'>
                    <ReportButton targetType='player' targetUsername={profile.username} />
                </div>
            </Panel>

            {ratings.length > 0 && (
                <Panel title={t('Amber')}>
                    <div className='grid gap-3 sm:grid-cols-3'>
                        {ratings.map((rating) => (
                            <div
                                key={rating.pool}
                                className='rounded-lg border border-border/60 bg-surface-secondary/50 px-4 py-3'
                            >
                                <div className='text-xs uppercase tracking-wide text-muted'>
                                    {t(POOL_LABELS[rating.pool] || rating.pool)}
                                </div>
                                <AmberValue value={rating.rating} className='text-xl' />
                                <div className='mt-0.5 text-xs text-muted'>
                                    {rating.provisional
                                        ? t('Provisional · {{games}} games', {
                                              games: rating.gamesPlayed
                                          })
                                        : t('#{{rank}} of {{total}} · {{wins}}-{{losses}}', {
                                              rank: rating.rank,
                                              total: rating.totalRated,
                                              wins: rating.wins,
                                              losses: rating.losses
                                          })}
                                </div>
                            </div>
                        ))}
                    </div>
                </Panel>
            )}

            {stats?.overall?.games > 0 && (
                <Panel title={t('Record')}>
                    <div className='flex flex-wrap gap-x-6 gap-y-1 text-sm'>
                        <span className='text-foreground'>
                            {t('{{wins}}W - {{losses}}L', {
                                wins: stats.overall.wins,
                                losses: stats.overall.losses
                            })}
                        </span>
                        {stats.overall.winRate != null && (
                            <span className='text-muted'>
                                {t('{{rate}}% win rate', { rate: stats.overall.winRate })}
                            </span>
                        )}
                        {stats.overall.avgKeys != null && (
                            <span className='text-muted'>
                                {t('{{keys}} keys per game', { keys: stats.overall.avgKeys })}
                            </span>
                        )}
                    </div>
                    {stats.houses?.length > 0 && (
                        <div className='mt-2 flex flex-wrap gap-2 text-xs text-muted'>
                            {stats.houses.slice(0, 6).map((house) => (
                                <span
                                    key={house.house}
                                    className='rounded bg-surface-secondary/60 px-2 py-0.5'
                                >
                                    {house.house} {house.winRate}%
                                </span>
                            ))}
                        </div>
                    )}
                </Panel>
            )}

            {/* ARCHON (N4): season finishes. Sourced from the standings
                archived when each season ended, so a badge keeps meaning what
                it meant even though the ladder behind it is long gone. Only
                ranked finishes earn one - "unranked in season 2" is not a
                badge. */}
            {seasonBadges.length > 0 && (
                <Panel title={t('Season finishes')}>
                    <div className='flex flex-wrap gap-2'>
                        {seasonBadges.map((entry) => (
                            <div
                                key={`${entry.season}-${entry.pool}`}
                                className='rounded-md border border-border/55 bg-surface-secondary/40 px-3 py-1.5 text-sm'
                                title={t('{{games}} rated games', { games: entry.gamesPlayed })}
                            >
                                <span className='mr-1'>{SEASON_MEDALS[entry.rank] || '•'}</span>
                                <span className='font-semibold text-foreground'>
                                    {t('S{{season}}', { season: entry.season })}
                                </span>{' '}
                                <span className='text-muted'>
                                    {t(POOL_LABELS[entry.pool] || entry.pool)} · #{entry.rank}
                                </span>
                            </div>
                        ))}
                    </div>
                </Panel>
            )}

            {podiums.length > 0 && (
                <Panel title={t('Trophies')}>
                    <ul className='space-y-1 text-sm'>
                        {podiums.map((event) => (
                            <li key={event.id}>
                                <span className='mr-1'>{MEDALS[event.placement]}</span>
                                <Link
                                    href={`/tournaments/${event.id}`}
                                    className='text-amber-300 hover:underline'
                                >
                                    {event.name}
                                </Link>
                            </li>
                        ))}
                    </ul>
                </Panel>
            )}

            <Panel title={t('Recent games')}>
                {profile.recentGames.length === 0 ? (
                    <p className='text-sm text-muted'>{t('No finished games yet.')}</p>
                ) : (
                    <ul className='divide-y divide-border/40 text-sm'>
                        {profile.recentGames.map((game) => (
                            <li
                                key={game.gameId}
                                className='flex flex-wrap items-center gap-x-3 py-1.5'
                            >
                                <span
                                    className={`w-12 shrink-0 font-semibold ${
                                        game.won ? 'text-emerald-300' : 'text-rose-300'
                                    }`}
                                >
                                    {game.won ? t('Win') : t('Loss')}
                                </span>
                                <span className='text-muted'>
                                    {game.keys}-{game.opponentKeys}
                                </span>
                                {game.opponent && (
                                    <Link
                                        href={`/players/${encodeURIComponent(game.opponent)}`}
                                        className='text-amber-300 hover:underline'
                                    >
                                        {game.opponent}
                                    </Link>
                                )}
                                {game.deckName && (
                                    <span className='min-w-0 truncate text-xs text-muted'>
                                        {game.deckName}
                                    </span>
                                )}
                                <Link
                                    href={`/replay/${encodeURIComponent(game.gameId)}`}
                                    className='ml-auto text-xs text-muted hover:text-amber-300'
                                >
                                    {t('Replay')}
                                </Link>
                            </li>
                        ))}
                    </ul>
                )}
            </Panel>
        </div>
    );
};

PlayerProfile.displayName = 'PlayerProfile';

export default PlayerProfile;
