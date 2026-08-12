import React from 'react';
import { useSelector } from 'react-redux';
import { useTranslation } from 'react-i18next';
import { Button as HeroButton } from '@heroui/react';
import { Link } from 'react-router-dom';

import Panel from '../Components/Site/Panel';
import AlertPanel from '../Components/Site/AlertPanel';
import { LockGlyph } from '../Components/Membership/PremiumLock';
import {
    useGetMembershipCatalogQuery,
    useGetMyMembershipQuery,
    useGetPatreonStatusQuery
} from '../redux/api';
import { TIER_BADGE_CLASS } from '../membership';

/**
 * ARCHON (N12): the membership page.
 *
 * The whole proposition in one line: play free, pay for understanding. The page
 * leads with that rather than with a price grid, because the thing being sold
 * is not access to the game - it is the analytics, and a player who thinks we
 * are charging them to play will leave before reading the table.
 *
 * Everything on this page is rendered from the server's tier catalogue, so
 * moving a capability between tiers, changing a price, or adding a tier changes
 * this page with no edit here.
 */

const CheckGlyph = () => (
    <svg
        aria-hidden='true'
        className='mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-400'
        fill='none'
        stroke='currentColor'
        strokeWidth='2.5'
        viewBox='0 0 24 24'
    >
        <path d='M20 6 9 17l-5-5' />
    </svg>
);

const TierCard = ({ tier, capabilityCopy, currentTier, isAdmin, campaignUrl, t }) => {
    const isCurrent = currentTier === tier.id;
    const recommended = tier.recommended;

    return (
        <div
            className={[
                'relative flex flex-col rounded-lg border bg-surface/85 p-4',
                recommended
                    ? 'border-amber-500/60 shadow-[0_0_0_1px_rgba(245,158,11,0.25)]'
                    : 'border-border/70'
            ].join(' ')}
        >
            {recommended && (
                <div className='absolute -top-2.5 left-4 rounded-full bg-amber-500 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-black'>
                    {t('Recommended')}
                </div>
            )}

            <div className='flex items-baseline justify-between gap-2'>
                <h3 className='m-0 text-lg font-semibold text-foreground'>{tier.name}</h3>
                <div className='text-right'>
                    {tier.priceUsd > 0 ? (
                        <>
                            <span className='text-xl font-semibold text-foreground'>
                                ${tier.priceUsd}
                            </span>
                            <span className='text-xs text-muted'>{t('/mo')}</span>
                        </>
                    ) : (
                        <span className='text-xl font-semibold text-foreground'>{t('Free')}</span>
                    )}
                </div>
            </div>

            <p className='mt-1 mb-3 text-xs text-muted'>{tier.tagline}</p>

            {isCurrent && (
                <div className='mb-3 rounded border border-emerald-500/40 bg-emerald-500/10 px-2 py-1 text-center text-xs text-emerald-300'>
                    {isAdmin ? t('Your admin account includes this') : t('Your current plan')}
                </div>
            )}

            <ul className='m-0 flex list-none flex-col gap-1.5 p-0 text-xs text-foreground'>
                {tier.rank > 0 && (
                    <li className='mb-1 text-muted'>{t('Everything below, plus:')}</li>
                )}
                {(tier.includes || []).map((line) => (
                    <li className='flex gap-1.5' key={line}>
                        <CheckGlyph />
                        <span>{line}</span>
                    </li>
                ))}
                {(tier.adds || []).map((capability) => (
                    <li className='flex gap-1.5' key={capability}>
                        <CheckGlyph />
                        <span>
                            <span className='font-medium'>
                                {capabilityCopy?.[capability]?.label || capability}
                            </span>
                            {capabilityCopy?.[capability]?.learn && (
                                <span className='block text-muted'>
                                    {capabilityCopy[capability].learn}
                                </span>
                            )}
                        </span>
                    </li>
                ))}
            </ul>

            <div className='mt-4 pt-3'>
                {tier.priceUsd > 0 ? (
                    campaignUrl ? (
                        <HeroButton
                            as='a'
                            className='w-full'
                            href={campaignUrl}
                            rel='noopener noreferrer'
                            target='_blank'
                            variant={recommended ? 'primary' : 'tertiary'}
                        >
                            {isCurrent
                                ? t('Manage on Patreon')
                                : t('Choose {{tier}}', { tier: tier.name })}
                        </HeroButton>
                    ) : (
                        // No campaign configured yet: say so plainly rather than
                        // showing a button that goes nowhere.
                        <div className='rounded border border-border/70 bg-surface-secondary/60 px-2 py-1.5 text-center text-xs text-muted'>
                            {t('Coming soon')}
                        </div>
                    )
                ) : (
                    <div className='text-center text-xs text-muted'>
                        {t('No account needed to play')}
                    </div>
                )}
            </div>
        </div>
    );
};

const Membership = () => {
    const { t } = useTranslation();
    const user = useSelector((state) => state.account.user);
    const { data: catalog, isLoading } = useGetMembershipCatalogQuery();
    const { data: mine } = useGetMyMembershipQuery(undefined, { skip: !user });
    const { data: patreon } = useGetPatreonStatusQuery();

    const tiers = catalog?.tiers || [];
    const capabilityCopy = catalog?.capabilities || {};
    const currentTier = mine?.membership?.tier || 'free';
    const isAdmin = !!mine?.membership?.isAdmin;
    const campaignUrl = patreon?.campaignUrl;

    return (
        <div className='mx-auto max-w-6xl space-y-3 p-3'>
            <Panel type='default' compactHeader title={t('Archon Arena Membership')}>
                <div className='space-y-2'>
                    <h2 className='m-0 text-xl font-semibold text-foreground'>
                        {t(
                            'Play Archon Arena for free. Upgrade for deeper competitive intelligence.'
                        )}
                    </h2>
                    <p className='m-0 max-w-3xl text-sm text-muted'>
                        {t(
                            'Playing here is free and always will be — unlimited games, deck import, ' +
                                'matchmaking, leaderboards and tournaments, with nothing held back. ' +
                                'Membership pays for the servers, the deck data and the domain, and in ' +
                                'return it unlocks the tools for players who want to understand their ' +
                                'decks, improve their play, prepare for events and read the meta.'
                        )}
                    </p>
                    <p className='m-0 max-w-3xl text-xs text-muted'>
                        {t(
                            'No membership perk affects Amber, matchmaking, tournament eligibility or ' +
                                'any other competitive outcome. Paying changes what you can see about ' +
                                'your own game — never what happens in it.'
                        )}
                    </p>
                </div>
            </Panel>

            {isAdmin && (
                <AlertPanel
                    type='info'
                    message={t(
                        'You are an administrator, so every membership feature is unlocked for your account regardless of subscription.'
                    )}
                />
            )}

            {isLoading && <div className='text-sm text-muted'>{t('Loading…')}</div>}

            <div className='grid gap-3 md:grid-cols-2 xl:grid-cols-4'>
                {tiers.map((tier) => (
                    <TierCard
                        campaignUrl={campaignUrl}
                        capabilityCopy={capabilityCopy}
                        currentTier={currentTier}
                        isAdmin={isAdmin}
                        key={tier.id}
                        t={t}
                        tier={tier}
                    />
                ))}
            </div>

            <Panel type='default' compactHeader title={t('Where the money goes')}>
                <ul className='m-0 list-disc space-y-1 pl-5 text-sm text-muted'>
                    <li>{t('Hosting: the game servers, the database and backups.')}</li>
                    <li>{t('The Decks of KeyForge API tier that provides SAS and AERC data.')}</li>
                    <li>{t('The domain, email delivery and error monitoring.')}</li>
                    <li>{t('Time spent building the competitive tools listed above.')}</li>
                </ul>
                <p className='mt-2 mb-0 text-xs text-muted'>
                    {t(
                        'Archon Arena is a fan-run, open-source platform. It is not affiliated with or ' +
                            'endorsed by the publishers of KeyForge.'
                    )}
                </p>
            </Panel>

            {user && (
                <Panel type='default' compactHeader title={t('Your membership')}>
                    <div className='flex flex-wrap items-center gap-3 text-sm'>
                        <span
                            className={`rounded-full border px-2 py-0.5 text-xs font-medium ${
                                TIER_BADGE_CLASS[currentTier] || TIER_BADGE_CLASS.free
                            }`}
                        >
                            {mine?.membership?.tierName || t('Free')}
                        </span>
                        {mine?.membership?.complimentary && (
                            <span className='text-xs text-muted'>{t('Complimentary access')}</span>
                        )}
                        {mine?.membership?.expiresAt && (
                            <span className='text-xs text-muted'>
                                {t('Renews or expires {{date}}', {
                                    date: new Date(mine.membership.expiresAt).toLocaleDateString()
                                })}
                            </span>
                        )}
                        <Link className='text-xs text-accent hover:underline' to='/profile'>
                            {t('Manage your Patreon link')}
                        </Link>
                    </div>
                </Panel>
            )}

            <Panel type='default' compactHeader title={t('Questions')}>
                <dl className='m-0 space-y-2 text-sm'>
                    <div>
                        <dt className='font-medium text-foreground'>
                            {t('Does paying make me stronger in game?')}
                        </dt>
                        <dd className='m-0 text-muted'>
                            {t(
                                'No. Every perk is analytics, customisation or convenience. Nothing ' +
                                    'touches the rules, matchmaking or eligibility.'
                            )}
                        </dd>
                    </div>
                    <div>
                        <dt className='font-medium text-foreground'>
                            {t('Is there a limit on how much I can play for free?')}
                        </dt>
                        <dd className='m-0 text-muted'>
                            {t('No. Games are unlimited on every tier, including free.')}
                        </dd>
                    </div>
                    <div>
                        <dt className='flex items-center gap-1.5 font-medium text-foreground'>
                            <LockGlyph />
                            {t('What happens if I cancel?')}
                        </dt>
                        <dd className='m-0 text-muted'>
                            {t(
                                'You keep your account, your decks and your whole match record. The ' +
                                    'premium panels lock again, and unlock immediately if you come back.'
                            )}
                        </dd>
                    </div>
                </dl>
            </Panel>
        </div>
    );
};

Membership.displayName = 'Membership';

export default Membership;
