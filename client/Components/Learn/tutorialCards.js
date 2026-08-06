/**
 * ARCHON (N11): card data for the two KeyForge learning decks that ship in the
 * Ghost Galaxy two-player starter set. The interactive tutorial at /learn
 * replays the official demo game with these 36 cards, so the data is frozen
 * here rather than fetched: the tutorial has to work for a signed-out visitor
 * who has never loaded a game, and the script depends on these exact stats.
 *
 * Text is taken verbatim from master-vault-data/packs (the most recent
 * printing of each card, which is what the starter set carries). The
 * Aember/damage glyphs in the master vault text live in a private-use unicode
 * range with no matching webfont here, so they are stored as {A} and {D} and
 * turned into icons at render time by CardText.
 */

/**
 * @typedef TutorialCard
 * @property {string} id Card id, also the image name under /img/cards
 * @property {string} name
 * @property {string} house
 * @property {'creature'|'artifact'|'action'|'upgrade'} type
 * @property {number} [power]
 * @property {number} [armor]
 * @property {number} [bonusAmber] Printed Aember bonus icons
 * @property {string[]} keywords
 * @property {string[]} traits
 * @property {string} text
 */

/** @type {Object<string, TutorialCard>} */
export const TutorialCards = {
    // Radiant Learning Deck - House Mars
    'incubation-chamber': {
        id: 'incubation-chamber',
        name: 'Incubation Chamber',
        house: 'mars',
        type: 'artifact',
        keywords: [],
        traits: ['location'],
        text: 'Omni: You may reveal a Mars creature from your hand. If you do, archive it.'
    },
    'yxl-the-iron-captain': {
        id: 'yxl-the-iron-captain',
        name: 'Yxl the Iron Captain',
        house: 'mars',
        type: 'creature',
        power: 4,
        armor: 1,
        keywords: [],
        traits: ['martian', 'ironyx'],
        text: 'Play: Each friendly Ironyx creature captures 2{A}.'
    },
    'ironyx-rebel': {
        id: 'ironyx-rebel',
        name: 'Ironyx Rebel',
        house: 'mars',
        type: 'creature',
        power: 2,
        armor: 0,
        keywords: ['deploy'],
        traits: ['martian', 'ironyx'],
        text:
            'Deploy. (This creature can enter play anywhere in your battleline.)\n' +
            'Play: Ready each of Ironyx Rebel’s Mars neighbors.'
    },
    'myx-the-tallminded': {
        id: 'myx-the-tallminded',
        name: 'Myx, the Tallminded',
        house: 'mars',
        type: 'creature',
        power: 5,
        armor: 0,
        keywords: [],
        traits: ['martian'],
        text: 'Your opponent’s keys cost +1{A} for each friendly Mars creature in play.'
    },
    'zysysyx-shockworm': {
        id: 'zysysyx-shockworm',
        name: 'Zysysyx Shockworm',
        house: 'mars',
        type: 'creature',
        power: 3,
        armor: 1,
        keywords: [],
        traits: ['soldier', 'martian'],
        text: 'After an enemy creature reaps, stun it.'
    },
    'destroy-them-all': {
        id: 'destroy-them-all',
        name: 'Destroy Them All!',
        house: 'mars',
        type: 'action',
        keywords: [],
        traits: [],
        text: 'Play: Destroy an artifact, a creature, and an upgrade.'
    },

    // Radiant Learning Deck - House Sanctum
    'champion-anaphiel': {
        id: 'champion-anaphiel',
        name: 'Champion Anaphiel',
        house: 'sanctum',
        type: 'creature',
        power: 6,
        armor: 1,
        keywords: ['taunt'],
        traits: ['knight', 'spirit'],
        text: 'Taunt. (This creature’s neighbors cannot be attacked unless they have taunt.)'
    },
    'sergeant-zakiel': {
        id: 'sergeant-zakiel',
        name: 'Sergeant Zakiel',
        house: 'sanctum',
        type: 'creature',
        power: 4,
        armor: 1,
        keywords: [],
        traits: ['human', 'knight'],
        text: 'Play: You may ready and fight with a neighboring creature.'
    },
    'mother-northelle': {
        id: 'mother-northelle',
        name: 'Mother Northelle',
        house: 'sanctum',
        type: 'creature',
        power: 2,
        armor: 0,
        keywords: ['elusive'],
        traits: ['human', 'monk'],
        text:
            'Elusive. (The first time this creature is attacked each turn, no damage is dealt.)\n' +
            'After Reap: Move 1{A} from a friendly creature to your pool.'
    },
    'raiding-knight': {
        id: 'raiding-knight',
        name: 'Raiding Knight',
        house: 'sanctum',
        type: 'creature',
        power: 4,
        armor: 2,
        keywords: [],
        traits: ['human', 'knight'],
        text: 'Play: Capture 1{A}. (Move 1{A} from your opponent’s pool to this creature.)'
    },
    'gorm-of-omm': {
        id: 'gorm-of-omm',
        name: 'Gorm of Omm',
        house: 'sanctum',
        type: 'artifact',
        keywords: [],
        traits: ['item'],
        text: 'Omni: Destroy Gorm of Omm. Destroy an artifact.'
    },
    'protect-the-weak': {
        id: 'protect-the-weak',
        name: 'Protect the Weak',
        house: 'sanctum',
        type: 'upgrade',
        bonusAmber: 1,
        keywords: [],
        traits: [],
        text: 'This creature gets +1 armor and gains taunt. (This creature’s neighbors cannot be attacked unless they have taunt.)'
    },

    // Radiant Learning Deck - House Star Alliance
    'badge-of-unity': {
        id: 'badge-of-unity',
        name: 'Badge of Unity',
        house: 'staralliance',
        type: 'upgrade',
        keywords: [],
        traits: [],
        text: 'This creature belongs to house Star Alliance in addition to its other houses.'
    },
    'commander-chan': {
        id: 'commander-chan',
        name: 'Commander Chan',
        house: 'staralliance',
        type: 'creature',
        power: 4,
        armor: 0,
        keywords: [],
        traits: ['human'],
        text: 'After Fight/After Reap: Use another friendly creature.'
    },
    'medic-ingram': {
        id: 'medic-ingram',
        name: 'Medic Ingram',
        house: 'staralliance',
        type: 'creature',
        power: 3,
        armor: 0,
        keywords: [],
        traits: ['human'],
        text: 'Play/After Fight/After Reap: You may heal 3 damage from a creature and ward it.'
    },
    'tactical-officer-moon': {
        id: 'tactical-officer-moon',
        name: 'Tactical Officer Moon',
        house: 'staralliance',
        type: 'creature',
        power: 4,
        armor: 0,
        keywords: ['assault:2'],
        traits: ['human'],
        text:
            'Assault 2. (Before this creature attacks, deal 2{D} to the attacked enemy.)\n' +
            'Play: You may rearrange the creatures in a player’s battleline.'
    },
    'explo-rover': {
        id: 'explo-rover',
        name: 'Explo-rover',
        house: 'staralliance',
        type: 'creature',
        power: 3,
        armor: 0,
        keywords: ['skirmish'],
        traits: ['robot'],
        text:
            'Skirmish. (When you use this creature to fight, it is dealt no damage in return.)\n' +
            'Explo-rover may be played as an upgrade instead of a creature, with the text: “This creature gains skirmish.”'
    },
    zap: {
        id: 'zap',
        name: 'Zap',
        house: 'staralliance',
        type: 'action',
        bonusAmber: 1,
        keywords: [],
        traits: [],
        text: 'Play: Deal 1{D} to a creature for each house represented among creatures in play.'
    },

    // Onyx Learning Deck - House Brobnar
    headhunter: {
        id: 'headhunter',
        name: 'Headhunter',
        house: 'brobnar',
        type: 'creature',
        power: 5,
        armor: 0,
        keywords: [],
        traits: ['giant'],
        text: 'After Fight: Gain 1{A}.'
    },
    valdr: {
        id: 'valdr',
        name: 'Valdr',
        house: 'brobnar',
        type: 'creature',
        power: 6,
        armor: 0,
        keywords: [],
        traits: ['giant'],
        text: 'Valdr deals +2{D} while attacking an enemy flank creature.'
    },
    'gauntlet-of-command': {
        id: 'gauntlet-of-command',
        name: 'Gauntlet of Command',
        house: 'brobnar',
        type: 'artifact',
        keywords: [],
        traits: ['item'],
        text: 'Action: Ready and fight with a friendly creature.'
    },
    'blood-of-titans': {
        id: 'blood-of-titans',
        name: 'Blood of Titans',
        house: 'brobnar',
        type: 'upgrade',
        bonusAmber: 1,
        keywords: [],
        traits: [],
        text: 'This creature gets +5 power.'
    },
    'grenade-snib': {
        id: 'grenade-snib',
        name: 'Grenade Snib',
        house: 'brobnar',
        type: 'creature',
        power: 2,
        armor: 0,
        keywords: [],
        traits: ['goblin'],
        text: 'Destroyed: Your opponent loses 2{A}.'
    },
    'crogg-the-clumsy': {
        id: 'crogg-the-clumsy',
        name: 'Crogg the Clumsy',
        house: 'brobnar',
        type: 'creature',
        power: 7,
        armor: 0,
        keywords: ['splash-attack:2'],
        traits: ['giant'],
        text: 'Splash-attack 2. (When this creature attacks, also deal 2{D} to each of the attacked creature’s neighbors.)'
    },

    // Onyx Learning Deck - House Ekwidon
    'gemcoat-vendor': {
        id: 'gemcoat-vendor',
        name: 'Gemcoat Vendor',
        house: 'ekwidon',
        type: 'creature',
        power: 6,
        armor: 0,
        keywords: [],
        traits: ['merchant', 'getrookya'],
        text: 'Action: Steal 1{A}. Deal 1{D} to Gemcoat Vendor.'
    },
    'the-old-tinker': {
        id: 'the-old-tinker',
        name: 'The Old Tinker',
        house: 'ekwidon',
        type: 'creature',
        power: 3,
        armor: 0,
        keywords: ['elusive'],
        traits: ['artisan', 'getrookya'],
        text:
            'Elusive. (The first time this creature is attacked each turn, no damage is dealt.)\n' +
            'After Reap: Discard a card from your hand. Draw a card.'
    },
    'forced-retirement': {
        id: 'forced-retirement',
        name: 'Forced Retirement',
        house: 'ekwidon',
        type: 'action',
        keywords: [],
        traits: [],
        text: 'Play: Destroy a creature. If you do, its controller gains 1{A}.'
    },
    'uncommon-currency': {
        id: 'uncommon-currency',
        name: 'Uncommon Currency',
        house: 'ekwidon',
        type: 'artifact',
        keywords: [],
        traits: ['item'],
        text: 'Action: Swap control of Uncommon Currency and an enemy artifact.'
    },
    'transitory-philosopher': {
        id: 'transitory-philosopher',
        name: 'Transitory Philosopher',
        house: 'ekwidon',
        type: 'creature',
        power: 5,
        armor: 0,
        keywords: [],
        traits: ['getrookya', 'philosopher'],
        text: 'Action: Steal 1{A} for each enemy artifact.'
    },
    'belligerent-guard': {
        id: 'belligerent-guard',
        name: 'Belligerent Guard',
        house: 'ekwidon',
        type: 'creature',
        power: 8,
        armor: 0,
        keywords: [],
        traits: ['giant'],
        text: 'Belligerent Guard enters play ready.\n' + 'Play: Your opponent draws a card.'
    },

    // Onyx Learning Deck - House Unfathomable
    kaupe: {
        id: 'kaupe',
        name: 'Kaupe',
        house: 'unfathomable',
        type: 'creature',
        power: 2,
        armor: 0,
        keywords: [],
        traits: ['aquan'],
        text: 'Your opponent cannot play more than 1 card of each card type (action, artifact, creature, upgrade) each turn.'
    },
    wikolia: {
        id: 'wikolia',
        name: 'Wikolia',
        house: 'unfathomable',
        type: 'creature',
        power: 3,
        armor: 0,
        keywords: [],
        traits: ['beast'],
        text: 'After Reap: Keys cost +2{A} during your opponent’s next turn.'
    },
    'adult-swim': {
        id: 'adult-swim',
        name: 'Adult Swim',
        house: 'unfathomable',
        type: 'action',
        bonusAmber: 1,
        keywords: [],
        traits: [],
        text: 'Play: Put each creature with power 3 or lower on top of its owner’s deck in a random order.'
    },
    'frigorific-rod': {
        id: 'frigorific-rod',
        name: 'Frigorific Rod',
        house: 'unfathomable',
        type: 'artifact',
        bonusAmber: 1,
        keywords: [],
        traits: ['item'],
        text: 'Action: Exhaust a creature or artifact.'
    },
    'weak-link': {
        id: 'weak-link',
        name: 'Weak Link',
        house: 'unfathomable',
        type: 'upgrade',
        bonusAmber: 1,
        keywords: [],
        traits: [],
        text: 'This creature gains, “While this creature is exhausted, your keys cost +6{A}.”'
    },
    kelpminder: {
        id: 'kelpminder',
        name: 'Kelpminder',
        house: 'unfathomable',
        type: 'creature',
        power: 5,
        armor: 0,
        keywords: [],
        traits: ['aquan'],
        text: 'Enhance {C}{R}{R}. (These icons have already been added to cards in your deck.)'
    }
};
