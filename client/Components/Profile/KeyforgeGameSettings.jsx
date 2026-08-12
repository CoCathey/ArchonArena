import React from 'react';
import { useTranslation } from 'react-i18next';
import { Switch } from '@heroui/react';
import Panel from '../Site/Panel';

/**
 * @typedef { import('./Profile').ProfileDetails } ProfileDetails
 */
/**
 * @typedef KeyforgeGameSettingsProps
 * @property {import('formik').FormikProps<ProfileDetails>} formProps
 * @property {User} user
 */

/**
 * @param {KeyforgeGameSettingsProps} props
 */
const KeyforgeGameSettings = ({ formProps }) => {
    const { t } = useTranslation();

    const interactionOptions = [
        ['orderForcedAbilities', t('Prompt to order simultaneous abilities')],
        ['confirmOneClick', t('Show a prompt when initiating 1-click abilities')]
    ];
    const displayOptions = [
        ['useHalfSizedCards', t('Use half sized card images')],
        ['showAccolades', t('Show deck accolades')],
        // ARCHON: a comfort setting - your own hand can pull the eye while
        // there is nothing you can do with it. It comes straight back the
        // moment the game asks you anything, and one click looks anyway.
        ['hideHandOnOpponentTurn', t("Hide my hand during the opponent's turn")]
    ];

    const renderOption = ([id, text]) => (
        <Switch
            key={id}
            id={id}
            isSelected={formProps.values.gameOptions[id]}
            onChange={(isSelected) => formProps.setFieldValue(`gameOptions.${id}`, isSelected)}
            className='flex w-full cursor-pointer items-center justify-between gap-2 rounded bg-surface-secondary/70 px-2 py-1.5'
        >
            <span className='text-sm'>{text}</span>
            <Switch.Control>
                <Switch.Thumb />
            </Switch.Control>
        </Switch>
    );

    return (
        <div className='grid gap-3 lg:grid-cols-2'>
            <Panel type='default' compactHeader title={t('Interaction')}>
                <div className='grid gap-2'>
                    {interactionOptions.map((option) => renderOption(option))}
                </div>
            </Panel>
            <Panel type='default' compactHeader title={t('Display')}>
                <div className='grid gap-2'>
                    {displayOptions.map((option) => renderOption(option))}
                </div>
            </Panel>
        </div>
    );
};

export default KeyforgeGameSettings;
