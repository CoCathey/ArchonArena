-- ARCHON: index "Decks"."Uuid".
--
-- Two questions are now asked by uuid rather than by name: how many people own
-- this deck (the Used / Popular / Notorious level), and what every copy of it
-- has done in games (the deck page's all-players record). Name had an index and
-- uuid did not, so both were sequential scans of "Decks" per row - fine on a
-- single deck page, not fine on a page of fifteen decks.
--
-- Uuid is null for rows imported before it was recorded and for standalone
-- decks, and those rows fall back to matching on name, so the index is partial:
-- nothing looks a null uuid up.
CREATE INDEX IF NOT EXISTS "IX_Decks_Uuid"
    ON public."Decks" ("Uuid")
    WHERE "Uuid" IS NOT NULL;
