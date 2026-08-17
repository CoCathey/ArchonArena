import {
    describeDeckStatus,
    NOTE_TONE,
    PROBLEM_TONE,
    VALID_TONE
} from '../../client/Components/Games/deckStatusLabel';

const t = (text) => text;

// The status object the lobby builds for a deck that is fine in every way.
const clean = {
    basicRules: true,
    extendedStatus: [],
    noUnreleasedCards: true,
    officialRole: true,
    usageLevel: 0,
    verified: false,
    impossible: false
};

describe('describeDeckStatus', function () {
    it('calls a clean deck Valid', function () {
        expect(describeDeckStatus(clean, t)).toMatchObject({ label: 'Valid', tone: VALID_TONE });
    });

    it('says Pending before a deck is chosen', function () {
        expect(describeDeckStatus(undefined, t).label).toBe('Pending');
    });

    describe('a deck more than one account owns', function () {
        // THE DEFECT: this said "Invalid". Two people owning one physical deck
        // is ordinary, the deck is legal, the game starts, and it is rated -
        // but the pre-game screen told both players the deck was not allowed,
        // and neither of them could do anything about it.
        it('is not called Invalid', function () {
            for (const usageLevel of [1, 2, 3]) {
                const result = describeDeckStatus({ ...clean, usageLevel }, t);

                expect(result.label).not.toBe('Invalid');
                expect(result.playable).toBe(true);
                expect(result.tone).toBe(NOTE_TONE);
            }
        });

        it('uses the same words as the deck list', function () {
            expect(describeDeckStatus({ ...clean, usageLevel: 1 }, t).label).toBe('Used');
            expect(describeDeckStatus({ ...clean, usageLevel: 2 }, t).label).toBe('Popular');
            expect(describeDeckStatus({ ...clean, usageLevel: 3 }, t).label).toBe('Notorious');
        });

        it('says so in the tooltip, in as many words', function () {
            expect(describeDeckStatus({ ...clean, usageLevel: 1 }, t).hint).toContain(
                'still legal to play'
            );
        });

        it('says nothing at all once the deck is verified', function () {
            expect(describeDeckStatus({ ...clean, usageLevel: 3, verified: true }, t).label).toBe(
                'Valid'
            );
        });
    });

    describe('a deck that genuinely cannot be played', function () {
        // The one case that keeps the word: the engine cannot build a deck
        // whose enhancements have not been assigned.
        it('is still called Invalid when its enhancements are unassigned', function () {
            const result = describeDeckStatus({ ...clean, basicRules: false }, t);

            expect(result.label).toBe('Invalid');
            expect(result.tone).toBe(PROBLEM_TONE);
            expect(result.playable).toBe(false);
        });

        it('names unreleased cards rather than calling them Invalid', function () {
            const result = describeDeckStatus({ ...clean, noUnreleasedCards: false }, t);

            expect(result.label).toBe('Unreleased cards');
            expect(result.playable).toBe(false);
        });
    });

    it('marks a theoretical deck casual rather than illegal', function () {
        const result = describeDeckStatus({ ...clean, impossible: true }, t);

        expect(result.label).toBe('Casual only');
        expect(result.playable).toBe(true);
    });

    it('keeps the unassigned-enhancement case ahead of the ownership one', function () {
        // Both true at once: the broken deck is the more important thing to say.
        expect(describeDeckStatus({ ...clean, basicRules: false, usageLevel: 2 }, t).label).toBe(
            'Invalid'
        );
    });
});
