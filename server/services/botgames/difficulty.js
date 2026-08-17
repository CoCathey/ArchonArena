/**
 * ARCHON (F9): how hard the practice bot is, expressed as the deck it brings.
 *
 * The bot's brain is the same at every setting - one champion model (or one
 * plain order) shared with the lab, and deliberately so: a bot that plays
 * WORSE on purpose teaches bad habits, and a bot that plays better on purpose
 * would need a second brain nobody maintains. What changes is the deck it
 * sits down with, which is the honest lever KeyForge already has. A 50-ARI
 * deck loses to a 110-ARI deck in anybody's hands.
 *
 * ARI is the platform's own living deck rating (N19, `rating/AriService`):
 * seeded from SAS/AERC and moved by every rated and sparring game since, so
 * these bands mean "decks this platform has actually seen perform like this",
 * not "decks somebody's model once scored".
 *
 * The bands are deliberately touching but not overlapping, and they leave a
 * gap at each end on purpose: below 45 is a deck nobody would enjoy playing
 * against and above 125 is a deck almost nothing beats, so neither belongs on
 * a table meant for practice.
 */

/** The three settings, in the order they are offered. */
const BOT_DIFFICULTIES = [
    { key: 'easy', label: 'Easy', minAri: 45, maxAri: 65 },
    { key: 'medium', label: 'Medium', minAri: 66, maxAri: 89 },
    { key: 'hard', label: 'Hard', minAri: 90, maxAri: 125 }
];

/**
 * What a table plays at until somebody says otherwise. Medium is the middle
 * of the field, so an unattended table is a fair game rather than a warm-up
 * or a wall.
 */
const DEFAULT_DIFFICULTY = 'medium';

/** The keys, for validating what a client sends. */
const DIFFICULTY_KEYS = BOT_DIFFICULTIES.map((entry) => entry.key);

/**
 * The band a name refers to, or the default band for anything else.
 *
 * Never throws and never returns null: an unrecognised setting - an old
 * client, a hand-made socket message - plays a Medium game rather than
 * failing to open a table.
 *
 * @param {string} [name]
 * @returns {{key: string, label: string, minAri: number, maxAri: number}}
 */
function difficultyBand(name) {
    const wanted = String(name || '').toLowerCase();

    return (
        BOT_DIFFICULTIES.find((entry) => entry.key === wanted) ||
        BOT_DIFFICULTIES.find((entry) => entry.key === DEFAULT_DIFFICULTY)
    );
}

/** The stored form of whatever a client asked for. */
function normalizeDifficulty(name) {
    return difficultyBand(name).key;
}

module.exports = {
    BOT_DIFFICULTIES,
    DEFAULT_DIFFICULTY,
    DIFFICULTY_KEYS,
    difficultyBand,
    normalizeDifficulty
};
