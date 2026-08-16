import React from 'react';
import { Button } from '@heroui/react';
import { useTranslation } from 'react-i18next';

import Panel from '../Site/Panel';
import {
    useAcceptDeckShareMutation,
    useDeclineDeckShareMutation,
    useGetDeckSharesQuery,
    useRevokeDeckShareMutation
} from '../../redux/api';

/**
 * ARCHON: decks friends have offered to lend, and the ones you have offered.
 *
 * Renders nothing at all when there is nothing outstanding. A panel that is
 * permanently empty teaches people to stop reading it, and this one has to be
 * noticed on the day it is not empty.
 */
const DeckShareOffers = () => {
    const { t } = useTranslation();
    const { data } = useGetDeckSharesQuery();
    const [accept, acceptState] = useAcceptDeckShareMutation();
    const [decline] = useDeclineDeckShareMutation();
    const [revoke] = useRevokeDeckShareMutation();

    const incoming = data?.incoming || [];
    const pendingOut = (data?.outgoing || []).filter((share) => share.status === 'pending');

    if (!incoming.length && !pendingOut.length) {
        return null;
    }

    return (
        <Panel
            headerVariant='context'
            title={t('Shared decks')}
            titleClass='text-sm font-medium tracking-wide text-foreground/85'
        >
            <div className='space-y-2'>
                {incoming.map((offer) => (
                    <div
                        className='flex flex-wrap items-center gap-2 rounded-md border border-border/50 bg-surface-secondary/30 px-3 py-2'
                        key={offer.id}
                    >
                        <div className='min-w-0 flex-1'>
                            <div className='truncate text-sm font-semibold'>{offer.deckName}</div>
                            <div className='text-xs text-muted'>
                                {t('{{from}} wants to lend you this deck', { from: offer.from })}
                                {offer.sasRating != null && ` · ${t('SAS')} ${offer.sasRating}`}
                            </div>
                        </div>
                        <Button
                            isDisabled={acceptState.isLoading}
                            onPress={() => accept(offer.id)}
                            size='sm'
                            variant='primary'
                        >
                            {t('Add to my decks')}
                        </Button>
                        <Button onPress={() => decline(offer.id)} size='sm' variant='tertiary'>
                            {t('No thanks')}
                        </Button>
                    </div>
                ))}

                {pendingOut.map((offer) => (
                    <div
                        className='flex flex-wrap items-center gap-2 rounded-md border border-border/40 px-3 py-2'
                        key={`out-${offer.id}`}
                    >
                        <div className='min-w-0 flex-1 text-xs text-muted'>
                            {t('Waiting for {{to}} to accept {{deck}}', {
                                to: offer.to,
                                deck: offer.deckName
                            })}
                        </div>
                        <Button onPress={() => revoke(offer.id)} size='sm' variant='tertiary'>
                            {t('Withdraw')}
                        </Button>
                    </div>
                ))}

                {acceptState.error && (
                    <p className='m-0 text-sm text-rose-300'>
                        {acceptState.error?.data?.message || t('That deck could not be added.')}
                    </p>
                )}
            </div>
        </Panel>
    );
};

export default DeckShareOffers;
