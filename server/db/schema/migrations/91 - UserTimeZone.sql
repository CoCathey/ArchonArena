-- The time zone a player reads the site from.
--
-- WHY THE ACCOUNT NEEDS ONE
--
-- Every timestamp the platform stores is UTC, and every timestamp it EMAILED was
-- UTC too: "alice suggests 2026-08-20 19:00 UTC" left the arithmetic to the
-- reader. The reader most likely to get it wrong is the one several zones from
-- their opponent - exactly the player an asynchronous event exists for, and the
-- one the email was trying to help. The in-app pages already format in the
-- browser's zone; email and push have no browser, so the account has to carry
-- the answer.
--
-- WHY IT IS RECORDED RATHER THAN CONFIGURED
--
-- The browser knows its zone without anybody being asked (Intl reports it), so
-- the client tells the server after signing in and whenever it changes. A
-- setting nobody has to find is a setting that is actually set. It is an IANA
-- name ('America/Chicago'); NULL means "unknown", and everything that reads it
-- falls back to labelling the time as UTC, which is what happened before.

ALTER TABLE public."Users"
    ADD COLUMN IF NOT EXISTS "Settings_TimeZone" text COLLATE pg_catalog."default";
