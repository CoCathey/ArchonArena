/**
 * The game modes the lobby offers, mirroring client/Components/Games/
 * GameFormats.jsx. Unchained and Reversal are hidden from the UI on both
 * clients — the engine still supports them, they are just not offerable.
 */
export interface GameFormat {
    name: 'normal' | 'sealed' | 'adaptive-bo1' | 'alliance';
    label: string;
    hint: string;
}

export const GAME_FORMATS: GameFormat[] = [
    {
        name: 'normal',
        label: 'Archon',
        hint: 'Standard play with a deck from your collection.'
    },
    {
        name: 'sealed',
        label: 'Sealed',
        hint: 'Both players get a random deck from the sets you allow.'
    },
    {
        name: 'adaptive-bo1',
        label: 'Adaptive',
        hint: 'Chain handicaps even out a mismatch between decks.'
    },
    {
        name: 'alliance',
        label: 'Alliance',
        hint: 'Play a deck built from three houses of different decks.'
    }
];

export function formatLabel(name?: string): string {
    const format = GAME_FORMATS.find((entry) => entry.name === name);
    if (format) {
        return format.label;
    }
    return name ? name.replace(/-/g, ' ') : 'Archon';
}

/**
 * Expansions the sealed-deck generator understands, keyed as the newgame
 * payload expects (server/services/DeckService.js getSealedDeck). Newest
 * first — a player choosing sets is usually reaching for a recent one.
 */
export const EXPANSIONS: { name: string; label: string }[] = [
    { name: 'dm', label: 'Draconian Measures' },
    { name: 'cc', label: 'Crucible Clash' },
    { name: 'pv', label: 'Prophetic Visions' },
    { name: 'disc', label: 'Discovery' },
    { name: 'momu', label: 'More Mutation' },
    { name: 'toc', label: 'Tokens of Change' },
    { name: 'as', label: 'Æmber Skies' },
    { name: 'gr', label: 'Grim Reminders' },
    { name: 'woe', label: 'Winds of Exchange' },
    { name: 'dt', label: 'Dark Tidings' },
    { name: 'mm', label: 'Mass Mutation' },
    { name: 'wc', label: 'Worlds Collide' },
    { name: 'aoa', label: 'Age of Ascension' },
    { name: 'cota', label: 'Call of the Archons' },
    { name: 'vm2026', label: 'Vault Masters 2026' },
    { name: 'vm2025', label: 'Vault Masters 2025' },
    { name: 'vm2024', label: 'Vault Masters 2024' },
    { name: 'vm2023', label: 'Vault Masters 2023' }
];

/** The web client's starting selection: Prophetic Visions only. */
export const DEFAULT_EXPANSIONS: Record<string, boolean> = Object.fromEntries(
    EXPANSIONS.map((expansion) => [expansion.name, expansion.name === 'pv'])
);
