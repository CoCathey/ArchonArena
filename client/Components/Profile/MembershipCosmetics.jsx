import React from 'react';
import { useSelector } from 'react-redux';
import { useTranslation } from 'react-i18next';
import { toast } from '@heroui/react';
import { Link } from 'react-router-dom';

import PlayerName from '../Site/PlayerName';
import { cosmeticPreviewClass } from '../../cosmetics';
import { useGetMembershipCosmeticsQuery, useSetMembershipCosmeticsMutation } from '../../redux/api';

/**
 * ARCHON (N12): the cosmetics a membership unlocks.
 *
 * Everything else in Appearance is private - the board background and the card
 * size are settings for the player's own screen. These two are the opposite:
 * they are what OTHER people see, in the lobby, on a leaderboard row, in
 * standings. That is the entire point, and it is why the panel leads with a
 * live sample of the player's own name rather than with a list of colour names.
 *
 * Locked options are shown rather than hidden. This panel is where somebody
 * finds out that a membership changes something visible at all; a panel with
 * one row in it says nothing, and hiding the options would make the tier's
 * promise unverifiable from inside the product.
 *
 * Saved on selection like the other membership panels, not through the profile
 * form's Save button.
 */

const SlotOptions = ({ slot, chosen, onChoose, isSaving, t }) => (
    <div className='space-y-1.5'>
        <div>
            <div className='text-sm font-medium text-foreground'>{t(slot.label)}</div>
            <div className='text-xs text-muted'>{t(slot.description)}</div>
        </div>
        <div className='flex flex-wrap gap-1.5'>
            {slot.options.map((option) => {
                const selected = (chosen || slot.default) === option.id;

                return (
                    <button
                        className={[
                            'rounded border px-2 py-1 text-xs transition',
                            selected
                                ? 'border-accent bg-surface-secondary'
                                : 'border-border/70 bg-surface-secondary/40 hover:bg-surface-secondary',
                            option.locked ? 'cursor-not-allowed opacity-50' : ''
                        ].join(' ')}
                        disabled={option.locked || isSaving}
                        key={option.id}
                        title={
                            option.locked ? t('Included with Vault Master membership') : undefined
                        }
                        type='button'
                        onClick={() => onChoose(slot.slot, option.id)}
                    >
                        {/* The option drawn in its own treatment, so the choice
                            is made by looking rather than by reading. */}
                        <span className={cosmeticPreviewClass(slot.slot, option.id)}>
                            {t(option.label)}
                        </span>
                        {option.locked && <span className='ml-1 text-muted'>🔒</span>}
                    </button>
                );
            })}
        </div>
    </div>
);

const MembershipCosmetics = () => {
    const { t } = useTranslation();
    const user = useSelector((state) => state.account.user);
    const { data, isLoading } = useGetMembershipCosmeticsQuery();
    const [saveCosmetics, { isLoading: isSaving }] = useSetMembershipCosmeticsMutation();

    const slots = data?.slots || [];
    const chosen = data?.chosen || {};

    const onChoose = async (slot, id) => {
        try {
            const result = await saveCosmetics({ [slot]: id }).unwrap();

            if (result.refused?.length) {
                toast.danger(t('That option is not part of your membership'));
            }
        } catch {
            toast.danger(t('Could not save that choice'));
        }
    };

    if (isLoading) {
        return <p className='text-sm text-muted'>{t('Loading…')}</p>;
    }

    const anythingUnlocked = slots.some((slot) =>
        slot.options.some((option) => !option.locked && option.capability)
    );

    return (
        <div className='space-y-3'>
            <div>
                <div className='text-sm font-medium text-foreground'>
                    {t('How other people see you')}
                </div>
                <p className='m-0 mt-0.5 text-xs text-muted'>
                    {t(
                        'These appear next to your name everywhere it is shown — the lobby, ' +
                            'leaderboards, tournament standings and chat.'
                    )}
                </p>
            </div>

            {/* The live sample, drawn by the same component every other page
                uses - so this is what a stranger sees, not an approximation.
                Fed from `chosen` rather than the redux user because the API
                response is what updates on save; the user object refreshes only
                on the next auth round trip, and a sample that lags the switch
                you just flicked is worse than no sample. */}
            <div className='rounded border border-border/60 bg-surface-secondary/30 px-3 py-2'>
                <PlayerName
                    cosmetics={chosen}
                    tier={user?.membership?.tier}
                    tierName={user?.membership?.tierName}
                    username={user?.username}
                />
            </div>

            {slots.map((slot) => (
                <SlotOptions
                    chosen={chosen[slot.slot]}
                    isSaving={isSaving}
                    key={slot.slot}
                    onChoose={onChoose}
                    slot={slot}
                    t={t}
                />
            ))}

            {!anythingUnlocked && (
                <p className='m-0 text-xs text-muted'>
                    {t('Nameplates and key finishes are part of Vault Master membership.')}{' '}
                    <Link className='text-accent hover:underline' to='/membership'>
                        {t('See what membership includes')}
                    </Link>
                </p>
            )}
        </div>
    );
};

MembershipCosmetics.displayName = 'MembershipCosmetics';

export default MembershipCosmetics;
