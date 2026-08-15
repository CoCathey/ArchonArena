const { CAPABILITIES } = require('./capabilities');

/**
 * ARCHON (N12): the catalogue of profile cosmetics, and the one place that
 * says which tier unlocks which one.
 *
 * `profile_cosmetics` and `enhanced_cosmetics` were both sold and neither was
 * built - Supporter promised "customise how your profile looks" and the only
 * customisation on the site was the game board background, which is free. This
 * file is what those two capabilities now buy.
 *
 * ## Why a catalogue rather than a column per cosmetic
 *
 * Every cosmetic is the same shape: a slot, a closed set of options, and a
 * capability per option. Writing that down once means adding "profile border"
 * next year is an entry in this file plus a presentation mapping on the client
 * - not a migration, an endpoint, a validator and a settings row.
 *
 * ## Why the server owns ids and the client owns pixels
 *
 * The values stored and validated here are **identifiers**, never CSS. A
 * selection is a member of a set this file defines; the client maps that id to
 * a colour, an image or a class (`client/cosmetics.js`). Nothing a player
 * submits is ever rendered as style, so a cosmetic cannot become an injection
 * surface, and an id the client does not recognise degrades to the default
 * instead of drawing something arbitrary.
 *
 * The one exception is a custom accent colour, which IS the data - it is
 * restricted to `#rrggbb`, and lightened if it is too dark to read (see
 * `normalizeAccentHex`).
 *
 * ## What happens when a membership lapses
 *
 * Nothing is deleted. `resolveCosmetics` filters a stored selection against
 * what the account may currently use, so a lapsed Vault Master's prismatic
 * frame stops rendering on the day their pledge lapses - the same rule the
 * badge follows - and comes back exactly as they left it if they resubscribe.
 * Deleting the selection would punish someone for pausing a pledge, and
 * rendering it forever would sell it once.
 */

/** The slots a player can set. Ids are the wire/DB field names. */
const SLOTS = Object.freeze({
    ACCENT: 'accent',
    BANNER: 'banner',
    FRAME: 'frame',
    TITLE: 'title',
    NAME_EFFECT: 'nameEffect'
});

const SUPPORTER = CAPABILITIES.PROFILE_COSMETICS;
const ENHANCED = CAPABILITIES.ENHANCED_COSMETICS;

/**
 * Accent colour: the tint used for the profile header, the panel edges and any
 * cosmetic that says "in your accent colour".
 *
 * Hex values live here rather than on the client because the accent is data -
 * a profile payload carries the resolved colour so a page can render it
 * without shipping a copy of this table - and because a locked palette is what
 * keeps the free-form option (Vault Master) from being the only way to get a
 * colour that reads on a dark board.
 */
const ACCENTS = [
    { id: 'default', label: 'Aember', hex: '#f5c451', capability: null },
    { id: 'brobnar', label: 'Brobnar', hex: '#e05a3b', capability: SUPPORTER },
    { id: 'dis', label: 'Dis', hex: '#b45cd6', capability: SUPPORTER },
    { id: 'ekwidon', label: 'Ekwidon', hex: '#e0a13c', capability: SUPPORTER },
    { id: 'geistoid', label: 'Geistoid', hex: '#7f8fd8', capability: SUPPORTER },
    { id: 'logos', label: 'Logos', hex: '#4aa3e8', capability: SUPPORTER },
    { id: 'mars', label: 'Mars', hex: '#4fbf8b', capability: SUPPORTER },
    { id: 'ouboros', label: 'Ouboros', hex: '#c7ccd4', capability: SUPPORTER },
    { id: 'redemption', label: 'Redemption', hex: '#f0e3b8', capability: SUPPORTER },
    { id: 'sanctum', label: 'Sanctum', hex: '#e8c76a', capability: SUPPORTER },
    { id: 'saurian', label: 'Saurian', hex: '#6fc3a8', capability: SUPPORTER },
    { id: 'shadows', label: 'Shadows', hex: '#9aa3b5', capability: SUPPORTER },
    { id: 'skyborn', label: 'Skyborn', hex: '#7fd3f0', capability: SUPPORTER },
    { id: 'staralliance', label: 'Star Alliance', hex: '#5b8def', capability: SUPPORTER },
    { id: 'unfathomable', label: 'Unfathomable', hex: '#5fbfc4', capability: SUPPORTER },
    { id: 'untamed', label: 'Untamed', hex: '#7fc75a', capability: SUPPORTER }
];

/**
 * Profile banner. Ids are existing background art (`client/assets/img/bgs`),
 * so this ships without a single new image - the art is already in the bundle
 * for the game board, at a size that crops well into a header strip.
 */
const BANNERS = [
    { id: 'none', label: 'None', capability: null },
    { id: 'brobnar', label: 'Brobnar', capability: SUPPORTER },
    { id: 'dis', label: 'Dis', capability: SUPPORTER },
    { id: 'ekwidon', label: 'Ekwidon', capability: SUPPORTER },
    { id: 'geistoid', label: 'Geistoid', capability: SUPPORTER },
    { id: 'logos', label: 'Logos', capability: SUPPORTER },
    { id: 'mars', label: 'Mars', capability: SUPPORTER },
    { id: 'ouboros', label: 'Ouboros', capability: SUPPORTER },
    { id: 'redemption', label: 'Redemption', capability: SUPPORTER },
    { id: 'sanctum', label: 'Sanctum', capability: SUPPORTER },
    { id: 'saurian', label: 'Saurian', capability: SUPPORTER },
    { id: 'shadows', label: 'Shadows', capability: SUPPORTER },
    { id: 'skyborn', label: 'Skyborn', capability: SUPPORTER },
    { id: 'staralliance', label: 'Star Alliance', capability: SUPPORTER },
    { id: 'unfathomable', label: 'Unfathomable', capability: SUPPORTER },
    { id: 'untamed', label: 'Untamed', capability: SUPPORTER },
    // Set and card art rather than a house identity - the three backgrounds
    // that are not one of the fifteen houses.
    { id: 'keyforge', label: 'KeyForge', capability: ENHANCED },
    { id: 'massmutation', label: 'Mass Mutation', capability: ENHANCED },
    { id: 'philophosaurus', label: 'Philophosaurus', capability: ENHANCED }
];

/** Ring drawn around the avatar, wherever an avatar appears. */
const FRAMES = [
    { id: 'none', label: 'None', capability: null },
    { id: 'brass', label: 'Brass', capability: SUPPORTER },
    { id: 'aember', label: 'Aember', capability: SUPPORTER },
    { id: 'shadow', label: 'Shadow', capability: SUPPORTER },
    { id: 'verdant', label: 'Verdant', capability: SUPPORTER },
    { id: 'crimson', label: 'Crimson', capability: SUPPORTER },
    // Follows the accent colour rather than a fixed one, and animates.
    { id: 'prismatic', label: 'Prismatic', capability: ENHANCED }
];

/**
 * A short flair line under the name on a profile.
 *
 * Curated rather than free text, deliberately. A bio is already a moderated
 * free-text field with a report button on it; a second one would double that
 * surface for a line of flavour, and a title that has to be reviewed is a
 * title that cannot be shown immediately. A closed list needs no moderation at
 * all, so a new member's title is live the moment they pick it.
 */
const TITLES = [
    { id: 'none', label: 'None', capability: null },
    { id: 'archon_adept', label: 'Archon Adept', capability: SUPPORTER },
    { id: 'vault_diver', label: 'Vault Diver', capability: SUPPORTER },
    { id: 'key_forger', label: 'Key Forger', capability: SUPPORTER },
    { id: 'aember_baron', label: 'Aember Baron', capability: SUPPORTER },
    { id: 'chain_breaker', label: 'Chain Breaker', capability: SUPPORTER },
    { id: 'deck_tinkerer', label: 'Deck Tinkerer', capability: SUPPORTER },
    { id: 'house_loyalist', label: 'House Loyalist', capability: SUPPORTER },
    { id: 'reap_and_repeat', label: 'Reap and Repeat', capability: SUPPORTER },
    { id: 'friendly_local', label: 'Friendly Local', capability: SUPPORTER },
    { id: 'table_captain', label: 'Table Captain', capability: SUPPORTER },
    { id: 'first_turn_forger', label: 'First-Turn Forger', capability: ENHANCED },
    { id: 'keeper_of_the_vault', label: 'Keeper of the Vault', capability: ENHANCED }
];

/**
 * How the name is drawn next to the badge, everywhere names appear.
 *
 * `glow` and above are deliberately restrained: a leaderboard is a table of
 * names, and a cosmetic that makes one row shout makes the other twenty-nine
 * harder to read. Nothing here changes the size or weight of the text, and the
 * animated options are dropped entirely under `prefers-reduced-motion`.
 */
const NAME_EFFECTS = [
    { id: 'none', label: 'None', capability: null },
    { id: 'glow', label: 'Glow', capability: SUPPORTER },
    { id: 'gradient', label: 'Gradient', capability: ENHANCED },
    { id: 'shimmer', label: 'Shimmer', capability: ENHANCED }
];

const SLOT_CATALOG = Object.freeze({
    [SLOTS.ACCENT]: {
        id: SLOTS.ACCENT,
        label: 'Accent colour',
        description: 'Tints your profile header, your title and any cosmetic that follows it.',
        default: 'default',
        options: ACCENTS,
        // The only slot that also takes a value outside its option list.
        customCapability: ENHANCED
    },
    [SLOTS.BANNER]: {
        id: SLOTS.BANNER,
        label: 'Profile banner',
        description: 'The strip of art across the top of your public profile.',
        default: 'none',
        options: BANNERS
    },
    [SLOTS.FRAME]: {
        id: SLOTS.FRAME,
        label: 'Avatar frame',
        description: 'A ring around your avatar, wherever it appears.',
        default: 'none',
        options: FRAMES
    },
    [SLOTS.TITLE]: {
        id: SLOTS.TITLE,
        label: 'Title',
        description: 'A short line under your name on your profile.',
        default: 'none',
        options: TITLES
    },
    [SLOTS.NAME_EFFECT]: {
        id: SLOTS.NAME_EFFECT,
        label: 'Name effect',
        description: 'How your name is drawn in lobbies, leaderboards and chat.',
        default: 'none',
        options: NAME_EFFECTS
    }
});

const SLOT_IDS = Object.freeze(Object.keys(SLOT_CATALOG));

/** Bio length at each level. The free limit is what the field shipped with. */
const BIO_LENGTHS = Object.freeze({ free: 280, supporter: 1000 });

/**
 * How long a bio this account may save.
 *
 * Only *saving* is capped. An existing longer bio keeps rendering after a
 * membership lapses - it was written legitimately, and truncating somebody's
 * words to sell them back is not a cosmetic.
 *
 * @param {string[]} capabilities
 * @returns {number}
 */
function bioMaxLength(capabilities) {
    return holds(capabilities, SUPPORTER) ? BIO_LENGTHS.supporter : BIO_LENGTHS.free;
}

function holds(capabilities, capability) {
    if (!capability) {
        return true;
    }

    return Array.isArray(capabilities) && capabilities.includes(capability);
}

/** The default selection: what every account renders as before it chooses. */
function defaultCosmetics() {
    const defaults = {};

    for (const slot of SLOT_IDS) {
        defaults[slot] = SLOT_CATALOG[slot].default;
    }

    return defaults;
}

const HEX_PATTERN = /^#[0-9a-f]{6}$/i;

/**
 * A custom accent, made readable.
 *
 * Accents are drawn as text and as thin borders on a dark surface, so a very
 * dark custom colour renders as an invisible name on somebody's own profile -
 * they picked it, but they cannot see that it did not work. Rather than
 * refusing dark colours (a colour picker that rejects a third of its own range
 * is a bug report), the hue is kept and the lightness is raised to the floor
 * the palette itself sits at.
 *
 * @param {string} value
 * @returns {string|null} `#rrggbb`, or null if it is not a hex colour
 */
function normalizeAccentHex(value) {
    const hex = String(value || '').trim();

    if (!HEX_PATTERN.test(hex)) {
        return null;
    }

    const channels = [1, 3, 5].map((offset) => parseInt(hex.slice(offset, offset + 2), 16));
    // Rec. 709 luma, which is close enough to perceived brightness for a
    // readability floor and does not need a colour library.
    const luma = (0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2]) / 255;
    const FLOOR = 0.45;

    if (luma >= FLOOR) {
        return `#${channels.map((c) => c.toString(16).padStart(2, '0')).join('')}`.toLowerCase();
    }

    // Mix toward white by however far short of the floor it fell. Pure black
    // has no hue to keep, so it lands on the same grey any near-black would.
    const mix = luma <= 0 ? FLOOR : Math.min(1, (FLOOR - luma) / (1 - luma));
    const lightened = channels.map((channel) => Math.round(channel + (255 - channel) * mix));

    return `#${lightened.map((c) => c.toString(16).padStart(2, '0')).join('')}`;
}

/**
 * The option a stored value refers to, or undefined.
 *
 * @param {string} slot
 * @param {string} value
 */
function optionFor(slot, value) {
    const catalog = SLOT_CATALOG[slot];

    return catalog && catalog.options.find((option) => option.id === value);
}

/**
 * May this account use this value in this slot?
 *
 * @param {string} slot
 * @param {string} value
 * @param {string[]} capabilities
 * @returns {boolean}
 */
function canUse(slot, value, capabilities) {
    const catalog = SLOT_CATALOG[slot];

    if (!catalog || value === undefined || value === null || value === '') {
        return false;
    }

    if (slot === SLOTS.ACCENT && String(value).startsWith('#')) {
        return !!normalizeAccentHex(value) && holds(capabilities, catalog.customCapability);
    }

    const option = optionFor(slot, value);

    return !!option && holds(capabilities, option.capability);
}

/**
 * What to DISPLAY for a stored selection.
 *
 * Silently falls back per slot, because this runs on every profile view and on
 * every list of names: a lapsed member's page must render, just without the
 * parts they are no longer paying for. Compare `sanitizeCosmetics`, which is
 * the save path and refuses instead.
 *
 * @param {object|null} stored
 * @param {string[]} capabilities the OWNER's capabilities, not the viewer's
 * @returns {{accent: string, accentHex: string, banner: string, frame: string,
 *            title: string, titleLabel: string|null, nameEffect: string}}
 */
function resolveCosmetics(stored, capabilities) {
    const resolved = defaultCosmetics();

    for (const slot of SLOT_IDS) {
        const value = stored && stored[slot];

        if (canUse(slot, value, capabilities)) {
            resolved[slot] = value;
        }
    }

    const accentHex = String(resolved.accent).startsWith('#')
        ? normalizeAccentHex(resolved.accent)
        : (optionFor(SLOTS.ACCENT, resolved.accent) || ACCENTS[0]).hex;

    const title = optionFor(SLOTS.TITLE, resolved.title);

    return {
        ...resolved,
        // Resolved server-side so a payload carries a usable colour and no
        // page has to ship the palette to look one up.
        accentHex,
        titleLabel: title && title.id !== 'none' ? title.label : null
    };
}

/**
 * Is a resolved selection the same as picking nothing?
 *
 * Used to keep default cosmetics out of list payloads - most accounts have
 * none, and sending `{accent:'default', banner:'none', ...}` per row would be
 * most of a leaderboard's response.
 */
function isDefaultCosmetics(cosmetics) {
    if (!cosmetics) {
        return true;
    }

    return SLOT_IDS.every((slot) => cosmetics[slot] === SLOT_CATALOG[slot].default);
}

/**
 * Validate a selection for SAVING.
 *
 * Rejects rather than defaults: on the save path, a locked or unknown value
 * means the request did not come from the editor this account was shown, and
 * quietly storing something other than what was sent is how a settings page
 * ends up lying about its own state.
 *
 * Slots that are absent from the input are left alone by the caller; slots
 * explicitly set to null or '' reset to their default, which is how "None" is
 * saved.
 *
 * @param {object} input
 * @param {string[]} capabilities
 * @returns {{cosmetics: object, rejected: string[]}}
 */
function sanitizeCosmetics(input, capabilities) {
    const cosmetics = {};
    const rejected = [];

    for (const slot of SLOT_IDS) {
        if (!input || !Object.prototype.hasOwnProperty.call(input, slot)) {
            continue;
        }

        const raw = input[slot];

        if (raw === null || raw === undefined || raw === '') {
            cosmetics[slot] = SLOT_CATALOG[slot].default;
            continue;
        }

        const value =
            slot === SLOTS.ACCENT && String(raw).startsWith('#')
                ? normalizeAccentHex(raw) || String(raw)
                : String(raw);

        if (!canUse(slot, value, capabilities)) {
            rejected.push(slot);
            continue;
        }

        cosmetics[slot] = value;
    }

    return { cosmetics, rejected };
}

/**
 * The catalogue as the editor renders it, with each option marked locked or
 * not for this account.
 *
 * Locked options are sent rather than hidden on purpose: "you could have this"
 * is the only thing on the page that earns an upgrade, and a picker that
 * simply has fewer swatches for a free account teaches them nothing.
 *
 * @param {string[]} capabilities
 */
function cosmeticsCatalog(capabilities) {
    return SLOT_IDS.map((slot) => {
        const catalog = SLOT_CATALOG[slot];

        return {
            id: catalog.id,
            label: catalog.label,
            description: catalog.description,
            default: catalog.default,
            custom: catalog.customCapability
                ? {
                      capability: catalog.customCapability,
                      locked: !holds(capabilities, catalog.customCapability)
                  }
                : null,
            options: catalog.options.map((option) => ({
                id: option.id,
                label: option.label,
                hex: option.hex || null,
                capability: option.capability || null,
                locked: !holds(capabilities, option.capability)
            }))
        };
    });
}

module.exports = {
    SLOTS,
    SLOT_IDS,
    SLOT_CATALOG,
    BIO_LENGTHS,
    bioMaxLength,
    defaultCosmetics,
    resolveCosmetics,
    sanitizeCosmetics,
    isDefaultCosmetics,
    cosmeticsCatalog,
    canUse,
    normalizeAccentHex
};
