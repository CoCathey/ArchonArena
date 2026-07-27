import React, { useEffect, useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Button as HeroButton } from '@heroui/react';
import moment from 'moment';

import Panel from '../Components/Site/Panel';
import Link from '../Components/Navigation/Link';
import Messages from '../Components/GameBoard/Messages';
import ReplayBoard from '../Components/GameBoard/ReplayBoard';
import { useGetGameReplayQuery } from '../redux/api';

const noop = () => {};

/**
 * ARCHON: replay viewer (move-log). Steps through the recorded, structured
 * play-by-play of a finished game, reusing the in-game Messages renderer. The
 * board-snapshot viewer can layer onto the same recording later.
 */
const Replay = () => {
    const { t } = useTranslation();
    const { gameId } = useParams();
    const { data, isFetching, isError } = useGetGameReplayQuery(gameId, { skip: !gameId });
    const replay = data?.replay;
    const messages = useMemo(() => replay?.messages || [], [replay]);
    const total = messages.length;
    const [step, setStep] = useState(0);

    // Reveal the whole log by default once loaded; the controls scrub back.
    useEffect(() => {
        setStep(total);
    }, [total]);

    if (isFetching) {
        return <div className='py-10 text-center text-muted'>{t('Loading replay…')}</div>;
    }

    if (isError || !replay) {
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

    const clamp = (value) => Math.max(0, Math.min(total, value));
    const shown = messages.slice(0, step);
    // The board as it stood at this point: the last snapshot recorded at or
    // before the current log position. Older recordings (version 1) have no
    // snapshots at all, and the viewer degrades to the log alone.
    const snapshots = replay.snapshots || [];
    const currentBoard = snapshots.reduce(
        (best, snapshot) => (snapshot.messageIndex <= step ? snapshot : best),
        snapshots[0]
    )?.board;
    const players = replay.players || [];
    const finished = replay.finishedAt ? moment(replay.finishedAt).format('YYYY-MM-DD HH:mm') : '';

    return (
        <div className='mx-auto w-full max-w-3xl space-y-3'>
            <Panel title={t('Replay')}>
                <div className='flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-foreground'>
                    <span className='font-semibold'>
                        {players.map((player) => player.name).join(' vs ') || t('Game')}
                    </span>
                    {replay.winner ? (
                        <span className='text-muted'>
                            {t('Winner')}: <span className='text-foreground'>{replay.winner}</span>
                        </span>
                    ) : null}
                    {replay.gameFormat ? (
                        <span className='text-muted'>{t(replay.gameFormat)}</span>
                    ) : null}
                    {finished ? <span className='text-muted'>{finished}</span> : null}
                </div>
            </Panel>

            <Panel title={t('Play-by-play')}>
                <div className='mb-3 flex flex-wrap items-center gap-2'>
                    <HeroButton
                        size='sm'
                        variant='tertiary'
                        isDisabled={step <= 1}
                        onPress={() => setStep(1)}
                    >
                        ⏮
                    </HeroButton>
                    <HeroButton
                        size='sm'
                        variant='tertiary'
                        isDisabled={step <= 1}
                        onPress={() => setStep(clamp(step - 1))}
                    >
                        ◀ {t('Prev')}
                    </HeroButton>
                    <HeroButton
                        size='sm'
                        variant='tertiary'
                        isDisabled={step >= total}
                        onPress={() => setStep(clamp(step + 1))}
                    >
                        {t('Next')} ▶
                    </HeroButton>
                    <HeroButton
                        size='sm'
                        variant='tertiary'
                        isDisabled={step >= total}
                        onPress={() => setStep(total)}
                    >
                        ⏭
                    </HeroButton>
                    <input
                        type='range'
                        min={total > 0 ? 1 : 0}
                        max={total}
                        value={step}
                        onChange={(event) => setStep(clamp(parseInt(event.target.value, 10)))}
                        className='min-w-[140px] flex-1'
                        aria-label={t('Replay position')}
                    />
                    <span className='whitespace-nowrap text-xs text-muted'>
                        {t('Step {{step}} / {{total}}', { step, total })}
                    </span>
                </div>
                <div className='max-h-[45vh] overflow-y-auto rounded-md border border-border/55 bg-surface-secondary/35 px-3 py-2 text-sm'>
                    {total === 0 ? (
                        <p className='text-muted'>{t('This replay has no recorded log.')}</p>
                    ) : (
                        <Messages messages={shown} onCardMouseOver={noop} onCardMouseOut={noop} />
                    )}
                </div>
            </Panel>

            {snapshots.length > 0 && (
                <Panel title={t('Board')}>
                    {replay.truncated && (
                        <p className='mb-2 text-xs text-amber-300'>
                            {t(
                                'This game ran long enough that board recording stopped part-way; later positions are not available.'
                            )}
                        </p>
                    )}
                    <ReplayBoard board={currentBoard} />
                </Panel>
            )}
        </div>
    );
};

Replay.displayName = 'Replay';

export default Replay;
