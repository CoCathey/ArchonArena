const {
    normalizeConfig,
    expectedScore,
    keyDifferential,
    movMultiplier,
    kFactorFor,
    calculateGameResult
} = require('../../../../server/services/rating/EloCalculator');
const { DEFAULT_ELO_CONFIG } = require('../../../../server/services/rating/eloDefaults');

describe('EloCalculator', function () {
    const config = normalizeConfig();

    describe('normalizeConfig', function () {
        it('returns defaults when no overrides are given', function () {
            expect(normalizeConfig()).toEqual(DEFAULT_ELO_CONFIG);
        });

        it('merges scalar overrides onto defaults', function () {
            const merged = normalizeConfig({ kFactor: 20, sasWeight: 0 });
            expect(merged.kFactor).toBe(20);
            expect(merged.sasWeight).toBe(0);
            expect(merged.provisionalKFactor).toBe(DEFAULT_ELO_CONFIG.provisionalKFactor);
        });

        it('deep-merges multiplier tables', function () {
            const merged = normalizeConfig({ keyDiffMultipliers: { 3: 1.5 } });
            expect(merged.keyDiffMultipliers[3]).toBe(1.5);
            expect(merged.keyDiffMultipliers[1]).toBe(DEFAULT_ELO_CONFIG.keyDiffMultipliers[1]);
        });

        it('rejects non-positive K factors', function () {
            expect(() => normalizeConfig({ kFactor: 0 })).toThrow();
            expect(() => normalizeConfig({ kFactor: -5 })).toThrow();
        });

        it('rejects negative sasWeight', function () {
            expect(() => normalizeConfig({ sasWeight: -1 })).toThrow();
        });

        it('rejects non-positive multipliers', function () {
            expect(() => normalizeConfig({ keyDiffMultipliers: { 2: 0 } })).toThrow();
            expect(() => normalizeConfig({ resultTypeMultipliers: { concede: -1 } })).toThrow();
        });
    });

    describe('expectedScore', function () {
        it('gives 0.5 for equal ratings and equal SAS', function () {
            expect(expectedScore(1200, 1200, 0, config)).toBeCloseTo(0.5, 10);
        });

        it('matches the classic Elo table for a 200 point underdog', function () {
            // 1 / (1 + 10^(200/400))
            expect(expectedScore(1200, 1400, 0, config)).toBeCloseTo(0.2402530733, 8);
        });

        it('is complementary: E(a,b) + E(b,a) === 1', function () {
            const eA = expectedScore(1310, 1150, 7, config);
            const eB = expectedScore(1150, 1310, -7, config);
            expect(eA + eB).toBeCloseTo(1, 10);
        });

        it('increases when the player deck has higher SAS', function () {
            const even = expectedScore(1200, 1200, 0, config);
            const strongerDeck = expectedScore(1200, 1200, 10, config);
            const weakerDeck = expectedScore(1200, 1200, -10, config);
            expect(strongerDeck).toBeGreaterThan(even);
            expect(weakerDeck).toBeLessThan(even);
        });

        it('treats sasWeight as rating points per SAS point', function () {
            // 25 SAS at weight 4 should equal a flat 100 rating point edge
            const viaSas = expectedScore(1200, 1200, 25, config);
            const viaRating = expectedScore(1300, 1200, 0, config);
            expect(viaSas).toBeCloseTo(viaRating, 10);
        });

        it('ignores SAS when sasWeight is 0', function () {
            const noSas = normalizeConfig({ sasWeight: 0 });
            expect(expectedScore(1200, 1200, 40, noSas)).toBeCloseTo(0.5, 10);
        });
    });

    describe('keyDifferential', function () {
        it('reads the margin off the loser, not off the gap between the players', function () {
            expect(keyDifferential(2)).toBe(1); // 3-2
            expect(keyDifferential(1)).toBe(2); // 3-1
            expect(keyDifferential(0)).toBe(3); // 3-0
        });

        it('clamps a loser who finished ahead to the narrowest margin', function () {
            // Conceding while winning the key race is unusual but legal.
            expect(keyDifferential(3)).toBe(1);
            expect(keyDifferential(9)).toBe(1);
        });

        it('treats a missing key count as none forged', function () {
            expect(keyDifferential(null)).toBe(3);
            expect(keyDifferential(undefined)).toBe(3);
        });
    });

    describe('movMultiplier', function () {
        it('scales with key differential', function () {
            expect(movMultiplier(1, 'keys', config)).toBe(1.0);
            expect(movMultiplier(2, 'keys', config)).toBe(1.1);
            expect(movMultiplier(3, 'keys', config)).toBe(1.25);
        });

        it('clamps an out-of-range differential into the table', function () {
            expect(movMultiplier(0, 'keys', config)).toBe(config.keyDiffMultipliers[1]);
            expect(movMultiplier(-2, 'keys', config)).toBe(config.keyDiffMultipliers[1]);
            expect(movMultiplier(7, 'keys', config)).toBe(config.keyDiffMultipliers[3]);
        });

        it('applies the result type multiplier', function () {
            const discounted = normalizeConfig({ resultTypeMultipliers: { timeout: 0.5 } });
            expect(movMultiplier(3, 'timeout', discounted)).toBeCloseTo(1.25 * 0.5, 10);
        });

        it('falls back to the keys multiplier for unknown result types', function () {
            expect(movMultiplier(3, 'mystery', config)).toBe(1.25);
        });

        // How the game ended is priced by resultTypeMultipliers alone. If a
        // concession should be worth less than a forge-out, that is the knob -
        // the margin tier must not quietly do it a second time.
        it('prices a concession by result type only, not by a demoted margin', function () {
            expect(movMultiplier(3, 'concede', config)).toBe(movMultiplier(3, 'keys', config));

            const discounted = normalizeConfig({ resultTypeMultipliers: { concede: 0.8 } });
            expect(movMultiplier(3, 'concede', discounted)).toBeCloseTo(1.25 * 0.8, 10);
        });
    });

    describe('kFactorFor', function () {
        it('uses the provisional K below the provisional game count', function () {
            expect(kFactorFor(0, 1200, config)).toBe(config.provisionalKFactor);
            expect(kFactorFor(config.provisionalGames - 1, 1200, config)).toBe(
                config.provisionalKFactor
            );
        });

        it('uses the standard K at and beyond the provisional game count', function () {
            expect(kFactorFor(config.provisionalGames, 1200, config)).toBe(config.kFactor);
            expect(kFactorFor(500, 1200, config)).toBe(config.kFactor);
        });

        it('reduces K for high-rated established players (FIDE-style tiers)', function () {
            expect(kFactorFor(100, 2099, config)).toBe(config.kFactor);
            expect(kFactorFor(100, 2100, config)).toBe(config.highRatingKFactor);
            expect(kFactorFor(100, 2399, config)).toBe(config.highRatingKFactor);
            expect(kFactorFor(100, 2400, config)).toBe(config.topRatingKFactor);
            expect(kFactorFor(100, 3000, config)).toBe(config.topRatingKFactor);
        });

        it('provisional status beats the rating tiers', function () {
            expect(kFactorFor(0, 2500, config)).toBe(config.provisionalKFactor);
        });
    });

    describe('calculateGameResult', function () {
        const established = { gamesPlayed: 100 };

        it('gives the textbook exchange for an even 3-0 game', function () {
            // Even match, 3-0: change = K * 1.25 * 0.5 = 32 * 0.625 = 20
            const result = calculateGameResult({
                winner: { rating: 1200, deckSas: 60, ...established },
                loser: { rating: 1200, deckSas: 60, ...established },
                loserKeys: 0
            });

            expect(result.winner.newRating).toBe(1220);
            expect(result.loser.newRating).toBe(1180);
        });

        // ARCHON: the reported bug. A player who concedes on the back foot ends
        // the game before the winner forges their third key, and the margin
        // used to be read as winnerKeys - loserKeys - so conceding at 2-0 rated
        // as a 3-1 and at 1-0 as a 3-2. The loser could shrink their opponent's
        // gain by giving up, which is precisely backwards.
        it('rates a concession by how close the loser got, not by the winner keys', function () {
            const even = {
                winner: { rating: 1200, deckSas: 60, ...established },
                loser: { rating: 1200, deckSas: 60, ...established }
            };

            const forgedOut = calculateGameResult({ ...even, loserKeys: 0, resultType: 'keys' });
            const concededAtZero = calculateGameResult({
                ...even,
                loserKeys: 0,
                resultType: 'concede'
            });
            const concededAtOne = calculateGameResult({
                ...even,
                loserKeys: 1,
                resultType: 'concede'
            });

            // Conceding without a key is a 3-0, whether the winner had reached
            // three keys yet or not.
            expect(concededAtZero.winner.change).toBe(forgedOut.winner.change);
            expect(concededAtZero.winner.change).toBe(20);
            // And one key back from that is a 3-1, not a 3-2.
            expect(concededAtOne.movMultiplier).toBe(
                DEFAULT_ELO_CONFIG.keyDiffMultipliers[2] *
                    DEFAULT_ELO_CONFIG.resultTypeMultipliers.concede
            );
        });

        // The recalculation replay has the stored margin tier and not the raw
        // key counts, so it passes the tier straight in.
        it('accepts a pre-computed margin tier in place of the key count', function () {
            const even = {
                winner: { rating: 1200, deckSas: 60, ...established },
                loser: { rating: 1200, deckSas: 60, ...established }
            };

            expect(calculateGameResult({ ...even, keyDiff: 3 }).winner.change).toBe(
                calculateGameResult({ ...even, loserKeys: 0 }).winner.change
            );
            expect(calculateGameResult({ ...even, keyDiff: 1 }).winner.change).toBe(
                calculateGameResult({ ...even, loserKeys: 2 }).winner.change
            );
            // An explicit tier wins over the key count - a caller that has both
            // is replaying a stored result, and the stored tier is the truth.
            expect(calculateGameResult({ ...even, keyDiff: 1, loserKeys: 0 }).movMultiplier).toBe(
                DEFAULT_ELO_CONFIG.keyDiffMultipliers[1]
            );
        });

        it('applies the tournament K multiplier to both players', function () {
            const game = {
                winner: { rating: 1200, deckSas: 60, ...established },
                loser: { rating: 1200, deckSas: 60, ...established },
                loserKeys: 0
            };

            const ladder = calculateGameResult(game);
            const tournament = calculateGameResult(
                { ...game, isTournament: true },
                { tournamentKMultiplier: 1.5 }
            );

            expect(tournament.winner.change).toBe(Math.round(ladder.winner.change * 1.5));
            expect(tournament.loser.change).toBe(Math.round(ladder.loser.change * 1.5));
        });

        it('high-rated players move more slowly than mid-ladder players', function () {
            // Same 200-point favorite-wins scenario at two ladder heights:
            // the 2500-rated winner (K16) gains half of what a 1500-rated
            // winner (K32) would.
            const mid = calculateGameResult({
                winner: { rating: 1500, deckSas: 60, ...established },
                loser: { rating: 1300, deckSas: 60, ...established },
                loserKeys: 2
            });
            const top = calculateGameResult({
                winner: { rating: 2500, deckSas: 60, ...established },
                loser: { rating: 2300, deckSas: 60, ...established },
                loserKeys: 2
            });

            expect(top.winner.kFactor).toBe(16);
            expect(mid.winner.kFactor).toBe(32);
            expect(top.winner.change).toBeLessThan(mid.winner.change);
        });

        it('is zero-sum for two established players', function () {
            const result = calculateGameResult({
                winner: { rating: 1345, deckSas: 71, ...established },
                loser: { rating: 1522, deckSas: 64, ...established },
                loserKeys: 1
            });

            // Rounding can shift the sum by at most 1 point
            expect(Math.abs(result.winner.change + result.loser.change)).toBeLessThanOrEqual(1);
        });

        it('pays more for a bigger key differential', function () {
            const base = {
                winner: { rating: 1200, deckSas: 60, ...established },
                loser: { rating: 1200, deckSas: 60, ...established }
            };
            const narrow = calculateGameResult({ ...base, loserKeys: 2 });
            const sweep = calculateGameResult({ ...base, loserKeys: 0 });

            expect(sweep.winner.change).toBeGreaterThan(narrow.winner.change);
        });

        it('pays less for winning with a much stronger deck', function () {
            const strongerDeckWin = calculateGameResult({
                winner: { rating: 1200, deckSas: 90, ...established },
                loser: { rating: 1200, deckSas: 55, ...established },
                loserKeys: 1
            });
            const evenDeckWin = calculateGameResult({
                winner: { rating: 1200, deckSas: 70, ...established },
                loser: { rating: 1200, deckSas: 70, ...established },
                loserKeys: 1
            });

            expect(strongerDeckWin.winner.change).toBeLessThan(evenDeckWin.winner.change);
        });

        it('pays more for an upset with a weaker deck', function () {
            const upset = calculateGameResult({
                winner: { rating: 1200, deckSas: 55, ...established },
                loser: { rating: 1200, deckSas: 90, ...established },
                loserKeys: 2
            });
            const even = calculateGameResult({
                winner: { rating: 1200, deckSas: 70, ...established },
                loser: { rating: 1200, deckSas: 70, ...established },
                loserKeys: 2
            });

            expect(upset.winner.change).toBeGreaterThan(even.winner.change);
        });

        it('applies the provisional K factor to new players only', function () {
            const result = calculateGameResult({
                winner: { rating: 1200, deckSas: 60, gamesPlayed: 2 },
                loser: { rating: 1200, deckSas: 60, gamesPlayed: 200 },
                loserKeys: 2
            });

            expect(result.winner.kFactor).toBe(DEFAULT_ELO_CONFIG.provisionalKFactor);
            expect(result.loser.kFactor).toBe(DEFAULT_ELO_CONFIG.kFactor);
            expect(result.winner.change).toBeGreaterThan(Math.abs(result.loser.change));
        });

        it('never drops a rating below the floor', function () {
            // Near-even matchup close to the floor: the full ~20 point loss
            // would land below it, so the floor must clamp.
            const result = calculateGameResult({
                winner: { rating: 100, deckSas: 60, ...established },
                loser: { rating: 110, deckSas: 60, ...established },
                loserKeys: 0
            });

            expect(result.loser.newRating).toBe(DEFAULT_ELO_CONFIG.ratingFloor);
        });

        it('treats missing SAS values as an even deck matchup', function () {
            const result = calculateGameResult({
                winner: { rating: 1200, ...established },
                loser: { rating: 1200, ...established },
                loserKeys: 2
            });

            expect(result.winner.expected).toBeCloseTo(0.5, 10);
        });

        it('honors admin config overrides', function () {
            const result = calculateGameResult(
                {
                    winner: { rating: 1200, deckSas: 60, ...established },
                    loser: { rating: 1200, deckSas: 60, ...established },
                    loserKeys: 0
                },
                { kFactor: 16, keyDiffMultipliers: { 3: 1.0 } }
            );

            // 16 * 1.0 * 0.5 = 8
            expect(result.winner.change).toBe(8);
            expect(result.loser.change).toBe(-8);
        });
    });
});
