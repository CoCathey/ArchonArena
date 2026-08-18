const { SidebarMenu } = require('../../client/menus');

/**
 * ARCHON: the Stats section, and where the rankings live.
 *
 * The statistics pages used to live in four different places - Play > Stats,
 * Community > Top Players, Community > Leaderboards, and a top-level "My
 * Stats" - so finding any one of them meant knowing which of four places it
 * had been filed under. They were gathered into one Stats section, and that
 * section has now collapsed into a single page: the overview opens on your own
 * numbers and carries the meta beside them, and Leaderboards moved to
 * Community, where a player goes looking for other players.
 *
 * Three things are worth pinning. The shape, because a page that quietly ends
 * up listed under two sections lights both up in the sidebar. The absence of
 * children under Stats, because that is what makes the tab a destination
 * rather than a flyout. And the old paths: they are linked from player
 * profiles and the About page and are the kind of URL people bookmark, so they
 * must still resolve.
 */
describe('Stats navigation', function () {
    const sectionTitled = (title) => SidebarMenu.find((section) => section.title === title);
    const pathsIn = (section) => (section?.childItems || []).map((item) => item.path);

    const allChildPaths = SidebarMenu.flatMap((section) =>
        (section.childItems || []).map((item) => item.path)
    );
    const allSectionPaths = SidebarMenu.map((section) => section.path).filter(Boolean);

    // The whole point of the collapse: one click on Stats lands on the stats.
    // A section with childItems renders as a flyout in the sidebar (see
    // Components/Navigation/Sidebar), so "has no children" IS "has no popout".
    it('is a single destination with no flyout', function () {
        const stats = sectionTitled('Stats');

        expect(stats).toBeDefined();
        expect(stats.path).toBe('/stats');
        expect(stats.childItems).toBeUndefined();
    });

    // Top Players was the rankings query pinned to the worldwide top 25 - the
    // same page Leaderboards already served at one scope. It is the podium on
    // Leaderboards now, so listing it again would be listing one page twice.
    it('does not list Top Players as its own page', function () {
        expect(allChildPaths).not.toContain('/stats/top-players');
        expect(allChildPaths).not.toContain('/community/top-players');
    });

    it('no longer lists the stats pages as separate entries', function () {
        expect(allChildPaths).not.toContain('/stats/me');
        expect(sectionTitled('My Stats')).toBeUndefined();
        expect(pathsIn(sectionTitled('Play'))).not.toContain('/stats');
    });

    describe('Community', function () {
        const community = () => sectionTitled('Community');

        // The people pages, in the order a player looks for them. Leaderboards
        // sits here rather than under Stats: a ranking is a list of players.
        it('leads with the people pages', function () {
            expect(pathsIn(community()).slice(0, 4)).toEqual([
                '/community/members',
                '/community/leaderboards',
                '/community/friends',
                '/community/clubs'
            ]);
        });

        // "Member" means a paid tier on this site; the directory is everyone.
        it('calls the directory Players', function () {
            const directory = community().childItems.find(
                (item) => item.path === '/community/members'
            );

            expect(directory.title).toBe('Players');
        });

        it('keeps the admin-toggleable content pages reachable', function () {
            const paths = pathsIn(community());

            expect(paths).toContain('/community/news');
            expect(paths).toContain('/community/articles');
            expect(paths).toContain('/community/blogs');
            expect(paths).toContain('/community/forums');
        });

        it('does not list the ranking pages under their old names', function () {
            const paths = pathsIn(community());

            expect(paths).not.toContain('/community/top-players');
            expect(paths).not.toContain('/leaderboards');
            expect(paths).not.toContain('/community/ratings');
            expect(paths).not.toContain('/stats/leaderboards');
        });
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
     * rendering harness and adding one for a handful of routes would be out of
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
            expect(hasRoute('/community/leaderboards')).toBe(true);
        });

        it('still answers on every former path', function () {
            expect(hasRoute('/stats/me')).toBe(true);
            expect(hasRoute('/stats/leaderboards')).toBe(true);
            expect(hasRoute('/stats/top-players')).toBe(true);
            expect(hasRoute('/community/top-players')).toBe(true);
            expect(hasRoute('/community/ratings')).toBe(true);
            expect(hasRoute('/leaderboards')).toBe(true);
        });

        it('sends each former path to its new home', function () {
            expect(redirectsTo('/stats/me')).toBe(true);
            expect(redirectsTo('/community/leaderboards')).toBe(true);
            // Not a redirect: /stats/me still names the overview's first tab.
            expect(redirectsTo('/stats/leaderboards')).toBe(false);
        });
    });
});
