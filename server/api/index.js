const account = require('./account');
// ARCHON: OIDC SSO login (Keybringer)
const oidc = require('./oidc');
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
const decks = require('./decks');
const games = require('./games');
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
    account.init(server, options);
    // ARCHON: OIDC SSO login (Keybringer)
    oidc.init(server);
    // ARCHON: runtime admin settings
    adminSettings.init(server);
    // ARCHON: native tournament engine
    tournaments.init(server);
    // ARCHON: community (friends, members, clubs)
    community.init(server);
    // ARCHON: beta bug reports
    bugReports.init(server);
    decks.init(server);
    games.init(server);
    cards.init(server);
    news.init(server);
    user.init(server);
    messages.init(server);
    banlist.init(server);
};
