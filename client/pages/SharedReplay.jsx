import React from 'react';
import { useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

import Panel from '../Components/Site/Panel';
import Link from '../Components/Navigation/Link';
import ReplayViewer from '../Components/GameBoard/ReplayViewer';
import { useGetSharedReplayQuery } from '../redux/api';

/**
 * ARCHON (N1): a replay someone shared a link to.
 *
 * Public - no sign-in, and no "log in to see this" wall, which would defeat the
 * point of sending someone a game. It is safe because the recording is
 * spectator-safe by construction: the snapshots are rendered through the same
 * AnonymousSpectator path that protects live spectators, so a share link can
 * never reveal more than watching the game would have.
 */
const SharedReplay = () => {
    const { t } = useTranslation();
    const { token } = useParams();
    const { data, isFetching, isError } = useGetSharedReplayQuery(token, { skip: !token });

    if (isFetching) {
        return <div className='py-10 text-center text-muted'>{t('Loading replay…')}</div>;
    }

    if (isError || !data?.replay) {
        return (
            <div className='mx-auto w-full max-w-3xl'>
                <Panel title={t('Replay')}>
                    <p className='text-sm text-muted'>
                        {t(
                            'This share link is not valid any more. The players may have stopped sharing this game.'
                        )}{' '}
                        <Link href='/watch' className='text-amber-300 underline'>
                            {t('Watch a live game instead')}
                        </Link>
                    </p>
                </Panel>
            </div>
        );
    }

    // The token travels on, so a signed-in member with replay analysis can read
    // a game someone sent them without also needing its game id.
    return <ReplayViewer replay={data.replay} shareToken={token} />;
};

SharedReplay.displayName = 'SharedReplay';

export default SharedReplay;
