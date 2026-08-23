const GameServer = require('../../server/gamenode/gameserver.js');
const Settings = require('../../server/settings.js');
const { getCardIndex, cloneCard } = require('../../server/services/championschallenge/packCards');

/**
 * ARCHON (N50): the two facts the human ladder needs, stamped at the table.
 *
 * The lobby has always known that a table WAS a practice game (`botGame` on the
 * save state) and never which SEAT the bot held - so a result filed from the
 * save state alone would be credited to whichever name came first. And the
 * champion can be promoted while a game is being played, so reading the current
 * version when the game ends would file the result against a model that never
 * sat at the table.
 *
 * Both are therefore captured where they are true: the seat when the driver is
 * built, the version from the policy the lobby actually sent.
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
    server.flushDelayedStates = () => {};

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

describe('what a finished practice table reports for the human ladder', function () {
    const alphaDeck = buildDeck('alpha', ['brobnar', 'dis', 'logos']);
    const omegaDeck = buildDeck('omega', ['sanctum', 'shadows', 'untamed']);

    const start = (botPolicy) => {
        const server = buildServer();

        server.onStartGame({
            id: 'practice-table',
            name: 'Play against HelperBot!',
            owner: makeUser('Human'),
            gameFormat: 'normal',
            allowSpectators: false,
            botGame: true,
            botPolicy,
            botThinkMs: 0,
            players: {
                HelperBot: seat('HelperBot', alphaDeck, true),
                Human: seat('Human', omegaDeck, false)
            },
            spectators: {}
        });

        return { server, game: server.games['practice-table'] };
    };

    const win = (server, game, winnerName = 'Human') => {
        server.sent.length = 0;
        server.gameWon(game, 'keys', game.getPlayerByName(winnerName));

        return server.sent.find((message) => message.command === 'GAMEWIN').arg;
    };

    it('names the bot’s seat, so the result is not credited by guesswork', function () {
        const { server, game } = start({ version: 12, weights: {} });

        expect(win(server, game).botSeats).toEqual(['HelperBot']);
    });

    it('carries the model that actually played, not whatever reigns later', function () {
        const { server, game } = start({ version: 12, weights: {} });

        expect(win(server, game).botPolicyVersion).toBe(12);
    });

    it('reports version zero when the bot played the plain heuristics', function () {
        // `useLearnedPolicy` off, or a site with no champion yet: there is no
        // model to credit and the ladder row says so rather than inventing one.
        const { server, game } = start(null);

        expect(win(server, game).botPolicyVersion).toBe(0);
        expect(win(server, game).botSeats).toEqual(['HelperBot']);
    });

    it('reports no bot seat at an ordinary table between two people', function () {
        const server = buildServer();

        server.onStartGame({
            id: 'ordinary-table',
            name: 'A real game',
            owner: makeUser('One'),
            gameFormat: 'normal',
            allowSpectators: false,
            players: {
                One: seat('One', alphaDeck, false),
                Two: seat('Two', omegaDeck, false)
            },
            spectators: {}
        });

        const game = server.games['ordinary-table'];

        expect(win(server, game, 'One').botSeats).toEqual([]);
        expect(win(server, game, 'One').botPolicyVersion).toBe(0);
    });
});
