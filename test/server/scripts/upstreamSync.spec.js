const { parseExpansions } = require('../../../server/scripts/upstream-sync');

/**
 * The set detector is what stops a new KeyForge set arriving as a silently
 * half-finished sync: the engine side comes across on its own, the registration
 * side cannot, and nothing in the suite would catch the difference because no
 * test covers a set that was never registered.
 *
 * The fixtures below are the two real shapes, copied from `server/constants.js`
 * and `client/constants.js`. They differ in the key (`id` vs `value`), in
 * whether the id is quoted, and in whether an entry is on one line or spread
 * over several - all three of which a naive regex gets wrong.
 */
const SERVER_SHAPE = `
class Constants {}

Constants.Expansions = [
    { id: 341, label: 'CotA', tideRequired: false, tokenRequired: false, prophecySupported: false },
    { id: 435, label: 'AoA', tideRequired: false, tokenRequired: false, prophecySupported: false },
    {
        id: 939,
        label: 'VM2025',
        tideRequired: false,
        tokenRequired: false,
        prophecySupported: false
    },
    { id: 886, label: 'PV', tideRequired: false, tokenRequired: false, prophecySupported: true }
];

module.exports = Constants;
`;

const CLIENT_SHAPE = `
const Constants = {
    Expansions: [
        {
            value: '341',
            label: 'CotA',
            tideRequired: false,
            tokenRequired: false,
            prophecySupported: false
        },
        {
            value: '700',
            label: 'GR',
            tideRequired: false,
            tokenRequired: false,
            prophecySupported: false
        }
    ],
    SetIconPaths: {}
};
`;

describe('upstream sync: set detection', function () {
    describe('parseExpansions', function () {
        it('reads the server shape, one-line and multi-line entries alike', function () {
            const found = parseExpansions(SERVER_SHAPE);

            expect(found.size).toBe(4);
            expect(found.get('341')).toBe('CotA');
            // The multi-line entry is the one a line-based parser would miss.
            expect(found.get('939')).toBe('VM2025');
            expect(found.get('886')).toBe('PV');
        });

        it('reads the client shape, where the id is a quoted string named value', function () {
            const found = parseExpansions(CLIENT_SHAPE);

            expect(found.size).toBe(2);
            expect(found.get('341')).toBe('CotA');
            expect(found.get('700')).toBe('GR');
        });

        // The failure that matters: returning nothing quietly would make every
        // comparison "no new sets", so a set release would sync with no notice
        // at all. Anything that yields an empty map has to be visible as empty.
        it('returns nothing for input it cannot understand, rather than guessing', function () {
            expect(parseExpansions('').size).toBe(0);
            expect(parseExpansions(undefined).size).toBe(0);
            expect(parseExpansions('const x = 1;').size).toBe(0);
        });

        it('ignores objects that are not expansions', function () {
            const found = parseExpansions(`
                Constants.Something = [{ id: 7, name: 'no label here' }];
                Constants.Expansions = [{ id: 341, label: 'CotA' }];
            `);

            expect(found.size).toBe(1);
            expect(found.get('341')).toBe('CotA');
        });

        // Guards the regex against matching 'prophecySupported' style keys or
        // an id embedded in a longer word.
        it('does not treat a substring key as an id', function () {
            const found = parseExpansions(
                "[{ deckid: 999, label: 'Nope' }, { id: 341, label: 'CotA' }]"
            );

            expect(found.has('999')).toBe(false);
            expect(found.get('341')).toBe('CotA');
        });
    });

    describe('what a new set looks like', function () {
        it('shows up as an id present after but not before', function () {
            const before = parseExpansions(SERVER_SHAPE);
            const after = parseExpansions(
                SERVER_SHAPE.replace(
                    '];',
                    "    { id: 964, label: 'VM2026', tideRequired: false }\n];"
                )
            );

            const added = [...after.keys()].filter((id) => !before.has(id));

            expect(added).toEqual(['964']);
            expect(after.get('964')).toBe('VM2026');
        });

        it('is not reported when the list is unchanged', function () {
            const before = parseExpansions(SERVER_SHAPE);
            const after = parseExpansions(SERVER_SHAPE);

            expect([...after.keys()].filter((id) => !before.has(id))).toEqual([]);
        });
    });
});
