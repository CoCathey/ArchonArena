/**
 * ARCHON: the post-game menu at a tournament table.
 *
 * A tournament table offers the next game of its series and never a rematch
 * (a rematch would build a table the event knows nothing about). The one thing
 * it used to get wrong: it judged "is there a next game" from the game number
 * alone, so a 2-0 in a best of three still offered "Play Game 3", and the
 * lobby had to turn the players away. The seats now carry the series score,
 * and the menu reads it.
 */
describe('GameWonPrompt at a tournament table', function () {
    beforeEach(function () {
        this.setupTest({
            player1: { house: 'untamed', inPlay: ['flaxia'] },
            player2: { house: 'shadows', inPlay: ['lamindra'] }
        });
        this.game.router.tournamentNextGame = vi.fn();
        this.game.router.rematch = vi.fn();

        /**
         * Finish the game at a tournament table. Player 2 wins by concession;
         * `winsBefore` is the series score player 2 brought to the table.
         */
        this.finish = (tournament, winsBefore = 0) => {
            this.game.tournament = { tournamentId: 1, matchId: 5, players: [], ...tournament };

            if (winsBefore) {
                this.game.setWins(this.player2.player.name, winsBefore);
            }

            this.game.concede(this.player1.player.name);
            this.game.continue();
        };
    });

    it('offers the next game while the series is undecided', function () {
        this.finish({ gameNumber: 1, bestOf: 3 });

        expect(this.player1.currentButtons).toContain('Play Game 2');
        expect(this.player1.currentPrompt().menuTitle).toContain('Start the next game here');
    });

    it('offers nothing further once a player has won enough games', function () {
        // Player 2 came in 1-0 and has just won again: 2-0, series over.
        this.finish({ gameNumber: 2, bestOf: 3 }, 1);

        expect(this.player1.currentButtons).not.toContain('Play Game 3');
        expect(this.player1.currentButtons).toContain('Continue Playing');
        expect(this.player1.currentPrompt().menuTitle).toContain('decided the series');
    });

    it('offers the deciding game at 1-1', function () {
        // Player 1 won game one; player 2 has just levelled it.
        this.game.setWins(this.player1.player.name, 1);
        this.finish({ gameNumber: 2, bestOf: 3 });

        expect(this.player1.currentButtons).toContain('Play Game 3');
    });

    it('offers nothing further at the last game of the series', function () {
        this.finish({ gameNumber: 3, bestOf: 3 });

        expect(this.player1.currentButtons).not.toContain('Play Game 4');
        expect(this.player1.currentPrompt().menuTitle).toContain('last game of the series');
    });

    it('offers nothing further in a single-game match', function () {
        this.finish({ gameNumber: 1, bestOf: 1 });

        expect(this.player1.currentButtons).toEqual(['Continue Playing']);
    });

    it('never offers a rematch', function () {
        this.finish({ gameNumber: 1, bestOf: 3 });

        for (const player of [this.player1, this.player2]) {
            expect(player.currentButtons).not.toContain('Rematch: Same Decks');
            expect(player.currentButtons).not.toContain('Rematch: Trade Decks');
            expect(player.currentButtons).not.toContain('Rematch: Pick New Decks');
        }
    });

    it('hands the table back to the lobby when both players agree', function () {
        this.finish({ gameNumber: 1, bestOf: 3 });

        this.player1.clickPrompt('Play Game 2');
        expect(this.player2.currentButtons).toContain('Yes');

        this.player2.clickPrompt('Yes');

        expect(this.game.router.tournamentNextGame).toHaveBeenCalledWith(this.game);
        expect(this.game.router.rematch).not.toHaveBeenCalled();
    });

    it('returns both players to the menu when the opponent is not ready', function () {
        this.finish({ gameNumber: 1, bestOf: 3 });

        this.player1.clickPrompt('Play Game 2');
        this.player2.clickPrompt('No');

        expect(this.game.router.tournamentNextGame).not.toHaveBeenCalled();
        expect(this.player1.currentButtons).toContain('Play Game 2');
        expect(this.player2.currentButtons).toContain('Play Game 2');
    });
});
