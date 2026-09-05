-- An offered time can be a window.
--
-- "Thursday at 8" is one offer. "Any time Thursday evening" was five offers, or
-- more often a note nobody could act on, because the only thing a player could
-- put on the table was an instant. Two players in different zones spent a round
-- trip per candidate hour, and the whole point of offering several times at
-- once (migration 65) was to stop that.
--
-- "SlotEnd" turns a row into a window: from SlotTime until SlotEnd, the proposer
-- is available. NULL is the old meaning - a single instant - and every existing
-- row keeps it. The other player accepts a window by naming an instant inside it,
-- which becomes the match's ScheduledAt exactly as before; nothing downstream
-- (reminders, the schedule panel) has to learn what a window is.
--
-- The unique key stays (MatchId, SlotTime): the same start offered twice is one
-- offer, and the later, wider end wins.

ALTER TABLE public."TournamentMatchTimeSlots"
    ADD COLUMN IF NOT EXISTS "SlotEnd" timestamp without time zone;
