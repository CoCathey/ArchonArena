-- Asynchronous tournaments: Challonge-style events played out over days,
-- where each round has a deadline and the two players of a match arrange
-- between themselves when inside that window they will meet.
--
-- WHY "Pacing" IS A COLUMN AND NOT INFERRED
--
-- A live event and an async league differ in behaviour, not just display:
-- async events measure their round clock in days ("RoundDeadlineDays"), do
-- NOT auto-open a lobby table per pairing (a table nobody will sit at for
-- three days is lobby clutter - tables open on demand when the two players
-- actually meet), and get a deadline sweep that tells the organizer when a
-- round has run past its date. Inferring all that from "the timer is long"
-- would make a 4-hour live final indistinguishable from a short async round.
--
-- WHY THE SCHEDULE LIVES ON THE MATCH
--
-- "ScheduledAt" is the time both players agreed to meet; "ProposedTime" /
-- "ProposedBy" is a pending offer one of them has made (with an optional
-- note), which becomes ScheduledAt when the other accepts. One live proposal
-- at a time is deliberate: a counter-offer replaces the previous offer, the
-- way scheduling actually converges, and the columns stay a state machine
-- rather than a message log.
--
-- "DeadlineNotifiedAt" records that the once-per-deadline "this round is
-- overdue" notification has fired, so the sweep can run on every lobby tick
-- without nagging. Extending the deadline re-arms it (the clock adjustment
-- clears the marker).

ALTER TABLE public."Tournaments"
    ADD COLUMN IF NOT EXISTS "Pacing" text COLLATE pg_catalog."default" NOT NULL DEFAULT 'live';

ALTER TABLE public."Tournaments"
    ADD COLUMN IF NOT EXISTS "RoundDeadlineDays" integer;

ALTER TABLE public."Tournaments"
    ADD COLUMN IF NOT EXISTS "DeadlineNotifiedAt" timestamp without time zone;

ALTER TABLE public."TournamentMatches"
    ADD COLUMN IF NOT EXISTS "ScheduledAt" timestamp without time zone;

ALTER TABLE public."TournamentMatches"
    ADD COLUMN IF NOT EXISTS "ProposedTime" timestamp without time zone;

ALTER TABLE public."TournamentMatches"
    ADD COLUMN IF NOT EXISTS "ProposedBy" integer;

ALTER TABLE public."TournamentMatches"
    ADD COLUMN IF NOT EXISTS "ScheduleNote" text COLLATE pg_catalog."default";

-- The proposer is display data, not history: if the account goes away the
-- proposal simply loses its name rather than blocking the deletion.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'FK_TournamentMatches_ProposedBy'
    ) THEN
        ALTER TABLE public."TournamentMatches"
            ADD CONSTRAINT "FK_TournamentMatches_ProposedBy" FOREIGN KEY ("ProposedBy")
            REFERENCES public."Users" ("Id") MATCH SIMPLE
            ON UPDATE NO ACTION
            ON DELETE SET NULL;
    END IF;
END $$;

-- The deadline sweep asks one narrow question - "which async events are past
-- their round deadline and not yet flagged?" - so the index only carries the
-- rows that could ever answer it.
CREATE INDEX IF NOT EXISTS "IX_Tournaments_AsyncDeadline"
    ON public."Tournaments" USING btree ("RoundEndsAt" ASC NULLS LAST)
    WHERE "Status" = 'active' AND "Pacing" = 'async' AND "RoundEndsAt" IS NOT NULL;
