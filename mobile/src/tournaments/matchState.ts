import type { TournamentDetail, TournamentMatch } from '../api/tournaments';

/**
 * What the app is allowed to say and do about a tournament match.
 *
 * Lives here rather than in the card because every rule below is a rule the
 * server already enforces, and a component is the one thing in this project
 * that cannot be unit tested. When these disagree with the server the player
 * finds out by tapping and reading an error, which for match results is how
 * somebody's tournament gets ruined quietly.
 */

/**
 * Games one player has to win to take the series. Mirrors matchWinsNeeded in
 * server/services/tournament/pairing.js — the app needs the number to report a
 * score the server will accept, and to say what a report will write before it
 * writes it.
 */
export function winsNeeded(bestOf?: number): number {
    return Math.floor((bestOf || 1) / 2) + 1;
}

/**
 * ARCHON: a match is decided by its RESULT TYPE, not by having a winner.
 *
 * A double loss — the organizer's ruling on a match nobody won, and what "time
 * in the round" records for a pairing that is level on games — is decided and
 * has no winner at all. Reading `winnerId` alone left the player looking at a
 * live match: the table button and both report buttons, every one of which the
 * server refuses because the match already has a result.
 */
export function isDecided(match: Pick<TournamentMatch, 'winnerId' | 'resultType'>): boolean {
    return !!match.winnerId || !!match.resultType;
}

export interface SeriesScore {
    /** Games won, from the reader's own side of the table. */
    mine: number;
    theirs: number;
    bestOf: number;
    /** Games either player needs to take the series. */
    needed: number;
    /** Games the platform has already recorded for this match. */
    recorded: number;
}

export function seriesScore(match: TournamentMatch, myUserId: number): SeriesScore {
    const amPlayer1 = match.player1Id === myUserId;
    const player1Wins = match.player1Wins ?? 0;
    const player2Wins = match.player2Wins ?? 0;
    const bestOf = match.bestOf ?? 1;

    return {
        mine: amPlayer1 ? player1Wins : player2Wins,
        theirs: amPlayer1 ? player2Wins : player1Wins,
        bestOf,
        needed: winsNeeded(bestOf),
        recorded: player1Wins + player2Wins
    };
}

/**
 * The series line for a match still being played.
 *
 * ARCHON (N57): since the platform started attaching each game of a series to
 * its match, a part-scored match is the ordinary mid-series state — 1–0 in a
 * best of three, with real games behind it. The app showed none of that, so a
 * player looking at their match could not tell a series they were leading from
 * one they had not started, and the report buttons underneath looked like they
 * were about the next game.
 */
export function seriesLabel(score: SeriesScore): string | undefined {
    if (score.bestOf <= 1 && !score.recorded) {
        return undefined;
    }

    const head = score.bestOf > 1 ? `Best of ${score.bestOf}` : 'One game';

    if (!score.recorded) {
        return `${head} · no games played yet`;
    }

    const standing =
        score.mine === score.theirs
            ? 'level'
            : score.mine > score.theirs
            ? 'you lead'
            : 'they lead';

    return `${head} · ${score.mine}–${score.theirs} (${standing})`;
}

export type ReportPlan =
    | {
          ok: true;
          /** Scores to send, in the server's player1/player2 terms. */
          scores: { player1Wins: number; player2Wins: number };
          /** The same series from the reader's side, for the confirmation. */
          mine: number;
          theirs: number;
          /** Games already recorded that this report keeps. */
          kept: number;
      }
    | { ok: false; reason: string };

/**
 * What reporting this match to `winnerId` would actually write.
 *
 * ARCHON: the scores are always sent, because a report without them is
 * destructive. The endpoint fills a silent report in as "winner takes every
 * game" — 2–0 in a best of three — so a player tapping this on a match sitting
 * at 1–0 overwrote a game the platform recorded itself, from a game that was
 * actually played, with a game that never happened. Naming the score keeps the
 * recorded games: the winner is credited exactly the number that takes the
 * series (which is what the server validates against) and the loser keeps what
 * they have already won.
 *
 * A refusal is returned rather than thrown so the card can say why instead of
 * offering a button that the server will reject.
 */
export function planReport(
    match: TournamentMatch,
    myUserId: number,
    winnerId: number
): ReportPlan {
    if (!match.player1Id || !match.player2Id) {
        return { ok: false, reason: 'A bye has no result to report.' };
    }

    if (isDecided(match)) {
        return {
            ok: false,
            reason: 'This match already has a result — only the organizer can change it.'
        };
    }

    if (winnerId !== match.player1Id && winnerId !== match.player2Id) {
        return { ok: false, reason: 'That player is not in this match.' };
    }

    const score = seriesScore(match, myUserId);
    const winnerIsPlayer1 = winnerId === match.player1Id;
    const loserWins = (winnerIsPlayer1 ? match.player2Wins : match.player1Wins) ?? 0;

    // The server credits the winner exactly the number of games that takes the
    // series, so a player already holding that many cannot be its loser. That
    // is a contradiction between the recorded games and the claim, and the only
    // honest answer is a human: silently reporting it either way would be the
    // app choosing which of the two to believe.
    if (loserWins >= score.needed) {
        return {
            ok: false,
            reason: 'That contradicts the games already recorded — ask the organizer to sort it out.'
        };
    }

    const amPlayer1 = match.player1Id === myUserId;
    const player1Wins = winnerIsPlayer1 ? score.needed : loserWins;
    const player2Wins = winnerIsPlayer1 ? loserWins : score.needed;

    return {
        ok: true,
        scores: { player1Wins, player2Wins },
        mine: amPlayer1 ? player1Wins : player2Wins,
        theirs: amPlayer1 ? player2Wins : player1Wins,
        kept: loserWins
    };
}

/**
 * ARCHON (N9): 'paper' marks a result the platform did not witness, and the
 * server takes one only where the event has said paper play is allowed (always
 * for irl and hybrid events, opt-in for online ones). Typing a result into this
 * card is precisely that — a game the engine did not see — so where the event
 * accepts one, say so: an organizer auditing a disputed standing needs to know
 * which rows are records and which are claims.
 *
 * The value the app used to send, 'app', is not a source the server has ever
 * recognised. It fell through to 'online', filing a result typed on a phone as
 * a game the platform ran itself.
 */
export function reportSource(
    tournament: Pick<TournamentDetail, 'allowPaperResults'>
): 'paper' | undefined {
    return tournament.allowPaperResults ? 'paper' : undefined;
}

/**
 * Whether this event has an online table to open at all.
 *
 * An irl event is played across a table and the server refuses to open a game
 * for one ("This event has no online games to open"), so the button was a
 * guaranteed error on every irl pairing.
 */
export function hasOnlineTable(tournament: Pick<TournamentDetail, 'mode'>): boolean {
    return tournament.mode !== 'irl';
}

export interface MatchTimeOffer {
    /** Null only for a legacy payload carrying one bare proposedTime. */
    id: number | null;
    time: string;
    end?: string | null;
    proposedById?: number | null;
    proposedBy?: string | null;
}

/**
 * Every time currently on the table for a match, soonest first.
 *
 * ARCHON (N14): an offer is a row and several can be live at once; the match's
 * own `proposedTime` is only a cache of the soonest one. Reading that single
 * field, the app showed one offer of however many there were and accepted
 * without naming it — which the server refuses outright once there is more than
 * one ("Several times are on offer — pick the one that works"). Worse, when the
 * soonest offer happened to be the reader's own, the opponent's offer was not
 * on the screen at all and the card claimed nobody had answered.
 *
 * A payload with no slots is an older server, so its single `proposedTime` is
 * folded in as one offer rather than blanking the scheduler.
 */
export function liveOffers(match: TournamentMatch): MatchTimeOffer[] {
    if (match.timeSlots && match.timeSlots.length > 0) {
        return match.timeSlots.map((slot) => ({
            id: slot.id,
            time: slot.time,
            end: slot.end ?? null,
            proposedById: slot.proposedById,
            proposedBy: slot.proposedBy
        }));
    }

    if (!match.proposedTime) {
        return [];
    }

    return [
        {
            id: null,
            time: match.proposedTime,
            end: null,
            proposedById: match.proposedBy
        }
    ];
}
