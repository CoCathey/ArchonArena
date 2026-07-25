import React from 'react';
import { useTranslation } from 'react-i18next';

import AmberValue from './AmberValue';
import { useGetRatingsQuery } from '../../redux/api';

/**
 * ARCHON: map a game format onto its rating pool. Mirrors POOL_BY_FORMAT in
 * server/services/rating/RatingService.js - every constructed variant folds
 * into the main 'archon' ladder; sealed and alliance keep their own pools.
 */
export const poolForFormat = (format) => {
    if (format === 'sealed') {
        return 'sealed';
    }

    if (format === 'alliance') {
        return 'alliance';
    }

    return 'archon';
};

/**
 * ARCHON: a player's Amber (rating) for the pool a given game feeds, shown
 * inline next to their name in the lobby and pending game. Ratings are public
 * (GET /api/ratings/:username) and RTK Query dedupes/caches by username, so a
 * player appearing in several lobby rows costs a single request. Renders
 * nothing until loaded, or when the player is unrated in that pool.
 *
 * @param {{ username?: string, format?: string, className?: string }} props
 */
const PlayerAmber = ({ username, format, className = '' }) => {
    const { t } = useTranslation();
    const { data } = useGetRatingsQuery(username, { skip: !username });

    if (!username) {
        return null;
    }

    const pool = poolForFormat(format);
    const rating = (data?.ratings || []).find((entry) => entry.pool === pool);

    if (!rating) {
        return null;
    }

    return (
        <span
            className={`inline-flex shrink-0 ${className}`}
            title={
                rating.provisional ? t('Provisional Amber (still finding your level)') : t('Amber')
            }
        >
            <AmberValue
                value={rating.rating}
                className={`text-xs ${rating.provisional ? 'opacity-70' : ''}`}
                iconClass='h-3 w-3'
            />
        </span>
    );
};

PlayerAmber.displayName = 'PlayerAmber';

export default PlayerAmber;
