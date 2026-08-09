/**
 * ARCHON: the archon-maker image-diff harness.
 *
 * `client/archonMaker.js` draws the deck list, the card back and every card
 * image with Fabric. Those are the most visually load-bearing pixels on the
 * site and there is no test that looks at them - a Fabric upgrade, a token
 * change or a font swap can shift text a pixel, drop a shadow or lose an icon
 * and every existing test stays green.
 *
 * This page renders a fixed set of those outputs from fixed data so they can be
 * captured and compared byte-for-byte. It runs in a real browser rather than in
 * jsdom because Fabric draws to a real 2D context and text metrics come from
 * the real font stack; a headless canvas shim would be testing the shim.
 *
 * Determinism is the whole point, so everything here is pinned:
 *  - fixture decks and cards are literals, never fetched;
 *  - card art is a locally generated image, never the Master Vault CDN;
 *  - the fonts the maker asks for are awaited before anything draws, because
 *    Fabric measures text at draw time and an unloaded font silently falls back
 *    to a different metric.
 */
import { StaticCanvas } from 'fabric';

import { buildCard, buildCardBack, buildDeckList } from '../../client/archonMaker';
import '../../client/styles/tailwind.css';

/** Stand-in card art: deterministic, offline, and visibly wrong if it vanishes. */
const stubArt = () => {
    const canvas = document.createElement('canvas');
    canvas.width = 300;
    canvas.height = 420;

    const context = canvas.getContext('2d');
    const gradient = context.createLinearGradient(0, 0, 300, 420);

    gradient.addColorStop(0, '#2b3a67');
    gradient.addColorStop(1, '#8a5a2b');
    context.fillStyle = gradient;
    context.fillRect(0, 0, 300, 420);
    context.fillStyle = '#ffffff';
    context.fillRect(40, 60, 220, 8);
    context.fillRect(40, 300, 160, 8);

    return canvas.toDataURL('image/png');
};

const ART = stubArt();

const card = (overrides = {}) => ({
    id: 'harness-card',
    name: 'Harness Test Card',
    number: '042',
    image: ART,
    url: ART,
    expansion: 341,
    house: 'brobnar',
    keywords: [],
    traits: ['giant'],
    type: 'creature',
    rarity: 'Rare',
    amber: 1,
    armor: 2,
    power: 7,
    text: 'Play: Deal 2 damage to a creature.',
    ...overrides
});

/**
 * A realistically sized deck: 36 cards over three houses.
 *
 * The size is load-bearing rather than cosmetic. `buildDeckList` flows rows
 * into its three columns purely by index - twelve per column, with a hard
 * y-offset per column - so a short fixture would pile everything into column
 * one and leave the column-break arithmetic, which is exactly the sort of code
 * an upgrade disturbs, completely uncovered.
 *
 * The variety is chosen to hit branches that draw differently: every card type,
 * every rarity tier with its own icon, a maverick, an anomaly, an enhanced
 * card, and a name long enough to force truncation.
 */
const TYPES = ['creature', 'action', 'artifact', 'upgrade'];
const RARITIES = ['Common', 'Uncommon', 'Rare', 'Special'];
const HOUSES = ['brobnar', 'dis', 'logos'];

const deckCards = [];

for (let index = 0; index < 36; index++) {
    const house = HOUSES[Math.floor(index / 12)];
    const type = TYPES[index % TYPES.length];
    const rarity = RARITIES[index % RARITIES.length];
    const number = String(index + 1).padStart(3, '0');
    const entry = {
        count: 1,
        card: card({
            name: `${rarity} ${type} ${number}`,
            house,
            type,
            rarity,
            number,
            id: `harness-${number}`
        })
    };

    // A handful of cards carry the decorations, spread across all three
    // columns so no column is a plain list.
    if (index === 2) {
        entry.card.maverick = 'dis';
    }

    if (index === 14) {
        entry.card.anomaly = 'logos';
    }

    if (index === 26) {
        entry.card.enhancements = ['amber', 'draw'];
    }

    if (index === 7) {
        entry.card.name = 'A Deliberately Very Long Card Name That Must Truncate';
    }

    deckCards.push(entry);
}

const deck = {
    name: 'Harness Deck of Fixed Pixels',
    expansion: 341,
    houses: HOUSES,
    cards: deckCards
};

/** Every image the harness captures, keyed by the filename it is stored under. */
const SUBJECTS = {
    'deck-list': async (canvas) => {
        await buildDeckList(canvas, deck, 'en', (text) => text, 'normal', true);
    },
    'deck-list-no-accolades': async (canvas) => {
        await buildDeckList(canvas, deck, 'en', (text) => text, 'normal', false);
    },
    // A deck with no houses is the maker's explicit failure path; it has its
    // own drawing code and is exactly the sort of thing an upgrade breaks
    // without anyone noticing, because nobody looks at the error state.
    'deck-list-failed': async (canvas) => {
        await buildDeckList(canvas, { name: 'No Houses' }, 'en', (text) => text, 'normal', true);
    },
    'card-back': async (canvas) => {
        await buildCardBack(canvas, deck, 'normal', true);
    },
    'card-back-no-name': async (canvas) => {
        await buildCardBack(canvas, deck, 'normal', false);
    },
    'card-plain': async (canvas) => {
        await buildCard(canvas, { ...card(), size: 'normal', url: ART });
    },
    'card-maverick': async (canvas) => {
        await buildCard(canvas, {
            ...card({ name: 'Maverick Creature', house: 'dis' }),
            maverick: 'dis',
            size: 'normal',
            url: ART
        });
    },
    'card-enhanced': async (canvas) => {
        await buildCard(canvas, {
            ...card({ name: 'Enhanced Creature' }),
            enhancements: ['amber', 'draw', 'damage'],
            size: 'normal',
            url: ART
        });
    },
    // The board overlays - modified power, armor, amber and damage tokens -
    // only draw for a creature that is `location: 'play area'`. Without that
    // this subject renders the bare art and silently protects nothing, which
    // is how it was first written.
    'card-with-tokens': async (canvas) => {
        await buildCard(canvas, {
            ...card({ name: 'Tokened Creature' }),
            location: 'play area',
            powerPrinted: 7,
            armorPrinted: 2,
            modifiedPower: 11,
            tokens: { amber: 3, damage: 2, armor: 1 },
            size: 'normal',
            url: ART
        });
    }
};

/**
 * Render one subject and hand back its PNG.
 *
 * A fresh StaticCanvas per subject: Fabric caches per canvas, and reusing one
 * would let subject N's cache decide what subject N+1 looks like - the harness
 * would then be stable for the wrong reason.
 */
async function renderSubject(name) {
    const element = document.createElement('canvas');
    document.getElementById('stage').appendChild(element);

    const canvas = new StaticCanvas(element);
    canvas.renderOnAddRemove = false;

    await SUBJECTS[name](canvas);

    // Fabric batches; without an explicit render the bitmap can be a frame behind.
    if (typeof canvas.renderAll === 'function') {
        canvas.renderAll();
    }

    const dataUrl = element.toDataURL('image/png');

    canvas.dispose();
    element.remove();

    return dataUrl;
}

window.__renderSubject = renderSubject;
window.__subjectNames = Object.keys(SUBJECTS);

/**
 * The fonts have to be in before anything measures text. Fabric asks for
 * PoppinsMedium and Bombardier by name; if they are not loaded the browser
 * substitutes silently and every glyph lands a fraction off, which reads as a
 * spurious diff on an upgrade that changed nothing.
 */
window.__fontsReady = (async () => {
    if (!document.fonts) {
        return false;
    }

    await Promise.all([
        document.fonts.load('600 20px PoppinsMedium'),
        document.fonts.load('normal 35px Bombardier')
    ]);
    await document.fonts.ready;

    return document.fonts.check('600 20px PoppinsMedium');
})();
