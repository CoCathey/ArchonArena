#!/usr/bin/env node
/*eslint no-console: 0*/

/*
 * Put orphaned games back on the decks they were played with.
 *
 * "GamePlayers"."DeckId" is ON DELETE SET NULL, so deleting a deck did not
 * archive its games - it cut them loose. The wins and losses disappeared from
 * the deck page, the matchup tables and Archon Intelligence, and re-importing
 * the deck did not bring them back, because the import writes a new row with a
 * new id while the games still pointed at nothing.
 *
 * That is fixed going forward: migration 71 records the deck's uuid on the
 * game, and importing a deck re-points this user's orphans at the new row. This
 * script is for the games orphaned BEFORE that column existed, which carry no
 * uuid at all.
 *
 * Their one surviving trace is the replay: its header records each player's
 * deck identity (which is the deck name), so a row can be matched back to the
 * deck the player now owns under that name. That means:
 *
 *   - a game with no stored replay cannot be recovered. Replays are a setting
 *     and have a retention policy; if the recording is gone the link is gone.
 *   - a deck that has not been imported again has nothing to link TO. Import it
 *     first, then run this.
 *
 * Both are reported rather than silently skipped, because "recovered 3" reads
 * very differently next to "and 40 could not be".
 *
 * Dry run by default:
 *   npm run relink:decks              show what would be re-linked
 *   npm run relink:decks -- --commit  actually re-link them
 */
const db = require('../db');

const args = process.argv.slice(2);
const commit = args.includes('--commit');

async function main() {
    // Orphans that predate the uuid column. A row WITH a "DeckUuid" is either
    // still linked or will re-link itself on the next import, so it is not this
    // script's problem.
    const orphans = await db.query(
        'SELECT gp."Id", gp."PlayerId", u."Username", g."Id" AS "GameDbId", g."GameId" ' +
            'FROM "GamePlayers" gp ' +
            'JOIN "Games" g ON g."Id" = gp."GameId" ' +
            'JOIN "Users" u ON u."Id" = gp."PlayerId" ' +
            'WHERE gp."DeckId" IS NULL AND gp."DeckUuid" IS NULL ' +
            'ORDER BY g."Id"'
    );

    if (orphans.length === 0) {
        console.log('No orphaned game rows. Nothing to do.');

        return;
    }

    console.log(`${orphans.length} game row(s) with no deck.`);

    const outcome = { relinked: 0, noReplay: 0, noDeckNow: 0, notInReplay: 0 };
    const plan = [];

    for (const row of orphans) {
        const replay = await db.query('SELECT "Data" FROM "GameReplays" WHERE "GameDbId" = $1', [
            row.GameDbId
        ]);

        if (replay.length === 0) {
            outcome.noReplay++;
            continue;
        }

        const data = replay[0].Data;
        const player = (data && data.players ? data.players : []).find(
            (entry) => entry && entry.name === row.Username
        );

        // `deck` is the identity, which is the deck's name; `deckName` is the
        // same string under the label the reader sees. Either will do.
        const identity = player && (player.deck || player.deckName);

        if (!identity) {
            outcome.notInReplay++;
            continue;
        }

        const deck = await db.query(
            'SELECT "Id", "Uuid" FROM "Decks" WHERE "Identity" = $1 AND "UserId" = $2',
            [identity, row.PlayerId]
        );

        if (deck.length === 0) {
            outcome.noDeckNow++;
            plan.push({ ...row, identity, deckId: null });
            continue;
        }

        outcome.relinked++;
        plan.push({ ...row, identity, deckId: deck[0].Id, uuid: deck[0].Uuid });
    }

    for (const entry of plan.filter((p) => p.deckId)) {
        console.log(
            `  ${commit ? 'relink' : 'would relink'} game ${entry.GameId} ` +
                `(${entry.Username}) -> deck ${entry.deckId} "${entry.identity}"`
        );

        if (commit) {
            await db.query(
                'UPDATE "GamePlayers" SET "DeckId" = $1, "DeckUuid" = $2 WHERE "Id" = $3',
                [entry.deckId, entry.uuid, entry.Id]
            );
        }
    }

    const stillOwned = new Set(plan.filter((p) => !p.deckId).map((p) => p.identity));

    console.log('');
    console.log(`${outcome.relinked} ${commit ? 're-linked' : 'recoverable'}`);
    console.log(`${outcome.noReplay} unrecoverable - no replay was stored for that game`);
    console.log(
        `${outcome.notInReplay} unrecoverable - the replay does not name that player's deck`
    );
    console.log(
        `${outcome.noDeckNow} waiting on an import - the replay names a deck this account no longer has`
    );

    if (stillOwned.size > 0) {
        console.log('');
        console.log('Import these again and re-run to recover their games:');
        for (const name of stillOwned) {
            console.log(`  ${name}`);
        }
    }

    if (!commit && outcome.relinked > 0) {
        console.log('');
        console.log('Dry run. Re-run with --commit to apply.');
    }
}

main()
    .then(async () => {
        await db.shutdown();
        process.exit(0);
    })
    .catch(async (err) => {
        console.error(err);
        await db.shutdown();
        process.exit(1);
    });
