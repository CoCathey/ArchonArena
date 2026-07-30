import React from 'react';
import { useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

import Panel from '../Components/Site/Panel';
import Link from '../Components/Navigation/Link';
import ReplayViewer from '../Components/GameBoard/ReplayViewer';
import { useGetGameReplayQuery } from '../redux/api';

/**
 * ARCHON: replay viewer for a game you can already see (signed in).
 *
 * The viewer itself lives in ReplayViewer so the public share route renders
 * exactly the same thing; this page only fetches and handles the not-found
 * case.
 */
const Replay = () => {
    const { t } = useTranslation();
    const { gameId } = useParams();
    const { data, isFetching, isError } = useGetGameReplayQuery(gameId, { skip: !gameId });

    if (isFetching) {
        return <div className='py-10 text-center text-muted'>{t('Loading replay…')}</div>;
    }

    if (isError || !data?.replay) {
        return (
            <div className='mx-auto w-full max-w-3xl'>
                <Panel title={t('Replay')}>
                    <p className='text-sm text-muted'>
                        {t('No replay is available for this game.')}{' '}
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
