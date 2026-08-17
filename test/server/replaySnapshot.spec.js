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

        // The board half of the promise: the frames a spectator, a share link
        // or the opponent can see must never reveal more than watching the
        // game live would have. Hands ARE recorded since v4 - but beside the
        // board (`snapshots[].hands`, indexing a separate `handCards` table),
        // never inside it, and never in the public card table. Asserted
        // against the serialised board frames and public table, not one
        // snapshot: card names live in the tables, so checking a snapshot
        // alone would pass without proving anything.
        it('keeps both hands out of the board frames and the public card table', function () {
            this.game.recordBoardSnapshot();

            const snapshot = this.game.getBoardSnapshot();
            const replay = this.game.getReplay();
            const publicHalf = JSON.stringify({
                cards: replay.cards,
                boards: replay.snapshots.map((frame) => frame.board)
            });

            expect(publicHalf).not.toContain('Troll');
            expect(publicHalf).not.toContain('Groggins');
            expect(publicHalf).not.toContain('Dust Pixie');

            for (const player of snapshot.players) {
                expect(player.cardPiles.hand).toBeUndefined();
                expect(player.numHandCards).toBeGreaterThan(0);
            }
        });

        // ARCHON (F3): the owner's view of their archives, beside the hands.
        // The board pile stays a facedown count - that is what a spectator
        // sees - while the review and the owner read the real contents.
        it('records each player’s own archives beside the frame', function () {
            this.player1.moveCard(this.player1.player.hand[0], 'archives');
            this.game.addMessage('a fresh frame');
            this.game.recordBoardSnapshot();

            const replay = this.game.getReplay();
            const frame = replay.snapshots[replay.snapshots.length - 1];
            const names = (entries) => entries.map((entry) => replay.handCards[entry].name);

            expect(frame.archives.player1.length).toBe(1);
            expect(names(frame.archives.player1)).toContain('Troll');
            // And never through the public table or the board's pile.
            expect(replay.cards.map((card) => card.name)).not.toContain('Troll');

            const board = frame.board.players.find((player) => player.name === 'player1');

            expect(board.cardPiles.archives.length).toBe(1);
            expect(replay.cards[board.cardPiles.archives[0]].facedown).toBe(true);
        });

        // The other half: the recording itself carries each player's hand for
        // the misplay review, from the player's own perspective, in the
        // separable side channel the serving layer strips for anyone who may
        // not read it (replayPrivacy.spec.js proves the stripping).
        it('records each hand beside the frame, in the hand-card table', function () {
            // The capture self-throttles to log advances, and the fixture
            // hands were placed after setup's last recorded frame.
            this.game.addMessage('a fresh frame');
            this.game.recordBoardSnapshot();

            const replay = this.game.getReplay();
            const frame = replay.snapshots[replay.snapshots.length - 1];
            const names = (entries) => entries.map((entry) => replay.handCards[entry].name);

            expect(names(frame.hands.player1)).toContain('Troll');
            expect(names(frame.hands.player1)).toContain('Groggins');
            expect(names(frame.hands.player2)).toContain('Dust Pixie');
            // And only into the hand table - the entries are not indices into
            // the public one.
            expect(replay.cards.map((card) => card.name)).not.toContain('Troll');
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
        // Measured as a frame is actually recorded - board plus hands - so the
        // hand capture cannot quietly grow a frame past what the store takes.
        it('is small enough that a full recording fits the store limit', function () {
            const Game = require('../../server/game/game');
            const bytes = JSON.stringify({
                board: this.game.getBoardSnapshot(),
                hands: this.game.getHandsSnapshot()
            }).length;

            expect(bytes * Game.MAX_REPLAY_SNAPSHOTS).toBeLessThan(2000 * 1000);
        });

        // ARCHON (F3): so the misplay review can tell a forced call from a
        // chosen one. Clipped to the deck's public houses - the available list
        // also reads the hand, and an exotic foreign-house card there must
        // never leak through it.
        it('records which houses the active player could legally call', function () {
            const snapshot = this.game.getBoardSnapshot();
            const active = snapshot.players.find((p) => p.name === snapshot.activePlayer);
            const other = snapshot.players.find((p) => p.name !== snapshot.activePlayer);

            expect(Array.isArray(active.callableHouses)).toBe(true);
            expect(active.callableHouses.length).toBeGreaterThan(0);

            for (const house of active.callableHouses) {
                expect(active.houses).toContain(house);
            }

            // Only the player whose choice it is carries the list.
            expect(other.callableHouses).toBeUndefined();
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

            expect(replay.version).toBe(6);
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
