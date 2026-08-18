const HumanCapture = require('../../../server/gamenode/humancapture');
const { decisionRecord } = require('../../../server/services/championschallenge/labFeatures');

/**
 * ARCHON (N45): the bot learns from the people who play here.
 *
 * The whole feature stands on one property, and it is the property that is
 * easiest to break silently: a human row must be INDISTINGUISHABLE from a row
 * the bot's own driver wrote for the same position and the same move. A model
 * is a weight per feature; feed it rows whose features were computed even
 * slightly differently and it does not learn less, it learns something wrong,
 * confidently, with nothing in the output that says so.
 *
 * So the first test here compares a captured row against `decisionRecord`
 * called directly - the same function the lab calls - and the rest pin the
 * cases where a click is NOT a decision: forced moves, cancelled menus, the
 * prompts the bot answers from a rule, and a conceded game whose every move
 * would otherwise be labelled a losing one.
 */

const HUMAN = 'player';
const BOT = 'Snudge';

const card = (uuid, overrides = {}) => ({
    uuid,
    id: overrides.id || `card-${uuid}`,
    name: overrides.name || uuid,
    type: overrides.type || 'creature',
    power: overrides.power === undefined ? 4 : overrides.power,
    exhausted: !!overrides.exhausted,
    cardData: overrides.cardData || { amber: 0 },
    getLegalActions: () => (overrides.actions || []).map((title) => ({ title })),
    ...(overrides.controller ? { controller: overrides.controller } : {})
});

const seat = (name, overrides = {}) => {
    const player = {
        name,
        amber: overrides.amber === undefined ? 3 : overrides.amber,
        getForgedKeys: () => overrides.keys || 0,
        getCurrentKeyCost: () => overrides.keyCost || 6,
        hand: overrides.hand || [],
        cardsInPlay: overrides.cardsInPlay || [],
        creaturesInPlay: (overrides.cardsInPlay || []).filter((entry) => entry.type === 'creature'),
        archives: [],
        deck: overrides.deck || [],
        discard: [],
        opponent: null,
        promptState: {
            menuTitle: '',
            buttons: [],
            selectCard: false,
            selectableCards: [],
            selectedCards: []
        }
    };

    return player;
};

/** A table: one human, one bot, facing each other. */
const table = ({ human = {}, bot = {}, round = 4 } = {}) => {
    const me = seat(HUMAN, human);
    const them = seat(BOT, bot);

    me.opponent = them;
    them.opponent = me;

    const game = {
        round,
        winner: null,
        getPlayerByName: (name) => (name === HUMAN ? me : name === BOT ? them : null)
    };

    return { game, me, them };
};

const MAIN_WINDOW = 'Choose a card to play, discard or use';
const HOUSE_CHOICE = 'Choose which house you want to activate this turn';

const REAP = { text: 'Reap with this creature', arg: 'reap', method: 'menuButton' };
const FIGHT = { text: 'Fight with this creature', arg: 'fight', method: 'menuButton' };
const CANCEL = { text: 'Cancel', arg: 'cancel', method: 'menuButton' };

/** A board with two creatures that can each reap or fight - a real choice. */
const twoReapers = () => [
    card('a', { actions: ['reap with this creature', 'fight with this creature'] }),
    card('b', { actions: ['reap with this creature', 'fight with this creature'] })
];

describe('capturing what a human decided', function () {
    describe('the rows are the bot’s own rows', function () {
        it('writes exactly what decisionRecord would write for the same move', function () {
            const { game, me } = table({ human: { cardsInPlay: twoReapers() } });
            const capture = new HumanCapture([HUMAN]);

            me.promptState.menuTitle = MAIN_WINDOW;
            capture.note(game, HUMAN, 'cardClicked', ['a']);

            me.promptState.menuTitle = 'Choose an action';
            me.promptState.buttons = [REAP, FIGHT, CANCEL];
            capture.note(game, HUMAN, 'menuButton', ['reap', undefined, 'menuButton']);

            // The reference: the lab's own call, for this position and this
            // move. Byte-for-byte, or the model is being fed two different
            // languages and cannot tell which one it is reading.
            const expected = decisionRecord(game, me, {
                kind: 'reap',
                card: me.cardsInPlay[0]
            });

            expect(capture.decisions).toHaveLength(1);
            expect(capture.decisions[0]).toEqual(expected);
        });

        it('reads the position the move was chosen FROM', function () {
            const { game, me } = table({
                human: { amber: 3, cardsInPlay: twoReapers() }
            });
            const capture = new HumanCapture([HUMAN]);

            me.promptState.menuTitle = MAIN_WINDOW;
            capture.note(game, HUMAN, 'cardClicked', ['a']);

            me.promptState.menuTitle = 'Choose an action';
            me.promptState.buttons = [REAP, FIGHT, CANCEL];
            capture.note(game, HUMAN, 'menuButton', ['reap', undefined, 'menuButton']);

            // Then the engine runs the reap.
            me.amber = 4;
            me.cardsInPlay[0].exhausted = true;

            // The row must still describe the three-amber board. A row built
            // afterwards would describe the consequence and label it the cause.
            expect(capture.decisions[0].state.myAmber).toBeCloseTo(3 / 12, 6);
        });

        it('labels the side, so the trainer can tell whose move it was', function () {
            const { game, me } = table({ human: { cardsInPlay: twoReapers() } });
            const capture = new HumanCapture([HUMAN]);

            me.promptState.menuTitle = MAIN_WINDOW;
            capture.note(game, HUMAN, 'cardClicked', ['a']);
            me.promptState.buttons = [REAP, FIGHT, CANCEL];
            capture.note(game, HUMAN, 'menuButton', ['reap', undefined, 'menuButton']);

            expect(capture.decisions[0].side).toBe(HUMAN);
        });
    });

    describe('which move a click became', function () {
        it('tells a reap from a fight by the button that followed', function () {
            const { game, me } = table({ human: { cardsInPlay: twoReapers() } });
            const capture = new HumanCapture([HUMAN]);

            me.promptState.menuTitle = MAIN_WINDOW;
            capture.note(game, HUMAN, 'cardClicked', ['a']);
            me.promptState.buttons = [REAP, FIGHT, CANCEL];
            capture.note(game, HUMAN, 'menuButton', ['fight', undefined, 'menuButton']);

            expect(capture.decisions[0].action['act:fight']).toBe(1);
            expect(capture.decisions[0].action['act:reap']).toBe(0);
        });

        it('writes nothing for a click that was cancelled', function () {
            const { game, me } = table({ human: { cardsInPlay: twoReapers() } });
            const capture = new HumanCapture([HUMAN]);

            me.promptState.menuTitle = MAIN_WINDOW;
            capture.note(game, HUMAN, 'cardClicked', ['a']);
            me.promptState.buttons = [REAP, FIGHT, CANCEL];
            capture.note(game, HUMAN, 'menuButton', ['cancel', undefined, 'menuButton']);

            expect(capture.decisions).toHaveLength(0);
        });

        it('does not lose the row because they said something mid-menu', function () {
            // Chat does not close the card's menu, so the reap that follows is
            // still the move they chose. Throwing the row away for a message
            // would quietly cost the diary its chattiest players.
            const { game, me } = table({ human: { cardsInPlay: twoReapers() } });
            const capture = new HumanCapture([HUMAN]);

            me.promptState.menuTitle = MAIN_WINDOW;
            capture.note(game, HUMAN, 'cardClicked', ['a']);
            capture.note(game, HUMAN, 'chat', ['good luck']);
            me.promptState.buttons = [REAP, FIGHT, CANCEL];
            capture.note(game, HUMAN, 'menuButton', ['reap', undefined, 'menuButton']);

            expect(capture.decisions).toHaveLength(1);
            expect(capture.decisions[0].action['act:reap']).toBe(1);
        });

        it('drops a half-made move rather than resolve it against another prompt', function () {
            // The click is only ever completed by a button that expresses one
            // of THAT card's own moves. Anything else abandons it - and having
            // abandoned it, a later press cannot revive it either.
            const { game, me } = table({ human: { cardsInPlay: twoReapers() } });
            const capture = new HumanCapture([HUMAN]);

            me.promptState.menuTitle = MAIN_WINDOW;
            capture.note(game, HUMAN, 'cardClicked', ['a']);

            me.promptState.menuTitle = 'Which trigger resolves first?';
            me.promptState.buttons = [
                { text: 'Mine', arg: 'mine', method: 'menuButton' },
                { text: 'Theirs', arg: 'theirs', method: 'menuButton' }
            ];
            capture.note(game, HUMAN, 'menuButton', ['mine', undefined, 'menuButton']);

            // Captured as the button question it is - not as a reap.
            expect(capture.decisions).toHaveLength(1);
            expect(capture.decisions[0].action['act:button']).toBe(1);

            // And having been abandoned, the click cannot be revived: a later
            // press of Reap is whatever the prompt in front of it is, never
            // the move that click was going to become.
            me.promptState.buttons = [REAP, FIGHT, CANCEL];
            capture.note(game, HUMAN, 'menuButton', ['reap', undefined, 'menuButton']);

            expect(capture.decisions.some((row) => row.action['act:reap'])).toBe(false);
        });

        it('separates playing a card from binning it', function () {
            const { game, me } = table({
                human: {
                    hand: [
                        card('h1', {
                            type: 'creature',
                            actions: ['play this creature', 'discard this card']
                        }),
                        card('h2', {
                            type: 'creature',
                            actions: ['play this creature', 'discard this card']
                        })
                    ]
                }
            });
            const capture = new HumanCapture([HUMAN]);

            me.promptState.menuTitle = MAIN_WINDOW;
            capture.note(game, HUMAN, 'cardClicked', ['h1']);
            me.promptState.buttons = [
                { text: 'Play this creature', arg: 'play', method: 'menuButton' },
                { text: 'Discard this card', arg: 'discard', method: 'menuButton' },
                CANCEL
            ];
            capture.note(game, HUMAN, 'menuButton', ['discard', undefined, 'menuButton']);

            expect(capture.decisions[0].action['act:discard']).toBe(1);
            expect(capture.decisions[0].action['act:playCreature']).toBe(0);
        });
    });

    describe('what is not a decision', function () {
        it('ignores a move that was the only move', function () {
            // One creature, and it can only reap. The engine forced this; a
            // model trained on it learns that whatever it is compelled to do
            // is good, weighted by how often it is compelled.
            const { game, me } = table({
                human: { cardsInPlay: [card('a', { actions: ['reap with this creature'] })] }
            });
            const capture = new HumanCapture([HUMAN]);

            me.promptState.menuTitle = MAIN_WINDOW;
            capture.note(game, HUMAN, 'cardClicked', ['a']);
            me.promptState.buttons = [REAP, CANCEL];
            capture.note(game, HUMAN, 'menuButton', ['reap', undefined, 'menuButton']);

            expect(capture.decisions).toHaveLength(0);
        });

        it('ignores the prompts the bot answers from a rule, not the model', function () {
            const { game, me } = table();
            const capture = new HumanCapture([HUMAN]);
            const fixed = [
                'Keep starting hand?',
                'Are you sure you want to end your turn?',
                'Activate prophecy?'
            ];

            for (const title of fixed) {
                me.promptState.menuTitle = title;
                me.promptState.buttons = [
                    { text: 'Yes', arg: 'yes', method: 'menuButton' },
                    { text: 'No', arg: 'no', method: 'menuButton' }
                ];
                capture.note(game, HUMAN, 'menuButton', ['yes', undefined, 'menuButton']);
            }

            expect(capture.decisions).toHaveLength(0);
        });

        it('ignores Done and Autoresolve, which end a prompt rather than answer it', function () {
            const { game, me } = table();
            const capture = new HumanCapture([HUMAN]);

            me.promptState.menuTitle = 'Choose creatures to destroy';
            me.promptState.buttons = [
                { text: 'Done', arg: 'done', method: 'menuButton' },
                { text: 'Cancel', arg: 'cancel', method: 'menuButton' }
            ];
            capture.note(game, HUMAN, 'menuButton', ['done', undefined, 'menuButton']);

            expect(capture.decisions).toHaveLength(0);
        });

        it('never captures the bot’s seat', function () {
            const { game, them } = table({ bot: { cardsInPlay: twoReapers() } });
            const capture = new HumanCapture([HUMAN]);

            them.promptState.menuTitle = MAIN_WINDOW;
            capture.note(game, BOT, 'cardClicked', ['a']);
            them.promptState.buttons = [REAP, FIGHT, CANCEL];
            capture.note(game, BOT, 'menuButton', ['reap', undefined, 'menuButton']);

            expect(capture.decisions).toHaveLength(0);
        });

        it('stops once the game has been won', function () {
            const { game, me } = table({ human: { cardsInPlay: twoReapers() } });
            const capture = new HumanCapture([HUMAN]);

            game.winner = { name: HUMAN };
            me.promptState.menuTitle = MAIN_WINDOW;
            capture.note(game, HUMAN, 'cardClicked', ['a']);
            me.promptState.buttons = [REAP, FIGHT, CANCEL];
            capture.note(game, HUMAN, 'menuButton', ['reap', undefined, 'menuButton']);

            expect(capture.decisions).toHaveLength(0);
        });

        it('writes nothing when the pressed button cannot be identified', function () {
            // Two buttons carrying the same arg: a row filed against the wrong
            // one is worse than no row at all.
            const { game, me } = table();
            const capture = new HumanCapture([HUMAN]);

            me.promptState.menuTitle = 'Choose one';
            me.promptState.buttons = [
                { text: 'Left', arg: 'same', method: 'menuButton' },
                { text: 'Right', arg: 'same', method: 'menuButton' }
            ];
            capture.note(game, HUMAN, 'menuButton', ['same', undefined, 'menuButton']);

            expect(capture.decisions).toHaveLength(0);
        });
    });

    describe('the other three kinds of decision', function () {
        it('captures the house call', function () {
            const { game, me } = table();
            const capture = new HumanCapture([HUMAN]);

            me.promptState.menuTitle = HOUSE_CHOICE;
            me.promptState.buttons = [
                { text: 'Dis', arg: 'dis', method: 'menuButton' },
                { text: 'Sanctum', arg: 'sanctum', method: 'menuButton' },
                { text: 'Shadows', arg: 'shadows', method: 'menuButton' }
            ];
            capture.note(game, HUMAN, 'menuButton', ['sanctum', undefined, 'menuButton']);

            expect(capture.decisions).toHaveLength(1);
            expect(capture.decisions[0].action['act:houseCall']).toBe(1);
        });

        it('captures a selection, with the prompt that asked for it', function () {
            const { game, me, them } = table();
            const targets = [card('t1', { controller: them }), card('t2', { controller: them })];
            const capture = new HumanCapture([HUMAN]);

            me.promptState.menuTitle = 'Choose a creature to destroy';
            me.promptState.selectCard = true;
            me.promptState.selectableCards = targets;
            capture.note(game, HUMAN, 'cardClicked', ['t2']);

            expect(capture.decisions).toHaveLength(1);
            expect(capture.decisions[0].action['act:select']).toBe(1);
            // The prompt is the whole signal: "choose a creature to destroy"
            // and "choose a creature to heal" look identical on the board and
            // want opposite answers.
            expect(capture.decisions[0].promptKey).toContain('choose a creature to destroy');
            expect(capture.decisions[0].promptKey).toContain('theirs');
        });

        it('ignores a selection with only one selectable card left', function () {
            const { game, me, them } = table();
            const capture = new HumanCapture([HUMAN]);

            me.promptState.menuTitle = 'Choose a creature to destroy';
            me.promptState.selectCard = true;
            me.promptState.selectableCards = [card('t1', { controller: them })];
            capture.note(game, HUMAN, 'cardClicked', ['t1']);

            expect(capture.decisions).toHaveLength(0);
        });

        it('captures a card’s own question, keyed on the prompt and the answer', function () {
            const { game, me } = table();
            const capture = new HumanCapture([HUMAN]);

            me.promptState.menuTitle = 'Use this card’s ability?';
            me.promptState.buttons = [
                { text: 'Yes', arg: 'yes', method: 'menuButton' },
                { text: 'No', arg: 'no', method: 'menuButton' }
            ];
            capture.note(game, HUMAN, 'menuButton', ['no', undefined, 'menuButton']);

            expect(capture.decisions).toHaveLength(1);
            expect(capture.decisions[0].action['act:button']).toBe(1);
            expect(capture.decisions[0].promptKey).toContain('no');
        });
    });

    describe('harvesting the finished game', function () {
        const played = () => {
            const { game, me } = table({ human: { cardsInPlay: twoReapers() } });
            const capture = new HumanCapture([HUMAN]);

            me.promptState.menuTitle = MAIN_WINDOW;
            capture.note(game, HUMAN, 'cardClicked', ['a']);
            me.promptState.buttons = [REAP, FIGHT, CANCEL];
            capture.note(game, HUMAN, 'menuButton', ['reap', undefined, 'menuButton']);

            return capture;
        };

        it('names the winner in the form the trainer compares against', function () {
            const harvested = played().harvest(HUMAN, 'keys');

            expect(harvested.winnerSide).toBe(HUMAN);
            expect(harvested.decisions[0].side).toBe(harvested.winnerSide);
        });

        it('keeps a game the human lost - a loss is a label, not a rejection', function () {
            expect(played().harvest(BOT, 'keys').decisions).toHaveLength(1);
        });

        it('throws away a conceded game', function () {
            // A concession labels every move the conceder made a losing move,
            // including the good ones, and people concede for reasons that have
            // nothing to do with the position.
            expect(played().harvest(BOT, 'concede')).toBeNull();
        });

        it('throws away an abandoned game, which is a concession without the button', function () {
            expect(played().harvest(BOT, 'abandoned')).toBeNull();
        });

        it('has nothing to file when nothing was decided', function () {
            expect(new HumanCapture([HUMAN]).harvest(HUMAN, 'keys')).toBeNull();
        });

        it('bounds one game’s rows rather than growing without limit', function () {
            const { game, me } = table({ human: { cardsInPlay: twoReapers() } });
            const capture = new HumanCapture([HUMAN]);

            for (let index = 0; index < HumanCapture.MAX_DECISIONS + 20; index++) {
                me.promptState.menuTitle = MAIN_WINDOW;
                me.promptState.buttons = [];
                capture.note(game, HUMAN, 'cardClicked', ['a']);
                me.promptState.buttons = [REAP, FIGHT, CANCEL];
                capture.note(game, HUMAN, 'menuButton', ['reap', undefined, 'menuButton']);
            }

            expect(capture.decisions).toHaveLength(HumanCapture.MAX_DECISIONS);
            expect(capture.dropped).toBe(20);
        });
    });

    describe('never at the game’s expense', function () {
        it('swallows a reading that throws', function () {
            const { game, me } = table();
            const capture = new HumanCapture([HUMAN]);

            me.promptState.menuTitle = MAIN_WINDOW;
            Object.defineProperty(me, 'hand', {
                get() {
                    throw new Error('the engine moved under us');
                }
            });

            expect(() => capture.note(game, HUMAN, 'cardClicked', ['a'])).not.toThrow();
            expect(capture.decisions).toHaveLength(0);
        });

        it('does nothing for a seat that is not at this table', function () {
            const { game } = table();

            expect(new HumanCapture([HUMAN]).note(game, 'spectator', 'cardClicked', ['a'])).toBe(
                false
            );
        });
    });
});
