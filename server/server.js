const express = require('express');
const app = express();
const bodyParser = require('body-parser');
// ARCHON: cookies carry transient OIDC login state (see server/api/oidc.js)
const cookieParser = require('cookie-parser');
const ConfigService = require('./services/ConfigService');
const helmet = require('helmet');
const { buildDirectives, normalizeMode } = require('./csp');
const passport = require('passport');
const logger = require('./log.js');
const api = require('./api');
const fs = require('fs');
const path = require('path');
const http = require('http');

const passportJwt = require('passport-jwt');
const Sentry = require('@sentry/node');

const JwtStrategy = passportJwt.Strategy;
const ExtractJwt = passportJwt.ExtractJwt;

const UserService = require('./services/UserService.js');
// ARCHON (I5): shared (cross-process) rate limiting
const RedisClientFactory = require('./services/RedisClientFactory');
const { setRedisStore } = require('./api/rateLimit');

class Server {
    constructor(isDeveloping) {
        this.configService = new ConfigService();

        this.userService = new UserService(this.configService);
        this.isDeveloping = isDeveloping;
        this.server = http.Server(app);
    }

    async init(options) {
        if (!this.isDeveloping) {
            Sentry.init({
                dsn: this.configService.getValue('sentryDsn'),
                release: process.env.VERSION || 'Local build',
                environment: process.env.NODE_ENV || 'production',
                integrations: [Sentry.expressIntegration({ app })]
            });
        }

        var opts = {};
        opts.jwtFromRequest = ExtractJwt.fromAuthHeaderAsBearerToken();
        opts.secretOrKey = this.configService.getValue('secret');

        passport.use(
            new JwtStrategy(opts, (jwtPayload, done) => {
                this.userService
                    .getUserById(jwtPayload.id)
                    .then((user) => {
                        if (user) {
                            return done(null, user.getWireSafeDetails());
                        }

                        return done(null, false);
                    })
                    .catch((err) => {
                        return done(err, false);
                    });
            })
        );
        // ARCHON: trust exactly one proxy hop in production, none in development.
        //
        // This is what makes req.ip the real client address rather than the
        // proxy's, and req.ip is what the rate limiter keys anonymous callers on
        // (server/api/rateLimit.js). Trusting one hop is only sound because the
        // app cannot be reached any other way: in docker-compose.prod.yml only
        // the caddy service publishes ports (80/443) - lobby, node-0, postgres
        // and redis publish none - so every request the app sees has passed
        // through Caddy exactly once. If a future deployment ever exposes the
        // lobby port directly, this must be revisited: a client that can reach
        // the app without the proxy can forge X-Forwarded-For.
        app.set('trust proxy', this.isDeveloping ? false : 1);

        // ARCHON: security response headers. `helmet` had been a dependency since
        // the upstream fork but was never actually mounted, so the site shipped
        // with none of them.
        //
        // Two of helmet 8's defaults are deliberately overridden:
        //
        //  - contentSecurityPolicy: helmet 4+ ships a default policy (helmet 3
        //    shipped none). That default knows nothing about hCaptcha, gameplay
        //    websockets or the Sentry ingest host, so leaving it on would both
        //    break the site and emit a second, conflicting CSP header alongside
        //    ours. Our policy is built in server/csp.js and applied below.
        //  - crossOriginOpenerPolicy: 'same-origin' severs window.opener. The
        //    tournament print-pairings view opens an about:blank popup and writes
        //    into it (client/Components/Tournaments/printPairings.js), so this is
        //    relaxed to same-origin-allow-popups, which still blocks cross-origin
        //    popups from reaching back into the page.
        app.use(
            helmet({
                contentSecurityPolicy: false,
                crossOriginOpenerPolicy: { policy: 'same-origin-allow-popups' },
                referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
                hsts: this.isDeveloping ? false : undefined
            })
        );

        // ARCHON: Content-Security-Policy (server/csp.js documents each
        // directive). CSP_MODE can turn it down to report-only, or off, without
        // a redeploy if the live site turns out to need an origin we missed.
        const cspMode = normalizeMode(this.configService.getValueForSection('lobby', 'cspMode'));

        if (cspMode !== 'off') {
            app.use(
                helmet.contentSecurityPolicy({
                    directives: buildDirectives({
                        isDeveloping: this.isDeveloping,
                        sentryDsn: this.configService.getValue('sentryDsn'),
                        // Only needed when game nodes live on their own hosts;
                        // the documented topology is same-origin behind Caddy.
                        gameNodeOrigins: this.configService.getValue('gameNodeOrigins')
                    }),
                    reportOnly: cspMode === 'report-only'
                })
            );
        }

        logger.info(`Content-Security-Policy: ${cspMode}`);

        app.use(passport.initialize());

        app.use(bodyParser.json({ limit: '5mb' }));
        app.use(bodyParser.urlencoded({ extended: false }));
        // ARCHON: cookies carry transient OIDC login state (see server/api/oidc.js)
        app.use(cookieParser());
        // ARCHON: load runtime admin settings snapshot + periodic refresh
        require('./services/settings').start();

        // ARCHON (I5): share rate-limit and login-throttle state across lobby
        // processes. Best-effort on purpose - if Redis cannot be reached the
        // limiters stay per-process, which is exactly how they behaved before,
        // rather than the site failing to start over a cache.
        await this.connectRateLimitStore();

        api.init(app, options);

        app.use(express.static(__dirname + '/../public'));
        if (!this.isDeveloping) {
            app.use(express.static(__dirname + '/../dist'));
        }

        if (this.isDeveloping) {
            const { createViteMiddleware } = await import('./vite-dev.mjs');
            const { vite, templatePath } = await createViteMiddleware({
                root: path.join(__dirname, '..')
            });

            app.use(vite.middlewares);

            app.get('*', async (req, res, next) => {
                try {
                    const url = req.originalUrl;
                    const template = fs.readFileSync(templatePath, 'utf-8');
                    const html = await vite.transformIndexHtml(url, template);
                    res.status(200).set({ 'Content-Type': 'text/html' }).end(html);
                } catch (err) {
                    vite.ssrFixStacktrace(err);
                    next(err);
                }
            });
        } else {
            app.get('*', (req, res) => {
                res.sendFile(path.join(__dirname, '..', 'dist', 'index.html'));
            });
        }

        if (!this.isDeveloping) {
            Sentry.setupExpressErrorHandler(app);
        }

        // Define error middleware last
        app.use(function (err, req, res, next) {
            logger.error(err);

            if (!res.headersSent && req.xhr) {
                return res.status(500).send({ success: false });
            }

            next(err);
        });

        return this.server;
    }

    /**
     * ARCHON (I5): back the rate limiter and login failure throttle with Redis
     * so limits hold across lobby processes.
     *
     * Deliberately non-fatal. A limiter is a safeguard, and refusing to boot
     * because a cache is down would turn a degraded state into an outage; the
     * store falls back to per-process limits, which is what shipped before.
     */
    async connectRateLimitStore() {
        try {
            const factory = new RedisClientFactory(this.configService);
            const client = factory.createClient();

            // Without a handler node-redis emits 'error' as an unhandled event
            // and takes the process down with it.
            client.on('error', (err) => logger.warn(`Rate limit Redis error: ${err.message}`));

            await client.connect();
            setRedisStore(client, factory.prefix);
        } catch (err) {
            logger.warn(
                `Rate limiting could not reach Redis (${err.message}); ` +
                    'limits will apply per lobby process only.'
            );
        }
    }

    run() {
        let port =
            process.env.PORT || this.configService.getValueForSection('lobby', 'port') || 4000;

        this.server.listen(port, '0.0.0.0', function onStart(err) {
            if (err) {
                logger.error(err);
            }

            logger.info(
                `==> ?? Listening on port ${port}. Open up http://0.0.0.0:${port}/ in your browser.`
            );
        });
    }

    serializeUser(user, done) {
        if (user) {
            done(null, user.id);
        }
    }
}

module.exports = Server;
