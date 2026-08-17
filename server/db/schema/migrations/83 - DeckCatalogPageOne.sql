-- The Master Vault crawl was asking for page 0.
--
-- Master Vault's deck list is Django-paginated, and Django numbers pages from
-- 1: `?page=0` is "Invalid page.", answered with HTTP 404 - the same status a
-- wrong path gets. The crawler read that 404 as "this address is not the deck
-- list", tried its other candidate spellings, got the same 404 from each, and
-- recorded failure after failure against an endpoint that was healthy the
-- whole time. The cursor never left page 0, and the circuit breaker kept the
-- crawl parked for an hour at a stretch.
--
-- The crawler now counts from 1 and clamps a stored 0 up to 1 on read, so the
-- cursor bump below is belt and braces. What IS load-bearing is clearing the
-- breaker: a deployment that hit this bug is sitting on a stale "PausedUntil"
-- of up to an hour and a wall of recorded failures, and without clearing them
-- the fixed crawler would spend that hour reporting "paused" over failures a
-- page number caused.
--
-- Guarded by "CurrentPage" = 0, which can only mean a cursor from before this
-- fix: a crawl that has ever fetched a page holds a cursor of 1 or more.
UPDATE public."DeckCatalogState"
SET "CurrentPage" = 1,
    "ConsecutiveFailures" = 0,
    "PausedUntil" = NULL,
    "LastError" = NULL
WHERE "Id" = 1 AND "CurrentPage" = 0;

-- New cursors start at the first page that exists.
ALTER TABLE public."DeckCatalogState" ALTER COLUMN "CurrentPage" SET DEFAULT 1;
