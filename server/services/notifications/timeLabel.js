/**
 * ARCHON: saying an instant back to a person, in their own time zone.
 *
 * Every timestamp on the platform is UTC, which is right for storing and wrong
 * for reading: "Round 2: alice suggests 2026-08-20 19:00 UTC" is a sum the
 * reader has to do, and the reader most likely to get it wrong is the one three
 * zones away - who is exactly who asynchronous events exist for. The browser
 * knows its zone and the account now remembers it (Settings_TimeZone), so
 * notifications can format for the recipient. When the zone is unknown, the
 * label says UTC rather than guessing.
 *
 * Kept away from the tournament and notification services so both format the
 * same way, and so the format can be tested on its own with fixed zones.
 */

/**
 * A zone name as the browser reports it ('America/Chicago', 'UTC'), or null.
 *
 * The shape check keeps free text out of the column; whether the name is one
 * the runtime actually knows is checked where it is used (see zoneIsUsable),
 * because the list of valid zones is the runtime's, not ours.
 */
function cleanZone(zone) {
    const text = String(zone || '').trim();

    return /^[A-Za-z_+-]+\/[A-Za-z0-9_+-]+(\/[A-Za-z0-9_+-]+)?$|^UTC$/.test(text)
        ? text.slice(0, 64)
        : null;
}

/** Whether Intl can format in this zone. */
function zoneIsUsable(zone) {
    if (!zone) {
        return false;
    }

    try {
        new Intl.DateTimeFormat('en-US', { timeZone: zone });

        return true;
    } catch {
        return false;
    }
}

/**
 * Timestamps come back from Postgres as Dates (the db module parses them as
 * UTC), from the API as ISO strings, and from older rows as naive strings.
 * A naive string is UTC here, as everywhere in this schema.
 */
function asDate(value) {
    if (value instanceof Date) {
        return Number.isNaN(value.getTime()) ? null : value;
    }

    if (!value) {
        return null;
    }

    const text = String(value);
    const time = new Date(
        /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(text) ? `${text}Z` : text
    );

    return Number.isNaN(time.getTime()) ? null : time;
}

/** "2026-08-20 19:00 UTC" - the label used when the reader's zone is unknown. */
function utcLabel(date) {
    return `${date.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

const dateOptions = { weekday: 'short', month: 'short', day: 'numeric' };
const timeOptions = { hour: 'numeric', minute: '2-digit' };

/**
 * Newer ICU builds put a narrow no-break space before "PM". Plain spaces read
 * the same in a mail client and compare the same in a test.
 */
const plainSpaces = (text) => text.replace(/[\u202f\u00a0]/g, ' ');

const format = (options, date) =>
    plainSpaces(new Intl.DateTimeFormat('en-US', options).format(date));

/**
 * One instant, for one reader.
 *
 * "Thu, Aug 20, 2:00 PM CDT" in a known zone; "2026-08-20 19:00 UTC" otherwise.
 * The zone abbreviation is always included: an email is read later, somewhere
 * else, and "2:00 PM" on its own is the sentence that books the wrong hour.
 *
 * @param {Date|string} value
 * @param {string} [zone] IANA zone name
 */
function formatWhen(value, zone) {
    const date = asDate(value);

    if (!date) {
        return 'an unknown time';
    }

    if (!zoneIsUsable(zone)) {
        return utcLabel(date);
    }

    return format({ timeZone: zone, ...dateOptions, ...timeOptions, timeZoneName: 'short' }, date);
}

/**
 * A window of time, for one reader.
 *
 * "Thu, Aug 20, 2:00 PM - 5:00 PM CDT" when both ends fall on the same day in
 * that zone; each end dated in full when they do not. Falls back to the UTC
 * form of both ends when the zone is unknown. A window with no end is just its
 * start.
 *
 * @param {Date|string} start
 * @param {Date|string} [end]
 * @param {string} [zone]
 */
function formatWindow(start, end, zone) {
    const from = asDate(start);
    const to = asDate(end);

    if (!from) {
        return 'an unknown time';
    }

    if (!to || to.getTime() <= from.getTime()) {
        return formatWhen(from, zone);
    }

    if (!zoneIsUsable(zone)) {
        return `${utcLabel(from)} - ${utcLabel(to)}`;
    }

    const dayOptions = { timeZone: zone, ...dateOptions };

    if (format(dayOptions, from) !== format(dayOptions, to)) {
        return `${formatWhen(from, zone)} - ${formatWhen(to, zone)}`;
    }

    const day = format(dayOptions, from);
    const opens = format({ timeZone: zone, ...timeOptions }, from);
    const closes = format({ timeZone: zone, ...timeOptions, timeZoneName: 'short' }, to);

    return `${day}, ${opens} - ${closes}`;
}

module.exports = { cleanZone, zoneIsUsable, asDate, formatWhen, formatWindow };
