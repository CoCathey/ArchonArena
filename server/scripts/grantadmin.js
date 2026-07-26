/*eslint no-console: 0*/

// ARCHON: promote an existing account to Admin.
//
// Production databases deliberately ship with no seeded accounts (the demo
// admin/test0/test1 logins live in server/db/dev-seed/ and are mounted only by
// the local docker-compose.yml). This is how a real deployment bootstraps its
// first administrator: register normally through the site, then run
//
//     npm run grant-admin -- <username>
//
// or, inside the production stack:
//
//     docker compose -f docker-compose.prod.yml --env-file .env.production \
//         exec lobby npm run grant-admin -- <username>
//
// Idempotent: re-running on an account that is already an admin is a no-op.

const db = require('../db');

const ADMIN_ROLE = 'Admin';

async function main() {
    const username = process.argv[2];

    if (!username) {
        console.error('Usage: npm run grant-admin -- <username>');
        process.exitCode = 1;

        return;
    }

    const users = await db.query(
        'SELECT "Id", "Username", "Disabled" FROM "Users" WHERE lower("Username") = lower($1)',
        [username]
    );
    const user = users && users[0];

    if (!user) {
        console.error(
            `No account named '${username}'. Register it through the site first, then re-run.`
        );
        process.exitCode = 1;

        return;
    }

    if (user.Disabled) {
        console.error(
            `Account '${user.Username}' is disabled; re-enable it before granting admin.`
        );
        process.exitCode = 1;

        return;
    }

    const roles = await db.query('SELECT "Id" FROM "Roles" WHERE "Name" = $1', [ADMIN_ROLE]);
    const role = roles && roles[0];

    if (!role) {
        console.error(
            `The '${ADMIN_ROLE}' role is missing from the Roles table - the schema was not fully applied.`
        );
        process.exitCode = 1;

        return;
    }

    // ON CONFLICT DO NOTHING against the (UserId, RoleId) primary key makes
    // re-running harmless.
    const inserted = await db.query(
        'INSERT INTO "UserRoles" ("UserId", "RoleId") VALUES ($1, $2) ' +
            'ON CONFLICT ("UserId", "RoleId") DO NOTHING RETURNING "UserId"',
        [user.Id, role.Id]
    );

    if (inserted && inserted.length > 0) {
        console.log(`Granted ${ADMIN_ROLE} to '${user.Username}'.`);
    } else {
        console.log(`'${user.Username}' already has ${ADMIN_ROLE}; nothing to do.`);
    }

    console.log('They must sign out and back in for the new permissions to take effect.');
}

main()
    .then(() => process.exit(process.exitCode || 0))
    .catch((err) => {
        console.error('Failed to grant admin:', err.message);
        process.exit(1);
    });
