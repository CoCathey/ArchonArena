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
        expect(this.game.winReason).toBe('abandoned');
        expect(this.game.router.gameWon).toHaveBeenCalledWith(
            this.game,
            'abandoned',
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
        expect(this.game.winReason).toBe('abandoned');
    });

    it('does not record a winner when the opponent is still present (client concede handles that)', function () {
        this.game.leave(this.player1.player.name);

        expect(this.game.winner).toBeFalsy();
        expect(this.game.router.gameWon).not.toHaveBeenCalled();
    });

    /**
     * ARCHON: the half of this rule that was missing.
     *
     * `checkAbandonment` has always refused to charge a loss to somebody whose
     * client never reached the game node; this path did not, so a table that
     * auto-started against an absent seat was scored in full the moment the
     * player who WAS there pressed Leave. In a tournament that is a recorded
     * result: the event counts the game, moves the series on and opens the next
     * one, for a game in which no card was played. Reported exactly that way.
     */
    it('records nothing when the opponent never reached the game', function () {
        this.player2.player.connectionSucceeded = false;
        this.player2.player.disconnectedAt = new Date();

        this.game.leave(this.player1.player.name);

        expect(this.game.winner).toBeFalsy();
        expect(this.game.router.gameWon).not.toHaveBeenCalled();
    });

    it('records nothing when the opponent’s handoff failed', function () {
        this.player2.player.disconnectedAt = new Date();
        this.player2.player.connectFailed = true;

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

    /**
     * ARCHON: a player of this game cannot become a spectator of it.
     *
     * The event page's "Rejoin game" button sent `watchgame` for a table that
     * had already started, and `watch` replaced the Player object - the seat,
     * its deck, its hand, its clock - with a Spectator. The player was then
     * watching a game they were still notionally in, with their own side of it
     * gone.
     */
    it('refuses to turn a seated player into a spectator of their own game', function () {
        const seat = this.player1.player;

        expect(
            this.game.watch('another-socket', {
                username: seat.name,
                permissions: {},
                settings: {}
            })
        ).toBe(false);
        expect(this.game.playersAndSpectators[seat.name]).toBe(seat);
        expect(this.game.isSpectator(this.game.playersAndSpectators[seat.name])).toBe(false);
    });
});
