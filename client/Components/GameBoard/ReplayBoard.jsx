import React from 'react';
import PropTypes from 'prop-types';
import { useTranslation } from 'react-i18next';

import CardImage from './CardImage';
import { keyCount, orderPlayersForPerspective } from '../../replayMarkers';
import { hydrateBoard } from '../../replayFormat';

/**
 * ARCHON: the board as it stood at a point in a recorded game.
 *
 * Replays used to be the chat log alone — readable, but you could not see what
 * the board actually looked like when something happened. This renders the
 * compact snapshot the engine records alongside each log entry
 * (`Game.getBoardSnapshot`), resolved through the recording's card table.
 *
 * The snapshot is captured from an AnonymousSpectator's perspective, so hands
 * are counts rather than contents here for the same reason they are hidden from
 * live spectators — a replay reveals no more than watching would have.
 *
 * `perspective` names the player to show at the bottom, where your own side of
 * the table sits in the live game. It only reorders — a replay shows the same
 * information whichever way round it is read, because the snapshot itself is
 * spectator-safe.
 *
 * @param {{board?: object, cards?: object[], perspective?: string}} props
 */

/** The three key colours, in the order the live board shows them. */
const KEY_COLOURS = ['red', 'blue', 'yellow'];

const KEY_CLASSES = {
    red: 'bg-red-500/80 border-red-300/70',
    blue: 'bg-sky-500/80 border-sky-300/70',
    yellow: 'bg-amber-400/80 border-amber-200/70'
};

/**
 * Forged keys as three pips rather than as a number.
 *
 * This is the bug that made the board look broken: the panel rendered
 * `stats.keys` straight into the text, and `stats.keys` is the engine's
 * per-colour map (`{red: false, blue: true, yellow: false}`), so every replay
 * said "Keys [object Object]".
 */
const Keys = ({ keys, t }) => {
    const forged = keyCount(keys) ?? 0;
    const map = keys && typeof keys === 'object' ? keys : null;

    return (
        <span
            className='inline-flex items-center gap-1'
            title={t('{{count}} keys forged', { count: forged })}
        >
            {KEY_COLOURS.map((colour, index) => {
                // With the colour map, colour the pips that were actually
                // forged; with only a count (a number, from an older or
                // hand-made recording) fill them left to right.
                const isForged = map ? !!map[colour] : index < forged;

                return (
                    <span
                        key={colour}
                        className={`h-2.5 w-2.5 rounded-sm border ${
                            isForged ? KEY_CLASSES[colour] : 'border-border/70 bg-transparent'
                        }`}
                    />
                );
            })}
            <span className='ml-1 text-xs text-muted'>{t('Keys {{keys}}', { keys: forged })}</span>
        </span>
    );
};

Keys.propTypes = {
    keys: PropTypes.oneOfType([PropTypes.object, PropTypes.number]),
    t: PropTypes.func
};

/**
 * One card on the replay board.
 *
 * Wrapped in an explicitly sized box: `CardImage` renders `h-full w-full`, so
 * dropped into a flex row with no dimensions it collapsed to nothing and the
 * board came out as a row of blank slivers.
 */
const BoardCard = ({ card, onCardMouseOver, onCardMouseOut }) => (
    <div
        className={`relative h-[4.9rem] w-[3.5rem] shrink-0 overflow-hidden rounded-[3px] ${
            card.exhausted ? 'rotate-90 opacity-90' : ''
        }`}
        title={card.name}
    >
        <CardImage card={card} onMouseOver={onCardMouseOver} onMouseOut={onCardMouseOut} />
        {card.childCards?.length > 0 && (
            <span className='absolute bottom-0 right-0 rounded-tl bg-black/70 px-1 text-[0.6rem] text-amber-200'>
                +{card.childCards.length}
            </span>
        )}
    </div>
);

BoardCard.propTypes = {
    card: PropTypes.object,
    onCardMouseOut: PropTypes.func,
    onCardMouseOver: PropTypes.func
};

const ReplayBoard = ({ board, cards, perspective, onCardMouseOver, onCardMouseOut }) => {
    const { t } = useTranslation();
    const resolved = hydrateBoard(board, cards);

    if (!resolved || resolved.players.length === 0) {
        return (
            <div className='rounded-md border border-border/55 bg-surface-secondary/35 px-3 py-6 text-center text-sm text-muted'>
                {t('No board was recorded for this point in the game.')}
            </div>
        );
    }

    const renderPile = (label, pile) => {
        if (!pile || pile.length === 0) {
            return null;
        }

        return (
            <div className='min-w-0'>
                <div className='mb-1 text-[0.65rem] uppercase tracking-wide text-muted'>
                    {t(label)} ({pile.length})
                </div>
                <div className='flex flex-wrap gap-1'>
                    {pile.map((card, index) => (
                        <BoardCard
                            key={`${card.uuid || card.id || card.name}-${index}`}
                            card={card}
                            onCardMouseOver={onCardMouseOver}
                            onCardMouseOut={onCardMouseOut}
                        />
                    ))}
                </div>
            </div>
        );
    };

    return (
        <div className='space-y-3'>
            {resolved.round != null && (
                <div className='flex flex-wrap gap-x-3 text-xs text-muted'>
                    <span>{t('Turn {{round}}', { round: resolved.round })}</span>
                    {resolved.activePlayer && (
                        <span>{t('{{player}} to act', { player: resolved.activePlayer })}</span>
                    )}
                    {resolved.phase && <span>{t(resolved.phase)}</span>}
                </div>
            )}

            {orderPlayersForPerspective(resolved.players, perspective).map((player) => (
                <div
                    key={player.name}
                    className={`rounded-md border px-3 py-2 ${
                        resolved.activePlayer === player.name
                            ? 'border-amber-400/60 bg-surface-secondary/55'
                            : 'border-border/55 bg-surface-secondary/30'
                    }`}
                >
                    <div className='mb-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm'>
                        <span className='font-semibold text-foreground'>{player.name}</span>
                        {player.activeHouse && (
                            <span className='rounded bg-amber-400/15 px-1.5 py-0.5 text-xs text-amber-300'>
                                {t(player.activeHouse)}
                            </span>
                        )}
                        <span className='text-xs text-muted'>
                            {t('Amber {{amber}}', { amber: player.stats?.amber ?? 0 })}
                        </span>
                        <Keys keys={player.stats?.keys} t={t} />
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

ReplayBoard.propTypes = {
    board: PropTypes.object,
    cards: PropTypes.array,
    onCardMouseOut: PropTypes.func,
    onCardMouseOver: PropTypes.func,
    perspective: PropTypes.string
};

ReplayBoard.displayName = 'ReplayBoard';

export default ReplayBoard;
