/**
 * @typedef MenuItem
 * @property {string} [path] The url path
 * @property {string} title The title to show to the user
 * @property {boolean} [showOnlyWhenLoggedIn] Whether or not this menu item only shows for logged in users
 * @property {boolean} [showOnlyWhenLoggedOut] Whether or not this menu item only shows for logged out users
 * @property {Permission} [permission] The permission required to see this menu item
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
            { path: '/play-irl', title: 'Play IRL' },
            { path: '/decks', title: 'My Decks', showOnlyWhenLoggedIn: true },
            { path: '/stats', title: 'Stats' },
            { path: '/tournaments', title: 'Tournaments' },
            { path: '/matches', title: 'Game History', showOnlyWhenLoggedIn: true }
        ]
    },
    { title: 'Learn', path: '/learn' },
    { title: 'Watch', path: '/watch' },
    {
        title: 'Community',
        landingPath: '/community/members',
        childItems: [
            { path: '/community/friends', title: 'Friends' },
            { path: '/community/clubs', title: 'Clubs' },
            { path: '/community/members', title: 'Members' },
            { path: '/community/top-players', title: 'Top Players' },
            { path: '/community/ratings', title: 'Ratings' },
            { path: '/leaderboards', title: 'Leaderboards' },
            { path: '/community/news', title: 'News' },
            { path: '/community/articles', title: 'Articles' },
            { path: '/community/blogs', title: 'Blogs' },
            { path: '/community/forums', title: 'Forums' }
        ]
    },
    // ARCHON: quick links for signed-in players, chess.com-style
    { title: 'My Decks', path: '/decks', showOnlyWhenLoggedIn: true },
    { title: 'My Stats', path: '/community/ratings', showOnlyWhenLoggedIn: true },
    {
        title: 'Other',
        landingPath: '/about',
        childItems: [
            { path: '/how-to-play', title: 'How To Play' },
            { path: '/about', title: 'About' },
            { path: '/privacy', title: 'Privacy Policy' },
            {
                path: '/tournamentlobby',
                title: 'Challonge Events',
                showOnlyWhenLoggedIn: true,
                permission: 'canManageTournaments'
            },
            { path: '/admin/settings', title: 'Site Settings', permission: 'isAdmin' },
            { path: '/news', title: 'News Admin', permission: 'canEditNews' },
            { path: '/users', title: 'User Admin', permission: 'canManageUsers' },
            { path: '/nodes', title: 'Node Admin', permission: 'canManageNodes' },
            { path: '/banlist', title: 'Ban List', permission: 'canManageBanlist' },
            { path: '/admin/motd', title: 'Motd Admin', permission: 'canManageMotd' }
        ]
    }
];
