-- ARCHON (N34): how sure ARI is of itself, and where a deck sits in the field.
--
-- Two additions that answer the two halves of "what does 78 mean".
--
-- HOW SURE. ARI moved at one fixed rate whatever a deck had done: three games
-- and three hundred games bought the same step. So a new deck stayed pinned to
-- its card-math seed while its results argued otherwise, and an established
-- deck twitched at every game after it had earned the right not to. The step is
-- now scaled by a stored deviation, and the deviation is what tells a player
-- their rating is still settling. "LastGameAt" is what lets certainty DECAY: a
-- deck rated in one meta and shelved for a year is not still known to that
-- precision, and the counters alone cannot say so because they only ever grow.
--
-- WHERE IN THE FIELD. A rating nobody can place is a number, not a ranking.
-- The distribution is snapshotted rather than computed per request: the
-- question "what percentile is 78" is asked once per deck row on every deck
-- list, and answering it with a window function over every rated deck on the
-- platform is a table scan per page. A bucketed snapshot answers it with a
-- primary-key lookup and is refreshed on a schedule, which is the right
-- accuracy for a number that moves by fractions of a percentile per game.

ALTER TABLE public."DeckAri"
    -- On the ARI (SAS) scale, so it can be printed beside the rating without
    -- conversion: "78, ±9 and settling" is a sentence a player can read.
    ADD COLUMN IF NOT EXISTS "Deviation" real,
    -- When this deck last had a result of any kind. Not derivable from
    -- "UpdatedAt", which also moves when a backfill touches the row.
    ADD COLUMN IF NOT EXISTS "LastGameAt" timestamp without time zone;

-- The field, in whole-ARI buckets. One row per occupied bucket, so a platform
-- with four thousand rated decks stores about a hundred rows.
CREATE TABLE IF NOT EXISTS public."AriDistribution"
(
    -- floor(ARI). The band is 1..150, so this is small and dense.
    "Bucket" integer NOT NULL,
    "Decks" integer NOT NULL,
    -- Running total of decks in this bucket and every lower one. Stored rather
    -- than summed at read time for the same reason the table exists at all.
    "AtOrBelow" bigint NOT NULL,
    CONSTRAINT "PK_AriDistribution" PRIMARY KEY ("Bucket")
)

TABLESPACE pg_default;

-- One row, forever, like the crawl cursor: the totals the buckets are read
-- against, and when they were last true. A percentile quoted from a snapshot
-- whose age nobody can see is a percentile nobody should quote.
CREATE TABLE IF NOT EXISTS public."AriDistributionState"
(
    "Id" integer NOT NULL DEFAULT 1,
    "TotalDecks" bigint NOT NULL DEFAULT 0,
    "UpdatedAt" timestamp without time zone,
    CONSTRAINT "PK_AriDistributionState" PRIMARY KEY ("Id"),
    CONSTRAINT "CK_AriDistributionState_SingleRow" CHECK ("Id" = 1)
)

TABLESPACE pg_default;

-- Seeded here rather than created on first use: every reader expects the row
-- to exist, and one INSERT in the schema is cheaper than an "or create it"
-- branch in every caller.
INSERT INTO public."AriDistributionState" ("Id") VALUES (1) ON CONFLICT DO NOTHING;
