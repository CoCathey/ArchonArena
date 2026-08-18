-- ARCHON (N41): which pilot the practice game was against.
--
-- N31 let a player choose a sparring style on the pending screen - the Racer,
-- the Bruiser, the Schemer, the same three pilots the Champion's Challenge
-- measures decks against. Then the choice vanished: nothing showed it on the
-- board while the game was played, and nothing recorded it afterwards.
--
-- So a player could not answer "which one keeps beating me", which is the only
-- question the feature exists to raise. And the site could not answer it
-- either: the lab knows exactly how each pilot does against SIMULATED decks and
-- had no idea how they do against people, which is a more interesting number
-- than anything on the health panel.
--
-- Nullable, because most games have no bot in them at all.
ALTER TABLE public."Games"
    ADD COLUMN IF NOT EXISTS "BotStyle" text COLLATE pg_catalog."default";
