-- ARCHON (N19): ARI, the Archon Rating Index - the platform's own deck rating.
--
-- SAS is somebody else's opinion of a deck, frozen at scoring time. ARI is
-- what this platform has actually seen: it starts where SAS and AERC point
-- and then moves, Elo-fashion, with every rated real game and every
-- Champion's Challenge sparring game the deck plays. It is the deck-strength
-- input the Amber ladder uses from now on (RatingService reads it in place
-- of raw SAS), which is why it lives beside the rating engine rather than
-- beside the deck importer.
--
-- Keyed by Master Vault uuid, like "DeckSas": a deck is the same 36 cards in
-- everyone's hands, so its index is a property of the deck, not of any one
-- owner's copy. One row per deck the platform has ever adjusted; decks the
-- engine has never seen simply have no row, and readers fall back to the
-- SAS/AERC seed (AriService.seedAri) so every deck has an ARI from the
-- moment it is imported.
--
-- "RatedGames" counts rated real games folded in; "SimGames" counts Champion’s
-- Challenge games. Kept separately because they move the index at different
-- rates (rating.ari.gameK vs simGameK) and because "how much of this number
-- is sparring" is a fair question for a player to ask of it.

CREATE TABLE IF NOT EXISTS public."DeckAri"
(
    "Uuid" text COLLATE pg_catalog."default" NOT NULL,
    "Ari" real NOT NULL,
    "RatedGames" integer NOT NULL DEFAULT 0,
    "SimGames" integer NOT NULL DEFAULT 0,
    "UpdatedAt" timestamp without time zone NOT NULL,
    CONSTRAINT "PK_DeckAri" PRIMARY KEY ("Uuid")
)

TABLESPACE pg_default;
