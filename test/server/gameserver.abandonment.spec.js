const GameServer = require('../../server/gamenode/gameserver.js');

/**
 * ARCHON: the wiring that makes the abandonment forfeit actually run.
 *
 * `Game.checkAbandonment` is tested on its own in game.abandonment.spec.js.
 * What is tested here is that anything ever CALLS it - which is the whole
 * point, since the bug being fixed was precisely that nothing decided an
 * abandoned game unless a human pressed a button.
 *
 * Two call sites, and they cover different failures. The periodic sweep decides
 * games while the remaining player is still sitting at the board. `closeGame`
 * is the backstop: the last instant before the game is deleted from memory, and
 * the only chance to score a game BOTH players walked out on, because GAMECLOSED
 * persists nothing.
 *
 * The constructor connects to Redis, so the object under test is built from the
 * prototype - the same approach as gamenode.control.spec.js.
 */
const buildServer = (games = {}) => {
    const server = Object.create(GameServer.prototype);

    server.games = games;
    server.sent = [];
    server.pushed = [];
    server.gameSocket = { send: (command, arg) => server.sent.push({ command, arg }) };
    server.sendGameState = (game) => server.pushed.push(game.id);
    server.clearSpectatorDelay = () => {};
    server.handleError = (game, err) => {
        throw err;
    };

    return server;
};

const buildGame = (id, overrides = {}) => ({
    id,
    finishedAt: undefined,
    isEmpty: () => false,
    checkInactivity: () => false,
    checkAbandonment: () => false,
    continue: () => {},
    getPlayersAndSpectators: () => ({}),
    ...overrides
});

describe('game node abandonment sweep', function () {
    describe('the periodic sweep', function () {
        it('asks every live game whether it has been abandoned', function () {
            const asked = [];
            const games = {
                one: buildGame('one', {
                    checkAbandonment: (options) => {
                        asked.push(['one', options]);

                        return false;
                    }
                }),
                two: buildGame('two', {
                    checkAbandonment: (options) => {
                        asked.push(['two', options]);

                        return false;
                    }
                })
            };

            buildServer(games).clearStaleAndFinishedGames();

            // Undefined options: the sweep is not closing anything, so the
            // grace period applies and a dropped connection can still return.
            expect(asked).toEqual([
                ['one', undefined],
                ['two', undefined]
            ]);
        });

        it('pushes the new state when a game is decided', function () {
            let continued = false;
            const server = buildServer({
                abandoned: buildGame('abandoned', {
                    checkAbandonment: () => true,
                    continue: () => {
                        continued = true;
                    }
                })
            });

            server.clearStaleAndFinishedGames();

            // Without these the winner is recorded server-side but the player
            // still at the board sees the game sitting there unchanged.
            expect(continued).toBe(true);
            expect(server.pushed).toEqual(['abandoned']);
        });

        it('leaves an undecided game alone', function () {
            const server = buildServer({ live: buildGame('live') });

            server.clearStaleAndFinishedGames();

            expect(server.pushed).toEqual([]);
            expect(server.sent).toEqual([]);
        });

        it('carries on when one game throws', function () {
            const server = buildServer({
                broken: buildGame('broken', {
                    checkAbandonment: () => {
                        throw new Error('boom');
                    }
                }),
                fine: buildGame('fine', { checkAbandonment: () => true })
            });

            // runAndCatchErrors hands failures to handleError, which the real
            // server logs; here it rethrows, so swap it for a recorder.
            const errors = [];

            server.handleError = (game, err) => errors.push([game.id, err.message]);

            server.clearStaleAndFinishedGames();

            expect(errors).toEqual([['broken', 'boom']]);
            expect(server.pushed).toContain('fine');
        });
    });

    describe('closing a game', function () {
        it('takes a last chance to record a result before the game is destroyed', function () {
            const calls = [];
            const server = buildServer();
            const game = buildGame('doomed', {
                checkAbandonment: (options) => {
                    calls.push(options);

                    return true;
                }
            });

            server.closeGame(game);

            expect(calls).toEqual([{ closing: true }]);
        });

        it('decides the game before the sockets are torn down', function () {
            const order = [];
            const server = buildServer();

            server.clearSpectatorDelay = () => order.push('sockets');

            const game = buildGame('doomed', {
                checkAbandonment: () => {
                    order.push('decided');

                    return true;
                }
            });

            server.closeGame(game);

            expect(order).toEqual(['decided', 'sockets']);
            expect(server.sent).toEqual([{ command: 'GAMECLOSED', arg: { game: 'doomed' } }]);
        });

        it('still closes the game when the check throws', function () {
            const server = buildServer();
            const errors = [];

            server.handleError = (game, err) => errors.push(err.message);

            const game = buildGame('doomed', {
                checkAbandonment: () => {
                    throw new Error('boom');
                }
            });

            server.closeGame(game);

            expect(errors).toEqual(['boom']);
            expect(server.sent).toEqual([{ command: 'GAMECLOSED', arg: { game: 'doomed' } }]);
        });

        it('checks a game the lobby forces closed, which takes a different path', function () {
            const calls = [];
            const server = buildServer();

            server.games = {
                forced: buildGame('forced', {
                    checkAbandonment: (options) => {
                        calls.push(options);

                        return false;
                    }
                })
            };

            server.onCloseGame('forced');

            expect(calls).toEqual([{ closing: true }]);
            expect(server.sent).toEqual([{ command: 'GAMECLOSED', arg: { game: 'forced' } }]);
        });

        it('survives a player with no socket when the lobby forces a close', function () {
            // The regression: `disconnect()` nulls the socket, so the very
            // games that get force-closed - the ones somebody walked out of -
            // threw here, before the game was deleted or the lobby was told.
            const server = buildServer();
            const cleared = [];

            server.games = {
                forced: buildGame('forced', {
                    getPlayersAndSpectators: () => ({
                        quitter: { socket: undefined },
                        stayer: {
                            socket: {
                                send: (message) => cleared.push(message),
                                leaveChannel: () => {}
                            }
                        }
                    })
                })
            };

            server.onCloseGame('forced');

            expect(cleared).toEqual(['cleargamestate']);
            expect(server.games.forced).toBeUndefined();
            expect(server.sent).toEqual([{ command: 'GAMECLOSED', arg: { game: 'forced' } }]);
        });

        it('closes an empty game through the same path, so it gets the check', function () {
            const calls = [];
            const server = buildServer();

            server.games = {
                empty: buildGame('empty', {
                    isEmpty: () => true,
                    checkAbandonment: (options) => {
                        calls.push(options);

                        return false;
                    }
                })
            };

            server.clearStaleAndFinishedGames();

            // Both players gone is the case that used to vanish silently: the
            // game is swept as empty and GAMECLOSED persists nothing.
            expect(calls).toContainEqual({ closing: true });
            expect(server.sent).toEqual([{ command: 'GAMECLOSED', arg: { game: 'empty' } }]);
        });
    });
});
