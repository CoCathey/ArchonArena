import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import AmberValue from '../Site/AmberValue';
import { useGetGameRatingQuery } from '../../redux/api';

const POOL_LABELS = {
    archon: 'Archon',
    sealed: 'Sealed',
    alliance: 'Alliance'
};

/**
 * ARCHON: post-game result — what the finished game did to your Amber.
 *
 * The rating engine is the reason the platform exists, and until now it was
 * invisible at the exact moment it mattered: a rated game ended with no
 * indication that anything had changed. Everything shown here was already
 * persisted by RatingService (RatingHistory keeps the before/after, both decks'
 * SAS, the key differential and the result type); this only reads it back.
 *
 * Rendered from the client against a finished game's id, so the gameplay engine
 * is untouched — no new coupling, and nothing here can delay or block leaving
 * the game.
 *
 * @param {{ gameId?: string, username?: string, winner?: string }} props
 */
// Rating is written asynchronously after GAMEWIN, so a single request almost
// always arrives before the rating exists. This is how long to keep asking
// before concluding none is coming. Generous on purpose: the cost of waiting is
// a moment of "Rating this game...", and the cost of giving up early is telling
// a player their game did not count when it did.
const RATING_POLL_MS = 1500;
const RATING_POLL_ATTEMPTS = 10;

const GameResultPanel = ({ gameId, username, winner }) => {
    const { t } = useTranslation();
    // Fixed at mount rather than counted per request, so a slow network cannot
    // stretch the wait indefinitely.
    const [deadline] = useState(() => Date.now() + RATING_POLL_MS * RATING_POLL_ATTEMPTS);
    const [pollingInterval, setPollingInterval] = useState(RATING_POLL_MS);

    const { data } = useGetGameRatingQuery(gameId, {
        skip: !gameId,
        pollingInterval
    });

    // Stop as soon as the answer is final: the rating arrived, the server says
    // none is coming, or we have waited long enough. Asking once and caching
    // that first answer is exactly what made finished games report themselves
    // as unrated.
    useEffect(() => {
        if (!data || pollingInterval === 0) {
            return;
        }

        if (data.rated || !data.pending || Date.now() > deadline) {
            setPollingInterval(0);
        }
    }, [data, deadline, pollingInterval]);

    if (!gameId || !data) {
        return null;
    }

    // Still expected: say so rather than claim it was not rated.
    if (!data.rated && data.pending && pollingInterval !== 0) {
        return (
            <div className='rounded-md border border-border/60 bg-surface-secondary/60 px-3 py-2 text-center text-xs text-muted'>
                {t('Rating this game...')}
            </div>
        );
    }

    const you = (data.players || []).find(
        (player) => player.username?.toLowerCase() === username?.toLowerCase()
    );

    // An unrated game is a normal outcome, not an error — say so plainly
    // instead of leaving a blank space where the result would be, and say WHY
    // when the server knows. "Not rated" with no reason is the kind of thing
    // players reasonably read as a bug.
    if (!data.rated || !you) {
        const reason = data.reason;

        return (
            <div className='rounded-md border border-border/60 bg-surface-secondary/60 px-3 py-2 text-center text-xs text-muted'>
                {winner
                    ? t('{{winner}} won. This game was not rated.', { winner })
                    : t('This game was not rated.')}
                {reason ? <span className='ml-1'>{t(reason)}</span> : null}
            </div>
        );
    }

    const won = you.won;
    const change = you.change;
    const sign = change > 0 ? '+' : '';
    const poolLabel = POOL_LABELS[data.pool] || data.pool;
    const placementsLeft = you.provisional
        ? Math.max(0, you.provisionalGames - (you.gamesPlayed || 0))
        : 0;

    return (
        <div className='rounded-md border border-border/60 bg-surface-secondary/60 px-3 py-2'>
            <div className='flex flex-wrap items-center justify-center gap-x-3 gap-y-1'>
                <span
                    className={`text-sm font-semibold ${won ? 'text-emerald-300' : 'text-muted'}`}
                >
                    {won ? t('Victory') : t('Defeat')}
                </span>

                <span
                    className={`text-lg font-bold tabular-nums ${
                        change > 0
                            ? 'text-emerald-300'
                            : change < 0
                            ? 'text-rose-300'
                            : 'text-muted'
                    }`}
                >
                    {sign}
                    {change}
                </span>

                <AmberValue value={you.ratingAfter} showLabel />

                <span className='text-xs text-muted'>{t(poolLabel)}</span>
            </div>

            <div className='mt-1 flex flex-wrap items-center justify-center gap-x-3 gap-y-0.5 text-xs text-muted'>
                {you.keyDiff != null && (
                    <span>{t('Key margin: {{keys}}', { keys: you.keyDiff })}</span>
                )}
                {/* The SAS gap is what makes this Elo variant KeyForge-specific:
                    winning up in deck power pays more than winning down. */}
                {you.ownSas != null && you.opponentSas != null && (
                    <span>
                        {t('SAS {{own}} vs {{opponent}}', {
                            own: you.ownSas,
                            opponent: you.opponentSas
                        })}
                    </span>
                )}
                {placementsLeft > 0 && (
                    <span className='text-amber-300'>
                        {t('{{count}} more placement game(s)', { count: placementsLeft })}
                    </span>
                )}
            </div>
        </div>
    );
};

GameResultPanel.displayName = 'GameResultPanel';

export default GameResultPanel;
