-- Public share links for recorded replays.
--
-- Replays have been authenticated-only since capture landed, which makes them
-- useless for the thing people actually want to do with a game: send it to
-- someone. A share token is minted per replay on request and is the only way
-- an anonymous caller can read one, so sharing stays an explicit act by a
-- player in the game rather than a property of every recording.
--
-- Nullable: a replay with no token has never been shared and stays private.
-- Unique, because the token IS the credential - two replays must never collide
-- on one.

ALTER TABLE public."GameReplays"
    ADD COLUMN IF NOT EXISTS "ShareToken" text,
    ADD COLUMN IF NOT EXISTS "SharedAt" timestamp without time zone,
    ADD COLUMN IF NOT EXISTS "SharedBy" integer;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'FK_GameReplays_SharedBy'
    ) THEN
        ALTER TABLE public."GameReplays"
            ADD CONSTRAINT "FK_GameReplays_SharedBy" FOREIGN KEY ("SharedBy")
                REFERENCES public."Users" ("Id") ON DELETE SET NULL;
    END IF;
END
$$;

CREATE UNIQUE INDEX IF NOT EXISTS "IX_GameReplays_ShareToken"
    ON public."GameReplays" ("ShareToken")
    WHERE "ShareToken" IS NOT NULL;
