-- Master Vault deck catalog: an index of every deck that EXISTS, so a player
-- can find their own decks by name instead of pasting a Master Vault link.
--
-- This is a lookup index, not a deck. It carries the four things a search
-- result needs - uuid, name, expansion, houses - and no cards. Picking a
-- result still runs the ordinary import path, which fetches the deck from
-- Master Vault and writes the real "Decks"/"DeckCards" rows; duplicating card
-- lists here would mean storing millions of decks nobody on this site will
-- ever play in order to answer a question that only needs a name.
--
-- WHY "Expansion" IS A RAW INTEGER WITH NO FOREIGN KEY
--
-- Every other deck table in this repo references "Expansions", and this one
-- deliberately does not. The crawler walks Master Vault in registration
-- order, so it reaches the first deck of a brand-new set on the day that set
-- goes on sale - weeks or months before this codebase has an "Expansions" row
-- for it. Under a foreign key that deck is an insert failure, and because the
-- crawl is a single ordered cursor it does not skip the page and move on: it
-- stalls, permanently, at exactly the moment indexing is worth the most -
-- release week, when every player is looking for the decks they just opened.
--
-- So the catalog stores whatever number Master Vault reported and asks no
-- questions about it. "Is this expansion playable here" is the import path's
-- decision, and the import path does validate it.

CREATE TABLE IF NOT EXISTS public."DeckCatalog"
(
    "Uuid" text COLLATE pg_catalog."default" NOT NULL,
    "Name" text COLLATE pg_catalog."default" NOT NULL,
    -- Raw Master Vault expansion number, intentionally unvalidated - see above.
    "Expansion" integer NOT NULL,
    -- Comma-separated house codes. Nullable because Master Vault does not
    -- always return houses on a list page, and a deck with an unknown house
    -- set is still worth finding by name.
    "Houses" text COLLATE pg_catalog."default",
    "FirstSeen" timestamp without time zone NOT NULL,
    CONSTRAINT "PK_DeckCatalog" PRIMARY KEY ("Uuid")
)

TABLESPACE pg_default;

-- The crawl cursor. One row, forever: "Id" is pinned to 1 by a CHECK so a
-- second cursor cannot exist. Two rows would mean two crawlers each convinced
-- they know where the walk had got to, and the damage - pages silently never
-- visited - is invisible in a catalog whose whole point is that you cannot
-- tell what is missing from it.
--
-- "ConsecutiveFailures" and "PausedUntil" are a circuit breaker. Master Vault
-- is someone else's service, and the polite response to it returning errors is
-- to stop asking for a while, not to hammer the same page every minute.
-- "CaughtUp" records that the walk has reached the end of the deck list, which
-- turns the job from a backfill into a cheap tail poll.
CREATE TABLE IF NOT EXISTS public."DeckCatalogState"
(
    "Id" integer NOT NULL DEFAULT 1,
    -- Pages count from 1: Master Vault's list is Django-paginated, and Django
    -- answers `?page=0` with the same 404 a wrong path gets. A cursor seeded
    -- at 0 pinned the crawl to a page that cannot exist.
    "CurrentPage" integer NOT NULL DEFAULT 1,
    -- bigint: Master Vault has passed two million decks and only ever grows.
    "TotalIndexed" bigint NOT NULL DEFAULT 0,
    "LastRunAt" timestamp without time zone,
    "LastError" text COLLATE pg_catalog."default",
    "PausedUntil" timestamp without time zone,
    "ConsecutiveFailures" integer NOT NULL DEFAULT 0,
    "CaughtUp" boolean NOT NULL DEFAULT false,
    CONSTRAINT "PK_DeckCatalogState" PRIMARY KEY ("Id"),
    CONSTRAINT "CK_DeckCatalogState_SingleRow" CHECK ("Id" = 1)
)

TABLESPACE pg_default;

-- Seeded here rather than created on first use: every reader expects the
-- cursor to exist, and one INSERT in the schema is cheaper than every caller
-- carrying an "or create it" branch that is exercised exactly once in the life
-- of the database.
INSERT INTO public."DeckCatalogState" ("Id") VALUES (1) ON CONFLICT DO NOTHING;

-- NAME SEARCH HAS TO SURVIVE A DATABASE THAT SAYS NO
--
-- The good index for "find the deck whose name contains this" is a pg_trgm
-- GIN one, and on a managed Postgres the application role is routinely not
-- allowed to CREATE EXTENSION. A migration that assumes it can is a migration
-- that works on the VPS and fails on RDS, at the one moment nobody wants to be
-- debugging SQL. So the indexes search can actually rely on are the two below,
-- which need nothing installed; trigrams are applied as an upgrade afterwards.

-- Exact lookup and collation-ordered listing.
CREATE INDEX IF NOT EXISTS "IX_DeckCatalog_NameLower"
    ON public."DeckCatalog" USING btree
    (lower("Name") COLLATE pg_catalog."default" ASC NULLS LAST)
    TABLESPACE pg_default;

-- Prefix matching, which is the whole of search wherever the trigram index
-- below never got created. It needs its own operator class: outside the C
-- collation a default btree cannot serve LIKE 'prefix%' at all, so without
-- this every keystroke is a sequential scan of every deck in existence.
CREATE INDEX IF NOT EXISTS "IX_DeckCatalog_NamePrefix"
    ON public."DeckCatalog" USING btree
    (lower("Name") COLLATE pg_catalog."default" text_pattern_ops ASC NULLS LAST)
    TABLESPACE pg_default;

-- Two handlers, not one. A PL/pgSQL block with an EXCEPTION clause is a
-- subtransaction, so putting both statements under a single handler means a
-- failed index build rolls the CREATE EXTENSION back with it - leaving a
-- database that could have had pg_trgm without it, while the notice blames
-- only the index. Separating them lets the extension survive, so a later
-- migration adding just the index has something to build on.
DO $$
BEGIN
    EXECUTE 'CREATE EXTENSION IF NOT EXISTS pg_trgm';
EXCEPTION
    WHEN OTHERS THEN
        RAISE NOTICE 'DeckCatalog: pg_trgm unavailable (% %) - deck name search matches from the start of the name instead of anywhere in it', SQLSTATE, SQLERRM;
END
$$;

DO $$
BEGIN
    EXECUTE 'CREATE INDEX IF NOT EXISTS "IX_DeckCatalog_NameTrgm" ' ||
        'ON public."DeckCatalog" USING gin (lower("Name") gin_trgm_ops)';
EXCEPTION
    WHEN OTHERS THEN
        RAISE NOTICE 'DeckCatalog: pg_trgm index skipped (% %) - deck name search matches from the start of the name instead of anywhere in it', SQLSTATE, SQLERRM;
END
$$;

-- CatalogService checks at runtime whether "IX_DeckCatalog_NameTrgm" actually
-- exists and shapes its query to match, so a database that took either skip
-- path searches by prefix rather than sequentially scanning the catalog. To
-- upgrade one later, install pg_trgm and add a new migration creating just the
-- GIN index - this file is checksum-guarded and will never re-run.

-- Name search is filtered by set often enough ("my Winds of Exchange decks"),
-- and the crawler reports its per-expansion coverage from the same column.
CREATE INDEX IF NOT EXISTS "IX_DeckCatalog_Expansion"
    ON public."DeckCatalog" USING btree
    ("Expansion" ASC NULLS LAST)
    TABLESPACE pg_default;
