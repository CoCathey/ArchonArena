import React from 'react';
import PlayerName from '../Site/PlayerName';
import { useTranslation } from 'react-i18next';
import { Button as HeroButton, Input } from '@heroui/react';

import Panel from '../Site/Panel';
import AmberValue from '../Site/AmberValue';

/**
 * ARCHON: the pre-start roster - who's in, who's checked in, who has a
 * registered deck, the waitlist queue, and (for manual seeding) the
 * seed order editor.
 */
const PlayersPanel = ({ tournament, players, act }) => {
    const { t } = useTranslation();
    const [lateEntrant, setLateEntrant] = React.useState('');

    const roster = players.filter((player) => !player.waitlisted && !player.dropped);
    const waitlist = players.filter((player) => player.waitlisted && !player.dropped);
    const manualSeeds = tournament.seedMethod === 'manual' && tournament.canManage;

    const setSeed = (userId, seed) => {
        act('seeds', { seeds: [{ userId, seed: seed === '' ? null : parseInt(seed, 10) }] }, null);
    };

    const row = (player, waitlisted) => (
        <li
            key={player.userId}
            className='flex flex-wrap items-center gap-2 rounded bg-surface-secondary/50 px-2 py-1'
        >
            {manualSeeds && !waitlisted && (
                <input
                    type='number'
                    min='1'
                    defaultValue={player.seed || ''}
                    onBlur={(event) => setSeed(player.userId, event.target.value)}
                    className='w-12 rounded border border-border/70 bg-surface-secondary/80 px-1 py-0.5 text-xs text-foreground'
                    title={t('Seed')}
                />
            )}
            <PlayerName className='hover:text-amber-300' link username={player.username} />
            {player.amber != null && (
                <AmberValue value={player.amber} className='!text-xs' iconClass='h-3 w-3' />
            )}
            {tournament.checkInOpen &&
                !waitlisted &&
                (player.checkedIn ? (
                    <span className='rounded bg-emerald-500/15 px-1.5 text-xs text-emerald-400'>
                        {t('checked in')}
                    </span>
                ) : tournament.canManage ? (
                    /* ARCHON: the desk marking a player present. The roster
                       showed the status and offered no way to change it, so an
                       in-person organizer running the door from a laptop had
                       no working way to check anybody in - the player needed a
                       phone, an account they were signed into, and the event
                       page, or they were dropped as a no-show at start. */
                    <HeroButton
                        size='sm'
                        variant='tertiary'
                        className='!h-5 !min-w-0 !px-1.5 text-xs'
                        onPress={() =>
                            act(
                                'check-in',
                                { userId: player.userId },
                                t('{{player}} checked in', { player: player.username })
                            )
                        }
                    >
                        {t('Check in')}
                    </HeroButton>
                ) : (
                    <span className='rounded bg-surface-tertiary/70 px-1.5 text-xs text-muted'>
                        {t('not checked in')}
                    </span>
                ))}
            {/* ARCHON: the entry-payment register, in the roster where the
                organizer is already ticking people off.

                Staff only, and never the player themselves - a register anybody
                can tick their own name on is not a register. The tick names who
                made it, because "which judge marked me paid" is the question
                that settles a disagreement, and a bare checkbox cannot answer
                it. The platform still takes none of the money. */}
            {tournament.entryFeeCents > 0 &&
                !waitlisted &&
                (player.paid ? (
                    <span
                        className='rounded bg-emerald-500/15 px-1.5 text-xs text-emerald-400'
                        title={
                            player.paidBy
                                ? t('Marked paid by {{staff}}', { staff: player.paidBy })
                                : undefined
                        }
                    >
                        {tournament.canManage ? (
                            <button
                                type='button'
                                className='underline-offset-2 hover:underline'
                                onClick={() =>
                                    act(
                                        'set-paid',
                                        { userId: player.userId, paid: false },
                                        t('{{player}} marked unpaid', { player: player.username })
                                    )
                                }
                            >
                                {t('paid')}
                            </button>
                        ) : (
                            t('paid')
                        )}
                    </span>
                ) : tournament.canManage ? (
                    <HeroButton
                        size='sm'
                        variant='tertiary'
                        className='!h-5 !min-w-0 !px-1.5 text-xs'
                        onPress={() =>
                            act(
                                'set-paid',
                                { userId: player.userId, paid: true },
                                t('{{player}} marked paid', { player: player.username })
                            )
                        }
                    >
                        {t('Mark paid')}
                    </HeroButton>
                ) : (
                    <span className='rounded bg-amber-400/15 px-1.5 text-xs text-amber-300'>
                        {t('unpaid')}
                    </span>
                ))}
            {tournament.triad ? (
                player.hasDeck ? (
                    (player.triadDecks || []).map((deck) => (
                        <span
                            key={deck.deckId}
                            className='rounded bg-amber-400/15 px-1.5 text-xs text-amber-300'
                        >
                            {deck.deckName}
                            {deck.deckSas != null && ` (${deck.deckSas})`}
                        </span>
                    ))
                ) : (
                    <span className='rounded bg-red-500/15 px-1.5 text-xs text-red-400'>
                        {t('no pool')}
                    </span>
                )
            ) : (
                (tournament.requireDeckRegistration || player.hasDeck) &&
                (player.hasDeck ? (
                    <span
                        className='rounded bg-amber-400/15 px-1.5 text-xs text-amber-300'
                        title={player.deckName || undefined}
                    >
                        {player.deckName ? player.deckName : t('deck registered')}
                        {player.deckSas != null && ` (${player.deckSas})`}
                    </span>
                ) : (
                    <span className='rounded bg-red-500/15 px-1.5 text-xs text-red-400'>
                        {t('no deck')}
                    </span>
                ))
            )}
            {/* ARCHON: the judge releasing a frozen deck. A locked event tells
                a player to "ask the organizer" if they need to change deck,
                and the organizer had no way to do anything about it - a deck
                registered wrong, or one that turns out to be illegal, was
                stuck for the whole event. Clearing it reopens the lock for
                exactly one registration: the player re-picks through their own
                picker, so every legality rule still applies. */}
            {tournament.canManage &&
                !tournament.triad &&
                player.hasDeck &&
                tournament.status === 'active' && (
                    <HeroButton
                        size='sm'
                        variant='tertiary'
                        className='!h-5 !min-w-0 !px-1.5 text-xs'
                        title={t('Let this player register a different deck')}
                        onPress={() => {
                            if (
                                window.confirm(
                                    t(
                                        "Release {{player}}'s deck? They will be able to register a different one.",
                                        { player: player.username }
                                    )
                                )
                            ) {
                                act(
                                    'register-deck',
                                    { userId: player.userId, deckId: null },
                                    t('Deck released - {{player}} can register another', {
                                        player: player.username
                                    })
                                );
                            }
                        }}
                    >
                        {t('Release deck')}
                    </HeroButton>
                )}
            {tournament.canManage && (
                <HeroButton
                    size='sm'
                    variant='tertiary'
                    className='ml-auto !h-6 !px-2 text-xs'
                    onPress={() => act('drop', { userId: player.userId }, t('Player removed'))}
                >
                    {t('Remove')}
                </HeroButton>
            )}
        </li>
    );

    return (
        <Panel
            title={
                tournament.playerCap
                    ? t('Players ({{count}}/{{cap}})', {
                          count: roster.length,
                          cap: tournament.playerCap
                      })
                    : t('Players ({{count}})', { count: roster.length })
            }
        >
            {roster.length === 0 ? (
                <div className='text-sm text-muted'>{t('No players yet')}</div>
            ) : (
                <ul className='space-y-1 text-sm'>{roster.map((player) => row(player, false))}</ul>
            )}
            {waitlist.length > 0 && (
                <>
                    <div className='mb-1 mt-3 text-xs uppercase tracking-wide text-muted'>
                        {t('Waitlist ({{count}})', { count: waitlist.length })}
                    </div>
                    <ul className='space-y-1 text-sm opacity-80'>
                        {waitlist.map((player) => row(player, true))}
                    </ul>
                </>
            )}
            {manualSeeds && roster.length > 0 && (
                <div className='mt-2 text-xs text-muted'>
                    {t('Manual seeding: enter seed numbers (1 = top); blank seeds go last.')}
                </div>
            )}
            {/* ARCHON: late registration. A player turning up at round two of
                a five-round event is normal at a local scene - the shop was
                busy, the bus was late - and there was no way to admit them at
                all: registration closed at start, and the only workaround was
                to cancel the event and build it again. Swiss pairs on record,
                so a late entrant starts on zero and is paired from there. */}
            {tournament.canManage && tournament.status === 'active' && (
                <div className='mt-3 flex flex-wrap items-center gap-2 border-t border-border/50 pt-2'>
                    <span className='text-xs text-muted'>{t('Add a late entrant')}:</span>
                    <Input
                        aria-label={t('Username')}
                        className='w-40'
                        value={lateEntrant}
                        placeholder={t('Username')}
                        onChange={(event) => setLateEntrant(event.target.value)}
                    />
                    <HeroButton
                        size='sm'
                        variant='tertiary'
                        isDisabled={!lateEntrant.trim()}
                        onPress={async () => {
                            const added = await act(
                                'register',
                                { username: lateEntrant.trim() },
                                t('{{player}} added to the event', { player: lateEntrant.trim() })
                            );

                            if (added) {
                                setLateEntrant('');
                            }
                        }}
                    >
                        {t('Add player')}
                    </HeroButton>
                </div>
            )}
        </Panel>
    );
};

PlayersPanel.displayName = 'PlayersPanel';

export default PlayersPanel;
