import React, { useState } from 'react';
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
 */
const AdaptiveBidding = ({ tournamentId, matchId, players }) => {
    const { t } = useTranslation();
    const [chains, setChains] = useState(1);
    const { data, refetch } = useGetAdaptiveStateQuery({ id: tournamentId, matchId });
    const [tournamentAction] = useTournamentActionMutation();

    if (!data?.success) {
        return null;
    }

    const nameOf = (userId) =>
        players?.find((player) => player.userId === userId)?.username || t('Player');

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

    const bidding = data.bidding || {};

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
                    {t('The other player takes the remaining deck with no chains.')}
                </div>
            </Panel>
        );
    }

    const myTurn = bidding.turnUserId;

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
                    {bidding.turnDeadlineAt &&
                        ' ' +
                            t('Resolves automatically at {{time}} if nobody acts.', {
                                time: new Date(bidding.turnDeadlineAt).toLocaleString()
                            })}
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
