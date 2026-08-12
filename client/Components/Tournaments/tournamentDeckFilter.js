/**
 * ARCHON: what a tournament's deck picker is allowed to offer.
 *
 * The event's legality rules are already on the page as badges - SAS band,
 * legal sets, required and banned houses - and the server enforces every one
 * of them when a deck is registered (TournamentService.validateDeck). The
 * picker knew none of it: it listed the player's whole collection, unmarked,
 * and the first thing that told them a rule existed was the red toast after
 * they had already chosen. At a check-in desk that is a player guessing deck
 * by deck with a queue behind them.
 *
 * The lobby already does exactly this for SAS-bound games - PendingGame builds
 * the same shape. This is the same idea for an event.
 *
 * Not everything can be filtered: house requirements need the deck's houses,
 * which the deck list does not carry, so those are stated in the modal instead
 * of silently ignored. Filtering some rules and staying quiet about the rest
 * would be worse than filtering none, because the player would reasonably read
 * "it is in the list" as "it is legal".
 *
 * A pure function of the tournament payload, so it can be tested as one.
 */

/**
 * @param {object} tournament the event as getDetail returns it
 * @param {Array<{value: string}>} allExpansions every set the picker knows
 * @returns {{deckFilter: object, notes: string[]}}
 */
export const buildTournamentDeckFilter = (tournament = {}, allExpansions = []) => {
    const deckFilter = {};
    const notes = [];

    // Alliance events want alliance decks and nothing else; every other format
    // wants the opposite. This mirrors the lobby's rule for the same reason.
    if (tournament.gameFormat === 'alliance') {
        deckFilter.isAlliance = true;
        notes.push('Only Alliance decks may be registered for this event.');
    } else {
        deckFilter.isAlliance = false;
    }

    const legalSets = Array.isArray(tournament.allowedSets) ? tournament.allowedSets : [];

    if (legalSets.length > 0) {
        const wanted = new Set(legalSets.map((id) => String(id)));
        const matching = allExpansions.filter((expansion) => wanted.has(String(expansion.value)));

        // A restriction the picker cannot express is stated rather than
        // silently dropped - listing everything would read as "all legal".
        if (matching.length > 0) {
            deckFilter.expansion = matching;
            notes.push(
                `Only decks from ${matching
                    .map((expansion) => expansion.label)
                    .join(', ')} may be registered.`
            );
        } else {
            notes.push('This event restricts which sets may be registered.');
        }
    }

    if (tournament.sasMin != null) {
        deckFilter.sasMin = tournament.sasMin;
    }

    if (tournament.sasMax != null) {
        deckFilter.sasMax = tournament.sasMax;
    }

    if (tournament.sasMin != null || tournament.sasMax != null) {
        notes.push(
            `Decks must rate between ${tournament.sasMin ?? 0} and ${
                tournament.sasMax ?? 'any'
            } SAS. A deck with no SAS rating yet cannot be registered.`
        );
    }

    // Houses are not filterable here - the deck list does not carry them - so
    // they are said out loud instead.
    if (tournament.requiredHouses?.length > 0) {
        notes.push(`Decks must contain ${tournament.requiredHouses.join(', ')}.`);
    }

    if (tournament.bannedHouses?.length > 0) {
        notes.push(`Decks may not contain ${tournament.bannedHouses.join(', ')}.`);
    }

    return { deckFilter, notes };
};

export default buildTournamentDeckFilter;
