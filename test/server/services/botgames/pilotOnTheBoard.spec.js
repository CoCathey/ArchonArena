const fs = require('fs');
const path = require('path');

/**
 * ARCHON (N41): the pilot you chose is the pilot you are told you are facing.
 *
 * N31 let a player pick a sparring style on the pending screen - the same
 * Racer, Bruiser and Schemer the Champion's Challenge measures decks against -
 * and then every layer downstream forgot about it. Nothing named it on the
 * board while the game was played, and nothing recorded it when the game
 * finished. So the feature existed as a dropdown and as nothing else: a player
 * could not answer "which one keeps beating me", and neither could the site,
 * which knew exactly how each pilot does against simulated decks and nothing
 * at all about how they do against people.
 *
 * The chain is long and every link is somewhere different - pending game, start
 * details, engine, live state, save state, insert - so it is asserted link by
 * link. A style that stops one hop short is invisible in exactly the way the
 * original was.
 */
const root = path.join(__dirname, '..', '..', '..', '..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');

describe('the pilot travels with the game', function () {
    it('is chosen with a label, not just a key', function () {
        const lobby = read('server/lobby.js');

        // The node has no database to ask, so the human-readable name has to
        // ride along with the table like the policy does.
        expect(lobby).toContain('game.botStyleLabel = style ? style.label : undefined;');
    });

    it('leaves the pending game in the start details', function () {
        const pending = read('server/pendinggame.js');

        expect(pending).toMatch(/botStyle:\s*this\.botStyle \|\| undefined/);
        expect(pending).toMatch(/botStyleLabel:\s*this\.botStyleLabel \|\| undefined/);
    });

    it('is kept by the engine', function () {
        const game = read('server/game/game.js');

        expect(game).toContain('this.botStyle = details.botStyle;');
        expect(game).toContain('this.botStyleLabel = details.botStyleLabel;');
    });

    it('reaches the live board, so it can be named while it is played', function () {
        const game = read('server/game/game.js');

        expect(game).toMatch(/botStyleLabel:\s*this\.botStyleLabel \|\| undefined/);
    });

    it('reaches the save state, so it can be recorded when it finishes', function () {
        const game = read('server/game/game.js');

        expect(game).toMatch(/botStyle:\s*this\.botStyle \|\| undefined/);
    });

    it('is written to the row', function () {
        const service = read('server/services/GameService.js');

        expect(service).toContain('"BotStyle"');
        expect(service).toContain('game.botStyle || null');
    });

    it('has a column to be written to', function () {
        const schema = read('server/db/schema/84 - BotStyleOnGames.sql');
        const migration = read('server/db/schema/migrations/87 - BotStyleOnGames.sql');

        expect(schema).toContain('ADD COLUMN IF NOT EXISTS "BotStyle"');
        // The schema directory is the final shape and the migration is how a
        // deployed database gets there; they disagreeing is a deploy that
        // works on a fresh install and fails on a real one.
        expect(migration).toContain('ADD COLUMN IF NOT EXISTS "BotStyle"');
    });

    it('is shown on the board only when there is one', function () {
        const board = read('client/Components/GameBoard/GameBoard.jsx');

        expect(board).toContain('currentGame.botStyleLabel &&');
        expect(board).toContain('Facing {{style}}');
    });

    it('does not claim a style on an ordinary game between two people', function () {
        const game = read('server/game/game.js');

        // `|| undefined` throughout: a human-versus-human game has no pilot,
        // and a null in the state would render an empty badge.
        expect(game).not.toMatch(/botStyleLabel:\s*this\.botStyleLabel,/);
    });
});
