import React from 'react';
import { useTranslation } from 'react-i18next';

/**
 * The enlarged card shown while the pointer is over one.
 *
 * ARCHON (N15): it also names the cards currently acting on this one. A
 * persistent effect never prompts and mostly never logs, so a creature printed
 * at 5 sitting at 9 was a number with no explanation anywhere in the interface.
 * This is where a player already looks when they want to understand a card.
 */
const CardZoom = ({ card }) => {
    const { t } = useTranslation();
    const sources = card.effectSources || [];

    return (
        <div
            className={`card-zoom ${card.size} ${card.orientation} ${card.zoomClass || ''} shadow`}
        >
            {card.image}
            {sources.length > 0 && (
                <div className='card-zoom-effects'>
                    <span className='card-zoom-effects-label'>{t('Affected by')}</span>{' '}
                    {sources.join(', ')}
                </div>
            )}
        </div>
    );
};

CardZoom.displayName = 'CardZoom';

export default CardZoom;
