import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useDispatch } from 'react-redux';
import { useNavigate } from 'react-router-dom';

import AmberValue from '../Site/AmberValue';
import Link from '../Navigation/Link';
import { useGetGameRatingQuery } from '../../redux/api';
import {
    gameCloseRequested,
    gameSendMessage,
    lobbyLeaveGameRequested
} from '../../redux/socketActions';

const POOL_LABELS = {
    archon: 'Archon',
    sealed: 'Sealed',
    alliance: 'Alliance'
};

/**
 * The stored key differential is a margin TIER (1..3), not a subtraction, so
 * showing the bare number invites the wrong reading - "margin: 3" after
 * conceding to someone on two keys looks like a claim nobody was three keys
 * ahead. Rendered as the scoreline the tier stands for it says the true thing:
 * as one-sided as a 3-0.
 *
 * Clamped because rows written before the tier was measured on the loser can
 * hold 0 or a negative, and the rating engine clamped those the same way.
 */
const keyMarginLabel = (keyDiff) => {
    const tier = Math.max(1, Math.min(3, keyDiff));

    return `3-${3 - tier}`;
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
//
// ARCHON (N36): forty-five seconds, not fifteen. Rating runs after the finished
// game is persisted and alongside the replay write, on a lobby that may also be
// running Challenge sweeps, so a busy server takes longer than the old window
// allowed - and what the player saw when it ran out was a flat "this game was
// not rated", about a game that was being rated as they read it. The polls are
// one small indexed read each; the honesty is worth more than they cost.
const RATING_POLL_MS = 1500;
const RATING_POLL_ATTEMPTS = 30;

const GameResultPanel = ({ gameId, username, winner }) => {
    const { t } = useTranslation();
    const dispatch = useDispatch();
    const navigate = useNavigate();
    // Fixed at mount rather than counted per request, so a slow network cannot
    // stretch the wait indefinitely.
    const [deadline] = useState(() => Date.now() + RATING_POLL_MS * RATING_POLL_ATTEMPTS);
    const [pollingInterval, setPollingInterval] = useState(RATING_POLL_MS);

    const { data } = useGetGameRatingQuery(gameId, {
        skip: !gameId,
        pollingInterval
    });

    // ARCHON: leave the finished game the same way the top-bar "Leave Game"
    // control does (both sockets, so a dead game socket can never strand the
    // player here) - this is only ever rendered once `currentGame.winner` is
    // set, so there is no active game left to concede.
    const onBackToLobby = () => {
        dispatch(gameSendMessage('leavegame'));
        if (gameId) {
            dispatch(lobbyLeaveGameRequested(gameId));
        }
        dispatch(gameCloseRequested());
        navigate('/');
    };

    // The replay is written as an independent, best-effort consequence of the
    // same persist that the rating read above is waiting on (see GAMEWIN in
    // gamerouter.js) - so "the Games row exists" (rating no longer `pending`)
    // is the same signal that tells us the replay page will not 403 the
    // player out of their own just-finished game or claim it doesn't exist.
    const replayReady = !!data && !data.pending;

    const renderActions = () => (
        <div className='mt-2 flex flex-wrap items-center justify-center gap-x-3 gap-y-1 text-xs'>
            {replayReady ? (
                <Link
                    href={`/replay/${gameId}`}
                    className='font-medium text-amber-300 underline underline-offset-2 hover:text-amber-200'
                >
                    {t('View Replay')}
                </Link>
            ) : (
                <span className='text-muted'>{t('Preparing replay...')}</span>
            )}
            <button
                type='button'
                onClick={onBackToLobby}
                className='font-medium text-muted underline underline-offset-2 hover:text-foreground'
            >
                {t('Back to Lobby')}
            </button>
        </div>
    );

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
                {renderActions()}
            </div>
        );
    }

    const you = (data.players || []).find(
        (player) => player.username?.toLowerCase() === username?.toLowerCase()
    );

    // ARCHON (N36): running out of patience is not a verdict.
    //
    // The server distinguishes "this game will never be rated, here is why"
    // from "the rating has not landed yet", and only the first is something to
    // report. When the poll budget runs out with the answer still pending, the
    // game is in all likelihood being rated right now - saying it was not is
    // both wrong and the single most alarming thing this panel could say, since
    // a player reads it as their win not counting.
    if (!data.rated && data.pending) {
        return (
            <div className='rounded-md border border-border/60 bg-surface-secondary/60 px-3 py-2 text-center text-xs text-muted'>
                {t('Still rating this game — it will appear in your Amber history shortly.')}
                {renderActions()}
            </div>
        );
    }

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
                {renderActions()}
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
                    <span>{t('Key margin: {{keys}}', { keys: keyMarginLabel(you.keyDiff) })}</span>
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
            {renderActions()}
        </div>
    );
};

GameResultPanel.displayName = 'GameResultPanel';

export default GameResultPanel;
