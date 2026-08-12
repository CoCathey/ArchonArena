import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import Droppable from './Droppable';
import SquishableCardPanel from './SquishableCardPanel';
import { shouldHideHand } from './handVisibility';

const PlayerRow = ({
    cardBack,
    cardSize,
    hasActiveHouse,
    hand,
    isMe,
    isSpectating,
    isActivePlayer,
    manualMode,
    onCardClick,
    onDragDrop,
    onMouseOut,
    onMouseOver,
    // ARCHON: the "hide my hand on the opponent's turn" option, and whether
    // the game is currently asking this player for anything.
    hideOnOpponentTurn,
    needsInput
}) => {
    const { t } = useTranslation();
    const [isPeeking, setIsPeeking] = useState(false);

    // A peek lasts until the turn comes back round, so the setting behaves the
    // same way every opponent turn rather than quietly staying off after the
    // one time somebody looked.
    useEffect(() => {
        if (isActivePlayer) {
            setIsPeeking(false);
        }
    }, [isActivePlayer]);

    const hidden = shouldHideHand({
        enabled: hideOnOpponentTurn,
        isMyTurn: isActivePlayer,
        isPeeking,
        needsInput
    });

    let sortedHand = [].concat(hand).sort((a, b) => {
        if (a.printedHouse < b.printedHouse) {
            return -1;
        } else if (a.printedHouse > b.printedHouse) {
            return 1;
        }

        return 0;
    });

    let handToRender = (
        <SquishableCardPanel
            cards={sortedHand}
            className='panel hand'
            groupVisibleCards
            cardBack={cardBack}
            manualMode={manualMode}
            maxCards={5}
            onCardClick={onCardClick}
            onMouseOut={onMouseOut}
            onMouseOver={onMouseOver}
            source='hand'
            title={t('Hand')}
            cardSize={cardSize}
            hasActiveHouse={hasActiveHouse}
            isMe={isMe}
            isSpectating={isSpectating}
        />
    );

    if (!isMe) {
        return null;
    }

    return (
        <div className={`player-home-row-container pt-1${isActivePlayer ? '' : ' inactive-turn'}`}>
            {hidden ? (
                /* Not unmounted, just stood down: the count is still there, and
                   one click brings the cards back for the rest of the
                   opponent's turn. A hidden hand you cannot look at would be a
                   worse distraction than the one this setting is for. */
                <button
                    type='button'
                    className='hand-hidden'
                    onClick={() => setIsPeeking(true)}
                    aria-label={t('Show my hand')}
                >
                    <span className='hand-hidden-label'>
                        {t('Hand hidden - {{count}} cards', { count: sortedHand.length })}
                    </span>
                    <span className='hand-hidden-hint'>{t('Click to look')}</span>
                </button>
            ) : (
                <Droppable onDragDrop={onDragDrop} source='hand' manualMode={manualMode}>
                    {handToRender}
                </Droppable>
            )}
        </div>
    );
};

PlayerRow.displayName = 'PlayerRow';

export default PlayerRow;
