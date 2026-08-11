import React from 'react';
import { useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

import Panel from '../Components/Site/Panel';
import Link from '../Components/Navigation/Link';
import ReplayViewer from '../Components/GameBoard/ReplayViewer';
import { replayUnavailable } from '../Components/GameBoard/replayUnavailable';
import { useGetGameReplayQuery } from '../redux/api';

/**
 * ARCHON: replay viewer for one of your own games (signed in).
 *
 * The viewer itself lives in ReplayViewer so the public share route renders
 * exactly the same thing; this page only fetches and explains why there is
 * nothing to show when there is not.
 */
const Replay = () => {
    const { t } = useTranslation();
    const { gameId } = useParams();
    const { data, isFetching, isError, error } = useGetGameReplayQuery(gameId, { skip: !gameId });

    if (isFetching) {
        return <div className='py-10 text-center text-muted'>{t('Loading replay…')}</div>;
    }

    if (isError || !data?.replay) {
        const { key, isOwnershipProblem } = replayUnavailable(error);

        return (
            <div className='mx-auto w-full max-w-3xl'>
                <Panel title={t('Replay')}>
                    <p className='text-sm text-muted'>{t(key)}</p>
                    {isOwnershipProblem && (
                        <p className='mt-2 text-sm text-muted'>
                            {t(
                                'Ask one of the players for a share link - they can create one from their own replay.'
                            )}
                        </p>
                    )}
                    <p className='mt-3 text-sm'>
                        <Link href='/matches' className='text-amber-300 underline'>
                            {t('Back to Game History')}
                        </Link>
                    </p>
                </Panel>
            </div>
        );
    }

    return <ReplayViewer replay={data.replay} gameId={gameId} canShare={!!data.canShare} />;
};

Replay.displayName = 'Replay';

export default Replay;
