-- ARCHON (N28): three sparring pilots, and the record of which one played.
--
-- Every sparring game the lab had ever played was piloted by one policy, so a
-- deck's win rate meant "how this deck does against this bot" - and a deck that
-- happened to punish that bot's habits carried a rating saying it was strong,
-- with nothing in the output able to show it. The lab now rotates three personas
-- (one learned brain, three fixed style biases - see labPersonas.js), so a
-- rating is an average over three styles and the spread across them is itself a
-- fact about the deck.
--
-- Which pilot played is therefore part of the result, not a runtime detail: the
-- per-persona records on the Challenge page are read straight off these columns,
-- and a game whose pilot was not recorded cannot be attributed later.
ALTER TABLE public."ProvingGroundsGames"
    ADD COLUMN IF NOT EXISTS "Persona" text;

ALTER TABLE public."GauntletGames"
    ADD COLUMN IF NOT EXISTS "Persona" text;

-- The diary too: a training row produced by a stylised pilot is still valid
-- off-policy data (the labels come from outcomes and search, not from the
-- behaviour), but "two thirds of my diary is Racer games" is a question that
-- should have an answer.
ALTER TABLE public."BotTrainingGames"
    ADD COLUMN IF NOT EXISTS "Persona" text;

-- The calibration: personas playing each other.
--
-- A persona is the champion pulled away from the policy trained to win, so each
-- one is slightly weaker than the champion - and a persona pulled TOO far is a
-- bad player, which would make a deck's spread across the three measure "which
-- decks punish bad play" rather than style matchup. That has to be observable,
-- and it cannot be observed from ordinary sparring, where both seats share a
-- pilot by design (which is what keeps a game's result attributable to the
-- decks).
--
-- So the personas duel: paired seeds, one seed played twice with the two pilots
-- swapped between seats, exactly as the champion-versus-candidate arena does, so
-- deck and draw luck cancel and what survives the pair is the difference between
-- the players. One row per unordered pair, keys sorted, wins counted per side.
CREATE TABLE IF NOT EXISTS public."ChallengePersonaDuels"
(
    -- Sorted, so a pair is one row rather than two halves of one record filed
    -- under different names.
    "PersonaA" text COLLATE pg_catalog."default" NOT NULL,
    "PersonaB" text COLLATE pg_catalog."default" NOT NULL,
    "WinsA" integer NOT NULL DEFAULT 0,
    "WinsB" integer NOT NULL DEFAULT 0,
    "UpdatedAt" timestamp without time zone NOT NULL,
    CONSTRAINT "PK_ChallengePersonaDuels" PRIMARY KEY ("PersonaA", "PersonaB")
)

TABLESPACE pg_default;
