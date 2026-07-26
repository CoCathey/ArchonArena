-- LOCAL DEVELOPMENT ONLY - NEVER MOUNT THIS INTO A PRODUCTION DATABASE.
--
-- The three convenience accounts every local stack expects (see AGENTS.md and
-- docs/local-development.md): admin, test0, test1 - all with the password
-- 'password'. `admin` carries the Admin role, which implies every management
-- permission on the site.
--
-- These used to sit in `server/db/schema/99 - Data.sql`. That whole directory is
-- mounted into the production database's docker-entrypoint-initdb.d
-- (docker-compose.prod.yml), so a production deploy created a live admin account
-- with a guessable password. They were moved here so that only
-- docker-compose.yml (local dev) mounts them; production never sees this file.
--
-- To make someone an admin on a real deployment, register the account through
-- the site and then run:  npm run grant-admin -- <username>

INSERT INTO public."Users" ("Id", "Password", "Registered", "Username", "Email", "Settings_Background", "Settings_CardSize",
    "Settings_OrderAbilities", "Settings_ConfirmOneClick", "Settings_UseHalfSizedCards", "Verified", "Disabled", "RegisterIp") VALUES
    (1, '$2b$10$T7eqHoi26C3ADmTDbGOYseTbsrPdCoNFkMKmgh21T4Y6i9NVylgxG', NOW(), 'admin', 'admin@example.com', 'Brobnar', 'normal', False, True, False, True,
     False, '127.0.0.1');

INSERT INTO public."Users" ("Id", "Password", "Registered", "Username", "Email", "Settings_Background", "Settings_CardSize",
    "Settings_OrderAbilities", "Settings_ConfirmOneClick", "Settings_UseHalfSizedCards", "Verified", "Disabled", "RegisterIp") VALUES
    (2, '$2b$10$T7eqHoi26C3ADmTDbGOYseTbsrPdCoNFkMKmgh21T4Y6i9NVylgxG', NOW(), 'test0', 'test0@example.com', 'none', 'normal', True, True, False, True,
     False, '127.0.0.1');
INSERT INTO public."Users" ("Id", "Password", "Registered", "Username", "Email", "Settings_Background", "Settings_CardSize",
    "Settings_OrderAbilities", "Settings_ConfirmOneClick", "Settings_UseHalfSizedCards", "Verified", "Disabled", "RegisterIp") VALUES
    (3, '$2b$10$T7eqHoi26C3ADmTDbGOYseTbsrPdCoNFkMKmgh21T4Y6i9NVylgxG', NOW(), 'test1', 'test1@example.com', 'Dis', 'normal', True, True, False, True,
     False, '127.0.0.1');

INSERT INTO public."UserRoles" ("UserId", "RoleId") VALUES (1, 1);
INSERT INTO public."UserRoles" ("UserId", "RoleId") VALUES (1, 6);
INSERT INTO public."UserRoles" ("UserId", "RoleId") VALUES (1, 10);
