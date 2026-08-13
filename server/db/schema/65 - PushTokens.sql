-- Expo push tokens, so the mobile app can be told things while it is closed.
--
-- The notification service already decides what a player hears about and
-- records it for the in-app centre; email is the only way it currently reaches
-- somebody who is not looking at the site. That is the wrong channel for the
-- things tournaments need to say. "Your match starts in fifteen minutes" and
-- "your opponent suggested Thursday 8pm" are worth an interruption and worth
-- nothing an hour later, which is exactly what a push notification is for and
-- exactly what email is not.
--
-- WHY THE TOKEN IS THE KEY
--
-- An Expo push token identifies an install, not a person. Two facts follow,
-- and between them they decide the shape of this table:
--
--   * One account can hold several - a phone and a tablet - and all of them
--     should ring. So this is a list per user, not a column on "Users".
--   * One install can move between accounts. Sign out on a shared phone, sign
--     in as somebody else, and the same token now belongs to the second
--     account. If the row were keyed by (user, token) the first account would
--     keep its row and would go on receiving the second person's pairings.
--
-- So the token is unique on its own, and re-registering it moves it: the
-- upsert below overwrites "UserId". Sign-out deletes the row outright, which
-- is the other half of the same rule.
--
-- "LastSeenAt" is what lets a token be retired. Expo tells us when a token is
-- dead ("DeviceNotRegistered") and the sender deletes those immediately, but
-- an app deleted while the phone was off never produces that receipt. A token
-- the app has not re-registered in months belongs to an install that is gone.

CREATE TABLE IF NOT EXISTS public."PushTokens"
(
    "Id" serial NOT NULL,
    "UserId" integer NOT NULL,
    "Token" text COLLATE pg_catalog."default" NOT NULL,
    -- 'ios' | 'android'. Recorded for diagnostics and so a future
    -- platform-specific payload has something to switch on.
    "Platform" text COLLATE pg_catalog."default",
    -- Free-form build/device label from the client, purely for support:
    -- "which of my phones is this row?"
    "DeviceName" text COLLATE pg_catalog."default",
    "CreatedAt" timestamp without time zone NOT NULL DEFAULT (now() AT TIME ZONE 'utc'),
    "LastSeenAt" timestamp without time zone NOT NULL DEFAULT (now() AT TIME ZONE 'utc'),
    CONSTRAINT "PK_PushTokens" PRIMARY KEY ("Id"),
    CONSTRAINT "UQ_PushTokens_Token" UNIQUE ("Token"),
    CONSTRAINT "FK_PushTokens_Users" FOREIGN KEY ("UserId")
        REFERENCES public."Users" ("Id") MATCH SIMPLE
        ON UPDATE NO ACTION
        ON DELETE CASCADE
);

-- Every send starts "which tokens does this user have", so that lookup gets
-- the index rather than the uniqueness constraint.
CREATE INDEX IF NOT EXISTS "IX_PushTokens_UserId" ON public."PushTokens" ("UserId");

-- The third delivery channel, alongside "InApp" and "Email".
--
-- Nullable rather than defaulted, and this matters: a row already in this
-- table records a choice the player made about in-app and email BEFORE push
-- existed. It says nothing about push. NULL preserves that distinction, and
-- NotificationService reads NULL as "the category's default applies" - so an
-- existing user still gets pairing pushes without having to go and ask for
-- them, and a user who deliberately turned a category off keeps it off,
-- because turning a category off writes false to every channel.
ALTER TABLE public."NotificationPreferences"
    ADD COLUMN IF NOT EXISTS "Push" boolean;
