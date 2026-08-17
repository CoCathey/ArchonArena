const { BotPolicy } = require('../../../../server/services/botplayer/BotPolicy');
const {
    bestCandidates,
    bestFightTarget,
    fightOutcome,
    houseScore,
    keyWithinReach,
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
 * Four blunders seen at a real table drive this spec, and each is a
 * different failure:
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
 *
 * The play fixes live in the shared move module, so the lab and the lobby
 * get them together - and the last block covers the reason a trained
 * champion could not have learned its way out of the second one.
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
    it('does not treat a card it can only discard as a move', function () {
        // An upgrade with nothing to attach to: the engine allows Discard
        // and nothing else, which is not a reason to play the card.
        const stranded = card('helm', 'upgrade', ['Discard this card']);

        expect(mainWindowCandidates(player({ hand: [stranded] })).candidates).toEqual([]);
    });

    it('keeps that card and ends the turn rather than binning it', function () {
        const game = gameStub();
        const pressed = [];
        const seat = player({ hand: [card('helm', 'upgrade', ['Discard this card'])] });

        game.menuButton = (name, arg) => pressed.push(arg);

        new BotPolicy().playFromMainWindow(game, seat, [{ text: 'End Turn', arg: 'endturn' }]);

        expect(game.clicks).toEqual([]);
        expect(pressed).toEqual(['endturn']);
    });

    it('still plays the upgrade once there is a creature to wear it', function () {
        const wearable = card('helm', 'upgrade', ['Play this upgrade', 'Discard this card']);
        const { candidates } = mainWindowCandidates(player({ hand: [wearable] }));

        expect(candidates.length).toBe(1);
        expect(candidates[0]).toMatchObject({ list: 'hand', index: 0, kind: 'playUpgrade' });
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

describe('what a bot is allowed to know about its own deck', function () {
    const withDeck = (deck) => {
        const seat = player({ inPlay: [] });

        seat.deck = deck;

        return seat;
    };

    it('reads the composition of what it can still draw', function () {
        const state = stateFeatures(
            { round: 3 },
            withDeck([
                card('soldier', 'creature', []),
                card('brute', 'creature', []),
                card('bolt', 'action', [], { cardData: { amber: 1 } }),
                { ...card('thief', 'creature', []), id: 'infernal-terran' }
            ])
        );

        expect(state.deckCreatures).toBe(0.75);
        expect(state.deckAmber).toBeGreaterThan(0);
        expect(state.deckControl).toBeGreaterThan(0);
    });

    it('says nothing at all about the order of it', function () {
        // Same cards, shuffled: the features a fair player could compute do
        // not change, which is the whole point.
        const cards = [
            card('soldier', 'creature', []),
            card('bolt', 'action', []),
            card('relic', 'artifact', [])
        ];
        const forwards = stateFeatures({ round: 1 }, withDeck(cards));
        const backwards = stateFeatures({ round: 1 }, withDeck([...cards].reverse()));

        expect(forwards).toEqual(backwards);
    });

    it('is empty rather than wrong when the deck is out', function () {
        const state = stateFeatures({ round: 20 }, withDeck([]));

        expect(state.deckCreatures).toBe(0);
        expect(state.deckAmber).toBe(0);
        expect(state.deckControl).toBe(0);
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
