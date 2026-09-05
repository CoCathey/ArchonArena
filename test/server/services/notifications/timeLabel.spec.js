const {
    cleanZone,
    zoneIsUsable,
    asDate,
    formatWhen,
    formatWindow
} = require('../../../../server/services/notifications/timeLabel');

/**
 * ARCHON: saying a UTC instant back to a person in their own zone.
 *
 * Every emailed time used to read "2026-08-20 19:00 UTC", a sum left to the
 * reader - and the reader most likely to get it wrong is the one several zones
 * from their opponent. These pin the two outputs: a recognisable local label
 * when the zone is known, and the honest UTC label when it is not.
 */
describe('timeLabel', function () {
    // 19:00 UTC on a Thursday in August: 2:00 PM in Chicago (CDT), 9:00 PM in
    // Berlin (CEST), the same evening in both.
    const instant = '2026-08-20T19:00:00.000Z';

    describe('cleanZone', function () {
        it('accepts IANA names and UTC', function () {
            expect(cleanZone('America/Chicago')).toBe('America/Chicago');
            expect(cleanZone('America/Argentina/Buenos_Aires')).toBe(
                'America/Argentina/Buenos_Aires'
            );
            expect(cleanZone('Etc/GMT+5')).toBe('Etc/GMT+5');
            expect(cleanZone('UTC')).toBe('UTC');
        });

        it('refuses anything that is not a zone name', function () {
            expect(cleanZone('')).toBeNull();
            expect(cleanZone(undefined)).toBeNull();
            expect(cleanZone('8pm my time')).toBeNull();
            expect(cleanZone('<script>')).toBeNull();
            expect(cleanZone('Chicago')).toBeNull();
        });
    });

    describe('zoneIsUsable', function () {
        it('knows a real zone from a well-formed fake one', function () {
            expect(zoneIsUsable('America/Chicago')).toBe(true);
            expect(zoneIsUsable('Nowhere/Land')).toBe(false);
            expect(zoneIsUsable(null)).toBe(false);
        });
    });

    describe('asDate', function () {
        it('reads a naive database string as UTC', function () {
            expect(asDate('2026-08-20 19:00:00').toISOString()).toBe(instant);
            expect(asDate('2026-08-20T19:00').toISOString()).toBe(instant);
        });

        it('passes Dates and ISO strings through', function () {
            expect(asDate(new Date(instant)).toISOString()).toBe(instant);
            expect(asDate(instant).toISOString()).toBe(instant);
        });

        it('returns null for nothing and for nonsense', function () {
            expect(asDate(null)).toBeNull();
            expect(asDate('soonish')).toBeNull();
        });
    });

    describe('formatWhen', function () {
        it('says the local time with its zone when the zone is known', function () {
            expect(formatWhen(instant, 'America/Chicago')).toBe('Thu, Aug 20, 2:00 PM CDT');
        });

        it('falls back to the UTC label when the zone is unknown or unusable', function () {
            expect(formatWhen(instant, null)).toBe('2026-08-20 19:00 UTC');
            expect(formatWhen(instant, 'Nowhere/Land')).toBe('2026-08-20 19:00 UTC');
        });

        it('reads a database timestamp the same way as an ISO string', function () {
            expect(formatWhen('2026-08-20 19:00:00', 'America/Chicago')).toBe(
                'Thu, Aug 20, 2:00 PM CDT'
            );
        });

        it('never throws on a bad value', function () {
            expect(formatWhen('soonish', 'America/Chicago')).toBe('an unknown time');
            expect(formatWhen(null)).toBe('an unknown time');
        });
    });

    describe('formatWindow', function () {
        it('collapses a same-day window to one date and two clocks', function () {
            expect(formatWindow(instant, '2026-08-20T22:00:00.000Z', 'America/Chicago')).toBe(
                'Thu, Aug 20, 2:00 PM - 5:00 PM CDT'
            );
        });

        it('dates both ends when the window crosses midnight in that zone', function () {
            // 19:00Z-03:00Z is one Chicago evening (2pm-10pm) but two Berlin days.
            expect(formatWindow(instant, '2026-08-21T03:00:00.000Z', 'America/Chicago')).toBe(
                'Thu, Aug 20, 2:00 PM - 10:00 PM CDT'
            );
            expect(formatWindow(instant, '2026-08-21T03:00:00.000Z', 'Europe/Berlin')).toBe(
                'Thu, Aug 20, 9:00 PM GMT+2 - Fri, Aug 21, 5:00 AM GMT+2'
            );
        });

        it('falls back to two UTC labels without a zone', function () {
            expect(formatWindow(instant, '2026-08-20T22:00:00.000Z', null)).toBe(
                '2026-08-20 19:00 UTC - 2026-08-20 22:00 UTC'
            );
        });

        it('is just the start when there is no end, or the end is not after it', function () {
            expect(formatWindow(instant, null, 'America/Chicago')).toBe('Thu, Aug 20, 2:00 PM CDT');
            expect(formatWindow(instant, instant, 'America/Chicago')).toBe(
                'Thu, Aug 20, 2:00 PM CDT'
            );
        });
    });
});
