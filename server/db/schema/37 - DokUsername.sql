-- Decks of KeyForge link (Phase 9): the DoK account a user imports their
-- collection from, remembered so they can re-sync new decks later.

ALTER TABLE public."Users"
    ADD COLUMN IF NOT EXISTS "DokUsername" text COLLATE pg_catalog."default";
