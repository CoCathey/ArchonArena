import React, { useState } from 'react';
import { useSelector } from 'react-redux';
import { useTranslation } from 'react-i18next';
import { Button as HeroButton, Label, toast } from '@heroui/react';

import Panel from '../Components/Site/Panel';
import Link from '../Components/Navigation/Link';
import {
    useGetMobileInfoQuery,
    useGetMyTestFlightRequestQuery,
    useSubmitTestFlightRequestMutation
} from '../redux/api';

const inputClass =
    'w-full rounded-md border border-border/65 bg-surface-secondary/55 px-3 py-2 text-sm text-foreground focus:border-border/90 focus:outline-none';

/**
 * ARCHON (N14): self-serve iOS beta access.
 *
 * The app itself is not the gap - the owner has had friends on it for a
 * while - self-serve is. Apple caps external TestFlight testers and
 * enrollment stays entirely manual in App Store Connect, so this page does
 * not (and cannot) hand out an invite on its own; it captures a request into
 * a queue the admin works through, instead of players having to ask over
 * chat.
 */
const MobileIos = () => {
    const { t } = useTranslation();
    const user = useSelector((state) => state.account.user);
    const { data: info } = useGetMobileInfoQuery();
    const {
        data: mine,
        isLoading: mineLoading,
        refetch
    } = useGetMyTestFlightRequestQuery(undefined, { skip: !user });
    const [submitRequest, submitState] = useSubmitTestFlightRequestMutation();
    const [email, setEmail] = useState('');
    const [requestingAgain, setRequestingAgain] = useState(false);

    const existing = mine?.request;
    const showForm = !existing || (existing.status === 'resolved' && requestingAgain);

    const onSubmit = async () => {
        try {
            const result = await submitRequest(email.trim()).unwrap();

            if (result.success) {
                toast.success(
                    result.alreadyPending
                        ? t("You're already in the queue for a TestFlight invite.")
                        : t('Request received - watch your email for a TestFlight invite.')
                );
                setEmail('');
                setRequestingAgain(false);
                refetch();
            } else {
                toast.danger(result.message || t('Could not send your request'));
            }
        } catch (err) {
            toast.danger(err?.data?.message || t('Could not send your request'));
        }
    };

    return (
        <div className='mx-auto w-full max-w-lg'>
            <Panel title={t('iPhone App')}>
                <div className='space-y-4'>
                    <p className='text-sm text-muted'>
                        {t(
                            'The Archon Arena iOS app is in TestFlight beta. Request an invite below and the beta build number and changelog will show here once one is published.'
                        )}
                    </p>

                    {info?.ios?.buildNumber && (
                        <div className='rounded-md border border-border/60 bg-surface-secondary/50 px-3 py-2 text-sm'>
                            <div className='font-semibold text-foreground'>
                                {t('Current beta build: {{build}}', {
                                    build: info.ios.buildNumber
                                })}
                            </div>
                            {info.ios.changelog && (
                                <p className='mt-1 whitespace-pre-wrap text-xs text-muted'>
                                    {info.ios.changelog}
                                </p>
                            )}
                        </div>
                    )}

                    {!user && (
                        <div className='space-y-3 py-2 text-center'>
                            <p className='text-sm text-muted'>
                                {t('Log in to request a TestFlight invite.')}
                            </p>
                            <Link href='/login'>
                                <HeroButton variant='primary' size='sm'>
                                    {t('Log In')}
                                </HeroButton>
                            </Link>
                        </div>
                    )}

                    {user && existing && existing.status === 'pending' && (
                        <div className='rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-foreground'>
                            {t(
                                "You're in the queue - invited to {{email}}. We'll email you once it's sent.",
                                { email: existing.appleIdEmail }
                            )}
                        </div>
                    )}

                    {user && existing && existing.status === 'resolved' && !requestingAgain && (
                        <div className='space-y-2'>
                            <div className='rounded-md border border-border/60 bg-surface-secondary/50 px-3 py-2 text-sm text-muted'>
                                {t('Your last request ({{email}}) has already been handled.', {
                                    email: existing.appleIdEmail
                                })}
                            </div>
                            <HeroButton
                                size='sm'
                                variant='tertiary'
                                onPress={() => setRequestingAgain(true)}
                            >
                                {t('Request Another Invite')}
                            </HeroButton>
                        </div>
                    )}

                    {user && !mineLoading && showForm && (
                        <div className='space-y-2'>
                            <Label>{t('Apple ID email')}</Label>
                            <input
                                type='email'
                                className={inputClass}
                                value={email}
                                placeholder={t('you@example.com')}
                                onChange={(event) => setEmail(event.target.value)}
                            />
                            <p className='text-xs text-muted'>
                                {t(
                                    'Apple sends the TestFlight invite to this address - it does not have to match your Archon Arena account.'
                                )}
                            </p>
                            <HeroButton
                                variant='primary'
                                size='sm'
                                isPending={submitState.isLoading}
                                isDisabled={!email.trim()}
                                onPress={onSubmit}
                            >
                                {t('Request TestFlight Invite')}
                            </HeroButton>
                        </div>
                    )}
                </div>
            </Panel>
        </div>
    );
};

MobileIos.displayName = 'MobileIos';

export default MobileIos;
