const ConfigService = require('../../../server/services/ConfigService');
const logger = require('../../../server/log');

/**
 * ARCHON: "not configured" has to mean absent, not falsy.
 *
 * These warnings used to fire on any falsy value, which is a different question
 * from the one they claim to answer. Plenty of settings are legitimately empty,
 * zero or false - an unset smtpHost on an SES deployment, emailDailyLimit: 0
 * meaning "no cap", requireActivation: false - and every read of one logged a
 * line saying it "was not configured" while the config file said exactly what
 * it should be.
 *
 * The cost is not the noise, it is what the noise does to the real warnings:
 * one that fires when nothing is wrong teaches everyone to skip warnings, and
 * saying when a setting is genuinely missing is this file's entire purpose.
 */
describe('ConfigService', function () {
    let warnings;
    let service;

    beforeEach(function () {
        warnings = [];
        vi.spyOn(logger, 'warn').mockImplementation((message) => warnings.push(message));
        service = new ConfigService();
    });

    afterEach(function () {
        vi.restoreAllMocks();
    });

    // Real keys from config/default.json5, so this cannot pass against a
    // fixture that has drifted from what the app actually reads.
    describe('a setting that is configured but empty, zero or false', function () {
        it('is returned without a warning', function () {
            expect(service.getValueForSection('lobby', 'smtpHost')).toBe('');
            expect(service.getValueForSection('lobby', 'resendApiKey')).toBe('');
            expect(service.getValueForSection('lobby', 'blockDisposableEmail')).toBe(false);
            expect(warnings).toEqual([]);
        });
    });

    describe('a setting that is genuinely missing', function () {
        it('still warns, naming the key', function () {
            expect(service.getValueForSection('lobby', 'noSuchSetting')).toBeUndefined();
            expect(warnings.join(' ')).toMatch(/noSuchSetting/);
        });

        // It used to warn and then throw a TypeError reading a key off
        // undefined, so the warning never reached anyone: the process died on
        // the next line.
        it('returns undefined for a missing section rather than throwing', function () {
            expect(service.getValueForSection('noSuchSection', 'anything')).toBeUndefined();
            expect(warnings.join(' ')).toMatch(/noSuchSection/);
        });
    });

    describe('top-level values', function () {
        it('reads them and warns only when absent', function () {
            expect(service.getValue('lobby')).toBeTruthy();
            expect(warnings).toEqual([]);

            expect(service.getValue('noSuchTopLevelKey')).toBeUndefined();
            expect(warnings.join(' ')).toMatch(/noSuchTopLevelKey/);
        });
    });
});
