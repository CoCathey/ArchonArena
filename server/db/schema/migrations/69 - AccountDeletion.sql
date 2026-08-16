-- ARCHON: mark an account as deleted, distinctly from disabled.
--
-- "Disabled" has been carrying two meanings at once: banned by a moderator, and
-- deleted by its owner. They look identical to every read path, which is right
-- for suppression - a deleted account should vanish from the directory and the
-- leaderboards exactly as a banned one does - and wrong for everything else.
--
-- The bug that proves it: ModerationService.revoke lifts a ban by setting
-- "Disabled" = false unconditionally. Revoking a stale ban against an account
-- that has since been deleted un-disables a wiped, password-less row and puts
-- it back in the directory. Nothing else in the schema could tell the two
-- states apart, so nothing could stop that.
--
-- So: "Disabled" stays the authority on "is suppressed"; "DeletedAt" becomes
-- the authority on "is gone", and is what moderation must never undo.
ALTER TABLE public."Users"
    ADD COLUMN IF NOT EXISTS "DeletedAt" timestamp without time zone;

-- Partial: the column is null for almost every row, and the only questions
-- asked of it are "is this one deleted" and "which accounts were deleted".
CREATE INDEX IF NOT EXISTS "IX_Users_DeletedAt"
    ON public."Users" ("DeletedAt")
    WHERE "DeletedAt" IS NOT NULL;
