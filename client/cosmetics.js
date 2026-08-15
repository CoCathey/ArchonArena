/**
 * ARCHON (N12): the pixels behind a cosmetic id.
 *
 * The server owns the catalogue - which cosmetics exist, and which tier
 * unlocks each one (`server/services/membership/cosmetics.js`). This file owns
 * only how an id is drawn, and knows nothing about tiers or capabilities: by
 * the time a selection reaches the client it has already been filtered against
 * what the account may use, so anything here is something the player is
 * entitled to see.
 *
 * That split is what keeps a cosmetic from becoming an injection surface.
 * Nothing a player submits is ever rendered as style - a stored value is a key
 * into the maps below, and a key that is not in them draws the default. The
 * single exception is the accent colour, which is a hex string the server has
 * already validated and lightened for readability, and which is passed as a
 * custom property rather than interpolated into a class name.
 */

/**
 * The site amber, used wherever an accent has not arrived - a name rendered
 * before its badge lookup lands, or a payload from a build that predates
 * cosmetics. It matches the `default` accent in the server catalogue and the
 * fallback in the CSS, so the three cannot disagree about what "no accent"
 * looks like.
 */
export const DEFAULT_ACCENT_HEX = '#f5c451';

/**
 * Banner art, keyed by the id the catalogue stores.
 *
 * These are purpose-built strips cropped from the game board art by
 * `scripts/generate-profile-banners.js`, not the board images themselves - the
 * board version of philophosaurus is 4.1MB, which is not a decoration, it is a
 * download. Cropped and re-encoded, every banner is between 13KB and 47KB.
 *
 * Globbed rather than imported one by one so that adding art is a file plus a
 * catalogue entry, with no edit here.
 */
const bannerAssets = import.meta.glob('./assets/img/banners/*.jpg', {
    eager: true,
    import: 'default'
});

export const BANNER_ART = Object.freeze(
    Object.fromEntries(
        Object.entries(bannerAssets).map(([file, url]) => [
            file.slice(file.lastIndexOf('/') + 1, -'.jpg'.length),
            url
        ])
    )
);

/**
 * Avatar frames. Each is a 2px ring drawn as a padded background behind the
 * avatar, so they share one structure and only the fill differs - `prismatic`
 * is the same shape with a spinning gradient (see `.cosmetic-frame-prismatic`
 * in styles/tailwind.css).
 */
export const FRAME_CLASS = Object.freeze({
    none: '',
    brass: 'cosmetic-frame cosmetic-frame-brass',
    aember: 'cosmetic-frame cosmetic-frame-aember',
    shadow: 'cosmetic-frame cosmetic-frame-shadow',
    verdant: 'cosmetic-frame cosmetic-frame-verdant',
    crimson: 'cosmetic-frame cosmetic-frame-crimson',
    prismatic: 'cosmetic-frame cosmetic-frame-prismatic'
});

/**
 * Name effects.
 *
 * Deliberately restrained, and none of them changes the size or weight of the
 * text: a leaderboard is a table of names, and an effect that makes one row
 * shout makes the other twenty-nine harder to read. The animated ones are
 * dropped under `prefers-reduced-motion`, in CSS rather than here, so it holds
 * for a page that renders a name without going through this file.
 */
export const NAME_EFFECT_CLASS = Object.freeze({
    none: '',
    glow: 'cosmetic-name cosmetic-name-glow',
    gradient: 'cosmetic-name cosmetic-name-gradient',
    shimmer: 'cosmetic-name cosmetic-name-shimmer'
});

/** A hex colour, or null for anything that is not one. */
const safeHex = (value) => (/^#[0-9a-f]{6}$/i.test(String(value || '')) ? String(value) : null);

/**
 * The custom property every cosmetic class reads.
 *
 * Passed as a variable rather than baked into a class because the accent is
 * per-player data: Tailwind cannot generate a class for a colour it has never
 * seen, and building one from a string at runtime is the thing this file
 * exists to avoid.
 *
 * @param {object} [cosmetics] a resolved selection from the server
 * @returns {object} a React style object
 */
export function accentStyle(cosmetics) {
    const hex = safeHex(cosmetics && cosmetics.accentHex);

    return hex ? { '--cosmetic-accent': hex } : {};
}

/** The class for a slot, falling back to the default for an unknown id. */
const classFor = (map, value) => map[value] || map.none;

export const frameClass = (cosmetics) => classFor(FRAME_CLASS, cosmetics && cosmetics.frame);
export const nameEffectClass = (cosmetics) =>
    classFor(NAME_EFFECT_CLASS, cosmetics && cosmetics.nameEffect);

/** The banner image for a selection, or null when there is none to draw. */
export function bannerArt(cosmetics) {
    const banner = cosmetics && cosmetics.banner;

    return (banner && BANNER_ART[banner]) || null;
}
