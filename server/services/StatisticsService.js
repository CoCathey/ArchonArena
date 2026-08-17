const db = require('../db');

// SAS rating bands (ascending, contiguous, open-ended at the top) used to
// bucket deck power for the meta win-rate-by-SAS chart. Single-sourced here so
// the generated SQL CASE and the pure JS labeller can never drift apart.
const SAS_BANDS = [
    { label: '<50', max: 50 },
    { label: '50-59', max: 60 },
    { label: '60-69', max: 70 },
    { label: '70-79', max: 80 },
    { label: '80-89', max: 90 },
    { label: '90+', max: Infinity }
];

const BAND_ORDER = SAS_BANDS.map((band) => band.label);

/**
 * Win rate as a one-decimal percentage (0-100), or null when there are no
 * games to divide by. Pure so it is trivially unit-testable and shared by
 * every aggregation below.
 */
function winRate(wins, games) {
    const w = Number(wins) || 0;
    const g = Number(games) || 0;

    if (g <= 0) {
        return null;
    }

    return Math.round((w / g) * 1000) / 10;
}

/**
 * The SAS band label a rating falls into, or null when unrated/non-numeric.
 * Mirrors sasBandCaseSql exactly (both walk SAS_BANDS in order).
 */
function sasBandLabel(sas) {
    if (sas === null || sas === undefined || sas === '' || Number.isNaN(Number(sas))) {
        return null;
    }

    const value = Number(sas);

    for (const band of SAS_BANDS) {
        if (value < band.max) {
            return band.label;
        }
    }

    return SAS_BANDS[SAS_BANDS.length - 1].label;
}

/**
 * Build the SQL CASE expression that buckets `column` into SAS_BANDS labels.
 * The labels are hard-coded constants (digits, '<', '-', '+') so there is no
 * injection surface; `column` is always a caller-supplied identifier literal.
 */
function sasBandCaseSql(column) {
    const whens = SAS_BANDS.filter((band) => Number.isFinite(band.max)).map(
        (band) => `WHEN ${column} < ${band.max} THEN '${band.label}'`
    );

    return `CASE ${whens.join(' ')} ELSE '${SAS_BANDS[SAS_BANDS.length - 1].label}' END`;
}

const round2 = (value) => (value == null ? null : Math.round(Number(value) * 100) / 100);
const roundInt = (value) => (value == null ? null : Math.round(Number(value)));

// A matchup cell needs enough games behind it to mean anything; below this a
// win rate is noise and is reported as null rather than as a number that will
// be read as a finding.
const MIN_MATCHUP_GAMES = 20;

// Likewise for "your best deck": one lucky game is not a callout.
const MIN_DECK_CALLOUT_GAMES = 5;

/**
 * ARCHON (N3): shape flat (house, opponent, games, wins) rows into the matrix
 * the dashboard renders - an ordered house list plus a lookup keyed
 * `house|opponent`.
 *
 * Cells thinner than MIN_MATCHUP_GAMES keep their game count but report a null
 * win rate: an empty cell says "not enough games" honestly, where 100% off two
 * games says something false confidently.
 */
function buildMatchupMatrix(rows) {
    const houses = [...new Set((rows || []).flatMap((row) => [row.house, row.opponent]))].sort();
    const cells = {};

    for (const row of rows || []) {
        const games = Number(row.games) || 0;
        const wins = Number(row.wins) || 0;

        cells[`${row.house}|${row.opponent}`] = {
            house: row.house,
            opponent: row.opponent,
            games,
            wins,
            winRate: games >= MIN_MATCHUP_GAMES ? winRate(wins, games) : null
        };
    }

    return { houses, cells, minGames: MIN_MATCHUP_GAMES };
}

/**
 * ARCHON: platform statistics & analytics.
 *
 * Aggregates finished, decided games (Games / GamePlayers / Decks / DeckHouses
 * / DeckSas) into a meta dashboard (house win rates, format share, deck-power
 * win rates, totals) and per-player breakdowns. Results are read-only and
 * expensive to compute over a growing game log, so each answer is memoised in
 * a small in-memory TTL cache; freshness within a minute or so is plenty for a
 * stats page.
 *
 * `db` is injectable (defaults to the shared PG pool) so the service is
 * unit-testable, matching RatingService / GameService.
 */
class StatisticsService {
    constructor(database = db, options = {}) {
        this.db = database;
        this.ttlMs = options.ttlMs ?? 60000;
        // Injectable clock so cache-expiry is deterministic under test.
        this.now = options.now || (() => Date.now());
        this.cache = new Map();
    }

    /** Memoise `producer` under `key` for ttlMs; recompute once it expires. */
    async cached(key, producer) {
        const now = this.now();
        const hit = this.cache.get(key);

        if (hit && hit.expires > now) {
            return hit.value;
        }

        const value = await producer();
        this.cache.set(key, { value, expires: now + this.ttlMs });

        return value;
    }

    clearCache() {
        this.cache.clear();
    }

    /** Meta dashboard across every finished, decided game. Cached. */
    async getMetaStats() {
        return this.cached('meta', () => this.computeMetaStats());
    }

    async computeMetaStats() {
        const [totalsRows, houseRows, formatRows, sasRows, setRows, matchupRows] =
            await Promise.all([
                // Game-level totals in one round-trip (subqueries keep the
                // players-level avg keys from double-counting the game rows).
                this.db.query(
                    'SELECT ' +
                        '(SELECT COUNT(*) FROM "Games" WHERE "FinishedAt" IS NOT NULL AND "BotGame" IS NOT TRUE) AS "finishedGames", ' +
                        '(SELECT COUNT(*) FROM "Games" WHERE "FinishedAt" IS NOT NULL AND "BotGame" IS NOT TRUE ' +
                        'AND "WinnerId" IS NOT NULL) AS "decidedGames", ' +
                        '(SELECT AVG(EXTRACT(EPOCH FROM ("FinishedAt" - "StartedAt"))) FROM "Games" ' +
                        'WHERE "FinishedAt" IS NOT NULL AND "BotGame" IS NOT TRUE AND "StartedAt" IS NOT NULL ' +
                        'AND "FinishedAt" > "StartedAt") AS "avgDurationSec", ' +
                        '(SELECT AVG(gp."Keys") FROM "GamePlayers" gp ' +
                        'JOIN "Games" g ON g."Id" = gp."GameId" ' +
                        'WHERE g."FinishedAt" IS NOT NULL AND g."BotGame" IS NOT TRUE AND g."WinnerId" IS NOT NULL) AS "avgKeys"'
                ),
                // Win rate per house: every deck contributes its three houses to
                // the games it played, won or lost.
                this.db.query(
                    'SELECT h."Name" AS "house", COUNT(*) AS "games", ' +
                        'COUNT(*) FILTER (WHERE gp."PlayerId" = g."WinnerId") AS "wins" ' +
                        'FROM "Games" g ' +
                        'JOIN "GamePlayers" gp ON gp."GameId" = g."Id" ' +
                        'JOIN "Decks" d ON d."Id" = gp."DeckId" ' +
                        'JOIN "DeckHouses" dh ON dh."DeckId" = d."Id" ' +
                        'JOIN "Houses" h ON h."Id" = dh."HouseId" ' +
                        'WHERE g."FinishedAt" IS NOT NULL AND g."BotGame" IS NOT TRUE AND g."WinnerId" IS NOT NULL ' +
                        'GROUP BY h."Name"'
                ),
                // Format distribution (one row per game, so count Games directly).
                this.db.query(
                    'SELECT "GameFormat" AS "format", COUNT(*) AS "games" ' +
                        'FROM "Games" WHERE "FinishedAt" IS NOT NULL AND "BotGame" IS NOT TRUE ' +
                        'GROUP BY "GameFormat" ORDER BY COUNT(*) DESC'
                ),
                // Win rate by deck-power band (joined to DeckSas via deck Uuid).
                this.db.query(
                    'SELECT ' +
                        sasBandCaseSql('ds."SasRating"') +
                        ' AS "band", COUNT(*) AS "games", ' +
                        'COUNT(*) FILTER (WHERE gp."PlayerId" = g."WinnerId") AS "wins" ' +
                        'FROM "Games" g ' +
                        'JOIN "GamePlayers" gp ON gp."GameId" = g."Id" ' +
                        'JOIN "Decks" d ON d."Id" = gp."DeckId" ' +
                        'JOIN "DeckSas" ds ON ds."Uuid" = d."Uuid" ' +
                        'WHERE g."FinishedAt" IS NOT NULL AND g."BotGame" IS NOT TRUE AND g."WinnerId" IS NOT NULL ' +
                        'AND ds."SasRating" IS NOT NULL ' +
                        'GROUP BY "band"'
                ),
                // ARCHON (N3): win rate per expansion. Which sets are actually
                // winning is the first question anyone asks of a card-game meta,
                // and the deck already carries its expansion.
                this.db.query(
                    'SELECT e."Name" AS "set", e."ExpansionId" AS "expansionId", ' +
                        'COUNT(*) AS "games", ' +
                        'COUNT(*) FILTER (WHERE gp."PlayerId" = g."WinnerId") AS "wins" ' +
                        'FROM "Games" g ' +
                        'JOIN "GamePlayers" gp ON gp."GameId" = g."Id" ' +
                        'JOIN "Decks" d ON d."Id" = gp."DeckId" ' +
                        'JOIN "Expansions" e ON e."Id" = d."ExpansionId" ' +
                        'WHERE g."FinishedAt" IS NOT NULL AND g."BotGame" IS NOT TRUE AND g."WinnerId" IS NOT NULL ' +
                        'GROUP BY e."Name", e."ExpansionId"'
                ),
                // ARCHON (N3): the house-vs-house matchup matrix.
                //
                // Every game contributes nine (myHouse, theirHouse) cells, because
                // each deck brings three houses - so a cell counts games in which
                // a deck containing that house faced a deck containing the other.
                // That is what a KeyForge matchup table means; it is not a count of
                // distinct games, and the row totals deliberately exceed them.
                this.db.query(
                    'SELECT h."Name" AS "house", oh."Name" AS "opponent", COUNT(*) AS "games", ' +
                        'COUNT(*) FILTER (WHERE gp."PlayerId" = g."WinnerId") AS "wins" ' +
                        'FROM "Games" g ' +
                        'JOIN "GamePlayers" gp ON gp."GameId" = g."Id" ' +
                        'JOIN "GamePlayers" ogp ON ogp."GameId" = g."Id" AND ogp."Id" <> gp."Id" ' +
                        'JOIN "Decks" d ON d."Id" = gp."DeckId" ' +
                        'JOIN "DeckHouses" dh ON dh."DeckId" = d."Id" ' +
                        'JOIN "Houses" h ON h."Id" = dh."HouseId" ' +
                        'JOIN "Decks" od ON od."Id" = ogp."DeckId" ' +
                        'JOIN "DeckHouses" odh ON odh."DeckId" = od."Id" ' +
                        'JOIN "Houses" oh ON oh."Id" = odh."HouseId" ' +
                        'WHERE g."FinishedAt" IS NOT NULL AND g."BotGame" IS NOT TRUE AND g."WinnerId" IS NOT NULL ' +
                        'GROUP BY h."Name", oh."Name"'
                )
            ]);

        const totals = (totalsRows && totalsRows[0]) || {};
        const formatTotal = (formatRows || []).reduce(
            (sum, row) => sum + (Number(row.games) || 0),
            0
        );

        return {
            generatedAt: new Date(this.now()).toISOString(),
            totals: {
                finishedGames: Number(totals.finishedGames) || 0,
                decidedGames: Number(totals.decidedGames) || 0,
                avgDurationSec: roundInt(totals.avgDurationSec),
                avgKeys: round2(totals.avgKeys)
            },
            // Sorted strongest-first for the horizontal bar chart.
            houses: (houseRows || [])
                .map((row) => ({
                    house: row.house,
                    games: Number(row.games) || 0,
                    wins: Number(row.wins) || 0,
                    winRate: winRate(row.wins, row.games)
                }))
                .sort((a, b) => (b.winRate ?? -1) - (a.winRate ?? -1)),
            formats: (formatRows || []).map((row) => {
                const games = Number(row.games) || 0;

                return {
                    format: row.format || 'unknown',
                    games,
                    share: formatTotal ? Math.round((games / formatTotal) * 1000) / 10 : null
                };
            }),
            // Kept in ascending band order for a readable left-to-right ramp.
            sasBands: (sasRows || [])
                .map((row) => ({
                    band: row.band,
                    games: Number(row.games) || 0,
                    wins: Number(row.wins) || 0,
                    winRate: winRate(row.wins, row.games)
                }))
                .sort((a, b) => BAND_ORDER.indexOf(a.band) - BAND_ORDER.indexOf(b.band)),
            // Newest set first: that is the one a player is deciding about.
            sets: (setRows || [])
                .map((row) => ({
                    set: row.set,
                    expansionId: Number(row.expansionId) || null,
                    games: Number(row.games) || 0,
                    wins: Number(row.wins) || 0,
                    winRate: winRate(row.wins, row.games)
                }))
                .sort((a, b) => (b.expansionId ?? 0) - (a.expansionId ?? 0)),
            houseMatchups: buildMatchupMatrix(matchupRows)
        };
    }

    /**
     * ARCHON: how each of a player's decks has actually performed, and how that
     * compares to what its SAS predicted.
     *
     * SAS says how strong a deck is on paper. This is the other half: whether it
     * wins for *you*. The delta column is the interesting one - a deck well above
     * its band's average win rate is one you pilot well, and a deck well below it
     * is one to reconsider regardless of its score.
     *
     * Cached like every other answer here; never computed in the game path.
     */
    async getDeckStats(username) {
        if (!username) {
            return null;
        }

        return this.cached(`decks:${String(username).toLowerCase()}`, () =>
            this.computeDeckStats(username)
        );
    }

    async computeDeckStats(username) {
        const userRows = await this.db.query(
            'SELECT "Id", "Username" FROM "Users" WHERE lower("Username") = lower($1)',
            [username]
        );
        const user = userRows && userRows[0];

        if (!user) {
            return null;
        }

        const [deckRows, bandRows, matchupRows] = await Promise.all([
            this.db.query(
                'SELECT d."Id", d."Name", d."Identity", ds."SasRating", ' +
                    'COUNT(*) AS "games", ' +
                    'COUNT(*) FILTER (WHERE gp."PlayerId" = g."WinnerId") AS "wins", ' +
                    'MAX(g."FinishedAt") AS "lastPlayed" ' +
                    'FROM "Games" g ' +
                    'JOIN "GamePlayers" gp ON gp."GameId" = g."Id" AND gp."PlayerId" = $1 ' +
                    'JOIN "Decks" d ON d."Id" = gp."DeckId" ' +
                    'LEFT JOIN "DeckSas" ds ON ds."Uuid" = d."Uuid" ' +
                    'WHERE g."FinishedAt" IS NOT NULL AND g."BotGame" IS NOT TRUE AND g."WinnerId" IS NOT NULL ' +
                    'GROUP BY d."Id", d."Name", d."Identity", ds."SasRating" ' +
                    'ORDER BY COUNT(*) DESC',
                [user.Id]
            ),
            // Site-wide win rate per SAS band, so "expected" is what decks of
            // this power actually achieve here rather than a guess.
            this.db.query(
                'SELECT ' +
                    sasBandCaseSql('ds."SasRating"') +
                    ' AS "band", COUNT(*) AS "games", ' +
                    'COUNT(*) FILTER (WHERE gp."PlayerId" = g."WinnerId") AS "wins" ' +
                    'FROM "Games" g ' +
                    'JOIN "GamePlayers" gp ON gp."GameId" = g."Id" ' +
                    'JOIN "Decks" d ON d."Id" = gp."DeckId" ' +
                    'JOIN "DeckSas" ds ON ds."Uuid" = d."Uuid" ' +
                    'WHERE g."FinishedAt" IS NOT NULL AND g."BotGame" IS NOT TRUE AND g."WinnerId" IS NOT NULL ' +
                    'AND ds."SasRating" IS NOT NULL GROUP BY "band"'
            ),
            // ARCHON (N3): this player's record against each opposing house -
            // the "who beats me" half of deck intelligence. Every game
            // contributes the opponent's three houses.
            this.db.query(
                'SELECT oh."Name" AS "opponent", COUNT(*) AS "games", ' +
                    'COUNT(*) FILTER (WHERE gp."PlayerId" = g."WinnerId") AS "wins" ' +
                    'FROM "Games" g ' +
                    'JOIN "GamePlayers" gp ON gp."GameId" = g."Id" AND gp."PlayerId" = $1 ' +
                    'JOIN "GamePlayers" ogp ON ogp."GameId" = g."Id" AND ogp."PlayerId" <> $1 ' +
                    'JOIN "Decks" od ON od."Id" = ogp."DeckId" ' +
                    'JOIN "DeckHouses" odh ON odh."DeckId" = od."Id" ' +
                    'JOIN "Houses" oh ON oh."Id" = odh."HouseId" ' +
                    'WHERE g."FinishedAt" IS NOT NULL AND g."BotGame" IS NOT TRUE AND g."WinnerId" IS NOT NULL ' +
                    'GROUP BY oh."Name"',
                [user.Id]
            )
        ]);

        const bandWinRate = {};
        for (const row of bandRows || []) {
            bandWinRate[row.band] = winRate(row.wins, row.games);
        }

        const decks = (deckRows || []).map((row) => {
            const games = Number(row.games) || 0;
            const wins = Number(row.wins) || 0;
            const rate = winRate(wins, games);
            const band = sasBandLabel(row.SasRating);
            const expected = band ? bandWinRate[band] : null;

            return {
                deckId: row.Id,
                name: row.Name,
                identity: row.Identity,
                sasRating: row.SasRating,
                sasBand: band,
                games,
                wins,
                losses: Math.max(0, games - wins),
                winRate: rate,
                expectedWinRate: expected,
                // Positive: this deck beats what its power predicts.
                sasDelta:
                    rate != null && expected != null
                        ? Math.round((rate - expected) * 10) / 10
                        : null,
                lastPlayed: row.lastPlayed
            };
        });

        // ARCHON (N3): the record against each opposing house, best first.
        const matchups = (matchupRows || [])
            .map((row) => {
                const games = Number(row.games) || 0;
                const wins = Number(row.wins) || 0;

                return {
                    opponentHouse: row.opponent,
                    games,
                    wins,
                    losses: Math.max(0, games - wins),
                    winRate: games >= MIN_MATCHUP_GAMES ? winRate(wins, games) : null
                };
            })
            .sort((a, b) => (b.winRate ?? -1) - (a.winRate ?? -1));

        const ranked = matchups.filter((entry) => entry.winRate != null);

        return {
            username: user.Username,
            decks,
            matchups,
            // Only meaningful once there is a matchup on each end - with one
            // qualifying house, "best" and "worst" would be the same row
            // presented as two findings.
            bestMatchup: ranked.length >= 2 ? ranked[0] : null,
            worstMatchup: ranked.length >= 2 ? ranked[ranked.length - 1] : null,
            ...this.deckCallouts(decks)
        };
    }

    /**
     * ARCHON (N3): "your best deck" / "your worst deck".
     *
     * Ranked by how far a deck beats what its SAS band predicts, not by raw win
     * rate - a 45% win rate with a weak deck is a better piloting result than
     * 55% with the strongest deck on the site, and raw win rate would call the
     * second one your best deck. Decks with no SAS (so no expectation) fall
     * back to win rate, and anything under MIN_DECK_CALLOUT_GAMES is ignored.
     */
    deckCallouts(decks) {
        const eligible = (decks || []).filter(
            (deck) => deck.games >= MIN_DECK_CALLOUT_GAMES && deck.winRate != null
        );

        if (eligible.length === 0) {
            return { bestDeck: null, worstDeck: null, calloutMinGames: MIN_DECK_CALLOUT_GAMES };
        }

        const score = (deck) => (deck.sasDelta != null ? deck.sasDelta : deck.winRate - 50);
        const sorted = [...eligible].sort((a, b) => score(b) - score(a));

        return {
            bestDeck: sorted[0],
            // One eligible deck is your best deck and nothing else; calling it
            // your worst as well would be a true statement that reads as a
            // criticism.
            worstDeck: sorted.length >= 2 ? sorted[sorted.length - 1] : null,
            calloutMinGames: MIN_DECK_CALLOUT_GAMES
        };
    }

    /**
     * Per-player breakdown by username (case-insensitive). Cached per player.
     * Returns null when the username does not exist.
     */
    async getPlayerStats(username) {
        if (!username) {
            return null;
        }

        return this.cached(`player:${String(username).toLowerCase()}`, () =>
            this.computePlayerStats(username)
        );
    }

    async computePlayerStats(username) {
        const userRows = await this.db.query(
            'SELECT "Id", "Username" FROM "Users" WHERE lower("Username") = lower($1)',
            [username]
        );

        const user = userRows && userRows[0];

        if (!user) {
            return null;
        }

        const userId = user.Id;

        const [overallRows, formatRows, houseRows] = await Promise.all([
            this.db.query(
                'SELECT COUNT(*) AS "games", ' +
                    'COUNT(*) FILTER (WHERE g."WinnerId" = $1) AS "wins", ' +
                    'AVG(gp."Keys") AS "avgKeys", ' +
                    'AVG(EXTRACT(EPOCH FROM (g."FinishedAt" - g."StartedAt"))) ' +
                    'FILTER (WHERE g."StartedAt" IS NOT NULL AND g."FinishedAt" > g."StartedAt") ' +
                    'AS "avgDurationSec" ' +
                    'FROM "Games" g ' +
                    'JOIN "GamePlayers" gp ON gp."GameId" = g."Id" AND gp."PlayerId" = $1 ' +
                    'WHERE g."FinishedAt" IS NOT NULL AND g."BotGame" IS NOT TRUE AND g."WinnerId" IS NOT NULL',
                [userId]
            ),
            this.db.query(
                'SELECT g."GameFormat" AS "format", COUNT(*) AS "games", ' +
                    'COUNT(*) FILTER (WHERE g."WinnerId" = $1) AS "wins" ' +
                    'FROM "Games" g ' +
                    'JOIN "GamePlayers" gp ON gp."GameId" = g."Id" AND gp."PlayerId" = $1 ' +
                    'WHERE g."FinishedAt" IS NOT NULL AND g."BotGame" IS NOT TRUE AND g."WinnerId" IS NOT NULL ' +
                    'GROUP BY g."GameFormat"',
                [userId]
            ),
            this.db.query(
                'SELECT h."Name" AS "house", COUNT(*) AS "games", ' +
                    'COUNT(*) FILTER (WHERE g."WinnerId" = $1) AS "wins" ' +
                    'FROM "Games" g ' +
                    'JOIN "GamePlayers" gp ON gp."GameId" = g."Id" AND gp."PlayerId" = $1 ' +
                    'JOIN "Decks" d ON d."Id" = gp."DeckId" ' +
                    'JOIN "DeckHouses" dh ON dh."DeckId" = d."Id" ' +
                    'JOIN "Houses" h ON h."Id" = dh."HouseId" ' +
                    'WHERE g."FinishedAt" IS NOT NULL AND g."BotGame" IS NOT TRUE AND g."WinnerId" IS NOT NULL ' +
                    'GROUP BY h."Name"',
                [userId]
            )
        ]);

        const overall = (overallRows && overallRows[0]) || {};
        const games = Number(overall.games) || 0;
        const wins = Number(overall.wins) || 0;

        return {
            username: user.Username,
            overall: {
                games,
                wins,
                losses: Math.max(0, games - wins),
                winRate: winRate(wins, games),
                avgKeys: round2(overall.avgKeys),
                avgDurationSec: roundInt(overall.avgDurationSec)
            },
            formats: (formatRows || [])
                .map((row) => {
                    const g = Number(row.games) || 0;
                    const w = Number(row.wins) || 0;

                    return {
                        format: row.format || 'unknown',
                        games: g,
                        wins: w,
                        losses: Math.max(0, g - w),
                        winRate: winRate(w, g)
                    };
                })
                .sort((a, b) => b.games - a.games),
            houses: (houseRows || [])
                .map((row) => {
                    const g = Number(row.games) || 0;
                    const w = Number(row.wins) || 0;

                    return { house: row.house, games: g, wins: w, winRate: winRate(w, g) };
                })
                .sort((a, b) => (b.winRate ?? -1) - (a.winRate ?? -1))
        };
    }
}

module.exports = StatisticsService;
module.exports.winRate = winRate;
module.exports.sasBandLabel = sasBandLabel;
module.exports.sasBandCaseSql = sasBandCaseSql;
module.exports.SAS_BANDS = SAS_BANDS;
