const TournamentLabService = require('../../../../server/services/membership/TournamentLabService');

/**
 * ARCHON (N24): what Deep Probe weighs.
 *
 * The page used to rank on the player's raw win percentage, which is the number
 * most distorted by who they happened to play: a 70% built out of games against
 * whatever three houses their local group likes says very little about an event.
 * So the ranking now weighs four things - ARI, the win rate against the meta as
 * it actually stands, what the player's own record can actually support (its 95%
 * lower bound, not its face value), and the Champion's Challenge.
 *
 * The arithmetic is pinned here rather than the rendering, because these are
 * claims about decks a player will act on:
 *
 *  - the meta-weighted win rate really is weighted by prevalence, and says how
 *    much of the field it rests on;
 *  - a thin record cannot outrank a long one on the strength of being lucky;
 *  - a missing term does not count as a zero (a deck with no Challenge games is
 *    ranked on the rest, not penalised);
 *  - field games count for more than mirror games, since a stranger's deck is
 *    the harder test.
 */
describe('Deep Probe ranking', function () {
    let lab;
    let db;

    const settingsService = { getSection: () => ({}) };

    beforeEach(function () {
        db = { query: vi.fn().mockResolvedValue([]) };
        lab = new TournamentLabService(db, {}, settingsService);
    });

    describe('metaWinRate', function () {
        // Two houses, wildly different prevalence: the deck is good against the
        // rare one and poor against the common one, so a prevalence-weighted
        // answer must land well below the flat average of the two.
        const meta = {
            available: true,
            rows: [
                { house: 'dis', prevalence: 0.8, appearances: 80 },
                { house: 'untamed', prevalence: 0.2, appearances: 20 }
            ]
        };

        it('weights each matchup by how common the house is', function () {
            const result = lab.metaWinRate(
                [
                    { house: 'dis', games: 20, winRate: 0.4 },
                    { house: 'untamed', games: 20, winRate: 0.9 }
                ],
                meta
            );

            // 0.4·0.8 + 0.9·0.2 = 0.5, over full coverage.
            expect(result.winRate).toBeCloseTo(0.5, 5);
            expect(result.coverage).toBeCloseTo(1, 5);
            expect(result.houses).toBe(2);
            // The flat average would have flattered the deck.
            expect(result.winRate).toBeLessThan(0.65);
        });

        it('normalises over the part of the field it can speak to', function () {
            const result = lab.metaWinRate([{ house: 'untamed', games: 20, winRate: 0.9 }], meta);

            // Only the 20% slice is covered, and the answer is that slice's rate
            // - NOT 0.9 x 0.2, which would read as "18% against the meta".
            expect(result.winRate).toBeCloseTo(0.9, 5);
            expect(result.coverage).toBeCloseTo(0.2, 5);
            expect(result.houses).toBe(1);
        });

        it('ignores houses with too few games to mean anything', function () {
            const result = lab.metaWinRate(
                [
                    { house: 'dis', games: 1, winRate: 1 },
                    { house: 'untamed', games: 20, winRate: 0.5 }
                ],
                meta
            );

            expect(result.houses).toBe(1);
            expect(result.winRate).toBeCloseTo(0.5, 5);
        });

        it('says nothing when there is no meta to weigh against', function () {
            expect(lab.metaWinRate([{ house: 'dis', games: 20, winRate: 1 }], null)).toEqual({
                winRate: null,
                coverage: 0,
                houses: 0
            });
            expect(
                lab.metaWinRate([{ house: 'dis', games: 20, winRate: 1 }], { available: false })
                    .winRate
            ).toBeNull();
        });
    });

    describe('rankDeck', function () {
        const base = {
            fieldAri: 65,
            sasWeight: 0.5,
            metaWinRate: { winRate: 0.55, coverage: 0.9, houses: 5 },
            overview: { games: 30, winRate: 0.6 },
            challenge: {
                mirror: { games: 100, winRate: 0.5 },
                field: { games: 50, winRate: 0.6 }
            }
        };

        it('weighs all four terms when all four exist', function () {
            const { score, components } = lab.rankDeck({ ...base, ari: 80 });

            expect(Object.keys(components).sort()).toEqual(['ari', 'challenge', 'meta', 'record']);
            expect(score).toBeGreaterThan(0);
            expect(score).toBeLessThan(1);
            // ARI above the field reads as an expectation above even.
            expect(components.ari.value).toBeGreaterThan(0.5);
            expect(components.ari.detail).toEqual({ ari: 80, fieldAri: 65 });
        });

        // The score ORDERS decks - two of its terms are lower bounds, so its
        // absolute value is not a win probability and a good deck can sit below
        // 0.5. What must hold is that better evidence ranks higher.
        it('ranks a stronger deck above a weaker one on every term', function () {
            const stronger = lab.rankDeck({
                ...base,
                ari: 85,
                metaWinRate: { winRate: 0.62, coverage: 0.9, houses: 5 },
                overview: { games: 40, winRate: 0.65 }
            });
            const weaker = lab.rankDeck({
                ...base,
                ari: 55,
                metaWinRate: { winRate: 0.45, coverage: 0.9, houses: 5 },
                overview: { games: 40, winRate: 0.45 }
            });

            expect(stronger.score).toBeGreaterThan(weaker.score);
        });

        it('ranks on ARI when the records are identical', function () {
            const highAri = lab.rankDeck({ ...base, ari: 85 });
            const lowAri = lab.rankDeck({ ...base, ari: 55 });

            expect(highAri.score).toBeGreaterThan(lowAri.score);
        });

        it('does not count a missing term as a zero', function () {
            const withoutChallenge = lab.rankDeck({ ...base, ari: 65, challenge: null });

            expect(withoutChallenge.components.challenge).toBeUndefined();
            // Dropping a term must renormalise the weights, not count it as a
            // zero: the remaining terms decide the score on their own.
            const remaining = Object.values(withoutChallenge.components);
            const expected =
                remaining.reduce((sum, part) => sum + part.weight * part.value, 0) /
                remaining.reduce((sum, part) => sum + part.weight, 0);

            expect(withoutChallenge.score).toBeCloseTo(expected, 10);
            // And a deck with no sparring history is not dragged below a deck
            // whose sparring went badly.
            expect(withoutChallenge.score).toBeGreaterThan(
                lab.rankDeck({
                    ...base,
                    ari: 65,
                    challenge: {
                        mirror: { games: 100, winRate: 0.2 },
                        field: { games: 50, winRate: 0.2 }
                    }
                }).score
            );
        });

        it('will not let a 3-0 outrank a long solid record', function () {
            const lucky = lab.rankDeck({
                ...base,
                ari: null,
                challenge: null,
                overview: { games: 3, winRate: 1 }
            });
            const proven = lab.rankDeck({
                ...base,
                ari: null,
                challenge: null,
                overview: { games: 40, winRate: 0.62 }
            });

            expect(lucky.components.record.value).toBeLessThan(0.75);
            expect(proven.score).toBeGreaterThan(lucky.score);
        });

        it('counts field games for more than mirror games', function () {
            const strongField = lab.rankDeck({
                ...base,
                ari: null,
                challenge: {
                    mirror: { games: 50, winRate: 0.4 },
                    field: { games: 50, winRate: 0.8 }
                }
            });
            const strongMirror = lab.rankDeck({
                ...base,
                ari: null,
                challenge: {
                    mirror: { games: 50, winRate: 0.8 },
                    field: { games: 50, winRate: 0.4 }
                }
            });

            expect(strongField.components.challenge.value).toBeGreaterThan(
                strongMirror.components.challenge.value
            );
        });

        it('has nothing to say about a deck with no evidence at all', function () {
            const { score, components } = lab.rankDeck({
                ari: null,
                fieldAri: 65,
                sasWeight: 0.5,
                metaWinRate: { winRate: null, coverage: 0, houses: 0 },
                overview: { games: 0, winRate: null },
                challenge: null
            });

            expect(score).toBeNull();
            expect(components).toEqual({});
        });
    });

    describe('summariseRanking', function () {
        const deck = (id, score, metaRate, name) => ({
            deckId: id,
            deckName: name || `Deck ${id}`,
            score,
            confident: true,
            vsMeta: { winRate: metaRate, coverage: 0.8, houses: 4 }
        });

        it('names the best all-round deck and the best against the meta', function () {
            // Deliberately different decks: the interesting case, and the one the
            // page exists to surface.
            const summary = lab.summariseRanking([
                deck(1, 0.7, 0.5, 'All rounder'),
                deck(2, 0.6, 0.8, 'Meta caller')
            ]);

            expect(summary.bestOverall.deckId).toBe(1);
            expect(summary.bestVsMeta.deckId).toBe(2);
            expect(summary.bestVsMeta.winRate).toBe(0.8);
            expect(summary.order).toEqual([1, 2]);
        });

        it('skips decks with nothing to rank on', function () {
            const summary = lab.summariseRanking([
                { deckId: 1, deckName: 'Unplayed', score: null, vsMeta: { winRate: null } },
                deck(2, 0.6, 0.55)
            ]);

            expect(summary.bestOverall.deckId).toBe(2);
            expect(summary.order).toEqual([2]);
        });

        it('carries the thin-sample warning up to the headline', function () {
            const thin = { ...deck(1, 0.9, 0.9), confident: false };
            const summary = lab.summariseRanking([thin]);

            expect(summary.bestOverall.confident).toBe(false);
        });

        it('answers with nulls rather than a guess when nothing qualifies', function () {
            expect(lab.summariseRanking([])).toEqual({
                bestOverall: null,
                bestVsMeta: null,
                order: []
            });
        });
    });

    describe('the Challenge evidence', function () {
        it('reads mirror and field records separately, never summed', async function () {
            db.query.mockImplementation(async (sql) => {
                if (sql.includes('"ProvingGroundsGames"')) {
                    return [{ DeckId: 7, Played: 40, Wins: 24 }];
                }

                if (sql.includes('"GauntletGames"')) {
                    return [{ DeckId: 7, Played: 20, Wins: 8, AvgOpponentSas: 74.2 }];
                }

                return [];
            });

            const records = await lab.challengeRecords(1, [7]);

            expect(records.get(7).mirror).toEqual({ games: 40, wins: 24, winRate: 0.6 });
            expect(records.get(7).field).toEqual({
                games: 20,
                wins: 8,
                winRate: 0.4,
                avgOpponentSas: 74.2
            });
        });

        it('gives a deck with no Challenge history zeros, not a failure', async function () {
            const records = await lab.challengeRecords(1, [7]);

            expect(records.get(7).mirror.games).toBe(0);
            expect(records.get(7).field.winRate).toBeNull();
        });

        it('falls back to the SAS distribution when no ARI has moved yet', async function () {
            db.query.mockImplementation(async (sql) => {
                if (sql.includes('"DeckAri"')) {
                    return [{ Ari: null }];
                }

                if (sql.includes('"DeckSas"')) {
                    return [{ Sas: 68.5 }];
                }

                return [];
            });

            expect(await lab.fieldAri()).toBe(68.5);
        });

        it('assumes a middling field when the platform has no decks at all', async function () {
            expect(await lab.fieldAri()).toBe(65);
        });
    });
});
