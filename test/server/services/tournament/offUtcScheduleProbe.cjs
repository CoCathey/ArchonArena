/**
 * ARCHON: propose-then-accept a match time, in a process whose clock is not
 * UTC. Driven by tournamentEndToEnd.spec.js.
 *
 * This is a separate process rather than a block inside the spec because
 * vitest runs with `pool: 'threads'`, and assigning process.env.TZ inside a
 * worker thread does not move V8's timezone - so the in-process version of
 * this check passes against the very bug it is meant to catch. TZ has to be
 * set before the runtime starts, which means spawning something.
 *
 * Writes one line of JSON to stdout.
 */
const { Pool, types } = require('pg');

const TournamentService = require('../../../../server/services/tournament/TournamentService');

// The same UTC parsing server/db/index.js installs. Without it this probe
// would not reproduce the production read path at all.
types.setTypeParser(1114, (value) =>
    value === null ? null : new Date(`${value.replace(' ', 'T')}Z`)
);

const main = async () => {
    const pool = new Pool({ connectionString: process.env.PROBE_PG_URI });
    const db = {
        query: async (text, params = []) => (await pool.query(text, params)).rows
    };

    const service = new TournamentService(db);
    const tournamentId = parseInt(process.env.PROBE_TOURNAMENT, 10);
    const matchId = parseInt(process.env.PROBE_MATCH, 10);

    const proposed = await service.proposeMatchTime(
        tournamentId,
        matchId,
        { id: parseInt(process.env.PROBE_PROPOSER, 10) },
        process.env.PROBE_TIME,
        null
    );

    const accepted = await service.acceptMatchTime(tournamentId, matchId, {
        id: parseInt(process.env.PROBE_ACCEPTER, 10)
    });

    await pool.end();

    // Reported so the spec can fail loudly if the child somehow ran on UTC
    // after all, rather than passing for the wrong reason.
    process.stdout.write(
        `${JSON.stringify({
            offsetMinutes: new Date().getTimezoneOffset(),
            proposed,
            accepted
        })}\n`
    );
};

main().catch((err) => {
    process.stdout.write(`${JSON.stringify({ error: err.message })}\n`);
    process.exit(1);
});
