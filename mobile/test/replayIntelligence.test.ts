import { describe, expect, it } from 'vitest';

import {
    MIN_HEADLINE_GAMES,
    opposingHouseBars,
    replayHeadline,
    replayHouseBars
} from '../src/membership/replayIntelligence';
import type { ReplayIntelligenceResult } from '../src/api/types';

/**
 * ARCHON (N12): Replay Intelligence, shaped for a phone.
 *
 * The aggregation itself is the server's, and is tested there. What is tested
 * here is the part that is only true on a phone: five columns of web table
 * folded into a bar and a sub-line, and the headline that decides whether there
 * is enough evidence to say anything at all.
 */
describe('replay house bars', () => {
    it('draws the win rate and folds the rest into a sub-line', () => {
        const [bar] = replayHouseBars([
            { house: 'untamed', turns: 14, games: 5, wins: 2, winRate: 0.4, share: 0.35 }
        ]);

        expect(bar.key).toBe('untamed');
        expect(bar.label).toBe('Untamed');
        // BarList is scaled 0-100, not 0-1.
        expect(bar.value).toBe(40);
        expect(bar.display).toBe('40%');
        expect(bar.sub).toBe('14 turns · 35% of your turns · 5g');
    });

    it('names a multi-word house properly', () => {
        const [bar] = replayHouseBars([
            { house: 'staralliance', turns: 3, games: 2, winRate: 0.5 }
        ]);

        expect(bar.label).toBe('Star Alliance');
    });

    it('says "1 turn", not "1 turns"', () => {
        const [bar] = replayHouseBars([{ house: 'logos', turns: 1, games: 1, winRate: 0 }]);

        expect(bar.sub).toContain('1 turn ');
    });

    /**
     * The distinction the whole panel rests on. A house never won with is 0%
     * and draws an empty bar; a house with no measurable rate is null and draws
     * an em dash. Collapsing the two would report a loss the player never had.
     */
    it('keeps "never won" and "nothing to measure" apart', () => {
        const [lost, unknown] = replayHouseBars([
            { house: 'dis', turns: 4, games: 2, winRate: 0 },
            { house: 'mars', turns: 2, games: 1, winRate: null }
        ]);

        expect(lost.value).toBe(0);
        expect(lost.display).toBe('0%');
        expect(unknown.value).toBe(null);
        expect(unknown.display).toBeUndefined();
    });

    it('keeps the server ordering, which is most-called first', () => {
        const bars = replayHouseBars([
            { house: 'brobnar', turns: 20, games: 6, winRate: 0.3 },
            { house: 'shadows', turns: 4, games: 2, winRate: 1 }
        ]);

        expect(bars.map((bar) => bar.key)).toEqual(['brobnar', 'shadows']);
    });

    it('copes with nothing at all', () => {
        expect(replayHouseBars(undefined)).toEqual([]);
        expect(replayHouseBars([])).toEqual([]);
    });

    it('labels the opposing side by games faced, not turns', () => {
        const [bar] = opposingHouseBars([{ house: 'sanctum', games: 3, winRate: 0.667 }]);

        expect(bar.sub).toBe('3 games');
        expect(bar.display).toBe('67%');
    });
});

describe('replay headline', () => {
    const insights = (extra: Partial<ReplayIntelligenceResult> = {}): ReplayIntelligenceResult =>
        ({
            success: true,
            available: true,
            games: 10,
            byHouse: [{ house: 'untamed', turns: 30, games: 8, winRate: 0.375 }],
            ...extra
        }) as ReplayIntelligenceResult;

    it('names the house called most, and how that goes', () => {
        const headline = replayHeadline(insights());

        expect(headline).toEqual({
            house: 'untamed',
            houseName: 'Untamed',
            turns: 30,
            winRate: 0.375,
            games: 8
        });
    });

    /**
     * On a phone the headline is the part people actually read, so it must not
     * state a pattern off a sample that cannot carry one.
     */
    it('says nothing off too few games', () => {
        expect(replayHeadline(insights({ games: MIN_HEADLINE_GAMES - 1 }))).toBe(null);
    });

    it('says nothing when the top house itself has barely been played', () => {
        const thin = insights({
            byHouse: [{ house: 'untamed', turns: 2, games: 1, winRate: 0 }]
        });

        expect(replayHeadline(thin)).toBe(null);
    });

    it('says nothing when there is no analysis to read', () => {
        expect(replayHeadline(undefined)).toBe(null);
        expect(
            replayHeadline({ success: true, available: false, reason: 'none' } as ReplayIntelligenceResult)
        ).toBe(null);
        expect(replayHeadline(insights({ byHouse: [] }))).toBe(null);
    });
});
