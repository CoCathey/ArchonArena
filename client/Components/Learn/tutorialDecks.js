import { TutorialCards } from './tutorialCards';

/**
 * ARCHON (N11): the two learning decks from the KeyForge two-player starter
 * set, in the exact order the starter set tells you to stack them.
 *
 * The printed learning decks are numbered 1-18 in the top right corner and the
 * demo game is played from an unshuffled deck, so "card 6" and "card 10" in the
 * official walkthrough are fixed positions rather than lucky draws. Every draw
 * in tutorialScript.js is taken off the top of these lists, which is what keeps
 * the replay honest: no step hands a player a card the deck could not have
 * given them.
 *
 * Bonus icons: `bonusAmber` on the card itself is the printed Aember bonus.
 * `enhancements` here are the extra bonus icons stamped onto specific copies in
 * these particular decks (Forced Retirement's capture + draw, Transitory
 * Philosopher's draw), which is how the walkthrough uses them.
 */

/**
 * @typedef TutorialDeck
 * @property {string} key Player key used throughout the tutorial state
 * @property {string} name Deck name as printed on the identity card
 * @property {string} shortName Name used in narration
 * @property {string[]} houses The three houses on the identity card
 * @property {string[]} cards Card ids, position 0 is card #1 (top of the deck)
 * @property {Object<string, string[]>} enhancements Extra bonus icons by card id
 */

/** @type {TutorialDeck} */
export const RadiantDeck = {
    key: 'radiant',
    name: 'Radiant Learning Deck',
    shortName: 'Radiant',
    houses: ['mars', 'sanctum', 'staralliance'],
    cards: [
        'incubation-chamber', // 1
        'yxl-the-iron-captain', // 2
        'champion-anaphiel', // 3
        'sergeant-zakiel', // 4
        'ironyx-rebel', // 5
        'badge-of-unity', // 6
        'commander-chan', // 7
        'medic-ingram', // 8
        'protect-the-weak', // 9
        'gorm-of-omm', // 10
        'mother-northelle', // 11
        'raiding-knight', // 12
        'myx-the-tallminded', // 13
        'zysysyx-shockworm', // 14
        'destroy-them-all', // 15
        'tactical-officer-moon', // 16
        'explo-rover', // 17
        'zap' // 18
    ],
    enhancements: {}
};

/** @type {TutorialDeck} */
export const OnyxDeck = {
    key: 'onyx',
    name: 'Onyx Learning Deck',
    shortName: 'Onyx',
    houses: ['brobnar', 'ekwidon', 'unfathomable'],
    cards: [
        'headhunter', // 1
        'valdr', // 2
        'gauntlet-of-command', // 3
        'gemcoat-vendor', // 4
        'the-old-tinker', // 5
        'forced-retirement', // 6
        'wikolia', // 7
        'adult-swim', // 8
        'frigorific-rod', // 9
        'kaupe', // 10
        'weak-link', // 11
        'uncommon-currency', // 12
        'transitory-philosopher', // 13
        'belligerent-guard', // 14
        'blood-of-titans', // 15
        'grenade-snib', // 16
        'crogg-the-clumsy', // 17
        'kelpminder' // 18
    ],
    enhancements: {
        'forced-retirement': ['capture', 'draw'],
        'transitory-philosopher': ['draw']
    }
};

export const TutorialDecks = { radiant: RadiantDeck, onyx: OnyxDeck };

/** The deck position (1-18) printed on a learning-deck card. */
export const cardNumber = (side, cardId) => TutorialDecks[side].cards.indexOf(cardId) + 1;

/** Bonus icons a card shows in this tutorial: printed Aember plus enhancements. */
export const bonusIcons = (side, cardId) => {
    const card = TutorialCards[cardId];
    const icons = [];

    for (let i = 0; i < (card?.bonusAmber || 0); i++) {
        icons.push('amber');
    }

    return icons.concat(TutorialDecks[side].enhancements[cardId] || []);
};
