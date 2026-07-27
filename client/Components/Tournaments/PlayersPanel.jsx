import React from 'react';
import Link from '../Navigation/Link';
import { useTranslation } from 'react-i18next';
import { Button as HeroButton } from '@heroui/react';

import Panel from '../Site/Panel';
import AmberValue from '../Site/AmberValue';

/**
 * ARCHON: the pre-start roster - who's in, who's checked in, who has a
 * registered deck, the waitlist queue, and (for manual seeding) the
 * seed order editor.
 */
const PlayersPanel = ({ tournament, players, act }) => {
    const { t } = useTranslation();

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
            <Link
                href={`/players/${encodeURIComponent(player.username)}`}
                className='text-foreground hover:text-amber-300 hover:underline'
            >
                {player.username}
            </Link>
            {player.amber != null && (
                <AmberValue value={player.amber} className='!text-xs' iconClass='h-3 w-3' />
            )}
            {tournament.checkInOpen &&
                !waitlisted &&
                (player.checkedIn ? (
                    <span className='rounded bg-emerald-500/15 px-1.5 text-xs text-emerald-400'>
                        {t('checked in')}
                    </span>
                ) : (
                    <span className='rounded bg-surface-tertiary/70 px-1.5 text-xs text-muted'>
                        {t('not checked in')}
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
        </Panel>
    );
};

PlayersPanel.displayName = 'PlayersPanel';

export default PlayersPanel;
