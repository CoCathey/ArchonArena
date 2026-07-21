-- SAS/AERC deck statistics fetched from Decks of KeyForge (see schema/24 - DeckSas.sql)
CREATE TABLE IF NOT EXISTS public."DeckSas"
(
    "Uuid" text COLLATE pg_catalog."default" NOT NULL,
    "SasRating" integer,
    "AercScore" integer,
    "AercVersion" integer,
    "RawData" jsonb,
    "FetchedAt" timestamp without time zone NOT NULL,
    CONSTRAINT "PK_DeckSas" PRIMARY KEY ("Uuid")
);
