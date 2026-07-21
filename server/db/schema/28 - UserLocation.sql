-- Player location for rankings (Phase 6). Added via ALTER so the upstream
-- "03 - Users.sql" stays untouched for clean upstream merges; this file
-- runs after it on fresh installs (files execute in name order).

ALTER TABLE public."Users" ADD COLUMN IF NOT EXISTS "Country" text COLLATE pg_catalog."default";
ALTER TABLE public."Users" ADD COLUMN IF NOT EXISTS "State" text COLLATE pg_catalog."default";

CREATE INDEX IF NOT EXISTS "IX_Users_Country"
    ON public."Users" USING btree
    ("Country" ASC NULLS LAST)
    TABLESPACE pg_default;
