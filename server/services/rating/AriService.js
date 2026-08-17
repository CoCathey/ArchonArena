const logger = require('../../log');
const { expectedScore } = require('./EloCalculator');

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
    constructor(db = require('../../db')) {
        this.db = db;
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
                'da."RatedGames", da."SimGames" ' +
                'FROM "DeckSas" ds LEFT JOIN "DeckAri" da ON da."Uuid" = ds."Uuid" ' +
                'WHERE ds."Uuid" = ANY($1)',
            [wanted]
        );

        for (const row of rows || []) {
            result.set(row.Uuid, {
                ari: effectiveAri(row),
                ratedGames: row.RatedGames || 0,
                simGames: row.SimGames || 0
            });
        }

        return result;
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

            await Promise.all([
                this.upsertAri(winnerUuid, clampAri(winner.ari + step), sim),
                this.upsertAri(loserUuid, clampAri(loser.ari - step), sim)
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
    async upsertAri(uuid, ari, sim) {
        const gameIncrement = sim ? 0 : 1;
        const simIncrement = sim ? 1 : 0;

        await this.db.query(
            'INSERT INTO "DeckAri" ("Uuid", "Ari", "RatedGames", "SimGames", "UpdatedAt") ' +
                "VALUES ($1, $2, $3, $4, now() AT TIME ZONE 'utc') " +
                'ON CONFLICT ("Uuid") DO UPDATE SET "Ari" = $2, ' +
                '"RatedGames" = "DeckAri"."RatedGames" + $3, ' +
                '"SimGames" = "DeckAri"."SimGames" + $4, ' +
                '"UpdatedAt" = now() AT TIME ZONE \'utc\'',
            [uuid, Math.round(ari * 10) / 10, gameIncrement, simIncrement]
        );
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
