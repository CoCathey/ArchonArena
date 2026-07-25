-- Remove the per-game "type" concept (Beginner/Casual/Competitive).
-- Games are no longer categorised by type; every table behaves identically
-- and rating no longer depends on a game's type. Drop the now-unused column.

ALTER TABLE public."Games" DROP COLUMN IF EXISTS "GameType";
