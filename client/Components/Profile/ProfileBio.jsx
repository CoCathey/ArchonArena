import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button as HeroButton, Label, toast } from '@heroui/react';

import Panel from '../Site/Panel';
import { useGetBioQuery, useSetBioMutation } from '../../redux/api';

const BIO_MAX_LENGTH = 280;

/**
 * ARCHON (I3): optional short bio, shown on the public profile.
 */
const ProfileBio = () => {
    const { t } = useTranslation();
    const { data } = useGetBioQuery();
    const [setBio, setState] = useSetBioMutation();
    const [bio, setBioValue] = useState('');

    useEffect(() => {
        if (data) {
            setBioValue(data.bio || '');
        }
    }, [data]);

    const onSave = async () => {
        try {
            const result = await setBio(bio || null).unwrap();

            if (result.success) {
                setBioValue(result.bio || '');
                toast.success(t('Bio saved'));
            } else {
                toast.danger(result.message || t('Could not save bio'));
            }
        } catch (err) {
            toast.danger(err?.data?.message || t('Could not save bio'));
        }
    };

    return (
        <Panel type='default' compactHeader title={t('Bio')}>
            <p className='mb-3 text-xs text-muted'>
                {t('Optional. Shown on your public profile.')}
            </p>
            <Label htmlFor='profileBio'>{t('Bio')}</Label>
            <textarea
                id='profileBio'
                className='w-full rounded-md border border-border/65 bg-surface-secondary/55 px-3 py-2 text-sm text-foreground focus:border-border/90 focus:outline-none dark:border-border/80 dark:bg-surface-secondary/85'
                rows={3}
                maxLength={BIO_MAX_LENGTH}
                placeholder={t('Tell other players a little about yourself')}
                value={bio}
                onChange={(event) => setBioValue(event.target.value)}
            />
            <div className='mt-1 text-right text-xs text-muted'>
                {bio.length}/{BIO_MAX_LENGTH}
            </div>
            <div className='mt-2'>
                <HeroButton
                    size='sm'
                    variant='primary'
                    isPending={setState.isLoading}
                    onPress={onSave}
                >
                    {t('Save Bio')}
                </HeroButton>
            </div>
        </Panel>
    );
};

ProfileBio.displayName = 'ProfileBio';

export default ProfileBio;
