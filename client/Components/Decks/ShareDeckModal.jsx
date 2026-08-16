import React, { useEffect, useState } from 'react';
import PropTypes from 'prop-types';
import { Button, Modal as HeroModal } from '@heroui/react';
import { useTranslation } from 'react-i18next';

import { useGetFriendsQuery, useShareDeckMutation } from '../../redux/api';

/**
 * ARCHON: lend a deck to a friend.
 *
 * Picking from the friend list rather than typing a name: the server only
 * accepts friends anyway, so a free-text box would exist mainly to produce
 * "you can only lend decks to friends" at people who have spelled a name
 * correctly. The refusals it cannot pre-empt - they already have the deck, the
 * offer is already out - come back from the server and are shown verbatim,
 * because each one tells the sharer something different about what to do next.
 */
const ShareDeckModal = ({ deck, isOpen, onOpenChange }) => {
    const { t } = useTranslation();
    const { data: friendData, isFetching } = useGetFriendsQuery(undefined, { skip: !isOpen });
    const [shareDeck, shareState] = useShareDeckMutation();
    const [sentTo, setSentTo] = useState([]);

    useEffect(() => {
        if (isOpen) {
            setSentTo([]);
            shareState.reset();
        }
        // shareState is a new object every render; resetting on open is the
        // only behaviour wanted here.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [isOpen]);

    const friends = friendData?.friends || [];

    const onShare = async (username) => {
        try {
            await shareDeck({ deckId: deck.id, username }).unwrap();
            setSentTo((previous) => [...previous, username]);
        } catch {
            // Rendered from shareState.error below.
        }
    };

    return (
        <HeroModal.Backdrop isOpen={isOpen} onOpenChange={onOpenChange}>
            <HeroModal.Container placement='center'>
                <HeroModal.Dialog className='sm:max-w-md'>
                    <HeroModal.CloseTrigger />
                    <HeroModal.Header>
                        <HeroModal.Heading>{t('Share deck')}</HeroModal.Heading>
                    </HeroModal.Header>
                    <HeroModal.Body>
                        <p className='mb-3 text-sm text-muted'>
                            {t(
                                'Your friend gets a copy of {{deck}} in their decks, badged as yours. Games they play with it count towards the deck’s record.',
                                { deck: deck?.name }
                            )}
                        </p>

                        {isFetching && <p className='text-sm text-muted'>{t('Loading…')}</p>}

                        {!isFetching && friends.length === 0 && (
                            <p className='text-sm text-muted'>
                                {t('Add a friend first — decks are only lent to friends.')}
                            </p>
                        )}

                        <ul className='m-0 max-h-64 list-none space-y-1 overflow-auto p-0'>
                            {friends.map((friend) => {
                                const name = friend.username || friend.name;
                                const sent = sentTo.includes(name);

                                return (
                                    <li
                                        className='flex items-center justify-between gap-2 rounded-md border border-border/50 bg-surface-secondary/30 px-2.5 py-1.5'
                                        key={name}
                                    >
                                        <span className='truncate text-sm'>{name}</span>
                                        <Button
                                            isDisabled={sent || shareState.isLoading}
                                            onPress={() => onShare(name)}
                                            size='sm'
                                            variant={sent ? 'tertiary' : 'primary'}
                                        >
                                            {sent ? t('Sent') : t('Share')}
                                        </Button>
                                    </li>
                                );
                            })}
                        </ul>

                        {shareState.error && (
                            <p className='mt-3 text-sm text-rose-300'>
                                {shareState.error?.data?.message ||
                                    t('That deck could not be shared.')}
                            </p>
                        )}
                    </HeroModal.Body>
                    <HeroModal.Footer>
                        <Button onPress={() => onOpenChange(false)} variant='tertiary'>
                            {t('Done')}
                        </Button>
                    </HeroModal.Footer>
                </HeroModal.Dialog>
            </HeroModal.Container>
        </HeroModal.Backdrop>
    );
};

ShareDeckModal.propTypes = {
    deck: PropTypes.object,
    isOpen: PropTypes.bool,
    onOpenChange: PropTypes.func
};

export default ShareDeckModal;
