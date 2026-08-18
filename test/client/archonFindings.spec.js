const { deriveFindings, MIN_FINDING_GAMES } = require('../../client/archonFindings');

/**
 * ARCHON: the headline findings on Archon Intelligence.
 *
 * The whole risk of a "what stands out" panel is that the most striking gap in
 * a small dataset is noise, and "stands out" is precisely the filter that
 * selects for noise. So most of what is pinned here is the refusals: which
 * true-looking sentences the panel declines to write, and why.
 */
describe('Archon Intelligence findings', function () {
    const solidHouse = (house, winRate, games = 40) => ({
        house,
        houseName: house,
        games,
        wins: Math.round(games * winRate),
        winRate
    });

    it('says nothing at all without a payload', function () {
        expect(deriveFindings(null)).toEqual([]);
        expect(deriveFindings({})).toEqual([]);
    });

    describe('beating the rating', function () {
        const payload = (over) => ({
            vsExpectation: {
                available: true,
                games: 50,
                wins: 30,
                winRate: 0.6,
                expectedWinRate: 0.5,
                vsExpectation: over
            }
        });

        it('reports outperforming and underperforming as different findings', function () {
            expect(deriveFindings(payload(5))[0].kind).toBe('aheadOfRating');
            expect(deriveFindings(payload(-5))[0].kind).toBe('behindRating');
        });

        // A losing streak is as much a fact about someone's play as a winning
        // one; a panel that only reports good news is a congratulation.
        it('reports the gap as a magnitude either way', function () {
            expect(deriveFindings(payload(-5))[0].values.gap).toBe(5);
        });

        it('will not comment on a handful of rated games', function () {
            const thin = {
                vsExpectation: {
                    available: true,
                    games: MIN_FINDING_GAMES - 1,
                    winRate: 1,
                    expectedWinRate: 0.5,
                    vsExpectation: 4
                }
            };

            expect(deriveFindings(thin)).toEqual([]);
        });
    });

    describe('house matchups', function () {
        it('names the best and worst when both have a sample', function () {
            const findings = deriveFindings({
                byHouse: [solidHouse('Untamed', 0.7), solidHouse('Dis', 0.3)]
            });

            expect(findings).toHaveLength(1);
            expect(findings[0].kind).toBe('houseSpread');
            expect(findings[0].values.bestHouse).toBe('Untamed');
            expect(findings[0].values.worstHouse).toBe('Dis');
        });

        /**
         * The failure this guard exists for: a 0-3 record against one house is
         * the widest gap in most players' tables and means nothing at all.
         * Excluding the thin row leaves fewer than two comparable houses, so
         * there is no finding rather than a dramatic one.
         */
        it('ignores a house with too few games even when it is the widest gap', function () {
            const findings = deriveFindings({
                byHouse: [
                    solidHouse('Untamed', 0.55),
                    { house: 'Dis', houseName: 'Dis', games: 3, wins: 0, winRate: 0 }
                ]
            });

            expect(findings).toEqual([]);
        });
    });

    describe('turn order', function () {
        const turn = (firstRate, secondRate, games = 30) => ({
            byTurnOrder: {
                available: true,
                first: { games, wins: games * firstRate, winRate: firstRate },
                second: { games, wins: games * secondRate, winRate: secondRate },
                edge: firstRate - secondRate
            }
        });

        it('reports whichever side is stronger', function () {
            expect(deriveFindings(turn(0.65, 0.45))[0].kind).toBe('strongerFirst');
            expect(deriveFindings(turn(0.45, 0.65))[0].kind).toBe('strongerSecond');
        });

        // Both sides need a sample - an 80% on the play over four games next to
        // a 50% over forty is not an edge, it is four games.
        it('needs a sample on both sides of the split', function () {
            const lopsided = turn(0.8, 0.5);
            lopsided.byTurnOrder.first.games = 4;

            expect(deriveFindings(lopsided)).toEqual([]);
        });
    });

    describe('recent form', function () {
        const withForm = (recentRate, lifetimeRate) => ({
            vsExpectation: {
                available: true,
                games: 100,
                winRate: lifetimeRate,
                expectedWinRate: 0.5,
                vsExpectation: 0
            },
            form: { available: true, games: 20, winRate: recentRate }
        });

        it('reports a real swing in either direction', function () {
            expect(deriveFindings(withForm(0.75, 0.5)).some((f) => f.kind === 'formUp')).toBe(true);
            expect(deriveFindings(withForm(0.25, 0.5)).some((f) => f.kind === 'formDown')).toBe(
                true
            );
        });

        // Form that matches the lifetime rate is not news, and reporting it
        // would push a real finding off the top of the panel.
        it('stays quiet when form matches the record', function () {
            expect(deriveFindings(withForm(0.52, 0.5)).some((f) => f.id === 'form-drift')).toBe(
                false
            );
        });
    });

    describe('your best deck', function () {
        /**
         * The exact failure the rankings table's own marker exists to prevent,
         * reappearing one panel higher: this must never call a 1-0 deck
         * somebody's strongest.
         */
        it('will not crown a deck with no sample behind it', function () {
            const findings = deriveFindings({
                rankings: [
                    { deckId: 1, deckName: 'Fluke', games: 1, winRate: 1, confident: false },
                    { deckId: 2, deckName: 'Workhorse', games: 40, winRate: 0.65, confident: true }
                ]
            });

            const best = findings.find((finding) => finding.id === 'best-deck');

            expect(best).toBeDefined();
            expect(best.values.deckName).toBe('Workhorse');
        });

        it('says nothing when no deck has a real record yet', function () {
            const findings = deriveFindings({
                rankings: [{ deckId: 1, deckName: 'Fluke', games: 2, winRate: 1, confident: false }]
            });

            expect(findings).toEqual([]);
        });

        it('takes the threshold from the server when it sends one', function () {
            const rankings = [
                {
                    deckId: 1,
                    deckName: 'Borderline',
                    games: 12,
                    winRate: 0.75,
                    confident: true,
                    minConfidentGames: 25
                }
            ];

            // 12 games clears the local default but not the server's 25.
            expect(deriveFindings({ rankings })).toEqual([]);
        });
    });

    // A reader scanning the top of a page reads the first line, so the biggest
    // effect has to be the one that lands there.
    it('ranks the largest effect first', function () {
        const findings = deriveFindings({
            byHouse: [solidHouse('Untamed', 0.9), solidHouse('Dis', 0.1)],
            rankings: [{ deckId: 1, deckName: 'Steady', games: 40, winRate: 0.55, confident: true }]
        });

        expect(findings[0].id).toBe('house-spread');
        expect(findings[0].weight).toBeGreaterThan(findings[1].weight);
    });
});
