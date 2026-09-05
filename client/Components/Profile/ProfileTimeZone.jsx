import React from 'react';
import { useTranslation } from 'react-i18next';

import Panel from '../Site/Panel';
import { browserTimeZone } from '../Site/useSyncTimeZone';

/**
 * ARCHON: the zone emailed match times are said in.
 *
 * Read-only on purpose. It follows the browser the player last signed in from
 * (see useSyncTimeZone), which is the right answer for almost everybody and
 * needs nobody to do anything; a hand-set zone would be overwritten on the
 * next sign-in from a browser that disagreed. The panel exists so the player
 * can SEE what the emails will assume, and understand why it changed after a
 * trip.
 *
 * @param {{ user: object }} props
 */
const ProfileTimeZone = ({ user }) => {
    const { t } = useTranslation();
    const remembered = user?.settings?.timeZone;
    const detected = browserTimeZone();

    const sample = (zone) => {
        if (!zone) {
            return null;
        }

        try {
            return new Intl.DateTimeFormat(undefined, {
                timeZone: zone,
                hour: 'numeric',
                minute: '2-digit',
                timeZoneName: 'short'
            }).format(new Date());
        } catch {
            return null;
        }
    };

    return (
        <Panel type='default' compactHeader title={t('Time zone')}>
            <div className='space-y-1 text-sm'>
                <div>
                    <span className='text-muted'>{t('Emails and reminders use')}: </span>
                    <span className='font-semibold text-foreground'>
                        {remembered || detected || t('UTC')}
                    </span>
                    {sample(remembered || detected) && (
                        <span className='ml-2 text-xs text-muted'>
                            {t('(it is {{time}} there now)', {
                                time: sample(remembered || detected)
                            })}
                        </span>
                    )}
                </div>
                <div className='text-xs text-muted'>
                    {remembered && detected && remembered !== detected
                        ? t(
                              'This browser reports {{zone}}; the account will switch to it the next time the page loads.',
                              { zone: detected }
                          )
                        : t(
                              'Detected from your browser automatically, so match times in email read in your local time.'
                          )}
                </div>
            </div>
        </Panel>
    );
};

ProfileTimeZone.displayName = 'ProfileTimeZone';

export default ProfileTimeZone;
