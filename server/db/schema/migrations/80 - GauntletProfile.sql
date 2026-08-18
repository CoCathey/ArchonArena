-- ARCHON (N30): what a pool deck is trying to do, read from its own cards.
--
-- The Gauntlet's strategy filters ("play me decks that fight for the board")
-- were computed entirely from Decks of KeyForge's AERC breakdown, which made the
-- most configurable part of the feature depend on somebody else's API and
-- somebody else's key. With no key there is no enrichment, so there was no
-- strategy filter: the pool answered every strategy with "no opponents" while
-- looking perfectly healthy.
--
-- The card list is already in this table. This column holds the estimate
-- computed from it (server/services/championschallenge/deckProfile.js) - printed
-- amber, creature power and armour, plus clause-level keyword counts - on its
-- own scale, under its own names, deliberately NOT called AERC or SAS. The
-- filters prefer DoK's numbers for any deck that has them; this is what makes
-- them work for every deck that does not.
--
-- Nullable: it is computed at hydration and backfilled a batch per sweep from
-- cards already stored, so it costs no outbound request at all.
ALTER TABLE public."GauntletDecks"
    ADD COLUMN IF NOT EXISTS "Profile" jsonb;
