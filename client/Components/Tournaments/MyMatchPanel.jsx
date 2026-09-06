import React, { useState } from 'react';
import { useSelector } from 'react-redux';
import { useTranslation } from 'react-i18next';
import { Button as HeroButton } from '@heroui/react';

import Panel from '../Site/Panel';
import AmberValue from '../Site/AmberValue';
import PlayerName from '../Site/PlayerName';
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
    // The table request is a round trip that used to be invisible. See the
    // button.
    const [opening, setOpening] = useState(false);

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

    /**
     * ARCHON: the table for the game being played NOW, not the first one found.
     *
     * A best-of-three has a table per game and the finished ones stay in the
     * lobby list, so matching on the match id alone returns whichever arrived
     * first - which after game one is always the game that just ended. The
     * button then offered to rejoin a finished game, or to open a table that
     * already existed, and a player who pressed it again got another table.
     *
     * The game number is derivable here: games played plus one, exactly as the
     * server numbers them.
     */
    const currentGameNumber = (myMatch.player1Wins || 0) + (myMatch.player2Wins || 0) + 1;
    const tablesForMatch = (lobbyGames || []).filter(
        (game) => game.tournament && game.tournament.matchId === myMatch.id
    );
    const lobbyGame =
        tablesForMatch.find((game) => game.tournament.gameNumber === currentGameNumber) ||
        // No table for this game number yet. Anything unstarted is still worth
        // offering - a single-game match has no numbering to speak of, and an
        // older build's table carries none.
        tablesForMatch.find((game) => !game.started && !game.tournament.gameNumber);

    // Triad ban/pick state for this match (official KeyForge format:
    // ban one of your opponent's three decks, then pilot one of your
    // own two survivors).
    const isP1 = myMatch.player1Id === user.id;
    const myBannedDeckId = isP1 ? myMatch.p1BannedDeckId : myMatch.p2BannedDeckId;
    const oppBannedDeckId = isP1 ? myMatch.p2BannedDeckId : myMatch.p1BannedDeckId;
    const myPickedDeckId = isP1 ? myMatch.p1DeckId : myMatch.p2DeckId;
    const oppPickedDeckId = isP1 ? myMatch.p2DeckId : myMatch.p1DeckId;
    const me = players.find((player) => player.userId === user.id);
    const myDeckName = me?.deckName;
    const myPool = me?.triadDecks || [];
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
                        <PlayerName
                            className='hover:text-amber-300'
                            link
                            username={opponent.username}
                        />
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
                    ) : tournament.mode !== 'irl' ? (
                        // ARCHON (N14): in an async event the table is opened
                        // when the players actually meet, so the button is the
                        // same one - it just is not pre-opened for them.
                        //
                        // ARCHON: a hybrid event reaches the same button by a
                        // different road. Its pairings may be played here or
                        // across a table, and nobody knows which until the two
                        // players decide - so both routes are offered and the
                        // pair take whichever they are actually using.
                        lobbyGame ? (
                            <HeroButton
                                size='sm'
                                variant='primary'
                                // ARCHON: 'joingame' for both states. A started
                                // table used to send 'watchgame', which is the
                                // spectator door - it either did nothing or
                                // replaced this player's own seat with a
                                // spectator of their own game. The lobby
                                // answers a join at a table you are already
                                // seated at with the handoff back to the
                                // board, which is what "Rejoin" means.
                                onPress={() => socket && socket.emit('joingame', lobbyGame.id)}
                            >
                                {lobbyGame.started ? t('Rejoin game') : t('Join your table')}
                            </HeroButton>
                        ) : (
                            <HeroButton
                                size='sm'
                                variant='primary'
                                // ARCHON: pressed once, and it says so while it
                                // works. The request now waits for the table to
                                // exist rather than returning the moment it is
                                // asked for, and it hands back the table's id -
                                // so this walks straight in instead of leaving
                                // somebody looking at an unchanged button
                                // wondering whether the click registered. That
                                // wondering is what built four tables for one
                                // game of one match.
                                isPending={opening}
                                isDisabled={opening}
                                onPress={async () => {
                                    setOpening(true);

                                    try {
                                        const result = await act(
                                            `matches/${myMatch.id}/open-game`,
                                            {},
                                            t('Your table is ready')
                                        );

                                        if (result?.gameId && socket) {
                                            socket.emit('joingame', result.gameId);
                                        }
                                    } finally {
                                        setOpening(false);
                                    }
                                }}
                            >
                                {opening ? t('Opening your table…') : t('Open my table')}
                            </HeroButton>
                        )
                    ) : (
                        <span className='text-muted'>
                            {t('Play your match and report the result below')}
                        </span>
                    )}
                    {/* In a hybrid event the button is one of two ways to play
                        this match, not the only one. */}
                    {tournament.mode === 'hybrid' && !decided && !triadStep && (
                        <span className='text-muted'>
                            {t('or play it on paper and report the result below')}
                        </span>
                    )}
                </span>
            </div>

            {/* ARCHON: which deck the event has you on. In an event that locks
                decks this is the one thing a player most wants confirmed
                before they sit down, and it was nowhere on the page. */}
            {myDeckName && !tournament.triad && (
                <div className='mt-2 text-sm text-muted'>
                    {t('Your deck')}:{' '}
                    <span className='font-semibold text-foreground'>{myDeckName}</span>
                    {tournament.deckSwapPolicy === 'between-rounds'
                        ? ` - ${t('you may change it between rounds')}`
                        : ` - ${t('locked for this event')}`}
                </div>
            )}
            {/* ARCHON: the conversation around the scheduler. Two people who
                have to agree on a time had a proposal button and no way to say
                "8 works but I might be ten minutes late". The thread opens by
                username, so it is the same conversation from any event. */}
            {opponent?.username && !decided && (
                <div className='mt-2 text-sm'>
                    <Link
                        href={`/messages/${encodeURIComponent(opponent.username)}`}
                        className='text-amber-300 underline-offset-2 hover:underline'
                    >
                        {t('Message {{name}}', { name: opponent.username })}
                    </Link>
                    <span className='ml-1 text-xs text-muted'>
                        {t('to sort out timing or anything else about the match')}
                    </span>
                </div>
            )}
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
