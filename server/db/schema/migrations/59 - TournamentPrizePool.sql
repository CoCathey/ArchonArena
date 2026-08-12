-- Buy-in and prize split for an event.
--
-- WHAT THIS IS NOT
--
-- The platform does not take, hold, or move any money. These columns record
-- what the organizer told everyone the event costs and how the pot is meant to
-- be divided; the organizer collects and pays out however they already do.
-- There is no payment integration behind this and no balance anywhere.
--
-- That is a deliberate line rather than a stage of construction. Handling the
-- money would mean KYC on every payee, 1099s every January, chargeback
-- liability on every buy-in, geo-restriction kept current as contest law
-- changes, and a Stripe relationship that a dispute rate could cost us for the
-- whole site - permanently, in exchange for a few dollars an event. What
-- organizers actually want from a platform is not to do the arithmetic in
-- their head at the end of the night, and that is what this gives them.
--
-- WHY CENTS AND BASIS POINTS
--
-- "EntryFeeCents" is an integer minor unit, never a decimal: money in floats
-- is how a prize table stops adding up to the pot. "PrizeSplits" is basis
-- points for the same reason (7500 = 75%), stored as
--   [{"rank": 1, "bps": 7500}, {"rank": 2, "bps": 2000}]
-- Splits summing to less than 10000 is normal and meaningful - the remainder
-- is the cut the venue keeps.
--
-- The arithmetic itself lives in client/Components/Tournaments/prizePool.js.
-- Nothing on the server consumes these beyond storing them, so there is one
-- implementation and it cannot disagree with itself. If money ever does move
-- through the platform that calculation becomes authoritative and moves here -
-- a deliberate change at that point, not something to pre-empt now.

ALTER TABLE public."Tournaments"
    ADD COLUMN IF NOT EXISTS "EntryFeeCents" integer,
    ADD COLUMN IF NOT EXISTS "PrizeCurrency" text COLLATE pg_catalog."default" DEFAULT 'USD',
    ADD COLUMN IF NOT EXISTS "PrizeSplits" jsonb,
    ADD COLUMN IF NOT EXISTS "PrizeNote" text COLLATE pg_catalog."default";
