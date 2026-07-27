import React, { useMemo } from 'react';
import { useSelector } from 'react-redux';
import { useTranslation } from 'react-i18next';

import Panel from '../Components/Site/Panel';
import Link from '../Components/Navigation/Link';
import GameList from '../Components/Games/GameList';
import AlertPanel from '../Components/Site/AlertPanel';

/**
 * ARCHON: Watch — games happening right now.
 *
 * `/watch` was a placeholder even though the lobby has always been able to
 * spectate; the games were simply mixed in with the joinable ones and there was
 * nowhere to send someone who just wants to watch.
 *
 * This is deliberately a filtered view over the same live lobby state rather
 * than a new data path: started, spectatable, non-private games only. Reusing
 * GameList means the spectate button, password handling and permission checks
 * behave exactly as they do in the lobby.
 */
const Watch = () => {
    const { t } = useTranslation();
    const games = useSelector((state) => state.lobby.games);
    const user = useSelector((state) => state.account.user);

    const liveGames = useMemo(
        () =>
            (games || []).filter(
                (game) => game.started && game.allowSpectators && !game.gamePrivate
            ),
        [games]
    );

    // GameList hides any format without a filter entry, so watching must opt
    // every currently-offered format in.
    const watchFilter = useMemo(
        () => ({ normal: true, sealed: true, 'adaptive-bo1': true, alliance: true }),
        []
    );

    return (
        <div className='mx-auto w-full max-w-4xl space-y-4'>
            <Panel title={t('Watch')}>
                <p className='text-sm text-muted'>
                    {t(
                        'Games being played right now. Anyone can watch — you do not need to be logged in to follow along.'
                    )}
                </p>
            </Panel>

            {liveGames.length === 0 ? (
                <AlertPanel
                    type='info'
                    message={t(
                        'No games are in progress right now. Finished games can be watched from Game History as replays.'
                    )}
                />
            ) : (
                <GameList gameFilter={watchFilter} games={liveGames} />
            )}

            <Panel title={t('Replays')}>
                <p className='text-sm text-muted'>
                    {t('Every finished game is recorded and can be replayed move by move.')}{' '}
                    {user ? (
                        <Link href='/matches' className='text-amber-300 underline'>
                            {t('Your game history')}
                        </Link>
                    ) : (
                        <Link href='/login' className='text-amber-300 underline'>
                            {t('Log in to see your games')}
                        </Link>
                    )}
                </p>
            </Panel>
        </div>
    );
};

Watch.displayName = 'Watch';

export default Watch;
