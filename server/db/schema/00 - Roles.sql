-- Upstream schema files assign table ownership to the 'keyteki' role.
-- Create it if missing so a fresh database initializes cleanly regardless
-- of which superuser runs the init scripts (e.g. 'archonarena' in
-- production docker-compose).
DO $$
BEGIN
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'keyteki') THEN
        CREATE ROLE keyteki;
    END IF;
END
$$;
