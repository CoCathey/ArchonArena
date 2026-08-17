import React, { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import Panel from '../Site/Panel';
import { useGetAdminMembershipsQuery, useGrantMembershipMutation } from '../../redux/api';

/**
 * ARCHON (N37): comping a tier to somebody, from a screen instead of a shell.
 *
 * The whole mechanism already existed - `Memberships."GrantedTier"` and
 * `"GrantedUntil"`, resolved by `entitlements` above any paid membership, with
 * an admin endpoint and even an RTK mutation wired up. What it never had was a
 * button, so the only way to give a player a week of Vault Master was a
 * hand-written POST. A capability nobody can reach is a capability that does
 * not exist, whatever the code says.
 *
 * Two decisions worth naming.
 *
 * The seven-day Vault Master trial is ONE button, not a form to fill in. It is
 * the thing this screen is for - handing somebody the Champion's Challenge to
 * try before an event - and making it the default path means the common case
 * costs a username and a click. The tier and length pickers are there for
 * everything else, below.
 *
 * Current comps are listed with a revoke, because a grant screen that cannot
 * show what has been granted invites the same comp being handed out twice, and
 * an expiry nobody can see is one nobody can plan around. Revoking clears the
 * comp ONLY - a paid membership underneath is untouched, which is the whole
 * reason grants live in their own columns.
 */

const TIERS = [
    { id: 'vault_master', name: 'Vault Master' },
    { id: 'archon', name: 'Archon' },
    { id: 'supporter', name: 'Supporter' }
];

const TRIAL_DAYS = 7;
const TRIAL_TIER = 'vault_master';

/** `days` from now as an ISO instant, or null for an open-ended grant. */
const until = (days) => {
    if (!days) {
        return null;
    }

    const expiry = new Date();

    expiry.setDate(expiry.getDate() + Number(days));

    return expiry.toISOString();
};

const when = (value) => {
    if (!value) {
        return null;
    }

    const date = new Date(value);

    return Number.isNaN(date.getTime()) ? null : date.toLocaleDateString();
};

const MembershipGrants = () => {
    const { t } = useTranslation();
    const { data, isError, refetch } = useGetAdminMembershipsQuery();
    const [grantMembership, { isLoading }] = useGrantMembershipMutation();
    const [username, setUsername] = useState('');
    const [tier, setTier] = useState(TRIAL_TIER);
    const [days, setDays] = useState(String(TRIAL_DAYS));
    const [message, setMessage] = useState(null);

    // Only accounts actually carrying a comp. The endpoint returns every
    // membership row it knows about, and a list dominated by paying members
    // would bury the handful this screen is responsible for.
    const granted = useMemo(
        () => (data?.members || []).filter((member) => member.grantedTier),
        [data]
    );

    const grant = async (body, success) => {
        setMessage(null);

        try {
            const result = await grantMembership(body).unwrap();

            if (result && result.success === false) {
                setMessage(result.message || t('That grant could not be made.'));

                return;
            }

            setMessage(success);
            refetch();
        } catch (error) {
            setMessage(error?.data?.message || t('That grant could not be made.'));
        }
    };

    const giveTrial = () =>
        grant(
            {
                username,
                tier: TRIAL_TIER,
                until: until(TRIAL_DAYS),
                reason: `${TRIAL_DAYS}-day Vault Master trial`
            },
            t('{{username}} has Vault Master for {{days}} days.', {
                username,
                days: TRIAL_DAYS
            })
        );

    const giveCustom = () =>
        grant(
            {
                username,
                tier,
                until: until(days),
                reason: days
                    ? `${days}-day comp`
                    : // A comp with no end date is a decision, so it is recorded
                      // as one rather than left blank in the audit column.
                      'Indefinite comp'
            },
            days
                ? t('{{username}} has {{tier}} for {{days}} days.', { username, tier, days })
                : t('{{username}} has {{tier}} indefinitely.', { username, tier })
        );

    const revoke = (member) =>
        grant(
            // A null tier clears the comp and leaves any paid membership alone.
            { username: member.username, tier: null },
            t('The comp on {{username}} has been removed.', { username: member.username })
        );

    const inputClass =
        'rounded border border-border/70 bg-surface-secondary/60 px-2 py-1 text-sm text-foreground';

    return (
        <Panel title={t('Complimentary membership')}>
            <p className='m-0 pb-2 text-sm text-muted'>
                {t(
                    'Give an account a paid tier without a payment — a trial before an event, a ' +
                        'contributor, or putting something right. A comp sits alongside any real ' +
                        'membership and never replaces it.'
                )}
            </p>

            <div className='flex flex-wrap items-end gap-2 pb-2'>
                <label className='flex-1'>
                    <span className='mb-0.5 block text-[10px] uppercase tracking-wide text-muted'>
                        {t('Username')}
                    </span>
                    <input
                        className={`w-full ${inputClass}`}
                        onChange={(e) => setUsername(e.target.value)}
                        placeholder={t('Their exact username')}
                        value={username}
                    />
                </label>
                <button
                    className='rounded-md border border-accent/60 bg-accent/20 px-3 py-1 text-xs font-semibold text-amber-200 disabled:opacity-40'
                    disabled={isLoading || !username.trim()}
                    onClick={giveTrial}
                    type='button'
                >
                    {t('Give {{days}}-day Vault Master trial', { days: TRIAL_DAYS })}
                </button>
            </div>

            <div className='flex flex-wrap items-end gap-2 border-t border-border/40 pt-2'>
                <span className='pb-1 text-[11px] text-muted'>{t('or comp')}</span>
                <select
                    className={inputClass}
                    onChange={(e) => setTier(e.target.value)}
                    value={tier}
                >
                    {TIERS.map((entry) => (
                        <option key={entry.id} value={entry.id}>
                            {entry.name}
                        </option>
                    ))}
                </select>
                <label>
                    <span className='mb-0.5 block text-[10px] uppercase tracking-wide text-muted'>
                        {t('Days (blank = no end)')}
                    </span>
                    <input
                        className={`w-28 ${inputClass}`}
                        min='1'
                        onChange={(e) => setDays(e.target.value)}
                        type='number'
                        value={days}
                    />
                </label>
                <button
                    className='rounded-md border border-border/70 px-3 py-1 text-xs text-foreground disabled:opacity-40'
                    disabled={isLoading || !username.trim()}
                    onClick={giveCustom}
                    type='button'
                >
                    {t('Grant')}
                </button>
            </div>

            {message && <p className='m-0 pt-2 text-[11px] text-amber-300'>{message}</p>}

            <div className='pt-3'>
                <div className='pb-1 text-[10px] uppercase tracking-wide text-muted'>
                    {t('Current comps')}
                </div>
                {isError ? (
                    <p className='m-0 text-sm text-red-300'>
                        {t('The membership list could not be loaded.')}
                    </p>
                ) : granted.length === 0 ? (
                    <p className='m-0 text-sm text-muted'>{t('Nobody has a comped tier.')}</p>
                ) : (
                    <ul className='m-0 list-none space-y-0.5 p-0 text-sm'>
                        {granted.map((member) => (
                            <li
                                className='flex flex-wrap items-baseline gap-2 border-b border-border/40 py-1 last:border-0'
                                key={member.userId}
                            >
                                <span className='text-foreground'>{member.username}</span>
                                <span className='text-[11px] text-muted'>{member.grantedTier}</span>
                                <span className='text-[11px] text-muted'>
                                    {when(member.grantedUntil)
                                        ? t('until {{date}}', {
                                              date: when(member.grantedUntil)
                                          })
                                        : t('no end date')}
                                </span>
                                {member.grantedReason && (
                                    <span className='text-[11px] text-muted'>
                                        {member.grantedReason}
                                    </span>
                                )}
                                <button
                                    className='ms-auto rounded border border-border/70 px-1.5 py-0.5 text-[11px] text-muted hover:text-foreground'
                                    disabled={isLoading}
                                    onClick={() => revoke(member)}
                                    type='button'
                                >
                                    {t('Revoke')}
                                </button>
                            </li>
                        ))}
                    </ul>
                )}
            </div>
        </Panel>
    );
};

MembershipGrants.displayName = 'MembershipGrants';

export default MembershipGrants;
