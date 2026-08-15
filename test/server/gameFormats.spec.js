const fs = require('fs');
const path = require('path');

/**
 * ARCHON: the phone app's game-mode lists must agree with the server's.
 *
 * They had drifted, in both directions and in ways nothing caught:
 *
 *  - The lobby runs six formats and Quick Match queues for all six, but the
 *    create forms offered four. Reversal and Unchained were reachable by
 *    matchmaking and not by making a game.
 *  - Events use a different word for standard play - `archon`, where the lobby
 *    says `normal` - and the app's tournament screen reused the lobby list. Its
 *    default was therefore `normal`, which is not in the event whitelist, so
 *    creating a standard event from the app was refused every time.
 *
 * Neither is a type error or a failing request in any test: one is a menu that
 * is quietly short, the other a default that only fails at the server. So the
 * check is textual - read the lists out of the app's source and compare them to
 * the constants that actually decide.
 */
describe('game formats agree across the apps', function () {
    const ROOT = path.resolve(__dirname, '../..');

    const readSource = (relative) => fs.readFileSync(path.join(ROOT, relative), 'utf8');

    /** The `name:` values inside a named exported array literal. */
    const namesIn = (source, exportName) => {
        const start = source.indexOf(`export const ${exportName}`);

        expect(start, `${exportName} is not exported`).toBeGreaterThan(-1);

        const end = source.indexOf('];', start);
        const block = source.slice(start, end);

        return [...block.matchAll(/name:\s*'([^']+)'/g)].map((match) => match[1]);
    };

    const mobileFormats = readSource('mobile/src/game/gameFormats.ts');

    /** The array literal assigned to a server const, read out of the source. */
    const serverList = (relative, constName) => {
        const source = readSource(relative);
        const match = source.match(new RegExp(`const ${constName} = \\[([^\\]]+)\\]`));

        expect(match, `${constName} not found in ${relative}`).toBeTruthy();

        return [...match[1].matchAll(/'([^']+)'/g)].map((entry) => entry[1]);
    };

    it('offers every lobby format the server will run', function () {
        // MATCHMAKING_FORMATS is the real list: Quick Match queues for each of
        // them, so anything missing from the app is a mode players can be
        // matched into but cannot create.
        const server = serverList('server/lobby.js', 'MATCHMAKING_FORMATS');
        const app = namesIn(mobileFormats, 'GAME_FORMATS');

        expect([...app].sort()).toEqual([...server].sort());
    });

    it('offers exactly the event formats the server accepts', function () {
        // A format the server rejects is a menu entry that always fails; one it
        // accepts but the app omits is a mode organisers cannot pick.
        const server = serverList(
            'server/services/tournament/TournamentService.js',
            'GAME_FORMATS'
        );
        const app = namesIn(mobileFormats, 'EVENT_GAME_FORMATS');

        expect([...app].sort()).toEqual([...server].sort());
    });

    it('does not offer Unchained as an event format', function () {
        // The engine runs it, but events never have. Asserted separately from
        // the comparison above so that if somebody adds it server-side, this
        // fails loudly enough to make them check the deck rules first.
        expect(namesIn(mobileFormats, 'EVENT_GAME_FORMATS')).not.toContain('unchained');
    });

    it('defaults a new event to a format the server accepts', function () {
        // The bug itself: the screen defaulted to the lobby's word and the
        // server refused it.
        const source = readSource('mobile/app/tournament/new.tsx');
        const match = source.match(/useState\('([^']+)'\)[^\n]*\n?/);
        const defaults = [...source.matchAll(/setGameFormat\]\s*=\s*useState\('([^']+)'\)/g)];

        expect(match).toBeTruthy();
        expect(defaults.length, 'gameFormat default not found').toBe(1);
        expect(
            serverList('server/services/tournament/TournamentService.js', 'GAME_FORMATS')
        ).toContain(defaults[0][1]);
    });
});
