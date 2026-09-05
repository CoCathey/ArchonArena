import React from 'react';
import { useTranslation, Trans } from 'react-i18next';
import { Button } from '@heroui/react';
import { faDice, faLock } from '@fortawesome/free-solid-svg-icons';

import Icon from '../Icon';
import Panel from '../Site/Panel';
import Avatar from '../Site/Avatar';
import PlayerAmber from '../Site/PlayerAmber';
import PlayerName from '../Site/PlayerName';
import { describeDeckStatus } from './deckStatusLabel';

/**
 * @typedef PendingGamePlayersProps
 * @property {PendingGame} currentGame The current pending game
 * @property {User} user The logged in user
 * @property {function(): void} onSelectDeck The callback to be invoked when a deck selection is requested
 * @property {function(): void} [onLuckyDice] The callback to be invoked when a random deck is requested
 */

/**
 * @param {PendingGamePlayersProps} props
 */
const PendingGamePlayers = ({ currentGame, user, onSelectDeck, onLuckyDice }) => {
    const { t } = useTranslation();
    const players = Object.values(currentGame.players || {});
    const sortedPlayers = players.sort((left, right) => {
        if (left.name === currentGame.owner) {
            return -1;
        }
        if (right.name === currentGame.owner) {
            return 1;
        }

        return left.name.localeCompare(right.name);
    });
    const seats = [sortedPlayers[0] || null, sortedPlayers[1] || null];
    const isSealed = currentGame.gameFormat === 'sealed';
    const isLuckyDice = !!currentGame.luckyDice;
    // ARCHON: this seat is pinned to the deck the event registered. The two
    // policies need different wording - under 'locked' there is nothing the
    // player can do about it, under 'between-rounds' there is, and it is on
    // the event page rather than here.
    const deckIsPinned = !!currentGame.tournament?.deckLocked;
    const pinnedDeckHint =
        currentGame.tournament?.deckSwapPolicy === 'between-rounds'
            ? t(
                  'This event runs on the deck you registered for this round. Change it on the event page before your match starts.'
              )
            : t('This event locks you to one deck for the whole run.');
    // ARCHON: what the event pinned each seat to, by name, from the moment the
    // table exists - not only after the deck has finished loading into the
    // seat, and for the opponent's seat too. Older servers send no `seats`;
    // everything below degrades to the previous behaviour without it.
    const tournamentSeats = currentGame.tournament?.seats || {};
    const seatLock = (player) => (player ? tournamentSeats[player.name] : undefined);

    const getSeatReadiness = (player) => {
        if (!player || !player.deck || !player.deck.selected) {
            // A Lucky Dice seat is never "waiting" on its player - the deck
            // arrives by roll when the game starts.
            if (isLuckyDice) {
                return {
                    label: t('Deck rolled at start'),
                    tone: 'text-violet-700 bg-violet-500/12 border-violet-500/30 dark:text-violet-300 dark:bg-violet-500/10'
                };
            }

            // A locked seat is not waiting on its player either: the table
            // loads the event's deck itself. Saying "Waiting for deck" here
            // sent people looking for a picker that does not exist.
            if (seatLock(player)?.locked) {
                return {
                    label: t('Loading event deck'),
                    tone: 'text-amber-700 bg-amber-500/12 border-amber-500/30 dark:text-amber-300 dark:bg-amber-500/10'
                };
            }

            return {
                label: t('Waiting for deck'),
                tone: 'text-[color:color-mix(in_oklab,var(--brand)_82%,black)] bg-[color:color-mix(in_oklab,var(--brand)_10%,white)] border-[color:color-mix(in_oklab,var(--brand)_32%,transparent)] dark:text-rose-300 dark:bg-rose-500/10 dark:border-rose-500/30'
            };
        }

        if (player.deck.status?.basicRules === false) {
            return {
                label: t('Deck needs fixes'),
                tone: 'text-[color:color-mix(in_oklab,var(--brand)_82%,black)] bg-[color:color-mix(in_oklab,var(--brand)_10%,white)] border-[color:color-mix(in_oklab,var(--brand)_32%,transparent)] dark:text-rose-300 dark:bg-rose-500/10 dark:border-rose-500/30'
            };
        }

        return {
            label: t('Ready'),
            tone: 'text-emerald-700 bg-emerald-500/12 border-emerald-500/30 dark:text-emerald-300 dark:bg-emerald-500/10'
        };
    };

    const getDeckValidity = (status) => describeDeckStatus(status, t);

    return (
        <Panel
            headerVariant='context'
            title={t('Players')}
            titleClass='text-sm font-medium tracking-wide text-foreground/85'
            contentClassName='py-3'
        >
            <div className='grid gap-3 sm:grid-cols-2'>
                {seats.map((player, index) => {
                    const playerIsMe = player && player.name === user?.username;
                    const readiness = player ? getSeatReadiness(player) : null;
                    const deckValidity = player ? getDeckValidity(player.deck?.status) : null;

                    if (!player) {
                        return (
                            <div
                                className='grid min-h-20 grid-cols-[minmax(0,1fr)_auto] grid-rows-2 items-center gap-x-3 gap-y-1 rounded-md border border-border/50 bg-surface-secondary/26 px-3 py-2'
                                key={`seat-${index}`}
                            >
                                <div className='min-w-0 text-sm font-semibold text-foreground/90'>
                                    <Trans>Empty seat</Trans>
                                </div>
                                <div />
                                <div className='min-w-0 text-sm text-muted'>
                                    <span className='block truncate'>
                                        <Trans>Waiting for player</Trans>
                                    </span>
                                </div>
                                <div />
                            </div>
                        );
                    }

                    const deckSelected = !!player.deck?.selected;
                    const lock = seatLock(player);
                    // The event's name for the deck this seat is locked to.
                    // Shown for either seat: the event page already publishes
                    // both, and the server withholds it when decklists are
                    // hidden.
                    const lockedDeckName = lock?.deckName;
                    const deckName = lockedDeckName
                        ? lockedDeckName
                        : playerIsMe
                        ? deckSelected
                            ? isSealed
                                ? t('Sealed deck selected')
                                : player.deck?.name
                            : isLuckyDice
                            ? t('Random deck at start')
                            : t('No deck selected')
                        : deckSelected
                        ? t('Selected')
                        : isLuckyDice
                        ? t('Random deck at start')
                        : t('Not selected');
                    const seatIsLocked = playerIsMe ? deckIsPinned : !!lock?.locked;

                    return (
                        <div
                            className='grid min-h-20 grid-cols-[minmax(0,1fr)_auto] grid-rows-2 items-center gap-x-3 gap-y-1 rounded-md border border-border/50 bg-surface-secondary/30 px-3 py-2'
                            key={player.name}
                        >
                            <div className='flex min-w-0 items-center gap-2'>
                                <Avatar cosmetics={player.cosmetics} imgPath={player.avatar} />
                                {/* ARCHON (N12): was `${role}-role`, a keyteki
                                    class name nothing defines, so a supporter
                                    in a game lobby looked like anyone else. */}
                                <PlayerName
                                    className='username'
                                    link
                                    role={player.role}
                                    username={player.name}
                                />
                                <PlayerAmber
                                    username={player.name}
                                    format={currentGame.gameFormat}
                                    className='ml-auto'
                                />
                            </div>
                            <span
                                className={`shrink-0 whitespace-nowrap rounded border px-1.5 py-0 text-xs font-medium leading-4 ${readiness.tone}`}
                            >
                                {readiness.label}
                            </span>

                            <div className='min-w-0 flex items-center gap-1 text-sm text-foreground/78 dark:text-foreground/75'>
                                <span className='shrink-0 text-foreground/62 dark:text-muted'>
                                    <Trans>Deck:</Trans>
                                </span>
                                <div className='min-w-0 flex flex-wrap items-center gap-2'>
                                    <span className='block min-w-0 flex-1 truncate text-foreground/90'>
                                        {deckName}
                                    </span>
                                    {/* ARCHON: deck power at the moment you
                                        decide whether to play this match. Absent
                                        when SAS is unknown or the game hides
                                        decklists. */}
                                    {player.deck?.sasRating != null && (
                                        <span
                                            className='shrink-0 whitespace-nowrap rounded bg-surface-secondary/70 px-1.5 py-0 text-xs font-bold leading-4 text-foreground'
                                            title={t('Deck power (SAS) from Decks of KeyForge')}
                                        >
                                            {t('SAS')} {player.deck.sasRating}
                                        </span>
                                    )}
                                    {/* ARCHON: a seat the event has pinned to a
                                        deck. The server refuses anything else,
                                        so offering the picker here would only
                                        be offering a click that gets rejected -
                                        say what the rule is instead. */}
                                    {seatIsLocked && (
                                        <span
                                            className='shrink-0 inline-flex items-center gap-1 whitespace-nowrap rounded border border-amber-500/35 bg-amber-500/12 px-1.5 py-0 text-xs font-medium leading-4 text-amber-700 dark:bg-amber-500/10 dark:text-amber-300'
                                            title={
                                                playerIsMe
                                                    ? pinnedDeckHint
                                                    : t(
                                                          'This seat is locked to the deck registered for the event.'
                                                      )
                                            }
                                        >
                                            <Icon icon={faLock} />
                                            {t('Event deck')}
                                        </span>
                                    )}
                                    {playerIsMe && !isSealed && !isLuckyDice && !deckIsPinned && (
                                        <>
                                            <Button
                                                className='shrink-0'
                                                size='sm'
                                                variant={deckSelected ? 'tertiary' : 'primary'}
                                                onPress={onSelectDeck}
                                            >
                                                {deckSelected ? t('Change deck') : t('Select deck')}
                                            </Button>
                                            {onLuckyDice && !currentGame.tournament && (
                                                <Button
                                                    className='shrink-0'
                                                    size='sm'
                                                    variant='tertiary'
                                                    title={t(
                                                        'Pick a random deck from your collection'
                                                    )}
                                                    onPress={onLuckyDice}
                                                >
                                                    <Icon icon={faDice} />
                                                    {t('Lucky Dice')}
                                                </Button>
                                            )}
                                        </>
                                    )}
                                </div>
                            </div>
                            <span
                                className={`shrink-0 whitespace-nowrap rounded border px-1.5 py-0 text-xs font-medium leading-4 ${deckValidity.tone}`}
                                title={deckValidity.hint}
                            >
                                {deckValidity.label}
                            </span>
                        </div>
                    );
                })}
            </div>
        </Panel>
    );
};

export default PendingGamePlayers;
