import React from 'react';
import { Modal as HeroModal } from '@heroui/react';
import { Trans, useTranslation } from 'react-i18next';
import { useSelector } from 'react-redux';

import DeckList from '../Decks/DeckList.jsx';
import { Constants } from '../../constants.js';

const SelectDeckModal = ({
    deckFilter,
    onClose,
    onDeckSelected,
    sasBound,
    expansions = Constants.Expansions
}) => {
    const standaloneDecks = useSelector((state) => state.cards.standaloneDecks);
    const { t } = useTranslation();

    return (
        <HeroModal.Backdrop isOpen onOpenChange={onClose}>
            <HeroModal.Container placement='center'>
                <HeroModal.Dialog className='sm:max-w-5xl'>
                    <HeroModal.CloseTrigger />
                    <HeroModal.Header>
                        <HeroModal.Heading>{t('Select Deck')}</HeroModal.Heading>
                    </HeroModal.Header>
                    <HeroModal.Body>
                        {sasBound ? (
                            <div className='rounded-md border border-amber-500/35 bg-amber-500/10 px-3 py-1.5 text-xs text-amber-700 dark:text-amber-300'>
                                {t(
                                    'This game only accepts decks with a SAS rating between {{min}} and {{max}} - only those decks are listed.',
                                    { min: sasBound.min, max: sasBound.max }
                                )}
                            </div>
                        ) : null}
                        <DeckList
                            deckFilter={deckFilter}
                            hideActionButtons
                            onDeckSelected={onDeckSelected}
                            expansions={expansions}
                        />
                        {/* Standalone decks have no SAS rating, so a bounded
                            game has nothing here it could accept. */}
                        {!sasBound && standaloneDecks && standaloneDecks.length !== 0 ? (
                            <div>
                                <h4 className='ml-4'>
                                    <Trans>Or choose a standalone deck</Trans>:
                                </h4>
                                <DeckList
                                    standaloneDecks
                                    deckFilter={deckFilter}
                                    hideActionButtons
                                    onDeckSelected={onDeckSelected}
                                />
                            </div>
                        ) : null}
                    </HeroModal.Body>
                </HeroModal.Dialog>
            </HeroModal.Container>
        </HeroModal.Backdrop>
    );
};

SelectDeckModal.displayName = 'SelectDeckModal';

export default SelectDeckModal;
