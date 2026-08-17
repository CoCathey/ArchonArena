import React, { useEffect, useState } from 'react';
import { useSelector } from 'react-redux';
import { useTranslation } from 'react-i18next';
import { Button as HeroButton, toast } from '@heroui/react';
import { Link } from 'react-router-dom';

import Panel from '../Components/Site/Panel';
import AlertPanel from '../Components/Site/AlertPanel';
import { LockGlyph } from '../Components/Membership/PremiumLock';
import {
    useGetMembershipCatalogQuery,
    useGetMyMembershipQuery,
    useGetPatreonStatusQuery,
    useStartPatreonLinkMutation
} from '../redux/api';
import { isAdminUser, TIER_BADGE_CLASS } from '../membership';
import { isPatreonUnlinked } from '../types';
import { clearUpgradeIntent, readUpgradeIntent, recordUpgradeIntent } from '../patreonIntent';

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

const TierCard = ({ tier, capabilityCopy, currentTier, isAdmin, campaignUrl, onChoose, t }) => {
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
                {(tier.adds || [])
                    .filter((capability) => !capabilityCopy?.[capability]?.planned)
                    .map((capability) => (
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

                {/* ARCHON (N12): planned work is shown, but never as something
                    you are buying today. An audit found thirteen capabilities
                    advertised with nothing behind them; listing them with a tick
                    alongside working features is how that happened. */}
                {(tier.adds || []).some((capability) => capabilityCopy?.[capability]?.planned) && (
                    <li className='mt-2 border-t border-border/60 pt-2'>
                        <div className='mb-1 text-[10px] font-semibold uppercase tracking-wide text-muted'>
                            {t('Planned — not available yet')}
                        </div>
                        <ul className='m-0 flex list-none flex-col gap-1 p-0'>
                            {(tier.adds || [])
                                .filter((capability) => capabilityCopy?.[capability]?.planned)
                                .map((capability) => (
                                    <li className='flex gap-1.5 text-muted' key={capability}>
                                        <span aria-hidden='true' className='mt-0.5 shrink-0'>
                                            ○
                                        </span>
                                        <span>
                                            {capabilityCopy?.[capability]?.label || capability}
                                        </span>
                                    </li>
                                ))}
                        </ul>
                    </li>
                )}
            </ul>

            <div className='mt-4 pt-3'>
                {tier.priceUsd > 0 ? (
                    // `purchasable` is false when a tier delivers nothing today
                    // that the tier below already includes. Offering checkout
                    // for it would be charging for nothing.
                    tier.purchasable && (tier.checkoutUrl || campaignUrl) ? (
                        // ARCHON (N12): a real anchor, not <HeroButton as='a'>.
                        // HeroUI's Button does not forward `href` - it renders a
                        // <button>, so the tier buttons looked correct and did
                        // nothing at all. Every other external link in this
                        // codebase is a plain <a> for the same reason; this was
                        // the only `as='a'` anywhere, and it was wrong.
                        <a
                            className={[
                                'inline-flex h-9 w-full items-center justify-center rounded-md px-3 text-sm font-semibold transition',
                                recommended
                                    ? 'bg-amber-500 text-black hover:bg-amber-400'
                                    : 'border border-border/70 bg-surface-secondary/60 text-foreground hover:bg-surface-secondary'
                            ].join(' ')}
                            // Per-tier checkout when the reward id is
                            // configured, campaign page otherwise.
                            href={tier.checkoutUrl || campaignUrl}
                            rel='noopener noreferrer'
                            target='_blank'
                            // The site cannot see a subscription until the
                            // account is linked, so remember that they went to
                            // pay and ask them to finish when they come back.
                            onClick={() => onChoose(tier.id)}
                        >
                            {isCurrent
                                ? t('Manage on Patreon')
                                : t('Choose {{tier}}', { tier: tier.name })}
                        </a>
                    ) : (
                        // No campaign configured yet: say so plainly rather than
                        // showing a button that goes nowhere.
                        <div className='rounded border border-border/70 bg-surface-secondary/60 px-2 py-1.5 text-center text-xs text-muted'>
                            {tier.purchasable === false
                                ? t('Not available yet — nothing in this tier is built')
                                : t('Coming soon')}
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

/**
 * ARCHON (N12): the prompt that catches someone coming back from Patreon.
 *
 * Without it the flow dead-ends silently: the site cannot see a subscription
 * until the account is linked (pledge status is read with the player's OWN
 * token - there is no webhook and no campaign poll), so a player pays, returns,
 * and is still shown as Free. The reasonable conclusion is that the payment
 * failed.
 *
 * Re-checked on window focus because the checkout opens in a new tab: the
 * membership page is still mounted behind it and would otherwise never
 * re-render when they switch back.
 */
const useUpgradeIntent = () => {
    const [intent, setIntent] = useState(() => readUpgradeIntent());

    useEffect(() => {
        const recheck = () => setIntent(readUpgradeIntent());

        window.addEventListener('focus', recheck);
        document.addEventListener('visibilitychange', recheck);

        return () => {
            window.removeEventListener('focus', recheck);
            document.removeEventListener('visibilitychange', recheck);
        };
    }, []);

    return [intent, setIntent];
};

const FinishLinking = ({ tierName, onLink, onDismiss, isLinking, t }) => (
    <div className='rounded-lg border border-amber-500/60 bg-amber-500/10 p-4'>
        <h3 className='m-0 text-sm font-semibold text-foreground'>
            {tierName
                ? t('Finish connecting your {{tier}} membership', { tier: tierName })
                : t('Finish connecting your membership')}
        </h3>
        <p className='mt-1 mb-3 max-w-2xl text-xs text-muted'>
            {t(
                'Subscribing on Patreon is only half of it — Archon Arena cannot see your ' +
                    'membership until you connect your Patreon account. It takes one click, and ' +
                    'your benefits unlock straight away.'
            )}
        </p>
        <div className='flex flex-wrap gap-2'>
            <HeroButton isDisabled={isLinking} size='sm' variant='primary' onPress={onLink}>
                {isLinking ? t('Connecting…') : t('Connect Patreon')}
            </HeroButton>
            <HeroButton size='sm' variant='tertiary' onPress={onDismiss}>
                {t('Not now')}
            </HeroButton>
        </div>
    </div>
);

/**
 * ARCHON (N12): the full "what do I actually get" grid.
 *
 * The tier cards sell; this settles. Rows are grouped by the tier that
 * introduces each capability, and every column to the right of that tier gets a
 * tick automatically - which is the visual form of "every tier includes the
 * ones below it", rather than a sentence asking the reader to take it on trust.
 *
 * Driven entirely by the server's catalogue, so moving a capability between
 * tiers moves it here too, with no edit to this file.
 */
const ComparisonTable = ({ tiers, capabilityCopy, currentTier, t }) => {
    if (!tiers.length) {
        return null;
    }

    const free = tiers.find((tier) => tier.rank === 0);
    const rows = tiers.flatMap((tier) =>
        (tier.adds || []).map((capability) => ({ capability, introducedBy: tier }))
    );

    const Tick = () => (
        <svg
            aria-hidden='true'
            className='mx-auto h-4 w-4 text-emerald-400'
            fill='none'
            stroke='currentColor'
            strokeWidth='2.5'
            viewBox='0 0 24 24'
        >
            <path d='M20 6 9 17l-5-5' />
        </svg>
    );

    return (
        <div className='overflow-x-auto'>
            <table className='w-full min-w-[640px] border-collapse text-sm'>
                <thead>
                    <tr className='border-b border-border/70'>
                        <th className='py-2 pr-3 text-left text-xs font-medium uppercase tracking-wide text-muted'>
                            {t('Feature')}
                        </th>
                        {tiers.map((tier) => (
                            <th
                                className={[
                                    'w-24 px-2 py-2 text-center text-xs font-semibold',
                                    tier.recommended ? 'text-amber-300' : 'text-foreground',
                                    currentTier === tier.id ? 'bg-surface-secondary/50' : ''
                                ].join(' ')}
                                key={tier.id}
                            >
                                <div>{tier.name}</div>
                                <div className='font-normal text-muted'>
                                    {tier.priceUsd ? `$${tier.priceUsd}` : t('Free')}
                                </div>
                            </th>
                        ))}
                    </tr>
                </thead>
                <tbody>
                    {/* Everything free, ticked all the way across - the point
                        being that nothing about playing is taken away. */}
                    {(free?.includes || []).map((line) => (
                        <tr className='border-b border-border/40' key={line}>
                            <td className='py-1.5 pr-3 text-foreground'>{line}</td>
                            {tiers.map((tier) => (
                                <td className='px-2 py-1.5' key={tier.id}>
                                    <Tick />
                                </td>
                            ))}
                        </tr>
                    ))}

                    {rows.map(({ capability, introducedBy }) => {
                        const copy = capabilityCopy?.[capability];

                        return (
                            <tr className='border-b border-border/40' key={capability}>
                                <td className='py-1.5 pr-3'>
                                    <div className='text-foreground'>
                                        {copy?.label || capability}
                                    </div>
                                    {copy?.learn && (
                                        <div className='text-xs text-muted'>{copy.learn}</div>
                                    )}
                                </td>
                                {tiers.map((tier) => (
                                    <td
                                        className={[
                                            'px-2 py-1.5 text-center',
                                            currentTier === tier.id ? 'bg-surface-secondary/50' : ''
                                        ].join(' ')}
                                        key={tier.id}
                                    >
                                        {copy?.planned ? (
                                            // Planned everywhere it would apply,
                                            // rather than a tick that says it
                                            // works today.
                                            <span className='text-[10px] uppercase tracking-wide text-muted'>
                                                {tier.rank >= introducedBy.rank
                                                    ? t('Planned')
                                                    : '—'}
                                            </span>
                                        ) : tier.rank >= introducedBy.rank ? (
                                            <Tick />
                                        ) : (
                                            <span className='text-muted'>—</span>
                                        )}
                                    </td>
                                ))}
                            </tr>
                        );
                    })}
                </tbody>
            </table>
        </div>
    );
};

/**
 * Where each thing you paid for actually lives.
 *
 * Borrowed from what Decks of KeyForge does well: subscribing is only useful if
 * you can then find the thing. The locations come from the server's capability
 * catalogue alongside the labels, so a feature that moves is described in one
 * place.
 */
const WhereToFindIt = ({ tiers, capabilityCopy, t }) => (
    <div className='space-y-3'>
        {tiers
            .filter((tier) => (tier.adds || []).length)
            .map((tier) => (
                <div key={tier.id}>
                    <h4 className='m-0 mb-1 text-sm font-semibold text-foreground'>{tier.name}</h4>
                    <dl className='m-0 grid gap-x-4 gap-y-1 sm:grid-cols-2'>
                        {(tier.adds || [])
                            .filter((capability) => !capabilityCopy?.[capability]?.planned)
                            .map((capability) => {
                                const copy = capabilityCopy?.[capability];

                                return (
                                    <div className='flex gap-2 text-xs' key={capability}>
                                        <dt className='shrink-0 text-foreground'>
                                            {copy?.label || capability}
                                        </dt>
                                        <dd className='m-0 text-muted'>{copy?.where || '—'}</dd>
                                    </div>
                                );
                            })}
                    </dl>
                </div>
            ))}
        <p className='m-0 text-xs text-muted'>
            {t(
                'Benefits unlock as soon as your Patreon account is connected — there is nothing else to claim.'
            )}
        </p>
    </div>
);

const Membership = () => {
    const { t } = useTranslation();
    const user = useSelector((state) => state.account.user);
    const { data: catalog, isLoading } = useGetMembershipCatalogQuery();
    const { data: mine } = useGetMyMembershipQuery(undefined, { skip: !user });
    const { data: patreon } = useGetPatreonStatusQuery();

    const [intent, setIntent] = useUpgradeIntent();
    const [startPatreonLink, linkState] = useStartPatreonLinkMutation();

    const linked = !isPatreonUnlinked(user?.patreon);
    // Only worth asking when there is something to finish: they went to pay,
    // they are signed in, and the account is not linked yet. A linked account
    // needs no prompt - the next auth refresh reads their pledge.
    const showFinishLinking = !!intent && !!user && !linked && !!patreon?.enabled;
    // The same condition without the breadcrumb: anyone signed in who has not
    // connected yet can do it from here.
    const canLink = !!user && !linked && !!patreon?.enabled;

    useEffect(() => {
        // Linked (or already a paying member): the breadcrumb has done its job.
        if (linked || (mine?.membership?.rank ?? 0) > 0) {
            clearUpgradeIntent();
            setIntent(null);
        }
    }, [linked, mine, setIntent]);

    const onFinishLinking = async () => {
        try {
            const result = await startPatreonLink().unwrap();

            if (result.success && result.url) {
                window.location.assign(result.url);
            } else {
                toast.danger(result.message || t('Could not start account linking'));
            }
        } catch {
            toast.danger(t('Could not start account linking'));
        }
    };

    const onDismissLinking = () => {
        clearUpgradeIntent();
        setIntent(null);
    };

    const tiers = catalog?.tiers || [];
    const capabilityCopy = catalog?.capabilities || {};
    const currentTier = mine?.membership?.tier || 'free';
    // Read locally as well as from the API: the notice explains why every
    // panel is unlocked, and it would be strange for it to disappear because a
    // status request failed.
    const isAdmin = !!mine?.membership?.isAdmin || isAdminUser(user);
    const campaignUrl = patreon?.campaignUrl;

    return (
        <div className='mx-auto max-w-6xl space-y-3 p-3'>
            {/* ARCHON (N12): what you currently have, before what you could buy.
                This sat at the foot of the page, below the pitch, the grid, the
                comparison table and the funding note - so the one line a
                signed-in member actually comes here for (which tier am I on,
                and where do I manage it) was the last thing on the page. */}
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
                        {/* ARCHON (N20): the trial names itself - "complimentary"
                            reads like an admin favour, and "renews" like a bill. */}
                        {mine?.membership?.source === 'new-player-trial' ? (
                            <span className='text-xs text-emerald-300'>
                                {t('New player trial — Archon’s tools are yours until {{date}}', {
                                    date: mine?.membership?.expiresAt
                                        ? new Date(mine.membership.expiresAt).toLocaleDateString()
                                        : ''
                                })}
                            </span>
                        ) : (
                            <>
                                {mine?.membership?.complimentary && (
                                    <span className='text-xs text-muted'>
                                        {t('Complimentary access')}
                                    </span>
                                )}
                                {mine?.membership?.expiresAt && (
                                    <span className='text-xs text-muted'>
                                        {t('Renews or expires {{date}}', {
                                            date: new Date(
                                                mine.membership.expiresAt
                                            ).toLocaleDateString()
                                        })}
                                    </span>
                                )}
                            </>
                        )}
                        <Link
                            className='text-xs text-accent hover:underline'
                            to='/profile?section=integrations'
                        >
                            {t('Manage your Patreon link')}
                        </Link>
                    </div>
                </Panel>
            )}

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
                    {/* ARCHON (N20): the trial is stated with the same number
                        the resolver enforces, from the catalogue payload. */}
                    {!!catalog?.newPlayerTrialDays && (
                        <p className='m-0 max-w-3xl text-sm font-medium text-emerald-300'>
                            {t(
                                'Every new account starts with the Archon tier’s tools, free, for its ' +
                                    'first {{days}} days — nothing to claim, it is simply on.',
                                { days: catalog.newPlayerTrialDays }
                            )}
                        </p>
                    )}

                    {/* Always offered to a signed-in account that has not linked
                        yet, not only after an upgrade click - somebody who
                        subscribed on their phone arrives here with no
                        breadcrumb, and the site cannot see their pledge until
                        they connect. */}
                    {canLink && (
                        <div className='flex flex-wrap items-center gap-2 pt-1'>
                            <HeroButton
                                isDisabled={linkState.isLoading}
                                size='sm'
                                variant='tertiary'
                                onPress={onFinishLinking}
                            >
                                {linkState.isLoading
                                    ? t('Connecting…')
                                    : t('Already subscribed? Connect Patreon')}
                            </HeroButton>
                            <span className='text-xs text-muted'>
                                {t('Your benefits unlock the moment your account is connected.')}
                            </span>
                        </div>
                    )}
                </div>
            </Panel>

            {showFinishLinking && (
                <FinishLinking
                    isLinking={linkState.isLoading}
                    onDismiss={onDismissLinking}
                    onLink={onFinishLinking}
                    t={t}
                    tierName={(tiers.find((tier) => tier.id === intent.tier) || {}).name || null}
                />
            )}

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
                        onChoose={recordUpgradeIntent}
                        t={t}
                        tier={tier}
                    />
                ))}
            </div>

            <Panel type='default' compactHeader title={t('Compare every tier')}>
                <p className='mt-0 mb-2 text-xs text-muted'>
                    {t('Every tier includes everything in the tiers below it.')}
                </p>
                <ComparisonTable
                    capabilityCopy={capabilityCopy}
                    currentTier={currentTier}
                    t={t}
                    tiers={tiers}
                />
            </Panel>

            <Panel type='default' compactHeader title={t('Where to find your benefits')}>
                <WhereToFindIt capabilityCopy={capabilityCopy} t={t} tiers={tiers} />
            </Panel>

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
