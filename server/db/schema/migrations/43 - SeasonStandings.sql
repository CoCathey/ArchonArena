-- Season archive: what each season finished as, and what the soft reset did.
--
-- Seasons recorded only a start date, so a season that ended left no trace of
-- itself: no final standings, no record of where anyone placed, and no way to
-- tell a player what the reset took off their Amber. Starting a new season
-- overwrote every rating in place and the previous ladder simply ceased to
-- exist.
--
-- One row per player per pool per *ended* season, written at the moment the
-- next season starts. It carries both halves of the transition: where the
-- player finished, and what they carried forward. That single row backs the
-- season archive, the end-of-season summary, the finish badges on public
-- profiles, and - importantly - the seed the rating recalculation tool replays
-- from, since a recalculation that replayed all of history from zero would
-- silently undo every season reset ever applied.

ALTER TABLE public."Seasons"
    ADD COLUMN IF NOT EXISTS "EndedAt" timestamp without time zone;

CREATE TABLE IF NOT EXISTS public."SeasonStandings"
(
    -- The season that ENDED, not the one being started.
    "SeasonId" integer NOT NULL,
    "UserId" integer NOT NULL,
    "Pool" text NOT NULL,
    -- Rank within the pool at season end. Null when the player did not meet
    -- the games threshold to be ranked - they still get a row, because their
    -- rating is what seeds their next season.
    "Rank" integer,
    "Rating" integer NOT NULL,
    "GamesPlayed" integer NOT NULL,
    -- What the soft reset carried into the next season. The pair
    -- (Rating, RatingAfterReset) is the end-of-season summary.
    "RatingAfterReset" integer NOT NULL,
    "CreatedAt" timestamp without time zone NOT NULL,
    CONSTRAINT "PK_SeasonStandings" PRIMARY KEY ("SeasonId", "UserId", "Pool"),
    CONSTRAINT "FK_SeasonStandings_Seasons" FOREIGN KEY ("SeasonId")
        REFERENCES public."Seasons" ("Id") ON DELETE CASCADE,
    CONSTRAINT "FK_SeasonStandings_Users" FOREIGN KEY ("UserId")
        REFERENCES public."Users" ("Id") ON DELETE CASCADE
);

-- The archive view: one season's ladder, best first.
CREATE INDEX IF NOT EXISTS "IX_SeasonStandings_Season_Pool_Rank"
    ON public."SeasonStandings" ("SeasonId", "Pool", "Rank" ASC NULLS LAST);

-- A player's own history across seasons (summary page, profile badges).
CREATE INDEX IF NOT EXISTS "IX_SeasonStandings_User"
    ON public."SeasonStandings" ("UserId", "SeasonId" DESC);
