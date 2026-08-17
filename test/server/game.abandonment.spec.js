/**
 * ARCHON: quitting by closing the site.
 *
 * The reported bug: "when someone leaves the game on purpose just by closing
 * the site it doesn't count on their record". It didn't. `disconnect()` marks
 * the player away and nothing else ever decided the game, so the result rested
 * entirely on the opponent going back to the board and pressing Leave. If they
 * closed their own tab instead - the obvious thing to do when the person you
 * are playing has vanished - the game was swept up as empty and closed with
 * GAMECLOSED, which persists nothing. No winner, no FinishedAt, so nothing the
 * profile query ("WinnerId IS NOT NULL") would ever count.
 *
 * These cover the timer that decides it without anybody watching, and - just
 * as important - the cases that must NOT be forfeited: a player who reconnects,
 * a pair whose connections died together, and somebody taking up the standing
 * offer to leave an idle opponent without recording a loss.
 */
describe('Game.checkAbandonment', function () {
    beforeEach(function () {
        this.setupTest({
            player1: { house: 'untamed', inPlay: ['flaxia'] },
            player2: { house: 'shadows', inPlay: ['lamindra'] }
        });
        this.game.router.gameWon = vi.fn();

        this.p1 = this.player1.player;
        this.p2 = this.player2.player;

        // How long ago, in milliseconds.
        this.wentAt = (ms) => new Date(Date.now() - ms);
    });

    describe('one player gone', function () {
        it('awards the game once the timeout has passed', function () {
            this.p2.disconnectedAt = this.wentAt(this.game.abandonmentTimeoutMs + 1000);

            expect(this.game.checkAbandonment()).toBe(true);
            expect(this.game.winner).toBe(this.p1);
            expect(this.game.winReason).toBe('abandoned');
            expect(this.game.router.gameWon).toHaveBeenCalledWith(this.game, 'abandoned', this.p1);
        });

        it('waits out the timeout first, so a reconnect is still possible', function () {
            this.p2.disconnectedAt = this.wentAt(10 * 1000);

            expect(this.game.checkAbandonment()).toBe(false);
            expect(this.game.winner).toBeFalsy();
            expect(this.game.router.gameWon).not.toHaveBeenCalled();
        });

        it('decides immediately when the game is being closed', function () {
            // No point holding a seat open for somebody on a game that is
            // about to stop existing.
            this.p2.disconnectedAt = this.wentAt(1000);

            expect(this.game.checkAbandonment({ closing: true })).toBe(true);
            expect(this.game.winner).toBe(this.p1);
        });

        it('records nothing once they have reconnected', function () {
            this.p2.disconnectedAt = this.wentAt(this.game.abandonmentTimeoutMs + 1000);
            this.game.reconnect({ id: 'socket-2' }, this.p2.name);

            expect(this.game.checkAbandonment()).toBe(false);
            expect(this.game.winner).toBeFalsy();
        });

        it('does not forfeit a player who never reached the game node', function () {
            // failedConnect writes the same disconnectedAt a quitter does, but
            // it means the client never got here at all - they have not seen
            // the board, so there is nothing they walked out of.
            this.game.failedConnect(this.p2.name);
            this.p2.disconnectedAt = this.wentAt(this.game.abandonmentTimeoutMs + 1000);

            expect(this.game.checkAbandonment({ closing: true })).toBe(false);
            expect(this.game.winner).toBeFalsy();
        });

        it('forfeits them normally once they do connect and then quit', function () {
            this.game.failedConnect(this.p2.name);
            this.game.reconnect({ id: 'socket-2' }, this.p2.name);
            this.game.disconnect(this.p2.name);
            this.p2.disconnectedAt = this.wentAt(this.game.abandonmentTimeoutMs + 1000);

            expect(this.game.checkAbandonment()).toBe(true);
            expect(this.game.winner).toBe(this.p1);
        });

        it('does not hand the game to an opponent who left of their own accord', function () {
            // The standing offer in chat: facing an opponent idle for five
            // minutes, you "may leave the game without recording a loss".
            // Their connection dropping afterwards must not turn that into a
            // win for them.
            this.game.leave(this.p1.name);
            this.p2.disconnectedAt = this.wentAt(this.game.abandonmentTimeoutMs + 1000);

            expect(this.game.checkAbandonment()).toBe(false);
            expect(this.game.winner).toBeFalsy();
        });
    });

    describe('both players gone', function () {
        it('scores it against whoever went first, when the game is closed', function () {
            this.p2.disconnectedAt = this.wentAt(90 * 1000);
            this.p1.disconnectedAt = this.wentAt(30 * 1000);

            expect(this.game.checkAbandonment({ closing: true })).toBe(true);
            expect(this.game.winner).toBe(this.p1);
            expect(this.game.winReason).toBe('abandoned');
        });

        it('holds off while the game is still alive', function () {
            // Either of them may still come back; only closing forces a call.
            this.p2.disconnectedAt = this.wentAt(90 * 1000);
            this.p1.disconnectedAt = this.wentAt(30 * 1000);

            expect(this.game.checkAbandonment()).toBe(false);
            expect(this.game.winner).toBeFalsy();
        });

        it('records nothing when both dropped at once', function () {
            // Two sockets closing within moments of each other is the network,
            // not two people deciding to quit. There is no honest winner here.
            this.p1.disconnectedAt = this.wentAt(61 * 1000);
            this.p2.disconnectedAt = this.wentAt(60 * 1000);

            expect(this.game.checkAbandonment({ closing: true })).toBe(false);
            expect(this.game.winner).toBeFalsy();
            expect(this.game.router.gameWon).not.toHaveBeenCalled();
        });
    });

    describe('games it must leave alone', function () {
        it('does not re-decide a game that already has a winner', function () {
            this.game.recordWinner(this.p1, 'keys');
            this.game.router.gameWon.mockClear();

            this.p2.disconnectedAt = this.wentAt(this.game.abandonmentTimeoutMs + 1000);

            expect(this.game.checkAbandonment({ closing: true })).toBe(false);
            expect(this.game.winner).toBe(this.p1);
            expect(this.game.winReason).toBe('keys');
            expect(this.game.router.gameWon).not.toHaveBeenCalled();
        });

        it('does not touch a game that never started', function () {
            this.game.started = false;
            this.p2.disconnectedAt = this.wentAt(this.game.abandonmentTimeoutMs + 1000);

            expect(this.game.checkAbandonment({ closing: true })).toBe(false);
            expect(this.game.winner).toBeFalsy();
        });

        it('records nothing while both players are connected', function () {
            expect(this.game.checkAbandonment({ closing: true })).toBe(false);
            expect(this.game.winner).toBeFalsy();
        });

        it('ignores a spectator who disconnected', function () {
            // Spectators are deleted on disconnect rather than marked away, but
            // the guard is worth pinning: they are not players and cannot lose.
            expect(this.game.getPlayers().length).toBe(2);

            this.game.disconnect('nobody-in-this-game');

            expect(this.game.checkAbandonment({ closing: true })).toBe(false);
            expect(this.game.winner).toBeFalsy();
        });
    });

    describe('the whole path, from closing the tab', function () {
        it('scores the quitter a loss without the opponent doing anything', function () {
            // Exactly what the bug report describes: player2 closes the site.
            this.game.disconnect(this.p2.name);

            expect(this.p2.disconnectedAt).toBeTruthy();
            expect(this.game.checkAbandonment()).toBe(false); // still inside the grace period

            // Time passes. player1 has not clicked anything at all.
            this.p2.disconnectedAt = this.wentAt(this.game.abandonmentTimeoutMs + 1);

            expect(this.game.checkAbandonment()).toBe(true);

            const saved = this.game.getSaveState();

            expect(saved.winner).toBe(this.p1.name);
            expect(saved.winReason).toBe('abandoned');
            expect(saved.finishedAt).toBeTruthy();
        });
    });
});
