-- Table: public."DeckSas"
-- SAS/AERC deck statistics fetched from Decks of KeyForge, keyed by the
-- deck's Master Vault UUID so one row covers every user's copy of a deck.

CREATE TABLE IF NOT EXISTS public."DeckSas"
(
    "Uuid" text COLLATE pg_catalog."default" NOT NULL,
    "SasRating" integer,
    "AercScore" integer,
    "AercVersion" integer,
    "RawData" jsonb,
    "FetchedAt" timestamp without time zone NOT NULL,
    CONSTRAINT "PK_DeckSas" PRIMARY KEY ("Uuid")
)

TABLESPACE pg_default;
