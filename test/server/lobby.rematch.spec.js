const Lobby = require('../../server/lobby');
const PendingGame = require('../../server/pendinggame');

/**
 * ARCHON: the rematch button.
 *
 * Reported as "the rematch button kicked us both out of the game and deleted
 * the game", and that is exactly what the handlers were built to do. Both of
 * them broadcast `removegame` and dropped the table out of `this.games` as
 * their first two statements, then went looking for the owner, their socket,
 * their deck, the opponent, the opponent's socket and the opponent's deck - six
 * ways to bail out or silently half-build the replacement, every one of them
 * after the point of no return. By then the node has already deleted its copy
 * of the game and sent both players back to the lobby, so any of those exits
 * left two people holding nothing.
 *
 * These drive the real handlers against a minimal `this`, the same approach as
 * lobby.onLeaveGame.spec.js. The invariant every one of them asserts is the
 * same: however the rematch fails, the players are never left with no game.
 */
function makeUser(username) {
    return {
        username,
        id: username,
        blockList: [],
        hasUserBlocked: () => false,
        getDetails: () => ({ username }),
        getShortSummary: () => ({ username })
    };
}

function makeSocket(username) {
    return {
        id: `sock-${username}`,
        user: makeUser(username),
        channels: [],
        joinChannel(id) {
            this.channels.push(id);
        },
        leaveChannel: () => {},
        send: () => {}
    };
}

describe('Lobby rematch', function () {
    let lobby;
    let table;
    let sockets;
    let broadcasts;

    beforeEach(function () {
        broadcasts = [];
        sockets = { alice: makeSocket('alice'), bob: makeSocket('bob') };

        table = new PendingGame(makeUser('alice'), { gameFormat: 'normal' });
        table.newGame('sock-alice', makeUser('alice'), undefined, true);
        table.join('sock-bob', makeUser('bob'));
        table.selectDeck('alice', { id: 11 });
        table.selectDeck('bob', { id: 22 });
        table.started = true;
        table.node = { identity: 'node-0' };

        lobby = {
            games: { [table.id]: table },
            socketsByName: sockets,
            // Keyed by socket id, the way the real lobby keeps it. Seating
            // falls back to this when the by-name entry is missing.
            sockets: Object.fromEntries(
                Object.values(sockets).map((socket) => [socket.id, socket])
            ),
            broadcastGameMessage: (msg, game) => broadcasts.push({ msg, id: game.id }),
            sendGameState: () => {},
            started: null,
            // Mirrors the real one closely enough to matter: it resolves on a
            // later tick, which is what lets the synchronous seating loop finish
            // before any deck lands.
            onSelectDeck: async (socket, gameId, deckId) => {
                await Promise.resolve();
                lobby.games[gameId]?.selectDeck(socket.user.username, { id: deckId });
            },
            onStartGame: (socket, gameId) => {
                const game = lobby.games[gameId];

                if (
                    !game ||
                    Object.values(game.getPlayers()).length < 2 ||
                    !game.isOwner(socket.user.username) ||
                    Object.values(game.getPlayers()).some((player) => !player.deck)
                ) {
                    return;
                }

                game.started = true;
                lobby.started = gameId;
            },
            rematchSeating: Lobby.prototype.rematchSeating,
            refuseRematch: Lobby.prototype.refuseRematch,
            onGameRematch: Lobby.prototype.onGameRematch,
            onGameRematchWithNewDecks: Lobby.prototype.onGameRematchWithNewDecks
        };
    });

    /** What the game node publishes when a rematch is agreed. */
    const nodeSaveState = (game) => ({
        gameId: game.id,
        // getSaveState() maps deck to `player.deckData.identity` - a STRING.
        // The handlers used to fall back to it and read `.id` off it, which is
        // always undefined, so the fallback could only ever fire the bail-out
        // it existed to prevent.
        players: Object.values(game.getPlayers()).map((player) => ({
            name: player.name,
            deck: `${player.name}-identity`,
            wins: 3
        })),
        winner: 'alice',
        swap: false
    });

    const rematch = async (handler = 'onGameRematch') => {
        lobby[handler](nodeSaveState(table));

        // Two ticks: one for the deck selections, one for the Promise.all.
        await Promise.resolve();
        await Promise.resolve();
        await new Promise((resolve) => setImmediate(resolve));
    };

    const onlyGame = () => Object.values(lobby.games)[0];

    describe('same decks', function () {
        it('seats both players at a new table and starts it', async function () {
            await rematch();

            const game = onlyGame();

            expect(game.id).not.toBe(table.id);
            expect(Object.keys(game.players).sort()).toEqual(['alice', 'bob']);
            expect(game.players.alice.deck.id).toBe(11);
            expect(game.players.bob.deck.id).toBe(22);
            expect(lobby.started).toBe(game.id);
        });

        it('adds the owner as a player', async function () {
            // Every other newGame() call site passes `join: true`; both rematch
            // handlers omitted it, so the owner was never added to the game
            // being built for them. A second bug hid it - the loop filtered on
            // `owner.username`, and a player record has `name` and no
            // `username`, so the filter excluded nobody and seated the owner by
            // accident.
            await rematch();

            expect(onlyGame().players.alice).toBeDefined();
            expect(onlyGame().players.alice.owner).toBe(true);
            expect(onlyGame().isOwner('alice')).toBe(true);
        });

        it('puts both players in the new channel, not just the owner', async function () {
            await rematch();

            const game = onlyGame();

            expect(sockets.alice.channels).toContain(game.id);
            expect(sockets.bob.channels).toContain(game.id);
        });

        it('carries the running score over', async function () {
            await rematch();

            expect(onlyGame().players.alice.wins).toBe(3);
            expect(onlyGame().players.bob.wins).toBe(3);
        });

        it('announces the new game only after everybody is seated', async function () {
            // Sent before, `newgame`/`gamestate` described a game with no
            // players in it, so it reached nobody.
            await rematch();

            const announced = broadcasts.find((entry) => entry.msg === 'newgame');

            expect(announced).toBeDefined();
            expect(Object.keys(lobby.games[announced.id].players).length).toBe(2);
        });
    });

    describe('when the rematch cannot be built', function () {
        const cases = [
            [
                'the opponent lost their lobby socket',
                () => {
                    delete lobby.socketsByName.bob;
                    delete lobby.sockets['sock-bob'];
                }
            ],
            ['the opponent has no deck on the table', () => delete table.players.bob.deck],
            ['the opponent left the game first', () => table.leave('bob')],
            ['the owner left the game first', () => table.leave('alice')]
        ];

        for (const [label, breakIt] of cases) {
            describe(label, function () {
                beforeEach(async function () {
                    breakIt();
                    await rematch();
                });

                it('leaves the players their table instead of nothing', function () {
                    expect(Object.keys(lobby.games)).toEqual([table.id]);
                });

                it('puts the table back to pending, so it can be started again', function () {
                    // The node has already torn down its copy, so a table still
                    // marked started is one nobody can enter and the lobby would
                    // advertise as in progress forever.
                    expect(onlyGame().started).toBe(false);
                    expect(onlyGame().node).toBeUndefined();
                });

                it('never broadcasts removegame', function () {
                    expect(broadcasts.some((entry) => entry.msg === 'removegame')).toBe(false);
                });
            });
        }
    });

    describe('a player whose name lookup has gone stale', function () {
        it('is still seated from the socket the table recorded', async function () {
            // A lobby socket that was replaced (a reconnect, a second tab)
            // used to take the by-name entry with it when the old one finally
            // timed out, and the rematch was then refused as "no longer
            // connected" - dropping two people who had just agreed to play
            // again out of their game.
            delete lobby.socketsByName.bob;

            await rematch();

            const game = onlyGame();

            expect(game.id).not.toBe(table.id);
            expect(Object.keys(game.players).sort()).toEqual(['alice', 'bob']);
            expect(lobby.started).toBe(game.id);
        });
    });

    describe('a refused trade-decks rematch', function () {
        beforeEach(async function () {
            delete lobby.socketsByName.bob;
            delete lobby.sockets['sock-bob'];

            // What the node publishes once both players have agreed to trade:
            // it has already toggled the flag.
            lobby.onGameRematch({ ...nodeSaveState(table), swap: true });
            await new Promise((resolve) => setImmediate(resolve));
        });

        it('keeps the trade the players agreed to', function () {
            // The table comes back so they can press Start - and pressing it
            // has to do what they voted for. It used to hand back a table with
            // the swap dropped, so the game they got was the one they had just
            // agreed not to play.
            expect(onlyGame().swap).toBe(true);
        });

        it('says so, rather than leaving them to notice', function () {
            const messages = table.gameChat.messages.map((message) =>
                JSON.stringify(message.message)
            );

            expect(messages.some((message) => message.includes('press Start'))).toBe(true);
            expect(messages.some((message) => message.includes('swaps them over'))).toBe(true);
        });
    });

    describe('a deck selection that fails', function () {
        it('does not take the process down with an unhandled rejection', async function () {
            // `Promise.all(promises).then(...)` had no catch. A rejection here
            // skipped onStartGame AND, under Node's default policy, terminated
            // the lobby - every game on it, not just this one.
            lobby.onSelectDeck = async () => {
                throw new Error('deck service exploded');
            };

            await expect(rematch()).resolves.toBeUndefined();

            // The table is still there to recover from, unstarted.
            expect(Object.keys(lobby.games).length).toBe(1);
            expect(lobby.started).toBeNull();
        });
    });

    describe('tournament tables', function () {
        it('are refused without being touched at all', async function () {
            table.tournament = { matchId: 'm1' };

            await rematch();

            expect(Object.keys(lobby.games)).toEqual([table.id]);
            // Refused, not "recovered" - the event's table was never in danger,
            // so it must not be reset to pending either.
            expect(onlyGame().started).toBe(true);
            expect(onlyGame().node).toEqual({ identity: 'node-0' });
            expect(broadcasts).toEqual([]);
        });
    });

    describe('pick new decks', function () {
        it('seats both players with no decks and leaves the table pending', async function () {
            await rematch('onGameRematchWithNewDecks');

            const game = onlyGame();

            expect(game.id).not.toBe(table.id);
            expect(Object.keys(game.players).sort()).toEqual(['alice', 'bob']);
            expect(game.started).toBeFalsy();
            // The owner keeps theirs on screen as a starting point; the
            // opponent picks from scratch.
            expect(game.players.alice.deck.id).toBe(11);
            expect(game.players.bob.deck).toBeUndefined();
        });

        it('does not need anybody to hold a deck first', async function () {
            // Nobody is required to have one - they are all about to choose.
            delete table.players.alice.deck;
            delete table.players.bob.deck;

            await rematch('onGameRematchWithNewDecks');

            expect(onlyGame().id).not.toBe(table.id);
            expect(Object.keys(onlyGame().players).sort()).toEqual(['alice', 'bob']);
        });

        it('still keeps the table when a player cannot be seated', async function () {
            delete lobby.socketsByName.bob;
            delete lobby.sockets['sock-bob'];

            await rematch('onGameRematchWithNewDecks');

            expect(Object.keys(lobby.games)).toEqual([table.id]);
            expect(onlyGame().started).toBe(false);
        });
    });
});
