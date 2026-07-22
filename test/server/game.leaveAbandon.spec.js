describe('Game.leave (abandonment rating)', function () {
    beforeEach(function () {
        this.setupTest({
            player1: { house: 'untamed', inPlay: ['flaxia'] },
            player2: { house: 'shadows', inPlay: ['lamindra'] }
        });
        this.game.router.gameWon = vi.fn();
    });

    it('awards the game to a player who leaves after the opponent disconnected', function () {
        // Opponent (player2) abandons by disconnecting.
        this.player2.player.disconnectedAt = new Date();

        this.game.leave(this.player1.player.name);

        expect(this.game.winner).toBe(this.player1.player);
        expect(this.game.winReason).toBe('concede');
        expect(this.game.router.gameWon).toHaveBeenCalledWith(
            this.game,
            'concede',
            this.player1.player
        );
    });

    it('makes the first player to leave a started game the loser', function () {
        // player2 leaves first while player1 is still present: player1 wins
        // when they subsequently leave the now-abandoned game.
        this.game.leave(this.player2.player.name);
        expect(this.game.winner).toBeFalsy(); // opponent (p1) still present -> no result yet

        this.game.leave(this.player1.player.name);
        expect(this.game.winner).toBe(this.player1.player);
        expect(this.game.winReason).toBe('concede');
    });

    it('does not record a winner when the opponent is still present (client concede handles that)', function () {
        this.game.leave(this.player1.player.name);

        expect(this.game.winner).toBeFalsy();
        expect(this.game.router.gameWon).not.toHaveBeenCalled();
    });

    it('does not override an already-decided game', function () {
        this.game.recordWinner(this.player2.player, 'keys');
        this.game.router.gameWon.mockClear();

        this.player2.player.disconnectedAt = new Date();
        this.game.leave(this.player1.player.name);

        // Winner stays player2; leaving does not steal the win.
        expect(this.game.winner).toBe(this.player2.player);
        expect(this.game.router.gameWon).not.toHaveBeenCalled();
    });
});
