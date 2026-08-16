import React, { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useSelector } from 'react-redux';
import { useNavigate } from 'react-router-dom';
import { Button as HeroButton, toast } from '@heroui/react';

import Avatar from '../Site/Avatar';
import PlayerBadge from '../Site/PlayerBadge';
import { LockGlyph } from '../Membership/PremiumLock';
import { DEFAULT_ACCENT_HEX, accentStyle, bannerArt, nameEffectClass } from '../../cosmetics';
import { tierOf } from '../../membership';
import {
    useGetCosmeticsQuery,
    useGetMembershipCatalogQuery,
    useSetCosmeticsMutation
} from '../../redux/api';

/**
 * ARCHON (N12): Profile → Appearance → how your profile looks.
 *
 * This is what `profile_cosmetics` (Supporter) and `enhanced_cosmetics` (Vault
 * Master) buy. Both were being sold before anything existed to sell: the only
 * customisation on the site was the game board background, which is free.
 *
 * ## Locked options are shown, not hidden
 *
 * Every option in the catalogue is rendered for every account, with the ones
 * above their tier marked. A picker that quietly has four swatches instead of
 * sixteen tells a free player nothing, and the whole argument for a paid tier
 * is made by seeing the thing you would get. Same reasoning as `PremiumLock`,
 * applied at the level of a single swatch.
 *
 * ## The preview is the point
 *
 * Cosmetics are the one setting where "save and go and look" is a bad loop -
 * you cannot see your own profile the way other people do without leaving the
 * page. So the preview above the pickers is built from the same components the
 * public profile uses (`Avatar`, `PlayerBadge`, the cosmetic classes) and
 * updates as you click, before anything is saved.
 *
 * ## Everything here is decoration
 *
 * Per the supporter-perks rule: no cosmetic touches Amber, matchmaking,
 * tournament eligibility or any other competitive outcome. The worst a
 * hand-edited client achieves is a locked swatch that the server refuses on
 * save - `sanitizeCosmetics` names the slot and stores nothing.
 */

const SLOT_ORDER = ['accent', 'banner', 'frame', 'title', 'nameEffect', 'badgeFinish'];

/** The catalogue entry for a slot, or undefined. */
const slotFrom = (catalog, id) => (catalog || []).find((slot) => slot.id === id);

/** The colour a selection resolves to, palette id or custom hex alike. */
function accentHexFor(catalog, value) {
    if (typeof value === 'string' && value.startsWith('#')) {
        return value;
    }

    const accents = slotFrom(catalog, 'accent');
    const option = (accents?.options || []).find((candidate) => candidate.id === value);

    return option?.hex || DEFAULT_ACCENT_HEX;
}

/**
 * The words a title id stands for.
 *
 * The editor holds raw ids - that is what it edits and what it saves - while a
 * public profile is served the label already resolved. The preview is showing
 * the public version, so it has to do that resolution itself; without it the
 * preview reads `vault_diver` where the profile will read "Vault Diver".
 */
function titleLabelFor(catalog, value) {
    if (!value || value === 'none') {
        return null;
    }

    const titles = slotFrom(catalog, 'title');

    return (titles?.options || []).find((candidate) => candidate.id === value)?.label || null;
}

/**
 * The tier that unlocks a capability, from the membership catalogue.
 *
 * Derived rather than hardcoded, so moving cosmetics between tiers changes
 * every prompt on this page with no edit here.
 */
function useTierNameFor() {
    const { data: catalog } = useGetMembershipCatalogQuery();

    return (capability) => {
        if (!capability) {
            return null;
        }

        // The cheapest tier that includes it - tiers are cumulative, so the
        // first match by rank is the one worth naming.
        const tier = [...(catalog?.tiers || [])]
            .sort((a, b) => a.rank - b.rank)
            .find((candidate) => (candidate.capabilities || []).includes(capability));

        return tier?.name || null;
    };
}

/**
 * One selectable option.
 *
 * A locked option is a real button rather than a disabled one: it is still
 * focusable, still says what it is, and pressing it goes to the membership
 * page. A disabled control that does nothing when you press it is the version
 * that reads as broken.
 */
const OptionTile = ({ option, selected, locked, tierName, onSelect, onLocked, children, t }) => (
    <button
        aria-checked={selected}
        aria-label={
            locked && tierName
                ? t('{{label}} (needs {{tier}})', { label: option.label, tier: tierName })
                : option.label
        }
        className={`group relative rounded-md border p-1 text-left transition ${
            selected
                ? 'border-2 border-accent bg-accent/12'
                : 'border border-border/70 bg-surface-secondary/45 hover:border-border-tertiary hover:bg-surface-secondary/70'
        } ${locked ? 'opacity-60 hover:opacity-100' : ''}`}
        role='radio'
        type='button'
        onClick={() => (locked ? onLocked(option) : onSelect(option.id))}
    >
        {children}
        <span className='mt-1 flex items-center justify-center gap-1 text-center text-[11px] leading-tight text-muted'>
            {locked && <LockGlyph className='h-3 w-3 shrink-0' />}
            <span className='truncate'>{option.label}</span>
        </span>
    </button>
);

const ProfileCosmetics = () => {
    const { t } = useTranslation();
    const navigate = useNavigate();
    const user = useSelector((state) => state.account.user);
    const { data, isFetching } = useGetCosmeticsQuery();
    const [setCosmetics, saveState] = useSetCosmeticsMutation();
    const tierNameFor = useTierNameFor();

    const [draft, setDraft] = useState(null);

    useEffect(() => {
        if (data?.cosmetics) {
            setDraft(data.cosmetics);
        }
    }, [data]);

    const catalog = data?.catalog;
    const selection = draft || data?.cosmetics;

    // What the preview draws: the draft, plus the colour it resolves to. The
    // server sends the same shape for a saved selection, so the preview and
    // the public profile are rendering identical input.
    const preview = useMemo(
        () => ({
            ...(selection || {}),
            accentHex: accentHexFor(catalog, selection?.accent),
            titleLabel: titleLabelFor(catalog, selection?.title)
        }),
        [catalog, selection]
    );

    const dirty = useMemo(() => {
        if (!draft || !data?.cosmetics) {
            return false;
        }

        return SLOT_ORDER.some((slot) => draft[slot] !== data.cosmetics[slot]);
    }, [draft, data]);

    if (isFetching && !data) {
        return <div className='py-6 text-center text-sm text-muted'>{t('Loading…')}</div>;
    }

    if (!catalog) {
        return null;
    }

    const choose = (slot, value) => setDraft({ ...(selection || {}), [slot]: value });

    const onLocked = (option) => {
        const tierName = tierNameFor(option.capability);

        toast.info(
            tierName
                ? t('{{label}} is part of {{tier}}.', { label: option.label, tier: tierName })
                : t('{{label}} is part of Archon Arena membership.', { label: option.label })
        );
    };

    const onSave = async () => {
        try {
            const result = await setCosmetics(
                Object.fromEntries(SLOT_ORDER.map((slot) => [slot, selection[slot]]))
            ).unwrap();

            if (result.success) {
                toast.success(t('Profile appearance saved'));
            } else {
                toast.danger(result.message || t('Could not save your profile appearance'));
            }
        } catch (err) {
            toast.danger(err?.data?.message || t('Could not save your profile appearance'));
        }
    };

    // Nothing at all unlocked: say so once, at the top, instead of on each of
    // the fifty swatches below it.
    const anythingUnlocked = catalog.some((slot) =>
        slot.options.some((option) => !option.locked && option.id !== slot.default)
    );

    return (
        <div className='w-full border-t border-border/70 pt-3'>
            <div className='mb-2 flex items-center justify-between gap-3'>
                <div>
                    <div className='text-sm font-medium text-foreground'>
                        {t('Profile Appearance')}
                    </div>
                    <p className='m-0 text-xs text-muted'>
                        {t('How your profile and your name look to other players.')}
                    </p>
                </div>
                <HeroButton
                    isDisabled={!dirty || saveState.isLoading || !anythingUnlocked}
                    isPending={saveState.isLoading}
                    size='sm'
                    variant='primary'
                    onPress={onSave}
                >
                    {t('Save Appearance')}
                </HeroButton>
            </div>

            {!anythingUnlocked && (
                <div className='mb-3 flex flex-wrap items-center gap-2 rounded-md border border-border/70 bg-surface-secondary/45 px-3 py-2'>
                    <LockGlyph className='h-4 w-4 shrink-0 text-amber-300' />
                    <span className='text-xs text-muted'>
                        {t(
                            'Profile customisation is part of membership. Everything below is shown so you can see what it looks like.'
                        )}
                    </span>
                    <HeroButton size='sm' variant='primary' onPress={() => navigate('/membership')}>
                        {t('See membership')}
                    </HeroButton>
                </div>
            )}

            <CosmeticPreview cosmetics={preview} t={t} user={user} />

            <div className='mt-3 space-y-4'>
                {SLOT_ORDER.map((slotId) => {
                    const slot = slotFrom(catalog, slotId);

                    if (!slot) {
                        return null;
                    }

                    return (
                        <fieldset key={slot.id} className='m-0 border-0 p-0'>
                            <legend className='mb-1 p-0 text-xs font-medium tracking-wide text-foreground'>
                                {t(slot.label)}
                            </legend>
                            <p className='mb-2 mt-0 text-[11px] text-muted'>
                                {t(slot.description)}
                            </p>
                            <div
                                aria-label={t(slot.label)}
                                className={
                                    slot.id === 'title'
                                        ? 'flex flex-wrap gap-2'
                                        : 'grid grid-cols-3 gap-2 sm:grid-cols-4 lg:grid-cols-6'
                                }
                                role='radiogroup'
                            >
                                {slot.options.map((option) => (
                                    <OptionTile
                                        key={option.id}
                                        locked={option.locked}
                                        onLocked={onLocked}
                                        onSelect={(value) => choose(slot.id, value)}
                                        option={option}
                                        selected={selection?.[slot.id] === option.id}
                                        t={t}
                                        tierName={tierNameFor(option.capability)}
                                    >
                                        <OptionSwatch
                                            accentHex={preview.accentHex}
                                            option={option}
                                            slotId={slot.id}
                                            tier={tierOf(user)}
                                            username={user?.username}
                                        />
                                    </OptionTile>
                                ))}
                            </div>
                            {slot.id === 'accent' && slot.custom && (
                                <CustomAccent
                                    hex={preview.accentHex}
                                    isCustom={String(selection?.accent || '').startsWith('#')}
                                    locked={slot.custom.locked}
                                    onLocked={() =>
                                        onLocked({
                                            label: t('A custom colour'),
                                            capability: slot.custom.capability
                                        })
                                    }
                                    onPick={(value) => choose('accent', value)}
                                    t={t}
                                    tierName={tierNameFor(slot.custom.capability)}
                                />
                            )}
                        </fieldset>
                    );
                })}
            </div>
        </div>
    );
};

/**
 * The thing being edited, drawn the way other people will see it.
 *
 * Uses the real `Avatar` and `PlayerBadge` rather than a mock-up, so the
 * preview cannot drift from the profile it is previewing.
 */
const CosmeticPreview = ({ cosmetics, user, t }) => {
    const art = bannerArt(cosmetics);

    return (
        <div
            className='overflow-hidden rounded-md border border-border/70'
            style={accentStyle(cosmetics)}
        >
            <div
                className='relative h-20 bg-surface-secondary/60'
                style={
                    art
                        ? {
                              backgroundImage: `url(${art})`,
                              backgroundSize: 'cover',
                              backgroundPosition: 'center'
                          }
                        : {
                              backgroundImage:
                                  'linear-gradient(120deg, color-mix(in srgb, var(--cosmetic-accent) 35%, transparent), transparent)'
                          }
                }
            >
                <div className='absolute inset-x-0 bottom-0 h-10 bg-gradient-to-t from-surface to-transparent' />
            </div>
            <div
                className='flex items-center gap-3 border-t-2 px-3 pb-3 pt-2'
                style={{ borderTopColor: 'var(--cosmetic-accent)' }}
            >
                <Avatar cosmetics={cosmetics} imgPath={user?.avatar} />
                <div className='min-w-0'>
                    <div className='flex items-center gap-1.5 text-base'>
                        <span className={`font-semibold ${nameEffectClass(cosmetics)}`}>
                            {user?.username || t('Your name')}
                        </span>
                        <PlayerBadge
                            cosmetics={cosmetics}
                            tier={tierOf(user)}
                            tierName={user?.membership?.tierName}
                        />
                    </div>
                    {cosmetics.titleLabel ? (
                        <div
                            className='text-xs font-medium'
                            style={{ color: 'var(--cosmetic-accent)' }}
                        >
                            {cosmetics.titleLabel}
                        </div>
                    ) : (
                        <div className='text-xs text-muted'>{t('Preview')}</div>
                    )}
                </div>
            </div>
        </div>
    );
};

/** The visual for one option, which differs per slot. */
const OptionSwatch = ({ slotId, option, accentHex, username, tier }) => {
    if (slotId === 'accent') {
        return (
            <span
                className='block h-8 w-full rounded'
                style={{ backgroundColor: option.hex || DEFAULT_ACCENT_HEX }}
            />
        );
    }

    if (slotId === 'banner') {
        const art = bannerArt({ banner: option.id });

        return art ? (
            <img alt='' className='h-8 w-full rounded object-cover' src={art} />
        ) : (
            <span className='block h-8 w-full rounded bg-surface-secondary/70' />
        );
    }

    if (slotId === 'frame') {
        return (
            <span
                className='flex h-8 items-center justify-center'
                style={{ '--cosmetic-accent': accentHex }}
            >
                <Avatar cosmetics={{ frame: option.id, accentHex }} imgPath={null} />
            </span>
        );
    }

    if (slotId === 'nameEffect') {
        return (
            <span
                className='flex h-8 items-center justify-center overflow-hidden'
                style={{ '--cosmetic-accent': accentHex }}
            >
                <span
                    className={`truncate text-sm font-semibold ${nameEffectClass({
                        nameEffect: option.id
                    })}`}
                >
                    {username || 'Archon'}
                </span>
            </span>
        );
    }

    if (slotId === 'badgeFinish') {
        // The real badge, at the tier the viewer actually holds - a finish
        // previewed on a tier they do not have would be a preview of somebody
        // else's key.
        return (
            <span className='flex h-8 items-center justify-center text-lg'>
                <PlayerBadge cosmetics={{ badgeFinish: option.id }} tier={tier} />
            </span>
        );
    }

    // Titles are words; a swatch would say less than the label already does.
    return null;
};

/**
 * Any colour you like - the Vault Master half of the accent slot.
 *
 * A native colour input rather than a hex field: it is the one control every
 * platform already ships an accessible picker for. The value is validated and,
 * if it is too dark to read on the board, lightened server-side before it is
 * stored - so the swatch here can differ slightly from what is saved, which is
 * why the saved value is what the preview re-reads.
 */
const CustomAccent = ({ hex, isCustom, locked, tierName, onPick, onLocked, t }) => (
    <div className='mt-2 flex flex-wrap items-center gap-2'>
        <label
            className={`flex items-center gap-2 text-xs ${
                locked ? 'text-muted' : 'text-foreground'
            }`}
            htmlFor='cosmeticCustomAccent'
        >
            {locked && <LockGlyph className='h-3 w-3' />}
            {t('Custom colour')}
        </label>
        <input
            aria-label={t('Custom accent colour')}
            className={`h-7 w-12 cursor-pointer rounded border border-border/70 bg-transparent p-0.5 ${
                locked ? 'cursor-not-allowed opacity-60' : ''
            }`}
            disabled={locked}
            id='cosmeticCustomAccent'
            type='color'
            value={hex}
            onChange={(event) => onPick(event.target.value.toLowerCase())}
        />
        {isCustom && !locked && (
            <span className='text-[11px] uppercase tracking-wide text-muted'>{hex}</span>
        )}
        {locked && (
            <button
                className='text-[11px] text-muted underline decoration-dotted underline-offset-2 hover:text-foreground'
                type='button'
                onClick={onLocked}
            >
                {tierName ? t('Part of {{tier}}', { tier: tierName }) : t('Part of membership')}
            </button>
        )}
    </div>
);

ProfileCosmetics.displayName = 'ProfileCosmetics';

export default ProfileCosmetics;
