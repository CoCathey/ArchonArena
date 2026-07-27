import React from 'react';
import { useTranslation } from 'react-i18next';

import CardImage from './CardImage';

/**
 * ARCHON: the board as it stood at a point in a recorded game.
 *
 * Replays used to be the chat log alone — readable, but you could not see what
 * the board actually looked like when something happened. This renders the
 * compact snapshot the engine records alongside each log entry
 * (`Game.getBoardSnapshot`).
 *
 * The snapshot is captured from an AnonymousSpectator's perspective, so hands
 * are counts rather than contents here for the same reason they are hidden from
 * live spectators — a replay reveals no more than watching would have.
 *
 * @param {{ board?: object }} props
 */
const ReplayBoard = ({ board }) => {
    const { t } = useTranslation();

    if (!board || !board.players || board.players.length === 0) {
        return (
            <div className='rounded-md border border-border/55 bg-surface-secondary/35 px-3 py-6 text-center text-sm text-muted'>
                {t('No board was recorded for this point in the game.')}
            </div>
        );
    }

    const renderPile = (label, cards) => {
        if (!cards || cards.length === 0) {
            return null;
        }

        return (
            <div className='min-w-0'>
                <div className='mb-1 text-[0.65rem] uppercase tracking-wide text-muted'>
                    {t(label)} ({cards.length})
                </div>
                <div className='flex flex-wrap gap-1'>
                    {cards.map((card, index) => (
                        <CardImage key={`${card.id || card.name}-${index}`} card={card} size='sm' />
                    ))}
                </div>
            </div>
        );
    };

    return (
        <div className='space-y-3'>
            {board.round != null && (
                <div className='flex flex-wrap gap-x-3 text-xs text-muted'>
                    <span>{t('Turn {{round}}', { round: board.round })}</span>
                    {board.activePlayer && (
                        <span>{t('{{player}} to act', { player: board.activePlayer })}</span>
                    )}
                    {board.phase && <span>{t(board.phase)}</span>}
                </div>
            )}

            {board.players.map((player) => (
                <div
                    key={player.name}
                    className={`rounded-md border px-3 py-2 ${
                        board.activePlayer === player.name
                            ? 'border-amber-400/60 bg-surface-secondary/55'
                            : 'border-border/55 bg-surface-secondary/30'
                    }`}
                >
                    <div className='mb-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm'>
                        <span className='font-semibold text-foreground'>{player.name}</span>
                        {player.activeHouse && (
                            <span className='text-xs text-amber-300'>{t(player.activeHouse)}</span>
                        )}
                        <span className='text-xs text-muted'>
                            {t('Amber {{amber}}', { amber: player.stats?.amber ?? 0 })}
                        </span>
                        <span className='text-xs text-muted'>
                            {t('Keys {{keys}}', { keys: player.stats?.keys ?? 0 })}
                        </span>
                        {player.stats?.chains > 0 && (
                            <span className='text-xs text-muted'>
                                {t('Chains {{chains}}', { chains: player.stats.chains })}
                            </span>
                        )}
                        <span className='ml-auto text-xs text-muted'>
                            {t('Hand {{hand}} · Deck {{deck}}', {
                                hand: player.numHandCards ?? 0,
                                deck: player.numDeckCards ?? 0
                            })}
                        </span>
                    </div>

                    <div className='space-y-2'>
                        {renderPile('In play', player.cardPiles?.cardsInPlay)}
                        {renderPile('Archives', player.cardPiles?.archives)}
                        {renderPile('Discard', player.cardPiles?.discard)}
                        {renderPile('Purged', player.cardPiles?.purged)}
                    </div>
                </div>
            ))}
        </div>
    );
};

ReplayBoard.displayName = 'ReplayBoard';

export default ReplayBoard;
