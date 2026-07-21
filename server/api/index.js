const account = require('./account');
// ARCHON: OIDC SSO login (Keybringer)
const oidc = require('./oidc');
// ARCHON: public rating lookups
const ratings = require('./ratings');
// ARCHON: runtime admin settings
const adminSettings = require('./admin-settings');
const decks = require('./decks');
const games = require('./games');
const cards = require('./cards');
const news = require('./news');
const user = require('./user');
const messages = require('./messages');
const banlist = require('./banlist');
const challonge = require('./challonge');

module.exports.init = function (server, options) {
    account.init(server, options);
    // ARCHON: OIDC SSO login (Keybringer)
    oidc.init(server);
    // ARCHON: public rating lookups
    ratings.init(server);
    // ARCHON: runtime admin settings
    adminSettings.init(server);
    decks.init(server);
    games.init(server);
    cards.init(server);
    news.init(server);
    user.init(server);
    messages.init(server);
    banlist.init(server);
    challonge.init(server);
};
