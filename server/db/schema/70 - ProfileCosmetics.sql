-- ARCHON (N12): profile cosmetics - what the profile_cosmetics and
-- enhanced_cosmetics capabilities actually buy.
--
-- Both were sold and neither existed: Supporter promised "customise how your
-- profile looks" while the only customisation on the site was the game board
-- background, which is free, and every one of Vault Master's capabilities was
-- unbuilt. This table is where a member's choices live.
--
-- WHY A TABLE RATHER THAN COLUMNS ON "Users"
--
-- Same reasoning as "Memberships". These are five optional fields that only a
-- paying member ever sets, read on their own paths (a profile view, a batch of
-- badges) and joined in rather than dragged along by every SELECT * the user
-- loader does. It also means a deployment that has not run this migration
-- degrades to "nobody has cosmetics" - every reader LEFT JOINs and tolerates
-- the table being absent - instead of erroring on a missing column.
--
-- WHAT IS STORED IS AN IDENTIFIER, NOT A STYLE
--
-- Every value here is a member of a closed set defined in
-- server/services/membership/cosmetics.js: a palette id, a banner id, a frame
-- id, a title id, an effect id. The client maps an id to pixels; nothing
-- stored here is ever rendered as CSS. The single exception is a custom accent
-- colour ('#rrggbb', Vault Master), which is validated and lightened to stay
-- readable before it is written.
--
-- Deliberately no foreign keys or enums against the option lists: the
-- catalogue is code, so an option can be renamed, added or retired without a
-- migration, and a value this build no longer recognises resolves to the slot
-- default rather than erroring.
--
-- WHY LAPSING DOES NOT DELETE ANYTHING
--
-- Rows survive a membership ending. resolveCosmetics() filters a stored
-- selection against what the account may use *now*, so a lapsed pledge stops
-- rendering on the same day the badge does, and resubscribing restores exactly
-- what they had. Deleting on lapse would punish somebody for pausing.

CREATE TABLE IF NOT EXISTS public."ProfileCosmetics"
(
    "UserId" integer NOT NULL,

    -- Palette id ('sanctum') or a custom '#rrggbb' (enhanced_cosmetics only).
    "Accent" text COLLATE pg_catalog."default",
    -- Banner art id, matching an existing background image.
    "Banner" text COLLATE pg_catalog."default",
    -- Avatar ring id.
    "Frame" text COLLATE pg_catalog."default",
    -- Curated flair title id. Curated rather than free text so that a title
    -- needs no moderation and is live the moment it is chosen.
    "Title" text COLLATE pg_catalog."default",
    -- How the name is drawn in lists ('glow' | 'gradient' | 'shimmer').
    "NameEffect" text COLLATE pg_catalog."default",

    "CreatedAt" timestamp without time zone NOT NULL DEFAULT (now() AT TIME ZONE 'utc'),
    "UpdatedAt" timestamp without time zone NOT NULL DEFAULT (now() AT TIME ZONE 'utc'),

    CONSTRAINT "PK_ProfileCosmetics" PRIMARY KEY ("UserId"),
    CONSTRAINT "FK_ProfileCosmetics_Users_UserId" FOREIGN KEY ("UserId")
        REFERENCES public."Users" ("Id") MATCH SIMPLE
        ON UPDATE NO ACTION
        ON DELETE CASCADE
)

TABLESPACE pg_default;
