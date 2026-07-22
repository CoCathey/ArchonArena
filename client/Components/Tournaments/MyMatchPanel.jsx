import React from 'react';
import { useSelector } from 'react-redux';
import { useTranslation } from 'react-i18next';
import { Button as HeroButton } from '@heroui/react';

import Panel from '../Site/Panel';
import AmberValue from '../Site/AmberValue';

/**
 * ARCHON: the signed-in player's view of their current-round pairing -
 * opponent (with Amber and deck when visible), table number, series
 * state, and the way into their auto-created game for online events.
 */
const MyMatchPanel = ({ tournament, matches, players, user, act }) => {
    const { t } = useTranslation();
    const socket = useSelector((state) => state.lobby.socket);
    const lobbyGames = useSelector((state) => state.lobby.games);
    const currentGameId = useSelector((state) => state.games.gameId);

    if (!user || tournament.status !== 'active' || !tournament.isRegistered) {
        return null;
    }

    const myMatch = matches.find(
        (match) =>
            match.round === tournament.currentRound &&
            (match.player1Id === user.id || match.player2Id === user.id)
    );

    if (!myMatch) {
        return (
            <Panel title={t('Your Match')}>
                <div className='text-sm text-muted'>
                    {t('No pairing for you this round - stand by for the next one.')}
                </div>
            </Panel>
        );
    }

    if (!myMatch.player2Id && myMatch.resultType === 'bye') {
        return (
            <Panel title={t('Your Match')}>
                <div className='text-sm text-foreground'>
                    {t('You have a bye this round - it counts as a win. Take a breather!')}
                </div>
            </Panel>
        );
    }

    const opponentId = myMatch.player1Id === user.id ? myMatch.player2Id : myMatch.player1Id;
    const opponent = players.find((player) => player.userId === opponentId);
    const decided = !!myMatch.winnerId || !!myMatch.resultType;
    const won = myMatch.winnerId === user.id;
    const myWins = myMatch.player1Id === user.id ? myMatch.player1Wins : myMatch.player2Wins;
    const theirWins = myMatch.player1Id === user.id ? myMatch.player2Wins : myMatch.player1Wins;

    const lobbyGame = (lobbyGames || []).find(
        (game) => game.tournament && game.tournament.matchId === myMatch.id
    );

    return (
        <Panel title={t('Your Match - Round {{round}}', { round: tournament.currentRound })}>
            <div className='flex flex-wrap items-center gap-x-4 gap-y-2 text-sm'>
                <div>
                    <span className='text-muted'>{t('Opponent')}: </span>
                    <span className='font-semibold text-foreground'>
                        {opponent?.username || t('Unknown')}
                    </span>
                    {opponent?.amber != null && (
                        <AmberValue
                            value={opponent.amber}
                            className='ml-2 !text-xs'
                            iconClass='h-3 w-3'
                        />
                    )}
                    {opponent?.deckName && (
                        <span className='ml-2 text-xs text-muted'>
                            {opponent.deckName}
                            {opponent.deckSas != null && ` (${opponent.deckSas} ${t('SAS')})`}
                        </span>
                    )}
                </div>
                {myMatch.table && (
                    <span className='text-muted'>
                        {t('Table {{table}}', { table: myMatch.table })}
                    </span>
                )}
                {myMatch.bestOf > 1 && (
                    <span className='text-muted'>
                        {t('Best of {{bestOf}}', { bestOf: myMatch.bestOf })}
                        {myWins + theirWins > 0 && (
                            <span className='ml-1 font-bold text-foreground'>
                                {myWins}-{theirWins}
                            </span>
                        )}
                    </span>
                )}
                <span className='ml-auto flex flex-wrap gap-2'>
                    {decided ? (
                        <span className={`font-bold ${won ? 'text-emerald-400' : 'text-red-400'}`}>
                            {won ? t('You won this match') : t('You lost this match')}
                        </span>
                    ) : tournament.mode === 'online' ? (
                        lobbyGame ? (
                            <HeroButton
                                size='sm'
                                variant='primary'
                                isDisabled={!!currentGameId && lobbyGame.started}
                                onPress={() =>
                                    socket &&
                                    socket.emit(
                                        lobbyGame.started ? 'watchgame' : 'joingame',
                                        lobbyGame.id
                                    )
                                }
                            >
                                {lobbyGame.started ? t('Rejoin game') : t('Join your table')}
                            </HeroButton>
                        ) : (
                            <HeroButton
                                size='sm'
                                variant='primary'
                                onPress={() =>
                                    act(
                                        `matches/${myMatch.id}/open-game`,
                                        {},
                                        t('Table requested - it appears in a moment')
                                    )
                                }
                            >
                                {t('Open my table')}
                            </HeroButton>
                        )
                    ) : (
                        <span className='text-muted'>
                            {t('Play your match and report the result below')}
                        </span>
                    )}
                </span>
            </div>
        </Panel>
    );
};

MyMatchPanel.displayName = 'MyMatchPanel';

export default MyMatchPanel;
