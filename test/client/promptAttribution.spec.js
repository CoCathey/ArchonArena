import { getLocalizedSourceName } from '../../client/Components/GameBoard/promptAttribution.js';

describe('getLocalizedSourceName', function () {
    it('returns null when there is no source', function () {
        expect(getLocalizedSourceName(null, 'en')).toBeNull();
        expect(getLocalizedSourceName(undefined, 'fr')).toBeNull();
    });

    it('returns the plain name in English', function () {
        const source = { name: 'Krump', locale: { fr: { name: 'Krump (FR)' } } };
        expect(getLocalizedSourceName(source, 'en')).toBe('Krump');
    });

    it('returns the plain name when no language is given', function () {
        const source = { name: 'Krump', locale: { fr: { name: 'Krump (FR)' } } };
        expect(getLocalizedSourceName(source)).toBe('Krump');
    });

    it('returns the localized name when the source has one for the active language', function () {
        const source = { name: 'Krump', locale: { fr: { name: 'Krump (FR)' } } };
        expect(getLocalizedSourceName(source, 'fr')).toBe('Krump (FR)');
    });

    it('falls back to the plain name when the source has no locale entry for the language', function () {
        const source = { name: 'Krump', locale: { fr: { name: 'Krump (FR)' } } };
        expect(getLocalizedSourceName(source, 'de')).toBe('Krump');
    });

    it('falls back to the plain name when the source has no locale data at all', function () {
        const source = { name: 'Krump' };
        expect(getLocalizedSourceName(source, 'fr')).toBe('Krump');
    });
});
