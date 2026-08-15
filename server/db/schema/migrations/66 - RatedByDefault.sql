-- ARCHON: new events are rated unless the organizer says otherwise.
--
-- The product default now lives in TournamentService.create, which is what
-- actually decides this - every INSERT supplies the column explicitly. This
-- migration exists so the schema does not say the opposite of the product to
-- the next person who reads it, or to anything that inserts a row directly.
--
-- Deliberately DEFAULT only. Existing rows are untouched: an organizer who
-- chose an unrated event chose it, and finished events must not be re-rated
-- retroactively - that would rewrite ratings other players already earned.
ALTER TABLE public."Tournaments"
    ALTER COLUMN "RatedGames" SET DEFAULT true;
