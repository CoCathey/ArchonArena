-- Runtime admin-editable settings (see schema/29 - SiteSettings.sql)
CREATE TABLE IF NOT EXISTS public."SiteSettings"
(
    "Key" text NOT NULL,
    "Value" jsonb NOT NULL,
    "UpdatedBy" integer,
    "UpdatedAt" timestamp without time zone NOT NULL,
    CONSTRAINT "PK_SiteSettings" PRIMARY KEY ("Key"),
    CONSTRAINT "FK_SiteSettings_Users_UpdatedBy" FOREIGN KEY ("UpdatedBy")
        REFERENCES public."Users" ("Id") ON DELETE SET NULL
);
