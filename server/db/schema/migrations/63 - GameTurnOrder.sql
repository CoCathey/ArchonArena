-- ARCHON (N12): record who took the first turn.
--
-- "Do I win more going first?" is one of the few genuinely actionable things a
-- KeyForge player can learn about their own results, and it has never been
-- answerable here. Not because the information was hard to get - the engine has
-- always known it, FirstPlayerSelection sets game.firstPlayer during setup -
-- but because getSaveState() never carried it and there was no column to put it
-- in. It was thrown away at the end of every game ever played on the platform.
--
-- Nullable, and deliberately not defaulted to false. Every game that finished
-- before this migration has no recorded turn order, and NULL is the only honest
-- way to say so: defaulting to false would silently claim that every historic
-- game was played on the draw, and the going-first win rate computed from that
-- would be wrong in a way nobody could see. Archon Intelligence excludes NULL
-- rows from the split and tells the player how many games are missing it.
--
-- Written by GameService.update from the save state, with COALESCE so a partial
-- or repeated save cannot overwrite a value already recorded.

ALTER TABLE public."GamePlayers"
    ADD COLUMN IF NOT EXISTS "WentFirst" boolean;
