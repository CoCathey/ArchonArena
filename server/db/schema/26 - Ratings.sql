-- Table: public."Ratings"
-- Current rating per player per pool (pool = game format, e.g. archon).
-- History lives in "RatingHistory"; this is the fast-lookup current state.

CREATE TABLE IF NOT EXISTS public."Ratings"
(
    "UserId" integer NOT NULL,
    "Pool" text COLLATE pg_catalog."default" NOT NULL,
    "Rating" integer NOT NULL,
    "GamesPlayed" integer NOT NULL DEFAULT 0,
    "UpdatedAt" timestamp without time zone NOT NULL,
    CONSTRAINT "PK_Ratings" PRIMARY KEY ("UserId", "Pool"),
    CONSTRAINT "FK_Ratings_Users_UserId" FOREIGN KEY ("UserId")
        REFERENCES public."Users" ("Id") MATCH SIMPLE
        ON UPDATE NO ACTION
        ON DELETE CASCADE
)

TABLESPACE pg_default;

CREATE INDEX IF NOT EXISTS "IX_Ratings_Pool_Rating"
    ON public."Ratings" USING btree
    ("Pool" ASC NULLS LAST, "Rating" DESC NULLS LAST)
    TABLESPACE pg_default;
