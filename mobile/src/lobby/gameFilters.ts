import type { GameSummary } from '../api/types';
import { GAME_FORMATS } from '../game/gameFormats';

/**
 * ARCHON: which games the lobby list shows.
 *
 * The website carries one switch per format plus "only show new games"
 * (client/Components/Games/GameLobby.jsx). The app showed everything, which is
 * fine at four tables and useless at forty — and worse on a phone, where the
 * list is the whole screen.
 *
 * Kept as plain data with a pure filter so the rules are testable; the screen
 * only owns which switches are on.
 */

export interface GameFilterState {
    /** Format key → shown. A format missing from the map counts as shown. */
    formats: Record<string, boolean>;
    /** Hide tables that already have both seats taken and have not started. */
    onlyOpenSeats: boolean;
    /** Hide games already in progress (which can only be spectated). */
    hideStarted: boolean;
    /** Hide the Helper Bot's practice tables. */
    hidePractice: boolean;
}

export const DEFAULT_GAME_FILTERS: GameFilterState = {
    formats: {},
    onlyOpenSeats: false,
    hideStarted: false,
    hidePractice: false
};

/** The formats offered as switches, in the order the new-game form lists them. */
export const FILTERABLE_FORMATS = GAME_FORMATS.map((format) => ({
    key: format.name,
    label: format.label
}));

/** True when nothing is being narrowed — drives the "clear" affordance. */
export function filtersAreDefault(filters: GameFilterState): boolean {
    return (
        !filters.onlyOpenSeats &&
        !filters.hideStarted &&
        !filters.hidePractice &&
        Object.values(filters.formats).every((shown) => shown !== false)
    );
}

function seatsFree(game: GameSummary): boolean {
    return Object.keys(game.players ?? {}).length < 2;
}

export function applyGameFilters(
    games: GameSummary[],
    filters: GameFilterState
): GameSummary[] {
    return games.filter((game) => {
        const format = game.gameFormat ?? 'normal';
        if (filters.formats[format] === false) {
            return false;
        }
        if (filters.hideStarted && game.started) {
            return false;
        }
        if (filters.hidePractice && game.botGame) {
            return false;
        }
        // "Open seats" is about joining, so a started game is never hidden by
        // it — you were never going to sit down at one anyway, and hiding it
        // would silently remove every game you could watch.
        if (filters.onlyOpenSeats && !game.started && !seatsFree(game)) {
            return false;
        }

        return true;
    });
}
