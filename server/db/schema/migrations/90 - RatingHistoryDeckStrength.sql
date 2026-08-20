-- ARCHON (N49): the write that unrated every game.
--
-- "OwnSas"/"OpponentSas" record the deck-strength value the rating ACTUALLY
-- USED, and since N19 pointed the Elo deck term at ARI that value has been an
-- ARI: a tenth-precision number whose seed is the SAS/AERC midpoint, so it is
-- fractional far more often than not (a 72/63 deck seeds at 67.5).
--
-- The columns were `integer`. node-postgres sends a bound parameter as text
-- and PostgreSQL parses it with the target column's input function, so 67.5
-- did not round - it was rejected outright:
--
--     invalid input syntax for type integer: "67.5"
--
-- That threw inside the rating transaction, which rolled back, which meant no
-- "RatingHistory" rows and no "Ratings" update. RatingService.processGame
-- swallows its own errors by design (rating must never break the game flow),
-- so the only trace was a log line - and what a player saw was the post-game
-- panel polling for a rating that was never coming: "Rating this game...",
-- then "Still rating this game", and an Amber total that never moved.
--
-- Two things follow from that, and this file is the second of them. The ladder
-- is back on raw SAS (rating.ari.useForElo, default off), which by itself
-- makes these writes integral again. This widens the columns anyway, because
-- the column type is what made a fractional deck rating unstorable, and
-- leaving it would put the same landmine back under anyone who ever points the
-- ladder at ARI again.
--
-- `real` matches "Expected" beside it and is a widening in place: every value
-- already stored is a whole SAS number well inside float4's exact-integer
-- range, so nothing is rewritten and nothing is lost. Rounding on the way in
-- was the alternative and is not equivalent - recalculateRatings replays these
-- exact numbers back through the calculator, so a rounded column would make a
-- replay disagree with the ratings it is supposed to reproduce.

ALTER TABLE public."RatingHistory"
    ALTER COLUMN "OwnSas" TYPE real,
    ALTER COLUMN "OpponentSas" TYPE real;
