-- Reminders for asynchronous events.
--
-- WHY THESE ARE COLUMNS AND NOT A JOB QUEUE
--
-- An async league is paced in days, and the platform is the only thing keeping
-- time. Two players agree to meet on Thursday at eight; nothing reminds either
-- of them. A round ends on Sunday; nothing says so until Monday, when the
-- deadline sweep tells the organizer the round is overdue and matches start
-- being decided by the clock instead of by play. Every notification the event
-- sent was about something that had ALREADY happened.
--
-- Both reminders are "fire exactly once, for this thing, ever", which is a
-- marker on the row rather than a queue: the sweep that flips the marker is
-- the one that announces, so several lobby processes stay one voice, and a
-- restart cannot replay a reminder that already went out. This is the same
-- shape "DeadlineNotifiedAt" already uses for the deadline-passed notice.
--
-- "DeadlineWarnedAt" is separate from "DeadlineNotifiedAt" because they are
-- different events - "your round ends tomorrow" and "your round ended" - and
-- collapsing them would mean a round that fired the warning could never fire
-- the notice.
--
-- "ScheduleRemindedAt" sits on the match because that is what was scheduled,
-- and it is cleared whenever the agreed time changes, so a rescheduled match
-- gets a fresh reminder rather than being treated as already reminded.

ALTER TABLE public."Tournaments"
    ADD COLUMN IF NOT EXISTS "DeadlineWarnedAt" timestamp without time zone;

ALTER TABLE public."TournamentMatches"
    ADD COLUMN IF NOT EXISTS "ScheduleRemindedAt" timestamp without time zone;
