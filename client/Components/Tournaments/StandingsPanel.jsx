import React from 'react';
import Link from '../Navigation/Link';
import { useTranslation } from 'react-i18next';

import Panel from '../Site/Panel';
import AmberValue from '../Site/AmberValue';

const trophyColors = ['text-amber-300', 'text-zinc-300', 'text-amber-600'];

const Trophy = ({ place }) => (
    <svg
        viewBox='0 0 24 24'
        className={`inline h-4 w-4 ${trophyColors[place - 1] || 'text-muted'}`}
        fill='currentColor'
        aria-hidden='true'
    >
        <path d='M6 2h12v2h3v3c0 2.8-2.2 5-5 5h-.35A6 6 0 0 1 13 14.9V17h3v2H8v-2h3v-2.1a6 6 0 0 1-2.65-2.9H8c-2.8 0-5-2.2-5-5V4h3V2zm-1 4v1c0 1.7 1.3 3 3 3V6H5zm14 1V6h-3v4c1.7 0 3-1.3 3-3z' />
        <path d='M7 20h10v2H7z' />
    </svg>
);
Trophy.displayName = 'StandingsTrophy';

/**
 * ARCHON: live standings (or final placements once the event is done):
 * rank, record, points, tiebreakers, and the registered deck with SAS
 * when the event shows decklists.
 */
const StandingsPanel = ({ tournament, standings, players, currentUsername }) => {
    const { t } = useTranslation();

    const playerById = {};
    for (const player of players) {
        playerById[player.userId] = player;
    }

    const complete = tournament.status === 'complete';
    const showDeckColumn = players.some((player) => player.deckName);

    return (
        <Panel title={complete ? t('Final Standings') : t('Standings')}>
            <div className='overflow-x-auto'>
                <table className='w-full text-sm'>
                    <thead>
                        <tr className='border-b border-border/70 text-left text-xs uppercase tracking-wide text-muted'>
                            <th className='w-10 px-2 py-1.5'>#</th>
                            <th className='px-2 py-1.5'>{t('Player')}</th>
                            <th className='px-2 py-1.5 text-right'>{t('Record')}</th>
                            <th className='px-2 py-1.5 text-right'>{t('Points')}</th>
                            <th
                                className='px-2 py-1.5 text-right'
                                title={t('Strength of schedule')}
                            >
                                {t('SOS')}
                            </th>
                            <th
                                className='px-2 py-1.5 text-right'
                                title={t('Extended strength of schedule')}
                            >
                                {t('xSOS')}
                            </th>
                            {showDeckColumn && <th className='px-2 py-1.5'>{t('Deck')}</th>}
                        </tr>
                    </thead>
                    <tbody>
                        {standings.map((entry) => {
                            const player = playerById[entry.id] || {};
                            const place = complete ? entry.finalRank || entry.rank : entry.rank;

                            return (
                                <tr
                                    key={entry.id}
                                    className={`border-b border-border/40 ${
                                        entry.username === currentUsername ? 'bg-accent/15' : ''
                                    }`}
                                >
                                    <td className='px-2 py-1.5 text-muted'>
                                        {complete && place <= 3 ? (
                                            <span className='inline-flex items-center gap-1'>
                                                <Trophy place={place} />
                                                {place}
                                            </span>
                                        ) : (
                                            place
                                        )}
                                    </td>
                                    <td className='px-2 py-1.5'>
                                        <span className='font-semibold text-foreground'>
                                            <Link
                                                href={`/players/${encodeURIComponent(
                                                    entry.username
                                                )}`}
                                                className='hover:text-amber-300 hover:underline'
                                            >
                                                {entry.username}
                                            </Link>
                                        </span>
                                        {player.amber != null && (
                                            <AmberValue
                                                value={player.amber}
                                                className='ml-2 !text-xs'
                                                iconClass='h-3 w-3'
                                            />
                                        )}
                                        {entry.dropped && (
                                            <span className='ml-1 text-xs text-muted'>
                                                ({t('dropped')})
                                            </span>
                                        )}
                                    </td>
                                    <td className='px-2 py-1.5 text-right text-foreground'>
                                        {entry.wins}-{entry.losses}
                                    </td>
                                    <td className='px-2 py-1.5 text-right font-bold text-amber-300'>
                                        {entry.points}
                                    </td>
                                    <td className='px-2 py-1.5 text-right text-muted'>
                                        {entry.sos}
                                    </td>
                                    <td className='px-2 py-1.5 text-right text-muted'>
                                        {entry.extendedSos}
                                    </td>
                                    {showDeckColumn && (
                                        <td className='max-w-40 truncate px-2 py-1.5 text-muted'>
                                            {player.deckName || '-'}
                                            {player.deckSas != null && (
                                                <span className='ml-1 text-xs'>
                                                    ({player.deckSas} {t('SAS')})
                                                </span>
                                            )}
                                        </td>
                                    )}
                                </tr>
                            );
                        })}
                    </tbody>
                </table>
            </div>
        </Panel>
    );
};

StandingsPanel.displayName = 'StandingsPanel';

export default StandingsPanel;
