import React from 'react';
import { useTranslation } from 'react-i18next';
import moment from 'moment';

import Panel from '../Site/Panel';
import { useGetChampionsChallengeHealthQuery } from '../../redux/api';

/**
 * ARCHON (N26): the Champion's Challenge lab, as an operator sees it.
 *
 * Every number here existed already - as a counter in a result object, a warning
 * in a log, a row nobody read. That was the problem: two features ship behind
 * operator switches (the Gauntlet's catalog crawl, the worker node), and an
 * operator deciding whether to turn them on had no way to see whether the last
 * hour of sparring went anywhere.
 *
 * The three questions it answers, in order of how often they are asked:
 *
 *  1. **Is anything playing?** Games today, and which process holds the sweep
 *     lease. A lease whose heartbeat has gone stale is a worker node that died,
 *     and it is invisible without this.
 *  2. **Is the bot learning?** The diary's depth, the champion's version, and
 *     whether a candidate is mid-title-fight.
 *  3. **Is the field growing?** The pool against its target, when Master Vault
 *     was last asked, and - most useful of all - what the pool could NOT play,
 *     grouped: one card id at the top of that list is an actionable fact about
 *     this server's card data.
 */
const Row = ({ label, value, tone, hint }) => (
    <div className='flex flex-wrap items-baseline justify-between gap-2 border-b border-border/40 py-1 last:border-0'>
        <span className='text-sm text-muted'>{label}</span>
        <span className='text-right'>
            <span
                className={[
                    'text-sm font-semibold',
                    tone === 'good' ? 'text-emerald-300' : '',
                    tone === 'bad' ? 'text-red-300' : '',
                    !tone ? 'text-foreground' : ''
                ].join(' ')}
            >
                {value}
            </span>
            {hint ? <span className='ml-1.5 text-[11px] text-muted'>{hint}</span> : null}
        </span>
    </div>
);

const LabHealth = () => {
    const { t } = useTranslation();
    // Polled rather than fetched once: an operator watching a worker node start
    // up wants the lease to appear without reloading the page.
    const { data, isFetching, isError } = useGetChampionsChallengeHealthQuery(undefined, {
        pollingInterval: 30000
    });
    const health = data?.health;

    if (isError) {
        return null;
    }

    if (!health) {
        return (
            <Panel title={t('Champion’s Challenge health')}>
                <p className='m-0 text-sm text-muted'>
                    {isFetching ? t('Loading…') : t('No lab data.')}
                </p>
            </Panel>
        );
    }

    const when = (value) => (value ? moment(value).fromNow() : t('never'));
    const lease = health.lease;

    return (
        <Panel title={t('Champion’s Challenge health')}>
            <div className='space-y-3'>
                <div>
                    <div className='mb-1 text-[10px] uppercase tracking-wide text-muted'>
                        {t('Playing')}
                    </div>
                    <Row
                        label={t('Sweep')}
                        tone={health.running ? 'good' : 'bad'}
                        value={health.running ? t('on') : t('off')}
                    />
                    <Row
                        label={t('Games today')}
                        value={(health.sparring.today || 0).toLocaleString()}
                        hint={t('{{total}} all time', {
                            total: (health.sparring.total || 0).toLocaleString()
                        })}
                    />
                    <Row label={t('Configured node')} value={health.sweepOwner} />
                    <Row
                        label={t('Lease holder')}
                        tone={!lease ? undefined : lease.stale ? 'bad' : 'good'}
                        value={lease ? lease.owner : t('nobody yet')}
                        hint={
                            lease
                                ? lease.stale
                                    ? t('stale — last beat {{when}}', {
                                          when: when(lease.heartbeatAt)
                                      })
                                    : when(lease.heartbeatAt)
                                : undefined
                        }
                    />
                </div>

                <div>
                    <div className='mb-1 text-[10px] uppercase tracking-wide text-muted'>
                        {t('Learning')}
                    </div>
                    <Row
                        label={t('Learning loop')}
                        tone={health.learning.enabled ? 'good' : undefined}
                        value={health.learning.enabled ? t('on') : t('off')}
                    />
                    <Row
                        label={t('Diary')}
                        value={t('{{games}} games', {
                            games: (health.learning.diaryGames || 0).toLocaleString()
                        })}
                    />
                    <Row
                        label={t('Champion')}
                        value={
                            health.learning.vitals?.championVersion
                                ? t('v{{version}}', {
                                      version: health.learning.vitals.championVersion
                                  })
                                : t('heuristics')
                        }
                        hint={
                            health.learning.vitals?.championTrainedGames
                                ? t('trained on {{games}}', {
                                      games: (
                                          health.learning.vitals.championTrainedGames || 0
                                      ).toLocaleString()
                                  })
                                : undefined
                        }
                    />
                    <Row
                        label={t('Title fight')}
                        value={
                            health.learning.vitals?.candidate
                                ? t('v{{version}} {{record}}', {
                                      version: health.learning.vitals.candidate.version,
                                      record: `${health.learning.vitals.candidate.arenaWins}–${health.learning.vitals.candidate.arenaLosses}`
                                  })
                                : t('none')
                        }
                    />
                    <Row
                        label={t('Showcase games')}
                        value={(health.deep.games || 0).toLocaleString()}
                        hint={
                            health.deep.avgAnnotations
                                ? t('{{count}} annotations each', {
                                      count: health.deep.avgAnnotations
                                  })
                                : undefined
                        }
                    />
                </div>

                <div>
                    <div className='mb-1 text-[10px] uppercase tracking-wide text-muted'>
                        {t('The field')}
                    </div>
                    <Row
                        label={t('Gauntlet')}
                        tone={health.gauntlet.enabled ? 'good' : undefined}
                        value={health.gauntlet.enabled ? t('on') : t('off')}
                    />
                    <Row
                        label={t('Playable pool')}
                        tone={health.gauntlet.playable > 0 ? 'good' : 'bad'}
                        value={t('{{playable}} of {{target}}', {
                            playable: (health.gauntlet.playable || 0).toLocaleString(),
                            target: (health.gauntlet.target || 0).toLocaleString()
                        })}
                        hint={t('{{hydrated}} fetched', {
                            hydrated: (health.gauntlet.hydrated || 0).toLocaleString()
                        })}
                    />
                    <Row
                        label={t('Last Master Vault fetch')}
                        value={when(health.gauntlet.lastFetchAt)}
                    />

                    {health.gauntlet.unplayable?.length > 0 && (
                        <div className='pt-2'>
                            <div className='mb-1 text-[10px] uppercase tracking-wide text-muted'>
                                {t('Could not be played')}
                            </div>
                            <ul className='m-0 list-none space-y-0.5 p-0 text-[11px] text-muted'>
                                {health.gauntlet.unplayable.map((entry) => (
                                    <li key={entry.reason}>
                                        <span className='font-mono text-foreground'>
                                            {entry.reason}
                                        </span>{' '}
                                        ×{entry.decks}
                                    </li>
                                ))}
                            </ul>
                        </div>
                    )}

                    {health.gauntlet.enabled && health.gauntlet.hydrated === 0 && (
                        <p className='m-0 pt-2 text-[11px] text-amber-300'>
                            {t(
                                'Nothing has been fetched yet. The pool is drawn from the Master ' +
                                    'Vault deck catalog, and the catalog crawl ships off by ' +
                                    'default — turn on catalog.enabled and the pool starts filling ' +
                                    'a few decks per sweep.'
                            )}
                        </p>
                    )}
                </div>
            </div>
        </Panel>
    );
};

LabHealth.displayName = 'LabHealth';

export default LabHealth;
