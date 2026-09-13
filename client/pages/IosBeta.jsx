import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useSelector } from 'react-redux';
import { Button as HeroButton, toast } from '@heroui/react';

import Panel from '../Components/Site/Panel';
import Link from '../Components/Navigation/Link';
import BrandMark from '../assets/img/aa_mark.svg';
import { useGetMyIosBetaRequestQuery, useSubmitIosBetaRequestMutation } from '../redux/api';

/**
 * ARCHON (N14): self-serve TestFlight requests. The build is already in
 * testers' hands; the gap was that the only way in was knowing the owner.
 * This form is the queue instead - Apple caps external testers, so a
 * request sits pending until an admin works through it in order at
 * /admin/ios-beta-requests.
 */
const IosBeta = () => {
    const { t } = useTranslation();
    const user = useSelector((state) => state.account.user);
    const { data, isLoading } = useGetMyIosBetaRequestQuery(undefined, { skip: !user });
    const [submit, submitState] = useSubmitIosBetaRequestMutation();
    const [appleId, setAppleId] = useState('');

    const request = data?.request;

    const onSubmit = async () => {
        try {
            const result = await submit({ appleId }).unwrap();

            if (result.success) {
                toast.success(t('Request sent - you will hear from us once you are added.'));
                setAppleId('');
            } else {
                toast.danger(result.message || t('Could not send the request'));
            }
        } catch (err) {
            toast.danger(err?.data?.message || t('Could not send the request'));
        }
    };

    return (
        <div className='mx-auto w-full max-w-2xl'>
            <Panel title={t('iPhone App')}>
                <div className='flex flex-col items-center gap-4 py-6 text-center'>
                    <img src={BrandMark} alt='' className='h-16 w-16 opacity-60' />
                    <p className='max-w-md text-sm text-muted'>
                        {t(
                            'Archon Arena runs on iPhone through Apple TestFlight. Apple limits how many external testers a beta can have, so requests are worked through in order rather than sent instantly.'
                        )}
                    </p>

                    {!user ? (
                        <div className='space-y-3 pt-2'>
                            <p className='text-sm text-muted'>
                                {t('Log in to request a TestFlight invite.')}
                            </p>
                            <Link href='/login'>
                                <HeroButton variant='primary' size='sm'>
                                    {t('Log In')}
                                </HeroButton>
                            </Link>
                        </div>
                    ) : isLoading ? null : request && request.status === 'pending' ? (
                        <div className='w-full max-w-sm rounded-md border border-border/60 bg-surface-secondary/50 px-4 py-3'>
                            <div className='text-sm font-semibold text-foreground'>
                                {t('Request received')}
                            </div>
                            <p className='mt-1 text-xs text-muted'>
                                {t(
                                    'You are in the queue for {{appleId}}. Once you are added in App Store Connect, Apple will send the TestFlight invite to that address.',
                                    { appleId: request.appleId || '' }
                                )}
                            </p>
                        </div>
                    ) : (
                        <div className='w-full max-w-sm space-y-3 pt-2 text-left'>
                            {request && request.status === 'cleared' && (
                                <p className='text-xs text-emerald-400'>
                                    {t(
                                        'Your last invite was sent. Requesting again queues a fresh one.'
                                    )}
                                </p>
                            )}
                            <label className='block text-xs font-medium text-muted'>
                                {t('Apple ID email')}
                            </label>
                            <input
                                type='email'
                                className='w-full rounded-md border border-border/65 bg-surface-secondary/55 px-3 py-2 text-sm text-foreground focus:border-border/90 focus:outline-none'
                                value={appleId}
                                placeholder='you@example.com'
                                onChange={(event) => setAppleId(event.target.value)}
                            />
                            <HeroButton
                                variant='primary'
                                size='sm'
                                className='w-full'
                                isPending={submitState.isLoading}
                                isDisabled={!appleId.trim()}
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

IosBeta.displayName = 'IosBeta';

export default IosBeta;
