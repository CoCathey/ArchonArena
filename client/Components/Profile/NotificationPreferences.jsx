import React from 'react';
import { useTranslation } from 'react-i18next';

import {
    useGetNotificationPreferencesQuery,
    useSetNotificationPreferenceMutation
} from '../../redux/api';

/**
 * ARCHON (N2): per-category notification preferences.
 *
 * Every category the platform can raise is listed with both delivery channels,
 * whether or not the player has ever changed it - a switch you cannot find is
 * not really an opt-out. The categories come from the server's taxonomy rather
 * than a list duplicated here, so a new notification type appears in this panel
 * without a client change.
 *
 * Saved immediately on toggle rather than through the page's Save button: this
 * panel is not part of the profile form, and a switch that silently needs a
 * separate Save is the kind of thing people get wrong once and never trust
 * again.
 */
const NotificationPreferences = () => {
    const { t } = useTranslation();
    const { data, isLoading } = useGetNotificationPreferencesQuery();
    const [setPreference, { isLoading: isSaving }] = useSetNotificationPreferenceMutation();

    const preferences = data?.preferences || [];

    if (isLoading) {
        return <p className='text-sm text-muted'>{t('Loading…')}</p>;
    }

    const onToggle = (preference, channel, value) => {
        // Both channels are always sent: the server stores an explicit row, and
        // sending only the changed one would leave the other at its default
        // rather than at what the player currently sees.
        setPreference({
            category: preference.category,
            inApp: channel === 'inApp' ? value : preference.inApp,
            email: channel === 'email' ? value : preference.email
        })
            .unwrap()
            .catch(() => null);
    };

    // Grouped the way the taxonomy groups them (Tournaments, Community).
    const groups = preferences.reduce((acc, preference) => {
        (acc[preference.group] = acc[preference.group] || []).push(preference);

        return acc;
    }, {});

    return (
        <div className='space-y-4'>
            <p className='text-sm text-muted'>
                {t(
                    'Choose what Archon Arena tells you about, and how. Turning a category off stops both the notification and the email for it.'
                )}
            </p>

            {Object.entries(groups).map(([group, entries]) => (
                <div key={group} className='space-y-2'>
                    <h3 className='m-0 text-sm font-semibold text-foreground'>{t(group)}</h3>
                    <div className='overflow-x-auto'>
                        <table className='w-full border-collapse text-left text-sm'>
                            <thead>
                                <tr className='border-b border-border/70 text-xs uppercase tracking-wide text-muted'>
                                    <th className='px-2 py-2 font-semibold'>{t('Notify me')}</th>
                                    <th className='w-24 px-2 py-2 text-center font-semibold'>
                                        {t('In app')}
                                    </th>
                                    <th className='w-24 px-2 py-2 text-center font-semibold'>
                                        {t('Email')}
                                    </th>
                                </tr>
                            </thead>
                            <tbody>
                                {entries.map((preference) => (
                                    <tr
                                        key={preference.category}
                                        className='border-b border-border/40'
                                    >
                                        <td className='px-2 py-2'>
                                            <div className='text-foreground'>
                                                {t(preference.label)}
                                            </div>
                                            <div className='text-xs text-muted'>
                                                {t(preference.description)}
                                            </div>
                                        </td>
                                        <td className='px-2 py-2 text-center'>
                                            <input
                                                type='checkbox'
                                                checked={!!preference.inApp}
                                                disabled={isSaving}
                                                aria-label={t('{{label}} in app', {
                                                    label: preference.label
                                                })}
                                                onChange={(event) =>
                                                    onToggle(
                                                        preference,
                                                        'inApp',
                                                        event.target.checked
                                                    )
                                                }
                                            />
                                        </td>
                                        <td className='px-2 py-2 text-center'>
                                            <input
                                                type='checkbox'
                                                checked={!!preference.email}
                                                disabled={isSaving}
                                                aria-label={t('{{label}} by email', {
                                                    label: preference.label
                                                })}
                                                onChange={(event) =>
                                                    onToggle(
                                                        preference,
                                                        'email',
                                                        event.target.checked
                                                    )
                                                }
                                            />
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                </div>
            ))}
        </div>
    );
};

NotificationPreferences.displayName = 'NotificationPreferences';

export default NotificationPreferences;
