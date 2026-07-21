-- Player location for rankings (see schema/28 - UserLocation.sql)
ALTER TABLE public."Users" ADD COLUMN IF NOT EXISTS "Country" text;
ALTER TABLE public."Users" ADD COLUMN IF NOT EXISTS "State" text;

CREATE INDEX IF NOT EXISTS "IX_Users_Country" ON public."Users" ("Country");
