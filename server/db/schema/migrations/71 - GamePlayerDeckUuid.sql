-- ARCHON: record WHICH DECK a game was played with, not just which row.
--
-- "GamePlayers"."DeckId" points at a row in a mutable collection, and the FK is
-- ON DELETE SET NULL. Deleting a deck therefore did not archive its games, it
-- erased them: every "GamePlayers" row for that deck lost its only link, so the
-- wins and losses vanished. Re-importing the deck did not bring them back
-- either - the import inserts a NEW row with a new Id, and the old games point
-- at nothing.
--
-- A deck's identity is its Master Vault uuid, which outlives any particular
-- row, so that is what the game record should carry. "DeckId" stays as the
-- live link (every existing query joins on it); "DeckUuid" is the durable one
-- underneath it, written at game time and used to re-point the games back when
-- the deck is imported again.
ALTER TABLE public."GamePlayers"
    ADD COLUMN IF NOT EXISTS "DeckUuid" text;

-- Everything still linked can be recovered from the link itself. Rows already
-- orphaned by a deletion cannot - nothing recorded the uuid at the time - and
-- `npm run relink:decks` recovers what it can of those from replay headers.
UPDATE public."GamePlayers" gp
SET "DeckUuid" = d."Uuid"
FROM public."Decks" d
WHERE gp."DeckId" = d."Id"
  AND gp."DeckUuid" IS NULL
  AND d."Uuid" IS NOT NULL;

-- Partial: null for alliance and standalone decks, which have no Master Vault
-- uuid, and nothing looks a null one up.
CREATE INDEX IF NOT EXISTS "IX_GamePlayers_DeckUuid"
    ON public."GamePlayers" ("DeckUuid")
    WHERE "DeckUuid" IS NOT NULL;
