import {
    archiveFromHand,
    beginTurn,
    capture,
    chooseHouse,
    dealDamage,
    destroyArtifact,
    destroyCreature,
    destroyUpgrade,
    discardFromHand,
    draw,
    drawToHandSize,
    fight,
    finishAction,
    forgeKey,
    gainAmber,
    heal,
    loseAmber,
    moveAmberToPool,
    note,
    play,
    readyAll,
    ready,
    reap,
    reshuffle,
    setPhase,
    stealAmber,
    takeArchives,
    activate,
    wardCard
} from './tutorialEngine';
import { RadiantDeck, OnyxDeck } from './tutorialDecks';

/**
 * ARCHON (N11): the interactive Learn-to-Play tutorial.
 *
 * This is the demo game from Ghost Galaxy's two-player starter set, step by
 * step, played with the Radiant and Onyx learning decks. Every rule the
 * official walkthrough teaches is taught here in the same order and at the same
 * moment it first matters, and the board beside the text is the real position
 * after that step - it is not an illustration.
 *
 * Each step is:
 *   chapter   grouping shown in the chapter rail
 *   title     the heading for this step
 *   body      one or more paragraphs; **bold** and the {A} {D} {C} {R} icon
 *             tokens are rendered by RichText
 *   rule      an optional rules box - the rule this step exists to teach
 *   platform  an optional note about doing this on Archon Arena rather than at
 *             a kitchen table
 *   highlight board targets to spotlight: 'side.card.id', 'side.zone.name',
 *             'side.stat.name', or 'turnsteps'
 *   apply     mutates the board into the position this step describes
 *
 * The decks are unshuffled and stacked 1-18, exactly as the starter set tells
 * you to set them up, so every draw below is simply the next card off the top.
 */

const R = 'radiant';
const O = 'onyx';

const card = (side, id) => `${side}.card.${id}`;
const zone = (side, name) => `${side}.zone.${name}`;
const stat = (side, name) => `${side}.stat.${name}`;

/** @type {Array<Object>} */
export const TutorialSteps = [
    // ---------------------------------------------------------------- intro
    {
        chapter: 'Welcome',
        title: 'Welcome to the Crucible',
        body: [
            'KeyForge is a two-player card game. Each player is an **Archon** — a being who leads a team of followers gathered from across the Crucible, an artificial world built out of pieces of countless civilisations.',
            'This tutorial walks you through a complete game, one action at a time. Nothing is assumed: every rule is explained the first time it matters, and the board on the right always shows the real position after the step you are reading.'
        ],
        platform:
            'You can stop and come back at any time — Archon Arena remembers which step you reached.'
    },
    {
        chapter: 'Welcome',
        title: 'How you win',
        body: [
            'Players compete to gather a precious resource called **Æmber** ({A}). When you have gathered enough Æmber, you **forge a key**.',
            'The first player to forge **three keys** unlocks a Vault and wins the game. That is the whole race — everything else in the game exists to speed you up or slow your opponent down.'
        ],
        rule: 'A key costs 6{A} by default. The first player to forge three keys wins.',
        highlight: [stat(R, 'keys'), stat(O, 'keys')]
    },
    {
        chapter: 'Welcome',
        title: 'The two learning decks',
        body: [
            'This tutorial uses the two decks that come in the KeyForge two-player starter set: the **Radiant Learning Deck** and the **Onyx Learning Deck**. You will play as Radiant; Onyx is your opponent.',
            'Each deck has 18 cards, split evenly between three **houses**. Radiant plays Mars, Sanctum and Star Alliance. Onyx plays Brobnar, Ekwidon and Unfathomable.',
            'Each learning deck is 20 cards in the box: the 18 you play with, the identity card, and a chain tracker. Chains are a handicap mechanic used in competitive play — the starter set leaves them out, and so does this tutorial.',
            'A real KeyForge deck is 36 cards and is unique — no two decks in the world are the same. The learning decks are half-size and fixed, which is what makes a scripted walkthrough like this one possible.'
        ],
        highlight: [stat(R, 'identity'), stat(O, 'identity')]
    },
    {
        chapter: 'Welcome',
        title: 'The identity card',
        body: [
            'Each deck has an **identity card** naming the Archon and showing its three houses. It sits at the edge of your play area for the whole game as a reminder of which houses you can choose from.',
            'Look at the three house symbols on each identity card. Those are the only houses that deck will ever play.'
        ],
        rule: 'Your deck contains cards from exactly three houses, and they are printed on your identity card.',
        highlight: [stat(R, 'identity'), stat(O, 'identity'), stat(R, 'houses'), stat(O, 'houses')],
        platform:
            'On Archon Arena the identity card sits in your stats bar, and the three house symbols next to it are buttons — that is where you will pick your house each turn.'
    },

    // ---------------------------------------------------------------- setup
    {
        chapter: 'Setup',
        title: 'Stack the decks',
        body: [
            'Normally both players shuffle. For this tutorial the decks are stacked in numbered order instead: the learning-deck cards are numbered 1 to 18 in their top-right corner, and they are arranged so that card 1 is drawn first, card 2 second, and so on.',
            'That is why this walkthrough can promise what you will draw. Every card that reaches a hand in this tutorial came off the top of one of these two stacks.'
        ],
        highlight: [zone(R, 'deck'), zone(O, 'deck')],
        apply: (s) => {
            s.players[R].deck = RadiantDeck.cards.slice();
            s.players[O].deck = OnyxDeck.cards.slice();
            note(s, 'Both learning decks are stacked in order, 1 through 18');
        }
    },
    {
        chapter: 'Setup',
        title: 'Keys and the common supply',
        body: [
            'Each player takes three key tokens — red, blue and yellow — and places them **unforged** side up. Those are the three keys you are racing to forge.',
            'All the other tokens (Æmber, damage, stun, ward and so on) go into a shared pile called the **common supply**. When a card tells you to gain Æmber, that Æmber comes from the common supply, not from your opponent.'
        ],
        rule: 'Gaining Æmber takes it from the common supply. Stealing or capturing takes it from your opponent.',
        highlight: [stat(R, 'keys'), stat(O, 'keys'), stat(R, 'amber'), stat(O, 'amber')]
    },
    {
        chapter: 'Setup',
        title: 'Opening hands',
        body: [
            'The first player is normally chosen at random. In this tutorial **Radiant goes first**.',
            'The first player draws **seven** cards; the second player draws **six**. Radiant’s extra card balances the fact that on the very first turn they are allowed to play only one card.'
        ],
        rule: 'Hand size is 6. The first player begins with 7 cards; the second player begins with 6.',
        highlight: [zone(R, 'hand'), zone(O, 'hand')],
        apply: (s) => {
            draw(s, R, 7);
            draw(s, O, 6);
            note(s, 'Radiant draws 7 cards; Onyx draws 6 cards');
        }
    },
    {
        chapter: 'Setup',
        title: 'The five steps of a turn',
        body: [
            'Players alternate turns until someone wins. Every turn runs through the same five steps, always in this order:',
            '**1 Forge a key** — if you have enough Æmber, you must forge.\n**2 Choose a house** — pick one of your three houses for the turn.\n**3 Play, discard and use cards** — of that house only.\n**4 Ready cards** — turn your used cards upright again.\n**5 Draw cards** — refill your hand to six.',
            'The strip above the board tracks which of the five steps is happening; it lights up as soon as the first turn begins. Watch it as you click through — the order never changes.'
        ],
        highlight: ['turnsteps']
    },

    // --------------------------------------------------------------- turn 1
    {
        chapter: 'Turn 1 · Radiant',
        title: 'Step 1 — can you forge?',
        body: [
            'Radiant starts the game. The first thing you do on every turn is check whether you can forge a key.',
            'A key costs **6{A}** and Radiant has **0{A}**, so no key is forged. Note that forging is not optional: if you begin your turn with enough Æmber, you *must* spend it.'
        ],
        rule: 'At the start of your turn, if you have at least the key cost in Æmber, you must forge a key.',
        highlight: [stat(R, 'amber'), stat(R, 'keyCost'), 'turnsteps'],
        apply: (s) => beginTurn(s, R, 1)
    },
    {
        chapter: 'Turn 1 · Radiant',
        title: 'Step 2 — choose a house',
        body: [
            'Now Radiant picks one of the three houses on their identity card. That house is **active** for the rest of the turn.',
            'The active house decides everything you may do this turn: you can only play, discard and use cards of that house. Radiant declares **house Mars**.',
            'This one decision is the heart of KeyForge. A card of the wrong house is simply unavailable to you this turn, however good it is.'
        ],
        rule: 'You may only play, use or discard cards belonging to your active house.',
        highlight: [stat(R, 'houses'), 'turnsteps'],
        platform:
            'On Archon Arena a house-picker appears in the middle of the board at the start of your turn; you can also click the house symbols beside your identity card.',
        apply: (s) => chooseHouse(s, R, 'mars')
    },
    {
        chapter: 'Turn 1 · Radiant',
        title: 'Step 3 — the first-turn limit',
        body: [
            'On the very first turn of the game the starting player may play or discard only **one** card. From the second turn onward, players may play, use and discard as many cards of their active house as they like, in any order.',
            'Radiant plays the Mars artifact **Incubation Chamber**.'
        ],
        rule: 'On the first turn of the game, the starting player may play or discard only one card.',
        highlight: [card(R, 'incubation-chamber'), 'turnsteps'],
        apply: (s) => play(s, R, 'incubation-chamber')
    },
    {
        chapter: 'Turn 1 · Radiant',
        title: 'Artifacts and the artifact row',
        body: [
            'Artifacts enter play **exhausted** — sideways — and sit in their own row behind the creatures. They stay in play from turn to turn until something removes them.',
            'A card being exhausted means it has already been used and cannot be used again until it readies. Because Incubation Chamber entered play exhausted, Radiant cannot use its ability this turn.',
            'On the board an exhausted card is drawn turned on its side, exactly as you would turn it on a table. Whenever you need to read one, the copy in the panel below is always upright — and hovering or tapping any card on the board brings it up there.'
        ],
        rule: 'Creatures and artifacts enter play exhausted, and an exhausted card cannot be used.',
        highlight: [card(R, 'incubation-chamber'), zone(R, 'artifacts')]
    },
    {
        chapter: 'Turn 1 · Radiant',
        title: 'Step 4 — ready cards',
        body: [
            'With nothing else to do, Radiant moves to step 4 and readies their cards: every exhausted card they control turns upright again.',
            'This is why a creature you play this turn becomes useful next turn.'
        ],
        highlight: [card(R, 'incubation-chamber'), 'turnsteps'],
        apply: (s) => readyAll(s, R)
    },
    {
        chapter: 'Turn 1 · Radiant',
        title: 'Step 5 — draw cards',
        body: [
            'Finally Radiant draws back up to six cards. They played one card from a hand of seven, so they already have six and draw nothing.',
            'That is a whole turn. Play passes to Onyx.'
        ],
        rule: 'At the end of your turn, draw until you have six cards in hand.',
        highlight: [zone(R, 'hand'), 'turnsteps'],
        apply: (s) => drawToHandSize(s, R)
    },

    // --------------------------------------------------------------- turn 2
    {
        chapter: 'Turn 2 · Onyx',
        title: 'Onyx takes a turn',
        body: [
            'Onyx has no Æmber, so no key is forged, and they declare **house Brobnar** as their active house.',
            'Onyx is not restricted to one card — the first-turn limit only applies to the player who went first, on the first turn.'
        ],
        highlight: [stat(O, 'amber'), stat(O, 'houses'), 'turnsteps'],
        apply: (s) => {
            beginTurn(s, O, 2);
            chooseHouse(s, O, 'brobnar');
        }
    },
    {
        chapter: 'Turn 2 · Onyx',
        title: 'Creatures and the battleline',
        body: [
            'Onyx plays two Brobnar creatures, **Headhunter** and **Valdr**. Creatures are placed exhausted into a row called your **battleline**.',
            'Creatures are your board presence: they gather Æmber for you, they fight, and many of them have abilities. Like artifacts, they stay in play until they are destroyed.'
        ],
        highlight: [card(O, 'headhunter'), card(O, 'valdr'), zone(O, 'creatures')],
        apply: (s) => {
            play(s, O, 'headhunter');
            play(s, O, 'valdr');
        }
    },
    {
        chapter: 'Turn 2 · Onyx',
        title: 'An artifact for Onyx',
        body: [
            'Onyx also plays the artifact **Gauntlet of Command**, exhausted, below their battleline.',
            'Read its text: *Action: Ready and fight with a friendly creature.* An **Action:** ability on a card in play is used by exhausting that card — which means Onyx can use the Gauntlet once per turn, starting next turn.'
        ],
        highlight: [card(O, 'gauntlet-of-command'), zone(O, 'artifacts')],
        apply: (s) => play(s, O, 'gauntlet-of-command')
    },
    {
        chapter: 'Turn 2 · Onyx',
        title: 'Ready, then draw',
        body: [
            'Onyx readies their cards — the two creatures and the artifact turn upright — and then draws back up to six, taking three cards from the top of their deck.',
            'Onyx’s turn is over. Play returns to Radiant.'
        ],
        highlight: [zone(O, 'hand'), 'turnsteps'],
        apply: (s) => {
            readyAll(s, O);
            drawToHandSize(s, O);
        }
    },

    // --------------------------------------------------------------- turn 3
    {
        chapter: 'Turn 3 · Radiant',
        title: 'Radiant declares Sanctum',
        body: [
            'Radiant still has no Æmber, so no key is forged. This time they declare **house Sanctum**.',
            'Their Incubation Chamber is a Mars card, so normally it would be off-limits this turn. But it has an ability that ignores that.'
        ],
        highlight: [stat(R, 'houses'), 'turnsteps'],
        apply: (s) => {
            beginTurn(s, R, 3);
            chooseHouse(s, R, 'sanctum');
        }
    },
    {
        chapter: 'Turn 3 · Radiant',
        title: 'Omni: the exception to the house rule',
        body: [
            'Incubation Chamber reads *Omni: You may reveal a Mars creature from your hand. If you do, archive it.*',
            'An **Omni** ability can be used on your turn even if the card does not belong to your active house. It is the one clean exception to "only your active house".',
            'Radiant uses it, reveals the Mars creature **Yxl the Iron Captain** from hand, and archives it.'
        ],
        rule: 'Omni abilities can be used on your turn regardless of your active house. Action abilities cannot.',
        highlight: [card(R, 'incubation-chamber'), card(R, 'yxl-the-iron-captain')],
        apply: (s) => {
            activate(s, R, 'incubation-chamber', 'archive a Mars creature');
            archiveFromHand(s, R, 'yxl-the-iron-captain');
        }
    },
    {
        chapter: 'Turn 3 · Radiant',
        title: 'The archives',
        body: [
            'Archived cards go face down, out of play, next to your discard pile. They are not in your hand and cannot be played from the archives.',
            'At the start of a later turn you may take **all** the cards in your archives into your hand at once. Archiving is how you save a card for the turn you need it — and how you get a hand larger than six.'
        ],
        rule: 'During step 2 of your turn, you may put all cards in your archives into your hand.',
        highlight: [zone(R, 'archives')]
    },
    {
        chapter: 'Turn 3 · Radiant',
        title: 'Reading a creature card',
        body: [
            'Radiant plays the Sanctum creature **Champion Anaphiel**. It enters play exhausted, so on the board it is lying on its side; read it from the upright copy in the panel below.',
            'The number in a creature’s bottom-left corner is its **power** (6 here) — how much damage it deals and how much it can take. The shield in the bottom-right corner is **armor** (1), which prevents that much incoming damage each turn.',
            '**Taunt** on its card means its neighbours in the battleline cannot be attacked while it is there.'
        ],
        rule: 'Power is both a creature’s damage and its health. Armor prevents that much damage each turn.',
        highlight: [card(R, 'champion-anaphiel')],
        apply: (s) => play(s, R, 'champion-anaphiel')
    },
    {
        chapter: 'Turn 3 · Radiant',
        title: 'Play abilities',
        body: [
            'Radiant’s other Sanctum card is **Sergeant Zakiel**, played exhausted into the battleline next to Champion Anaphiel.',
            'Zakiel reads *Play: You may ready and fight with a neighboring creature.* A **Play:** ability resolves as soon as the card enters play — it is a one-off bonus for playing the card, separate from anything the card does later.'
        ],
        rule: 'Play: abilities resolve immediately after the card enters play.',
        highlight: [card(R, 'sergeant-zakiel')],
        apply: (s) => play(s, R, 'sergeant-zakiel')
    },
    {
        chapter: 'Turn 3 · Radiant',
        title: 'Readying Champion Anaphiel',
        body: [
            'Champion Anaphiel is a neighbour of Sergeant Zakiel, so Zakiel’s Play ability readies it. A readied creature can be used, even though it only just arrived.',
            'This is a common trick: a creature normally does nothing on the turn you play it, and cards like Zakiel break that rule.'
        ],
        highlight: [card(R, 'champion-anaphiel'), card(R, 'sergeant-zakiel')],
        apply: (s) => {
            ready(s, R, 'champion-anaphiel');
            note(s, 'Champion Anaphiel is readied by Sergeant Zakiel');
        }
    },
    {
        chapter: 'Turn 3 · Radiant',
        title: 'Fighting',
        body: [
            'Sergeant Zakiel’s ability finishes by letting that readied creature fight. To **fight**, exhaust a ready creature and pick one enemy creature to attack. Both creatures deal damage equal to their power **at the same time** — so even a creature that dies still hits back.',
            'Radiant attacks **Headhunter** with Champion Anaphiel. Anaphiel deals 6 damage to Headhunter, whose power is 5, so Headhunter is destroyed and goes on top of Onyx’s discard pile.',
            'Headhunter simultaneously deals 5 damage back. Anaphiel has 1 armor, so it takes 4 — damage counters that stay on it until something heals them.'
        ],
        rule: 'A creature is destroyed when the damage on it is equal to or greater than its power.',
        highlight: [card(R, 'champion-anaphiel'), card(O, 'headhunter')],
        platform:
            'On Archon Arena you fight by clicking your ready creature and choosing "Fight" from the menu, then clicking the enemy creature. Damage, armor and destruction are worked out for you.',
        apply: (s) => fight(s, R, 'champion-anaphiel', 'headhunter')
    },
    {
        chapter: 'Turn 3 · Radiant',
        title: 'End of turn',
        body: [
            'Radiant has no more Sanctum cards to play, use or discard, so they ready their cards and draw back up to six.',
            'Notice the hand refills to exactly six every turn, no matter how many cards you spent. Emptying your hand is not a cost in KeyForge — it is usually correct.'
        ],
        highlight: [zone(R, 'hand'), 'turnsteps'],
        apply: (s) => {
            readyAll(s, R);
            drawToHandSize(s, R);
        }
    },

    // --------------------------------------------------------------- turn 4
    {
        chapter: 'Turn 4 · Onyx',
        title: 'Onyx declares Ekwidon',
        body: [
            'Key cost is still 6{A} and Onyx has none, so they move to step 2 and declare **house Ekwidon**.'
        ],
        highlight: [stat(O, 'houses'), 'turnsteps'],
        apply: (s) => {
            beginTurn(s, O, 4);
            chooseHouse(s, O, 'ekwidon');
        }
    },
    {
        chapter: 'Turn 4 · Onyx',
        title: 'Flanks',
        body: [
            'Onyx plays the Ekwidon creatures **Gemcoat Vendor** and **The Old Tinker**, exhausted, into the battleline.',
            'The two outside edges of a battleline are called the **flanks**. A new creature always enters play on a flank of your choice, and the battleline grows outward. Where you put a creature matters, because abilities that care about neighbours — and creatures that attack the flank — read the line as it stands.'
        ],
        rule: 'A creature enters play on either flank of your battleline, unless it has deploy.',
        highlight: [card(O, 'gemcoat-vendor'), card(O, 'the-old-tinker'), zone(O, 'creatures')],
        apply: (s) => {
            play(s, O, 'gemcoat-vendor');
            play(s, O, 'the-old-tinker');
        }
    },
    {
        chapter: 'Turn 4 · Onyx',
        title: 'Bonus icons',
        body: [
            'Onyx plays the Ekwidon action card **Forced Retirement**. Look at its top-left corner, below the house symbol: this copy has two **bonus icons**, a capture {C} and a draw {R}.',
            'When you play a card with bonus icons you resolve each icon from top to bottom, one at a time, *before* the card’s own ability. Resolving them is mandatory.'
        ],
        rule: 'Bonus icons resolve from top to bottom as the card is played, before its Play ability.',
        highlight: [card(O, 'forced-retirement')],
        apply: (s) => play(s, O, 'forced-retirement')
    },
    {
        chapter: 'Turn 4 · Onyx',
        title: 'The capture bonus does nothing',
        body: [
            'The capture bonus would move 1{A} from Radiant’s pool onto one of Onyx’s creatures. Radiant’s pool is empty, so nothing happens.',
            'This is a rule worth learning early: **resolve as much of an ability as you can and ignore the rest**. An ability that cannot do anything is not a failure — it simply does nothing.'
        ],
        rule: 'Resolve as much of an ability as possible; ignore the parts that cannot be resolved.',
        highlight: [stat(R, 'amber'), card(O, 'forced-retirement')],
        apply: (s) =>
            note(s, 'Forced Retirement’s capture bonus does nothing — Radiant’s pool is empty')
    },
    {
        chapter: 'Turn 4 · Onyx',
        title: 'The draw bonus',
        body: [
            'The draw bonus lets Onyx draw one card from the top of their deck. They draw card number 10, the Unfathomable creature **Kaupe**.',
            'Note it is drawn into hand, not played — and because it is Unfathomable, not Ekwidon, Onyx cannot play it this turn.'
        ],
        highlight: [card(O, 'kaupe'), zone(O, 'deck')],
        apply: (s) => {
            draw(s, O, 1);
            note(s, 'Onyx draws Kaupe from the draw bonus');
        }
    },
    {
        chapter: 'Turn 4 · Onyx',
        title: 'Forced Retirement resolves',
        body: [
            'Now the card’s own ability: *Play: Destroy a creature. If you do, its controller gains 1{A}.*',
            'Onyx destroys **Champion Anaphiel** — the 6-power blocker in Radiant’s way. Because Radiant controls it, Radiant gains 1{A}. Anaphiel goes to Radiant’s discard pile, and Forced Retirement, having done its job, goes to Onyx’s discard pile.',
            'Action cards work like this: play them, resolve them, discard them. They never stay in play.'
        ],
        rule: 'An action card is discarded as soon as it finishes resolving.',
        highlight: [card(R, 'champion-anaphiel'), stat(R, 'amber')],
        apply: (s) => {
            destroyCreature(s, R, 'champion-anaphiel');
            gainAmber(s, R, 1, 'Forced Retirement');
            finishAction(s, O, 'forced-retirement');
        }
    },
    {
        chapter: 'Turn 4 · Onyx',
        title: 'End of turn',
        body: [
            'Onyx has nothing else to play, use or discard, so they ready their cards and draw back up to six.'
        ],
        highlight: ['turnsteps'],
        apply: (s) => {
            readyAll(s, O);
            drawToHandSize(s, O);
        }
    },

    // --------------------------------------------------------------- turn 5
    {
        chapter: 'Turn 5 · Radiant',
        title: 'One Æmber is not enough',
        body: [
            'Radiant begins with 1{A} in their pool. A key costs 6{A}, so no key is forged. They declare **house Star Alliance**.'
        ],
        highlight: [stat(R, 'amber'), stat(R, 'keyCost'), 'turnsteps'],
        apply: (s) => {
            beginTurn(s, R, 5);
            chooseHouse(s, R, 'staralliance');
        }
    },
    {
        chapter: 'Turn 5 · Radiant',
        title: 'Archiving again',
        body: [
            'Incubation Chamber’s Omni ability works no matter which house is active, so Radiant uses it again and archives their Mars card **Ironyx Rebel**.',
            'Radiant now has two cards waiting in the archives. Both are Mars cards, saved for a Mars turn.'
        ],
        highlight: [card(R, 'incubation-chamber'), zone(R, 'archives')],
        apply: (s) => {
            activate(s, R, 'incubation-chamber', 'archive a Mars creature');
            archiveFromHand(s, R, 'ironyx-rebel');
        }
    },
    {
        chapter: 'Turn 5 · Radiant',
        title: 'Upgrades',
        body: [
            'Radiant plays the upgrade **Badge of Unity**. An upgrade is not played on its own — you attach it to a creature by tucking it partly underneath, and it stays there modifying that creature.',
            'Badge of Unity reads *This creature belongs to house Star Alliance in addition to its other houses.* Radiant attaches it to **Sergeant Zakiel**, who is Sanctum. Zakiel is now both Sanctum and Star Alliance — so he can be used on Star Alliance turns as well.'
        ],
        rule: 'An upgrade attaches to a creature and stays in play, modifying it, until the creature leaves play.',
        highlight: [card(R, 'badge-of-unity'), card(R, 'sergeant-zakiel')],
        apply: (s) =>
            play(s, R, 'badge-of-unity', { attachTo: { side: R, cardId: 'sergeant-zakiel' } })
    },
    {
        chapter: 'Turn 5 · Radiant',
        title: 'Reaping',
        body: [
            'A ready creature of your active house can do one of three things: **fight**, **reap**, or **use** an Action or Omni ability printed on it.',
            'To **reap**, exhaust the creature and take 1{A} from the common supply. That is the main way Æmber enters the game, and it is how most keys get forged.',
            'Radiant reaps with **Sergeant Zakiel** — legal because Badge of Unity made him Star Alliance — and goes to 2{A}.'
        ],
        rule: 'Reap: exhaust a ready creature of your active house to gain 1{A}.',
        highlight: [card(R, 'sergeant-zakiel'), stat(R, 'amber')],
        platform:
            'On Archon Arena, clicking a ready creature on your turn opens a menu with Fight, Reap and Use. Cards you cannot use are dimmed.',
        apply: (s) => reap(s, R, 'sergeant-zakiel')
    },
    {
        chapter: 'Turn 5 · Radiant',
        title: 'Two more creatures',
        body: [
            'Radiant plays **Commander Chan** and **Medic Ingram** into the battleline, both exhausted.',
            'Medic Ingram has a triple trigger: *Play/After Fight/After Reap: You may heal 3 damage from a creature and ward it.* The Play part fires now.'
        ],
        highlight: [card(R, 'commander-chan'), card(R, 'medic-ingram')],
        apply: (s) => {
            play(s, R, 'commander-chan');
            play(s, R, 'medic-ingram');
        }
    },
    {
        chapter: 'Turn 5 · Radiant',
        title: 'Warding',
        body: [
            'No creature has damage on it, so the healing part of Medic Ingram’s ability does nothing — resolve what you can, ignore the rest — but the ward still happens.',
            'A **warded** creature gets a ward counter. The next time it would take damage, be destroyed, or leave play, the ward counter is removed instead and nothing else happens. It is a single-use shield against anything.',
            'Radiant wards **Commander Chan**.'
        ],
        rule: 'Ward: the next time this creature would take damage, be destroyed or leave play, remove the ward instead.',
        highlight: [card(R, 'commander-chan'), card(R, 'medic-ingram')],
        apply: (s) => wardCard(s, R, 'commander-chan')
    },
    {
        chapter: 'Turn 5 · Radiant',
        title: 'End of turn',
        body: ['Radiant readies their cards and draws back up to six.'],
        highlight: ['turnsteps'],
        apply: (s) => {
            readyAll(s, R);
            drawToHandSize(s, R);
        }
    },

    // --------------------------------------------------------------- turn 6
    {
        chapter: 'Turn 6 · Onyx',
        title: 'Onyx declares Unfathomable',
        body: [
            'Onyx still has no Æmber. They declare **house Unfathomable** and play the creature **Wikolia**, exhausted, into the battleline.'
        ],
        highlight: [stat(O, 'houses'), card(O, 'wikolia'), 'turnsteps'],
        apply: (s) => {
            beginTurn(s, O, 6);
            chooseHouse(s, O, 'unfathomable');
            play(s, O, 'wikolia');
        }
    },
    {
        chapter: 'Turn 6 · Onyx',
        title: 'Discarding on purpose',
        body: [
            'Onyx chooses to **discard** their Unfathomable action **Adult Swim** straight from hand, without playing it.',
            'Discarding is a normal thing to do on your turn with cards of your active house. You would do it with a card that does nothing useful right now, because at the end of the turn you refill to six anyway — a dead card thrown away is a fresh card drawn.'
        ],
        rule: 'On your turn you may discard any number of cards of your active house from your hand.',
        highlight: [card(O, 'adult-swim'), zone(O, 'discard')],
        apply: (s) => discardFromHand(s, O, 'adult-swim')
    },
    {
        chapter: 'Turn 6 · Onyx',
        title: 'An Æmber bonus icon',
        body: [
            'Onyx plays **Kaupe** to the battleline, then the artifact **Frigorific Rod**, both exhausted.',
            'Frigorific Rod has an Æmber bonus icon {A} printed on it, so playing it gains Onyx 1{A} from the common supply. Æmber bonus icons are the other main source of Æmber besides reaping, and they are free — you get them just for playing the card.'
        ],
        highlight: [card(O, 'kaupe'), card(O, 'frigorific-rod'), stat(O, 'amber')],
        apply: (s) => {
            play(s, O, 'kaupe');
            play(s, O, 'frigorific-rod');
            gainAmber(s, O, 1, 'Frigorific Rod’s Æmber bonus');
        }
    },
    {
        chapter: 'Turn 6 · Onyx',
        title: 'An upgrade on an enemy creature',
        body: [
            'Onyx plays the upgrade **Weak Link** — onto Radiant’s **Commander Chan**. Upgrades are not only for your own creatures.',
            'Weak Link reads *This creature gains, "While this creature is exhausted, your keys cost +6{A}."* Whenever Radiant exhausts Commander Chan, Radiant’s keys become far more expensive.',
            'Weak Link also has an Æmber bonus icon, so Onyx gains another 1{A}.'
        ],
        highlight: [card(O, 'weak-link'), card(R, 'commander-chan'), stat(R, 'keyCost')],
        apply: (s) => {
            play(s, O, 'weak-link', { attachTo: { side: R, cardId: 'commander-chan' } });
            gainAmber(s, O, 1, 'Weak Link’s Æmber bonus');
        }
    },
    {
        chapter: 'Turn 6 · Onyx',
        title: 'End of turn',
        body: [
            'Onyx readies their cards and draws back up to six — five cards this time, since their hand is nearly empty.'
        ],
        highlight: [zone(O, 'hand'), 'turnsteps'],
        apply: (s) => {
            readyAll(s, O);
            drawToHandSize(s, O);
        }
    },

    // --------------------------------------------------------------- turn 7
    {
        chapter: 'Turn 7 · Radiant',
        title: 'Clearing the way',
        body: [
            'Radiant has 2{A} — still short of a key — and declares **house Sanctum**.',
            'First, a fight. **Sergeant Zakiel** (power 4, armor 1) attacks **Kaupe** (power 2). Zakiel destroys it and takes 2 damage back, reduced to 1 by his armor.'
        ],
        highlight: [card(R, 'sergeant-zakiel'), card(O, 'kaupe'), 'turnsteps'],
        apply: (s) => {
            beginTurn(s, R, 7);
            chooseHouse(s, R, 'sanctum');
            fight(s, R, 'sergeant-zakiel', 'kaupe');
        }
    },
    {
        chapter: 'Turn 7 · Radiant',
        title: 'Why that fight came first',
        body: [
            'Kaupe read *Your opponent cannot play more than 1 card of each card type each turn.* With it in play Radiant could have played only one creature this turn.',
            'Killing it first unlocks the rest of the turn. Ordering your actions inside step 3 is a real skill: you may play, use and discard in any order you like.'
        ],
        rule: 'Within step 3 you may play, use and discard cards in any order.',
        highlight: [zone(O, 'discard')]
    },
    {
        chapter: 'Turn 7 · Radiant',
        title: 'Protect the Weak',
        body: [
            'Radiant plays the upgrade **Protect the Weak** onto **Commander Chan**, gaining 1{A} from its Æmber bonus icon.',
            'It gives Chan +1 armor and **taunt** — so Chan’s neighbours in the battleline cannot be attacked at all while Chan stands there. Taunt is how you protect the small, valuable creatures beside a big one.'
        ],
        rule: 'Taunt: this creature’s neighbours cannot be attacked unless they also have taunt.',
        highlight: [card(R, 'protect-the-weak'), card(R, 'commander-chan'), stat(R, 'amber')],
        apply: (s) => {
            play(s, R, 'protect-the-weak', { attachTo: { side: R, cardId: 'commander-chan' } });
            gainAmber(s, R, 1, 'Protect the Weak’s Æmber bonus');
        }
    },
    {
        chapter: 'Turn 7 · Radiant',
        title: 'Gorm of Omm',
        body: [
            'Radiant plays the artifact **Gorm of Omm** exhausted, next to Incubation Chamber.',
            'It reads *Omni: Destroy Gorm of Omm. Destroy an artifact.* Some cards pay for themselves — this one removes an enemy artifact at the cost of its own life, and being Omni it can do so on any turn.'
        ],
        highlight: [card(R, 'gorm-of-omm'), zone(R, 'artifacts')],
        apply: (s) => play(s, R, 'gorm-of-omm')
    },
    {
        chapter: 'Turn 7 · Radiant',
        title: 'Capture',
        body: [
            'Radiant plays **Mother Northelle**, then **Raiding Knight**, both exhausted onto the left flank.',
            'Raiding Knight reads *Play: Capture 1{A}.* **Capture** moves Æmber from your opponent’s pool onto this creature. It is not yours yet — it sits on the creature, out of everyone’s reach, and if the creature leaves play it goes straight back to your opponent.',
            'Onyx drops from 2{A} to 1{A}, and one Æmber now sits on Raiding Knight.'
        ],
        rule: 'Captured Æmber sits on a creature. If that creature leaves play, the Æmber returns to its owner’s pool.',
        highlight: [card(R, 'mother-northelle'), card(R, 'raiding-knight'), stat(O, 'amber')],
        apply: (s) => {
            play(s, R, 'mother-northelle', { flank: 'left' });
            play(s, R, 'raiding-knight', { flank: 'left' });
            capture(s, R, 'raiding-knight', 1);
        }
    },
    {
        chapter: 'Turn 7 · Radiant',
        title: 'The deck runs out',
        body: [
            'Radiant readies and draws back up to six — and that empties their deck. There is nothing wrong with this: when you next need to draw and your deck is gone, you shuffle your discard pile to make a new one.',
            'Your discard pile is not a graveyard in KeyForge. It is the rest of your deck, waiting.'
        ],
        rule: 'When you must draw with an empty deck, shuffle your discard pile to form a new deck.',
        highlight: [zone(R, 'deck'), zone(R, 'hand'), 'turnsteps'],
        apply: (s) => {
            readyAll(s, R);
            drawToHandSize(s, R);
        }
    },

    // --------------------------------------------------------------- turn 8
    {
        chapter: 'Turn 8 · Onyx',
        title: 'Onyx goes to work',
        body: [
            'Onyx has 1{A} and declares **house Ekwidon** — the house of every creature they need this turn.'
        ],
        highlight: [stat(O, 'houses'), 'turnsteps'],
        apply: (s) => {
            beginTurn(s, O, 8);
            chooseHouse(s, O, 'ekwidon');
        }
    },
    {
        chapter: 'Turn 8 · Onyx',
        title: 'Using an Action ability — and stealing',
        body: [
            'Onyx exhausts **Gemcoat Vendor** to use its Action ability: *Steal 1{A}. Deal 1 damage to Gemcoat Vendor.*',
            '**Steal** takes Æmber from your opponent’s pool straight into yours — unlike capture, it is immediately yours. Radiant goes to 2{A}, Onyx to 2{A}, and Gemcoat Vendor takes 1 damage from its own ability.',
            'Remember that 1 damage. It matters three turns from now.'
        ],
        rule: 'Steal moves Æmber from your opponent’s pool into yours. Capture moves it onto a creature.',
        highlight: [card(O, 'gemcoat-vendor'), stat(R, 'amber'), stat(O, 'amber')],
        apply: (s) => {
            activate(s, O, 'gemcoat-vendor', 'steal 1 Æmber');
            stealAmber(s, O, 1);
            dealDamage(s, O, 'gemcoat-vendor', 1);
        }
    },
    {
        chapter: 'Turn 8 · Onyx',
        title: 'After Reap abilities',
        body: [
            'Onyx reaps with **The Old Tinker**, gaining 1{A}. Its *After Reap: Discard a card from your hand. Draw a card.* then triggers.',
            'Onyx discards **Uncommon Currency** and draws **Kelpminder** — which empties their deck too. Both players are now playing out of their discard piles.'
        ],
        highlight: [card(O, 'the-old-tinker'), zone(O, 'deck')],
        apply: (s) => {
            reap(s, O, 'the-old-tinker');
            discardFromHand(s, O, 'uncommon-currency');
            draw(s, O, 1);
            note(s, 'Onyx draws Kelpminder — their deck is now empty');
        }
    },
    {
        chapter: 'Turn 8 · Onyx',
        title: 'Reshuffling',
        body: [
            'Onyx plays **Transitory Philosopher**, which has a draw bonus icon {R}. Their deck is empty, so they shuffle their discard pile into a new deck and draw from it.',
            'The card that comes up is card 6, **Forced Retirement** — the action that killed Champion Anaphiel back on turn 4. Cards come back around; that is why discarding a card is not the same as losing it.'
        ],
        highlight: [card(O, 'transitory-philosopher'), zone(O, 'deck'), zone(O, 'discard')],
        apply: (s) => {
            play(s, O, 'transitory-philosopher');
            reshuffle(s, O, [
                'forced-retirement',
                'headhunter',
                'adult-swim',
                'kaupe',
                'uncommon-currency'
            ]);
            draw(s, O, 1);
            note(s, 'Onyx draws Forced Retirement');
        }
    },
    {
        chapter: 'Turn 8 · Onyx',
        title: 'Forced Retirement, again',
        body: [
            'Onyx plays it straight away. Bonus icons first, in order:',
            'The **capture** {C} bonus now has a target — Radiant has Æmber. Onyx takes 1{A} from Radiant and places it on **Valdr**. When an action card captures, you may choose any creature in your battleline to hold the Æmber.',
            'The **draw** {R} bonus draws them **Headhunter**.'
        ],
        highlight: [card(O, 'forced-retirement'), card(O, 'valdr'), stat(R, 'amber')],
        apply: (s) => {
            play(s, O, 'forced-retirement');
            capture(s, O, 'valdr', 1);
            draw(s, O, 1);
            note(s, 'Onyx draws Headhunter');
        }
    },
    {
        chapter: 'Turn 8 · Onyx',
        title: 'Æmber comes home',
        body: [
            'Now Forced Retirement’s own ability: destroy a creature, its controller gains 1{A}. Onyx destroys **Raiding Knight**, so Radiant gains 1{A}.',
            'Raiding Knight was holding 1 captured Æmber that came from Onyx. Because the creature left play, that Æmber goes back to **Onyx’s** pool — captured Æmber always returns to the player it was taken from.'
        ],
        highlight: [card(R, 'raiding-knight'), stat(R, 'amber'), stat(O, 'amber')],
        apply: (s) => {
            destroyCreature(s, R, 'raiding-knight');
            gainAmber(s, R, 1, 'Forced Retirement');
            finishAction(s, O, 'forced-retirement');
        }
    },
    {
        chapter: 'Turn 8 · Onyx',
        title: 'A creature that enters ready',
        body: [
            'Onyx plays **Belligerent Guard**, which reads *Belligerent Guard enters play ready.* — so it can be used the same turn.',
            'Its *Play: Your opponent draws a card.* makes **Radiant** draw. Radiant’s deck is empty, so Radiant shuffles their discard pile into a new deck and draws **Champion Anaphiel** back into hand.',
            'Then Onyx reaps with Belligerent Guard for 1{A}.'
        ],
        highlight: [card(O, 'belligerent-guard'), zone(R, 'deck'), stat(O, 'amber')],
        apply: (s) => {
            play(s, O, 'belligerent-guard', { ready: true });
            reshuffle(s, R, ['champion-anaphiel', 'raiding-knight']);
            draw(s, R, 1);
            note(s, 'Radiant draws Champion Anaphiel');
            reap(s, O, 'belligerent-guard');
        }
    },
    {
        chapter: 'Turn 8 · Onyx',
        title: 'End of turn',
        body: [
            'Onyx readies everything and draws back up to six. Radiant is now holding seven cards — a card drawn on your opponent’s turn is a card you keep.'
        ],
        highlight: [zone(R, 'hand'), 'turnsteps'],
        apply: (s) => {
            readyAll(s, O);
            drawToHandSize(s, O);
        }
    },

    // --------------------------------------------------------------- turn 9
    {
        chapter: 'Turn 9 · Radiant',
        title: 'A Mars turn',
        body: [
            'Radiant has 2{A} and cannot forge. They declare **house Mars** — the house they have been stockpiling in the archives.'
        ],
        highlight: [stat(R, 'houses'), 'turnsteps'],
        apply: (s) => {
            beginTurn(s, R, 9);
            chooseHouse(s, R, 'mars');
        }
    },
    {
        chapter: 'Turn 9 · Radiant',
        title: 'Emptying the archives',
        body: [
            'During step 2, after choosing a house, you may take **all** the cards in your archives into your hand. Radiant takes both.',
            'They enter step 3 with **nine** cards in hand. This is the payoff for two turns of archiving, and it is the only way in KeyForge to hold more than six cards.'
        ],
        highlight: [zone(R, 'archives'), zone(R, 'hand')],
        apply: (s) => takeArchives(s, R)
    },
    {
        chapter: 'Turn 9 · Radiant',
        title: 'Trading an artifact for an artifact',
        body: [
            'Radiant uses **Gorm of Omm**’s Omni ability: destroy Gorm of Omm, then destroy an artifact. They point it at Onyx’s **Gauntlet of Command**.',
            'Both artifacts go to their owners’ discard piles. Gorm was Sanctum, not Mars — but Omni abilities ignore the active house.'
        ],
        highlight: [card(R, 'gorm-of-omm'), card(O, 'gauntlet-of-command')],
        apply: (s) => {
            activate(s, R, 'gorm-of-omm', 'destroy an artifact');
            destroyArtifact(s, R, 'gorm-of-omm');
            destroyArtifact(s, O, 'gauntlet-of-command');
        }
    },
    {
        chapter: 'Turn 9 · Radiant',
        title: 'Traits',
        body: [
            'Radiant plays **Yxl the Iron Captain**, whose *Play: Each friendly Ironyx creature captures 2{A}.* fires immediately.',
            'The italic words at the top of a creature’s text box are its **traits** — Martian, Ironyx, Knight, Giant. Traits have no rules of their own; they exist so that other cards can refer to them. Yxl itself has the Ironyx trait, so Yxl captures 2{A} from Onyx.'
        ],
        rule: 'Traits do nothing by themselves. They are labels other cards look for.',
        highlight: [card(R, 'yxl-the-iron-captain'), stat(O, 'amber')],
        apply: (s) => {
            play(s, R, 'yxl-the-iron-captain');
            capture(s, R, 'yxl-the-iron-captain', 2);
        }
    },
    {
        chapter: 'Turn 9 · Radiant',
        title: 'A constant ability',
        body: [
            'Radiant plays **Myx, the Tallminded**, exhausted. Its text has no trigger word at all: *Your opponent’s keys cost +1{A} for each friendly Mars creature in play.*',
            'An ability with no trigger is **constant** — it is simply true while the card is in play. Watch Onyx’s key cost climb as Radiant’s Mars creatures arrive.'
        ],
        rule: 'An ability with no Play/Action/Omni/After trigger is constant: it applies while the card is in play.',
        highlight: [card(R, 'myx-the-tallminded'), stat(O, 'keyCost')],
        apply: (s) => play(s, R, 'myx-the-tallminded')
    },
    {
        chapter: 'Turn 9 · Radiant',
        title: 'Deploy',
        body: [
            'Radiant plays **Ironyx Rebel**, which has **deploy**: instead of entering on a flank, it can be placed anywhere in the battleline. Radiant slots it in between Yxl and Myx.',
            'Its *Play: Ready each of Ironyx Rebel’s Mars neighbors.* then readies both Yxl and Myx — which is exactly why it was placed there. Both can now be used this turn.'
        ],
        rule: 'Deploy: this creature may enter play anywhere in your battleline, not only on a flank.',
        highlight: [
            card(R, 'ironyx-rebel'),
            card(R, 'yxl-the-iron-captain'),
            card(R, 'myx-the-tallminded')
        ],
        apply: (s) => {
            const line = s.players[R].creatures;
            const index = line.findIndex((c) => c.id === 'myx-the-tallminded');

            play(s, R, 'ironyx-rebel', { index });
            ready(s, R, 'yxl-the-iron-captain');
            ready(s, R, 'myx-the-tallminded');
            note(s, 'Ironyx Rebel readies its Mars neighbours');
        }
    },
    {
        chapter: 'Turn 9 · Radiant',
        title: 'One more creature',
        body: [
            'Radiant plays **Zysysyx Shockworm** to the battleline. Its *After an enemy creature reaps, stun it.* is a constant threat rather than something Radiant activates — it will punish Onyx for reaping on their next turn.'
        ],
        highlight: [card(R, 'zysysyx-shockworm')],
        apply: (s) => play(s, R, 'zysysyx-shockworm')
    },
    {
        chapter: 'Turn 9 · Radiant',
        title: 'Destroy Them All!',
        body: [
            'Radiant plays the action **Destroy Them All!**: *Destroy an artifact, a creature, and an upgrade.* One card, three answers.',
            'They destroy Onyx’s artifact **Frigorific Rod**, the creature **Valdr** — which returns the 1{A} captured on it to **Radiant’s** pool, because that Æmber was taken from Radiant — and the upgrade **Weak Link**, freeing Commander Chan.'
        ],
        highlight: [
            card(O, 'frigorific-rod'),
            card(O, 'valdr'),
            card(O, 'weak-link'),
            stat(R, 'amber')
        ],
        apply: (s) => {
            play(s, R, 'destroy-them-all');
            destroyArtifact(s, O, 'frigorific-rod');
            destroyCreature(s, O, 'valdr');
            destroyUpgrade(s, R, 'weak-link');
            finishAction(s, R, 'destroy-them-all');
        }
    },
    {
        chapter: 'Turn 9 · Radiant',
        title: 'Cashing in',
        body: [
            'Radiant reaps with **Yxl the Iron Captain** and **Myx, the Tallminded** — the two creatures Ironyx Rebel readied — gaining 1{A} each and reaching 5{A}.',
            'Then they ready up and draw two cards: **Raiding Knight** off the top, then a reshuffle and **Gorm of Omm**.'
        ],
        highlight: [
            card(R, 'yxl-the-iron-captain'),
            card(R, 'myx-the-tallminded'),
            stat(R, 'amber')
        ],
        apply: (s) => {
            reap(s, R, 'yxl-the-iron-captain');
            reap(s, R, 'myx-the-tallminded');
            readyAll(s, R);
            setPhase(s, 'Draw cards');
            draw(s, R, 1);
            reshuffle(s, R, ['gorm-of-omm', 'destroy-them-all']);
            draw(s, R, 1);
            note(s, 'Radiant draws Raiding Knight and Gorm of Omm');
        }
    },

    // -------------------------------------------------------------- turn 10
    {
        chapter: 'Turn 10 · Onyx',
        title: 'Keys just got expensive',
        body: [
            'Onyx has 3{A}, but look at their key cost. Myx, the Tallminded adds +1{A} for each of Radiant’s Mars creatures, and Radiant has four of them in play — so an Onyx key now costs **10{A}**.',
            'Onyx declares **house Brobnar** and starts rebuilding.'
        ],
        rule: 'Key cost is not fixed. Cards on either side of the table can raise it.',
        highlight: [stat(O, 'keyCost'), stat(O, 'amber'), card(R, 'myx-the-tallminded')],
        apply: (s) => {
            beginTurn(s, O, 10);
            chooseHouse(s, O, 'brobnar');
        }
    },
    {
        chapter: 'Turn 10 · Onyx',
        title: 'Headhunter returns',
        body: [
            'Onyx plays **Headhunter** — the same card Champion Anaphiel destroyed on turn 3, drawn again out of the reshuffled deck.'
        ],
        highlight: [card(O, 'headhunter')],
        apply: (s) => play(s, O, 'headhunter')
    },
    {
        chapter: 'Turn 10 · Onyx',
        title: 'Making a monster',
        body: [
            'Onyx attaches the upgrade **Blood of Titans** to Headhunter: *This creature gets +5 power.* Headhunter goes from 5 power to **10**.',
            'Blood of Titans has an Æmber bonus icon too, so Onyx gains 1{A}.',
            'A 10-power creature is now the biggest thing on the table by a distance, and Radiant has nothing that can trade with it.'
        ],
        highlight: [card(O, 'blood-of-titans'), card(O, 'headhunter'), stat(O, 'amber')],
        apply: (s) => {
            play(s, O, 'blood-of-titans', { attachTo: { side: O, cardId: 'headhunter' } });
            gainAmber(s, O, 1, 'Blood of Titans’ Æmber bonus');
        }
    },
    {
        chapter: 'Turn 10 · Onyx',
        title: 'Two more Brobnar creatures',
        body: [
            'Onyx plays **Grenade Snib** and **Crogg the Clumsy** into the battleline, then readies and draws back up to six.',
            'Note Crogg’s **splash-attack 2**: when it attacks, it also deals 2 damage to each of the attacked creature’s neighbours. And Grenade Snib’s *Destroyed: Your opponent loses 2{A}* — a card that pays out when it dies.'
        ],
        highlight: [card(O, 'grenade-snib'), card(O, 'crogg-the-clumsy')],
        apply: (s) => {
            play(s, O, 'grenade-snib');
            play(s, O, 'crogg-the-clumsy');
            readyAll(s, O);
            setPhase(s, 'Draw cards');
            draw(s, O, 2);
            reshuffle(s, O, [
                'valdr',
                'weak-link',
                'frigorific-rod',
                'forced-retirement',
                'gauntlet-of-command'
            ]);
            draw(s, O, 2);
        }
    },

    // -------------------------------------------------------------- turn 11
    {
        chapter: 'Turn 11 · Radiant',
        title: 'One Æmber short',
        body: [
            'Radiant has 5{A} and a key costs 6{A}. One short. They declare **house Star Alliance** and set out to find it.'
        ],
        highlight: [stat(R, 'amber'), stat(R, 'keyCost'), 'turnsteps'],
        apply: (s) => {
            beginTurn(s, R, 11);
            chooseHouse(s, R, 'staralliance');
        }
    },
    {
        chapter: 'Turn 11 · Radiant',
        title: 'The ward pays off',
        body: [
            '**Commander Chan** fights **Wikolia**. Chan deals 4 damage and destroys it; Wikolia deals 3 back.',
            'But Chan has been warded since turn 5. The ward counter is removed and **no damage is dealt** — a shield that waited six turns and then did its job.'
        ],
        highlight: [card(R, 'commander-chan'), card(O, 'wikolia')],
        apply: (s) => fight(s, R, 'commander-chan', 'wikolia')
    },
    {
        chapter: 'Turn 11 · Radiant',
        title: 'After Fight: use another creature',
        body: [
            'Commander Chan’s *After Fight/After Reap: Use another friendly creature.* now triggers.',
            'Read it carefully: it does not say *Star Alliance* creature. Abilities override the house rule when they do not mention a house, so Radiant may use **any** ready creature in their battleline — including ones from houses that are not active this turn.',
            'Radiant reaps with **Mother Northelle** (Sanctum) for 1{A}, reaching 6{A}.'
        ],
        rule: 'A card ability that tells you to use a creature is not limited by your active house unless it says so.',
        highlight: [card(R, 'commander-chan'), card(R, 'mother-northelle'), stat(R, 'amber')],
        apply: (s) => reap(s, R, 'mother-northelle')
    },
    {
        chapter: 'Turn 11 · Radiant',
        title: 'Freeing captured Æmber',
        body: [
            'Mother Northelle has her own trigger: *After Reap: Move 1{A} from a friendly creature to your pool.*',
            'Yxl the Iron Captain is holding 2 captured Æmber. Radiant moves one of them into their pool — 7{A}. Captured Æmber is not dead; the right card sets it free.'
        ],
        highlight: [card(R, 'mother-northelle'), card(R, 'yxl-the-iron-captain'), stat(R, 'amber')],
        apply: (s) => moveAmberToPool(s, R, 'yxl-the-iron-captain', 1)
    },
    {
        chapter: 'Turn 11 · Radiant',
        title: 'Optional abilities',
        body: [
            'Radiant plays **Tactical Officer Moon**. Its *Play: You may rearrange the creatures in a player’s battleline.* is optional — "you may" always means you can decline.',
            'Radiant declines, so the battlelines stay as they are.'
        ],
        highlight: [card(R, 'tactical-officer-moon')],
        apply: (s) => {
            play(s, R, 'tactical-officer-moon');
            note(s, 'Radiant declines Tactical Officer Moon’s optional ability');
        }
    },
    {
        chapter: 'Turn 11 · Radiant',
        title: 'Two more reaps',
        body: [
            'Radiant reaps with **Sergeant Zakiel** — still Star Alliance thanks to Badge of Unity — for 8{A}, then with **Medic Ingram** for 9{A}.',
            'Medic Ingram’s *After Reap* triggers, and this time there is damage to heal: Radiant heals the 1 damage from **Sergeant Zakiel** and wards him.'
        ],
        highlight: [
            card(R, 'sergeant-zakiel'),
            card(R, 'medic-ingram'),
            card(R, 'badge-of-unity'),
            stat(R, 'amber')
        ],
        apply: (s) => {
            reap(s, R, 'sergeant-zakiel');
            reap(s, R, 'medic-ingram');
            heal(s, R, 'sergeant-zakiel', 3);
            wardCard(s, R, 'sergeant-zakiel');
        }
    },
    {
        chapter: 'Turn 11 · Radiant',
        title: 'Zap',
        body: [
            'Radiant plays **Explo-rover**, then the action **Zap**, whose Æmber bonus icon takes them to **10{A}**.',
            'Zap reads *Play: Deal 1 damage to a creature for each house represented among creatures in play.* Count them: Mars, Sanctum and Star Alliance on Radiant’s side, Brobnar and Ekwidon on Onyx’s — five houses, so 5 damage.',
            'Radiant aims it at **Gemcoat Vendor**, which has 6 power but already took 1 damage from its own ability on turn 8. 5 + 1 = 6, and it is destroyed.'
        ],
        highlight: [card(R, 'zap'), card(R, 'explo-rover'), card(O, 'gemcoat-vendor')],
        apply: (s) => {
            play(s, R, 'explo-rover');
            play(s, R, 'zap');
            gainAmber(s, R, 1, 'Zap’s Æmber bonus');
            dealDamage(s, O, 'gemcoat-vendor', 5);
            finishAction(s, R, 'zap');
        }
    },
    {
        chapter: 'Turn 11 · Radiant',
        title: '“Check”',
        body: [
            'Radiant readies and draws what is left of their deck. With **10{A}** in the pool and a key costing 6{A}, Radiant will forge at the start of their next turn no matter what.',
            'By convention the player announces **“check”** here — a courtesy warning that a key is coming unless the opponent can do something about it.'
        ],
        highlight: [stat(R, 'amber'), stat(R, 'keys')],
        platform:
            'On Archon Arena you would type this in the game chat beside the board — the same chat that logs every action of the game.',
        apply: (s) => {
            readyAll(s, R);
            setPhase(s, 'Draw cards');
            draw(s, R, 1);
            reshuffle(s, R, ['zap']);
            draw(s, R, 1);
            note(s, 'Radiant announces “check”');
        }
    },

    // -------------------------------------------------------------- turn 12
    {
        chapter: 'Turn 12 · Onyx',
        title: 'Onyx cannot race',
        body: [
            'Onyx has 4{A} and their keys cost **10{A}** because of Myx, the Tallminded and Radiant’s four Mars creatures. Reaping with all three Brobnar creatures would not get them there.',
            'And reaping has a second cost: **Zysysyx Shockworm** stuns any enemy creature that reaps. A **stunned** creature does nothing the next time it is used except exhaust and remove the stun counter — a whole action wasted.',
            'So Onyx declares **Brobnar** and attacks instead.'
        ],
        rule: 'Stun: the next time this creature is used, it only exhausts and removes the stun counter.',
        highlight: [
            stat(O, 'keyCost'),
            card(R, 'zysysyx-shockworm'),
            card(R, 'myx-the-tallminded')
        ],
        apply: (s) => {
            beginTurn(s, O, 12);
            chooseHouse(s, O, 'brobnar');
        }
    },
    {
        chapter: 'Turn 12 · Onyx',
        title: 'Headhunter swings',
        body: [
            '**Headhunter**, at 10 power thanks to Blood of Titans, attacks **Myx, the Tallminded** (5 power). Myx is destroyed; Headhunter takes 5 damage and survives comfortably.',
            'Headhunter’s *After Fight: Gain 1{A}* then triggers, taking Onyx to 5{A}. Myx was the only thing taxing Onyx’s keys, so with it gone their key cost drops straight back to 6{A}.'
        ],
        highlight: [card(O, 'headhunter'), card(R, 'myx-the-tallminded'), stat(O, 'keyCost')],
        apply: (s) => {
            fight(s, O, 'headhunter', 'myx-the-tallminded');
            gainAmber(s, O, 1, 'Headhunter’s After Fight');
        }
    },
    {
        chapter: 'Turn 12 · Onyx',
        title: 'Splash attack',
        body: [
            '**Crogg the Clumsy** (7 power) attacks **Yxl the Iron Captain** (4 power, 1 armor). 7 − 1 armor = 6 damage: Yxl is destroyed, and deals 4 back to Crogg.',
            'Crogg has **splash-attack 2**, so it also deals 2 damage to each of Yxl’s neighbours: **Medic Ingram** takes 2 and survives at 3 power, and **Ironyx Rebel** takes 2 and is destroyed.',
            'The Æmber still captured on Yxl returns to Onyx’s pool, since Onyx is who it was taken from.'
        ],
        rule: 'Splash-attack N: when this creature attacks, also deal N damage to each neighbour of the attacked creature.',
        highlight: [
            card(O, 'crogg-the-clumsy'),
            card(R, 'yxl-the-iron-captain'),
            card(R, 'ironyx-rebel'),
            card(R, 'medic-ingram')
        ],
        apply: (s) => fight(s, O, 'crogg-the-clumsy', 'yxl-the-iron-captain', { splash: 2 })
    },
    {
        chapter: 'Turn 12 · Onyx',
        title: 'Taunt changes the target',
        body: [
            'Medic Ingram, now damaged, would be easy prey for **Grenade Snib**. But Commander Chan carries Protect the Weak, which gives it **taunt** — and Medic Ingram is Chan’s neighbour, so it cannot be attacked at all.',
            'Grenade Snib also reads *Destroyed: Your opponent loses 2{A}.* Getting it killed is good for Onyx, so they attack **Commander Chan** directly.',
            'Snib deals 2, minus Chan’s 1 armor from Protect the Weak, for 1 damage. Chan deals 4 back and destroys Snib — and Radiant loses 2{A}, dropping from 10 to 8.'
        ],
        highlight: [
            card(O, 'grenade-snib'),
            card(R, 'commander-chan'),
            card(R, 'protect-the-weak'),
            stat(R, 'amber')
        ],
        apply: (s) => {
            fight(s, O, 'grenade-snib', 'commander-chan');
            loseAmber(s, R, 2, 'Grenade Snib’s Destroyed ability');
        }
    },
    {
        chapter: 'Turn 12 · Onyx',
        title: 'Not enough',
        body: [
            'Onyx plays **Valdr** to the battleline, readies their cards and draws back up to six.',
            'It was a good turn — three of Radiant’s creatures are gone and Radiant lost 2{A}. But Radiant still holds 8{A}, and a key costs 6{A}.'
        ],
        highlight: [card(O, 'valdr'), stat(R, 'amber')],
        apply: (s) => {
            play(s, O, 'valdr');
            readyAll(s, O);
            drawToHandSize(s, O);
        }
    },

    // -------------------------------------------------------------- turn 13
    {
        chapter: 'Turn 13 · Radiant',
        title: 'Forge!',
        body: [
            'Step 1 of Radiant’s turn: they have 8{A} and a key costs 6{A}. Radiant spends 6{A} and forges their **first key** — flipping the red key token to its forged side.',
            'Two more and Radiant wins. The 2{A} left over carries on toward the next one.'
        ],
        rule: 'Forging is mandatory and happens at the start of your turn, before you choose a house.',
        highlight: [stat(R, 'keys'), stat(R, 'amber')],
        apply: (s) => {
            beginTurn(s, R, 13);
            forgeKey(s, R);
        }
    },
    {
        chapter: 'Turn 13 · Radiant',
        title: 'That is the game',
        body: [
            'You now know every rule this game uses: houses and the active house, Æmber and key cost, playing and discarding and using, reaping and fighting, ready and exhausted, damage and armor and power, capture and steal, ward and stun and taunt, deploy and splash-attack, archives, bonus icons, and the reshuffle.',
            'What happens next is up to you. Radiant would choose a house and keep pushing; Onyx needs to kill Radiant’s reapers or start stealing.',
            'The official walkthrough ends here on purpose — the rest is the part you learn by playing.'
        ],
        highlight: []
    },
    {
        chapter: 'Turn 13 · Radiant',
        title: 'Three keywords that never came up',
        body: [
            'Three keywords are printed on cards in these decks but never triggered in this game. Each one is explained in brackets on the card itself, which is true of every KeyForge keyword — you never have to remember one.',
            '**Elusive** (Mother Northelle, The Old Tinker) — the first time this creature is attacked each turn, no damage is dealt to it.\n**Skirmish** (Explo-rover) — when you use this creature to fight, it takes no damage in return.\n**Assault N** (Tactical Officer Moon) — before this creature attacks, it deals N damage to the creature it is attacking.',
            'There are more keywords across the full card pool, and one thing makes them all manageable: the reminder text is on the card, every time.'
        ],
        highlight: [
            card(R, 'mother-northelle'),
            card(R, 'explo-rover'),
            card(R, 'tactical-officer-moon')
        ]
    },

    // ------------------------------------------------------- the platform
    {
        chapter: 'Playing on Archon Arena',
        title: 'The board you just used is the real one',
        body: [
            'Everything you have been reading sits in the same places in a real game here: your identity card, keys, Æmber and key cost along your stats bar; your creatures nearest the middle; your artifacts behind them; your hand along the bottom; your opponent mirrored above.',
            'The difference is that a real game does the bookkeeping. Damage, armor, destruction, captured Æmber, ward and stun counters, key cost and forging all resolve automatically.'
        ],
        highlight: [
            stat(R, 'identity'),
            zone(R, 'creatures'),
            zone(R, 'artifacts'),
            zone(R, 'hand')
        ]
    },
    {
        chapter: 'Playing on Archon Arena',
        title: 'Add a deck',
        body: [
            'Real KeyForge decks are unique and each has an identifier on the Master Vault. Go to **My Decks → Import Deck**, paste the deck’s link or its id, and it is yours to play with.',
            'You do not need to own the cards to try the platform out — but you do need a deck registered to your account to start a game.'
        ],
        platform:
            'My Decks → Import Deck. Paste a Master Vault deck link and it appears in your list.'
    },
    {
        chapter: 'Playing on Archon Arena',
        title: 'Find an opponent',
        body: [
            '**Play → Play Online** lists open games; join one, or start your own and pick a name, a format and whether it is beginner, casual or competitive.',
            '**Quick Match** is the fastest route: choose a format and the lobby pairs you with an available opponent near your rating, with no waiting for someone to open a table.',
            'If you would rather watch first, **Watch** shows games in progress.'
        ],
        platform:
            'Beginner games are exactly what they sound like. Nobody minds you asking rules questions in chat.'
    },
    {
        chapter: 'Playing on Archon Arena',
        title: 'When something goes wrong',
        body: [
            'Cards are automated, but if a card misbehaves or someone misclicks, the wrench icon turns on **manual mode**, which lets either player move cards and adjust counters by hand.',
            'The chat panel beside the board logs every action of the game, so you can always scroll back and see what happened.',
            'If a card really is behaving incorrectly, report it — the bug report link is in the site menu, and card fixes go out regularly.'
        ],
        highlight: ['log']
    },
    {
        chapter: 'Playing on Archon Arena',
        title: 'Where to go next',
        body: [
            'Play a few casual games first — the rules land much faster with a deck in your hand than in a walkthrough.',
            'After that: **Tournaments** for organised events, **Community** for clubs, friends and leaderboards, and **My Stats** to follow your rating.',
            'You can replay this tutorial any time from the **Learn** tab. Good luck on the Crucible.'
        ]
    }
];
