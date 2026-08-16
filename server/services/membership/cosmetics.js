const { CAPABILITIES } = require('./capabilities');

/**
 * ARCHON (N12): the cosmetics catalogue - what a membership changes about how
 * an account LOOKS to other people.
 *
 * Vault Master sells "enhanced cosmetics". The only customisation that existed
 * when that line was written was the game board background, which is free and
 * which only the player themselves ever sees - so the tier was charging for
 * something that was neither enhanced nor, in any meaningful sense, cosmetic.
 *
 * What is here instead is deliberately public. A cosmetic nobody else can see
 * is a private preference; the thing people actually buy is the one that shows
 * up next to their name in the lobby, on a leaderboard row and on a tournament
 * standings table. So both slots below ride on the badge lookup every list
 * already does (BadgeService), and cost no extra request anywhere.
 *
 * ## Why ids and not classes
 *
 * The server sends an id. The client owns the class names (client/cosmetics.js),
 * for the mundane reason that Tailwind only emits classes it can see in the
 * source - a class string invented by an API is a class string that does not
 * exist in the stylesheet. Same split as the capability ids, for the same
 * reason: names are duplicated, meaning is not.
 *
 * ## Entitlement is checked twice, on purpose
 *
 * On save, so a hand-edited client cannot store a choice it has not paid for;
 * and again on read, so a lapsed membership stops rendering its cosmetic the
 * moment it lapses rather than whenever the account next saves. The stored row
 * is left alone in that case - a member who comes back gets their look back
 * without having to set it again.
 */

const COSMETIC_SLOTS = Object.freeze({
    NAMEPLATE: 'nameplate',
    BADGE_FINISH: 'badgeFinish'
});

/**
 * @typedef CosmeticOption
 * @property {string} id
 * @property {string} label
 * @property {string|null} capability the capability required, null if free
 */

/**
 * Every slot, and every option in it. The first option of a slot is its
 * default and must always be free - a slot whose default is paid for would
 * render as "locked" for the entire free tier, which is a downgrade wearing a
 * feature's clothes.
 */
const COSMETICS = Object.freeze({
    [COSMETIC_SLOTS.NAMEPLATE]: {
        label: 'Nameplate',
        description: 'The colour your name is drawn in wherever it appears.',
        options: [
            { id: 'tier', label: 'Tier colour', capability: null },
            { id: 'ember', label: 'Ember', capability: CAPABILITIES.ENHANCED_COSMETICS },
            { id: 'frost', label: 'Frost', capability: CAPABILITIES.ENHANCED_COSMETICS },
            { id: 'verdant', label: 'Verdant', capability: CAPABILITIES.ENHANCED_COSMETICS },
            { id: 'void', label: 'Void', capability: CAPABILITIES.ENHANCED_COSMETICS },
            { id: 'gilded', label: 'Gilded', capability: CAPABILITIES.ENHANCED_COSMETICS }
        ]
    },
    [COSMETIC_SLOTS.BADGE_FINISH]: {
        label: 'Key finish',
        description: 'How the membership key beside your name is drawn.',
        options: [
            { id: 'standard', label: 'Standard', capability: null },
            { id: 'etched', label: 'Etched', capability: CAPABILITIES.ENHANCED_COSMETICS },
            { id: 'radiant', label: 'Radiant', capability: CAPABILITIES.ENHANCED_COSMETICS }
        ]
    }
});

const SLOT_IDS = Object.keys(COSMETICS);

/** The free option every account falls back to. */
function defaultChoice(slot) {
    const definition = COSMETICS[slot];

    return definition ? definition.options[0].id : null;
}

/** @returns {CosmeticOption|undefined} */
function optionFor(slot, id) {
    const definition = COSMETICS[slot];

    return definition && definition.options.find((option) => option.id === id);
}

function holds(capabilities, capability) {
    return !capability || (Array.isArray(capabilities) && capabilities.includes(capability));
}

/** The capability list off an entitlements object, however it was handed over. */
function capabilitiesOf(entitlements) {
    if (Array.isArray(entitlements)) {
        return entitlements;
    }

    return (entitlements && entitlements.capabilities) || [];
}

/**
 * May this account choose this option right now?
 *
 * An unknown slot or option is false rather than an error: a cosmetic retired
 * between releases should stop applying, not break the profile page.
 */
function isAllowed(slot, id, entitlements) {
    const option = optionFor(slot, id);

    return !!option && holds(capabilitiesOf(entitlements), option.capability);
}

/**
 * What may actually be stored for this account.
 *
 * Unknown slots, unknown options, and options the account is not entitled to
 * are dropped rather than rejected: this runs on a settings save, and refusing
 * the whole request because one row is stale would lose the other change the
 * player made in the same click. The default choice is stored as an explicit
 * null so the caller can tell "set back to default" from "not mentioned".
 *
 * @param {Object<string,string>} choices
 * @param {object|string[]} entitlements
 * @returns {Object<string,string|null>} only the slots that were named
 */
function sanitiseCosmetics(choices, entitlements) {
    const result = {};

    for (const [slot, value] of Object.entries(choices || {})) {
        if (!COSMETICS[slot]) {
            continue;
        }

        const id = value === null || value === undefined ? null : String(value);

        if (id === null || id === defaultChoice(slot)) {
            result[slot] = null;
            continue;
        }

        if (isAllowed(slot, id, entitlements)) {
            result[slot] = id;
        }
    }

    return result;
}

/**
 * What other people should actually see, given what is stored and what the
 * account is entitled to TODAY.
 *
 * Slots resolving to their default are omitted rather than sent as 'tier' /
 * 'standard': this rides along on a public badge lookup that is deliberately
 * sparse, and a default is the absence of a choice.
 *
 * @param {Object<string,string>} stored
 * @param {object|string[]} entitlements
 * @returns {Object<string,string>|null} null when there is nothing to show
 */
function publicCosmetics(stored, entitlements) {
    const visible = {};

    for (const slot of SLOT_IDS) {
        const id = stored && stored[slot];

        if (!id || id === defaultChoice(slot)) {
            continue;
        }

        if (isAllowed(slot, id, entitlements)) {
            visible[slot] = id;
        }
    }

    return Object.keys(visible).length ? visible : null;
}

/**
 * The catalogue as the settings panel renders it: every option, with the ones
 * this account cannot use marked rather than hidden.
 *
 * Shown rather than hidden on purpose - the panel is where somebody finds out
 * that a membership changes something visible, and an empty panel says nothing
 * at all. It is one screen deep in their own settings, not an interstitial.
 */
function cosmeticCatalog(entitlements) {
    const capabilities = capabilitiesOf(entitlements);

    return SLOT_IDS.map((slot) => ({
        slot,
        label: COSMETICS[slot].label,
        description: COSMETICS[slot].description,
        default: defaultChoice(slot),
        options: COSMETICS[slot].options.map((option) => ({
            id: option.id,
            label: option.label,
            capability: option.capability || null,
            locked: !holds(capabilities, option.capability)
        }))
    }));
}

module.exports = {
    COSMETIC_SLOTS,
    COSMETICS,
    SLOT_IDS,
    defaultChoice,
    optionFor,
    isAllowed,
    sanitiseCosmetics,
    publicCosmetics,
    cosmeticCatalog
};
