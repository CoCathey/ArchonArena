-- ARCHON (F9): practice games are recorded, and are not results.
--
-- Games against a practice bot are now kept: a player wants to find the game
-- again, watch the replay back, and show somebody the turn that won it, and
-- none of that is possible for a game that was never written down.
--
-- But a recorded game is not a RESULT. Every statistic on this site - deck
-- records, house and meta aggregates, player win rates, the Tournament Lab,
-- the intelligence reports - selects finished games with the same shape:
-- "FinishedAt IS NOT NULL AND WinnerId IS NOT NULL". Without a way to say
-- "this one does not count", persisting a bot game would make it a real
-- result in thirty places at once, silently.
--
-- So the row carries the flag, every aggregate excludes it, and a spec reads
-- the source to prove no aggregate forgets. Ratings do not consult the flag
-- at all: the router simply never rates a bot game, which is the earlier and
-- stronger guard.
--
-- Existing rows are real games by definition, which is why FALSE is the right
-- default and no backfill is needed.

ALTER TABLE public."Games"
    ADD COLUMN IF NOT EXISTS "BotGame" boolean NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS "IX_Games_BotGame"
    ON public."Games" ("BotGame")
    WHERE "BotGame" IS TRUE;
