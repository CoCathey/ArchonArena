// Requiring the db module builds a Pool, but node-postgres does not connect
// until a query is issued, and the refused calls below never get that far.
const db = require('../../../server/db');

/**
 * ARCHON: transaction control sent to the POOL is always a bug.
 *
 * `db.query` is `pool.query`, which takes a connection per statement. A `BEGIN`
 * sent that way opens a transaction on a connection nobody is holding: the
 * statements it was meant to protect run on other connections and auto-commit
 * one at a time, the `COMMIT` lands somewhere else again, and the connection
 * carrying the open transaction goes back to the pool. Whatever borrows it next
 * inherits the transaction, and once anything errors inside it that connection
 * refuses every further query - a long way from the code responsible.
 *
 * Four services had written transactions this way, including both writes on the
 * game path, so a finished game could fail to record its winner and a game
 * could fail to start. Refusing it here is what stops the fifth.
 */
describe('transaction control on the connection pool', function () {
    /**
     * Whether the guard refused this statement. Deliberately not written as
     * `rejects.toThrow`: the statements that get PAST the guard go on to look
     * for a database, and whether one answers is not what is being tested.
     */
    const wasRefused = async (sql, params) => {
        try {
            await db.query(sql, params);

            return false;
        } catch (err) {
            return /Refusing to send/.test(err.message);
        }
    };

    for (const statement of ['BEGIN', 'begin', '  COMMIT ;', 'ROLLBACK', 'START TRANSACTION']) {
        it(`refuses ${JSON.stringify(statement)}`, async function () {
            expect(await wasRefused(statement)).toBe(true);
        });
    }

    it('says what to use instead, naming the statement it refused', async function () {
        await expect(db.query('BEGIN')).rejects.toThrow('Refusing to send "BEGIN"');
        await expect(db.query('BEGIN')).rejects.toThrow(/startTransaction\(\)\/queryTran/);
    });

    it('leaves ordinary statements alone', async function () {
        expect(await wasRefused('SELECT 1')).toBe(false);
    });

    it('does not mistake a statement that merely mentions one for the real thing', async function () {
        expect(await wasRefused('SELECT "Id" FROM "Games" WHERE "WinReason" = $1', ['end'])).toBe(
            false
        );
    });
});
