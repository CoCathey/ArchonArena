/**
 * ARCHON (N12): how a chosen cosmetic is actually drawn.
 *
 * The server owns the catalogue - which slots exist, which options are in them,
 * and which capability each requires (server/services/membership/cosmetics.js).
 * It sends ids. This file owns the appearance, and it has to, for a mundane
 * reason: Tailwind emits only the classes it can find written in the source, so
 * a class name invented by an API is a class name that is not in the stylesheet.
 * A cosmetic assembled server-side would render as no cosmetic at all.
 *
 * Same split as the capability ids in membership.js, and the same rule: the
 * names are duplicated, the decisions are not. Nothing here grants anything -
 * an id that arrives without entitlement was already dropped server-side, and
 * an id this build does not know falls back to the default.
 */

/** Mirrors COSMETIC_SLOTS on the server. */
export const COSMETIC_SLOTS = Object.freeze({
    NAMEPLATE: 'nameplate',
    BADGE_FINISH: 'badgeFinish'
});

/**
 * Nameplate colours.
 *
 * Chosen to stay legible on the dark surfaces names actually sit on - a table
 * row, a lobby seat, a chat line - and to remain distinguishable from the three
 * tier colours, which is what a player is choosing *away* from. Weight is fixed
 * at semibold across all of them so a nameplate never changes a row's rhythm.
 */
export const NAMEPLATE_CLASS = Object.freeze({
    ember: 'font-semibold text-orange-300',
    frost: 'font-semibold text-sky-300',
    verdant: 'font-semibold text-lime-300',
    void: 'font-semibold text-fuchsia-300',
    gilded: 'font-semibold text-yellow-200 drop-shadow-[0_0_4px_rgba(253,224,71,0.35)]'
});

/**
 * Key finishes, applied on top of the tier's own colour rather than replacing
 * it - the key says which tier, the finish is the personalisation, and losing
 * the first to express the second would make the badge mean less than it did.
 */
export const KEY_FINISH_CLASS = Object.freeze({
    etched: 'opacity-80',
    radiant: 'drop-shadow-[0_0_5px_currentColor]'
});

/**
 * The class for a player's name, or '' when they have made no choice.
 *
 * @param {object} [cosmetics] the `cosmetics` block from a badge lookup
 */
export function nameplateClass(cosmetics) {
    const choice = cosmetics && cosmetics[COSMETIC_SLOTS.NAMEPLATE];

    return (choice && NAMEPLATE_CLASS[choice]) || '';
}

/**
 * The extra class for the key glyph, or '' when they have made no choice.
 *
 * @param {object} [cosmetics]
 */
export function keyFinishClass(cosmetics) {
    const choice = cosmetics && cosmetics[COSMETIC_SLOTS.BADGE_FINISH];

    return (choice && KEY_FINISH_CLASS[choice]) || '';
}

/**
 * A swatch for the settings panel, so an option can be seen before it is
 * chosen. Deliberately the same class the real thing uses - a preview drawn
 * from a second palette is a preview that can be wrong.
 */
export function cosmeticPreviewClass(slot, id) {
    if (slot === COSMETIC_SLOTS.NAMEPLATE) {
        return NAMEPLATE_CLASS[id] || 'font-semibold text-foreground';
    }

    if (slot === COSMETIC_SLOTS.BADGE_FINISH) {
        return KEY_FINISH_CLASS[id] || '';
    }

    return '';
}
