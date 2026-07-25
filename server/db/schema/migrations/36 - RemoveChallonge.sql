-- Remove the legacy Challonge integration. All tournaments now run on the
-- native Archon Arena tournament engine (the "Tournaments" tables), so the
-- per-user Challonge API credentials are no longer stored or used.

DROP TABLE IF EXISTS public."ChallongeSettings";
