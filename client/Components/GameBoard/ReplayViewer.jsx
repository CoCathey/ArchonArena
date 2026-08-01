import React, { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button as HeroButton } from '@heroui/react';
import moment from 'moment';

import Panel from '../Site/Panel';
import Messages from './Messages';
import ReplayBoard from './ReplayBoard';
import { findKeyForges } from '../../replayMarkers';
import { useShareReplayMutation, useUnshareReplayMutation } from '../../redux/api';

const noop = () => {};

/**
 * ARCHON: the replay viewer.
 *
 * Extracted from the Replay page so the authenticated route and the public
 * share route render exactly the same viewer - a shared replay that looked
 * different from the real thing would be a second implementation to keep in
 * step, and the recording is spectator-safe either way.
 *
 * @param {object} props
 * @param {object} props.replay   the recording
 * @param {string} [props.gameId] the game, when the viewer may offer sharing
 * @param {boolean} [props.canShare] whether the viewer played in this game
 */
const ReplayViewer = ({ replay, gameId, canShare = false }) => {
    const { t } = useTranslation();
    const messages = useMemo(() => replay?.messages || [], [replay]);
    const snapshots = useMemo(() => replay?.snapshots || [], [replay]);
    const players = useMemo(() => replay?.players || [], [replay]);
    const total = messages.length;

    const [step, setStep] = useState(0);
    const [perspective, setPerspective] = useState(null);
    const [shareToken, setShareToken] = useState(replay?.shareToken || null);
    const [copied, setCopied] = useState(false);

    const [shareReplay, { isLoading: isSharing }] = useShareReplayMutation();
    const [unshareReplay, { isLoading: isUnsharing }] = useUnshareReplayMutation();

    // Reveal the whole log by default once loaded; the controls scrub back.
    useEffect(() => {
        setStep(total);
    }, [total]);

    useEffect(() => {
        setShareToken(replay?.shareToken || null);
    }, [replay?.shareToken]);

    // The key forges, read off the recorded key counts (see replayMarkers).
    const forges = useMemo(() => findKeyForges(snapshots), [snapshots]);

    const clamp = (value) => Math.max(0, Math.min(total, value));
    const shown = messages.slice(0, step);
    // The board as it stood at this point: the last snapshot recorded at or
    // before the current log position. Older recordings (version 1) have no
    // snapshots at all, and the viewer degrades to the log alone.
    const currentBoard = snapshots.reduce(
        (best, snapshot) => (snapshot.messageIndex <= step ? snapshot : best),
        snapshots[0]
    )?.board;

    const finished = replay?.finishedAt ? moment(replay.finishedAt).format('YYYY-MM-DD HH:mm') : '';
    const shareUrl = shareToken ? `${window.location.origin}/replay/shared/${shareToken}` : null;

    const onShare = async () => {
        const result = await shareReplay(gameId)
            .unwrap()
            .catch(() => null);

        if (result?.success) {
            setShareToken(result.shareToken);
        }
    };

    const onUnshare = async () => {
        await unshareReplay(gameId)
            .unwrap()
            .catch(() => null);
        setShareToken(null);
        setCopied(false);
    };

    const onCopy = async () => {
        try {
            await navigator.clipboard.writeText(shareUrl);
            setCopied(true);
        } catch {
            // Clipboard access can be refused; the link is on screen to copy
            // by hand, so this is not worth an error message.
        }
    };

    return (
        <div className='mx-auto w-full max-w-3xl space-y-3'>
            <Panel title={t('Replay')} titleAlign='center'>
                <div className='flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-foreground'>
                    <span className='font-semibold'>
                        {players.map((player) => player.name).join(' vs ') || t('Game')}
                    </span>
                    {replay?.winner ? (
                        <span className='text-muted'>
                            {t('Winner')}: <span className='text-foreground'>{replay.winner}</span>
                        </span>
                    ) : null}
                    {replay?.gameFormat ? (
                        <span className='text-muted'>{t(replay.gameFormat)}</span>
                    ) : null}
                    {finished ? <span className='text-muted'>{finished}</span> : null}
                </div>

                {canShare && gameId && (
                    <div className='mt-3 border-t border-border/55 pt-3'>
                        {shareToken ? (
                            <div className='space-y-2'>
                                <p className='text-xs text-muted'>
                                    {t(
                                        'Anyone with this link can watch this replay without signing in.'
                                    )}
                                </p>
                                <div className='flex flex-wrap items-center gap-2'>
                                    <code className='min-w-0 flex-1 truncate rounded-md border border-border/55 bg-surface-secondary/35 px-2 py-1 text-xs'>
                                        {shareUrl}
                                    </code>
                                    <HeroButton size='sm' variant='tertiary' onPress={onCopy}>
                                        {copied ? t('Copied') : t('Copy link')}
                                    </HeroButton>
                                    <HeroButton
                                        size='sm'
                                        variant='tertiary'
                                        isDisabled={isUnsharing}
                                        onPress={onUnshare}
                                    >
                                        {t('Stop sharing')}
                                    </HeroButton>
                                </div>
                            </div>
                        ) : (
                            <HeroButton
                                size='sm'
                                variant='tertiary'
                                isDisabled={isSharing}
                                onPress={onShare}
                            >
                                {t('Create share link')}
                            </HeroButton>
                        )}
                    </div>
                )}
            </Panel>

            <Panel title={t('Play-by-play')} titleAlign='center'>
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

                {/* ARCHON (N1): jump straight to the forges - the only moments
                    in KeyForge that always matter, and the reason scrubbing a
                    long log is tedious. */}
                {forges.length > 0 && (
                    <div className='mb-3 flex flex-wrap items-center gap-2'>
                        <span className='text-xs uppercase tracking-wide text-muted'>
                            {t('Keys forged')}
                        </span>
                        {forges.map((forge, index) => (
                            <HeroButton
                                key={`${forge.player}-${forge.messageIndex}-${index}`}
                                size='sm'
                                variant='tertiary'
                                onPress={() => setStep(clamp(forge.messageIndex))}
                            >
                                {t('{{player}} key {{keys}}', {
                                    player: forge.player,
                                    keys: forge.keys
                                })}
                            </HeroButton>
                        ))}
                    </div>
                )}

                <div className='max-h-[45vh] overflow-y-auto rounded-md border border-border/55 bg-surface-secondary/35 px-3 py-2 text-sm'>
                    {total === 0 ? (
                        <p className='text-muted'>{t('This replay has no recorded log.')}</p>
                    ) : (
                        <Messages messages={shown} onCardMouseOver={noop} onCardMouseOut={noop} />
                    )}
                </div>
            </Panel>

            {snapshots.length > 0 && (
                <Panel title={t('Board')} titleAlign='center'>
                    {replay?.truncated && (
                        <p className='mb-2 text-xs text-amber-300'>
                            {t(
                                'This game ran long enough that board recording stopped part-way; later positions are not available.'
                            )}
                        </p>
                    )}

                    {/* ARCHON (N1): read the board from either player's side.
                        Presentation only - the snapshot is spectator-safe, so
                        neither perspective reveals anything the other does not. */}
                    {players.length > 1 && (
                        <div className='mb-2 flex flex-wrap items-center gap-2'>
                            <span className='text-xs uppercase tracking-wide text-muted'>
                                {t('Perspective')}
                            </span>
                            {players.map((player) => (
                                <HeroButton
                                    key={player.name}
                                    size='sm'
                                    variant={perspective === player.name ? 'primary' : 'tertiary'}
                                    onPress={() =>
                                        setPerspective(
                                            perspective === player.name ? null : player.name
                                        )
                                    }
                                >
                                    {player.name}
                                </HeroButton>
                            ))}
                        </div>
                    )}

                    <ReplayBoard board={currentBoard} perspective={perspective} />
                </Panel>
            )}
        </div>
    );
};

ReplayViewer.displayName = 'ReplayViewer';

export default ReplayViewer;
