import React, { useState } from 'react';
import { useSelector } from 'react-redux';
import { useTranslation } from 'react-i18next';
import { Button as HeroButton } from '@heroui/react';

import Panel from '../Site/Panel';
import MatchScheduler from './MatchScheduler';

/** Timestamps come back from Postgres without a zone; they are UTC. */
const asUtc = (value) => {
    if (!value) {
        return null;
    }

    const text = typeof value === 'string' ? value : String(value);
    const time = new Date(text.endsWith('Z') ? text : `${text}Z`);

    return Number.isNaN(time.getTime()) ? null : time;
};

const resultBadges = {
    bye: 'bye',
    forfeit: 'forfeit',
    'no-show': 'no-show',
    'double-loss': 'double loss',
    // Decided by the round clock rather than by finishing the match.
    time: 'time'
};

/**
 * ARCHON: one row per match - players, series score, result state,
 * report buttons for participants, penalty tools for the TO, and a
 * join/watch link when the match's lobby game is live.
 */
const MatchRow = ({ tournament, match, user, act, actionPending }) => {
    const { t } = useTranslation();
    const socket = useSelector((state) => state.lobby.socket);
    const lobbyGames = useSelector((state) => state.lobby.games);
    const currentGameId = useSelector((state) => state.games.gameId);
    const [showTools, setShowTools] = useState(false);
    const [scores, setScores] = useState(null);

    const isParticipant = user && (user.id === match.player1Id || user.id === match.player2Id);
    const decided = !!match.winnerId || !!match.resultType;

    // This match has a result somebody else reported and I have not answered.
    // A result the platform itself produced (an online game, a forfeit from a
    // drop) has no reporter and needs nobody's signature.
    const needsMyAnswer =
        isParticipant &&
        decided &&
        !match.confirmed &&
        !match.disputedBy &&
        !!match.reportedBy &&
        match.reportedBy !== user.id &&
        tournament.status === 'active';
    const canReport =
        tournament.status === 'active' &&
        match.player1Id &&
        match.player2Id &&
        (tournament.canManage || (!decided && isParticipant));

    const lobbyGame = (lobbyGames || []).find(
        (game) => game.tournament && game.tournament.matchId === match.id
    );

    const joinLiveGame = () => {
        if (socket && lobbyGame) {
            socket.emit(lobbyGame.started ? 'watchgame' : 'joingame', lobbyGame.id);
        }
    };

    const seriesLabel =
        match.bestOf > 1 || match.player1Wins + match.player2Wins > 1
            ? ` ${match.player1Wins}-${match.player2Wins}`
            : '';

    // ARCHON (N14): in an async event, when this match is booked for is as
    // much a part of its state as the score - it is what a reader scanning
    // the round wants to know.
    const isAsync = tournament.pacing === 'async';
    const scheduledAt = asUtc(match.scheduledAt);
    const proposedTime = asUtc(match.proposedTime);
    const [showSchedule, setShowSchedule] = useState(false);

    const submitScores = (winnerId) => {
        if (match.bestOf > 1) {
            const winnerIsP1 = winnerId === match.player1Id;
            const needed = Math.floor(match.bestOf / 2) + 1;
            const loserWins = Math.min(
                Math.max(parseInt(scores?.loserWins ?? 0, 10) || 0, 0),
                needed - 1
            );

            act(
                `matches/${match.id}/result`,
                {
                    winnerId,
                    player1Wins: winnerIsP1 ? needed : loserWins,
                    player2Wins: winnerIsP1 ? loserWins : needed
                },
                t('Result recorded')
            );
            setScores(null);
        } else {
            act(`matches/${match.id}/result`, { winnerId }, t('Result recorded'));
        }
    };

    return (
        <div className='rounded bg-surface-secondary/50 px-2 py-1.5 text-sm'>
            <div className='flex flex-wrap items-center gap-2'>
                {match.table && (
                    <span className='text-xs text-muted'>
                        {t('Table {{table}}', { table: match.table })}
                    </span>
                )}
                {match.bracket && (
                    <span className='rounded bg-surface-tertiary/70 px-1 text-xs uppercase text-muted'>
                        {match.bracket === 'GF'
                            ? match.bracketRound === 2
                                ? t('GF Reset')
                                : t('Grand Final')
                            : `${match.bracket}${match.bracketRound}`}
                    </span>
                )}
                {match.player2 || match.player2Id ? (
                    <span className='text-foreground'>
                        {[
                            [match.player1, match.player1Id],
                            [match.player2, match.player2Id]
                        ].map(([name, playerId], index) => (
                            <span key={`${playerId || 'tbd'}-${index}`}>
                                {index === 1 && <span className='text-muted'> vs </span>}
                                <span
                                    className={
                                        match.winnerId && match.winnerId === playerId
                                            ? 'font-bold text-amber-300'
                                            : name
                                            ? ''
                                            : 'italic text-muted'
                                    }
                                >
                                    {name || t('TBD')}
                                </span>
                            </span>
                        ))}
                        {seriesLabel && <span className='ml-1 text-muted'>{seriesLabel}</span>}
                    </span>
                ) : (
                    <span className='text-foreground'>
                        {match.player1 || <span className='italic text-muted'>{t('TBD')}</span>}{' '}
                        <span className='text-xs text-muted'>({t('bye')})</span>
                    </span>
                )}
                {match.resultType && match.resultType !== 'played' && match.player2Id && (
                    <span className='rounded bg-surface-tertiary/70 px-1.5 text-xs italic text-muted'>
                        {t(resultBadges[match.resultType] || match.resultType)}
                    </span>
                )}
                {isAsync && !decided && match.player1Id && match.player2Id && (
                    <span
                        className={`rounded border px-1.5 text-xs ${
                            scheduledAt
                                ? 'border-sky-500/40 bg-sky-500/10 text-sky-300'
                                : proposedTime
                                ? 'border-amber-400/50 bg-amber-400/10 text-amber-300'
                                : 'border-border/60 text-muted'
                        }`}
                        title={
                            scheduledAt
                                ? scheduledAt.toLocaleString()
                                : proposedTime
                                ? t('A time has been proposed and not answered yet')
                                : t('Neither player has proposed a time')
                        }
                    >
                        {scheduledAt
                            ? scheduledAt.toLocaleString(undefined, {
                                  weekday: 'short',
                                  hour: 'numeric',
                                  minute: '2-digit'
                              })
                            : proposedTime
                            ? t('time proposed')
                            : t('unscheduled')}
                    </span>
                )}
                {match.disputedBy ? (
                    <span
                        className='rounded border border-red-500/50 bg-red-500/10 px-1.5 text-xs font-semibold text-red-400'
                        title={match.disputeNote || t('The other player says this result is wrong')}
                    >
                        {t('disputed')}
                    </span>
                ) : (
                    decided &&
                    match.player2Id &&
                    !match.confirmed && (
                        <span
                            className='rounded border border-amber-400/50 bg-amber-400/10 px-1.5 text-xs text-amber-300'
                            title={t('Reported by one player; the other has not agreed yet')}
                        >
                            {t('unconfirmed')}
                        </span>
                    )
                )}
                {lobbyGame && !decided && (
                    <button
                        type='button'
                        onClick={joinLiveGame}
                        disabled={!!currentGameId}
                        className='inline-flex items-center gap-1 rounded border border-emerald-500/50 bg-emerald-500/10 px-1.5 py-0.5 text-xs text-emerald-400 hover:bg-emerald-500/20 disabled:opacity-50'
                    >
                        <span className='inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-400' />
                        {lobbyGame.started
                            ? t('In game - watch')
                            : isParticipant
                            ? t('Join table')
                            : t('Table open')}
                    </button>
                )}
                <span className='ml-auto flex flex-wrap items-center gap-1'>
                    {/* The opponent's answer to a result somebody else typed
                        in. Only shown to the player who did not report it -
                        agreeing with yourself is what confirmation is for. */}
                    {needsMyAnswer && (
                        <>
                            <HeroButton
                                size='sm'
                                variant='primary'
                                className='!h-6 !px-2 text-xs'
                                isDisabled={actionPending}
                                onPress={() =>
                                    act(`matches/${match.id}/confirm`, {}, t('Result confirmed'))
                                }
                            >
                                {t('Confirm result')}
                            </HeroButton>
                            <HeroButton
                                size='sm'
                                variant='tertiary'
                                className='!h-6 !px-2 text-xs'
                                isDisabled={actionPending}
                                onPress={() => {
                                    const note = window.prompt(
                                        t('What actually happened? The organizer will see this.')
                                    );

                                    if (note === null) {
                                        return;
                                    }

                                    act(
                                        `matches/${match.id}/dispute`,
                                        { note },
                                        t('The organizer has been notified')
                                    );
                                }}
                            >
                                {t('Dispute')}
                            </HeroButton>
                        </>
                    )}
                    {canReport &&
                        !scores &&
                        [
                            [match.player1Id, match.player1],
                            [match.player2Id, match.player2]
                        ].map(([playerId, name]) => (
                            <HeroButton
                                key={playerId}
                                size='sm'
                                variant='tertiary'
                                className='!h-6 !px-2 text-xs'
                                isDisabled={actionPending}
                                onPress={() =>
                                    match.bestOf > 1
                                        ? setScores({ winnerId: playerId, loserWins: 0 })
                                        : submitScores(playerId)
                                }
                            >
                                {t('{{name}} won', { name })}
                            </HeroButton>
                        ))}
                    {isAsync &&
                        isParticipant &&
                        !decided &&
                        match.player2Id &&
                        tournament.status === 'active' && (
                            <HeroButton
                                size='sm'
                                variant={scheduledAt ? 'tertiary' : 'primary'}
                                className='!h-6 !px-2 text-xs'
                                onPress={() => setShowSchedule((open) => !open)}
                            >
                                {scheduledAt ? t('Reschedule') : t('Schedule…')}
                            </HeroButton>
                        )}
                    {/* ARCHON: available on a decided match too. A disputed
                        result is by definition decided - somebody objected to
                        it - and the ruling is often "my opponent never showed
                        up" or "we both ran out of time", which is exactly what
                        these tools record. Gated on !decided, the only lever
                        left was re-reporting a played win, which files a false
                        result type. */}
                    {tournament.canManage &&
                        tournament.status === 'active' &&
                        match.player1Id &&
                        match.player2Id && (
                            <HeroButton
                                size='sm'
                                variant='tertiary'
                                className='!h-6 !px-2 text-xs'
                                onPress={() => setShowTools((open) => !open)}
                            >
                                {decided ? t('Judge (change)…') : t('Judge…')}
                            </HeroButton>
                        )}
                </span>
            </div>
            {showSchedule && (
                <MatchScheduler
                    match={match}
                    user={user}
                    opponentName={user?.id === match.player1Id ? match.player2 : match.player1}
                    act={act}
                    deadline={tournament.roundEndsAt}
                />
            )}
            {scores && (
                <div className='mt-1.5 flex flex-wrap items-center gap-2 border-t border-border/40 pt-1.5 text-xs'>
                    <span className='text-muted'>
                        {t('Games won by the loser (best of {{bestOf}})', {
                            bestOf: match.bestOf
                        })}
                    </span>
                    <select
                        className='rounded border border-border/70 bg-surface-secondary/80 px-1 py-0.5 text-xs text-foreground'
                        value={scores.loserWins}
                        onChange={(event) =>
                            setScores({ ...scores, loserWins: event.target.value })
                        }
                    >
                        {Array.from({ length: Math.floor(match.bestOf / 2) + 1 }, (_, index) => (
                            <option key={index} value={index}>
                                {index}
                            </option>
                        ))}
                    </select>
                    <HeroButton
                        size='sm'
                        variant='primary'
                        className='!h-6 !px-2 text-xs'
                        onPress={() => submitScores(scores.winnerId)}
                    >
                        {t('Confirm')}
                    </HeroButton>
                    <HeroButton
                        size='sm'
                        variant='tertiary'
                        className='!h-6 !px-2 text-xs'
                        onPress={() => setScores(null)}
                    >
                        {t('Cancel')}
                    </HeroButton>
                </div>
            )}
            {showTools && (
                <div className='mt-1.5 flex flex-wrap items-center gap-1 border-t border-border/40 pt-1.5'>
                    {[
                        [match.player1Id, match.player1],
                        [match.player2Id, match.player2]
                    ].map(([playerId, name]) => (
                        <React.Fragment key={playerId}>
                            <HeroButton
                                size='sm'
                                variant='tertiary'
                                className='!h-6 !px-2 text-xs'
                                onPress={() => {
                                    act(
                                        `matches/${match.id}/award`,
                                        { winnerId: playerId, resultType: 'forfeit' },
                                        t('Win awarded')
                                    );
                                    setShowTools(false);
                                }}
                            >
                                {t('Forfeit win: {{name}}', { name })}
                            </HeroButton>
                            <HeroButton
                                size='sm'
                                variant='tertiary'
                                className='!h-6 !px-2 text-xs'
                                onPress={() => {
                                    act(
                                        `matches/${match.id}/award`,
                                        { winnerId: playerId, resultType: 'no-show' },
                                        t('Win awarded')
                                    );
                                    setShowTools(false);
                                }}
                            >
                                {t('No-show win: {{name}}', { name })}
                            </HeroButton>
                        </React.Fragment>
                    ))}
                    {!match.bracket && (
                        <HeroButton
                            size='sm'
                            variant='tertiary'
                            className='!h-6 !px-2 text-xs'
                            onPress={() => {
                                act(
                                    `matches/${match.id}/double-loss`,
                                    {},
                                    t('Double loss recorded')
                                );
                                setShowTools(false);
                            }}
                        >
                            {t('Double loss')}
                        </HeroButton>
                    )}
                    {tournament.mode === 'online' && !lobbyGame && (
                        <HeroButton
                            size='sm'
                            variant='tertiary'
                            className='!h-6 !px-2 text-xs'
                            onPress={() => {
                                act(`matches/${match.id}/open-game`, {}, t('Table opened'));
                                setShowTools(false);
                            }}
                        >
                            {t('Reopen table')}
                        </HeroButton>
                    )}
                    {/* ARCHON (N9 follow-up): game 3 of an Adaptive Bo3 waits
                        for the chain bid before a table opens, and a pair who
                        neither bid nor pass leave the round stuck on them with
                        no other lever than ending the whole series. This
                        settles the bid as if whoever is on the clock passed,
                        so the round can move on without deciding the match. */}
                    {tournament.adaptiveBo3 &&
                        !decided &&
                        match.player1Wins === 1 &&
                        match.player2Wins === 1 && (
                            <HeroButton
                                size='sm'
                                variant='tertiary'
                                className='!h-6 !px-2 text-xs'
                                onPress={() => {
                                    act(
                                        `matches/${match.id}/adaptive-force-resolve`,
                                        {},
                                        t('Bid resolved')
                                    );
                                    setShowTools(false);
                                }}
                            >
                                {t('Force-resolve bid')}
                            </HeroButton>
                        )}
                </div>
            )}
        </div>
    );
};
MatchRow.displayName = 'MatchRow';

/**
 * ARCHON: matches grouped by round, newest round first while the event
 * runs so the live round is always on top.
 */
const RoundsPanel = ({ tournament, matches, user, act, actionPending, onPrint }) => {
    const { t } = useTranslation();

    const rounds = [];
    for (const match of matches) {
        (rounds[match.round] = rounds[match.round] || []).push(match);
    }

    const roundNumbers = rounds
        .map((roundMatches, round) => (roundMatches ? round : null))
        .filter((round) => round !== null);

    if (tournament.status === 'active') {
        roundNumbers.reverse();
    }

    // What is actually holding the round up, and what the organizer has to
    // look at. Both were previously invisible: the only signal that the round
    // could not advance was the error message when they tried.
    const currentMatches = rounds[tournament.currentRound] || [];
    const openMatches = currentMatches.filter(
        (match) => match.player1Id && match.player2Id && !match.winnerId && !match.resultType
    );
    const disputed = matches.filter((match) => match.disputedBy);
    const showRoundTools =
        tournament.canManage && tournament.status === 'active' && currentMatches.length > 0;
    const isAsync = tournament.pacing === 'async';
    // ARCHON (N14): in an async round the organizer's question is not "how
    // long is left" but "who has not even booked a time" - those are the
    // pairs that will still be open when the deadline arrives.
    const unscheduled = isAsync
        ? openMatches.filter((match) => !match.scheduledAt && !match.proposedTime)
        : [];

    return (
        <Panel
            title={t('Rounds')}
            titleClass='flex items-center justify-between'
            headerTextClassName='flex-1'
        >
            {disputed.length > 0 && tournament.canManage && (
                <div className='mb-3 rounded-md border border-red-500/50 bg-red-500/10 p-2 text-sm'>
                    <div className='font-semibold text-red-400'>
                        {t('{{count}} disputed result needs you', { count: disputed.length })}
                    </div>
                    <ul className='mt-1 space-y-0.5 text-xs text-muted'>
                        {disputed.map((match) => (
                            <li key={match.id}>
                                {t('Round {{round}}', { round: match.round })}: {match.player1}{' '}
                                {t('vs')} {match.player2}
                                {match.disputeNote && ` - "${match.disputeNote}"`}
                            </li>
                        ))}
                    </ul>
                    <div className='mt-1 text-xs text-muted'>
                        {t('Record the correct result on the match to clear it.')}
                    </div>
                </div>
            )}
            {showRoundTools && (
                <div className='mb-3 flex flex-wrap items-center gap-2 rounded-md border border-border/70 bg-surface-secondary/40 p-2 text-sm'>
                    <span className='text-muted'>
                        {openMatches.length === 0
                            ? t('Every match in this round is in.')
                            : t('{{count}} match still to report', {
                                  count: openMatches.length
                              })}
                        {isAsync && unscheduled.length > 0 && (
                            <span className='ml-1 text-amber-300'>
                                {t('({{count}} with no time booked)', {
                                    count: unscheduled.length
                                })}
                            </span>
                        )}
                    </span>
                    <span className='ml-auto flex flex-wrap gap-2'>
                        {/* An async round is measured in days, so the useful
                            extension is a day - "+5 min" on a three-day round
                            is a click that does nothing anyone can see. */}
                        <HeroButton
                            size='sm'
                            variant='tertiary'
                            className='!h-7 !px-2 text-xs'
                            isDisabled={actionPending}
                            onPress={() =>
                                act(
                                    'round-clock',
                                    { minutes: isAsync ? 24 * 60 : 5 },
                                    t('Round extended')
                                )
                            }
                        >
                            {isAsync ? t('+1 day') : t('+5 min')}
                        </HeroButton>
                        {openMatches.length > 0 && (
                            <HeroButton
                                size='sm'
                                variant='primary'
                                className='!h-7 !px-2 text-xs'
                                isDisabled={actionPending}
                                onPress={() => {
                                    // ARCHON: the old wording promised a draw,
                                    // which this has never done - a level
                                    // match is recorded as a loss for both
                                    // players, and the scoring model has no
                                    // draw in it at all. At an event that
                                    // takes paper results it also cannot
                                    // decide a match nobody has reported yet,
                                    // because 0-0 there means "not told", not
                                    // "level".
                                    if (
                                        !window.confirm(
                                            t(
                                                'Time in the round: decide all {{count}} open match(es) on the game score so far? A match that is level goes down as a loss for both players.',
                                                { count: openMatches.length }
                                            )
                                        )
                                    ) {
                                        return;
                                    }

                                    act('resolve-unfinished', {}, (result) =>
                                        result.undecidable?.length
                                            ? t(
                                                  '{{resolved}} decided; {{left}} still need you - nobody has reported a score for them.',
                                                  {
                                                      resolved: result.resolved,
                                                      left: result.undecidable.length
                                                  }
                                              )
                                            : t('{{resolved}} open match(es) resolved on time', {
                                                  resolved: result.resolved
                                              })
                                    );
                                }}
                            >
                                {t('Time in the round')}
                            </HeroButton>
                        )}
                    </span>
                </div>
            )}
            {roundNumbers.length === 0 ? (
                <div className='text-sm text-muted'>
                    {t('Pairings appear when the tournament starts')}
                </div>
            ) : (
                <div className='space-y-3'>
                    {roundNumbers.map((roundNumber) => (
                        <div key={roundNumber}>
                            <div className='mb-1 flex items-center gap-2 text-xs uppercase tracking-wide text-muted'>
                                {t('Round {{round}}', { round: roundNumber })}
                                {roundNumber === tournament.currentRound &&
                                    tournament.status === 'active' && (
                                        <span className='rounded bg-amber-400/15 px-1.5 text-amber-300'>
                                            {t('current')}
                                        </span>
                                    )}
                                {onPrint && (
                                    <button
                                        type='button'
                                        className='ml-auto text-muted underline-offset-2 hover:text-foreground hover:underline'
                                        onClick={() => onPrint(roundNumber)}
                                    >
                                        {t('print')}
                                    </button>
                                )}
                            </div>
                            <div className='space-y-1'>
                                {rounds[roundNumber].map((match) => (
                                    <MatchRow
                                        key={match.id}
                                        tournament={tournament}
                                        match={match}
                                        user={user}
                                        act={act}
                                        actionPending={actionPending}
                                    />
                                ))}
                            </div>
                        </div>
                    ))}
                </div>
            )}
        </Panel>
    );
};

RoundsPanel.displayName = 'RoundsPanel';

export default RoundsPanel;
