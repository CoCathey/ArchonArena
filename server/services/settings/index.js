const SettingsService = require('./SettingsService');

/**
 * Process-wide settings singleton. Services read the synchronous snapshot
 * via getSection(); the lobby entrypoint calls start() once at boot.
 * Tests construct their own SettingsService (or inject a stub) instead.
 */
module.exports = new SettingsService();
