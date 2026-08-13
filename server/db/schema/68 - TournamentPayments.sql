-- Who has paid their entry, and how the organizer wants to be paid.
--
-- The platform still takes no money and moves none - see migration 59. This is
-- a register the organizer keeps, in the place everyone is already looking,
-- instead of on paper or in their head. A paid event runs on the organizer
-- knowing who has handed over ten dollars, and at eight players on a Friday
-- that is genuinely hard to hold: people pay at different times, some pay a
-- judge rather than the organizer, and somebody always says they paid last
-- week.
--
-- "PaymentInstructions" is how to pay - a cash-at-the-counter note, a payment
-- handle, a link. Shown to players wherever the buy-in is shown, because a fee
-- with no way to pay it is the most obvious question an event can leave open.
--
-- "PaidAt" and "PaidBy" record the tick: when, and which staff member made it.
-- Two columns rather than a boolean because "who marked this" is the question
-- that actually gets asked when a player and an organizer disagree, and a
-- boolean cannot answer it. NULL means unpaid, which is also the default for
-- everybody, including players who registered before the fee existed.
--
-- Enforcement lives in TournamentService.start, next to the registered-deck
-- check it is modelled on: an event that requires payment will not start with
-- unpaid players in it, and the organizer either collects or removes them.

ALTER TABLE public."Tournaments"
    ADD COLUMN IF NOT EXISTS "PaymentInstructions" text COLLATE pg_catalog."default",
    -- Whether start() enforces payment. Separate from the fee being set,
    -- because "there is a buy-in" and "nobody plays until they have paid" are
    -- different decisions: a weekly event among friends may well collect as
    -- people arrive and not want the start button arguing about it.
    ADD COLUMN IF NOT EXISTS "RequirePayment" boolean NOT NULL DEFAULT false;

ALTER TABLE public."TournamentPlayers"
    ADD COLUMN IF NOT EXISTS "PaidAt" timestamp without time zone,
    ADD COLUMN IF NOT EXISTS "PaidBy" integer;

ALTER TABLE public."TournamentPlayers"
    DROP CONSTRAINT IF EXISTS "FK_TournamentPlayers_PaidBy";

ALTER TABLE public."TournamentPlayers"
    ADD CONSTRAINT "FK_TournamentPlayers_PaidBy" FOREIGN KEY ("PaidBy")
    REFERENCES public."Users" ("Id") MATCH SIMPLE
    ON UPDATE NO ACTION
    -- The record of the payment outlives the staff account that took it: a
    -- judge deleting their account must not silently un-pay eight players.
    ON DELETE SET NULL;
