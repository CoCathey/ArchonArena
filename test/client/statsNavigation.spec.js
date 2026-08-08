const { SidebarMenu } = require('../../client/menus');

/**
 * ARCHON: the Stats section.
 *
 * The statistics pages used to live in four different places - Play > Stats,
 * Community > Top Players, Community > Leaderboards, and a top-level "My
 * Stats" - so finding any one of them meant knowing which of four places it
 * had been filed under. They are one section now, and Top Players (the
 * rankings query pinned to the worldwide top 25) has been folded into
 * Leaderboards as its podium.
 *
 * Two things are worth pinning. First the shape, because a page that quietly
 * ends up listed under two sections lights both up in the sidebar. Second the
 * old paths: they are linked from player profiles and the About page and are
 * the kind of URL people bookmark, so they must still resolve.
 */
describe('Stats navigation', function () {
    const sectionTitled = (title) => SidebarMenu.find((section) => section.title === title);
    const pathsIn = (section) => (section?.childItems || []).map((item) => item.path);

    const allChildPaths = SidebarMenu.flatMap((section) =>
        (section.childItems || []).map((item) => item.path)
    );
    const allSectionPaths = SidebarMenu.map((section) => section.path).filter(Boolean);

    it('gathers the statistics pages into one section', function () {
        const stats = sectionTitled('Stats');

        expect(stats).toBeDefined();
        expect(pathsIn(stats)).toEqual(['/stats', '/stats/me', '/stats/leaderboards']);
    });

    // Top Players was the rankings query pinned to the worldwide top 25 - the
    // same page Leaderboards already served at one scope. It is the podium on
    // Leaderboards now, so listing it again would be listing one page twice.
    it('does not list Top Players as its own page', function () {
        expect(allChildPaths).not.toContain('/stats/top-players');
        expect(allChildPaths).not.toContain('/community/top-players');
    });

    it('lands on the site stats when the section header itself is clicked', function () {
        expect(sectionTitled('Stats').landingPath).toBe('/stats');
    });

    // Your own Amber is meaningless signed out, and the page says so rather
    // than showing an empty table - so it is hidden until there is a "you".
    it('shows My Stats only to signed-in players', function () {
        const myStats = sectionTitled('Stats').childItems.find((item) => item.path === '/stats/me');

        expect(myStats.showOnlyWhenLoggedIn).toBe(true);
    });

    it('leaves the pages behind in Play and Community', function () {
        expect(pathsIn(sectionTitled('Play'))).not.toContain('/stats');

        const community = pathsIn(sectionTitled('Community'));
        expect(community).not.toContain('/community/top-players');
        expect(community).not.toContain('/leaderboards');
        expect(community).not.toContain('/community/ratings');
    });

    it('no longer has a separate top-level My Stats tab', function () {
        expect(sectionTitled('My Stats')).toBeUndefined();
    });

    // The sidebar decides which section is lit by exact path match, so one
    // path appearing under two sections would light both.
    it('files every page under exactly one section', function () {
        const everyPath = [...allChildPaths, ...allSectionPaths];
        const duplicated = everyPath.filter((path, index) => everyPath.indexOf(path) !== index);

        expect(duplicated).toEqual([]);
    });

    /**
     * The old URLs are linked from player profiles and the About page and are
     * the kind of thing people bookmark, so they must still resolve.
     *
     * This reads the route table as source because the repo has no component
     * rendering harness and adding one for four routes would be out of
     * proportion. It is a structural pin, not a behavioural test: it can tell
     * you a route was deleted, not that it works. The redirects themselves
     * (including the season query surviving the move) were exercised in a real
     * browser against the built bundle.
     */
    describe('the pages that moved', function () {
        const routes = require('fs').readFileSync(
            require.resolve('../../client/AppRoutes.jsx'),
            'utf8'
        );

        // Quote style and attribute spacing are prettier's business, so match
        // on the path itself rather than on a formatted JSX fragment.
        const hasRoute = (path) =>
            new RegExp(`path=['"\`]${path.replace(/\//g, '\\/')}['"\`]`).test(routes);
        // A destination is either a plain string (`to='/stats/me'`) or built
        // in a template literal (the leaderboards one carries its query
        // through), so allow the brace and backtick between `to=` and the path.
        const redirectsTo = (path) =>
            new RegExp(`to=[{'"\`]*${path.replace(/\//g, '\\/')}`).test(routes);

        it('serves the new paths', function () {
            expect(hasRoute('/stats')).toBe(true);
            expect(hasRoute('/stats/me')).toBe(true);
            expect(hasRoute('/stats/leaderboards')).toBe(true);
        });

        it('still answers on every former path', function () {
            expect(hasRoute('/community/top-players')).toBe(true);
            expect(hasRoute('/community/ratings')).toBe(true);
            expect(hasRoute('/leaderboards')).toBe(true);
            // Briefly its own page during this move, so it redirects too.
            expect(hasRoute('/stats/top-players')).toBe(true);
        });

        it('sends each former path to its new home', function () {
            expect(redirectsTo('/stats/me')).toBe(true);
            expect(redirectsTo('/stats/leaderboards')).toBe(true);
        });
    });
});
