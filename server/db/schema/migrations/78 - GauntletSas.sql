-- ARCHON (N27): remember when the Gauntlet last asked Decks of KeyForge about a
-- pool deck, whether or not DoK had an answer.
--
-- The Gauntlet's SAS and strategy filters are computed from DoK enrichment, so a
-- pool deck with no DeckSas row satisfies no filter and can never be drawn. The
-- enrichment pass therefore looked for pool decks with no DeckSas row - which is
-- also, and indistinguishably, what a deck DoK has never heard of looks like.
-- Master Vault registers decks DoK does not rate, so the pass spent its whole
-- per-run budget re-asking the same unanswerable decks on every sweep and never
-- reached the decks behind them.
--
-- One nullable timestamp fixes it: stamped on every ask, ordered NULLS FIRST, so
-- each deck is asked once per retry window and the queue rotates through the
-- pool instead of grinding on its head.
ALTER TABLE public."GauntletDecks"
    ADD COLUMN IF NOT EXISTS "SasAskedAt" timestamp without time zone;
