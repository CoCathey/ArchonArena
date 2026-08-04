-- Tournament result integrity: confirmation, disputes, and a round clock
-- that cannot deadlock the event.
--
-- WHY RESULTS NEED A SECOND SIGNATURE
--
-- Until now any participant could report any result on their own match and it
-- was final: only the organizer could change it afterwards. In an online event
-- that is mostly harmless, because the platform witnessed the game and reports
-- itself. In an in-person or paper-reporting event it is the whole ballgame -
-- one player types "I won", and the opponent's only recourse is to find the
-- organizer and hope. Nothing in the record even showed that the loser had
-- never agreed.
--
-- So a reported result now carries who agreed to it:
--
--   * Reporting your OWN loss is self-evidently honest, and lands confirmed.
--   * Reporting your own WIN lands unconfirmed, and the opponent is asked.
--   * The opponent can confirm (done) or dispute (organizer's problem now).
--   * Organizers and staff always land confirmed - adjudication is their job.
--   * Results the platform itself witnessed (a game played here) land
--     confirmed, because there is nothing to take anyone's word about.
--
-- An unconfirmed result still counts. That is deliberate: holding up the
-- standings until both players click would hand any sore loser a veto over the
-- round, which is a worse failure than the one being fixed. What the flag buys
-- is that disagreement is *visible* - the organizer sees a disputed match
-- instead of hearing about it at the awards ceremony.
--
-- WHY THE ROUND CLOCK NEEDED TEETH
--
-- RoundTimerMinutes and RoundStartedAt existed but nothing ever read them: the
-- timer was a picture of a clock. Meanwhile pairing the next round refuses
-- while any result is missing. Between those two, one player who closes their
-- laptop mid-round stops the event permanently, and the organizer's only tool
-- is to award each stranded match by hand.
--
-- RoundEndsAt makes the deadline a real, stored fact (so it survives a restart
-- and every client agrees on it), and the service gains a bulk resolution the
-- organizer can run when time is up.

-- Who has agreed to the result on this match, and whether anyone has objected.
-- NULL ConfirmedBy on a decided match means "reported, not yet agreed".
ALTER TABLE public."TournamentMatches"
    ADD COLUMN IF NOT EXISTS "ConfirmedBy" integer;

ALTER TABLE public."TournamentMatches"
    ADD COLUMN IF NOT EXISTS "ConfirmedAt" timestamp without time zone;

ALTER TABLE public."TournamentMatches"
    ADD COLUMN IF NOT EXISTS "DisputedBy" integer;

ALTER TABLE public."TournamentMatches"
    ADD COLUMN IF NOT EXISTS "DisputedAt" timestamp without time zone;

-- What the disputing player says happened. Free text, shown to the organizer.
ALTER TABLE public."TournamentMatches"
    ADD COLUMN IF NOT EXISTS "DisputeNote" text COLLATE pg_catalog."default";

-- ADD CONSTRAINT has no IF NOT EXISTS, and a database built from
-- server/db/schema already carries these. Migrations have to tolerate being
-- pointed at a database that is further along than expected.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'FK_TournamentMatches_ConfirmedBy'
    ) THEN
        ALTER TABLE public."TournamentMatches"
            ADD CONSTRAINT "FK_TournamentMatches_ConfirmedBy" FOREIGN KEY ("ConfirmedBy")
                REFERENCES public."Users" ("Id") MATCH SIMPLE
                ON UPDATE NO ACTION
                ON DELETE SET NULL
                NOT VALID;
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'FK_TournamentMatches_DisputedBy'
    ) THEN
        ALTER TABLE public."TournamentMatches"
            ADD CONSTRAINT "FK_TournamentMatches_DisputedBy" FOREIGN KEY ("DisputedBy")
                REFERENCES public."Users" ("Id") MATCH SIMPLE
                ON UPDATE NO ACTION
                ON DELETE SET NULL
                NOT VALID;
    END IF;
END
$$;

-- Existing decided results predate confirmation. Treat them as confirmed by
-- whoever reported them rather than presenting a finished event as a wall of
-- unresolved disputes.
UPDATE public."TournamentMatches"
    SET "ConfirmedBy" = COALESCE("ReportedBy", "WinnerId"),
        "ConfirmedAt" = COALESCE("ReportedAt", now() AT TIME ZONE 'utc')
    WHERE "ConfirmedBy" IS NULL
      AND ("WinnerId" IS NOT NULL OR "ResultType" IS NOT NULL);

-- When the current round is due to end. Derived from RoundStartedAt +
-- RoundTimerMinutes at pairing time, but stored, so that extending the round
-- is a real edit rather than a lie the clients each compute differently.
ALTER TABLE public."Tournaments"
    ADD COLUMN IF NOT EXISTS "RoundEndsAt" timestamp without time zone;

-- Finding the matches an organizer has to deal with is the single most common
-- query while an event is running.
CREATE INDEX IF NOT EXISTS "IX_TournamentMatches_Disputed"
    ON public."TournamentMatches" USING btree ("TournamentId" ASC NULLS LAST)
    WHERE "DisputedBy" IS NOT NULL;
