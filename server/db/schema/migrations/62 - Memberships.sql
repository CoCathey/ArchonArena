-- ARCHON (N12): premium membership, and why it is a table rather than a role.
--
-- The inherited Patreon integration expressed "this person supports the site"
-- as a row in UserRoles named 'Supporter'. That is enough to draw a badge and
-- nothing else: a role has no tier, no expiry, no provider, and no record of
-- where it came from. It cannot answer "is this person still paying?", it
-- cannot express a beta tester who has Archon access until the end of the
-- month, and it cannot survive a second payment provider.
--
-- So membership state lives here, and the roles table goes back to meaning
-- what it says - what someone is allowed to administer. The Supporter role is
-- deliberately NOT dropped: accounts that predate this table are still honoured
-- as Supporter by the entitlement resolver, so turning this on does not
-- downgrade anybody who was already supporting the site.
--
-- WHAT THIS TABLE IS NOT
--
-- It is not permissions. It records what a person has *bought* (or been given);
-- server/services/membership/entitlements.js decides what that buys. Patreon
-- tells us the membership, this table stores it, and exactly one function turns
-- it into capabilities - which is what lets a feature move between tiers, or a
-- second provider appear, without touching any feature code.
--
-- WHY ONE ROW PER USER
--
-- A person has one membership at a time here, even though it can have two
-- sources: a provider subscription (Provider/Tier/Status) and a manual grant
-- (GrantedTier/GrantedUntil). Keeping both on one row means the common read -
-- "what does this account get?" - is a single join on the checkauth path, and
-- the resolver takes the higher of the two so comping someone who already pays
-- more never demotes them. A full subscription *history* is a separate concern
-- and belongs in its own table if it is ever needed for revenue reporting.

CREATE TABLE IF NOT EXISTS public."Memberships"
(
    "UserId" integer NOT NULL,

    -- Where the membership came from: 'patreon' today. Provider-agnostic on
    -- purpose - supporting a second one should be a sync job, not a redesign.
    "Provider" text COLLATE pg_catalog."default",
    -- The provider's own id for this membership, so a sync can reconcile
    -- without guessing from the tier name.
    "ExternalId" text COLLATE pg_catalog."default",

    -- Our tier id ('free' | 'supporter' | 'archon' | 'vault_master'), NOT the
    -- provider's tier name. Deliberately not a foreign key or an enum: tiers
    -- are defined in code (server/services/membership/tiers.js) so they can be
    -- renamed and reordered without a migration, and an id this build does not
    -- recognise resolves to free rather than erroring.
    "Tier" text COLLATE pg_catalog."default",
    -- 'active' | 'expired' | 'declined' | 'cancelled' | 'none'. What counts as
    -- current is decided in code, not here.
    "Status" text COLLATE pg_catalog."default",

    "StartedAt" timestamp without time zone,
    -- Renewal/expiry if the provider gives one. NULL means "no end date known",
    -- which the resolver treats as current - Patreon does not always report a
    -- next charge date, and reading absent as expired would cut off members who
    -- are paying perfectly well.
    "ExpiresAt" timestamp without time zone,
    -- When we last heard from the provider. Lets an operator see a sync that
    -- has quietly stopped running.
    "LastSyncedAt" timestamp without time zone,

    -- Complimentary / manual access, independent of any provider: comped
    -- accounts, beta testers, contributors, promotions. GrantedUntil NULL means
    -- indefinite. Kept separate from Tier/Status rather than overwriting them
    -- so a comp does not destroy the record of what someone actually pays.
    "GrantedTier" text COLLATE pg_catalog."default",
    "GrantedUntil" timestamp without time zone,
    "GrantedBy" integer,
    "GrantedReason" text COLLATE pg_catalog."default",

    "CreatedAt" timestamp without time zone NOT NULL DEFAULT (now() AT TIME ZONE 'utc'),
    "UpdatedAt" timestamp without time zone NOT NULL DEFAULT (now() AT TIME ZONE 'utc'),

    CONSTRAINT "PK_Memberships" PRIMARY KEY ("UserId"),
    CONSTRAINT "FK_Memberships_Users_UserId" FOREIGN KEY ("UserId")
        REFERENCES public."Users" ("Id") MATCH SIMPLE
        ON UPDATE NO ACTION
        ON DELETE CASCADE,
    -- SET NULL rather than CASCADE: deleting the admin who granted a comp must
    -- not delete the comp.
    CONSTRAINT "FK_Memberships_Users_GrantedBy" FOREIGN KEY ("GrantedBy")
        REFERENCES public."Users" ("Id") MATCH SIMPLE
        ON UPDATE NO ACTION
        ON DELETE SET NULL
)

TABLESPACE pg_default;

-- Admin views list members by tier ("who is on Archon?"), and the sync job
-- sweeps by staleness.
CREATE INDEX IF NOT EXISTS "IX_Memberships_Tier_Status"
    ON public."Memberships" USING btree
    ("Tier" ASC NULLS LAST, "Status" ASC NULLS LAST)
    TABLESPACE pg_default;

CREATE INDEX IF NOT EXISTS "IX_Memberships_LastSyncedAt"
    ON public."Memberships" USING btree
    ("LastSyncedAt" ASC NULLS FIRST)
    TABLESPACE pg_default;
