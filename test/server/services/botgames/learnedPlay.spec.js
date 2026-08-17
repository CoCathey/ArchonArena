const { BotPolicy } = require('../../../../server/services/botplayer/BotPolicy');
const { mainWindowCandidates } = require('../../../../server/services/botplayer/decisions');
const { emptyModel } = require('../../../../server/services/championschallenge/labPolicy');

/**
 * ARCHON (N21/F9): the practice bots play what the lab learned.
 *
 * The Champion's Challenge trains a model by playing thousands of games
 * against itself; the practice bots in the lobby score their moves with that
 * same model, over the same enumerated move list. Two things need pinning:
 * the list is the moves a human could make, and the model is what picks from
 * it - so a stronger champion is a stronger opponent in the lobby, with no
 * second brain to maintain.
 */

/** A card the engine would offer an action on. */
const card = (id, type, actions, extra = {}) => ({
    id,
    uuid: `uuid-${id}`,
    type,
    power: 4,
    cardData: { amber: 0 },
    exhausted: false,
    hasHouse: () => true,
    getLegalActions: () => actions.map((title) => ({ title })),
    ...extra
});

/** Enough of a player for the enumeration and the feature extractor. */
const player = ({ hand = [], inPlay = [] } = {}) => ({
    name: 'Snudge',
    amber: 3,
    hand,
    cardsInPlay: inPlay,
    keys: {},
    chains: 0,
    deck: [],
    discard: [],
    getForgedKeys: () => 0,
    getCurrentKeyCost: () => 6,
    opponent: {
        name: 'Ana',
        amber: 2,
        hand: [],
        cardsInPlay: [],
        deck: [],
        discard: [],
        getForgedKeys: () => 0,
        getCurrentKeyCost: () => 6
    }
});

const gameStub = () => {
    const clicks = [];

    return {
        clicks,
        round: 3,
        cardClicked: (name, uuid) => clicks.push({ name, uuid }),
        menuButton: () => {}
    };
};

describe('the move list every bot shares', function () {
    it('offers each playable hand card and each distinct board action', function () {
        const soldier = card('soldier', 'creature', [
            'Reap with this creature',
            'Fight with this creature'
        ]);
        const relic = card('relic', 'artifact', ["Use this card's action ability"]);
        const inHand = card('bolt', 'action', ['Play this action']);

        const { candidates } = mainWindowCandidates(
            player({ hand: [inHand], inPlay: [soldier, relic] })
        );

        expect(candidates.map((entry) => entry.kind).sort()).toEqual(
            ['fight', 'playAction', 'reap', 'useAbility'].sort()
        );
        // Hand cards come first and carry the kind playing them represents.
        expect(candidates[0]).toMatchObject({ list: 'hand', index: 0, kind: 'playAction' });
    });

    it('offers nothing when the engine allows nothing', function () {
        const idle = card('idle', 'creature', []);

        expect(mainWindowCandidates(player({ inPlay: [idle] })).candidates).toEqual([]);
    });
});

describe('a practice bot with the champion model', function () {
    const fighter = card('fighter', 'creature', [
        'Reap with this creature',
        'Fight with this creature'
    ]);

    /** A model that wants one kind of move and nothing else. */
    const modelWanting = (kind) => {
        const model = emptyModel();

        model.weights[`a:act:${kind}`] = 8;

        return model;
    };

    it('plays the move the model rates highest', function () {
        const game = gameStub();
        const seat = player({ inPlay: [fighter] });
        const policy = new BotPolicy({ policy: modelWanting('fight') });

        expect(policy.playFromMainWindow(game, seat, [])).toBe(true);
        expect(game.clicks).toEqual([{ name: 'Snudge', uuid: 'uuid-fighter' }]);
        // And it remembers WHY, so the menu that opens next is answered with
        // that move rather than by the old preference order (which would reap).
        expect(policy.pendingIntent).toEqual({ kind: 'fight' });
    });

    it('changes its mind when the model does', function () {
        const policy = new BotPolicy({ policy: modelWanting('reap') });

        policy.playFromMainWindow(gameStub(), player({ inPlay: [fighter] }), []);

        expect(policy.pendingIntent).toEqual({ kind: 'reap' });
    });

    it('answers the card menu with the move it chose', function () {
        const policy = new BotPolicy({ policy: modelWanting('fight') });
        const game = gameStub();
        const pressed = [];

        game.menuButton = (name, arg, uuid, method) => pressed.push({ arg, method });

        policy.playFromMainWindow(game, player({ inPlay: [fighter] }), []);

        // The engine now offers the card's menu; the bot takes the option it
        // clicked the card for, not the first one in the old preference list.
        const menu = [
            { text: 'Reap with this creature', arg: 'reap', method: 'm' },
            { text: 'Fight with this creature', arg: 'fight', method: 'm' }
        ];

        policy.respond(game, {
            ...player({ inPlay: [fighter] }),
            promptState: { menuTitle: 'Choose an action', buttons: menu }
        });

        expect(pressed).toEqual([{ arg: 'fight', method: 'm' }]);
    });

    it('falls back to sound heuristics with no model at all', function () {
        const game = gameStub();
        const policy = new BotPolicy();

        // No model is the ordinary state of a site that has not trained one:
        // it must still play, and still play the hand first.
        expect(
            policy.playFromMainWindow(
                game,
                player({ hand: [card('bolt', 'action', ['Play this action'])], inPlay: [fighter] }),
                []
            )
        ).toBe(true);
        expect(game.clicks).toEqual([{ name: 'Snudge', uuid: 'uuid-bolt' }]);
    });
});
