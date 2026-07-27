describe('replay board snapshots', function () {
    beforeEach(function () {
        this.setupTest({
            player1: {
                house: 'brobnar',
                hand: ['troll', 'groggins'],
                inPlay: ['flaxia']
            },
            player2: {
                house: 'untamed',
                hand: ['dust-pixie'],
                inPlay: ['nexus']
            }
        });
    });

    describe('getBoardSnapshot', function () {
        it('captures both players with their board and stats', function () {
            const snapshot = this.game.getBoardSnapshot();

            expect(snapshot.players.length).toBe(2);

            const player1 = snapshot.players.find((p) => p.name === 'player1');
            expect(player1.stats.amber).toBeDefined();
            expect(player1.stats.keys).toBeDefined();
            expect(player1.houses).toBeDefined();
            expect(player1.cardPiles.cardsInPlay.length).toBe(1);
            expect(player1.cardPiles.cardsInPlay[0].name).toBe('Flaxia');
        });

        // The whole point: a replay must never reveal more than watching the
        // game live would have.
        it('never exposes the contents of either hand', function () {
            const snapshot = this.game.getBoardSnapshot();
            const serialised = JSON.stringify(snapshot);

            expect(serialised).not.toContain('Troll');
            expect(serialised).not.toContain('Groggins');
            expect(serialised).not.toContain('Dust Pixie');

            for (const player of snapshot.players) {
                expect(player.cardPiles.hand).toBeUndefined();
                expect(player.numHandCards).toBeGreaterThan(0);
            }
        });

        it('does not carry the chat log or prompt state into every snapshot', function () {
            const snapshot = this.game.getBoardSnapshot();

            expect(snapshot.messages).toBeUndefined();
            for (const player of snapshot.players) {
                expect(player.promptState).toBeUndefined();
                expect(player.menuTitle).toBeUndefined();
            }
        });
    });

    describe('recordBoardSnapshot', function () {
        it('records a snapshot keyed to the message-log position', function () {
            this.game.recordBoardSnapshot();

            expect(this.game.replaySnapshots.length).toBe(1);
            expect(this.game.replaySnapshots[0].messageIndex).toBe(
                this.game.gameChat.messages.length
            );
            expect(this.game.replaySnapshots[0].board.players.length).toBe(2);
        });

        // The game state is broadcast far more often than anything visible
        // changes; without this a replay would be mostly duplicates.
        it('does not record twice for the same log position', function () {
            this.game.recordBoardSnapshot();
            this.game.recordBoardSnapshot();
            this.game.recordBoardSnapshot();

            expect(this.game.replaySnapshots.length).toBe(1);
        });

        it('records again once the log advances', function () {
            this.game.recordBoardSnapshot();
            this.game.addMessage('something happened');
            this.game.recordBoardSnapshot();

            expect(this.game.replaySnapshots.length).toBe(2);
        });

        it('stops at the cap and flags that it truncated, rather than silently', function () {
            const Game = require('../../server/game/game');
            const cap = Game.MAX_REPLAY_SNAPSHOTS;

            for (let i = 0; i < cap + 5; i++) {
                this.game.addMessage(`message ${i}`);
                this.game.recordBoardSnapshot();
            }

            expect(this.game.replaySnapshots.length).toBe(cap);
            expect(this.game.replayTruncated).toBe(true);
            expect(this.game.getReplay().truncated).toBe(true);
        });
    });

    describe('getReplay', function () {
        it('carries the log, the snapshots and a version', function () {
            this.game.recordBoardSnapshot();

            const replay = this.game.getReplay();

            expect(replay.version).toBe(2);
            expect(replay.messages).toBeDefined();
            expect(replay.snapshots.length).toBe(1);
            expect(replay.players.length).toBe(2);
        });

        it('is empty of snapshots but still valid when nothing was recorded', function () {
            const replay = this.game.getReplay();

            expect(replay.snapshots).toEqual([]);
            expect(replay.truncated).toBe(false);
        });
    });
});
