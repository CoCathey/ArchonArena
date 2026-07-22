const { validateSection } = require('../../../../server/services/settings/registry');

describe('settings registry: text and stringMap types', function () {
    describe('content section (text)', function () {
        it('accepts markdown strings', function () {
            expect(validateSection('content', { aboutMarkdown: '# Hello' })).toEqual([]);
        });

        it('rejects non-strings', function () {
            expect(validateSection('content', { aboutMarkdown: 42 })).not.toEqual([]);
        });

        it('rejects text beyond maxLength', function () {
            const errors = validateSection('content', { aboutMarkdown: 'x'.repeat(50001) });
            expect(errors.some((error) => error.includes('at most'))).toBe(true);
        });
    });

    describe('regions section (stringMap)', function () {
        it('accepts country codes mapped to known regions', function () {
            expect(validateSection('regions', { overrides: { US: 'EU', JP: 'NA' } })).toEqual([]);
        });

        it('rejects malformed country keys', function () {
            const errors = validateSection('regions', { overrides: { usa: 'EU' } });
            expect(errors.some((error) => error.includes('invalid key'))).toBe(true);
        });

        it('rejects unknown regions', function () {
            const errors = validateSection('regions', { overrides: { US: 'MOON' } });
            expect(errors.some((error) => error.includes('unknown value'))).toBe(true);
        });

        it('rejects non-object values', function () {
            expect(validateSection('regions', { overrides: ['US'] })).not.toEqual([]);
        });
    });
});
