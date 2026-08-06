-- Fold ratings stranded in legacy, format-named pools back into the real ones.
--
-- Rating pools are archon / sealed / alliance. Before POOL_BY_FORMAT existed,
-- RatingService derived the pool as `game.GameFormat || 'archon'` - the raw
-- format string. A lobby game has GameFormat 'normal', so every game rated in
-- that period created a Pool = 'normal' row.
--
-- The code was fixed to map formats onto pools, but only for new writes: the
-- rows already written were left behind. The result is a player carrying two
-- Amber ratings, one of them in a pool no future game can ever add to, shown
-- side by side on their stats page with a rank "#1 of 0".
--
-- Every legacy name here maps to archon; sealed and alliance were already
-- their own pools and are untouched. This is data repair, so there is
-- deliberately no counterpart in server/db/schema - a database built from that
-- directory has never had the bug and has nothing to fix.
--
-- AFTER APPLYING THIS, run the rating recalculation (Admin -> Ratings, or
-- RatingService.recalculateRatings) so the merged pool's numbers are replayed
-- from the corrected history. Until then a player whose legacy row had to be
-- dropped below shows only their post-fix games.

BEGIN;

-- History first: this is the audit trail the recalculation replays from, and
-- relabelling is safe because its key is (GameId, UserId) - the pool is not
-- part of any constraint, so no row can collide with another.
UPDATE public."RatingHistory"
SET "Pool" = 'archon'
WHERE "Pool" IN ('normal', 'reversal', 'adaptive-bo1', 'unchained');

-- Season standings are keyed on (SeasonId, UserId, Pool), so a legacy row can
-- collide with a real one. Drop those; keep the rest by relabelling.
DELETE FROM public."SeasonStandings" legacy
WHERE legacy."Pool" IN ('normal', 'reversal', 'adaptive-bo1', 'unchained')
    AND EXISTS (
        SELECT 1
        FROM public."SeasonStandings" canonical
        WHERE canonical."SeasonId" = legacy."SeasonId"
            AND canonical."UserId" = legacy."UserId"
            AND canonical."Pool" = 'archon'
    );

UPDATE public."SeasonStandings"
SET "Pool" = 'archon'
WHERE "Pool" IN ('normal', 'reversal', 'adaptive-bo1', 'unchained');

-- Ratings are keyed on (UserId, Pool). Where the player has no archon row the
-- legacy one simply becomes it, which preserves the rating exactly and needs no
-- recalculation. Where they have both, the two cannot be added together in any
-- meaningful way - Elo is not additive - so the legacy row is dropped and the
-- recalculation rebuilds the merged rating from the history relabelled above.
UPDATE public."Ratings" r
SET "Pool" = 'archon'
WHERE r."Pool" IN ('normal', 'reversal', 'adaptive-bo1', 'unchained')
    AND NOT EXISTS (
        SELECT 1
        FROM public."Ratings" canonical
        WHERE canonical."UserId" = r."UserId" AND canonical."Pool" = 'archon'
    );

DELETE FROM public."Ratings"
WHERE "Pool" IN ('normal', 'reversal', 'adaptive-bo1', 'unchained');

-- Team ratings were added long after the pool mapping, so they cannot carry
-- legacy names. Covered anyway: if one ever appears it is the same bug.
DELETE FROM public."TeamRatings" legacy
WHERE legacy."Pool" IN ('normal', 'reversal', 'adaptive-bo1', 'unchained')
    AND EXISTS (
        SELECT 1
        FROM public."TeamRatings" canonical
        WHERE canonical."TeamId" = legacy."TeamId" AND canonical."Pool" = 'archon'
    );

UPDATE public."TeamRatings"
SET "Pool" = 'archon'
WHERE "Pool" IN ('normal', 'reversal', 'adaptive-bo1', 'unchained');

COMMIT;
