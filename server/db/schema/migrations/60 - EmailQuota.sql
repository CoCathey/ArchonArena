-- How much mail has been sent in the current day and month.
--
-- Every email provider's entry plan is a hard cap with a cliff at the end of
-- it - Resend's free plan is 100 a day and 3,000 a month. Past the cap the
-- provider stops accepting mail, and it stops accepting ALL of it: the failure
-- is not "some pairing emails were late", it is that the next person to
-- register gets no activation link, and because registration rolls an account
-- back when that mail fails, no account either. One busy Saturday of
-- tournaments locks the site's front door.
--
-- So sends are counted and classed. Notification mail (pairings, scheduling,
-- deadlines) stops at a reserve and leaves the last slice of the day for the
-- mail somebody is actually waiting on. The arithmetic lives in
-- server/services/MailBudget.js.
--
-- WHY A TABLE RATHER THAN A COUNTER IN MEMORY
--
-- The cap belongs to the provider's calendar, not to this process. A restart
-- must not hand the day's quota back, and two node processes must not each
-- believe they have a hundred sends to spend.
--
-- Two rows at a time, replaced as the keys roll over: 'day' with a
-- 'YYYY-MM-DD' key and 'month' with a 'YYYY-MM'. Both UTC, because that is how
-- the provider counts. Old rows are harmless history - a few hundred a year -
-- and they answer "how much did we send last month" without another table.

CREATE TABLE IF NOT EXISTS public."EmailQuota"
(
    "Period" text COLLATE pg_catalog."default" NOT NULL,
    "PeriodKey" text COLLATE pg_catalog."default" NOT NULL,
    "Sent" integer NOT NULL DEFAULT 0,
    CONSTRAINT "PK_EmailQuota" PRIMARY KEY ("Period", "PeriodKey")
);
