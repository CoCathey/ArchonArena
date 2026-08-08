/**
 * ARCHON: the notification event taxonomy (N2).
 *
 * One entry per thing the platform will tell a player about. The key is both
 * the event type and the opt-out unit, so "turn off pairing emails" is a single
 * row rather than a policy spread across the code that raises the events.
 *
 * Deliberately a small closed list rather than free-form strings: every
 * notification has to be something a player can find, understand and switch
 * off, and an unnamed category is none of those. Adding one is a one-line
 * change here plus the call site - no migration, because the DB column is text.
 *
 * `email` defaults are set per category by whether the notification is useless
 * if missed. A round pairing you do not see costs you the match, so it mails by
 * default; "your friend request was accepted" is pleasant but never urgent, so
 * it does not.
 */
const CATEGORIES = {
    'tournament.pairing': {
        group: 'Tournaments',
        label: 'Round pairings',
        description: 'You have been paired for a new round and your table is ready.',
        defaults: { inApp: true, email: true }
    },
    'tournament.start': {
        group: 'Tournaments',
        label: 'Event start',
        description: 'An event you are registered for has begun.',
        defaults: { inApp: true, email: true }
    },
    // ARCHON (N14): asynchronous events run on these two. Scheduling mails by
    // default for the same reason pairings do - an offer of "Thursday 8pm?"
    // that sits unseen for two days IS the failure the feature exists to
    // prevent.
    'tournament.schedule': {
        group: 'Tournaments',
        label: 'Match scheduling',
        description:
            'Your opponent proposed, accepted or cleared a time for your tournament match.',
        defaults: { inApp: true, email: true }
    },
    'tournament.deadline': {
        group: 'Tournaments',
        label: 'Round deadlines',
        description:
            'A round deadline in an asynchronous event has passed with your match unplayed, or (for organizers) with matches outstanding.',
        defaults: { inApp: true, email: true }
    },
    'friend.request': {
        group: 'Community',
        label: 'Friend requests',
        description: 'Someone has sent you a friend request.',
        defaults: { inApp: true, email: true }
    },
    'friend.accepted': {
        group: 'Community',
        label: 'Friend requests accepted',
        description: 'Someone accepted the friend request you sent.',
        defaults: { inApp: true, email: false }
    },
    'club.join': {
        group: 'Community',
        label: 'Club joins',
        description: 'Someone joined a club you own.',
        defaults: { inApp: true, email: false }
    },
    // ARCHON (N13): an in-person game is stuck until the other player files
    // their report, and neither of them is on the site when it happens - the
    // whole exchange takes place across a table. So this mails by default:
    // a report nobody is told about is a game that never gets recorded.
    'game.inperson': {
        group: 'Play',
        label: 'In-person games',
        description:
            'Someone recorded a paper game with you, your report is needed, or a result was confirmed or disputed.',
        defaults: { inApp: true, email: true }
    },
    // ARCHON (N5). Deliberately the two categories a player CANNOT opt out
    // of in practice: a sanction nobody told you about is indistinguishable
    // from the site being broken, and "why can I not chat" is the single
    // most predictable support question a moderation system generates.
    // They are still listed here so the preferences page is honest about
    // what the platform sends.
    'moderation.action': {
        group: 'Account',
        label: 'Moderation actions on your account',
        description:
            'A moderator has warned, muted, timed out or suspended your account - or lifted one of those.',
        defaults: { inApp: true, email: true }
    },
    'moderation.update': {
        group: 'Account',
        label: 'Updates on reports you filed',
        description:
            'A report you submitted has been reviewed. You are told it was handled, never what was done to the other account.',
        defaults: { inApp: true, email: false }
    }
};

const CATEGORY_KEYS = Object.keys(CATEGORIES);

/** Whether `category` is a category this build knows about. */
function isKnownCategory(category) {
    return Object.prototype.hasOwnProperty.call(CATEGORIES, category);
}

/**
 * Delivery defaults for a category.
 *
 * An unknown category - a row written by a newer build, or one whose category
 * has since been retired - degrades to "show it, do not mail it" rather than
 * throwing: a stored notification must always stay readable.
 */
function categoryDefaults(category) {
    return isKnownCategory(category)
        ? { ...CATEGORIES[category].defaults }
        : { inApp: true, email: false };
}

/** The taxonomy as a list, for the preferences UI. */
function describeCategories() {
    return CATEGORY_KEYS.map((key) => ({
        category: key,
        group: CATEGORIES[key].group,
        label: CATEGORIES[key].label,
        description: CATEGORIES[key].description,
        defaults: { ...CATEGORIES[key].defaults }
    }));
}

module.exports = {
    CATEGORIES,
    CATEGORY_KEYS,
    isKnownCategory,
    categoryDefaults,
    describeCategories
};
