const settings = require('../../../../server/services/settings');
const {
    regionForCountry,
    countriesInRegion,
    isValidCountry
} = require('../../../../server/services/rating/regions');

describe('region overrides (admin settings)', function () {
    let getSection;

    beforeEach(function () {
        // regions.js lazily requires the settings singleton, so spying on
        // the real instance intercepts exactly what production code reads.
        getSection = vi.spyOn(settings, 'getSection').mockReturnValue({ overrides: {} });
    });

    afterEach(function () {
        getSection.mockRestore();
    });

    it('moves a country to another region', function () {
        settings.getSection.mockReturnValue({ overrides: { MX: 'LATAM' } });

        expect(regionForCountry('MX')).toBe('LATAM');
        expect(countriesInRegion('NA')).not.toContain('MX');
        expect(countriesInRegion('LATAM')).toContain('MX');
    });

    it('leaves every other country untouched', function () {
        settings.getSection.mockReturnValue({ overrides: { MX: 'LATAM' } });

        expect(regionForCountry('US')).toBe('NA');
        expect(countriesInRegion('NA')).toContain('US');
    });

    it('ignores overrides pointing at unknown regions', function () {
        settings.getSection.mockReturnValue({ overrides: { US: 'NOPE' } });

        expect(regionForCountry('US')).toBe('NA');
        expect(countriesInRegion('NA')).toContain('US');
    });

    it('cannot invent countries', function () {
        settings.getSection.mockReturnValue({ overrides: { XX: 'EU' } });

        expect(isValidCountry('XX')).toBe(false);
        expect(regionForCountry('XX')).toBeNull();
        expect(countriesInRegion('EU')).not.toContain('XX');
    });

    it('falls back to defaults when the settings service is unavailable', function () {
        settings.getSection.mockImplementation(() => {
            throw new Error('not started');
        });

        expect(regionForCountry('US')).toBe('NA');
        expect(countriesInRegion('NA')).toContain('US');
    });
});
