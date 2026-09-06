import { describe, expect, it } from 'vitest';
import type { TournamentMatch } from '../src/api/tournaments';
import {
    hasOnlineTable,
    isDecided,
    liveOffers,
    planReport,
    reportSource,
    seriesLabel,
    seriesScore,
    winsNeeded
} from '../src/tournaments/matchState';

const ME = 7;
const THEM = 9;

/** A live best-of-three where the player is player 1, unless said otherwise. */
function match(over: Partial<TournamentMatch> = {}): TournamentMatch {
    return {
        id: 1,
        round: 2,
        player1Id: ME,
        player2Id: THEM,
        player1: 'me',
        player2: 'them',
        bestOf: 3,
        player1Wins: 0,
        player2Wins: 0,
        ...over
    };
}

describe('series score on a live match', () => {
    it('reads the score from the reader’s own side of the table', () => {
        const asPlayer1 = seriesScore(match({ player1Wins: 1, player2Wins: 0 }), ME);
        expect([asPlayer1.mine, asPlayer1.theirs]).toEqual([1, 0]);

        // The same match seen by the opponent has to read the other way round,
        // or one of the two players is told they are ahead when they are not.
        const asPlayer2 = seriesScore(match({ player1Wins: 1, player2Wins: 0 }), THEM);
        expect([asPlayer2.mine, asPlayer2.theirs]).toEqual([0, 1]);
    });

    it('counts the games the platform has recorded, and what wins the series', () => {
        const score = seriesScore(match({ player1Wins: 1, player2Wins: 1 }), ME);
        expect(score.recorded).toBe(2);
        expect(score.needed).toBe(2);
        expect(winsNeeded(3)).toBe(2);
        expect(winsNeeded(5)).toBe(3);
        // A match with no bestOf at all is a single game.
        expect(winsNeeded(undefined)).toBe(1);
    });

    it('says the format and where the series stands', () => {
        expect(seriesLabel(seriesScore(match({ player1Wins: 1 }), ME))).toBe(
            'Best of 3 · 1–0 (you lead)'
        );
        expect(seriesLabel(seriesScore(match({ player2Wins: 1 }), ME))).toBe(
            'Best of 3 · 0–1 (they lead)'
        );
        expect(seriesLabel(seriesScore(match({ player1Wins: 1, player2Wins: 1 }), ME))).toBe(
            'Best of 3 · 1–1 (level)'
        );
        expect(seriesLabel(seriesScore(match(), ME))).toBe('Best of 3 · no games played yet');
    });

    it('says nothing about a single untouched game', () => {
        // There is no series to describe, and "One game · 0–0" is noise on
        // every pairing of an ordinary Swiss event.
        expect(seriesLabel(seriesScore(match({ bestOf: 1 }), ME))).toBeUndefined();
    });
});

describe('a match is decided by its result type, not only by a winner', () => {
    it('counts a double loss as decided', () => {
        // The organizer's ruling that nobody took the match, and what "time in
        // the round" records for a level pairing. Read as undecided, the card
        // offered a table and both report buttons, all of which the server
        // refuses because the match already has a result.
        expect(isDecided(match({ resultType: 'double-loss' }))).toBe(true);
        expect(isDecided(match({ winnerId: ME }))).toBe(true);
        expect(isDecided(match())).toBe(false);
    });
});

describe('reporting a match keeps the games already recorded', () => {
    it('names the score instead of letting the server fill one in', () => {
        // The endpoint reads a scoreless report as "winner took every game", so
        // this exact match — 1–0 with a real game behind it — went down as 2–0
        // and destroyed a result the platform recorded itself.
        const plan = planReport(match({ player1Wins: 0, player2Wins: 1 }), ME, ME);

        expect(plan).toMatchObject({
            ok: true,
            scores: { player1Wins: 2, player2Wins: 1 },
            mine: 2,
            theirs: 1,
            kept: 1
        });
    });

    it('credits the winner exactly what takes the series', () => {
        // The server rejects anything else: the winner's games must equal the
        // number that wins it, and the loser's must be short of it.
        expect(planReport(match({ bestOf: 5, player1Wins: 1, player2Wins: 2 }), ME, THEM)).toMatchObject(
            { ok: true, scores: { player1Wins: 1, player2Wins: 3 }, mine: 1, theirs: 3, kept: 1 }
        );
    });

    it('reports a fresh single game as 1–0', () => {
        expect(planReport(match({ bestOf: 1 }), ME, ME)).toMatchObject({
            ok: true,
            scores: { player1Wins: 1, player2Wins: 0 },
            kept: 0
        });
    });

    it('works the same from the opponent’s phone', () => {
        const plan = planReport(match({ player1Wins: 1 }), THEM, THEM);
        expect(plan).toMatchObject({
            ok: true,
            scores: { player1Wins: 1, player2Wins: 2 },
            mine: 2,
            theirs: 1,
            kept: 1
        });
    });
});

describe('the report guard', () => {
    it('refuses a match that already has a result', () => {
        const plan = planReport(match({ winnerId: THEM }), ME, ME);
        expect(plan.ok).toBe(false);
        expect(plan.ok === false && plan.reason).toMatch(/already has a result/);

        // Including one with no winner at all.
        expect(planReport(match({ resultType: 'double-loss' }), ME, ME).ok).toBe(false);
    });

    it('refuses a report the recorded games contradict', () => {
        // Two games already recorded to them in a best of three IS the series.
        // Reporting either player as the winner from here means the games and
        // the claim disagree, and the app is not the one to decide which is
        // right — the server would refuse it too.
        const decidedByGames = match({ player1Wins: 0, player2Wins: 2 });

        const plan = planReport(decidedByGames, ME, ME);
        expect(plan.ok).toBe(false);
        expect(plan.ok === false && plan.reason).toMatch(/contradicts the games already recorded/);
    });

    it('refuses a bye and a player who is not in the match', () => {
        expect(planReport(match({ player2Id: null }), ME, ME).ok).toBe(false);
        expect(planReport(match(), ME, 404).ok).toBe(false);
    });
});

describe('what the event will accept', () => {
    it('marks a typed result as paper only where the event takes paper results', () => {
        // 'paper' is the flag an organizer auditing a standing reads to tell a
        // claim from a record. The server refuses it where the event has not
        // opted in, so it is only sent where it will be taken.
        expect(reportSource({ allowPaperResults: true })).toBe('paper');
        expect(reportSource({ allowPaperResults: false })).toBeUndefined();
        expect(reportSource({})).toBeUndefined();
    });

    it('offers an online table only where there is one to open', () => {
        expect(hasOnlineTable({ mode: 'online' })).toBe(true);
        expect(hasOnlineTable({ mode: 'hybrid' })).toBe(true);
        expect(hasOnlineTable({})).toBe(true);
        // An irl event is played across a table; the server has no game to open.
        expect(hasOnlineTable({ mode: 'irl' })).toBe(false);
    });
});

describe('the times on the table', () => {
    it('lists every live offer, not just the soonest', () => {
        const offers = liveOffers(
            match({
                proposedTime: '2026-09-06 18:00:00',
                proposedBy: ME,
                timeSlots: [
                    { id: 11, time: '2026-09-06 18:00:00', proposedById: ME },
                    { id: 12, time: '2026-09-07 20:00:00', proposedById: THEM, proposedBy: 'them' }
                ]
            })
        );

        // Reading proposedTime alone showed one offer of two, and here the one
        // it showed is the reader's own — so the opponent's answer was not on
        // the screen at all.
        expect(offers.map((offer) => offer.id)).toEqual([11, 12]);
        expect(offers[1].proposedById).toBe(THEM);
    });

    it('folds an older payload’s single proposal in as one offer', () => {
        const offers = liveOffers(match({ proposedTime: '2026-09-06 18:00:00', proposedBy: THEM }));

        expect(offers).toHaveLength(1);
        // No id to name: the server lets an unnamed accept stand while exactly
        // one offer is live, which is what that payload means.
        expect(offers[0].id).toBeNull();
        expect(offers[0].proposedById).toBe(THEM);
    });

    it('has nothing to show when no time has been offered', () => {
        expect(liveOffers(match())).toEqual([]);
    });
});
