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
    HOUSE_LABELS,
    isBotHouse,
    houseLabel,
    defaultNameFor
};
