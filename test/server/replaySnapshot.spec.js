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

    /** The card a snapshot pile entry refers to, via the recording's table. */
    const cardAt = (game, entry) =>
        game.getReplay().cards[typeof entry === 'number' ? entry : entry.card];

    /**
     * Start from an empty recording.
     *
     * Capture is driven by `game.continue()`, so simply setting a test up plays
     * enough of a game to record several frames - which is the point, and is
     * asserted at the bottom of this file. The tests that count frames need a
     * known starting point, so they clear it first.
     */
    const resetRecording = (game) => {
        delete game.replaySnapshots;
        delete game.replayCards;
        delete game.replayCardKeys;
    };

    describe('getBoardSnapshot', function () {
        it('captures both players with their board and stats', function () {
            const snapshot = this.game.getBoardSnapshot();

            expect(snapshot.players.length).toBe(2);

            const player1 = snapshot.players.find((p) => p.name === 'player1');
            expect(player1.stats.amber).toBeDefined();
            expect(player1.stats.keys).toBeDefined();
            expect(player1.houses).toBeDefined();
            expect(player1.cardPiles.cardsInPlay.length).toBe(1);
            expect(cardAt(this.game, player1.cardPiles.cardsInPlay[0]).name).toBe('Flaxia');
        });

        // The whole point: a replay must never reveal more than watching the
        // game live would have. Asserted against the WHOLE recording, not just
        // one snapshot: card names now live in the recording's card table, so
        // checking a snapshot alone would pass without proving anything.
        it('never exposes the contents of either hand', function () {
            this.game.recordBoardSnapshot();

            const snapshot = this.game.getBoardSnapshot();
            const serialised = JSON.stringify(this.game.getReplay());

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

        // The reason the format changed. A snapshot of full card summaries came
        // to ~27 KB, which put a normal game's recording eight times over the
        // 2 MB store limit and got every one of them dropped on the way in.
        it('is small enough that a full recording fits the store limit', function () {
            const Game = require('../../server/game/game');
            const bytes = JSON.stringify(this.game.getBoardSnapshot()).length;

            expect(bytes * Game.MAX_REPLAY_SNAPSHOTS).toBeLessThan(2000 * 1000);
        });

        it('records live state on cards in play, not just their identity', function () {
            const flaxia = this.player1.player.cardsInPlay[0];

            flaxia.exhausted = true;

            const snapshot = this.game.getBoardSnapshot();
            const entry = snapshot.players.find((p) => p.name === 'player1').cardPiles
                .cardsInPlay[0];

            expect(entry.exhausted).toBe(true);
            expect(entry.uuid).toBe(flaxia.uuid);
        });
    });

    describe('recordBoardSnapshot', function () {
        beforeEach(function () {
            resetRecording(this.game);
        });

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

        // Cutting the recording off at the cap left a long game with a board
        // for its opening and nothing for the half that decided it. Halving
        // costs resolution evenly and keeps recording to the end.
        it('thins at the cap rather than stopping, and keeps recording to the end', function () {
            const Game = require('../../server/game/game');
            const cap = Game.MAX_REPLAY_SNAPSHOTS;

            for (let i = 0; i < cap + 5; i++) {
                this.game.addMessage(`message ${i}`);
                this.game.recordBoardSnapshot();
            }

            const replay = this.game.getReplay();
            const snapshots = this.game.replaySnapshots;

            expect(snapshots.length).toBeLessThanOrEqual(cap);
            expect(replay.thinned).toBe(true);
            // Still recording: the last frame is the most recent log position,
            // not one from the point the cap was reached.
            expect(snapshots[snapshots.length - 1].messageIndex).toBe(
                this.game.gameChat.messages.length
            );
            // And the opening is still there.
            expect(snapshots[0].messageIndex).toBeLessThan(snapshots[1].messageIndex);
            // Thinning is not a capture failure.
            expect(replay.truncated).toBe(false);
        });

        it('will not record once the game is over, unless it is the final frame', function () {
            this.game.finishedAt = new Date();
            this.game.addMessage('after the end');
            this.game.recordBoardSnapshot();

            expect(this.game.replaySnapshots).toBeUndefined();

            this.game.recordBoardSnapshot({ final: true });

            expect(this.game.replaySnapshots.length).toBe(1);
        });
    });

    describe('getReplay', function () {
        beforeEach(function () {
            resetRecording(this.game);
        });

        it('carries the log, the snapshots, the card table and a version', function () {
            this.game.recordBoardSnapshot();

            const replay = this.game.getReplay();

            expect(replay.version).toBe(3);
            expect(replay.messages).toBeDefined();
            expect(replay.snapshots.length).toBe(1);
            expect(replay.players.length).toBe(2);
            expect(replay.cards.length).toBeGreaterThan(0);
        });

        it('carries each player deck, houses and end state for a standalone render', function () {
            this.game.recordBoardSnapshot();

            const replay = this.game.getReplay();
            const player1 = replay.players.find((player) => player.name === 'player1');

            expect(player1.houses).toContain('brobnar');
            expect(player1.keys).toBeDefined();
            expect(player1.amber).toBeDefined();
        });

        it('is empty of snapshots but still valid when nothing was recorded', function () {
            const replay = this.game.getReplay();

            expect(replay.snapshots).toEqual([]);
            expect(replay.truncated).toBe(false);
            expect(replay.thinned).toBe(false);
        });
    });

    // Capture used to hang entirely off the game node's socket broadcast, so
    // nothing that drove the engine directly recorded anything.
    describe('capture is driven by the engine, not by the socket layer', function () {
        it('records as the game is played', function () {
            this.player1.play(this.player1.player.hand[0]);
            this.game.continue();

            expect(this.game.replaySnapshots.length).toBeGreaterThan(0);
        });

        it('captures the winning position, so the last frame shows the win', function () {
            this.game.continue();

            const before = this.game.replaySnapshots.length;

            this.game.recordWinner(this.player1.player, 'keys');

            const replay = this.game.getReplay();

            expect(replay.snapshots.length).toBe(before + 1);
            expect(replay.winner).toBe('player1');
            // The final frame is at the end of the log, so scrubbing to the end
            // of a replay lands on the board as the game finished.
            expect(replay.snapshots[replay.snapshots.length - 1].messageIndex).toBe(
                replay.messages.length
            );
        });
    });
});
