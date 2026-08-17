/**
 * ARCHON (F9): the practice bots, one per house.
 *
 * Each bot is a character rather than a slot: it belongs to a house, it is
 * named for it, and it only ever plays decks that contain that house. That
 * is the whole point of having thirteen of them instead of one - the lobby's
 * open table is a different opponent playing a different colour of deck each
 * time somebody sits down at the last one.
 *
 * The house is the bot's identity and never changes: it decides which decks
 * the bot may play, and it is what its account is keyed to (see
 * BotService.botEmail), so an admin renaming a bot renames a character
 * rather than rebinding it to a different set of decks.
 *
 * Names, pictures and profiles are all editable per bot from the Bot
 * Settings page; these are only what a fresh site starts with.
 */

/** Houses with no bot: `ouboros` and `redemption` are not deck houses. */
const BOT_ROSTER = [
    { house: 'brobnar', defaultName: 'BingleBangbang' },
    { house: 'dis', defaultName: 'Snudge' },
    { house: 'ekwidon', defaultName: 'TalentScout' },
    { house: 'geistoid', defaultName: 'Memette' },
    { house: 'logos', defaultName: 'HelperBot' },
    { house: 'mars', defaultName: 'Tunk' },
    { house: 'sanctum', defaultName: 'Bulwark' },
    { house: 'saurian', defaultName: 'Philophosaurus' },
    { house: 'shadows', defaultName: 'BadPenny' },
    { house: 'skyborn', defaultName: 'RedBaron' },
    { house: 'staralliance', defaultName: 'Explorover' },
    { house: 'unfathomable', defaultName: 'Bubbles' },
    { house: 'untamed', defaultName: 'FuzzyGruen' }
];

/** House code -> the name it is written with. */
const HOUSE_LABELS = {
    brobnar: 'Brobnar',
    dis: 'Dis',
    ekwidon: 'Ekwidon',
    geistoid: 'Geistoid',
    logos: 'Logos',
    mars: 'Mars',
    sanctum: 'Sanctum',
    saurian: 'Saurian',
    shadows: 'Shadows',
    skyborn: 'Skyborn',
    staralliance: 'Star Alliance',
    unfathomable: 'Unfathomable',
    untamed: 'Untamed'
};

const BOT_HOUSES = BOT_ROSTER.map((entry) => entry.house);

/**
 * The domain every bot account's email sits on. No human can register it
 * (`.invalid` is reserved by RFC 2606), which is what makes it usable as
 * proof that an account is ours - see BotService for the ownership rules.
 *
 * It doubles as the display signal: the badge next to a name says BOT
 * because of this, so a bot is marked everywhere a name is rendered without
 * a second table to join or a flag to remember to set.
 */
const BOT_EMAIL_DOMAIN = 'archon-bots.invalid';

/**
 * The sentinel email for a house's bot. Keyed on the HOUSE rather than the
 * name, because a bot's name is an admin's to change and an email built from
 * it would stop proving anything the moment they changed it.
 */
function botEmail(house) {
    return `bot+${house}@${BOT_EMAIL_DOMAIN}`;
}

/** Is this account one of ours? */
function isBotEmail(email) {
    return typeof email === 'string' && email.toLowerCase().endsWith(`@${BOT_EMAIL_DOMAIN}`);
}

function isBotHouse(house) {
    return BOT_HOUSES.includes(house);
}

function houseLabel(house) {
    return HOUSE_LABELS[house] || house;
}

function defaultNameFor(house) {
    const entry = BOT_ROSTER.find((candidate) => candidate.house === house);

    return entry ? entry.defaultName : null;
}

module.exports = {
    BOT_ROSTER,
    BOT_HOUSES,
    BOT_EMAIL_DOMAIN,
    HOUSE_LABELS,
    botEmail,
    isBotEmail,
    isBotHouse,
    houseLabel,
    defaultNameFor
};
