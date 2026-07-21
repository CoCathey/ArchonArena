-- Decks of KeyForge link (Phase 9): remembered DoK account for bulk import.

ALTER TABLE public."Users" ADD COLUMN IF NOT EXISTS "DokUsername" text;
