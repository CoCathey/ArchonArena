-- Per-player option: hide your own hand while the opponent is taking their turn.
--
-- WHY THIS IS A STORED SETTING AND NOT JUST A CLIENT TOGGLE
--
-- It is purely presentational - the hand is already on the client either way,
-- and nothing about the game changes - so it could have lived in the browser.
-- It sits with the other option settings instead because that is where a
-- player looks for it: the same profile panel and the same in-game settings
-- menu that hold half-sized cards and the one-click prompt. A preference that
-- lives in one browser and not another is a preference players re-set every
-- time they sit down somewhere new.
--
-- Defaults to FALSE, which is the behaviour every existing player already has:
-- the hand stays visible. Nobody's board changes until they ask for it.

ALTER TABLE public."Users"
    ADD COLUMN IF NOT EXISTS "Settings_HideHandOnOpponentTurn" boolean DEFAULT false;
