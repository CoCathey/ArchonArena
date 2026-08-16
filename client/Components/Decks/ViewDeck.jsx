import React, { useState } from 'react';
import { useTranslation, Trans } from 'react-i18next';
import { Button, Modal as HeroModal } from '@heroui/react';
import { useSelector } from 'react-redux';
import Icon from '../Icon';
import { faSync } from '@fortawesome/free-solid-svg-icons';

import DeckSummary from './DeckSummary';
import ShareDeckModal from './ShareDeckModal';
import AercBreakdown from './AercBreakdown';
import Panel from '../Site/Panel';
import {
    useDeleteDeckMutation,
    useGetDeckQuery,
    useRefreshAccoladesMutation
} from '../../redux/api';

/**
 * @typedef ViewDeckProps
 * @property {import('./DeckList').Deck} deck The currently selected deck
 */

/**
 * @param {ViewDeckProps} props
 */
const ViewDeck = ({ deck }) => {
    const [deleteDeck] = useDeleteDeckMutation();
    // ARCHON: the AERC breakdown lives on the deck detail endpoint; the deck in
    // redux comes from the list, which does not carry it. Skipped for
    // standalone decks, which have no Master Vault uuid to look up.
    const { data: deckDetail } = useGetDeckQuery(deck?.id, { skip: !deck?.id });
    const [refreshAccolades] = useRefreshAccoladesMutation();
    const { t } = useTranslation();
    const user = useSelector((state) => state.account.user);
    const [isRefreshing, setIsRefreshing] = useState(false);
    const [isDeleteModalOpen, setIsDeleteModalOpen] = useState(false);
    const [isShareModalOpen, setIsShareModalOpen] = useState(false);
    const showAccolades = user?.settings?.optionSettings?.showAccolades ?? true;

    const handleDeleteClick = () => {
        deleteDeck(deck.id);
        setIsDeleteModalOpen(false);
    };

    const handleRefreshAccolades = async () => {
        setIsRefreshing(true);
        try {
            await refreshAccolades(deck.id);
        } finally {
            setIsRefreshing(false);
        }
    };

    return (
        <Panel
            className='h-full !mb-0'
            contentClassName='flex h-full min-h-0 flex-col'
            title={deck.name}
            headerVariant='context'
            titleClass='text-sm font-semibold tracking-wide'
        >
            <div className='mb-2 text-center'>
                <div className='inline-flex gap-2'>
                    {showAccolades ? (
                        <Button
                            variant='tertiary'
                            onPress={handleRefreshAccolades}
                            isDisabled={isRefreshing}
                        >
                            <span className='inline-flex items-center gap-2'>
                                <Icon icon={faSync} spin={isRefreshing} />
                                <span>{t('Refresh Accolades')}</span>
                            </span>
                        </Button>
                    ) : null}
                    {/* ARCHON: lending is for decks you own. A deck a friend
                        lent you is theirs to lend, not yours to pass on. */}
                    {!deck.sharedFrom && (
                        <Button variant='tertiary' onPress={() => setIsShareModalOpen(true)}>
                            <Trans>Share with a friend</Trans>
                        </Button>
                    )}
                    <Button variant='danger' onPress={() => setIsDeleteModalOpen(true)}>
                        <Trans>Delete</Trans>
                    </Button>
                </div>
            </div>
            {/* ARCHON: a borrowed deck says so, everywhere it is shown. It is
                legal, rated and pooled with its owner's games - but an event
                with an ownership rule needs to know, and so does the player
                looking at their own collection wondering where it came from. */}
            {deck.sharedFrom && (
                <div className='mb-2 text-center'>
                    <span
                        className='inline-block rounded border border-sky-500/30 bg-sky-500/10 px-2 py-0.5 text-xs font-medium text-sky-300'
                        title={t('Your games with it count towards this deck’s record.')}
                    >
                        {t('Shared by {{name}}', { name: deck.sharedFrom })}
                    </span>
                </div>
            )}
            <div className='min-h-0 flex-1 overflow-auto pe-1'>
                {/* ARCHON: the list payload carries only this account's record
                    with the deck; the detail endpoint also carries every
                    owner's. Only those three fields are lifted across - the
                    rest of the detail deck is the raw row, whose `cards` have
                    not been through the redux normaliser this component's
                    rendering depends on. The summary renders immediately
                    either way and gains the second column when it arrives. */}
                <DeckSummary
                    deck={deck}
                    globalWins={deckDetail?.deck?.globalWins}
                    globalLosses={deckDetail?.deck?.globalLosses}
                    globalWinRate={deckDetail?.deck?.globalWinRate}
                />
                {deckDetail?.aerc && (
                    <div className='mt-3 border-t border-border/50 pt-3'>
                        <AercBreakdown aerc={deckDetail.aerc} />
                    </div>
                )}
            </div>
            <HeroModal.Backdrop isOpen={isDeleteModalOpen} onOpenChange={setIsDeleteModalOpen}>
                <HeroModal.Container placement='center'>
                    <HeroModal.Dialog className='sm:max-w-md'>
                        <HeroModal.CloseTrigger />
                        <HeroModal.Header>
                            <HeroModal.Heading>{t('Delete Deck')}</HeroModal.Heading>
                        </HeroModal.Header>
                        <HeroModal.Body>
                            <p className='text-sm text-muted'>
                                {t('Are you sure you want to delete this deck?')}
                            </p>
                        </HeroModal.Body>
                        <HeroModal.Footer>
                            <Button variant='tertiary' onPress={() => setIsDeleteModalOpen(false)}>
                                {t('Cancel')}
                            </Button>
                            <Button variant='danger' onPress={handleDeleteClick}>
                                {t('Delete')}
                            </Button>
                        </HeroModal.Footer>
                    </HeroModal.Dialog>
                </HeroModal.Container>
            </HeroModal.Backdrop>
            <ShareDeckModal
                deck={deck}
                isOpen={isShareModalOpen}
                onOpenChange={setIsShareModalOpen}
            />
        </Panel>
    );
};

export default ViewDeck;
