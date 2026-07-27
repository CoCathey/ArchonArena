-- When each account accepted the Terms of Service.
--
-- The terms are stated at sign-up, but until now nothing recorded that a given
-- account had actually agreed - which is the only part that matters if the
-- terms are ever disputed or materially change.
--
-- Nullable: accounts that registered before the terms existed have no
-- acceptance to record, and backfilling one would be a false claim.

ALTER TABLE public."Users"
    ADD COLUMN IF NOT EXISTS "TermsAcceptedAt" timestamp without time zone;
