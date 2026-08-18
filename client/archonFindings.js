/**
 * ARCHON: the headline findings on Archon Intelligence.
 *
 * The page renders fifteen panels of tables and, until this existed, left the
 * reading of them entirely to the player. That is a lot of numbers to hand
 * somebody with no statement about which of them matter, and the two that do
 * are rarely the two a reader happens to look at first. The AERC lens already
 * had a version of this - `aerc.findings`, sentences ranked by the size of the
 * gap - and it was the best thing on the page while being reachable only by
 * switching to a lens most players never touch.
 *
 * So this is that idea applied to the payload the page already has. Every
 * finding below is derived from data the client has already been sent: no new
 * request is made, no number is invented, and nothing here computes a
 * statistic the panels underneath would disagree with.
 *
 * ## The rules a finding has to pass
 *
 * 1. It must be countable. Every sentence names the games behind it, so a
 *    reader can dismiss one that rests on nothing.
 * 2. It must clear the sample threshold on BOTH sides of any comparison. The
 *    whole failure mode of a "what stands out" panel is that the most striking
 *    gap in a small dataset is noise, and noise is exactly what "stands out"
 *    selects for.
 * 3. It must be a record, not a cause. "You win less against Dis" is true;
 *    "Dis beats you" is a claim about why, and nothing here knows why.
 *
 * Findings are returned strongest-first by `weight`, which is the size of the
 * effect rather than a confidence - a reader deciding what to work on wants
 * the biggest gap at the top.
 */

/**
 * Games behind a figure before it is allowed into the headline.
 *
 * Matches the server's MIN_CONFIDENT_GAMES so the panel cannot call something
 * a finding while the table below it flags the same row as too thin. The
 * server sends its own value on ranking rows; that is preferred when present,
 * and this is the fallback for payload shapes that do not carry it.
 */
export const MIN_FINDING_GAMES = 10;

/** Both sides of a comparison need a sample, not just the flattering one. */
const clears = (games, min) => (games || 0) >= min;

const rate = (value) => (value === null || value === undefined ? null : value);

/**
 * Turn the player payload into ranked, plain-language findings.
 *
 * @param {object} player the /api/intelligence/player payload
 * @param {{min?: number}} [options]
 * @returns {Array<{id: string, kind: string, weight: number, values: object}>}
 *   `values` carries the numbers; the caller owns the wording, so translation
 *   stays in the component and this module stays testable without i18n.
 */
export const deriveFindings = (player, { min } = {}) => {
    if (!player) {
        return [];
    }

    const rankings = player.rankings || [];
    // Prefer the server's threshold so the two cannot drift apart.
    const threshold =
        min ??
        rankings.find((deck) => deck.minConfidentGames)?.minConfidentGames ??
        MIN_FINDING_GAMES;

    const findings = [];

    // --- Are you beating what your rating expected? --------------------------
    // The single most useful number in the product, per the service that
    // computes it, and it was rendered as one stat tile among four.
    const vs = player.vsExpectation;

    if (vs?.available && clears(vs.games, threshold) && vs.vsExpectation !== null) {
        findings.push({
            id: 'vs-expectation',
            kind: vs.vsExpectation >= 0 ? 'aheadOfRating' : 'behindRating',
            // Wins above prediction is already an absolute count of games, so
            // it needs no scaling to be comparable with a percentage gap.
            weight: Math.abs(vs.vsExpectation) / Math.max(vs.games, 1),
            values: {
                games: vs.games,
                gap: Math.abs(vs.vsExpectation),
                winRate: rate(vs.winRate),
                expectedWinRate: rate(vs.expectedWinRate)
            }
        });
    }

    // --- Which houses actually beat you? -------------------------------------
    // Both ends must clear the threshold: the widest gap in a thin table is
    // the one most likely to be noise.
    const houses = (player.byHouse || []).filter(
        (row) => clears(row.games, threshold) && row.winRate !== null
    );

    if (houses.length >= 2) {
        const sorted = [...houses].sort((a, b) => b.winRate - a.winRate);
        const best = sorted[0];
        const worst = sorted[sorted.length - 1];

        if (best.house !== worst.house && best.winRate - worst.winRate > 0) {
            findings.push({
                id: 'house-spread',
                kind: 'houseSpread',
                weight: best.winRate - worst.winRate,
                values: {
                    bestHouse: best.houseName || best.house,
                    bestRate: best.winRate,
                    bestGames: best.games,
                    worstHouse: worst.houseName || worst.house,
                    worstRate: worst.winRate,
                    worstGames: worst.games
                }
            });
        }
    }

    // --- Does going first decide your games? ---------------------------------
    const turn = player.byTurnOrder;

    if (
        turn?.available &&
        turn.edge !== null &&
        turn.edge !== undefined &&
        clears(turn.first?.games, threshold) &&
        clears(turn.second?.games, threshold)
    ) {
        findings.push({
            id: 'turn-order',
            kind: turn.edge >= 0 ? 'strongerFirst' : 'strongerSecond',
            weight: Math.abs(turn.edge),
            values: {
                edge: Math.abs(turn.edge),
                firstRate: turn.first.winRate,
                secondRate: turn.second.winRate,
                firstGames: turn.first.games,
                secondGames: turn.second.games
            }
        });
    }

    // --- Is your recent form different from your record? ---------------------
    // Only worth saying when the two disagree by enough to be a change rather
    // than a wobble; a run of form that matches the lifetime rate is not news.
    const form = player.form;

    if (
        form?.available &&
        clears(form.games, threshold) &&
        vs?.available &&
        vs.winRate !== null &&
        form.winRate !== null
    ) {
        const drift = form.winRate - vs.winRate;

        if (Math.abs(drift) >= 0.1) {
            findings.push({
                id: 'form-drift',
                kind: drift >= 0 ? 'formUp' : 'formDown',
                weight: Math.abs(drift),
                values: {
                    recentGames: form.games,
                    recentRate: form.winRate,
                    lifetimeRate: vs.winRate
                }
            });
        }
    }

    // --- Which of your decks is actually carrying you? -----------------------
    // Explicitly restricted to decks with a real sample, because this panel
    // naming a 1-0 deck as somebody's best is the exact failure the rankings
    // table's own marker exists to prevent.
    const solid = rankings.filter(
        (deck) => deck.confident && deck.winRate !== null && clears(deck.games, threshold)
    );

    if (solid.length) {
        const best = solid.reduce((top, deck) => (deck.winRate > top.winRate ? deck : top));

        findings.push({
            id: 'best-deck',
            kind: 'bestDeck',
            // Measured against an even record, so a 52% deck does not outrank
            // a genuine house spread.
            weight: Math.abs(best.winRate - 0.5),
            values: {
                deckName: best.deckName,
                winRate: best.winRate,
                games: best.games,
                set: best.set?.code || null
            }
        });
    }

    return findings.sort((a, b) => b.weight - a.weight);
};

export default deriveFindings;
