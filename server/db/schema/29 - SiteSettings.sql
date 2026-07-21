-- Table: public."SiteSettings"
-- Runtime admin-editable settings overrides, one row per settings section
-- (e.g. 'rating', 'dok'). Values are jsonb overrides merged over code
-- defaults and file config; editable fields are constrained by the
-- registry in server/services/settings/registry.js.

CREATE TABLE IF NOT EXISTS public."SiteSettings"
(
    "Key" text COLLATE pg_catalog."default" NOT NULL,
    "Value" jsonb NOT NULL,
    "UpdatedBy" integer,
    "UpdatedAt" timestamp without time zone NOT NULL,
    CONSTRAINT "PK_SiteSettings" PRIMARY KEY ("Key"),
    CONSTRAINT "FK_SiteSettings_Users_UpdatedBy" FOREIGN KEY ("UpdatedBy")
        REFERENCES public."Users" ("Id") MATCH SIMPLE
        ON UPDATE NO ACTION
        ON DELETE SET NULL
)

TABLESPACE pg_default;
