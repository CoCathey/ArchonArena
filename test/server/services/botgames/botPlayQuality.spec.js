const { BotPolicy } = require('../../../../server/services/botplayer/BotPolicy');
const {
    bestCandidates,
    bestFateCard,
    bestFightTarget,
    hasFate,
    fightOutcome,
    houseScore,
    keyWithinReach,
    wipeIsWorthIt,
    wipesBoard,
    mainWindowCandidates,
    opponentAtCheck,
    takesAmber
} = require('../../../../server/services/botplayer/decisions');
const {
    actionFeatures,
    stateFeatures
} = require('../../../../server/services/championschallenge/labFeatures');
const {
    chooseDecision,
    emptyModel,
    scoreDecision
} = require('../../../../server/services/championschallenge/labPolicy');

/**
 * ARCHON (F9): the bots play sense, with or without a champion.
 *
 * What a real table reported, and each one a different failure:
 *
 *  - An upgrade drawn before any creature was thrown away. The engine
 *    offers Discard on every card in hand, so the move list called that
 *    card "a play" and the bot took the only button in front of it.
 *  - A targeted action was fired into an empty board on the first play of
 *    the turn. With no trained model the bot picked a hand card at RANDOM,
 *    so it genuinely was a coin flip.
 *  - Fights were chosen the same way, with the target picked at random
 *    from whatever the prompt offered.
 *  - A request to enable manual mode was allowed once and refused the next
 *    time - the same coin flip, reached through the generic branch that
 *    presses any button that is not Cancel or Concede.
 *  - Prophecies were never touched at all, because a prophecy is not a
 *    card click and nothing in the bot knew that.
 *
 * The fixes live in the shared move module, so the lab and the lobby get
 * them together. The order below is a FLOOR - it covers the handful of
 * cases it can justify and nothing more, because ordering in this game
 * turns on the whole position and that is the Challenge's to learn. The
 * feature blocks are what make learning it possible at all.
 */

/** A stand-in for an engine card: only what the bots actually read. */
const card = (id, type, actions, extra = {}) => ({
    id,
    uuid: `uuid-${id}`,
    type,
    power: 4,
    damage: 0,
    armorTotal: 0,
    armorUsed: 0,
    controller: 'me',
    cardData: { amber: 0 },
    exhausted: false,
    hasHouse: () => true,
    hasToken: () => false,
    getKeywordValue: () => 0,
    getLegalActions: () => actions.map((title) => ({ title })),
    ...extra
});

const creature = (id, extra = {}) =>
    card(id, 'creature', ['Reap with this creature', 'Fight with this creature'], extra);

const enemy = (id, extra = {}) => creature(id, { controller: 'them', ...extra });

/** Enough of a player for the enumeration, the order and the features. */
const player = ({ hand = [], inPlay = [], enemies = [], amber = 3 } = {}) => ({
    name: 'Snudge',
    amber,
    hand,
    cardsInPlay: inPlay,
    creaturesInPlay: inPlay.filter((entry) => entry.type === 'creature'),
    deck: [],
    discard: [],
    getForgedKeys: () => 0,
    getCurrentKeyCost: () => 6,
    opponent: {
        name: 'Ana',
        amber: 2,
        hand: [],
        cardsInPlay: enemies,
        creaturesInPlay: enemies,
        deck: [],
        discard: [],
        getForgedKeys: () => 0,
        getCurrentKeyCost: () => 6
    }
});

const gameStub = () => {
    const clicks = [];
    const answers = [];

    return {
        clicks,
        answers,
        round: 3,
        cardClicked: (name, uuid) => clicks.push(uuid),
        menuButton: (name, arg) => answers.push(arg)
    };
};

describe('a bot deciding what to do with its hand', function () {
    const stranded = () => card('helm', 'upgrade', ['Discard this card']);
    const wearable = () => card('helm', 'upgrade', ['Play this upgrade', 'Discard this card']);

    it('offers playing a card and binning it as two different moves', function () {
        // Both are legal and they are not the same move. Enumerating only
        // the play is what got an upgrade binned by accident; enumerating
        // only the play when the bin is better is the opposite mistake.
        const { candidates } = mainWindowCandidates(player({ hand: [wearable()] }));

        expect(candidates.map((entry) => entry.kind)).toEqual(['playUpgrade', 'discard']);
        expect(candidates[1].playKind).toBe('playUpgrade');
    });

    it('plays a card it can use rather than binning it', function () {
        const seat = player({ hand: [wearable()] });

        expect(
            bestCandidates(seat, mainWindowCandidates(seat).candidates).map((entry) => entry.kind)
        ).toEqual(['playUpgrade']);
    });

    it('bins a card it cannot use, rather than gumming up the hand with it', function () {
        // An upgrade with nothing to attach to. Holding it costs a card
        // every turn it sits there; binning it draws a fresh one and the
        // discard pile becomes the deck again, so the card is not lost.
        const seat = player({ hand: [stranded()] });
        const { candidates } = mainWindowCandidates(seat);

        expect(candidates.map((entry) => entry.kind)).toEqual(['discard']);
        expect(bestCandidates(seat, candidates)).toEqual(candidates);
    });

    it('bins it only once the turn has nothing better left', function () {
        // Everything that accomplishes something outranks the bin, so a
        // dead card leaves at the end of the turn, not instead of a play.
        const seat = player({
            hand: [stranded(), card('soldier', 'creature', ['Play this creature'])],
            inPlay: [creature('ranger')]
        });
        const ranks = bestCandidates(seat, mainWindowCandidates(seat).candidates);

        expect(ranks.map((entry) => entry.card.id)).toEqual(['soldier']);
    });

    it('presses Discard, not Play, on the menu that opens', function () {
        // The two moves share a card, so the click alone does not say which
        // was chosen - the menu press does.
        const game = gameStub();
        const seat = player({ hand: [stranded()] });
        const policy = new BotPolicy();

        policy.playFromMainWindow(game, seat, []);

        expect(game.clicks).toEqual(['uuid-helm']);
        expect(policy.pendingIntent).toEqual({ kind: 'discard' });

        policy.respond(game, {
            ...seat,
            promptState: {
                menuTitle: 'Choose an action',
                buttons: [
                    { text: 'Play this upgrade', arg: 'play', method: 'm' },
                    { text: 'Discard this card', arg: 'discard', method: 'm' }
                ]
            }
        });

        expect(game.answers).toEqual(['discard']);
    });
});

describe('a bot with no champion model to guide it', function () {
    const bolt = card('bolt', 'action', ['Play this action']);
    const soldier = card('soldier', 'creature', ['Play this creature']);
    const relic = card('relic', 'artifact', ['Play this artifact']);

    it('builds the board before playing the cards that need one', function () {
        // The reported blunder: a targeted action fired first, into nothing.
        const seat = player({ hand: [bolt, soldier, relic] });
        const { candidates } = mainWindowCandidates(seat);

        expect(bestCandidates(seat, candidates).map((entry) => entry.card.id)).toEqual(['soldier']);
    });

    it('plays the hand out in that order, not at random', function () {
        // Ten runs of an unseeded bot: the old random pick landed on the
        // action about a third of the time.
        for (let attempt = 0; attempt < 10; attempt++) {
            const game = gameStub();

            new BotPolicy().playFromMainWindow(game, player({ hand: [bolt, soldier, relic] }), []);

            expect(game.clicks).toEqual(['uuid-soldier']);
        }
    });

    it('leaves the choice open inside one rank, so games differ', function () {
        // Two creatures are equally good openings; a bot that always took the
        // first would play every game from the same hand identically, and the
        // lab would train on one game over and over.
        const seat = player({ hand: [soldier, card('brute', 'creature', ['Play this creature'])] });

        expect(bestCandidates(seat, mainWindowCandidates(seat).candidates).length).toBe(2);
    });
});

describe('a bot deciding whether to fight', function () {
    const kindsChosen = (seat) =>
        bestCandidates(seat, mainWindowCandidates(seat).candidates).map((entry) => entry.kind);

    it('fights when the fight is won, rather than reaping', function () {
        expect(
            kindsChosen(
                player({ inPlay: [creature('ranger')], enemies: [enemy('goblin', { power: 2 })] })
            )
        ).toEqual(['fight']);
    });

    it('reaps instead of feeding a creature to a bigger one', function () {
        expect(
            kindsChosen(
                player({ inPlay: [creature('ranger')], enemies: [enemy('giant', { power: 9 })] })
            )
        ).toEqual(['reap']);
    });

    it('reaps when there is nobody to fight at all', function () {
        expect(kindsChosen(player({ inPlay: [creature('ranger')] }))).toEqual(['reap']);
    });

    it('reads armour, elusive and skirmish off the card', function () {
        const ranger = creature('ranger');
        const keyword = (name) => ({ getKeywordValue: (asked) => (asked === name ? 1 : 0) });

        // Armour soaks the difference: 4 power into 3 health behind 2 armour
        // kills nothing.
        expect(fightOutcome(ranger, enemy('turtle', { power: 3, armorTotal: 2 })).kills).toBe(
            false
        );

        // Elusive stops the first attack of the turn dead, both ways.
        expect(fightOutcome(ranger, enemy('sneak', { power: 1, ...keyword('elusive') }))).toEqual({
            kills: false,
            dies: false
        });

        // Skirmish means no counter-punch, so a bigger creature is safe to hit.
        expect(
            fightOutcome(creature('scout', keyword('skirmish')), enemy('giant', { power: 9 })).dies
        ).toBe(false);
    });
});

describe('a bot choosing whom to fight', function () {
    const attacker = creature('ranger');

    it('takes the biggest creature it can kill for free', function () {
        const target = bestFightTarget(attacker, [
            enemy('imp', { power: 1 }),
            enemy('brute', { power: 3 }),
            enemy('giant', { power: 9 })
        ]);

        // The giant kills it back; the brute is the best of the two it beats.
        expect(target.id).toBe('brute');
    });

    it('leaves prompts that are not fight targets alone', function () {
        // Own creatures in the list means this is some card's own question,
        // and the bot has no business answering it with combat maths.
        expect(bestFightTarget(attacker, [creature('mine'), enemy('theirs')])).toBe(null);
        expect(bestFightTarget(null, [enemy('theirs')])).toBe(null);
    });

    it('answers the fight prompt with that choice', function () {
        const game = gameStub();
        const seat = player({
            inPlay: [creature('ranger')],
            enemies: [enemy('giant', { power: 9 }), enemy('imp', { power: 1 })]
        });
        const policy = new BotPolicy();

        policy.playFromMainWindow(game, seat, []);
        policy.respond(game, {
            ...seat,
            promptState: {
                menuTitle: 'Choose a creature to attack',
                selectCard: true,
                selectableCards: seat.opponent.creaturesInPlay
            }
        });

        expect(game.clicks).toEqual(['uuid-ranger', 'uuid-imp']);
    });
});

/**
 * ARCHON (F9): playing the race, not just the board.
 *
 * "If I am above 6 and about to forge it should try to stop me while also
 * trying to get ahead on amber" - so the bot has to read two things off the
 * table it used to ignore: whether the opponent forges at the start of their
 * next turn, and whether its own key is within reach this turn.
 *
 * Real card ids throughout, classified by the platform's own card-knowledge
 * index (F3) rather than by a second parser written for the bots.
 */
describe('a bot watching the amber race', function () {
    // Infernal Terran: "Play/After Reap: Discard a card. Steal 1."
    const thief = (id = 'infernal-terran') => card(id, 'creature', ['Play this creature'], { id });
    const atCheck = (seat, amber = 7) => {
        seat.opponent.amber = amber;

        return seat;
    };

    it('knows a card that takes amber from the canonical card data', function () {
        expect(takesAmber(thief())).toBe(true);
        expect(takesAmber(card('soldier', 'creature', ['Play this creature']))).toBe(false);
        expect(takesAmber(null)).toBe(false);
    });

    it('sees the opponent standing at their key cost', function () {
        const seat = player();

        expect(opponentAtCheck(seat)).toBe(false);
        expect(opponentAtCheck(atCheck(seat))).toBe(true);
        // Exactly at the cost counts: they forge on their turn either way.
        expect(opponentAtCheck(atCheck(player(), 6))).toBe(true);
    });

    it('takes their amber before doing anything else', function () {
        const seat = atCheck(
            player({
                hand: [card('soldier', 'creature', ['Play this creature']), thief()],
                inPlay: [creature('ranger')],
                enemies: [enemy('imp', { power: 1 })]
            })
        );

        // A creature to play and a free kill available, and neither is the
        // move: the amber in their pool is a key unless it leaves now.
        expect(
            bestCandidates(seat, mainWindowCandidates(seat).candidates).map(
                (entry) => entry.card.id
            )
        ).toEqual(['infernal-terran']);
    });

    it('calls the house that can answer them', function () {
        const dis = thief();
        const untamed = card('soldier', 'creature', ['Play this creature']);

        dis.hasHouse = (house) => house === 'dis';
        untamed.hasHouse = (house) => house === 'untamed';

        // Two Untamed cards against one Dis card: on the count alone Untamed
        // wins, and it is the wrong call while they are sitting on a key.
        const seat = atCheck(player({ hand: [dis, untamed, { ...untamed, id: 'brute' }] }));

        expect(houseScore(seat, 'dis')).toBeGreaterThan(houseScore(seat, 'untamed'));

        // With nobody at check it is the plain count again.
        const calm = player({ hand: [dis, untamed, { ...untamed, id: 'brute' }] });

        expect(houseScore(calm, 'untamed')).toBeGreaterThan(houseScore(calm, 'dis'));
    });

    it('reaps for the key rather than taking a fight it would win', function () {
        // Six amber needed, four in the pool, two ready creatures: reaping
        // twice forges. A dead enemy creature is worth less than that.
        const seat = player({
            amber: 4,
            inPlay: [creature('ranger'), creature('scout')],
            enemies: [enemy('imp', { power: 1 })]
        });

        expect(keyWithinReach(seat)).toBe(true);
        expect(
            bestCandidates(seat, mainWindowCandidates(seat).candidates).map((entry) => entry.kind)
        ).toEqual(['reap', 'reap']);
    });

    it('goes back to fighting once the key is paid for', function () {
        const seat = player({
            amber: 6,
            inPlay: [creature('ranger')],
            enemies: [enemy('imp', { power: 1 })]
        });

        expect(keyWithinReach(seat)).toBe(false);
        expect(
            bestCandidates(seat, mainWindowCandidates(seat).candidates).map((entry) => entry.kind)
        ).toEqual(['fight']);
    });
});

/**
 * ARCHON (F9): order is the game.
 *
 * "Some actions you want to play before you play any creatures because the
 * outcome of that action would kill your creatures." Ordering is where
 * KeyForge strategy actually lives, and it turns on the whole position -
 * board, hand, discards - not on the card alone. The plain order below is a
 * floor for the handful of cases it can justify; everything past that is for
 * the Challenge to LEARN, which is why the features exist to express it.
 */
describe('a bot ordering its plays', function () {
    // De-escalation: "Play: Destroy each creature."
    const wipe = () => card('de-escalation', 'action', ['Play this action', 'Discard this card']);
    const soldier = () => card('soldier', 'creature', ['Play this creature']);

    it('knows a board wipe when it holds one', function () {
        expect(wipesBoard(wipe())).toBe(true);
        expect(wipesBoard(soldier())).toBe(false);
    });

    it('plays the wipe before the creatures, not over them', function () {
        // Out-bodied two to nothing: the wipe is the play, and it has to
        // come first or it destroys the board it was meant to rescue.
        const seat = player({
            hand: [wipe(), soldier()],
            enemies: [enemy('brute'), enemy('giant', { power: 9 })]
        });

        expect(
            bestCandidates(seat, mainWindowCandidates(seat).candidates).map(
                (entry) => entry.card.id
            )
        ).toEqual(['de-escalation']);
    });

    it('will not wipe a board it is winning', function () {
        const seat = player({
            hand: [wipe(), soldier()],
            inPlay: [creature('ranger'), creature('scout')],
            enemies: []
        });

        expect(wipeIsWorthIt(seat)).toBe(false);
        // The creature is the play; the wipe is not even second - the bot
        // would rather bin it, and does once the creature is down.
        expect(
            bestCandidates(seat, mainWindowCandidates(seat).candidates).map(
                (entry) => entry.card.id
            )
        ).toEqual(['soldier']);
    });

    it('bins the wipe it should not play rather than playing it', function () {
        // A board of our own, nothing of theirs, and the turn's work done -
        // the wipe would destroy our own creature for nothing, so it goes
        // in the bin and comes back later when it might answer something.
        const spent = creature('ranger', { exhausted: true, getLegalActions: () => [] });
        const seat = player({ hand: [wipe()], inPlay: [spent], enemies: [] });
        const chosen = bestCandidates(seat, mainWindowCandidates(seat).candidates);

        expect(chosen.map((entry) => entry.kind)).toEqual(['discard']);
    });

    it('gives the model the position it would need to learn this itself', function () {
        // The plain order handles one case from one role. What actually
        // decides ordering is the whole position, so every move is crossed
        // with it - including "are the creatures still to come", which is
        // the difference between playing a card first and playing it last.
        const holding = actionFeatures({
            kind: 'playAction',
            card: wipe(),
            player: player({ hand: [soldier()], enemies: [enemy('brute')] })
        }).features;

        expect(holding['card:boardWipe']).toBe(1);
        expect(holding['x:boardWipe:creatureInHand']).toBe(1);
        expect(holding['c:de-escalation:noBoard']).toBe(1);

        const committed = actionFeatures({
            kind: 'playAction',
            card: wipe(),
            player: player({ inPlay: [creature('ranger')], enemies: [enemy('brute')] })
        }).features;

        // Same card, same move kind, different weights available - which is
        // the whole point: one of these is a good play and one is not, and
        // nothing about `act:playAction` could ever tell them apart.
        expect(committed['x:boardWipe:creatureInHand']).toBe(undefined);
        expect(committed['c:de-escalation:noBoard']).toBe(undefined);
    });

    it('reads the discard pile too, since half the game reads it back', function () {
        const seat = player();

        seat.discard = new Array(14).fill(soldier());

        expect(stateFeatures({ round: 8 }, seat).myDiscard).toBeGreaterThan(0);
        expect(actionFeatures({ kind: 'reap', player: seat }).features['x:reap:deepDiscard']).toBe(
            1
        );
    });
});

describe('what a bot is allowed to know about its own deck', function () {
    const withDeck = (deck) => {
        const seat = player({ inPlay: [] });

        seat.deck = deck;

        return seat;
    };

    const contextsFor = (deck) => actionFeatures({ kind: 'reap', player: withDeck(deck) }).features;

    it('reads the composition of what it can still draw', function () {
        // Crossed with the move rather than kept as a state fact: every
        // candidate at one decision shares the state, so "creatures are
        // still coming" could never change which move gets picked from
        // there. Crossed with the kind, it can.
        const features = contextsFor([
            card('soldier', 'creature', []),
            card('brute', 'creature', []),
            card('bolt', 'action', [], { cardData: { amber: 1 } }),
            { ...card('thief', 'creature', []), id: 'infernal-terran' }
        ]);

        expect(features['x:reap:deckCreatures']).toBe(1);
        expect(features['x:reap:deckAmber']).toBe(1);
        expect(features['x:reap:deckControl']).toBe(1);
    });

    it('says nothing at all about the order of it', function () {
        // Same cards, shuffled: what a fair player could compute does not
        // change, which is the whole point.
        const cards = [
            card('soldier', 'creature', []),
            card('bolt', 'action', []),
            card('relic', 'artifact', [])
        ];

        expect(contextsFor(cards)).toEqual(contextsFor([...cards].reverse()));
    });

    it('says nothing rather than something wrong when the deck is out', function () {
        const features = contextsFor([]);

        expect(features['x:reap:deckCreatures']).toBe(undefined);
        expect(features['x:reap:deckAmber']).toBe(undefined);
        expect(features['x:reap:deckControl']).toBe(undefined);
    });

    it('keeps the STATE to facts a replay could reconstruct too', function () {
        // The parity N26 protects: a recording knows a deck's size and not
        // its contents, so deck composition must not live in the state.
        const state = stateFeatures({ round: 3 }, withDeck([card('soldier', 'creature', [])]));

        expect(state.deckCreatures).toBe(undefined);
        expect(state.myDeck).toBeGreaterThan(0);
    });

    it('crosses every move with the opponent standing at their key cost', function () {
        const seat = player();

        expect(actionFeatures({ kind: 'reap', player: seat }).features['x:reap:oppAtCheck']).toBe(
            undefined
        );

        seat.opponent.amber = 9;

        const answering = actionFeatures({
            kind: 'playCreature',
            card: { id: 'infernal-terran' },
            player: seat
        }).features;

        expect(answering['x:playCreature:oppAtCheck']).toBe(1);
        expect(answering['card:takesAmber']).toBe(1);
        expect(answering['x:takesAmber:oppAtCheck']).toBe(1);
    });
});

/**
 * ARCHON (F9): prophecies, and what goes under them.
 *
 * Prophetic Visions sits two pairs of prophecy cards beside the board.
 * Activating one costs a card from hand, buried face down beneath it; when
 * the prophecy comes true it pays out and the buried card's Fate ability
 * fires - and Fate abilities are penalties ("destroy the most powerful
 * friendly creature", "lose 2"). So there are two decisions here, not one,
 * and the bot used to make neither: it never clicked a prophecy at all,
 * because a prophecy is not a card click.
 */
describe('a bot and its prophecies', function () {
    // Embellish Imp carries "Fate: Destroy the most powerful friendly
    // creature." Burying it means paying that when the prophecy lands.
    const fateCard = () => card('embellish-imp', 'creature', ['Play this creature']);
    const spare = () => card('helm', 'upgrade', ['Discard this card']);
    const useful = () => card('soldier', 'creature', ['Play this creature']);

    const withProphecy = (options = {}) => {
        const seat = player(options);

        seat.activeHouse = 'dis';
        seat.prophecyCards = [card('stars-aligned', 'prophecy', [])];
        seat.canActivateProphecy = (prophecy) => prophecy.id === 'stars-aligned';

        return seat;
    };

    it('reads a Fate ability off the canonical card data', function () {
        expect(hasFate(fateCard())).toBe(true);
        expect(hasFate(useful())).toBe(false);
    });

    it('offers activating a prophecy as a move of its own', function () {
        const seat = withProphecy({ hand: [spare()] });
        const { prophecies, candidates } = mainWindowCandidates(seat);

        expect(prophecies.map((entry) => entry.id)).toEqual(['stars-aligned']);
        expect(candidates.some((entry) => entry.kind === 'activateProphecy')).toBe(true);
    });

    it('spends a card it was going to bin anyway', function () {
        // The dead upgrade buys a prophecy on its way out - which is why
        // activating sits immediately above the plain discard.
        const seat = withProphecy({ hand: [spare()] });

        expect(
            bestCandidates(seat, mainWindowCandidates(seat).candidates).map((entry) => entry.kind)
        ).toEqual(['activateProphecy']);
    });

    it('will not spend a card it could have played', function () {
        const seat = withProphecy({ hand: [useful()] });

        expect(
            bestCandidates(seat, mainWindowCandidates(seat).candidates).map((entry) => entry.kind)
        ).toEqual(['playCreature']);
    });

    it('clicks the prophecy and says yes to activating it', function () {
        // A prophecy is not in a zone, so it is not a card click - which is
        // exactly why the bots ignored prophecies entirely until now.
        const seat = withProphecy({ hand: [spare()] });
        const clicked = [];
        const game = gameStub();
        const policy = new BotPolicy();

        game.clickProphecy = (name, uuid) => clicked.push(uuid);

        policy.playFromMainWindow(game, seat, []);

        expect(clicked).toEqual(['uuid-stars-aligned']);
        expect(policy.pendingIntent).toEqual({ kind: 'activateProphecy' });

        policy.respond(game, {
            ...seat,
            promptState: {
                menuTitle: 'Activate prophecy?',
                buttons: [
                    { text: 'Yes', arg: 'yes', method: 'm' },
                    { text: 'No', arg: 'no', method: 'm' }
                ]
            }
        });

        expect(game.answers).toEqual(['yes']);
    });

    it('buries a card that will not punish it later', function () {
        const seat = withProphecy();
        const hand = [fateCard(), useful(), spare()];

        // No Fate ability, nothing it could have played, and of the house it
        // is already spending: the cheapest card in the hand, in that order.
        expect(bestFateCard(seat, hand).id).toBe('helm');
        // Given only a Fate card and a playable one, the playable one goes -
        // a penalty when the prophecy lands is worse than a card now.
        expect(bestFateCard(seat, [fateCard(), useful()]).id).toBe('soldier');
    });

    it('answers the prompt asking which card to bury', function () {
        const seat = withProphecy();
        const hand = [fateCard(), spare()];
        const game = gameStub();

        new BotPolicy().respond(game, {
            ...seat,
            hand,
            promptState: {
                menuTitle: 'Choose a card from your hand to place under the prophecy',
                selectCard: true,
                selectableCards: hand
            }
        });

        expect(game.clicks).toEqual(['uuid-helm']);
    });
});

/**
 * ARCHON: the prompt a card raises.
 *
 * "Would you like to use this?", "choose a house", which of two triggers
 * resolves first - nearly every optional ability in KeyForge arrives as a
 * button prompt, and every one the policy had no fixed title for was
 * answered by picking a button at random. It was the largest coin flip left
 * in the bot, and worse, it was never recorded as a decision, so no amount
 * of training could reach it.
 */
describe('a bot answering a prompt it has no fixed answer for', function () {
    const asked = (seat, buttons) => ({
        ...seat,
        promptState: { menuTitle: 'Would you like to draw a card?', buttons }
    });
    const yesNo = [
        { text: 'Yes', arg: 'yes', method: 'm' },
        { text: 'No', arg: 'no', method: 'm' }
    ];

    it('takes the offer rather than flipping for it', function () {
        // An optional ability is shown to the player it benefits, so yes is
        // the better half of the coin - twenty times out of twenty.
        const game = gameStub();
        const policy = new BotPolicy();

        for (let attempt = 0; attempt < 20; attempt++) {
            policy.respond(game, asked(player(), yesNo));
        }

        expect(game.answers).toEqual(new Array(20).fill('yes'));
    });

    it('presses what the model rates highest once there is one', function () {
        const model = emptyModel();

        // A champion that has learned this particular prompt is a trap.
        model.promptWeights = { 'would you like to draw a card|no': 6 };
        model.promptCounts = { 'would you like to draw a card|no': 500 };

        const game = gameStub();

        new BotPolicy({ policy: model }).respond(game, asked(player(), yesNo));

        expect(game.answers).toEqual(['no']);
    });

    it('generalizes from the button alone to a prompt it has never seen', function () {
        // `btn:yes` is what one weight for "accepting an optional ability"
        // looks like; it is what makes an unfamiliar prompt better than a
        // coin flip on the very first showing.
        const model = emptyModel();

        model.weights['a:btn:no'] = 6;

        const game = gameStub();

        new BotPolicy({ policy: model }).respond(game, {
            ...player(),
            promptState: { menuTitle: 'Some card nobody has seen before', buttons: yesNo }
        });

        expect(game.answers).toEqual(['no']);
    });

    it('still never concedes or cancels while anything else is offered', function () {
        const game = gameStub();

        new BotPolicy().respond(
            game,
            asked(player(), [
                { text: 'Concede', arg: 'concede', method: 'm' },
                { text: 'Maybe', arg: 'maybe', method: 'm' }
            ])
        );

        expect(game.answers).toEqual(['maybe']);
    });
});

describe('a bot asked to allow manual mode', function () {
    it('says yes every time, not on a coin flip', function () {
        const game = gameStub();
        const policy = new BotPolicy();
        const asked = {
            ...player(),
            promptState: {
                menuTitle: {
                    text: '{{player}} requests to enable manual mode. Allow?',
                    values: { player: 'cocathey' }
                },
                buttons: [
                    { text: 'Yes', arg: 'yes', method: 'menuButton' },
                    { text: 'No', arg: 'no', method: 'menuButton' }
                ]
            }
        };

        for (let attempt = 0; attempt < 20; attempt++) {
            expect(policy.respond(game, asked)).toBe(true);
        }

        expect(game.answers).toEqual(new Array(20).fill('yes'));
    });
});

describe('what the learned model can express', function () {
    it('crosses each move with the board it is made on', function () {
        const featuresFor = (seat) => actionFeatures({ kind: 'playAction', player: seat }).features;

        expect(featuresFor(player())['x:playAction:noBoard']).toBe(1);
        expect(
            featuresFor(player({ inPlay: [creature('soldier')] }))['x:playAction:noBoard']
        ).toBeUndefined();
    });

    it('lets a champion learn what a state weight never could', function () {
        // Every candidate at one decision shares a state, so the state's
        // contribution to Q is identical across them and cancels out of the
        // ranking. However strongly a model believes boards win games, it
        // cannot use that to prefer the creature here...
        const seat = player();
        const decision = (kind) => ({
            state: { myCreatures: 0 },
            action: actionFeatures({ kind, player: seat }).features,
            cardId: null
        });
        const candidates = [decision('playAction'), decision('playCreature')];
        const boardModel = emptyModel();

        boardModel.weights['s:myCreatures'] = 6;

        expect(scoreDecision(boardModel, candidates[0])).toBe(
            scoreDecision(boardModel, candidates[1])
        );

        // ...whereas one weight on the cross does exactly that.
        const crossModel = emptyModel();

        crossModel.weights['a:x:playAction:noBoard'] = -6;

        expect(chooseDecision(crossModel, candidates, 0, Math.random)).toBe(1);
    });
});
