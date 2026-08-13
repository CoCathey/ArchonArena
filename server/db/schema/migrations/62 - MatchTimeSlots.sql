-- Several times offered for one match, and the zone each was offered from.
--
-- Scheduling used to be a single live offer: one player proposed a time, the
-- other accepted it or replaced it with a counter-proposal. That is one round
-- trip per candidate time, between two people who are usually asleep when the
-- other is awake - which is the whole reason an asynchronous event exists. Two
-- players three time zones apart could spend a day of a three-day round finding
-- out that Thursday does not work either.
--
-- A player can now offer several times at once and the other picks one, or adds
-- more of their own. Every live offer is a row here; accepting one sets the
-- match's ScheduledAt and clears them all.
--
-- WHY THE ZONE IS STORED
--
-- "8pm" is not a time until you know whose 8pm. Both players see every offer in
-- their OWN zone, which the browser knows without anybody configuring anything -
-- but "8pm your time, 3am theirs" is the sentence that stops somebody agreeing
-- to a match at three in the morning, and that needs the proposer's zone. It is
-- an IANA name ('America/Chicago'), captured from the browser when the offer is
-- made, and it is advisory: a missing or unrecognised one just means the offer
-- shows in the reader's zone alone, which is what happened before this existed.
--
-- The instant itself is UTC in SlotTime, as everywhere else in this schema. The
-- zone is for saying it back to a human, never for computing with.

CREATE TABLE IF NOT EXISTS public."TournamentMatchTimeSlots"
(
    "Id" serial NOT NULL,
    "MatchId" integer NOT NULL,
    "ProposedBy" integer NOT NULL,
    "SlotTime" timestamp without time zone NOT NULL,
    "ProposerZone" text COLLATE pg_catalog."default",
    "CreatedAt" timestamp without time zone NOT NULL DEFAULT (now() AT TIME ZONE 'utc'),
    CONSTRAINT "PK_TournamentMatchTimeSlots" PRIMARY KEY ("Id"),
    CONSTRAINT "FK_TournamentMatchTimeSlots_Match" FOREIGN KEY ("MatchId")
        REFERENCES public."TournamentMatches" ("Id") MATCH SIMPLE
        ON UPDATE NO ACTION
        -- The offers belong to the match. A match going away takes them.
        ON DELETE CASCADE,
    CONSTRAINT "FK_TournamentMatchTimeSlots_ProposedBy" FOREIGN KEY ("ProposedBy")
        REFERENCES public."Users" ("Id") MATCH SIMPLE
        ON UPDATE NO ACTION
        ON DELETE CASCADE,
    -- The same instant twice is not two options. Offering a time somebody else
    -- already offered is agreement, and the UI treats it as such rather than
    -- listing it again.
    CONSTRAINT "UQ_TournamentMatchTimeSlots_MatchTime" UNIQUE ("MatchId", "SlotTime")
);

CREATE INDEX IF NOT EXISTS "IX_TournamentMatchTimeSlots_MatchId"
    ON public."TournamentMatchTimeSlots" ("MatchId");
