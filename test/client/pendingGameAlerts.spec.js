import { getPendingGameJoinAlert } from '../../client/Components/Games/pendingGameAlerts.js';

const player = (name) => ({ name, avatar: `${name}-avatar` });

const game = (overrides = {}) => ({
    owner: 'host',
    quickMatch: false,
    players: {},
    ...overrides
});

const bothPlayers = { host: player('host'), guest: player('guest') };

describe('getPendingGameJoinAlert', function () {
    describe('a game someone joins', function () {
        it('alerts the host when the second player arrives', function () {
            const alert = getPendingGameJoinAlert({
                game: game({ players: bothPlayers }),
                username: 'host',
                previousPlayerCount: 1
            });

            expect(alert).toBeTruthy();
            expect(alert.opponent.name).toBe('guest');
            expect(alert.notify).toBe(true);
            expect(alert.body).toBe('guest has joined your game');
        });

        it('alerts the player who joined, without interrupting them with a notification', function () {
            const alert = getPendingGameJoinAlert({
                game: game({ players: bothPlayers }),
                username: 'guest',
                previousPlayerCount: 0
            });

            expect(alert).toBeTruthy();
            expect(alert.opponent.name).toBe('host');
            // The cue plays, but the browser should not tell them what they just did.
            expect(alert.notify).toBe(false);
        });

        it('stays quiet while the host is waiting alone', function () {
            expect(
                getPendingGameJoinAlert({
                    game: game({ players: { host: player('host') } }),
                    username: 'host',
                    previousPlayerCount: 0
                })
            ).toBeNull();
        });
    });

    describe('a Quick Match', function () {
        // The matchmaker builds the game with both players already in it, so the
        // client goes straight from 0 to 2 players. The old 1 -> 2 guard missed
        // this entirely and matchmade games were silent.
        it('alerts the player the matchmaker named as owner', function () {
            const alert = getPendingGameJoinAlert({
                game: game({ players: bothPlayers, quickMatch: true }),
                username: 'host',
                previousPlayerCount: 0
            });

            expect(alert).toBeTruthy();
            expect(alert.notify).toBe(true);
            expect(alert.body).toBe('guest is your Quick Match opponent');
        });

        it('alerts the other player too, who owns nothing', function () {
            const alert = getPendingGameJoinAlert({
                game: game({ players: bothPlayers, quickMatch: true }),
                username: 'guest',
                previousPlayerCount: 0
            });

            expect(alert).toBeTruthy();
            expect(alert.opponent.name).toBe('host');
            // Both players were waiting in the queue, so both want telling.
            expect(alert.notify).toBe(true);
            expect(alert.body).toBe('host is your Quick Match opponent');
        });
    });

    describe('cases that must stay silent', function () {
        it('ignores spectators, who are not about to play', function () {
            expect(
                getPendingGameJoinAlert({
                    game: game({ players: bothPlayers }),
                    username: 'watcher',
                    previousPlayerCount: 0
                })
            ).toBeNull();
        });

        it('does not fire again on later updates to an already full game', function () {
            expect(
                getPendingGameJoinAlert({
                    game: game({ players: bothPlayers }),
                    username: 'host',
                    previousPlayerCount: 2
                })
            ).toBeNull();
        });

        it('does not fire when a player leaves a full game', function () {
            expect(
                getPendingGameJoinAlert({
                    game: game({ players: { host: player('host') } }),
                    username: 'host',
                    previousPlayerCount: 2
                })
            ).toBeNull();
        });

        it('handles a missing game, user or player list', function () {
            expect(
                getPendingGameJoinAlert({ game: null, username: 'host', previousPlayerCount: 1 })
            ).toBeNull();
            expect(
                getPendingGameJoinAlert({
                    game: game({ players: bothPlayers }),
                    username: undefined,
                    previousPlayerCount: 1
                })
            ).toBeNull();
            expect(
                getPendingGameJoinAlert({
                    game: game({ players: undefined }),
                    username: 'host',
                    previousPlayerCount: 1
                })
            ).toBeNull();
        });
    });
});
