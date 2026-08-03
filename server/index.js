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
    const EmailService = require('./services/EmailService');
    // describeConfiguration is the single authority on whether this deployment
    // can send - shared with `npm run check:email` and the health check, so they
    // cannot drift into telling you different things.
    const configuration = new EmailService(configService).describeConfiguration();
    const required = !!configService.getValueForSection('lobby', 'requireActivation');

    for (const warning of configuration.warnings) {
        logger.warn(`Email configuration: ${warning}`);
    }

    if (configuration.ready) {
        return;
    }

    const detail = `Transport is "${configuration.transport}". ${configuration.problems.join(' ')}`;

    if (required) {
        logger.error(
            `Email is not configured, and verification is required: ${detail} ` +
                'NO NEW ACCOUNT CAN BE REGISTERED until this is fixed, because a registration ' +
                'whose confirmation mail cannot be sent is rolled back. Set ' +
                'REQUIRE_ACTIVATION=false to keep sign-ups open without email.'
        );
    } else {
        logger.warn(
            `Email is not configured: ${detail} ` +
                'Verification is off so sign-ups still work, but no password reset can be sent - ' +
                'a player who forgets their password has no way back into their account.'
        );
    }

    // Being configured is not the same as working, and only a send proves the
    // difference. Say so here rather than let a quiet boot imply otherwise.
    logger.info('Verify email actually sends with: npm run check:email -- you@example.com');
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
