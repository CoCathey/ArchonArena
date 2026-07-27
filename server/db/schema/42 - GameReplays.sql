-- Table: public."GameReplays"
-- One recorded replay per finished game: a structured play-by-play log plus a
-- small header, stored as jsonb and keyed to the Games row. Written at game end
-- (GAMEWIN) and read by the replay viewer.

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
)

TABLESPACE pg_default;

ALTER TABLE public."GameReplays"
    OWNER to keyteki;
