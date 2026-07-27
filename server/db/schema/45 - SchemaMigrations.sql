-- Ledger of which migration files have been applied to this database.
--
-- Before this table existed, production schema state was untracked: migrations
-- were piped in by hand one file at a time (docs/DEPLOYMENT.md) with nothing
-- recording what had run, so drift between environments was undetectable.
--
-- Checksum is a sha256 of the file's contents, which lets the runner refuse to
-- continue if a migration that has already been applied is later edited - the
-- one situation where two databases silently diverge forever.
--
-- See server/scripts/migrate.js and `npm run migrate`.

CREATE TABLE IF NOT EXISTS public."SchemaMigrations"
(
    "Filename" text COLLATE pg_catalog."default" NOT NULL,
    "Checksum" text COLLATE pg_catalog."default" NOT NULL,
    "AppliedAt" timestamp without time zone NOT NULL,
    "AppliedBy" text COLLATE pg_catalog."default",
    CONSTRAINT "PK_SchemaMigrations" PRIMARY KEY ("Filename")
)

TABLESPACE pg_default;
