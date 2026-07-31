-- Tournament engine follow-ons (N9): hybrid events, kiosk check-in,
-- Alliance pod legality, and Adaptive Bo3.
--
-- ALLIANCE POD PROVENANCE
--
-- An Alliance deck is assembled from three house pods taken from three source
-- decks. Today that assembly happens in DeckService.createAlliance and is then
-- thrown away: the created deck records its cards, houses and expansion, but
-- nothing about which physical decks the pods came from. Every real Alliance
-- event rule is about provenance - "one pod per deck you own", "pods only from
-- these sets", "nobody else may use a deck you sourced from" - so none of them
-- could be checked at all. Decks.AlliancePods records `[{deckUuid, house}]` at
-- build time so they can be.
--
-- Pre-existing Alliance decks have NULL here and there is no way to backfill
-- it - the information was never captured. An event that turns on pod checking
-- therefore has to reject those decks by name rather than wave them through,
-- which is why requirePodProvenance is a policy field and not an assumption.
--
-- HYBRID EVENTS
--
-- A paper result feeds the STANDING, not the ladder. The Elo engine needs the
-- key differential and both decks' SAS, and a result typed in at a table has
-- neither in a form anyone verified - so tournament paper results deliberately
-- stop at the standings. Rating paper play is N13's job, where both players
-- report independently and the numbers have to agree before anything commits.
--
-- ADAPTIVE BO3
--
-- Archon Adaptive is a three-game series: game 1 is played normally, then the
-- LOSER of each game chooses to either swap decks with their opponent or bid
-- chains to keep their own. AdaptiveState carries that negotiation on the match
-- row, because it is match state (not deck state) and it has to survive a
-- reconnect, a page reload, and an organizer looking at the table.

ALTER TABLE public."Decks"
    ADD COLUMN IF NOT EXISTS "AlliancePods" jsonb;

-- Hybrid: this event accepts results reported from paper play alongside
-- (or instead of) games played on the platform.
ALTER TABLE public."Tournaments"
    ADD COLUMN IF NOT EXISTS "AllowPaperResults" boolean NOT NULL DEFAULT false;

-- Kiosk check-in. Distinct from JoinCode, which grants entry to a private
-- event: this one only marks an already-registered player as present, so it is
-- safe to put on a poster at the door.
ALTER TABLE public."Tournaments"
    ADD COLUMN IF NOT EXISTS "CheckInCode" text COLLATE pg_catalog."default";

ALTER TABLE public."Tournaments"
    ADD COLUMN IF NOT EXISTS "AlliancePolicy" jsonb;

ALTER TABLE public."Tournaments"
    ADD COLUMN IF NOT EXISTS "AdaptiveBo3" boolean NOT NULL DEFAULT false;

CREATE UNIQUE INDEX IF NOT EXISTS "UQ_Tournaments_CheckInCode"
    ON public."Tournaments" ("CheckInCode")
    WHERE "CheckInCode" IS NOT NULL;

-- 'online' when the result came from a game the platform ran, 'paper' when a
-- human typed it in at a table. Worth recording separately: an organizer
-- auditing a disputed standing needs to know which results the platform
-- actually witnessed.
ALTER TABLE public."TournamentMatches"
    ADD COLUMN IF NOT EXISTS "ResultSource" text COLLATE pg_catalog."default" NOT NULL DEFAULT 'online';

ALTER TABLE public."TournamentMatches"
    ADD COLUMN IF NOT EXISTS "AdaptiveState" jsonb;

-- Who was physically present, and when they said so. CheckedIn already exists
-- as a boolean; this records the kiosk scan itself so an organizer can tell a
-- self-check-in from a staff override at the desk.
ALTER TABLE public."TournamentPlayers"
    ADD COLUMN IF NOT EXISTS "CheckedInAt" timestamp without time zone;

ALTER TABLE public."TournamentPlayers"
    ADD COLUMN IF NOT EXISTS "CheckedInVia" text COLLATE pg_catalog."default";
