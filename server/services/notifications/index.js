const ConfigService = require('../ConfigService');
const EmailService = require('../EmailService');
const NotificationService = require('./NotificationService');

/**
 * Process-wide notification singleton.
 *
 * The lobby (which raises pairing and community events) and the API (which
 * serves the notification centre) run in the same process, so one instance
 * backs both - matching the settings singleton. Tests construct their own
 * NotificationService with a stub db instead.
 */
const configService = new ConfigService();

module.exports = new NotificationService(require('../../db'), {
    emailService: new EmailService(configService),
    configService,
    siteUrl: configService.getValueForSection('lobby', 'siteUrl') || '',
    appName: configService.getValueForSection('lobby', 'appName') || 'Archon Arena'
});
