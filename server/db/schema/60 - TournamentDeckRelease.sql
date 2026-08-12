-- Judge override for a registered deck.
--
-- WHY THIS IS A COLUMN AND NOT JUST A NULL "DeckId"
--
-- A locked event freezes each player's deck when it starts, and the refusal
-- the player gets tells them to ask the organizer - who, until this, could do
-- nothing about it. A deck registered against the wrong entry, or one that
-- turns out to be illegal once a judge looks at it, was stuck for the whole
-- event.
--
-- The fix is for the organizer to be able to release a deck, after which the
-- player re-picks through their own deck picker so every one of the event's
-- legality rules still runs on what they choose. But "released by a judge"
-- and "never registered a deck at all" both look like DeckId IS NULL, and
-- they must NOT be treated the same: allowing anyone with an empty DeckId to
-- register after the event starts would let a player in a locked event
-- withhold their deck, read the pairings, and only then choose. That is the
-- whole thing the lock exists to prevent.
--
-- So the release is recorded. It is a timestamp rather than a boolean because
-- it is the only trace the override leaves - an organizer looking at a
-- disputed event afterwards can see that a deck was released and when.
-- Registering a deck clears it, so the permission is spent by the one
-- registration it was granted for.

ALTER TABLE public."TournamentPlayers"
    ADD COLUMN IF NOT EXISTS "DeckReleasedAt" timestamp without time zone;
