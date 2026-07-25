import React, { useEffect, useState } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import { Button } from '@heroui/react';
import { Trans, useTranslation } from 'react-i18next';

import Panel from '../Site/Panel';
import AlertPanel from '../Site/AlertPanel';
import { lobbyActions } from '../../redux/slices/lobbySlice';
import { lobbySendMessage } from '../../redux/socketActions';

// Formats a player can queue for. 'normal' is surfaced as Archon (its rating
// pool) to match how ratings are branded elsewhere. Unchained and Reversal are
// hidden from the UI for now - the engine still supports them.
const FORMATS = [
    { name: 'normal', label: 'Archon' },
    { name: 'sealed', label: 'Sealed' },
    { name: 'alliance', label: 'Alliance' },
    { name: 'adaptive-bo1', label: 'Adaptive' }
];

/**
 * ARCHON: Quick Match — pick a format and the lobby pairs you with an available
 * player of similar Amber (widening the range the longer you wait). While the
 * server searches, this shows a live "searching…" state; on a match the paired
 * game arrives as the current game and the pending-game screen takes over.
 *
 * @param {{ onClose?: () => void }} props
 */
const QuickMatchPanel = ({ onClose }) => {
    const { t } = useTranslation();
    const dispatch = useDispatch();
    const searching = useSelector((state) => state.lobby.searching);
    const searchingFormat = useSelector((state) => state.lobby.matchmakingFormat);
    const queued = useSelector((state) => state.lobby.matchmakingQueued);
    const error = useSelector((state) => state.lobby.matchmakingError);
    const [format, setFormat] = useState('normal');
    const [elapsed, setElapsed] = useState(0);

    useEffect(() => {
        if (!searching) {
            setElapsed(0);
            return undefined;
        }

        setElapsed(0);
        const id = setInterval(() => setElapsed((seconds) => seconds + 1), 1000);

        return () => clearInterval(id);
    }, [searching]);

    const findMatch = () => {
        dispatch(lobbyActions.startSearching(format));
        dispatch(lobbySendMessage('joinqueue', { gameFormat: format }));
    };

    const cancel = () => {
        dispatch(lobbySendMessage('leavequeue'));
        dispatch(lobbyActions.stopSearching());
    };

    const close = () => {
        if (searching) {
            cancel();
        }

        if (onClose) {
            onClose();
        }
    };

    const activeFormat = searching ? searchingFormat : format;
    const formatLabel = FORMATS.find((entry) => entry.name === activeFormat)?.label || 'Archon';

    return (
        <Panel title={t('Quick Match')} titleClass='text-base font-semibold tracking-wide'>
            {error && (
                <AlertPanel type='warning' className='!mb-3'>
                    {t(error)}
                </AlertPanel>
            )}

            {searching ? (
                <div className='flex flex-col items-center gap-3 py-4 text-center'>
                    <span className='relative inline-flex h-3 w-3'>
                        <span className='absolute inline-flex h-full w-full animate-ping rounded-full bg-amber-400/60' />
                        <span className='relative inline-flex h-3 w-3 rounded-full bg-amber-400' />
                    </span>
                    <div className='text-sm font-semibold text-foreground'>
                        {t('Searching for a {{format}} opponent…', { format: t(formatLabel) })}
                    </div>
                    <div className='text-xs text-muted'>
                        {t('Elapsed: {{seconds}}s', { seconds: elapsed })}
                        {queued > 1
                            ? ` · ${t('{{count}} searching this format', { count: queued })}`
                            : ` · ${t('first in the queue')}`}
                    </div>
                    <div className='max-w-sm text-xs text-muted'>
                        <Trans>
                            We pair you with the closest available Amber and widen the range the
                            longer you wait.
                        </Trans>
                    </div>
                    <Button variant='tertiary' onPress={cancel}>
                        <Trans>Cancel search</Trans>
                    </Button>
                </div>
            ) : (
                <div className='space-y-3'>
                    <div className='text-sm text-muted'>
                        <Trans>
                            Pick a format and we&apos;ll pair you with an available player of
                            similar Amber.
                        </Trans>
                    </div>
                    <div className='grid grid-cols-2 gap-2 sm:grid-cols-3'>
                        {FORMATS.map((entry) => (
                            <button
                                key={entry.name}
                                type='button'
                                onClick={() => setFormat(entry.name)}
                                className={`rounded-md border px-3 py-2 text-sm transition-colors ${
                                    format === entry.name
                                        ? 'border-[color:var(--brand)] bg-[color:color-mix(in_oklab,var(--surface-secondary)_82%,var(--brand)_18%)] text-foreground'
                                        : 'border-border/20 bg-surface-secondary/78 text-foreground/92 hover:bg-surface-secondary/92'
                                }`}
                            >
                                {t(entry.label)}
                            </button>
                        ))}
                    </div>
                    <div className='flex justify-center gap-2 border-t border-border/55 pt-3'>
                        <Button variant='primary' onPress={findMatch}>
                            <Trans>Find Match</Trans>
                        </Button>
                        <Button variant='tertiary' onPress={close}>
                            <Trans>Close</Trans>
                        </Button>
                    </div>
                </div>
            )}
        </Panel>
    );
};

QuickMatchPanel.displayName = 'QuickMatchPanel';

export default QuickMatchPanel;
