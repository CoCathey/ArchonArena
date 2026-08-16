import type { BarItem } from '../ui/BarList';
import type { ReplayHouseRow, ReplayIntelligenceResult } from '../api/types';
import { houseLabel } from '../ui/houseNames';

/**
 * ARCHON (N12): Replay Intelligence, shaped for a phone.
 *
 * The web page draws each house as a five-column row — name, bar, win rate,
 * turns called, share of turns. At 390 points wide that is four columns too
 * many, so the same facts are folded into a bar with one number beside it and
 * the rest as a sub-line.
 *
 * The logic lives here rather than inside the screen because it is the only
 * part with anything to get wrong, and a component is the one thing in this
 * project that cannot be unit tested.
 */

/**
 * How many analysed games before this panel will say anything about a pattern.
 *
 * Below it the numbers are still shown — they are the player's real games — but
 * the headline is withheld. "You win 0% when you call Untamed" off one game is
 * true and useless, and on a phone the headline is the part people read.
 */
export const MIN_HEADLINE_GAMES = 3;

/** Games before one house's own win rate is worth stating. */
const MIN_HOUSE_GAMES = 2;

/**
 * The houses a player calls, as bars.
 *
 * Ordered by the server, which sorts by turns called — the most-played house
 * first is the order a player thinks in, and re-sorting by win rate here would
 * put a house they called twice above the one they build every game around.
 */
export function replayHouseBars(rows: ReplayHouseRow[] | undefined): BarItem[] {
    return (rows ?? []).map((row) => ({
        key: row.house,
        label: houseLabel(row.house),
        // Null stays null: BarList renders an em dash rather than an empty bar,
        // so "never won with it" and "no games yet" do not look the same.
        value: row.winRate === null || row.winRate === undefined ? null : row.winRate * 100,
        display: row.winRate === null || row.winRate === undefined ? undefined : `${Math.round(row.winRate * 100)}%`,
        sub: houseSubLine(row)
    }));
}

/** "14 turns · 22% of your turns · 5 games", dropping whatever is unknown. */
function houseSubLine(row: ReplayHouseRow): string {
    const parts: string[] = [];

    if (row.turns) {
        parts.push(`${row.turns} ${row.turns === 1 ? 'turn' : 'turns'}`);
    }

    if (row.share !== null && row.share !== undefined) {
        parts.push(`${Math.round(row.share * 100)}% of your turns`);
    }

    if (row.games) {
        parts.push(`${row.games}g`);
    }

    return parts.join(' · ');
}

/** What the other side called, most-faced first. */
export function opposingHouseBars(rows: ReplayHouseRow[] | undefined): BarItem[] {
    return (rows ?? []).map((row) => ({
        key: row.house,
        label: houseLabel(row.house),
        value: row.winRate === null || row.winRate === undefined ? null : row.winRate * 100,
        display: row.winRate === null || row.winRate === undefined ? undefined : `${Math.round(row.winRate * 100)}%`,
        sub: row.games ? `${row.games} ${row.games === 1 ? 'game' : 'games'}` : undefined
    }));
}

export interface ReplayHeadline {
    house: string;
    houseName: string;
    turns: number;
    winRate: number | null;
    games: number;
}

/**
 * The one sentence worth putting at the top of a phone screen: the house this
 * player reaches for most, and how they do when they reach for it.
 *
 * A statement of fact, not advice. It is the most-called house rather than the
 * best or worst one, because "your best house is X" off a handful of games is a
 * claim the sample cannot support, while "you call X most often" is simply what
 * the recordings say.
 *
 * Null when there is not enough to say — the caller renders the bars alone.
 */
export function replayHeadline(
    insights: ReplayIntelligenceResult | undefined
): ReplayHeadline | null {
    if (!insights?.available || (insights.games ?? 0) < MIN_HEADLINE_GAMES) {
        return null;
    }

    const top = (insights.byHouse ?? [])[0];

    if (!top || (top.games ?? 0) < MIN_HOUSE_GAMES) {
        return null;
    }

    return {
        house: top.house,
        houseName: houseLabel(top.house),
        turns: top.turns ?? 0,
        winRate: top.winRate ?? null,
        games: top.games ?? 0
    };
}
