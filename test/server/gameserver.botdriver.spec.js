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

const buildPendingGame = ({ id, players, botMaxTurns }) => ({
    id,
    name: 'Play against HelperBot!',
    owner: makeUser(Object.keys(players)[0]),
    gameFormat: 'normal',
    allowSpectators: false,
    botGame: true,
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

describe('game node bot driver', function () {
    const alphaDeck = buildDeck('alpha', ['brobnar', 'dis', 'logos']);
    const omegaDeck = buildDeck('omega', ['sanctum', 'shadows', 'untamed']);

    it('plays a bot-vs-bot game to a legitimate win through onStartGame alone', function () {
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
});
