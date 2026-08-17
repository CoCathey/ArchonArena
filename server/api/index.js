const account = require('./account');
// ARCHON: OIDC SSO login (Keybringer)
const oidc = require('./oidc');
// ARCHON (N12): Patreon supporter linking
const patreon = require('./patreon');
// ARCHON (N12): premium membership, entitlements and admin grants
const membership = require('./membership');
// ARCHON (N12): Archon Intelligence + Tournament Lab
const intelligence = require('./intelligence');
// ARCHON (N18): the Champion’s Challenge - Vault Master background deck testing
const championsChallenge = require('./championschallenge');
// ARCHON: public rating lookups
const ratings = require('./ratings');
// ARCHON: runtime admin settings
const adminSettings = require('./admin-settings');
// ARCHON: native tournament engine
const tournaments = require('./tournaments');
// ARCHON: community (friends, members, clubs)
const community = require('./community');
// ARCHON: first-run onboarding wizard
const onboarding = require('./onboarding');
// ARCHON: beta bug reports
const bugReports = require('./bug-reports');
// ARCHON: in-app notification centre + delivery preferences
const notifications = require('./notifications');
// ARCHON: in-person (paper) game tracking
const inPersonGames = require('./in-person-games');
// ARCHON: admin analytics and operations dashboard
const analytics = require('./analytics');
// ARCHON: reports and the moderation queue
const moderation = require('./moderation');
const decks = require('./decks');
const games = require('./games');
// ARCHON: platform statistics & analytics
const stats = require('./stats');
const cards = require('./cards');
const news = require('./news');
const user = require('./user');
const messages = require('./messages');
const banlist = require('./banlist');

module.exports.init = function (server, options) {
    // ARCHON: routes with fixed /api/account/* paths MUST register before
    // account.init - upstream's parameterised PUT /api/account/:username
    // would otherwise swallow PUT /api/account/location and
    // PUT /api/account/avatar ('location'/'avatar' parsed as a username ->
    // 403 Unauthorized). Express matches in registration order.
    // ARCHON: public rating lookups + player location
    ratings.init(server);
    // ARCHON: first-run onboarding wizard (onboarded + avatar)
    onboarding.init(server, options);
    // ARCHON (N12): Patreon linking. Before account.init so the fixed
    // /api/account/patreon/* paths are matched ahead of the parameterised
    // /api/account/:username routes.
    patreon.init(server);
    // ARCHON (N12): membership catalogue, status and admin grants. Before
    // account.init for the same reason patreon is - fixed /api/account paths
    // must beat the parameterised ones.
    membership.init(server);
    intelligence.init(server);
    // ARCHON (N18): the Champion’s Challenge. Fixed /api/champions-challenge paths,
    // nothing under /api/account - order is unconstrained.
    championsChallenge.init(server);
    // ARCHON: community (friends, members, clubs) and the profile a member
    // edits. Before account.init for the same reason as everything above it:
    // it owns the fixed paths /api/account/bio and /api/account/cosmetics, and
    // registered after the parameterised route they were both answered with
    // 403 Unauthorized ('bio' parsed as somebody else's username), which is
    // why saving a bio silently failed.
    community.init(server);
    account.init(server, options);
    // ARCHON: OIDC SSO login (Keybringer)
    oidc.init(server);
    // ARCHON: runtime admin settings
    adminSettings.init(server);
    // ARCHON: native tournament engine
    tournaments.init(server);
    // ARCHON: beta bug reports
    bugReports.init(server);
    // ARCHON: notification centre + preferences
    notifications.init(server);
    // ARCHON: in-person (paper) game tracking
    inPersonGames.init(server);
    // ARCHON: admin analytics and operations dashboard
    analytics.init(server);
    // ARCHON: reports and the moderation queue
    moderation.init(server);
    decks.init(server);
    games.init(server);
    // ARCHON: platform statistics & analytics
    stats.init(server);
    cards.init(server);
    news.init(server);
    user.init(server);
    messages.init(server);
    banlist.init(server);
};
