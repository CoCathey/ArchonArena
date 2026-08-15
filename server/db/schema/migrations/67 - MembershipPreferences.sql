-- ARCHON (N12): the two things a member CHOOSES, as opposed to what they bought.
--
-- Memberships (schema 66) records what an account has paid for or been given.
-- Neither of these tables does: they record decisions a member makes once they
-- have it - which previews they want switched on, and what they want to look
-- like. Keeping them apart from Memberships matters for one specific reason: a
-- membership lapsing must not destroy either. Somebody who cancels and comes
-- back three months later gets their preview switches and their nameplate back
-- exactly as they left them, and in the meantime the entitlement resolver
-- simply stops honouring them.
--
-- Which is also why neither table stores a tier, a capability, or an expiry.
-- What a stored row is worth is decided at read time by
-- server/services/membership/{previews,cosmetics}.js against live entitlements.
-- A row here is a preference, never a grant.

-- ---------------------------------------------------------------------------
-- Preview programme opt-ins
-- ---------------------------------------------------------------------------
--
-- One row per explicit answer, NOT one row per preview. A preview an account
-- has never been asked about has no row and falls back to the registry's
-- `defaultOn`, so shipping a new preview switched-on does not require writing a
-- row for every member - and a member who deliberately turned something off
-- keeps it off when the default later changes.
--
-- Preview is a free text id from the code registry rather than a foreign key:
-- previews are defined in server/services/membership/previews.js so one can be
-- added, staged or retired without a migration. An id this build no longer
-- recognises is ignored on read.

CREATE TABLE IF NOT EXISTS public."MembershipPreviews"
(
    "UserId" integer NOT NULL,
    "Preview" text COLLATE pg_catalog."default" NOT NULL,
    "Enabled" boolean NOT NULL DEFAULT true,
    "UpdatedAt" timestamp without time zone NOT NULL DEFAULT (now() AT TIME ZONE 'utc'),

    CONSTRAINT "PK_MembershipPreviews" PRIMARY KEY ("UserId", "Preview"),
    CONSTRAINT "FK_MembershipPreviews_Users" FOREIGN KEY ("UserId")
        REFERENCES public."Users" ("Id") MATCH SIMPLE
        ON UPDATE NO ACTION
        ON DELETE CASCADE
)

TABLESPACE pg_default;

-- "who is on this preview, and is anybody actually using it" - the question
-- that decides whether a preview graduates or is withdrawn.
CREATE INDEX IF NOT EXISTS "IX_MembershipPreviews_Preview"
    ON public."MembershipPreviews" USING btree
    ("Preview" ASC NULLS LAST, "Enabled" ASC NULLS LAST)
    TABLESPACE pg_default;

-- ---------------------------------------------------------------------------
-- Cosmetic choices
-- ---------------------------------------------------------------------------
--
-- Slot/choice pairs rather than a column per cosmetic, so adding a slot is an
-- edit to the catalogue in code and not a migration. Both are free text for the
-- same reason the tier column on Memberships is: the catalogue lives in
-- server/services/membership/cosmetics.js, and a value this build does not
-- recognise resolves to the default rather than erroring.
--
-- Only non-default choices are stored. The default is the absence of a row.

CREATE TABLE IF NOT EXISTS public."MembershipCosmetics"
(
    "UserId" integer NOT NULL,
    "Slot" text COLLATE pg_catalog."default" NOT NULL,
    "Choice" text COLLATE pg_catalog."default" NOT NULL,
    "UpdatedAt" timestamp without time zone NOT NULL DEFAULT (now() AT TIME ZONE 'utc'),

    CONSTRAINT "PK_MembershipCosmetics" PRIMARY KEY ("UserId", "Slot"),
    CONSTRAINT "FK_MembershipCosmetics_Users" FOREIGN KEY ("UserId")
        REFERENCES public."Users" ("Id") MATCH SIMPLE
        ON UPDATE NO ACTION
        ON DELETE CASCADE
)

TABLESPACE pg_default;
