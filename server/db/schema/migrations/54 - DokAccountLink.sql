-- Remembering a player's Decks of KeyForge key, so their collection can keep
-- itself up to date instead of being re-pasted every time they buy a deck.
--
-- WHY THE KEY IS ENCRYPTED AND THE OTHER SECRET IN THIS TABLE IS NOT (YET)
--
-- "DokApiKey" holds a credential belonging to somebody else's account, and one
-- that cannot be hashed instead because it has to be replayed to DoK verbatim.
-- It is written through server/services/crypto/secretBox.js (AES-256-GCM,
-- keyed from the site secret) so the database on its own does not read it.
-- "PatreonToken" in this same table predates that helper and is still
-- plaintext; the helper passes unrecognised values through untouched precisely
-- so that column can be sealed on its next write rather than by a migration
-- that rewrites rows nobody may be able to decrypt afterwards.
--
-- Rotating the site secret makes stored keys unreadable. That is deliberate
-- and survivable: decryption failure is treated as "no key", which asks the
-- player to paste it again.
--
-- WHY "DokKeyRejectedAt" EXISTS
--
-- Decks of KeyForge issues ONE key per account and generating a new one voids
-- the previous instantly, so a key stored here dies the moment the player
-- generates another anywhere else - something that has already happened once
-- on this deployment. Without somewhere to record that, an automatic sync
-- would fail against a dead credential on every cycle, forever, silently. The
-- timestamp stops the schedule and is what the UI reads to say "your key was
-- rejected, paste a new one".
--
-- WHY AUTO SYNC IS OPT-IN
--
-- Storing a third party's credential is a decision each player makes for
-- themselves, not a side effect of having once pasted one to import decks.
-- "DokAutoSync" defaults false, and the import path only stores a key when the
-- player asked it to.

ALTER TABLE public."Users"
    ADD COLUMN IF NOT EXISTS "DokApiKey" text COLLATE pg_catalog."default";

ALTER TABLE public."Users"
    ADD COLUMN IF NOT EXISTS "DokAutoSync" boolean NOT NULL DEFAULT false;

ALTER TABLE public."Users"
    ADD COLUMN IF NOT EXISTS "DokLastSyncAt" timestamp without time zone;

ALTER TABLE public."Users"
    ADD COLUMN IF NOT EXISTS "DokKeyRejectedAt" timestamp without time zone;

-- The auto-sync sweep asks one question - "whose collection is due?" - and the
-- answer is a small slice of a table that is mostly players who never linked an
-- account. Partial so the index stays proportional to the people using the
-- feature rather than to the user count.
CREATE INDEX IF NOT EXISTS "IX_Users_DokAutoSync"
    ON public."Users" USING btree ("DokLastSyncAt" ASC NULLS FIRST)
    WHERE "DokAutoSync" AND "DokApiKey" IS NOT NULL AND "DokKeyRejectedAt" IS NULL;
