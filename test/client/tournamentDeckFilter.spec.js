import { buildTournamentDeckFilter } from '../../client/Components/Tournaments/tournamentDeckFilter';

/**
 * ARCHON: the tournament deck picker offers what the event will accept.
 *
 * Every one of these rules is already enforced on the server when a deck is
 * registered, and every one of them was already on the page as a badge. The
 * picker knew none of it: it listed the player's whole collection and the
 * first thing that told them a rule existed was the red toast after they had
 * chosen. At a check-in desk that is a player guessing deck by deck with a
 * queue behind them.
 *
 * What matters here is the split: which rules become a FILTER, and which ones
 * cannot be filtered and therefore have to be said out loud. Filtering some
 * and staying quiet about the rest would be worse than filtering none, because
 * then "it is in the list" reads as "it is legal".
 */
describe('buildTournamentDeckFilter', function () {
    const expansions = [
        { value: '341', label: 'CotA' },
        { value: '435', label: 'AoA' },
        { value: '452', label: 'WC' }
    ];

    const build = (tournament) => buildTournamentDeckFilter(tournament, expansions);

    it('offers only the sets the event allows', function () {
        const { deckFilter, notes } = build({ allowedSets: [341, 452] });

        expect(deckFilter.expansion.map((entry) => entry.label)).toEqual(['CotA', 'WC']);
        expect(notes.some((note) => /CotA, WC/.test(note))).toBe(true);
    });

    it('leaves every set on offer when the event restricts none', function () {
        const { deckFilter } = build({});

        expect(deckFilter.expansion).toBeUndefined();
    });

    it('carries the SAS band through, and warns about unrated decks', function () {
        const { deckFilter, notes } = build({ sasMin: 50, sasMax: 75 });

        expect(deckFilter.sasMin).toBe(50);
        expect(deckFilter.sasMax).toBe(75);
        expect(notes.some((note) => /no SAS rating/.test(note))).toBe(true);
    });

    it('offers alliance decks only in an alliance event, and never elsewhere', function () {
        expect(build({ gameFormat: 'alliance' }).deckFilter.isAlliance).toBe(true);
        expect(build({ gameFormat: 'archon' }).deckFilter.isAlliance).toBe(false);
    });

    /**
     * Houses are the rules the list cannot filter on - it does not carry a
     * deck's houses - so they must appear as text or the player would read the
     * unfiltered list as "all of these are legal".
     */
    it('states the house rules it cannot filter on', function () {
        const { deckFilter, notes } = build({
            requiredHouses: ['logos'],
            bannedHouses: ['brobnar', 'dis']
        });

        expect(deckFilter.requiredHouses).toBeUndefined();
        expect(notes.some((note) => /must contain logos/.test(note))).toBe(true);
        expect(notes.some((note) => /may not contain brobnar, dis/.test(note))).toBe(true);
    });

    // A set the picker has never heard of must not silently become "no
    // restriction" - that would show the whole collection as legal.
    it('says so rather than offering everything when it cannot express the restriction', function () {
        const { deckFilter, notes } = build({ allowedSets: [99999] });

        expect(deckFilter.expansion).toBeUndefined();
        expect(notes.some((note) => /restricts which sets/.test(note))).toBe(true);
    });

    it('says nothing about an event with no deck rules at all', function () {
        expect(build({}).notes).toEqual([]);
        expect(buildTournamentDeckFilter().notes).toEqual([]);
    });
});
