const {
    REGIONS,
    REGION_NAMES,
    isValidCountry,
    regionForCountry,
    countriesInRegion
} = require('../../../../server/services/rating/regions');

describe('regions', function () {
    it('maps well known countries to their regions', function () {
        expect(regionForCountry('US')).toBe('NA');
        expect(regionForCountry('CA')).toBe('NA');
        expect(regionForCountry('BR')).toBe('LATAM');
        expect(regionForCountry('DE')).toBe('EU');
        expect(regionForCountry('GB')).toBe('EU');
        expect(regionForCountry('ZA')).toBe('MEA');
        expect(regionForCountry('JP')).toBe('APAC');
        expect(regionForCountry('AU')).toBe('APAC');
    });

    it('rejects unknown codes', function () {
        expect(regionForCountry('XX')).toBeNull();
        expect(isValidCountry('XX')).toBe(false);
        expect(isValidCountry('')).toBe(false);
        expect(isValidCountry(null)).toBe(false);
    });

    it('assigns every country to exactly one region', function () {
        const seen = {};
        for (const countries of Object.values(REGIONS)) {
            for (const country of countries) {
                expect(seen[country]).toBeUndefined();
                seen[country] = true;
            }
        }
    });

    it('round-trips countriesInRegion with regionForCountry', function () {
        for (const region of REGION_NAMES) {
            for (const country of countriesInRegion(region)) {
                expect(regionForCountry(country)).toBe(region);
            }
        }
    });
});
