const GameServer = require('../../server/gamenode/gameserver.js');
const { BotPolicy } = require('../../server/services/botplayer/BotPolicy.js');
const HumanCapture = require('../../server/gamenode/humancapture.js');
const Settings = require('../../server/settings.js');
const { getCardIndex, cloneCard } = require('../../server/services/championschallenge/packCards');
const { ACTION_KINDS } = require('../../server/services/championschallenge/labFeatures');

/**
 * ARCHON (N45): the bot learning from a person, through the real wiring.
 *
 * Every other spec for this feature drives stand-ins. This one plays a whole
 * practice game on the real engine, with the human seat's every input going
 * through `onGameMessage` exactly as a browser's would - because the failure
 * this feature is most exposed to is not a wrong number, it is a capture that
 * quietly writes NOTHING against real prompt shapes while every unit test
 * agrees it works.
 *
 * The human seat is driven by BotPolicy, which is fair: it enumerates and
 * clicks the same way a person does (click a card, answer its menu), so it
 * exercises the two-step main-window path rather than a shortcut.
 */

/** A legal-shaped 36-card deck, built from the pack data production uses. */
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
            optionSettings: { orderForcedAbilities: false, confirmOneClick: false }
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

const seat = (name, deck, isBot) => ({
    id: 'TBA',
    name,
    user: makeUser(name),
    isBot,
    wins: 0,
    deck
});

const pendingGame = ({ id, players, learnFromHumans }) => ({
    id,
    name: 'Play against HelperBot!',
    owner: makeUser(Object.keys(players)[0]),
    gameFormat: 'normal',
    allowSpectators: false,
    botGame: true,
    learnFromHumans,
    players,
    spectators: {}
});

/** Deterministic, so a failure here is reproducible. */
const seeded = (state) => () => {
    state |= 0;
    state = (state + 0x6d2b79f5) | 0;

    let t = Math.imul(state ^ (state >>> 15), 1 | state);

    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;

    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

/**
 * The human's hands: BotPolicy decides, but every input it dispatches goes
 * out through the socket path a browser uses, so the capture sees exactly what
 * production sees.
 */
const throughTheSocket = (server, socket) => ({
    cardClicked: (name, uuid) => server.onGameMessage(socket, 'cardClicked', uuid),
    menuButton: (name, arg, uuid, method) =>
        server.onGameMessage(socket, 'menuButton', arg, uuid, method),
    clickProphecy: (name, uuid) => server.onGameMessage(socket, 'clickProphecy', uuid)
});

const playOut = async (server, game, human, timeoutMs = 90000) => {
    const socket = { user: { username: human.name } };
    const policy = new BotPolicy({ rng: seeded(11) });
    const client = throughTheSocket(server, socket);
    const deadline = Date.now() + timeoutMs;

    while (!game.winner && Date.now() < deadline) {
        if (!policy.respond(client, human)) {
            // No prompt for the human: the bot is thinking, on its own ticks.
            await new Promise((resolve) => setTimeout(resolve, 2));
        }
    }

    return game.winner;
};

describe('learning from a human game, through the real node', function () {
    const alphaDeck = buildDeck('alpha', ['brobnar', 'dis', 'logos']);
    const omegaDeck = buildDeck('omega', ['sanctum', 'shadows', 'untamed']);

    const start = (learnFromHumans) => {
        const server = buildServer();

        server.onStartGame(
            pendingGame({
                id: 'practice-table',
                learnFromHumans,
                players: {
                    HelperBot: seat('HelperBot', alphaDeck, true),
                    Human: seat('Human', omegaDeck, false)
                }
            })
        );

        return { server, game: server.games['practice-table'] };
    };

    it('captures a whole game of a person’s real decisions', async function () {
        const { server, game } = start(true);
        const human = game.getPlayerByName('Human');

        expect(game.humanCapture).toBeInstanceOf(HumanCapture);

        await playOut(server, game, human);

        expect(game.winner).toBeDefined();

        // Real games are long. A capture that produced a handful of rows over
        // a full game is a capture that is missing most of the prompts, which
        // is the failure mode a unit test cannot see. This run captures around
        // five decisions per round; two is a floor, not a target.
        expect(game.humanCapture.decisions.length).toBeGreaterThan(game.round * 2);

        // Every row is the human's, and every row is a move the model has a
        // weight for - a kind outside the contract is a silent dead end.
        for (const decision of game.humanCapture.decisions) {
            expect(decision.side).toBe('Human');
            expect(decision.state.bias).toBe(1);

            const kind = ACTION_KINDS.find((entry) => decision.action[`act:${entry}`] === 1);

            expect(kind).toBeDefined();
        }

        // The moves that matter most are there: the main window, and the house
        // call that opens every turn.
        const kinds = new Set(
            game.humanCapture.decisions.flatMap((decision) =>
                ACTION_KINDS.filter((kind) => decision.action[`act:${kind}`] === 1)
            )
        );

        expect(kinds).toContain('houseCall');
        expect([...kinds].some((kind) => kind.startsWith('play') || kind === 'reap')).toBe(true);

        // Breadth is the real check. A capture that quietly stopped seeing one
        // shape of prompt - selections, say, or the card menu - would still
        // produce plenty of rows and would still pass every count. This run
        // covers every kind in the contract; five is a floor with room for the
        // draw to differ.
        expect(kinds.size).toBeGreaterThanOrEqual(5);
    }, 120000);

    it('ships the game to the lobby with GAMEWIN, labelled by who won', async function () {
        const { server, game } = start(true);

        await playOut(server, game, game.getPlayerByName('Human'));

        const [win] = server.sent.filter((message) => message.command === 'GAMEWIN');

        expect(win).toBeDefined();
        expect(win.arg.humanGame.winnerSide).toBe(game.winner.name);
        expect(win.arg.humanGame.decisions.length).toBe(game.humanCapture.decisions.length);
    }, 120000);

    it('captures nothing at a table the lobby did not mark', async function () {
        // The setting lives in the lobby; the node does as it is told. A table
        // that started before capture was switched on finishes the way it
        // started.
        const { server, game } = start(undefined);
        const human = game.getPlayerByName('Human');

        expect(game.humanCapture).toBeUndefined();

        await playOut(server, game, human);

        const [win] = server.sent.filter((message) => message.command === 'GAMEWIN');

        expect(win.arg.humanGame).toBeNull();
    }, 120000);

    it('says so at the table, every time', function () {
        const { game } = start(true);
        const said = game.messages
            .map((message) => JSON.stringify(message.message))
            .join(' ')
            .toLowerCase();

        expect(said).toContain('train the practice bots');
        expect(said).toContain('never who made them');
    });
});
