import React from 'react';
import { useTranslation } from 'react-i18next';
import { Button as HeroButton } from '@heroui/react';

import Panel from '../Components/Site/Panel';
import { useGetMobileInfoQuery } from '../redux/api';

/**
 * ARCHON (N14): the Android install link is admin-config rather than
 * hardcoded, the same shape N12 used for Patreon credentials - dormant (no
 * link shown) until an admin sets one once a Play Store beta track or a
 * signed APK actually exists, so this page never links to something that
 * does not exist yet, and going live needs no redeploy.
 */
const MobileAndroid = () => {
    const { t } = useTranslation();
    const { data: info } = useGetMobileInfoQuery();
    const android = info?.android;

    return (
        <div className='mx-auto w-full max-w-lg'>
            <Panel title={t('Android App')}>
                <div className='space-y-4'>
                    <p className='text-sm text-muted'>
                        {t('The Archon Arena Android app is on its way.')}
                    </p>

                    {android?.buildNumber && (
                        <div className='rounded-md border border-border/60 bg-surface-secondary/50 px-3 py-2 text-sm'>
                            <div className='font-semibold text-foreground'>
                                {t('Current beta build: {{build}}', {
                                    build: android.buildNumber
                                })}
                            </div>
                            {android.changelog && (
                                <p className='mt-1 whitespace-pre-wrap text-xs text-muted'>
                                    {android.changelog}
                                </p>
                            )}
                        </div>
                    )}

                    {android?.installUrl ? (
                        <HeroButton
                            variant='primary'
                            size='sm'
                            onPress={() => window.open(android.installUrl, '_blank', 'noopener')}
                        >
                            {t('Get the Beta')}
                        </HeroButton>
                    ) : (
                        <p className='text-sm text-muted'>
                            {t(
                                'The beta is not open yet. Until then, the site works great in Chrome on your phone.'
                            )}
                        </p>
                    )}
                </div>
            </Panel>
        </div>
    );
};

MobileAndroid.displayName = 'MobileAndroid';

export default MobileAndroid;
