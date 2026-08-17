const fs = require('fs');
const path = require('path');

/**
 * ARCHON (N18): the card index the Champion’s Challenge simulates with.
 *
 * The engine wants every deck entry to carry the full card JSON, and in a real
 * game the lobby joins that in from the Redis-backed CardService
 * (lobby.js `applyDeckSelection`). The lab reads the pack files on disk
 * instead, for two reasons: the sweep must keep working when Redis is having a
 * day (a simulated game is the one workload that has no user waiting on it,
 * so it must never compete for a shared cache), and the packs are what the
 * test suite and the scenario devtool already simulate against, so the lab
 * plays by exactly the rules the 38,000-test baseline exercises.
 *
 * Loaded lazily and once: ~10 MB of JSON parsed on the first sweep rather
 * than at lobby boot.
 */

const PACKS_DIR = path.join(__dirname, '../../../master-vault-data/packs');

// Sets that reprint another set's cards under a new house keep the ORIGINAL
// entry, exactly as the test DeckBuilder does - the reprint would otherwise
// overwrite the house every other deck expects.
const REPRINT_HOUSES = ['redemption'];

let cardIndex = null;

/** @returns {Object<string, object>} card id -> card JSON, shared and frozen-by-convention */
function getCardIndex() {
    if (!cardIndex) {
        cardIndex = {};

        const packFiles = fs.readdirSync(PACKS_DIR).filter((file) => file.endsWith('.json'));

        for (const file of packFiles) {
            const pack = JSON.parse(fs.readFileSync(path.join(PACKS_DIR, file), 'utf8'));

            for (const card of pack.cards || []) {
                if (REPRINT_HOUSES.includes(card.house) && card.id in cardIndex) {
                    continue;
                }

                cardIndex[card.id] = card;
            }
        }
    }

    return cardIndex;
}

/**
 * The full card JSON for an id, deep-cloned.
 *
 * Cloned because the engine MUTATES the card object it is given -
 * `Deck.prepare` writes mavericks, anomalies and enhancements straight onto
 * it - and a shared index entry would leak one deck's maverick house into
 * every later game that plays the same card.
 *
 * @param {string} id
 * @returns {object|null}
 */
function cloneCard(id) {
    const card = getCardIndex()[id];

    return card ? JSON.parse(JSON.stringify(card)) : null;
}

/** For tests: drop the cache so a spec can measure a cold load. */
function resetCache() {
    cardIndex = null;
}

module.exports = { getCardIndex, cloneCard, resetCache };
