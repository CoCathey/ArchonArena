-- ARCHON (N40): answers in minutes, instead of in days.
--
-- The lab plays a member's decks a dozen games a day each, which is the right
-- pace for a background service and the wrong pace for somebody with a
-- question. Twenty games is the threshold below which the page will not commit
-- to a verdict, so a member enrolled a deck, read "still proving", and had to
-- remember to come back in two days. Most did not.
--
-- A burst is the same games, asked for. The member names a deck and an
-- opposition, the lab plays a batch of them at the next tick, and the page
-- fills in while they watch.
--
-- A QUEUE rather than work done in the request, for the reason the sweep lease
-- exists at all: simulated games are CPU, the lobby serves live games on the
-- same event loop, and thirty games inside an HTTP handler would freeze every
-- table on the site for half a minute. So the request writes a row, and
-- whichever process holds the sweep lease picks it up - the one process already
-- designated to spend CPU on simulation.
CREATE TABLE IF NOT EXISTS public."ChallengeBurstRuns"
(
    "Id" serial NOT NULL,
    "UserId" integer NOT NULL,
    "DeckId" integer NOT NULL,
    -- 'roster' | 'field' | 'vaulttour' - which opposition to play. Checked in
    -- the service against a list, not here: the set of oppositions is a product
    -- decision that changes more often than a schema should.
    "Opposition" text COLLATE pg_catalog."default" NOT NULL,
    "Requested" integer NOT NULL,
    "Played" integer NOT NULL DEFAULT 0,
    "Wins" integer NOT NULL DEFAULT 0,
    "Losses" integer NOT NULL DEFAULT 0,
    -- Games the engine could not finish. Surfaced rather than hidden: a burst
    -- that abandons half its games is telling the member something about their
    -- deck, and silently reporting ten games when twenty were asked for reads
    -- as the feature being broken.
    "Abandoned" integer NOT NULL DEFAULT 0,
    -- 'queued' | 'running' | 'done' | 'failed'
    "Status" text COLLATE pg_catalog."default" NOT NULL DEFAULT 'queued',
    -- Why it stopped early, in words a member can read.
    "Note" text COLLATE pg_catalog."default",
    "CreatedAt" timestamp without time zone NOT NULL,
    "StartedAt" timestamp without time zone,
    "FinishedAt" timestamp without time zone,
    CONSTRAINT "PK_ChallengeBurstRuns" PRIMARY KEY ("Id"),
    -- A member's runs go with the member. Nothing here is evidence about
    -- anybody else - the GAMES are recorded in their own tables and survive.
    CONSTRAINT "FK_ChallengeBurstRuns_Users" FOREIGN KEY ("UserId")
        REFERENCES public."Users" ("Id") MATCH SIMPLE
        ON UPDATE NO ACTION
        ON DELETE CASCADE
)

TABLESPACE pg_default;

-- The queue read, every tick: the oldest run still waiting.
CREATE INDEX IF NOT EXISTS "IX_ChallengeBurstRuns_Queue"
    ON public."ChallengeBurstRuns" ("Status", "CreatedAt")
    WHERE "Status" IN ('queued', 'running');

-- "how many has this member started today", which is the budget.
CREATE INDEX IF NOT EXISTS "IX_ChallengeBurstRuns_UserDay"
    ON public."ChallengeBurstRuns" ("UserId", "CreatedAt" DESC);
