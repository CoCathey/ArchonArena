const { Pool, types } = require('pg');

const ConfigService = require('../services/ConfigService');
const logger = require('../log');

/**
 * ARCHON: read `timestamp without time zone` as UTC, not as server-local time.
 *
 * Every timestamp column in this schema is written as UTC wall-clock - the
 * writes all say `now() AT TIME ZONE 'utc'` - but the type carries no zone, so
 * node-postgres parses it with the SERVER's offset. On a host set to anything
 * but UTC that produces a Date pointing at the wrong instant, which then goes
 * out over the API as an ISO string that is wrong by exactly that offset.
 *
 * It has been invisible because the deployment runs UTC, where local parsing
 * and UTC parsing are the same thing - so this changes nothing there and
 * corrects everything on any host that is not UTC. It surfaced building
 * asynchronous tournaments, where the whole feature is two players in
 * different timezones agreeing on one instant, but the bug was never specific
 * to that: it applied to round timers, game clocks and moderation expiries
 * just as much.
 *
 * 1114 is TIMESTAMP (no zone). TIMESTAMPTZ (1184) is deliberately left alone -
 * it carries an offset and the driver already reads it correctly.
 */
const TIMESTAMP_WITHOUT_TIME_ZONE_OID = 1114;

types.setTypeParser(TIMESTAMP_WITHOUT_TIME_ZONE_OID, (value) =>
    value === null ? null : new Date(`${value.replace(' ', 'T')}Z`)
);

const configService = new ConfigService();

const pool = new Pool({
    user: configService.getValue('dbUser'),
    host: configService.getValue('dbHost'),
    database: configService.getValue('dbDatabase'),
    password: configService.getValue('dbPassword'),
    port: configService.getValue('dbPort')
});

module.exports = {
    /**
     * @param {string} text
     * @param {any[]} params
     */
    query: async (text, params = []) => {
        logger.debug(text, params);
        let res = await pool.query(text, params);

        return res.rows;
    },
    queryTran: async (client, text, params = []) => {
        logger.debug(text, params);
        let res = await client.query(text, params);

        return res.rows;
    },
    startTransaction: async () => {
        let client = await pool.connect();
        await client.query('BEGIN');

        return client;
    },
    shutdown: async () => {
        await pool.end();
    }
};
