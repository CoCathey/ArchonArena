import React, { useEffect, useRef, useState } from 'react';
import { useSelector } from 'react-redux';
import { useTranslation, Trans } from 'react-i18next';
import { Button as HeroButton, Input } from '@heroui/react';
import { useNavigate, useParams } from 'react-router-dom';

import Panel from '../Components/Site/Panel';
import Link from '../Components/Navigation/Link';
import { useCheckInByCodeMutation } from '../redux/api';

/**
 * ARCHON: the other end of the check-in kiosk (N9).
 *
 * An organizer opens check-in, prints the QR that CheckInKiosk renders, and
 * tapes it to the door. That QR encodes `/check-in/<code>` and the card next
 * to it tells players they can type the code at /check-in. Neither route
 * existed: every player who scanned the poster at a live event landed on the
 * 404 page. The whole server side was built and tested - the endpoint, the
 * service, even the RTK mutation - and nothing ever called it.
 *
 * Scanning does the check-in immediately and sends the player to the event.
 * Typing the code by hand is the same thing with one more step, and is worth
 * keeping: phone cameras fail, and a code read off a poster still works.
 *
 * The code identifies the EVENT, not the player - it marks whoever is signed
 * in as present, so a photographed poster cannot check anyone else in.
 */
const CheckIn = () => {
    const { t } = useTranslation();
    const navigate = useNavigate();
    const { code: scannedCode } = useParams();
    const user = useSelector((state) => state.account.user);

    const [code, setCode] = useState(scannedCode || '');
    const [error, setError] = useState(null);
    const [checkInByCode, { isLoading }] = useCheckInByCodeMutation();
    // A scan checks in by itself, but only once: without this, any re-render
    // while the request is in flight fires a second one.
    const attempted = useRef(false);

    const submit = async (value) => {
        const entered = (value || '').trim();

        if (!entered) {
            setError(t('Enter the code from the check-in sheet'));

            return;
        }

        setError(null);

        try {
            const result = await checkInByCode(entered).unwrap();

            if (result.success) {
                navigate(`/tournaments/${result.tournamentId}`, { replace: true });

                return;
            }

            setError(result.message || t('That code did not check you in'));
        } catch {
            setError(t('That code did not check you in'));
        }
    };

    useEffect(() => {
        if (!scannedCode || !user || attempted.current) {
            return;
        }

        attempted.current = true;
        submit(scannedCode);
        // Deliberately keyed on the scan and the sign-in only: this is a
        // one-shot side effect, not a subscription.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [scannedCode, user]);

    if (!user) {
        return (
            <div className='mx-auto w-full max-w-md'>
                <Panel title={t('Event Check-in')}>
                    <div className='space-y-3 text-sm'>
                        <p>
                            <Trans>
                                Sign in first - checking in marks your own account present at the
                                event.
                            </Trans>
                        </p>
                        {scannedCode && (
                            <p className='text-muted'>
                                {t('Your code is {{code}} - it will still work afterwards.', {
                                    code: scannedCode
                                })}
                            </p>
                        )}
                        <Link href='/login'>
                            <HeroButton variant='primary' size='sm'>
                                {t('Sign in')}
                            </HeroButton>
                        </Link>
                    </div>
                </Panel>
            </div>
        );
    }

    return (
        <div className='mx-auto w-full max-w-md'>
            <Panel title={t('Event Check-in')}>
                <div className='space-y-3'>
                    <p className='text-sm text-muted'>
                        <Trans>
                            Enter the code from the check-in sheet to mark yourself present.
                        </Trans>
                    </p>
                    <Input
                        aria-label={t('Check-in code')}
                        className='font-mono tracking-widest'
                        value={code}
                        autoFocus
                        onChange={(event) => setCode(event.target.value.toUpperCase())}
                        onKeyDown={(event) => {
                            if (event.key === 'Enter') {
                                submit(code);
                            }
                        }}
                        placeholder={t('Check-in code')}
                    />
                    {error && <div className='text-sm text-red-400'>{error}</div>}
                    <div className='flex gap-2'>
                        <HeroButton
                            variant='primary'
                            size='sm'
                            isPending={isLoading}
                            onPress={() => submit(code)}
                        >
                            {t('Check In')}
                        </HeroButton>
                        <Link href='/tournaments'>
                            <HeroButton variant='tertiary' size='sm'>
                                {t('All events')}
                            </HeroButton>
                        </Link>
                    </div>
                </div>
            </Panel>
        </div>
    );
};

CheckIn.displayName = 'CheckIn';

export default CheckIn;
