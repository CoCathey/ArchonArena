-- Onboarding (Phase 9): first-run wizard flag and club invite codes.
-- "OnboardedAt" null = the user has not completed (or skipped) the
-- new-player setup wizard yet. "JoinCode" lets players join a club with
-- a shareable invite code instead of searching.

ALTER TABLE public."Users" ADD COLUMN IF NOT EXISTS "OnboardedAt" timestamp without time zone;

ALTER TABLE public."Clubs" ADD COLUMN IF NOT EXISTS "JoinCode" text COLLATE pg_catalog."default";

CREATE UNIQUE INDEX IF NOT EXISTS "UQ_Clubs_JoinCode"
    ON public."Clubs" ("JoinCode")
    WHERE "JoinCode" IS NOT NULL;
