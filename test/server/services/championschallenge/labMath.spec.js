const { normalizeConfig } = require('../../../../server/services/rating/EloCalculator');
const {
    MIN_CONFIDENT_GAMES,
    wilsonLowerBound,
    sasExpectedScore,
    isHiddenGem,
    buildFindings
} = require('../../../../server/services/championschallenge/labMath');

// The lab’s claims - "hidden gem", the SAS expectation a gem must beat - are arithmetic, and
// this file pins the arithmetic. If any of these move, the badge criteria
// moved, and that should be a deliberate edit here rather than a surprise on
// somebody's roster.

describe('Champion’s Challenge math', function () {
    const elo = normalizeConfig({});

    describe('wilsonLowerBound', function () {
        it('is zero with no games', function () {
            expect(wilsonLowerBound(0, 0)).toBe(0);
        });

        it('sits below the observed rate', function () {
            expect(wilsonLowerBound(15, 20)).toBeLessThan(0.75);
            expect(wilsonLowerBound(15, 20)).toBeGreaterThan(0.5);
        });

        it('tightens toward the observed rate as the sample grows', function () {
            const small = wilsonLowerBound(15, 20);
            const large = wilsonLowerBound(150, 200);

            expect(large).toBeGreaterThan(small);
            expect(large).toBeLessThan(0.75);
        });

        it('never goes below zero even on a winless record', function () {
            expect(wilsonLowerBound(0, 10)).toBe(0);
        });
    });

    describe('sasExpectedScore', function () {
        it('calls an even match even', function () {
            expect(sasExpectedScore(70, 70, elo)).toBeCloseTo(0.5, 10);
        });

        it('uses the site rating model exchange rate: 25 SAS = 100 Elo', function () {
            // effective diff = sasWeight(4) * 25 = 100 -> 1/(1+10^-0.25)
            expect(sasExpectedScore(95, 70, elo)).toBeCloseTo(1 / (1 + Math.pow(10, -0.25)), 10);
        });

        it('is symmetric', function () {
            expect(sasExpectedScore(80, 60, elo) + sasExpectedScore(60, 80, elo)).toBeCloseTo(
                1,
                10
            );
        });
    });

    describe('isHiddenGem', function () {
        it('refuses a thin sample no matter how shiny', function () {
            expect(
                isHiddenGem({ games: MIN_CONFIDENT_GAMES - 1, wins: 18, expectedWinRate: 0.4 })
            ).toBe(false);
        });

        it('refuses when there is no expectation to beat', function () {
            expect(isHiddenGem({ games: 40, wins: 35, expectedWinRate: null })).toBe(false);
        });

        it('requires the whole confidence interval clear of expectation', function () {
            // 12/20 = 60% observed against 50% expected, but the lower bound
            // dips below 0.5 - a lucky streak, not a gem.
            expect(isHiddenGem({ games: 20, wins: 12, expectedWinRate: 0.5 })).toBe(false);
        });

        it('recognises sustained overperformance', function () {
            // 70% over 60 games against a 45% expectation: the lower bound
            // clears it comfortably.
            expect(isHiddenGem({ games: 60, wins: 42, expectedWinRate: 0.45 })).toBe(true);
        });
    });

    describe('buildFindings', function () {
        const deck = (overrides) => ({
            deckId: 1,
            name: 'Deck',
            games: 40,
            wins: 20,
            winRate: 0.5,
            expectedWinRate: 0.5,
            delta: 0,
            confident: true,
            hiddenGem: false,
            bestOpening: null,
            firstPlayerWinRate: null,
            secondPlayerWinRate: null,
            ...overrides
        });

        it('says nothing about a deck still proving', function () {
            expect(buildFindings([deck({ confident: false, hiddenGem: true })])).toEqual([]);
        });

        it('leads with the hidden gems', function () {
            const findings = buildFindings([
                deck({ deckId: 2, name: 'Solid', delta: 0.09, winRate: 0.59 }),
                deck({
                    deckId: 1,
                    name: 'Gem',
                    hiddenGem: true,
                    winRate: 0.7,
                    expectedWinRate: 0.45
                })
            ]);

            expect(findings[0].deckId).toBe(1);
            expect(findings[0].text).toContain('hidden gem');
            expect(findings[0].text).toContain('70%');
            expect(findings[0].text).toContain('45%');
        });

        it('names the opening that carries a deck', function () {
            const findings = buildFindings([
                deck({
                    bestOpening: { house: 'staralliance', games: 9, winRate: 0.72 },
                    winRate: 0.5
                })
            ]);

            expect(findings.some((finding) => finding.text.includes('Star Alliance'))).toBe(true);
        });

        it('reports a first-player split too large to ignore', function () {
            const findings = buildFindings([
                deck({ firstPlayerWinRate: 0.66, secondPlayerWinRate: 0.4 })
            ]);

            expect(findings.some((finding) => finding.text.includes('going first'))).toBe(true);
        });

        it('caps the list', function () {
            const decks = Array.from({ length: 20 }, (_, index) =>
                deck({
                    deckId: index,
                    name: `Deck ${index}`,
                    hiddenGem: true,
                    winRate: 0.7,
                    expectedWinRate: 0.45
                })
            );

            expect(buildFindings(decks).length).toBeLessThanOrEqual(8);
        });
    });
});
