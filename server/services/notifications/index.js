const ConfigService = require('../ConfigService');
const EmailService = require('../EmailService');
const NotificationService = require('./NotificationService');
const PushService = require('./PushService');

/**
 * Process-wide notification singleton.
 *
 * The lobby (which raises pairing and community events) and the API (which
 * serves the notification centre) run in the same process, so one instance
 * backs both - matching the settings singleton. Tests construct their own
 * NotificationService with a stub db instead.
 */
const configService = new ConfigService();

const pushService = new PushService(require('../../db'), {
    // Optional: Expo accepts unauthenticated sends for tokens it issued, and
    // only sites that have turned on Expo's stricter push security need this.
    accessToken: configService.getValueForSection('lobby', 'expoPushAccessToken') || null
});

module.exports = new NotificationService(require('../../db'), {
    emailService: new EmailService(configService),
    pushService,
    configService,
    siteUrl: configService.getValueForSection('lobby', 'siteUrl') || '',
    appName: configService.getValueForSection('lobby', 'appName') || 'Archon Arena'
});

// The account routes need it directly, to register and forget device tokens.
module.exports.pushService = pushService;
