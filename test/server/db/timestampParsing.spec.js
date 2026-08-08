const { types } = require('pg');

// Requiring the db module installs the parser. It builds a Pool, but
// node-postgres does not connect until a query is issued, so this costs
// nothing and needs no database.
require('../../../server/db');

/**
 * ARCHON: `timestamp without time zone` must be read as UTC.
 *
 * Every timestamp in this schema is written as UTC wall-clock (`now() AT TIME
 * ZONE 'utc'`), but the type carries no zone, so node-postgres would otherwise
 * parse it with the server's offset - producing a Date pointing at the wrong
 * instant, which then leaves the API as an ISO string wrong by that offset.
 *
 * It stayed invisible because production runs UTC, where the two readings are
 * identical. These pin the behaviour so a host that is not UTC - a laptop, a
 * relocated box - cannot quietly shift every deadline, round timer and
 * scheduled match on the site.
 */
describe('database timestamp parsing', function () {
    const TIMESTAMP_OID = 1114;
    const TIMESTAMPTZ_OID = 1184;

    const parse = (value) => types.getTypeParser(TIMESTAMP_OID)(value);

    it('reads a naive timestamp as UTC, not as local time', function () {
        expect(parse('2026-08-20 19:00:00').toISOString()).toBe('2026-08-20T19:00:00.000Z');
    });

    it('keeps sub-second precision', function () {
        expect(parse('2026-08-20 19:00:00.123').toISOString()).toBe('2026-08-20T19:00:00.123Z');
    });

    it('passes null through', function () {
        expect(parse(null)).toBeNull();
    });

    // The round trip that matters: what the client is handed over JSON has to
    // be the instant the column meant.
    it('survives the JSON round trip to the client', function () {
        const wire = JSON.parse(JSON.stringify({ at: parse('2026-08-20 19:00:00') })).at;

        expect(wire).toBe('2026-08-20T19:00:00.000Z');
        expect(new Date(wire).getTime()).toBe(Date.UTC(2026, 7, 20, 19, 0, 0));
    });

    // timestamptz carries its own offset and the driver already reads it
    // correctly; overriding it too would be a second, unnecessary opinion.
    it('leaves timestamptz alone', function () {
        expect(types.getTypeParser(TIMESTAMPTZ_OID)).not.toBe(types.getTypeParser(TIMESTAMP_OID));
    });
});
