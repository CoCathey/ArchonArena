/**
 * ARCHON: every game mode the lobby will actually run.
 *
 * The list is the server's MATCHMAKING_FORMATS, not the web create form's -
 * those had drifted apart. Reversal and Unchained are fully implemented (the
 * deck swap in gameserver.js, the set restriction in DeckService) and Quick
 * Match has always queued for both; only the web's create form left them out,
 * so they were reachable by matchmaking and not by making a game.
 */
export interface GameFormat {
    name: 'normal' | 'sealed' | 'adaptive-bo1' | 'alliance' | 'reversal' | 'unchained';
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
    },
    {
        name: 'reversal',
        label: 'Reversal',
        hint: 'You each pick a deck, then swap — play your opponent\'s.'
    },
    {
        name: 'unchained',
        label: 'Unchained',
        hint: 'Unchained-set decks only, on both sides.'
    }
];

/** Modes where the Unchained set is the only legal deck — and the only ones. */
export const isUnchainedFormat = (format?: string): boolean => format === 'unchained';

/**
 * ARCHON: game modes for a TOURNAMENT, which speak a different vocabulary.
 *
 * Events call standard play `archon`; the lobby calls it `normal`, and
 * TournamentService translates between them on the way to a table
 * (LOBBY_FORMAT_BY_EVENT). This screen used to reuse the lobby list, so the
 * default it sent was `normal` — which is not in the event whitelist, so
 * creating a standard event from the app was refused every time.
 *
 * Unchained is deliberately absent: the engine runs it, but events have never
 * accepted it, and offering a mode the server rejects is the bug above again.
 * This list mirrors TournamentService.GAME_FORMATS exactly.
 */
export const EVENT_GAME_FORMATS: { name: string; label: string }[] = [
    { name: 'archon', label: 'Archon' },
    { name: 'sealed', label: 'Sealed' },
    { name: 'alliance', label: 'Alliance' },
    { name: 'reversal', label: 'Reversal' },
    { name: 'adaptive-bo1', label: 'Adaptive' }
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
