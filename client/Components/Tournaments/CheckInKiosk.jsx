import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button as HeroButton, toast } from '@heroui/react';
import QRCode from 'qrcode';

import Panel from '../Site/Panel';

/**
 * ARCHON (N9): the check-in QR an organizer prints and puts by the door.
 *
 * The code identifies the EVENT, never a player - scanning it marks whoever
 * is signed in on that phone as present, so a photographed or forwarded code
 * cannot check anybody else in. That is also why it is not the join code: a
 * join code grants entry to a private event and must never end up on a poster.
 */
const CheckInKiosk = ({ code }) => {
    const { t } = useTranslation();
    const [dataUrl, setDataUrl] = useState(null);

    const url = `${window.location.origin}/check-in/${code}`;

    useEffect(() => {
        let cancelled = false;

        // Rendered locally to a data URI - never through a QR web service,
        // which would hand a third party the event's check-in code.
        QRCode.toDataURL(url, { width: 240, margin: 1 })
            .then((generated) => {
                if (!cancelled) {
                    setDataUrl(generated);
                }
            })
            .catch(() => {
                if (!cancelled) {
                    setDataUrl(null);
                }
            });

        return () => {
            cancelled = true;
        };
    }, [url]);

    if (!code) {
        return null;
    }

    return (
        <Panel title={t('Check-in kiosk')}>
            <div className='flex flex-wrap items-center gap-4'>
                {dataUrl ? (
                    <img
                        src={dataUrl}
                        alt={t('Check-in QR code')}
                        className='rounded bg-white p-2'
                        width={160}
                        height={160}
                    />
                ) : (
                    <div className='text-sm text-muted'>{t('Preparing code...')}</div>
                )}
                <div className='space-y-1 text-sm'>
                    <div className='text-muted'>{t('Or enter this code at /check-in:')}</div>
                    <code className='font-mono text-lg font-bold tracking-widest text-amber-300'>
                        {code}
                    </code>
                    <div className='text-xs text-muted'>
                        {t(
                            'Players scan this to mark themselves present. It only checks in the person scanning, so it is safe to leave on the table.'
                        )}
                    </div>
                    <HeroButton
                        size='sm'
                        variant='tertiary'
                        className='!h-6 !px-2 text-xs'
                        onPress={() => {
                            navigator.clipboard?.writeText(url);
                            toast.success(t('Copied'));
                        }}
                    >
                        {t('Copy link')}
                    </HeroButton>
                </div>
            </div>
        </Panel>
    );
};

CheckInKiosk.displayName = 'CheckInKiosk';

export default CheckInKiosk;
