import React, { useState } from 'react';
import { useSelector } from 'react-redux';
import { useTranslation } from 'react-i18next';
import { Button as HeroButton } from '@heroui/react';

import Panel from '../Site/Panel';

const resultBadges = {
    bye: 'bye',
    forfeit: 'forfeit',
    'no-show': 'no-show',
    'double-loss': 'double loss'
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
                    {tournament.canManage &&
                        tournament.status === 'active' &&
                        !decided &&
                        match.player1Id &&
                        match.player2Id && (
                            <HeroButton
                                size='sm'
                                variant='tertiary'
                                className='!h-6 !px-2 text-xs'
                                onPress={() => setShowTools((open) => !open)}
                            >
                                {t('Judge…')}
                            </HeroButton>
                        )}
                </span>
            </div>
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

    return (
        <Panel
            title={t('Rounds')}
            titleClass='flex items-center justify-between'
            headerTextClassName='flex-1'
        >
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
