-- Optional player bio (see schema/56 - UserBio.sql)
ALTER TABLE public."Users" ADD COLUMN IF NOT EXISTS "Bio" text;
