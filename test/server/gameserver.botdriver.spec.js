const GameServer = require('../../server/gamenode/gameserver.js');
const BotDriver = require('../../server/gamenode/botdriver.js');
const Settings = require('../../server/settings.js');
const { getCardIndex, cloneCard } = require('../../server/services/championschallenge/packCards');

// ARCHON (F9): the Helper Bot's seat, driven through the REAL game server
// wiring - onStartGame builds the game and pumps the driver, onGameMessage
// pumps it after every human input. These are real full games on the real
// engine (about a second each), so there are deliberately few of them; the
// cap behaviours are exercised with tiny budgets instead of wedged games.
//
// The constructor connects sockets and timers, so the object under test is
// built from the prototype - the same approach as gameserver.abandonment.

/**
 * A legal-shaped 36-card deck: 12 cards from each of three houses, drawn from
 * the same pack data production uses - the same builder the SimulatedGame
 * spec uses.
 */
function buildDeck(name, houses) {
    const byHouse = {};

    for (const card of Object.values(getCardIndex())) {
        if (
            houses.includes(card.house) &&
            !card.isNonDeck &&
            ['creature', 'artifact', 'action', 'upgrade'].includes(card.type)
        ) {
            (byHouse[card.house] = byHouse[card.house] || []).push(card);
        }
    }

    const cards = [];

    for (const house of houses) {
        const pool = byHouse[house];

        for (let i = 0; i < 12; i++) {
            const card = pool[(i * 5) % pool.length];

            cards.push({ id: card.id, count: 1, card: cloneCard(card.id) });
        }
    }

    return { name, uuid: `spec-${name}`, expansion: 341, houses, cards };
}

const makeUser = (username) =>
    Settings.getUserWithDefaultsSet({
        username,
        settings: {
            optionSettings: {
                orderForcedAbilities: false,
                confirmOneClick: false
            }
        }
    });

const buildServer = () => {
    const server = Object.create(GameServer.prototype);

    server.games = {};
    server.sent = [];
    server.cardData = {};
    server.gameSocket = { send: (command, arg) => server.sent.push({ command, arg }) };
    server.sendGameState = () => {};

    return server;
};

const buildPendingGame = ({ id, players, botMaxTurns, showcaseGame }) => ({
    id,
    name: 'Play against HelperBot!',
    owner: makeUser(Object.keys(players)[0]),
    gameFormat: 'normal',
    allowSpectators: false,
    botGame: true,
    showcaseGame,
    botMaxTurns,
    players,
    spectators: {}
});

const botSeat = (name, deck, isBot = true) => ({
    id: 'TBA',
    name,
    user: makeUser(name),
    isBot,
    wins: 0,
    deck
});

/**
 * Wait for a bot game to finish. A pump hands the event loop back when its
 * budget runs out and continues on a later tick, so a whole bot-vs-bot game
 * arrives across several ticks rather than inside one call - which is the
 * point: the node has to stay answerable while the bot thinks.
 */
const played = async (game, timeoutMs = 60000) => {
    const deadline = Date.now() + timeoutMs;

    while (!game.winner && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 5));
    }

    return game.winner;
};

describe('game node bot driver', function () {
    const alphaDeck = buildDeck('alpha', ['brobnar', 'dis', 'logos']);
    const omegaDeck = buildDeck('omega', ['sanctum', 'shadows', 'untamed']);

    it('plays a bot-vs-bot game to a legitimate win through onStartGame alone', async function () {
        const server = buildServer();

        server.onStartGame(
            buildPendingGame({
                id: 'bot-table',
                players: {
                    HelperBot: botSeat('HelperBot', alphaDeck),
                    Sparring: botSeat('Sparring', omegaDeck)
                }
            })
        );

        const game = server.games['bot-table'];

        await played(game);

        expect(game.winner).toBeDefined();
        expect(['HelperBot', 'Sparring']).toContain(game.winner.name);
        expect(game.getPlayerByName(game.winner.name).getForgedKeys()).toBe(3);

        // The result went out as GAMEWIN, flagged so the lobby's router keeps
        // it out of Games, replays and rating - and the bot never touched the
        // post-game menu.
        const wins = server.sent.filter((message) => message.command === 'GAMEWIN');

        expect(wins.length).toBe(1);
        expect(wins[0].arg.game.botGame).toBe(true);
        expect(wins[0].arg.game.winner).toBe(game.winner.name);
        expect(server.sent.filter((message) => message.command === 'REMATCH')).toEqual([]);
    }, 30000);

    it('answers the bot mulligan at start and its prompts after each human input', function () {
        const server = buildServer();

        server.onStartGame(
            buildPendingGame({
                id: 'practice-table',
                players: {
                    HelperBot: botSeat('HelperBot', alphaDeck),
                    Human: botSeat('Human', omegaDeck, false)
                }
            })
        );

        const game = server.games['practice-table'];
        const bot = game.getPlayerByName('HelperBot');
        const human = game.getPlayerByName('Human');
        const socket = { user: { username: 'Human' } };

        const buttonTexts = (player) =>
            (player.promptState.buttons || []).map((button) => String(button.text).toLowerCase());
        const press = (text) => {
            const button = human.promptState.buttons.find(
                (candidate) => String(candidate.text).toLowerCase() === text
            );

            expect(button).toBeDefined();
            server.onGameMessage(socket, 'menuButton', button.arg, button.uuid, button.method);
        };

        // The bot has already confirmed the start; only the human's
        // confirmation is still standing, waiting for a real click.
        expect(buttonTexts(human)).toContain('start the game');
        expect(buttonTexts(bot)).toEqual([]);

        // Each human answer goes through the real message path; the driver is
        // pumped inside onGameMessage, so by the time the state settles the
        // bot has answered everything that became answerable - its mulligan
        // never waits for anybody.
        press('start the game');

        expect(buttonTexts(human)).toContain('keep hand');
        expect(buttonTexts(bot)).not.toContain('keep hand');

        press('keep hand');

        // Both hands are settled, so the game has moved into the opening
        // turn: somebody is the active player, and no setup prompt survives.
        expect(game.activePlayer).toBeDefined();

        for (const player of game.getPlayers()) {
            expect(buttonTexts(player)).not.toContain('keep hand');
            expect(buttonTexts(player)).not.toContain('start the game');
        }
    }, 30000);

    it('concedes rather than wedges when the turn cap is reached', function () {
        const server = buildServer();

        server.onStartGame(
            buildPendingGame({
                id: 'capped-table',
                botMaxTurns: 0,
                players: {
                    HelperBot: botSeat('HelperBot', alphaDeck),
                    Sparring: botSeat('Sparring', omegaDeck)
                }
            })
        );

        const game = server.games['capped-table'];

        expect(game.winner).toBeDefined();
        expect(game.winReason).toBe('concede');
    }, 30000);

    /**
     * The node is single-threaded and shared. A bot that thinks for a minute
     * inside one call is not "a slow bot": the lobby's ping goes unanswered,
     * the node is declared timed out, and every game on it is cleared. So a
     * pump hands the loop back on a budget and finishes later.
     */
    it('hands the event loop back rather than holding the node', function () {
        const server = buildServer();

        server.onStartGame(
            buildPendingGame({
                id: 'budgeted-table',
                players: {
                    HelperBot: botSeat('HelperBot', alphaDeck, false),
                    Sparring: botSeat('Sparring', omegaDeck, false)
                }
            })
        );

        const game = server.games['budgeted-table'];
        const scheduled = [];

        // A budget of zero: every pump is out of time before it starts, so
        // this pins the handover itself rather than a duration.
        game.botDriver = new BotDriver(['HelperBot', 'Sparring'], {
            maxPumpMs: 0,
            schedule: (callback) => scheduled.push(callback),
            resume: () => game.botDriver.pump(game)
        });

        expect(game.botDriver.pump(game)).toBe(false);
        expect(game.winner).toBeUndefined();

        // It asked to be continued - once, however many times it is pumped,
        // so continuations cannot stack up.
        expect(scheduled.length).toBe(1);

        game.botDriver.pump(game);
        expect(scheduled.length).toBe(1);

        // And running the continuation asks for the next one, so the game
        // still progresses - one tick at a time.
        scheduled.pop()();
        expect(scheduled.length).toBe(1);
    }, 30000);

    /**
     * ARCHON (F9): the bot decides in microseconds. A whole turn arriving in
     * one frame reads as a glitch - cards already played, nothing to follow -
     * so each play waits a moment first, and the board goes out between them.
     */
    describe('playing at a pace a person can watch', function () {
        const pacedGame = (thinkMs) => {
            const server = buildServer();

            server.onStartGame(
                buildPendingGame({
                    id: 'paced-table',
                    players: {
                        HelperBot: botSeat('HelperBot', alphaDeck, false),
                        Human: botSeat('Human', omegaDeck, false)
                    }
                })
            );

            const game = server.games['paced-table'];
            const scheduled = [];

            game.botDriver = new BotDriver(['HelperBot'], {
                thinkMs,
                schedule: (callback, delay) => scheduled.push({ callback, delay }),
                resume: () => game.botDriver.pump(game)
            });

            return { game, scheduled };
        };

        it('thinks before its first play rather than answering instantly', function () {
            const { game, scheduled } = pacedGame(700);

            // Nothing dispatched yet: the bot is thinking.
            expect(game.botDriver.pump(game)).toBe(false);
            expect(scheduled.length).toBe(1);
            // Jittered around the configured pause, never metronomic.
            expect(scheduled[0].delay).toBeGreaterThanOrEqual(525);
            expect(scheduled[0].delay).toBeLessThanOrEqual(875);
        });

        it('plays one move per think, so a turn arrives as a sequence', function () {
            const { game, scheduled } = pacedGame(700);
            const before = game.botDriver.interactions;

            game.botDriver.pump(game);
            // Run the think: one play lands, and the next think is booked.
            scheduled.pop().callback();

            expect(game.botDriver.interactions).toBe(before + 1);
            expect(scheduled.length).toBe(1);
        });

        it('plays instantly when no pause is configured', function () {
            const { game, scheduled } = pacedGame(0);

            // Straight through: dispatched inside the call, with nothing
            // booked for later. Bot-vs-bot games and the specs want this.
            expect(game.botDriver.pump(game)).toBe(true);
            expect(game.botDriver.interactions).toBeGreaterThanOrEqual(1);
            expect(scheduled).toEqual([]);
        });
    });

    it('concedes rather than wedges when the interaction budget runs out', function () {
        const server = buildServer();

        // A plain (non-bot) start, so no driver is attached automatically and
        // the spec can run one with a tiny budget against the same game.
        server.onStartGame(
            buildPendingGame({
                id: 'budget-table',
                players: {
                    HelperBot: botSeat('HelperBot', alphaDeck, false),
                    Sparring: botSeat('Sparring', omegaDeck, false)
                }
            })
        );

        const game = server.games['budget-table'];

        game.botDriver = new BotDriver(['HelperBot', 'Sparring'], { maxInteractions: 10 });
        game.botDriver.pump(game);

        expect(game.winner).toBeDefined();
        expect(game.winReason).toBe('concede');
    }, 30000);

    /**
     * ARCHON (F9): the bug the showcase supervisor exists to avoid. Both of a
     * showcase table's seats are the platform's 'TBA' sentinel - there is no
     * human to ever hold a socket - and isEmpty() has always read that
     * sentinel as absence, because that is exactly what lets a PRACTICE table
     * close itself the moment its one human leaves. Left alone, the same rule
     * would read a showcase table as empty from the instant it starts and the
     * node's 30-second sweep (clearStaleAndFinishedGames) would close it
     * before a single turn completed.
     */
    describe('isEmpty, with no human ever seated', function () {
        it('is never empty when the table is a showcase game', function () {
            const server = buildServer();

            server.onStartGame(
                buildPendingGame({
                    id: 'showcase-table',
                    showcaseGame: true,
                    players: {
                        HelperBot: botSeat('HelperBot', alphaDeck),
                        Sparring: botSeat('Sparring', omegaDeck)
                    }
                })
            );

            expect(server.games['showcase-table'].isEmpty()).toBe(false);
        });

        it('is still empty for an ordinary two-bot game (no showcase flag)', function () {
            const server = buildServer();

            server.onStartGame(
                buildPendingGame({
                    id: 'plain-table',
                    players: {
                        HelperBot: botSeat('HelperBot', alphaDeck),
                        Sparring: botSeat('Sparring', omegaDeck)
                    }
                })
            );

            expect(server.games['plain-table'].isEmpty()).toBe(true);
        });

        it('still closes an ordinary practice table once its one human leaves', function () {
            const server = buildServer();

            server.onStartGame(
                buildPendingGame({
                    id: 'practice-table-empty',
                    players: {
                        HelperBot: botSeat('HelperBot', alphaDeck),
                        Human: botSeat('Human', omegaDeck, false)
                    }
                })
            );

            const game = server.games['practice-table-empty'];
            const human = game.getPlayerByName('Human');

            // botSeat() gives every seat 'TBA' for simplicity; give the human
            // a real connection id here, because that distinction - not the
            // showcase flag - is what isEmpty() actually keys on.
            human.id = 'socket-human';

            // Unchanged behaviour: the bot's 'TBA' seat still counts as
            // absent by design, and a real human still has to clear the
            // disconnect grace window before the table follows it into
            // "empty".
            expect(game.isEmpty()).toBe(false);

            human.disconnectedAt = new Date(Date.now() - 31 * 1000);

            expect(game.isEmpty()).toBe(true);
        });
    });
});
