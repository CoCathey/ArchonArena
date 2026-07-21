-- Onboarding (Phase 9): first-run wizard flag and club invite codes.

ALTER TABLE public."Users" ADD COLUMN IF NOT EXISTS "OnboardedAt" timestamp without time zone;

ALTER TABLE public."Clubs" ADD COLUMN IF NOT EXISTS "JoinCode" text;

CREATE UNIQUE INDEX IF NOT EXISTS "UQ_Clubs_JoinCode"
    ON public."Clubs" ("JoinCode")
    WHERE "JoinCode" IS NOT NULL;

-- Existing accounts should never see the new-player wizard.
UPDATE public."Users"
SET "OnboardedAt" = now() AT TIME ZONE 'utc'
WHERE "OnboardedAt" IS NULL;

-- Give pre-existing clubs an invite code so owners can share one
-- immediately. Codes avoid the easily-confused characters 0/O/1/I/L.
-- The outer-row reference keeps the subquery correlated so each club
-- gets its own random code instead of one shared statement-level value.
UPDATE public."Clubs"
SET "JoinCode" = (
    SELECT string_agg(substr('ABCDEFGHJKMNPQRSTUVWXYZ23456789', (floor(random() * 31) + 1)::int, 1), '')
    FROM generate_series(1, 8)
    WHERE "Clubs"."Id" IS NOT NULL
)
WHERE "JoinCode" IS NULL;
