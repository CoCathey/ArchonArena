-- Recorded game replays: one structured play-by-play per finished game, keyed
-- to the Games row (cascades on game delete).

CREATE TABLE IF NOT EXISTS public."GameReplays"
(
    "GameDbId" integer NOT NULL,
    "Data" jsonb NOT NULL,
    "CreatedAt" timestamp without time zone NOT NULL,
    CONSTRAINT "PK_GameReplays" PRIMARY KEY ("GameDbId"),
    CONSTRAINT "FK_GameReplays_Games_GameDbId" FOREIGN KEY ("GameDbId")
        REFERENCES public."Games" ("Id") MATCH SIMPLE
        ON UPDATE NO ACTION
        ON DELETE CASCADE
);
