import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button as HeroButton, toast } from '@heroui/react';

import Panel from '../Site/Panel';
import { useGetAdaptiveStateQuery, useTournamentActionMutation } from '../../redux/api';

/**
 * ARCHON (N9): the Adaptive Bo3 chain bid.
 *
 * Game 1 is each player's own deck, game 2 swaps them. At 1-1 each deck has
 * won once, so the question is which is stronger - and the players answer it
 * by bidding CHAINS for the right to pilot one of them. The bid is a
 * handicap, so bidding higher means claiming you can win with that deck even
 * burdened by the chains you took on.
 *
 * The bid is on a clock. It has to be shown: an auction that settles itself
 * while a player is still thinking about it would be a worse surprise than
 * the stall the clock exists to prevent.
 */
const AdaptiveBidding = ({ tournamentId, matchId, players }) => {
    const { t } = useTranslation();
    const [chains, setChains] = useState(1);
    const { data, refetch } = useGetAdaptiveStateQuery({ id: tournamentId, matchId });
    const [tournamentAction] = useTournamentActionMutation();
    const [now, setNow] = useState(() => Date.now());

    const bidding = data?.bidding || {};
    const deadline =
        !bidding.resolved && bidding.turnStartedAt && bidding.timeoutMinutes
            ? Date.parse(bidding.turnStartedAt) + bidding.timeoutMinutes * 60 * 1000
            : null;

    useEffect(() => {
        if (!deadline) {
            return undefined;
        }

        const tick = setInterval(() => setNow(Date.now()), 1000);

        return () => clearInterval(tick);
    }, [deadline]);

    // The server settles an expired bid when the table is next read, so asking
    // again is what turns a run-out clock into a result on screen.
    useEffect(() => {
        if (deadline && now >= deadline) {
            refetch();
        }
    }, [deadline, now, refetch]);

    if (!data?.success) {
        return null;
    }

    const nameOf = (userId) =>
        players?.find((player) => player.id === userId)?.username || t('Player');

    if (data.gameNumber < 3) {
        return (
            <Panel title={t('Adaptive series')}>
                <div className='text-sm text-muted'>
                    {data.gameNumber === 1
                        ? t('Game 1 - each player pilots their own deck.')
                        : t('Game 2 - the decks swap.')}
                </div>
            </Panel>
        );
    }

    const act = async (action, body, message) => {
        try {
            const result = await tournamentAction({
                id: tournamentId,
                action: `matches/${matchId}/${action}`,
                body
            }).unwrap();

            if (result.success) {
                toast.success(message);
                refetch();
            } else {
                toast.danger(result.message || t('Action failed'));
            }
        } catch {
            toast.danger(t('Action failed'));
        }
    };

    if (bidding.resolved) {
        const winner = bidding.highBidderId;
        // All three routes out of an auction reach the same outcome, and they
        // are very different things to have happened to you - so the panel
        // says which one it was rather than leaving a player to work out why
        // the bidding ended without them.
        const settledBy = {
            timeout: t('The bid clock ran out.'),
            organizer: t('The organizer settled the bid.')
        }[bidding.resolvedBy];

        return (
            <Panel title={t('Adaptive series - game 3')}>
                <div className='text-sm'>
                    {t('{{name}} pilots {{deck}} carrying {{chains}} chain(s).', {
                        name: nameOf(winner),
                        deck: t("{{name}}'s deck", { name: nameOf(bidding.bidDeckOwnerId) }),
                        chains: bidding.currentBid
                    })}
                </div>
                <div className='mt-1 text-xs text-muted'>
                    {settledBy ? `${settledBy} ` : ''}
                    {t('The other player takes the remaining deck with no chains.')}
                </div>
            </Panel>
        );
    }

    const myTurn = bidding.turnUserId;
    const remaining = deadline ? Math.max(0, deadline - now) : 0;
    const formatRemaining = () => {
        const totalSeconds = Math.ceil(remaining / 1000);
        const minutes = Math.floor(totalSeconds / 60);

        return `${minutes}:${String(totalSeconds % 60).padStart(2, '0')}`;
    };

    return (
        <Panel title={t('Adaptive series - bid for game 3')}>
            <div className='space-y-2 text-sm'>
                <div className='text-muted'>
                    {t('Bidding on {{deck}}.', {
                        deck: t("{{name}}'s deck", { name: nameOf(bidding.bidDeckOwnerId) })
                    })}{' '}
                    {bidding.highBidderId
                        ? t('{{name}} leads at {{chains}} chain(s).', {
                              name: nameOf(bidding.highBidderId),
                              chains: bidding.currentBid
                          })
                        : t('No bids yet.')}
                </div>
                <div className='text-xs text-muted'>
                    {t('Waiting on {{name}}.', { name: nameOf(myTurn) })}
                    {deadline && (
                        <>
                            {' '}
                            {remaining > 0
                                ? t('{{clock}} left to answer.', { clock: formatRemaining() })
                                : t('Time is up - settling the bid.')}
                        </>
                    )}
                </div>
                <div className='flex flex-wrap items-center gap-2'>
                    <input
                        type='number'
                        min={0}
                        max={24}
                        className='w-20 rounded-md border border-border/65 bg-surface-secondary/55 px-2 py-1 text-sm text-foreground'
                        value={chains}
                        onChange={(event) => setChains(event.target.value)}
                    />
                    <HeroButton
                        size='sm'
                        variant='primary'
                        onPress={() =>
                            act('adaptive-bid', { chains: Number(chains) }, t('Bid placed'))
                        }
                    >
                        {t('Bid chains')}
                    </HeroButton>
                    <HeroButton
                        size='sm'
                        variant='tertiary'
                        onPress={() => act('adaptive-pass', {}, t('Passed'))}
                    >
                        {t('Pass')}
                    </HeroButton>
                </div>
                <p className='text-xs text-muted'>
                    {t(
                        'Chains are a handicap you take on, so bids only go up. Passing hands the deck to the high bidder at their own bid.'
                    )}
                </p>
            </div>
        </Panel>
    );
};

AdaptiveBidding.displayName = 'AdaptiveBidding';

export default AdaptiveBidding;
