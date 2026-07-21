import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button as HeroButton, Label, toast } from '@heroui/react';

import Panel from '../Components/Site/Panel';
import {
    useGetAdminSettingsQuery,
    useResetAdminSettingsMutation,
    useSaveAdminSettingsMutation
} from '../redux/api';

const inputClass =
    'w-full rounded-md border border-border/65 bg-surface-secondary/55 px-3 py-2 text-sm text-foreground focus:border-border/90 focus:outline-none dark:border-border/80 dark:bg-surface-secondary/85';

const getPath = (object, path) =>
    path.reduce((current, key) => (current === undefined ? undefined : current?.[key]), object);

const setPath = (object, path, value) => {
    const next = { ...object };
    let cursor = next;

    for (let index = 0; index < path.length - 1; index++) {
        cursor[path[index]] = { ...(cursor[path[index]] || {}) };
        cursor = cursor[path[index]];
    }

    cursor[path[path.length - 1]] = value;

    return next;
};

/**
 * One editable field driven by its registry descriptor. Values edit into
 * the section's draft override object; empty means "use default".
 */
const SettingField = ({ descriptor, path, draft, setDraft }) => {
    const { t } = useTranslation();
    const override = getPath(draft, path);
    const effective = override !== undefined ? override : descriptor.default;

    if (descriptor.type === 'boolean') {
        return (
            <label className='flex items-center gap-2 text-sm text-foreground'>
                <input
                    type='checkbox'
                    checked={!!effective}
                    onChange={(event) => setDraft(setPath(draft, path, event.target.checked))}
                />
                {t(descriptor.label)}
            </label>
        );
    }

    if (descriptor.type === 'number') {
        return (
            <div>
                <Label>{t(descriptor.label)}</Label>
                <input
                    type='number'
                    className={inputClass}
                    value={effective ?? ''}
                    min={descriptor.min}
                    max={descriptor.max}
                    step='any'
                    onChange={(event) =>
                        setDraft(setPath(draft, path, parseFloat(event.target.value)))
                    }
                />
            </div>
        );
    }

    if (descriptor.type === 'stringArray') {
        return (
            <div>
                <Label>{t(descriptor.label)}</Label>
                <div className='flex flex-wrap gap-3 pt-1'>
                    {(descriptor.allowed || []).map((option) => (
                        <label
                            key={option}
                            className='flex items-center gap-1.5 text-sm text-foreground'
                        >
                            <input
                                type='checkbox'
                                checked={(effective || []).includes(option)}
                                onChange={(event) => {
                                    const current = effective || [];
                                    const next = event.target.checked
                                        ? [...current, option]
                                        : current.filter((entry) => entry !== option);
                                    setDraft(setPath(draft, path, next));
                                }}
                            />
                            {option}
                        </label>
                    ))}
                </div>
            </div>
        );
    }

    if (descriptor.type === 'numberMap') {
        return (
            <div>
                <Label>{t(descriptor.label)}</Label>
                <div className='grid grid-cols-3 gap-2 pt-1'>
                    {(descriptor.keys || []).map((key) => (
                        <div key={key}>
                            <div className='text-xs text-muted'>{key}</div>
                            <input
                                type='number'
                                className={inputClass}
                                value={effective?.[key] ?? ''}
                                min={descriptor.min}
                                max={descriptor.max}
                                step='any'
                                onChange={(event) =>
                                    setDraft(
                                        setPath(
                                            draft,
                                            [...path, key],
                                            parseFloat(event.target.value)
                                        )
                                    )
                                }
                            />
                        </div>
                    ))}
                </div>
            </div>
        );
    }

    return null;
};

const renderFields = (fields, basePath, draft, setDraft) =>
    Object.entries(fields).map(([key, descriptor]) => {
        if (descriptor.type === 'section') {
            return (
                <div key={key} className='rounded-md border border-border/50 p-3'>
                    <div className='mb-2 text-sm font-semibold text-amber-300'>
                        {descriptor.label}
                    </div>
                    <div className='space-y-3'>
                        {renderFields(descriptor.fields, [...basePath, key], draft, setDraft)}
                    </div>
                </div>
            );
        }

        return (
            <SettingField
                key={key}
                descriptor={descriptor}
                path={[...basePath, key]}
                draft={draft}
                setDraft={setDraft}
            />
        );
    });

/**
 * ARCHON: runtime site settings editor (admin only). Values save as
 * overrides on top of code/file defaults; Reset reverts a whole section.
 */
const SettingsAdmin = () => {
    const { t } = useTranslation();
    const { data, isLoading, refetch } = useGetAdminSettingsQuery();
    const [saveSettings, saveState] = useSaveAdminSettingsMutation();
    const [resetSettings] = useResetAdminSettingsMutation();
    const [drafts, setDrafts] = useState({});

    useEffect(() => {
        if (data?.sections) {
            const next = {};
            for (const [key, section] of Object.entries(data.sections)) {
                next[key] = section.overrides || {};
            }
            setDrafts(next);
        }
    }, [data]);

    if (isLoading || !data?.sections) {
        return <div className='text-sm text-muted'>{t('Loading settings...')}</div>;
    }

    const onSave = async (sectionKey) => {
        try {
            const result = await saveSettings({
                section: sectionKey,
                value: drafts[sectionKey] || {}
            }).unwrap();

            if (result.success) {
                toast.success(t('Settings saved'));
                refetch();
            } else {
                toast.danger(result.message || t('Could not save settings'));
            }
        } catch {
            toast.danger(t('Could not save settings'));
        }
    };

    const onReset = async (sectionKey) => {
        try {
            const result = await resetSettings(sectionKey).unwrap();

            if (result.success) {
                toast.success(t('Settings reset to defaults'));
                refetch();
            } else {
                toast.danger(result.message || t('Could not reset settings'));
            }
        } catch {
            toast.danger(t('Could not reset settings'));
        }
    };

    return (
        <div className='mx-auto w-full max-w-3xl space-y-4'>
            {Object.entries(data.sections).map(([sectionKey, section]) => (
                <Panel key={sectionKey} title={t(section.title)}>
                    <p className='mb-3 text-xs text-muted'>{t(section.description)}</p>
                    <div className='space-y-3'>
                        {renderFields(section.fields, [], drafts[sectionKey] || {}, (next) =>
                            setDrafts((current) => ({ ...current, [sectionKey]: next }))
                        )}
                    </div>
                    <div className='mt-4 flex items-center gap-2'>
                        <HeroButton
                            size='sm'
                            variant='primary'
                            isPending={saveState.isLoading}
                            onPress={() => onSave(sectionKey)}
                        >
                            {t('Save')}
                        </HeroButton>
                        <HeroButton
                            size='sm'
                            variant='tertiary'
                            onPress={() => onReset(sectionKey)}
                        >
                            {t('Reset to defaults')}
                        </HeroButton>
                        {section.audit && (
                            <span className='ml-auto text-xs text-muted'>
                                {t('Last changed by {{user}}', {
                                    user: section.audit.updatedBy || t('unknown')
                                })}
                            </span>
                        )}
                    </div>
                </Panel>
            ))}
        </div>
    );
};

SettingsAdmin.displayName = 'SettingsAdmin';

export default SettingsAdmin;
