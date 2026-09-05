import { toLocalInputValue, toServerTime } from '../../client/Components/Tournaments/localTime';

/**
 * ARCHON: an organizer's start time is a wall clock in the browser and an
 * instant on the wire.
 *
 * The create and edit forms sent the datetime-local value as typed, which the
 * server parsed in its own zone (UTC in production) - so a 7pm event in
 * Chicago was stored as 7pm UTC - and the edit form read the stored instant
 * back through toISOString(), showing UTC in a local input. Both directions
 * now go through one place.
 */
describe('tournament local time', function () {
    it('round-trips a wall clock through an instant and back', function () {
        const typed = '2026-08-20T19:00';

        const onTheWire = toServerTime(typed);
        expect(onTheWire).toBe(new Date(typed).toISOString());

        expect(toLocalInputValue(onTheWire)).toBe(typed);
    });

    it('formats an instant in the browser’s clock, not UTC', function () {
        const instant = new Date(2026, 7, 20, 19, 0);

        // Whatever zone the test runs in, the local reading is what comes back.
        expect(toLocalInputValue(instant.toISOString())).toBe('2026-08-20T19:00');
        expect(toLocalInputValue(instant)).toBe('2026-08-20T19:00');
    });

    it('sends nothing for an empty or unreadable field', function () {
        expect(toServerTime('')).toBeUndefined();
        expect(toServerTime(undefined)).toBeUndefined();
        expect(toServerTime('soonish')).toBeUndefined();
    });

    it('shows nothing for an empty or unreadable instant', function () {
        expect(toLocalInputValue(null)).toBe('');
        expect(toLocalInputValue('soonish')).toBe('');
    });
});
