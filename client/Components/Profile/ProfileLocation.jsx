import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button as HeroButton, Label, toast } from '@heroui/react';

import Panel from '../Site/Panel';
import { COUNTRIES, statesForCountry } from '../../geo';
import { useGetLocationQuery, useSetLocationMutation } from '../../redux/api';

/**
 * ARCHON: player location for rankings (Phase 6). Country drives which
 * regional/country/state leaderboards a player appears on.
 */
const ProfileLocation = () => {
    const { t } = useTranslation();
    const { data: location } = useGetLocationQuery();
    const [setLocation, setState] = useSetLocationMutation();
    const [country, setCountry] = useState('');
    const [state, setStateValue] = useState('');

    useEffect(() => {
        if (location) {
            setCountry(location.country || '');
            setStateValue(location.state || '');
        }
    }, [location]);

    const stateOptions = statesForCountry(country);

    const onSave = async () => {
        try {
            const result = await setLocation({
                country: country || null,
                state: state || null
            }).unwrap();

            if (result.success) {
                toast.success(t('Location saved'));
            } else {
                toast.error(result.message || t('Could not save location'));
            }
        } catch {
            toast.error(t('Could not save location'));
        }
    };

    const selectClass =
        'w-full rounded-md border border-border/65 bg-surface-secondary/55 px-3 py-2 text-sm text-foreground focus:border-border/90 focus:outline-none dark:border-border/80 dark:bg-surface-secondary/85';

    return (
        <Panel type='default' compactHeader title={t('Location')}>
            <p className='mb-3 text-xs text-muted'>
                {t(
                    'Used for rankings: set your country (and state/province) to appear on regional, country, and state leaderboards.'
                )}
            </p>
            <div className='grid gap-2 md:grid-cols-2'>
                <div>
                    <Label htmlFor='locationCountry'>{t('Country')}</Label>
                    <select
                        id='locationCountry'
                        className={selectClass}
                        value={country}
                        onChange={(event) => {
                            setCountry(event.target.value);
                            setStateValue('');
                        }}
                    >
                        <option value=''>{t('Not specified')}</option>
                        {COUNTRIES.map(([code, name]) => (
                            <option key={code} value={code}>
                                {name}
                            </option>
                        ))}
                    </select>
                </div>
                <div>
                    <Label htmlFor='locationState'>{t('State / Province')}</Label>
                    {stateOptions ? (
                        <select
                            id='locationState'
                            className={selectClass}
                            value={state}
                            disabled={!country}
                            onChange={(event) => setStateValue(event.target.value)}
                        >
                            <option value=''>{t('Not specified')}</option>
                            {stateOptions.map((name) => (
                                <option key={name} value={name}>
                                    {name}
                                </option>
                            ))}
                        </select>
                    ) : (
                        <input
                            id='locationState'
                            type='text'
                            className={selectClass}
                            value={state}
                            disabled={!country}
                            maxLength={60}
                            placeholder={t('Optional')}
                            onChange={(event) => setStateValue(event.target.value)}
                        />
                    )}
                </div>
            </div>
            <div className='mt-3'>
                <HeroButton
                    size='sm'
                    variant='primary'
                    isPending={setState.isLoading}
                    onPress={onSave}
                >
                    {t('Save Location')}
                </HeroButton>
            </div>
        </Panel>
    );
};

ProfileLocation.displayName = 'ProfileLocation';

export default ProfileLocation;
