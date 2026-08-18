const logger = require('../../log');
const { expectedScore } = require('./EloCalculator');
const { confidenceOf, kMultiplier } = require('./ariConfidence');

/**
 * ARCHON (N19): ARI, the Archon Rating Index - the platform's living deck
 * rating, and the deck-strength input the Amber ladder actually uses.
 *
 * The idea in one paragraph: SAS and AERC are estimates of a deck computed
 * from its card list - somebody's model of what the cards *should* do. ARI
 * starts there (the seed is the SAS/AERC midpoint) and then does what a
 * rating is supposed to do: it moves with results. Every rated real game and
 * every Champion's Challenge sparring game nudges the two decks' ARIs
 * Elo-fashion - the winner's up, the loser's down, by more when the result
 * was surprising - so a deck that keeps beating what the card math predicted
 * carries a number that says so, everywhere the platform prices decks.
 *
 * It lives on the SAS scale on purpose. The Elo engine already knows how to
 * spend a deck-strength differential (`sasWeight` rating points per point of
 * difference); handing it ARI instead of SAS changes what the number knows,
 * not what any formula does. One scale, one exchange rate, no second system.
 *
 * Three rules keep it honest:
 *
 *  - **A missing rating stays missing.** A deck with no SAS and no AERC has
 *    no seed and no ARI, and the Elo engine treats the game as it always
 *    treated unknown decks: no deck term at all. Zero is a strength claim,
 *    not an absence.
 *  - **Real games outrank sparring.** Rated games move ARI at `gameK`;
 *    Champion's Challenge games at `simGameK` (half by default) - the bot
 *    plays plainly, so its evidence is real but weaker. Both counters are
 *    kept, so "how much of this number is sparring" always has an answer.
 *  - **A provisional rating moves faster than a settled one** (N34). K is
 *    multiplied by the deck's deviation, so the first games after the seed
 *    move a deck a long way and the three-hundredth refines it. The configured
 *    K is what a SETTLED deck gets, so tuning it means what it always meant.
 *    See `ariConfidence`.
 *  - **The update is symmetric and bounded.** Both decks move by the same
 *    amount in opposite directions (expected scores sum to one), and ARI is
 *    clamped to a sane band so no anomaly can print a thousand-point deck.
 *
 * Updates are best-effort by design: they run after the game's rating commit
 * and a failure here must never unrate a game, so callers get a logged
 * `false` rather than a throw.
 */

/** ARI can never leave this band, whatever the results say. */
const ARI_MIN = 1;
const ARI_MAX = 150;

/**
 * The seed: where a deck's ARI starts before any game has moved it.
 *
 * The SAS/AERC midpoint when both exist - SAS is DoK's synergy-adjusted
 * verdict, AERC its raw component total, and the midpoint keeps a deck whose
 * synergies the model over- or under-prices from starting at the extreme -
 * or whichever one exists alone. Null when neither does.
 *
 * @param {number|null|undefined} sas
 * @param {number|null|undefined} aerc
 * @returns {number|null}
 */
function seedAri(sas, aerc) {
    const hasSas = sas !== null && sas !== undefined;
    const hasAerc = aerc !== null && aerc !== undefined;

    if (hasSas && hasAerc) {
        return clampAri((Number(sas) + Number(aerc)) / 2);
    }

    if (hasSas) {
        return clampAri(Number(sas));
    }

    if (hasAerc) {
        return clampAri(Number(aerc));
    }

    return null;
}

function clampAri(value) {
    return Math.min(ARI_MAX, Math.max(ARI_MIN, value));
}

/**
 * A deck's effective ARI from the columns readers already join: the stored,
 * game-adjusted value when the engine has ever touched the deck, otherwise
 * the seed. This is THE definition of "every deck has an ARI" - one
 * function, used by the rating engine, the deck lists and the Challenge
 * alike.
 *
 * @param {{Ari?: number|null, SasRating?: number|null, AercScore?: number|null}} row
 * @returns {number|null}
 */
function effectiveAri(row) {
    if (!row) {
        return null;
    }

    if (row.Ari !== null && row.Ari !== undefined) {
        return clampAri(Number(row.Ari));
    }

    return seedAri(row.SasRating, row.AercScore);
}

/**
 * `effectiveAri`, written as SQL, for the one thing the function cannot do:
 * let the database ORDER BY a deck's ARI.
 *
 * A query that decorates its rows with ARI in JavaScript can only sort the rows
 * it fetched, which for a paginated list means sorting one page of an
 * arbitrarily ordered collection - "highest ARI" becomes "highest ARI on page
 * one". So the expression has to exist in both languages, and the two have to
 * agree: a listing ordered by one definition and labelled with the other is
 * worse than no sort at all, because it looks right.
 *
 * Assumes the caller's joins are aliased `da` (DeckAri) and `ds` (DeckSas),
 * which is what every reader of these two tables already does. NULL when the
 * deck has neither a stored rating nor a seed - so ORDER BY still needs its own
 * NULLS LAST; a deck nobody has rated is not a deck rated zero.
 */
const EFFECTIVE_ARI_SQL =
    `LEAST(${ARI_MAX}, GREATEST(${ARI_MIN}, COALESCE(da."Ari", ` +
    'CASE WHEN ds."SasRating" IS NOT NULL AND ds."AercScore" IS NOT NULL ' +
    'THEN (ds."SasRating" + ds."AercScore") / 2.0 ' +
    'WHEN ds."SasRating" IS NOT NULL THEN ds."SasRating" ' +
    'ELSE ds."AercScore" END)))';

class AriService {
    constructor(db = require('../../db'), settingsService = require('../settings')) {
        this.db = db;
        this.settingsService = settingsService;
    }

    /**
     * Current ARI (with seed fallback) and sample counters for a set of deck
     * uuids, one query.
     *
     * @param {string[]} uuids
     * @returns {Promise<Map<string, {ari: number|null, games: number, simGames: number}>>}
     */
    async ariForUuids(uuids) {
        const wanted = [...new Set((uuids || []).filter(Boolean))];
        const result = new Map();

        if (!wanted.length) {
            return result;
        }

        const rows = await this.db.query(
            'SELECT ds."Uuid", ds."SasRating", ds."AercScore", da."Ari", ' +
                'da."RatedGames", da."SimGames", da."LastGameAt" ' +
                'FROM "DeckSas" ds LEFT JOIN "DeckAri" da ON da."Uuid" = ds."Uuid" ' +
                'WHERE ds."Uuid" = ANY($1)',
            [wanted]
        );

        for (const row of rows || []) {
            const record = {
                ratedGames: row.RatedGames || 0,
                simGames: row.SimGames || 0,
                lastGameAt: row.LastGameAt || null
            };

            result.set(row.Uuid, {
                ari: effectiveAri(row),
                ...record,
                // ARCHON (N34): computed rather than read back, so the stored
                // column can never disagree with the counters it is derived
                // from. The column exists for SQL readers and for the day a
                // deviation stops being a pure function of the counters.
                ...confidenceOf(record, this.confidenceOptions())
            });
        }

        return result;
    }

    /**
     * The confidence knobs, from settings when a settings service was handed
     * over and the module defaults otherwise. Read per call: an operator who
     * changes how fast ratings settle should not have to restart the site.
     */
    confidenceOptions() {
        if (!this.settingsService) {
            return {};
        }

        try {
            const section = this.settingsService.getSectionWithDefaults('rating');

            return (section && section.ari) || {};
        } catch (err) {
            logger.warn(`ARI: could not read confidence settings: ${err.message}`);

            return {};
        }
    }

    /**
     * Fold one decided game into both decks' ARIs.
     *
     * The surprise is measured against the winner's expected score - for real
     * games the caller passes the expectation the Elo engine actually used
     * (players AND decks), so ARI absorbs only what player ratings could not
     * explain; for sparring games (no players involved) it passes the
     * ARI-only expectation. Both decks move by the same amount because
     * expected scores sum to one.
     *
     * @param {object} params
     * @param {string} params.winnerUuid
     * @param {string} params.loserUuid
     * @param {number} [params.winnerExpected] expected score of the winning
     *        side, 0..1. Omit for sparring games and the update measures
     *        against the decks' current ARIs alone - the right baseline when
     *        no player ratings were in play.
     * @param {number} params.k rating points of ARI movement per unit surprise (Elo scale)
     * @param {number} params.sasWeight the elo config's SAS exchange rate
     * @param {boolean} [params.sim] whether this was a Champion’s Challenge game
     * @returns {Promise<boolean>} whether an update was written
     */
    async applyGameResult({ winnerUuid, loserUuid, winnerExpected, k, sasWeight, sim = false }) {
        try {
            if (!winnerUuid || !loserUuid || winnerUuid === loserUuid) {
                return false;
            }

            const weight = Number(sasWeight);

            if (!Number.isFinite(weight) || weight <= 0 || !Number.isFinite(k) || k <= 0) {
                // sasWeight 0 means the admin has switched deck strength out
                // of the rating model entirely; ARI follows it out.
                return false;
            }

            const current = await this.ariForUuids([winnerUuid, loserUuid]);
            const winner = current.get(winnerUuid);
            const loser = current.get(loserUuid);

            if (!winner || !loser || winner.ari === null || loser.ari === null) {
                // No seed on one side: nothing to move. See the header - zero
                // would be a claim, not an absence.
                return false;
            }

            const expected =
                winnerExpected !== undefined && winnerExpected !== null
                    ? Number(winnerExpected)
                    : expectedScore(0, 0, winner.ari - loser.ari, { sasWeight: weight });
            const surprise = 1 - expected;

            // K is on the Elo scale like every other knob; dividing by the
            // exchange rate lands the step back on the SAS scale.
            const step = (k / weight) * surprise;

            // ARCHON (N34): each side moves by its OWN confidence.
            //
            // Not a shared multiplier, because the two decks are rarely equally
            // known: a brand new deck beating a veteran should move a long way
            // while the veteran barely notices, which is the whole point of
            // rating a provisional deck faster. The symmetry that matters -
            // expected scores summing to one - is upstream of this and is
            // untouched; what breaks here is only the accidental symmetry of
            // both decks having the same amount to learn.
            const options = this.confidenceOptions();

            await Promise.all([
                this.upsertAri(
                    winnerUuid,
                    clampAri(winner.ari + step * kMultiplier(winner, options)),
                    sim,
                    winner
                ),
                this.upsertAri(
                    loserUuid,
                    clampAri(loser.ari - step * kMultiplier(loser, options)),
                    sim,
                    loser
                )
            ]);

            return true;
        } catch (err) {
            // Best-effort by contract: a failed ARI update must never unrate
            // a game or fail a sweep.
            logger.error('ARI update failed for %s vs %s: %s', winnerUuid, loserUuid, err.message);

            return false;
        }
    }

    /** @private */
    async upsertAri(uuid, ari, sim, before = null) {
        const gameIncrement = sim ? 0 : 1;
        const simIncrement = sim ? 1 : 0;
        // The deviation AFTER this game, which is the one a reader wants: the
        // row should say how sure the platform is now, not how sure it was
        // before the result that just landed.
        const { deviation } = confidenceOf(
            {
                ratedGames: ((before && before.ratedGames) || 0) + gameIncrement,
                simGames: ((before && before.simGames) || 0) + simIncrement,
                lastGameAt: new Date()
            },
            this.confidenceOptions()
        );

        await this.db.query(
            'INSERT INTO "DeckAri" ("Uuid", "Ari", "RatedGames", "SimGames", "Deviation", ' +
                '"LastGameAt", "UpdatedAt") ' +
                "VALUES ($1, $2, $3, $4, $5, now() AT TIME ZONE 'utc', " +
                "now() AT TIME ZONE 'utc') " +
                'ON CONFLICT ("Uuid") DO UPDATE SET "Ari" = $2, ' +
                '"RatedGames" = "DeckAri"."RatedGames" + $3, ' +
                '"SimGames" = "DeckAri"."SimGames" + $4, ' +
                '"Deviation" = $5, "LastGameAt" = now() AT TIME ZONE \'utc\', ' +
                '"UpdatedAt" = now() AT TIME ZONE \'utc\'',
            [uuid, Math.round(ari * 10) / 10, gameIncrement, simIncrement, deviation]
        );
    }

    // ------------------------------------------------- where in the field

    /**
     * Rebuild the ARI distribution snapshot.
     *
     * Every deck with an effective ARI - stored or seeded - counted into whole
     * point buckets, with a running total. Bucketing is what makes this cheap
     * enough to be a scheduled job rather than a nightly ordeal: the band is
     * 1..150, so the result is at most a hundred and fifty rows however many
     * million decks the catalog holds.
     *
     * Deliberately a snapshot. A percentile computed per request is a scan of
     * every rated deck for every row of every deck list, to move a number that
     * changes by hundredths of a percent per game.
     *
     * Never throws; a stale distribution is a worse answer than a fresh one and
     * a much better answer than a failed deck list.
     *
     * @returns {Promise<number>} decks counted
     */
    async refreshDistribution() {
        try {
            const rows = await this.db.query(
                `SELECT FLOOR(${EFFECTIVE_ARI_SQL})::int AS "Bucket", COUNT(*)::int AS "Decks" ` +
                    'FROM "Decks" d ' +
                    'LEFT JOIN "DeckSas" ds ON ds."Uuid" = d."Uuid" ' +
                    'LEFT JOIN "DeckAri" da ON da."Uuid" = d."Uuid" ' +
                    `WHERE NOT COALESCE(d."Banned", false) AND ${EFFECTIVE_ARI_SQL} IS NOT NULL ` +
                    'GROUP BY 1 ORDER BY 1'
            );

            const buckets = rows || [];
            let running = 0;
            const values = [];

            for (const row of buckets) {
                running += row.Decks;
                values.push([row.Bucket, row.Decks, running]);
            }

            // Replaced wholesale in one transaction: a half-written
            // distribution would quote percentiles from two different days.
            await this.db.query('BEGIN');

            try {
                await this.db.query('DELETE FROM "AriDistribution"');

                if (values.length) {
                    await this.db.query(
                        'INSERT INTO "AriDistribution" ("Bucket", "Decks", "AtOrBelow") ' +
                            'SELECT * FROM UNNEST($1::int[], $2::int[], $3::bigint[])',
                        [
                            values.map((value) => value[0]),
                            values.map((value) => value[1]),
                            values.map((value) => value[2])
                        ]
                    );
                }

                await this.db.query(
                    'UPDATE "AriDistributionState" SET "TotalDecks" = $1, ' +
                        '"UpdatedAt" = now() AT TIME ZONE \'utc\' WHERE "Id" = 1',
                    [running]
                );
                await this.db.query('COMMIT');
            } catch (err) {
                await this.db.query('ROLLBACK');

                throw err;
            }

            return running;
        } catch (err) {
            logger.error('ARI: could not refresh the distribution: %s', err.message);

            return 0;
        }
    }

    /**
     * The snapshot, as a sorted bucket list plus its total. Cached for a minute
     * because a deck list asks once per page and the underlying rows are
     * rewritten by a scheduled job, not by any request.
     *
     * @returns {Promise<{buckets: Array<{bucket: number, atOrBelow: number}>, total: number, updatedAt: Date|null}>}
     */
    async distribution() {
        const now = Date.now();

        if (this.distributionCache && now - this.distributionCache.readAt < 60000) {
            return this.distributionCache.value;
        }

        const empty = { buckets: [], total: 0, updatedAt: null };

        try {
            const [buckets, state] = await Promise.all([
                this.db.query(
                    'SELECT "Bucket", "AtOrBelow" FROM "AriDistribution" ORDER BY "Bucket"'
                ),
                this.db.query(
                    'SELECT "TotalDecks", "UpdatedAt" FROM "AriDistributionState" WHERE "Id" = 1'
                )
            ]);
            const row = state && state[0];
            const value = {
                buckets: (buckets || []).map((entry) => ({
                    bucket: entry.Bucket,
                    atOrBelow: Number(entry.AtOrBelow)
                })),
                total: row ? Number(row.TotalDecks) : 0,
                updatedAt: row ? row.UpdatedAt : null
            };

            this.distributionCache = { readAt: now, value };

            return value;
        } catch (err) {
            logger.error('ARI: could not read the distribution: %s', err.message);

            return empty;
        }
    }

    /**
     * Where an ARI sits in the field: percentile, rank, and the size of the
     * field it was ranked against.
     *
     * Percentile is the share of decks this one is AT OR ABOVE, so a deck at
     * the top of the band reads 100 and the median reads 50. Rank counts from
     * the top, which is the direction people say ranks in.
     *
     * Null when there is no snapshot to compare against - an unranked deck says
     * so rather than claiming the middle.
     *
     * @param {number|null} ari
     * @param {{buckets: Array, total: number}} snapshot
     * @returns {{percentile: number, rank: number, of: number}|null}
     */
    static placeIn(ari, snapshot) {
        if (ari === null || ari === undefined || !snapshot || !snapshot.total) {
            return null;
        }

        const bucket = Math.floor(Number(ari));
        let atOrBelow = 0;

        for (const entry of snapshot.buckets) {
            if (entry.bucket > bucket) {
                break;
            }

            atOrBelow = entry.atOrBelow;
        }

        const total = snapshot.total;
        // Rank from the top. Decks sharing a bucket share a rank, which is
        // honest: ARI is stored to a tenth and the bucket is a whole point, so
        // separating them would be precision the snapshot does not have.
        //
        // Clamped to the field size, because the snapshot is a snapshot: a deck
        // rated since it was taken - or one below every bucket in it - is not
        // counted in `atOrBelow`, and "rank 1001 of 1000" is the sort of thing
        // a player screenshots.
        const above = total - atOrBelow;

        return {
            percentile: Math.round((atOrBelow / total) * 1000) / 10,
            rank: Math.min(total, above + 1),
            of: total
        };
    }

    /**
     * Attach `ariPlace` to rows that carry an `ari`. One snapshot read for the
     * whole page.
     *
     * @param {Array<{ari?: number|null}>} rows
     */
    async attachPlaces(rows) {
        if (!rows || !rows.length) {
            return rows;
        }

        const snapshot = await this.distribution();

        for (const row of rows) {
            row.ariPlace = AriService.placeIn(row.ari, snapshot);
        }

        return rows;
    }

    /**
     * The ARI-only expected score between two decks - what the sparring
     * update measures surprise against, since no player ratings are in play.
     *
     * @param {number} ariA
     * @param {number} ariB
     * @param {object} eloConfig normalized elo config
     * @returns {number}
     */
    static expectedFromAri(ariA, ariB, eloConfig) {
        return expectedScore(0, 0, ariA - ariB, eloConfig);
    }
}

module.exports = AriService;
module.exports.seedAri = seedAri;
module.exports.effectiveAri = effectiveAri;
module.exports.EFFECTIVE_ARI_SQL = EFFECTIVE_ARI_SQL;
module.exports.clampAri = clampAri;
module.exports.ARI_MIN = ARI_MIN;
module.exports.ARI_MAX = ARI_MAX;
