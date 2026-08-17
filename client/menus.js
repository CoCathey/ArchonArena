/**
 * @typedef MenuItem
 * @property {string} [path] The url path
 * @property {string} title The title to show to the user
 * @property {boolean} [showOnlyWhenLoggedIn] Whether or not this menu item only shows for logged in users
 * @property {boolean} [showOnlyWhenLoggedOut] Whether or not this menu item only shows for logged out users
 * @property {Permission} [permission] The permission required to see this menu item
 * @property {boolean} [highlight] ARCHON (N12): render this item as a pill in
 *   the top navigation rather than a plain link. For Archon+ only - it stops
 *   being a signal if everything uses it.
 * @property {string} [capability] ARCHON (N12): a premium capability required to
 *   see this item. Checked against the resolved `user.capabilities` list, so an
 *   admin passes automatically. Prefer leaving premium entries VISIBLE and
 *   letting the page show its locked state - hiding a feature sells nothing.
 * @property {string} [pageKey] Key of an admin-toggleable content page (see the
 *   'navigation' site setting); the item is hidden when that page is turned off
 * @property {MenuItem[]} [childItems] Child menu items
 */

/**
 * @type {MenuItem[]} The list of menu items for the left side menu
 */
export const LeftMenu = [
    { path: '/decks', title: 'Decks', showOnlyWhenLoggedIn: true },
    //{ path: '/matches', title: 'Matches', showOnlyWhenLoggedIn: true },
    { path: '/play', title: 'Play' },
    {
        path: '/tournamentlobby',
        title: 'Tournament',
        showOnlyWhenLoggedIn: true,
        permission: 'canManageTournaments'
    },
    // ARCHON (N12): Archon+ in the top navigation, for everyone. It was only
    // reachable through a sidebar flyout and the profile dropdown, which is not
    // findable by someone who does not already know membership exists.
    { path: '/membership', title: 'Archon+', highlight: true },
    {
        title: 'Help',
        childItems: [
            { path: '/how-to-play', title: 'How To Play' },
            { path: '/about', title: 'About' },
            { path: '/privacy', title: 'Privacy Policy' }
        ]
    },
    {
        title: 'Admin',
        showOnlyWhenLoggedIn: true,
        childItems: [
            { path: '/news', title: 'News', permission: 'canEditNews' },
            { path: '/users', title: 'Users', permission: 'canManageUsers' },
            { path: '/nodes', title: 'Nodes', permission: 'canManageNodes' },
            { path: '/banlist', title: 'Ban List', permission: 'canManageBanlist' },
            { path: '/admin/motd', title: 'Motd', permission: 'canManageMotd' }
        ]
    }
];

/**
 * @type {MenuItem[]} The list of menu items for the right side menu
 */
export const RightMenu = [
    { path: '/login', title: 'Login', showOnlyWhenLoggedOut: true },
    { path: '/register', title: 'Register', showOnlyWhenLoggedOut: true, position: 'right' }
];

/**
 * @type {MenuItem[]} The menu items that appear in the profile menu
 */
export const ProfileMenu = [
    { title: 'Profile', path: '/profile' },
    // ARCHON (N12): membership sits in the profile menu because that is where a
    // player goes to look at their own account.
    { title: 'Membership', path: '/membership' },
    { title: 'Security', path: '/security' },
    { title: 'Block List', path: '/blocklist' },
    { title: 'Logout', path: '/logout' }
];

/**
 * ARCHON: chess.com-style left sidebar structure. Sections either link
 * directly (path) or open a flyout (childItems). Same visibility rules as
 * MenuItem (showOnlyWhenLoggedIn / permission).
 *
 * @type {MenuItem[]}
 */
export const SidebarMenu = [
    {
        title: 'Play',
        landingPath: '/play',
        childItems: [
            { path: '/play', title: 'Play Online' },
            { path: '/play-irl', title: 'Into the Fray' },
            // 'My Decks' lives in its own top-level tab below (for signed-in
            // players); keeping it out of this submenu avoids Play also
            // lighting up on /decks.
            // 'Stats' is its own top-level section now - see below.
            { path: '/tournaments', title: 'Tournaments' },
            { path: '/matches', title: 'Game History', showOnlyWhenLoggedIn: true }
        ]
    },
    { title: 'Learn', path: '/learn' },
    { title: 'Watch', path: '/watch' },
    // ARCHON: Stats is a destination, not a menu. It was a section with three
    // children, which meant two clicks and a decision to reach numbers that
    // all live on one page anyway: the overview now opens on your own stats
    // and carries the meta beside them, and the rankings - which are about
    // where everyone else places - moved to Community, where players look for
    // other players. Nothing is left to choose from, so the flyout is gone and
    // the tab goes straight to the page.
    { title: 'Stats', path: '/stats' },
    // ARCHON (N12): the premium tools get their own section rather than being
    // buried inside Stats. They are a distinct proposition - "understand your
    // decks" rather than "here are numbers" - and a player who never upgrades
    // still benefits from seeing what the tools are, which is why these entries
    // are visible to everyone and the pages themselves show a locked preview
    // instead of 404ing.
    {
        title: 'Archon+',
        landingPath: '/membership',
        childItems: [
            { path: '/intelligence', title: 'Archon Intelligence', showOnlyWhenLoggedIn: true },
            { path: '/deep-probe', title: 'Deep Probe', showOnlyWhenLoggedIn: true },
            {
                path: '/champions-challenge',
                title: 'Champion’s Challenge',
                showOnlyWhenLoggedIn: true
            },
            { path: '/membership', title: 'Membership' }
        ]
    },
    // ARCHON: the people section. "Players" rather than "Members", because
    // membership on this site means a paid tier - the directory lists everyone
    // who plays. Leaderboards sits with them: a ranking is a list of players,
    // and this is where someone goes looking for one.
    {
        title: 'Community',
        landingPath: '/community/members',
        childItems: [
            { path: '/community/members', title: 'Players' },
            { path: '/community/leaderboards', title: 'Leaderboards' },
            { path: '/community/friends', title: 'Friends' },
            { path: '/community/clubs', title: 'Grand Alliance Council' },
            { path: '/community/news', title: 'News', pageKey: 'news' },
            { path: '/community/articles', title: 'Articles', pageKey: 'articles' },
            { path: '/community/blogs', title: 'Blogs', pageKey: 'blogs' },
            { path: '/community/forums', title: 'Forums', pageKey: 'forums' }
        ]
    },
    // ARCHON: quick links for signed-in players, chess.com-style
    { title: 'My Decks', path: '/decks', showOnlyWhenLoggedIn: true },
    {
        title: 'Other',
        landingPath: '/about',
        childItems: [
            { path: '/how-to-play', title: 'How To Play' },
            { path: '/about', title: 'About' },
            { path: '/privacy', title: 'Privacy Policy' },
            { path: '/terms', title: 'Terms of Service' },
            { path: '/admin/settings', title: 'Site Settings', permission: 'isAdmin' },
            { path: '/admin/bug-reports', title: 'Bug Reports', permission: 'isAdmin' },
            { path: '/news', title: 'News Admin', permission: 'canEditNews' },
            { path: '/users', title: 'User Admin', permission: 'canManageUsers' },
            { path: '/nodes', title: 'Node Admin', permission: 'canManageNodes' },
            { path: '/banlist', title: 'Ban List', permission: 'canManageBanlist' },
            { path: '/admin/motd', title: 'Motd Admin', permission: 'canManageMotd' }
        ]
    }
];
