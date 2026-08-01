const Server = require('./server');
const Lobby = require('./lobby');
const UserService = require('./services/UserService');
const ConfigService = require('./services/ConfigService');
const logger = require('./log');
const configService = new ConfigService();

// The built-in placeholder secrets shipped in config/default.json5. These sign
// JWT auth tokens (`secret`) and refresh tokens (`hmacSecret`); running with
// them means anyone who knows the value can forge sessions for any account.
const DEFAULT_SECRET = 'somethingverysecret';
const DEFAULT_HMAC_SECRET = 'somethingevenmoresecret';

function assertSecureSecrets() {
    const secret = configService.getValue('secret');
    const hmacSecret = configService.getValueForSection('lobby', 'hmacSecret');

    const problems = [];
    if (!secret || secret === DEFAULT_SECRET) {
        problems.push("'secret' (set the SECRET environment variable)");
    }
    if (!hmacSecret || hmacSecret === DEFAULT_HMAC_SECRET) {
        problems.push("'hmacSecret' (set the HMAC_SECRET environment variable)");
    }

    if (problems.length === 0) {
        return;
    }

    const detail =
        `${problems.join(' and ')} still using the built-in default (or empty). ` +
        'These sign authentication and refresh tokens; leaving them at the default ' +
        'lets anyone forge sessions.';

    if (process.env.NODE_ENV === 'production') {
        logger.error(`FATAL: insecure secret configuration - ${detail} Refusing to start.`);
        process.exit(1);
    }

    logger.warn(`Insecure secret configuration - ${detail} This is acceptable only locally.`);
}

/**
 * ARCHON: with email verification on, registration depends on outbound mail.
 * A deployment that has not configured a sender cannot create *any* new
 * account - every registration rolls itself back - and the only symptom a
 * player sees is "we could not send your confirmation email".
 *
 * That is a configuration mistake worth shouting about at boot rather than
 * discovering from a support message. It is not fatal, though: the site still
 * works perfectly well for everyone who already has an account, so refusing
 * to start would turn a closed front door into an outage.
 */
function warnIfVerificationCannotWork() {
    if (!configService.getValueForSection('lobby', 'requireActivation')) {
        return;
    }

    if (configService.getValueForSection('lobby', 'emailFromAddress')) {
        return;
    }

    logger.error(
        'Email verification is required (lobby.requireActivation) but no sender address is ' +
            'configured (lobby.emailFromAddress / EMAIL_FROM_ADDRESS). No new account can be ' +
            'registered until this is set. Set REQUIRE_ACTIVATION=false if this instance is ' +
            'deliberately running without email.'
    );
}

async function runServer() {
    assertSecureSecrets();
    warnIfVerificationCannotWork();

    let options = { configService: configService };

    options.userService = new UserService(options.configService);
    // ARCHON (N8): the lobby records matchmaking queue depth and wait times.
    // Shared with the admin dashboard so both read the same service.
    options.analyticsService = require('./api/analytics').analyticsService;
    // ARCHON (N5): the lobby enforces mutes and timeouts on the chat paths.
    options.moderationService = require('./api/moderation').moderationService;

    let server = new Server(process.env.NODE_ENV !== 'production');
    let httpServer = await server.init(options);
    let lobby = new Lobby(httpServer, options);

    await lobby.init();

    server.run();
}

module.exports = runServer;
