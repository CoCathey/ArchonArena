import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import PropTypes from 'prop-types';
import { useSelector } from 'react-redux';
import { useTranslation } from 'react-i18next';
import { Button as HeroButton } from '@heroui/react';
import moment from 'moment';

import Panel from '../Site/Panel';
import Messages from './Messages';
import ReplayBoard from './ReplayBoard';
import CardZoom from './CardZoom';
import ReplayAnalysis from './ReplayAnalysis';
import PremiumLock from '../Membership/PremiumLock';
import { CAPABILITIES, hasCapability } from '../../membership';
import { findKeyForges, findTurns } from '../../replayMarkers';
import { boardAtStep, handsAtStep } from '../../replayFormat';
import { useShareReplayMutation, useUnshareReplayMutation } from '../../redux/api';

/** How fast autoplay steps through the log, in log entries per second. */
const SPEEDS = [1, 2, 4, 8];

/**
 * ARCHON: the replay viewer.
 *
 * Extracted from the Replay page so the authenticated route and the public
 * share route render exactly the same viewer - a shared replay that looked
 * different from the real thing would be a second implementation to keep in
 * step, and the recording is spectator-safe either way.
 *
 * ## Moving through a game
 *
 * Three ways, because a 300-entry log is not something anyone wants to step
 * through one entry at a time:
 *
 *   - turn jumps, one button per turn, labelled with the house that was chosen
 *   - forge jumps, the moments that always matter in KeyForge
 *   - play/pause, for watching it unfold
 *
 * Arrow keys step, space plays and pauses, so the common case needs no mouse.
 *
 * @param {object} props
 * @param {object} props.replay   the recording
 * @param {string} [props.gameId] the game, when the viewer may offer sharing
 * @param {boolean} [props.canShare] whether the viewer played in this game
 * @param {string} [props.shareToken] the token this replay was reached by, when
 *   it was reached by a share link - the analysis is fetched by it
 */
const ReplayViewer = ({ replay, gameId, canShare = false, shareToken: viaShareToken }) => {
    const { t } = useTranslation();
    const user = useSelector((state) => state.account.user);
    const messages = useMemo(() => replay?.messages || [], [replay]);
    const snapshots = useMemo(() => replay?.snapshots || [], [replay]);
    const players = useMemo(() => replay?.players || [], [replay]);
    const cards = useMemo(() => replay?.cards || [], [replay]);
    const total = messages.length;

    const [step, setStep] = useState(0);
    const [perspective, setPerspective] = useState(null);
    const [shareToken, setShareToken] = useState(replay?.shareToken || null);
    const [copied, setCopied] = useState(false);
    const [playing, setPlaying] = useState(false);
    const [speed, setSpeed] = useState(2);
    const [zoom, setZoom] = useState(null);
    const logRef = useRef(null);

    const [shareReplay, { isLoading: isSharing }] = useShareReplayMutation();
    const [unshareReplay, { isLoading: isUnsharing }] = useUnshareReplayMutation();

    // Reveal the whole log by default once loaded; the controls scrub back.
    useEffect(() => {
        setStep(total);
    }, [total]);

    useEffect(() => {
        setShareToken(replay?.shareToken || null);
    }, [replay?.shareToken]);

    // The key forges and the turn boundaries, read off the recorded board
    // frames (see replayMarkers).
    const forges = useMemo(() => findKeyForges(snapshots), [snapshots]);
    const turns = useMemo(() => findTurns(snapshots), [snapshots]);

    const clamp = useCallback((value) => Math.max(0, Math.min(total, value)), [total]);

    // Autoplay. Stops of its own accord at the end rather than sitting there
    // pretending to still be playing.
    useEffect(() => {
        if (!playing || total === 0) {
            return undefined;
        }

        if (step >= total) {
            setPlaying(false);

            return undefined;
        }

        const timer = setTimeout(
            () => setStep((current) => Math.min(total, current + 1)),
            1000 / speed
        );

        return () => clearTimeout(timer);
    }, [playing, speed, step, total]);

    // Arrow keys step, space plays and pauses. Ignored while the reader is
    // typing into something, so this cannot hijack a form field.
    useEffect(() => {
        const onKeyDown = (event) => {
            const tag = event.target?.tagName;

            if (tag === 'INPUT' || tag === 'TEXTAREA' || event.target?.isContentEditable) {
                return;
            }

            if (event.key === 'ArrowLeft') {
                setPlaying(false);
                setStep((current) => clamp(current - 1));
            } else if (event.key === 'ArrowRight') {
                setPlaying(false);
                setStep((current) => clamp(current + 1));
            } else if (event.key === ' ') {
                event.preventDefault();
                setPlaying((current) => !current);
            } else {
                return;
            }
        };

        window.addEventListener('keydown', onKeyDown);

        return () => window.removeEventListener('keydown', onKeyDown);
    }, [clamp]);

    // Follow the log as it advances, so autoplay does not scroll away from the
    // entry it is adding.
    useEffect(() => {
        const node = logRef.current;

        if (node) {
            node.scrollTop = node.scrollHeight;
        }
    }, [step]);

    const shown = messages.slice(0, step);
    // The board as it stood at this point: the last frame recorded at or before
    // the current log position. Version 1 recordings have no frames at all, and
    // the viewer degrades to the log alone.
    const currentBoard = boardAtStep(snapshots, step);
    // ARCHON (F3): the recorded hands at this point - only ever the ones the
    // server let this reader have (their own, with the Archon tier; both, for
    // an admin; none on a share link or an older recording).
    const currentHands = handsAtStep(snapshots, step, replay?.handCards);
    const handsRecorded = snapshots.some((snapshot) => snapshot?.hands);
    // A participant whose recording HAS hands they are not being served is
    // told what would unlock them; everyone else just sees no hand pile.
    // Version 4 marks a recording that captured hands even after the server
    // stripped them from this response - and the capability check keeps the
    // hint from ever showing to a member on a recording that simply failed to
    // capture.
    const handsLocked =
        canShare &&
        !handsRecorded &&
        (replay?.version || 0) >= 4 &&
        !!replay?.snapshots?.length &&
        !hasCapability(user, CAPABILITIES.ADVANCED_REPLAYS);

    const jumpTo = (messageIndex) => {
        setPlaying(false);
        setStep(clamp(messageIndex));
    };

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

    const onCardMouseOver = useCallback((card) => setZoom(card), []);
    const onCardMouseOut = useCallback(() => setZoom(null), []);

    return (
        <div className='mx-auto w-full max-w-3xl space-y-3'>
            {zoom && <CardZoom card={zoom} />}

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

                {/* Each player's deck, which is the other half of "what was
                    this game" and is in the recording already. */}
                {players.some((player) => player.deckName || player.houses) && (
                    <div className='mt-2 grid gap-1 text-xs text-muted sm:grid-cols-2'>
                        {players.map((player) => (
                            <div key={player.name}>
                                <span className='text-foreground'>{player.name}</span>
                                {player.deckName ? ` — ${player.deckName}` : ''}
                                {player.houses?.length
                                    ? ` (${player.houses.map((house) => t(house)).join(', ')})`
                                    : ''}
                            </div>
                        ))}
                    </div>
                )}

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
                        onPress={() => jumpTo(1)}
                    >
                        ⏮
                    </HeroButton>
                    <HeroButton
                        size='sm'
                        variant='tertiary'
                        isDisabled={step <= 1}
                        onPress={() => jumpTo(step - 1)}
                    >
                        ◀ {t('Prev')}
                    </HeroButton>
                    <HeroButton
                        size='sm'
                        variant={playing ? 'primary' : 'tertiary'}
                        isDisabled={total === 0}
                        onPress={() => {
                            // Replaying from the end means replaying from the
                            // start, which is what pressing play there means.
                            if (step >= total) {
                                setStep(1);
                            }

                            setPlaying(!playing);
                        }}
                    >
                        {playing ? `⏸ ${t('Pause')}` : `▶ ${t('Play')}`}
                    </HeroButton>
                    <HeroButton
                        size='sm'
                        variant='tertiary'
                        isDisabled={step >= total}
                        onPress={() => jumpTo(step + 1)}
                    >
                        {t('Next')} ▶
                    </HeroButton>
                    <HeroButton
                        size='sm'
                        variant='tertiary'
                        isDisabled={step >= total}
                        onPress={() => jumpTo(total)}
                    >
                        ⏭
                    </HeroButton>
                    <HeroButton
                        size='sm'
                        variant='tertiary'
                        onPress={() =>
                            setSpeed(SPEEDS[(SPEEDS.indexOf(speed) + 1) % SPEEDS.length])
                        }
                        title={t('Playback speed')}
                    >
                        {t('{{speed}}×', { speed })}
                    </HeroButton>
                    <input
                        type='range'
                        min={total > 0 ? 1 : 0}
                        max={total}
                        value={step}
                        onChange={(event) => jumpTo(parseInt(event.target.value, 10))}
                        className='min-w-[140px] flex-1'
                        aria-label={t('Replay position')}
                    />
                    <span className='whitespace-nowrap text-xs text-muted'>
                        {t('Step {{step}} / {{total}}', { step, total })}
                    </span>
                </div>

                {/* ARCHON: jump by turn. A KeyForge game is a sequence of turns
                    and this is how anyone describes a game to someone else -
                    "on my fourth turn" - so it is the navigation the log
                    always needed. The house is on the button because which
                    house was called is the decision the turn is about. */}
                {turns.length > 0 && (
                    <div className='mb-3'>
                        <div className='mb-1 text-xs uppercase tracking-wide text-muted'>
                            {t('Turns')}
                        </div>
                        <div className='flex max-h-24 flex-wrap gap-1 overflow-y-auto'>
                            {turns.map((turn, index) => {
                                const next = turns[index + 1];
                                const isCurrent =
                                    step >= turn.messageIndex &&
                                    (!next || step < next.messageIndex);

                                return (
                                    <button
                                        key={`${turn.round}-${turn.player}-${index}`}
                                        type='button'
                                        className={`rounded border px-1.5 py-0.5 text-[0.7rem] ${
                                            isCurrent
                                                ? 'border-amber-400/70 bg-amber-400/15 text-amber-200'
                                                : 'border-border/55 text-muted hover:text-foreground'
                                        }`}
                                        onClick={() => jumpTo(turn.messageIndex)}
                                        title={t('{{player}}, turn {{round}}', {
                                            player: turn.player,
                                            round: turn.round
                                        })}
                                    >
                                        {turn.round}. {turn.player}
                                        {turn.house ? ` · ${t(turn.house)}` : ''}
                                    </button>
                                );
                            })}
                        </div>
                    </div>
                )}

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
                                onPress={() => jumpTo(forge.messageIndex)}
                            >
                                {t('{{player}} key {{keys}}', {
                                    player: forge.player,
                                    keys: forge.keys
                                })}
                            </HeroButton>
                        ))}
                    </div>
                )}

                <div
                    ref={logRef}
                    className='max-h-[45vh] overflow-y-auto rounded-md border border-border/55 bg-surface-secondary/35 px-3 py-2 text-sm'
                >
                    {total === 0 ? (
                        <p className='text-muted'>{t('This replay has no recorded log.')}</p>
                    ) : (
                        <Messages
                            messages={shown}
                            onCardMouseOver={onCardMouseOver}
                            onCardMouseOut={onCardMouseOut}
                        />
                    )}
                </div>
            </Panel>

            {snapshots.length > 0 && (
                <Panel title={t('Board')} titleAlign='center'>
                    {replay?.thinned && (
                        <p className='mb-2 text-xs text-amber-300'>
                            {t(
                                'This game ran long enough that the board is recorded at reduced ' +
                                    'resolution: the log is complete, but some positions between ' +
                                    'entries were not kept.'
                            )}
                        </p>
                    )}

                    {replay?.truncated && (
                        <p className='mb-2 text-xs text-amber-300'>
                            {t('Part of the board recording for this game could not be captured.')}
                        </p>
                    )}

                    {/* ARCHON (F3): this game recorded your hand, and the
                        Archon tier is what reads it back. Shown only to a
                        participant the server stripped hands for - never on
                        share links, older recordings, or to members. */}
                    {handsLocked && (
                        <p className='mb-2 flex flex-wrap items-center gap-1.5 text-xs text-muted'>
                            {t(
                                'This game recorded the hand you held at every step, ready to replay.'
                            )}
                            <PremiumLock capability={CAPABILITIES.ADVANCED_REPLAYS} inline />
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

                    <ReplayBoard
                        board={currentBoard}
                        cards={cards}
                        hands={currentHands}
                        perspective={perspective}
                        onCardMouseOver={onCardMouseOver}
                        onCardMouseOut={onCardMouseOut}
                    />
                </Panel>
            )}

            {/* ARCHON (N12): the analysis, for Archon+. Locked rather than
                hidden - the panel explains what it would tell you. */}
            <ReplayAnalysis gameId={gameId} shareToken={viaShareToken} onJump={jumpTo} />
        </div>
    );
};

ReplayViewer.propTypes = {
    canShare: PropTypes.bool,
    gameId: PropTypes.string,
    replay: PropTypes.object,
    shareToken: PropTypes.string
};

ReplayViewer.displayName = 'ReplayViewer';

export default ReplayViewer;
