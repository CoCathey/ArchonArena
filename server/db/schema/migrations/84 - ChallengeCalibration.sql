-- ARCHON (N38): how good the sparring partner actually is.
--
-- Every number the Champion's Challenge shows a member is relative: "this deck
-- wins 62%". Against what standard of play? The lab could not say. A member
-- reading a verdict had no way to know whether the opponent behind it was
-- competent, and neither did an operator watching a training run - a candidate
-- promoted on a Wilson bound is better than the LAST champion, which says
-- nothing about whether either can play.
--
-- So the champion is measured against fixed reference opponents that never
-- learn: the plain heuristic bot the lab started from, each hand-biased
-- persona, and the deep searching bot. Their strength does not drift, which is
-- the entire point - a ladder whose rungs move measures nothing.
--
-- One row per opponent, accumulated. Paired seeds and swapped seats, like the
-- title fight and the persona duels, so first-player advantage cancels rather
-- than being averaged over and hoped about.
CREATE TABLE IF NOT EXISTS public."ChallengeCalibration"
(
    -- 'heuristic' | 'deep' | a persona key. Not a foreign key: these are code
    -- identities, and a reference opponent that is retired should leave its
    -- history behind rather than take it with it.
    "Opponent" text COLLATE pg_catalog."default" NOT NULL,
    -- The champion version these games were played by. Kept so a ladder can be
    -- read as "what THIS champion can do" rather than a running total across
    -- every model the loop has ever promoted - which would smear a regression
    -- across the record of the model that caused it.
    "PolicyVersion" integer NOT NULL DEFAULT 0,
    "Wins" integer NOT NULL DEFAULT 0,
    "Losses" integer NOT NULL DEFAULT 0,
    "UpdatedAt" timestamp without time zone NOT NULL,
    CONSTRAINT "PK_ChallengeCalibration" PRIMARY KEY ("Opponent", "PolicyVersion")
)

TABLESPACE pg_default;
