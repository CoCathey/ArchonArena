-- ARCHON (N24): the Gauntlet - Champion's Challenge against the field.
--
-- Until now the Challenge could only play a member's decks against EACH OTHER,
-- which measures a deck against the company it keeps. A deck that wins 70% in a
-- collection of weak decks and one that wins 70% against the world are not the
-- same deck, and the mirror lab cannot tell them apart.
--
-- The field comes from the Master Vault deck catalog this site already crawls
-- (DeckCatalog, see docs/design/deck-catalog.md - the same walk Decks of
-- KeyForge uses to index every deck that exists). The catalog holds names and
-- uuids only, deliberately: a search result needs a name, and asking Master
-- Vault for card lists would multiply every crawl response by two orders of
-- magnitude. So a catalog deck has to be HYDRATED - its cards fetched once -
-- before the engine can play it, and that is what GauntletDecks holds.

-- The playable pool: foreign decks whose cards have been fetched and proven
-- simulatable. One row per Master Vault deck, forever - a registered deck's
-- contents never change, so a hydrated deck is never re-fetched.
CREATE TABLE IF NOT EXISTS public."GauntletDecks"
(
    "Uuid" text COLLATE pg_catalog."default" NOT NULL,
    "Name" text COLLATE pg_catalog."default" NOT NULL,
    "Expansion" integer NOT NULL,
    -- Comma-separated house codes, as DeckCatalog stores them.
    "Houses" text COLLATE pg_catalog."default",
    -- The parsed card list, exactly the shape the engine's selectDeck wants
    -- (id, count, maverick, anomaly, house, enhancements, isNonDeck). Kept as
    -- one document rather than a child table because it is only ever read
    -- whole, by one consumer, to hand straight to the engine.
    "Cards" jsonb,
    -- false when the deck cannot be simulated here: a card this server has no
    -- data for, or a house count the engine will not accept. Kept as a row
    -- rather than deleted so the hydrator never spends another Master Vault
    -- request on it, and so "how much of the catalog can we play" is answerable.
    "Playable" boolean NOT NULL DEFAULT false,
    -- Why it is unplayable, for the operator: the missing card ids.
    "MissingCards" text COLLATE pg_catalog."default",
    -- ARCHON (N30): what the deck is trying to do, read from the card list above
    -- (deckProfile.js) - printed amber, creature power and armour, plus
    -- clause-level keyword counts, on their own scale and deliberately not
    -- called AERC or SAS. This is what makes the strategy filters work on a
    -- server with no Decks of KeyForge key; DoK's numbers still win for any deck
    -- that has them. Costs no outbound request: the cards are already here.
    "Profile" jsonb,
    "FetchedAt" timestamp without time zone NOT NULL,
    -- Spreads the draw across the pool instead of favouring whatever postgres
    -- hands back first; also shows the operator that the pool is being used.
    "LastPlayedAt" timestamp without time zone,
    "GamesPlayed" integer NOT NULL DEFAULT 0,
    -- When Decks of KeyForge was last asked about this deck's SAS - set whether
    -- or not it answered, which is the point. The pool's SAS and strategy
    -- filters need enrichment to mean anything, but plenty of pool decks are
    -- ones DoK has no rating for, and "no DeckSas row" cannot tell those apart
    -- from decks nobody has asked about yet. Without this stamp the sweep asked
    -- the same handful of unanswerable decks every run, forever, and never
    -- reached the rest of the pool.
    "SasAskedAt" timestamp without time zone,
    CONSTRAINT "PK_GauntletDecks" PRIMARY KEY ("Uuid")
)

TABLESPACE pg_default;

-- The draw: playable decks, filtered by set, ordered by least recently played.
CREATE INDEX IF NOT EXISTS "IX_GauntletDecks_Playable"
    ON public."GauntletDecks" USING btree
    ("Playable" ASC NULLS LAST, "Expansion" ASC NULLS LAST, "LastPlayedAt" ASC NULLS FIRST)
    TABLESPACE pg_default;

-- Per-member Gauntlet configuration. One row per member, created on first save.
CREATE TABLE IF NOT EXISTS public."GauntletSettings"
(
    "UserId" integer NOT NULL,
    "Enabled" boolean NOT NULL DEFAULT false,
    -- What share of this member's sparring games are played against the field,
    -- 0-100. The rest stay mirror games: both measurements are useful, and a
    -- member who wants only one moves the dial to an end.
    "FieldSharePct" smallint NOT NULL DEFAULT 50,
    -- Comma-separated Master Vault expansion numbers; empty means every set
    -- this server can play.
    "Sets" text COLLATE pg_catalog."default",
    -- Comma-separated house codes the opponent must contain; empty means any.
    "Houses" text COLLATE pg_catalog."default",
    -- Comma-separated strategy keys (see GauntletService.STRATEGIES), matched
    -- against the deck's AERC breakdown. Empty means any.
    "Strategies" text COLLATE pg_catalog."default",
    -- SAS window for the opponent; null means open-ended.
    "MinSas" integer,
    "MaxSas" integer,
    "UpdatedAt" timestamp without time zone NOT NULL,
    CONSTRAINT "PK_GauntletSettings" PRIMARY KEY ("UserId"),
    CONSTRAINT "CK_GauntletSettings_FieldShare" CHECK ("FieldSharePct" BETWEEN 0 AND 100),
    CONSTRAINT "FK_GauntletSettings_Users" FOREIGN KEY ("UserId")
        REFERENCES public."Users" ("Id") MATCH SIMPLE
        ON UPDATE NO ACTION
        ON DELETE CASCADE
)

TABLESPACE pg_default;

-- One Gauntlet game: a member's deck against a foreign deck.
--
-- Deliberately NOT ProvingGroundsGames. That table's two columns are both
-- foreign keys into "Decks", and a Gauntlet opponent has no row there - but the
-- deeper reason is that these are a different measurement. "How does my deck do
-- against my own decks" and "how does it do against the field" are separate
-- claims, and averaging them into one win rate would produce a number that
-- answers neither question. The report shows them side by side instead.
CREATE TABLE IF NOT EXISTS public."GauntletGames"
(
    "Id" integer NOT NULL GENERATED BY DEFAULT AS IDENTITY ( INCREMENT 1 START 1 MINVALUE 1 MAXVALUE 2147483647 CACHE 1 ),
    "UserId" integer NOT NULL,
    -- The member's deck. One row per game, from that deck's point of view, so
    -- "Won" is unambiguous and every aggregate is a single-column filter.
    "DeckId" integer NOT NULL,
    "OpponentUuid" text COLLATE pg_catalog."default" NOT NULL,
    -- Denormalised so a result stays readable if the pool row is ever pruned,
    -- and so the report does not join for a label. The opponent's SAS at the
    -- time of the game is the honest comparison point for the result.
    "OpponentName" text COLLATE pg_catalog."default",
    "OpponentSas" integer,
    "Won" boolean NOT NULL,
    "MyKeys" smallint NOT NULL,
    "OpponentKeys" smallint NOT NULL,
    "Turns" smallint NOT NULL,
    "WentFirst" boolean NOT NULL,
    "MyFirstHouse" text COLLATE pg_catalog."default",
    "OpponentFirstHouse" text COLLATE pg_catalog."default",
    "DurationMs" integer,
    -- ARCHON (N28): which of the three sparring pilots played it, both seats.
    "Persona" text COLLATE pg_catalog."default",
    "FinishedAt" timestamp without time zone NOT NULL,
    CONSTRAINT "PK_GauntletGames" PRIMARY KEY ("Id"),
    CONSTRAINT "FK_GauntletGames_Users" FOREIGN KEY ("UserId")
        REFERENCES public."Users" ("Id") MATCH SIMPLE
        ON UPDATE NO ACTION
        ON DELETE CASCADE,
    -- CASCADE with the deck, for the same reason the mirror games do: a result
    -- for a deck that no longer exists has nothing to name it by.
    CONSTRAINT "FK_GauntletGames_Decks" FOREIGN KEY ("DeckId")
        REFERENCES public."Decks" ("Id") MATCH SIMPLE
        ON UPDATE NO ACTION
        ON DELETE CASCADE
)

TABLESPACE pg_default;

-- The report reads one member's field games per deck; the sweep counts a
-- member's games since UTC midnight.
CREATE INDEX IF NOT EXISTS "IX_GauntletGames_Deck"
    ON public."GauntletGames" USING btree
    ("DeckId" ASC NULLS LAST, "FinishedAt" DESC NULLS LAST)
    TABLESPACE pg_default;

CREATE INDEX IF NOT EXISTS "IX_GauntletGames_User_FinishedAt"
    ON public."GauntletGames" USING btree
    ("UserId" ASC NULLS LAST, "FinishedAt" DESC NULLS LAST)
    TABLESPACE pg_default;

-- ARCHON (N24): the sweep lease - which process is currently playing the
-- Champion's Challenge's games.
--
-- Simulated games are CPU, and CPU spent on sparring is CPU not spent on the
-- real games a person is waiting for. So the sweep can be moved off the lobby
-- onto a node of its own (server/challengeworker), and this row is how two
-- processes that can both see the database agree that only one of them plays:
-- whoever holds a fresh lease sweeps, everyone else stands down. A crashed
-- holder costs one lease period of idleness, never a double-played roster.
--
-- One row, forever - "Id" is pinned to 1 by a CHECK, because two leases would
-- mean two sweepers each certain it was the only one, and the damage (every
-- deck quietly played twice as hard as its daily budget allows) is invisible
-- in the results.
CREATE TABLE IF NOT EXISTS public."ChallengeSweepLease"
(
    "Id" integer NOT NULL DEFAULT 1,
    -- Free-form process identity, for the operator: "worker@host", "lobby@host".
    "Owner" text COLLATE pg_catalog."default" NOT NULL,
    "HeartbeatAt" timestamp without time zone NOT NULL,
    CONSTRAINT "PK_ChallengeSweepLease" PRIMARY KEY ("Id"),
    CONSTRAINT "CK_ChallengeSweepLease_SingleRow" CHECK ("Id" = 1)
)

TABLESPACE pg_default;
