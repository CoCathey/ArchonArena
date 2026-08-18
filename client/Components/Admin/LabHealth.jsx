import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import moment from 'moment';

import Panel from '../Site/Panel';
import { useCrawlDeckCatalogMutation, useGetChampionsChallengeHealthQuery } from '../../redux/api';

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
                    // ARCHON (N48): not broken, but not working either - the
                    // state of a thing that is switched on and has produced
                    // nothing yet.
                    tone === 'warn' ? 'text-amber-300' : '',
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
    const [crawl, { isLoading: crawling }] = useCrawlDeckCatalogMutation();
    const [crawlMessage, setCrawlMessage] = useState(null);
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
                    {/* ARCHON (N48): how much of the diary came from people.
                        Everything else on this panel can look healthy while
                        capture has silently stopped - a bot that is only ever
                        taught by itself is the failure this row exists to make
                        visible, and zero human games with the setting on is
                        what it looks like. */}
                    <Row
                        label={t('Human play')}
                        tone={
                            health.learning.humanLearning === 'off'
                                ? undefined
                                : health.learning.humanGames
                                ? 'good'
                                : 'warn'
                        }
                        value={
                            health.learning.humanLearning === 'off'
                                ? t('off')
                                : t('{{games}} games', {
                                      games: (health.learning.humanGames || 0).toLocaleString()
                                  })
                        }
                        hint={
                            health.learning.humanLearning === 'off'
                                ? t('self-play only')
                                : health.learning.humanGames
                                ? t('{{mode}}, pull ×{{weight}}', {
                                      mode:
                                          health.learning.humanLearning === 'all'
                                              ? t('every game')
                                              : t('practice games'),
                                      weight: health.learning.humanGameWeight
                                  })
                                : t('capturing, none finished yet')
                        }
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
                    {/* ARCHON (N28): the three pilots. Games each has flown says
                        whether the rotation is rotating; the ladder says whether
                        one of them is simply the weaker player, which is the one
                        thing that would make a deck's style spread misleading. */}
                    <Row
                        label={t('Sparring styles')}
                        tone={health.personas?.enabled ? 'good' : undefined}
                        value={
                            health.personas?.enabled
                                ? t('on at ×{{strength}}', {
                                      strength: health.personas.strength
                                  })
                                : t('off')
                        }
                        hint={
                            health.personas?.enabled
                                ? t('{{pairs}} calibration pairs/sweep', {
                                      pairs: health.personas.duelPairsPerSweep
                                  })
                                : undefined
                        }
                    />
                    {(health.personas?.pilots || []).map((pilot) => {
                        const rung = (health.personas.ladder || []).find(
                            (entry) => entry.persona === pilot.key
                        );

                        return (
                            <Row
                                key={pilot.key}
                                label={pilot.label}
                                value={t('{{games}} games', {
                                    games: (pilot.games || 0).toLocaleString()
                                })}
                                hint={
                                    rung && rung.games
                                        ? t('{{rate}}% vs the others ({{games}})', {
                                              rate: Math.round(rung.rate * 100),
                                              games: rung.games
                                          })
                                        : pilot.avgTurns
                                        ? t('{{turns}} turns avg', { turns: pilot.avgTurns })
                                        : undefined
                                }
                            />
                        );
                    })}
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
                    {/* ARCHON (N30): the strategy filters read this, and it needs
                        no key and no outbound request - so on a healthy server it
                        should track the playable pool. SAS below is the part that
                        still depends on Decks of KeyForge. */}
                    <Row
                        label={t('Read from their cards')}
                        tone={
                            health.gauntlet.profiled >= health.gauntlet.playable
                                ? 'good'
                                : undefined
                        }
                        value={(health.gauntlet.profiled || 0).toLocaleString()}
                        hint={t('strategy filters')}
                    />
                    <Row
                        label={t('SAS on the pool')}
                        tone={health.gauntlet.rated > 0 ? 'good' : undefined}
                        value={t('{{rated}} rated', {
                            rated: (health.gauntlet.rated || 0).toLocaleString()
                        })}
                        // The SAS and strategy filters are computed from Decks of
                        // KeyForge enrichment, so a filter that matches nothing is
                        // otherwise unexplainable: the pool looks full and healthy.
                        hint={
                            health.gauntlet.unrated
                                ? t('{{unrated}} asked, unrated by DoK', {
                                      unrated: (health.gauntlet.unrated || 0).toLocaleString()
                                  })
                                : undefined
                        }
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

                    {/* ARCHON (N29): the crawl the pool is drawn from. On a
                        default install this is the whole reason the Gauntlet has
                        no opponents, and nothing used to report it. */}
                    <Row
                        label={t('Master Vault crawl')}
                        tone={health.catalog?.enabled ? 'good' : 'bad'}
                        value={health.catalog?.enabled ? t('on') : t('off')}
                        hint={
                            health.catalog?.enabled
                                ? health.catalog.caughtUp
                                    ? t('caught up')
                                    : t('page {{page}}', { page: health.catalog.page })
                                : t('catalog.enabled in Site Settings')
                        }
                    />
                    <Row
                        label={t('Decks indexed')}
                        tone={health.catalog?.indexed > 0 ? 'good' : 'bad'}
                        value={(health.catalog?.indexed || 0).toLocaleString()}
                        hint={
                            health.catalog?.lastRunAt
                                ? t('last run {{when}}', { when: when(health.catalog.lastRunAt) })
                                : t('never run')
                        }
                    />
                    {health.catalog?.pausedUntil && (
                        <Row
                            label={t('Crawl paused')}
                            tone='bad'
                            value={when(health.catalog.pausedUntil)}
                            hint={t('{{failures}} failures', {
                                failures: health.catalog.failures
                            })}
                        />
                    )}
                    {health.catalog?.lastError && (
                        <p className='m-0 pt-1 text-[11px] text-red-300'>
                            {health.catalog.lastError}
                        </p>
                    )}

                    {health.catalog?.indexed === 0 && (
                        <div className='pt-2'>
                            <p className='m-0 text-[11px] text-amber-300'>
                                {health.catalog.enabled
                                    ? t(
                                          'The crawl is on but has indexed nothing yet. It walks ' +
                                              'Master Vault a few pages at a time; start a pass ' +
                                              'now to see whether it reaches them.'
                                      )
                                    : t(
                                          'The Gauntlet has no field to draw from. The pool is ' +
                                              'built from the Master Vault deck catalog, and the ' +
                                              'crawl ships off by default because it walks ' +
                                              'somebody else’s API — turn on catalog.enabled in ' +
                                              'Site Settings, then start a pass here.'
                                      )}
                            </p>
                            <button
                                className='mt-1.5 rounded border border-border/70 bg-surface-secondary/60 px-2 py-1 text-[11px] text-foreground hover:border-border disabled:opacity-50'
                                disabled={crawling || !health.catalog.enabled}
                                onClick={async () => {
                                    setCrawlMessage(null);

                                    try {
                                        const result = await crawl().unwrap();
                                        // The response carries the state the pass
                                        // left behind, so a pass that ran and
                                        // failed reports the failure rather than
                                        // "indexed 0" - which reads as success.
                                        const lastError = result.health?.catalog?.lastError;

                                        setCrawlMessage(
                                            !result.success
                                                ? result.message
                                                : result.crawl?.indexed > 0
                                                ? t('Indexed {{indexed}} deck(s).', {
                                                      indexed: result.crawl.indexed
                                                  })
                                                : lastError
                                                ? t('The pass ran and failed: {{error}}', {
                                                      error: lastError
                                                  })
                                                : t('The pass ran and found nothing new.')
                                        );
                                    } catch {
                                        setCrawlMessage(t('The crawl could not be started.'));
                                    }
                                }}
                                type='button'
                            >
                                {crawling ? t('Crawling…') : t('Crawl Master Vault now')}
                            </button>
                            {crawlMessage && (
                                <p className='m-0 pt-1 text-[11px] text-muted'>{crawlMessage}</p>
                            )}
                        </div>
                    )}
                </div>
            </div>
        </Panel>
    );
};

LabHealth.displayName = 'LabHealth';

export default LabHealth;
