const { LeftMenu, SidebarMenu } = require('../../client/menus');

/**
 * ARCHON: what the admin menus offer, and what they deliberately do not.
 *
 * Three entries were removed from the admin menus, for two different reasons,
 * and the difference matters enough to pin:
 *
 *   News, Motd   features this site does not run. The pages, routes,
 *                permissions and server code are all still there - the menu
 *                entry is the only thing that went, so re-listing one is the
 *                whole of turning it back on.
 *   Ban List     not removed but MOVED, into User Admin. Banning an address is
 *                something you do while looking at the account that earned it.
 *
 * The distinction is invisible in a diff a year from now, which is why it is
 * asserted rather than only commented: a test that says "the route still
 * exists but nothing links to it" is the difference between a feature parked
 * on purpose and one half-deleted by accident.
 */
describe('Admin navigation', function () {
    const adminMenu = LeftMenu.find((section) => section.title === 'Admin');
    const otherMenu = SidebarMenu.find((section) => section.title === 'Other');

    const pathsIn = (section) => (section?.childItems || []).map((item) => item.path);
    const everyMenuPath = [
        ...LeftMenu.flatMap((section) => [section.path, ...pathsIn(section)]),
        ...SidebarMenu.flatMap((section) => [section.path, ...pathsIn(section)])
    ].filter(Boolean);

    it('still offers the admin screens that are in use', function () {
        expect(pathsIn(adminMenu)).toEqual(['/users', '/nodes']);
        expect(pathsIn(otherMenu)).toContain('/admin/settings');
        expect(pathsIn(otherMenu)).toContain('/users');
    });

    it('links to neither the news nor the motd admin screen', function () {
        expect(everyMenuPath).not.toContain('/news');
        expect(everyMenuPath).not.toContain('/admin/motd');
    });

    /**
     * The community News page is a different thing from the news ADMIN screen:
     * one is where players read announcements, the other is where an admin
     * writes them. Only the admin screen was unlinked - the reader-facing page
     * keeps its own runtime toggle (the 'navigation' site setting), which is
     * the supported way to hide it.
     */
    it('leaves the reader-facing News page alone', function () {
        const community = SidebarMenu.find((section) => section.title === 'Community');
        const news = (community?.childItems || []).find((item) => item.path === '/community/news');

        expect(news).toBeDefined();
        expect(news.pageKey).toBe('news');
    });

    it('no longer lists the ban list as a screen of its own', function () {
        expect(everyMenuPath).not.toContain('/banlist');
    });

    /**
     * Structural, like the sibling stats spec: the repo has no component
     * rendering harness, and adding one for a handful of routes would be out
     * of proportion. It can tell you a route was deleted - not that it works.
     */
    describe('the routes behind the removed entries', function () {
        const routes = require('fs').readFileSync(
            require.resolve('../../client/AppRoutes.jsx'),
            'utf8'
        );

        const hasRoute = (path) =>
            new RegExp(`path=['"\`]${path.replace(/\//g, '\\/')}['"\`]`).test(routes);

        // Unlinked, not deleted. This is the assertion that makes "leave the
        // code in case we turn it back on" a fact rather than an intention.
        it('keeps serving news and motd for anyone who has the URL', function () {
            expect(hasRoute('/news')).toBe(true);
            expect(hasRoute('/admin/motd')).toBe(true);
        });

        it('sends the old ban list URL to its new home', function () {
            expect(hasRoute('/banlist')).toBe(true);
            expect(/path='\/banlist'\s+element={<Navigate to='\/users'/.test(routes)).toBe(true);
        });

        /**
         * User Admin now carries a section governed by a permission its own
         * route did not require. Gating it on canManageUsers alone would lock
         * a ban list manager out of the only screen their permission leads to.
         */
        it('admits a ban list manager to User Admin', function () {
            expect(
                /requireAnyPermission\(\s*\['canManageUsers', 'canManageBanlist'\]/.test(routes)
            ).toBe(true);
        });
    });

    /**
     * The ban list has to actually be rendered somewhere, or "moved into User
     * Admin" is just "removed". Read as source for the same reason as above.
     */
    it('renders the ban list inside User Admin', function () {
        const userAdmin = require('fs').readFileSync(
            require.resolve('../../client/pages/UserAdmin.jsx'),
            'utf8'
        );

        expect(userAdmin).toContain("import BanlistAdmin from './BanlistAdmin'");
        expect(/canManageBanlist \? <BanlistAdmin \/> : null/.test(userAdmin)).toBe(true);
    });
});
