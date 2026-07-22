const Lobby = require('../../server/lobby');
const PendingGame = require('../../server/pendinggame');

// These exercise the real Lobby.onLeaveGame / findGameForUser methods against a
// minimal `this`, without standing up the full Lobby (socket.io server, DB
// services). They cover the ARCHON fix: leaving a *started* game over the lobby
// socket must tear the game down on the node once every player has left, so a
// stranded player (dead game-node socket) can escape and no ghost lingers.

function makeUser(username) {
    return {
        username,
        blockList: [],
        hasUserBlocked: () => false,
        getDetails: () => ({ username }),
        getShortSummary: () => ({ username })
    };
}

describe('Lobby.onLeaveGame (started game)', function () {
    let lobby;
    let game;
    let closeGameCalls;
    let broadcasts;

    beforeEach(function () {
        closeGameCalls = [];
        broadcasts = [];

        const owner = makeUser('alice');
        game = new PendingGame(owner, { gameFormat: 'normal' });
        game.newGame('sock-alice', owner, undefined, true);
        game.join('sock-bob', makeUser('bob'));
        game.started = true;
        game.node = { identity: 'node-0' };

        lobby = {
            games: { [game.id]: game },
            router: { closeGame: (g) => closeGameCalls.push(g.id) },
            broadcastGameMessage: (msg, g) => broadcasts.push({ msg, id: g.id }),
            sendGameState: () => {},
            findGameForUser: Lobby.prototype.findGameForUser,
            onLeaveGame: Lobby.prototype.onLeaveGame
        };
    });

    function leave(username) {
        lobby.onLeaveGame({
            user: { username },
            send: () => {},
            leaveChannel: () => {}
        });
    }

    it('keeps the game (no node close) while an opponent is still playing', function () {
        leave('alice');

        expect(closeGameCalls).toEqual([]);
        expect(lobby.games[game.id]).toBeDefined();
        expect(broadcasts.some((b) => b.msg === 'updategame')).toBe(true);
    });

    it('closes the game on the node and removes it once both players have left', function () {
        leave('alice');
        leave('bob');

        expect(closeGameCalls).toEqual([game.id]);
        expect(lobby.games[game.id]).toBeUndefined();
        expect(broadcasts.some((b) => b.msg === 'removegame')).toBe(true);
    });

    it('still removes the lobby entry even if the node identity is missing', function () {
        game.node = {};

        leave('alice');
        leave('bob');

        expect(closeGameCalls).toEqual([]); // no node to close, but no crash
        expect(lobby.games[game.id]).toBeUndefined();
        expect(broadcasts.some((b) => b.msg === 'removegame')).toBe(true);
    });
});
