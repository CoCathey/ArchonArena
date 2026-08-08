import React from 'react';
import { useSelector } from 'react-redux';
import { useTranslation } from 'react-i18next';
import { Button as HeroButton } from '@heroui/react';

import Panel from '../Site/Panel';
import AmberValue from '../Site/AmberValue';
import Link from '../Navigation/Link';
import MatchScheduler from './MatchScheduler';

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

    // A result somebody else typed in that I have not answered. Results the
    // platform produced itself (an online game, a forfeit from a drop) carry no
    // reporter and need nobody's signature.
    const needsMyAnswer =
        decided &&
        !myMatch.confirmed &&
        !myMatch.disputedBy &&
        !!myMatch.reportedBy &&
        myMatch.reportedBy !== user.id;
    const won = myMatch.winnerId === user.id;
    const myWins = myMatch.player1Id === user.id ? myMatch.player1Wins : myMatch.player2Wins;
    const theirWins = myMatch.player1Id === user.id ? myMatch.player2Wins : myMatch.player1Wins;

    const lobbyGame = (lobbyGames || []).find(
        (game) => game.tournament && game.tournament.matchId === myMatch.id
    );

    // Triad ban/pick state for this match (official KeyForge format:
    // ban one of your opponent's three decks, then pilot one of your
    // own two survivors).
    const isP1 = myMatch.player1Id === user.id;
    const myBannedDeckId = isP1 ? myMatch.p1BannedDeckId : myMatch.p2BannedDeckId;
    const oppBannedDeckId = isP1 ? myMatch.p2BannedDeckId : myMatch.p1BannedDeckId;
    const myPickedDeckId = isP1 ? myMatch.p1DeckId : myMatch.p2DeckId;
    const oppPickedDeckId = isP1 ? myMatch.p2DeckId : myMatch.p1DeckId;
    const myPool = players.find((player) => player.userId === user.id)?.triadDecks || [];
    const oppPool = opponent?.triadDecks || [];

    const triadStep =
        tournament.triad && !decided
            ? !oppBannedDeckId
                ? 'ban'
                : !myBannedDeckId
                ? 'wait-ban'
                : !myPickedDeckId
                ? 'pick'
                : !oppPickedDeckId
                ? 'wait-pick'
                : null
            : null;

    return (
        <Panel title={t('Your Match - Round {{round}}', { round: tournament.currentRound })}>
            <div className='flex flex-wrap items-center gap-x-4 gap-y-2 text-sm'>
                <div>
                    <span className='text-muted'>{t('Opponent')}: </span>
                    {opponent?.username ? (
                        <Link
                            href={`/players/${encodeURIComponent(opponent.username)}`}
                            className='font-semibold text-foreground hover:text-amber-300 hover:underline'
                        >
                            {opponent.username}
                        </Link>
                    ) : (
                        <span className='font-semibold text-foreground'>{t('Unknown')}</span>
                    )}
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
                    {triadStep ? (
                        <span className='text-muted'>
                            {triadStep === 'ban'
                                ? t('Triad: ban one of their decks below')
                                : triadStep === 'wait-ban'
                                ? t('Triad: waiting for their ban')
                                : triadStep === 'pick'
                                ? t('Triad: choose your deck below')
                                : t('Triad: waiting for their deck choice')}
                        </span>
                    ) : decided ? (
                        <span className={`font-bold ${won ? 'text-emerald-400' : 'text-red-400'}`}>
                            {won ? t('You won this match') : t('You lost this match')}
                        </span>
                    ) : tournament.mode === 'online' ? (
                        // ARCHON (N14): in an async event the table is opened
                        // when the players actually meet, so the button is the
                        // same one - it just is not pre-opened for them.
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
            {/* ARCHON (N14): asynchronous events give the players days to find
                an hour between them, so the scheduling exchange belongs right
                here - on the match, next to the way into the game. */}
            {tournament.pacing === 'async' && !decided && myMatch.player2Id && (
                <MatchScheduler
                    match={myMatch}
                    user={user}
                    opponentName={opponent?.username}
                    act={act}
                    deadline={tournament.roundEndsAt}
                />
            )}
            {/* ARCHON: the other player wrote down a result and this is the
                first place you would look for it. Without this, "You lost this
                match" was the end of the conversation as far as the platform
                was concerned. */}
            {needsMyAnswer && (
                <div className='mt-2 flex flex-wrap items-center gap-2 border-t border-border/40 pt-2'>
                    <span className='text-sm text-amber-300'>
                        {t('{{name}} reported this result. Does that match your game?', {
                            name: opponent?.username || t('Your opponent')
                        })}
                    </span>
                    <span className='ml-auto flex gap-2'>
                        <HeroButton
                            size='sm'
                            variant='primary'
                            onPress={() =>
                                act(`matches/${myMatch.id}/confirm`, {}, t('Result confirmed'))
                            }
                        >
                            {t('Yes, confirm')}
                        </HeroButton>
                        <HeroButton
                            size='sm'
                            variant='tertiary'
                            onPress={() => {
                                const note = window.prompt(
                                    t('What actually happened? The organizer will see this.')
                                );

                                if (note === null) {
                                    return;
                                }

                                act(
                                    `matches/${myMatch.id}/dispute`,
                                    { note },
                                    t('The organizer has been notified')
                                );
                            }}
                        >
                            {t('No, dispute it')}
                        </HeroButton>
                    </span>
                </div>
            )}
            {myMatch.disputedBy === user.id && (
                <div className='mt-2 border-t border-border/40 pt-2 text-sm text-muted'>
                    {t('You disputed this result. The organizer will sort it out.')}
                </div>
            )}
            {triadStep === 'ban' && (
                <div className='mt-2 border-t border-border/40 pt-2'>
                    <div className='mb-1 text-xs uppercase tracking-wide text-muted'>
                        {t("Ban one of {{name}}'s decks", { name: opponent?.username })}
                    </div>
                    <div className='flex flex-wrap gap-2'>
                        {oppPool.map((deck) => (
                            <HeroButton
                                key={deck.deckId}
                                size='sm'
                                variant='tertiary'
                                onPress={() =>
                                    act(
                                        `matches/${myMatch.id}/triad-ban`,
                                        { deckId: deck.deckId },
                                        t('Deck banned')
                                    )
                                }
                            >
                                {deck.deckName}
                                {deck.deckSas != null && ` (${deck.deckSas})`}
                            </HeroButton>
                        ))}
                    </div>
                </div>
            )}
            {triadStep === 'pick' && (
                <div className='mt-2 border-t border-border/40 pt-2'>
                    <div className='mb-1 text-xs uppercase tracking-wide text-muted'>
                        {t('Your deck for this match (they banned {{name}})', {
                            name:
                                myPool.find((deck) => deck.deckId === myBannedDeckId)?.deckName ||
                                t('one')
                        })}
                    </div>
                    <div className='flex flex-wrap gap-2'>
                        {myPool
                            .filter((deck) => deck.deckId !== myBannedDeckId)
                            .map((deck) => (
                                <HeroButton
                                    key={deck.deckId}
                                    size='sm'
                                    variant='primary'
                                    onPress={() =>
                                        act(
                                            `matches/${myMatch.id}/triad-pick`,
                                            { deckId: deck.deckId },
                                            t('Deck locked in')
                                        )
                                    }
                                >
                                    {deck.deckName}
                                    {deck.deckSas != null && ` (${deck.deckSas})`}
                                </HeroButton>
                            ))}
                    </div>
                </div>
            )}
        </Panel>
    );
};

MyMatchPanel.displayName = 'MyMatchPanel';

export default MyMatchPanel;
