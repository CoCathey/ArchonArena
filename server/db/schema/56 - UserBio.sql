-- Optional player bio (I3), editable from the account page and shown on the
-- public profile. Added via ALTER so the upstream "03 - Users.sql" stays
-- untouched for clean upstream merges; this file runs after it on fresh
-- installs (files execute in name order).

ALTER TABLE public."Users" ADD COLUMN IF NOT EXISTS "Bio" text COLLATE pg_catalog."default";
