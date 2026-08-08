const bcrypt = require('bcrypt');
const passport = require('passport');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const moment = require('moment');
const _ = require('underscore');
const EmailService = require('../services/EmailService');
const fs = require('fs');
const path = require('path');
const { fabric } = require('fabric');

const logger = require('../log.js');
const { wrapAsync } = require('../util.js');
const UserService = require('../services/UserService');
const ConfigService = require('../services/ConfigService');
const BanlistService = require('../services/BanlistService');
// ARCHON (N12): Patreon linking lives in api/patreon.js; checkauth below still
// needs the service to reconcile the supporter role on each auth refresh.
const { patreonService } = require('./patreon');
const util = require('../util.js');
const { rateLimit, createFailureThrottle, clientIp } = require('./rateLimit');
const { renderHtmlEmail, renderTextEmail } = require('../services/emailTemplate');
const {
    ACTIVATION_VALID_DAYS,
    buildActivationToken,
    isActivationExpired,
    verifyActivationToken,
    resendCooldownRemaining
} = require('../services/activationToken');

// ARCHON: abuse limits on the authentication surface. These endpoints are
// unauthenticated and are the first thing any credential-stuffing or
// account-enumeration script goes at, so they are bounded two ways:
//
//  - a request-volume limit per IP, generous enough that no human notices;
//  - for login specifically, a throttle counting only FAILED attempts, which
//    can be strict because a successful login clears it (see rateLimit.js).
const loginRateLimit = rateLimit({
    name: 'login',
    windowMs: 60 * 1000,
    max: 20,
    message: 'Too many login attempts. Please wait a moment and try again.'
});
const registerRateLimit = rateLimit({
    name: 'register',
    windowMs: 60 * 60 * 1000,
    max: 10,
    message: 'Too many accounts created from here recently. Please try again later.'
});
const passwordResetRateLimit = rateLimit({
    name: 'password-reset',
    windowMs: 60 * 60 * 1000,
    max: 10,
    message: 'Too many password reset requests. Please try again later.'
});
const activationRateLimit = rateLimit({
    name: 'activation',
    windowMs: 60 * 60 * 1000,
    max: 30,
    message: 'Too many activation attempts. Please try again later.'
});
// ARCHON: a lost or spam-filtered activation mail used to be permanent - the
// username was taken and there was no way to ask for another. Tighter than
// the activation limit because this one sends mail.
const resendActivationRateLimit = rateLimit({
    name: 'resend-activation',
    windowMs: 60 * 60 * 1000,
    max: 5,
    message: 'Too many activation emails requested. Please try again later.'
});

/**
 * ARCHON: token minting, expiry and cooldown live in
 * server/services/activationToken.js. They are shared by registration, the
 * activate endpoint and the resend endpoint, and each of the three used to
 * disagree with the others about the format - see that module for what broke.
 */

/** The link that lands a player on the activation page. */
const activationUrl = (req, userId, token) =>
    `${req.protocol}://${req.get('host')}/activation?id=${userId}&token=${token}`;

/** The activation email, shared by registration and resend. */
const activationEmail = (appName, username, url) => ({
    appName,
    title: 'Confirm your account',
    paragraphs: [
        `Someone, hopefully you, asked for an account named ${username} on ${appName}.`,
        'Confirm it to finish signing up and start playing.',
        `This link is valid for ${ACTIVATION_VALID_DAYS} days. After that you can ask for a new one from the login page.`
    ],
    action: { label: 'Confirm my account', url },
    footer: 'If you did not request this, you can safely ignore this email.'
});
const tokenRateLimit = rateLimit({
    name: 'token-refresh',
    windowMs: 60 * 1000,
    max: 30,
    message: 'Too many token refresh attempts. Please try again later.'
});
const usernameCheckRateLimit = rateLimit({
    name: 'check-username',
    windowMs: 60 * 1000,
    max: 60,
    message: 'Too many requests. Please slow down.'
});

// 10 failures in 15 minutes locks that address (or that account) out for 15
// minutes. Tracked per-IP and per-username: per-IP stops one host working
// through many accounts, per-username stops many hosts working on one account.
const loginFailures = createFailureThrottle({
    windowMs: 15 * 60 * 1000,
    max: 10,
    blockMs: 15 * 60 * 1000
});

const loginKeys = (req) => [
    `ip:${clientIp(req)}`,
    ...(req.body && req.body.username ? [`user:${String(req.body.username).toLowerCase()}`] : [])
];

let configService = new ConfigService();
let emailService = new EmailService(configService);
let userService;
let banlistService;

const appName = configService.getValueForSection('lobby', 'appName');

function verifyPassword(password, dbPassword) {
    return new Promise((resolve, reject) => {
        bcrypt.compare(password, dbPassword, function (err, valid) {
            if (err) {
                return reject(err);
            }

            return resolve(valid);
        });
    });
}

function isValidImage(base64Image) {
    let buffer = Buffer.from(base64Image, 'base64');

    return buffer.toString('hex', 0, 4) === '89504e47' || buffer.toString('hex', 0, 2) === 'ffd8';
}

function validateUserName(username) {
    if (!username) {
        return 'You must specify a username';
    }

    if (username.length < 3 || username.length > 15) {
        return 'Username must be at least 3 characters and no more than 15 characters long';
    }

    if (!username.match(/^[A-Za-z0-9_-]+$/)) {
        return 'Usernames must only use the characters a-z, 0-9, _ and -';
    }

    return undefined;
}

function validateEmail(email) {
    if (!email) {
        return 'You must specify an email address';
    }

    if (
        !email.match(
            /^(([^<>()[\]\\.,;:\s@"]+(\.[^<>()[\]\\.,;:\s@"]+)*)|(".+"))@((\[[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}])|(([a-zA-Z\-0-9]+\.)+[a-zA-Z]{2,}))$/
        )
    ) {
        return 'Please enter a valid email address';
    }

    return undefined;
}

function validatePassword(password) {
    if (!password) {
        return 'You must specify a password';
    }

    if (password.length < 6) {
        return 'Password must be at least 6 characters';
    }

    return undefined;
}

function sanitizePathSegment(input) {
    return String(input || '').replace(/[^A-Za-z0-9_-]/g, '');
}

function buildPngPath(baseDir, name) {
    const safeName = sanitizePathSegment(name);
    if (!safeName) {
        throw new Error('Invalid file name');
    }

    const resolvedBase = path.resolve(baseDir);
    const resolvedFile = path.resolve(resolvedBase, `${safeName}.png`);

    if (!resolvedFile.startsWith(resolvedBase + path.sep)) {
        throw new Error('Invalid file path');
    }

    return resolvedFile;
}

function removePng(baseDir, name) {
    if (!name) {
        return;
    }

    try {
        const resolvedPath = buildPngPath(baseDir, name);
        if (fs.existsSync(resolvedPath)) {
            fs.unlinkSync(resolvedPath);
        }
    } catch (err) {
        logger.warn(`Failed to resolve file path for ${name}`, err);
    }
}

// ARCHON: avatars were stored at 24x24 - the exact size the web client draws
// them at, and a blurry mess on any high-DPI screen (the mobile app shows them
// considerably larger). Stored at 96 they stay crisp everywhere; the web is
// unaffected since it scales them down in CSS, and avatars already on disk keep
// working untouched.
const AVATAR_SIZE = 96;

async function getRandomAvatar(user) {
    let stringToHash = crypto.randomBytes(32).toString('hex');
    let md5Hash = crypto.createHash('md5').update(stringToHash).digest('hex');
    let avatar = await util.httpRequest(
        `https://www.gravatar.com/avatar/${md5Hash}?d=identicon&s=${AVATAR_SIZE}`,
        { encoding: null, allowedHosts: ['www.gravatar.com'] }
    );

    if (!fs.existsSync('public/img/avatar')) {
        fs.mkdirSync('public/img/avatar/');
    }

    await fs.promises.writeFile(buildPngPath('public/img/avatar', user.username), avatar);
}

function processImage(image, width, height) {
    return new Promise((resolve, reject) => {
        const canvas = new fabric.StaticCanvas();
        canvas.setWidth(width);
        canvas.setHeight(height);
        fabric.Image.fromURL(
            'data:image/png;base64,' + image,
            (img) => {
                if (!img || img.getElement() == null) {
                    reject(new Error('Error occurred in fabric'));
                } else {
                    img.scaleToWidth(width)
                        .scaleToHeight(height)
                        .set({
                            originX: 'center',
                            originY: 'center',
                            left: width / 2,
                            top: height / 2
                        });
                    canvas.add(img);
                    canvas.renderAll();
                    resolve(canvas);
                }
            },
            { crossOrigin: 'anonymous' }
        );
    });
}

async function processAvatar(newUser, user) {
    let hash = crypto.randomBytes(16).toString('hex');

    removePng('public/img/avatar', user.settings.avatar);

    let canvas;
    try {
        canvas = await processImage(newUser.avatar, AVATAR_SIZE, AVATAR_SIZE);
    } catch (err) {
        logger.error(err);
        return null;
    }

    let fileName = `${sanitizePathSegment(user.username)}-${hash}`;
    const stream = canvas.createPNGStream();
    const out = fs.createWriteStream(buildPngPath('public/img/avatar', fileName));
    stream.on('data', (chunk) => {
        out.write(chunk);
    });

    return fileName;
}

async function processCustomBackground(newUser, user) {
    let hash = crypto.randomBytes(16).toString('hex');

    removePng('public/img/bgs', user.settings.customBackground);

    if (!fs.existsSync('public/img/bgs')) {
        fs.mkdirSync('public/img/bgs/');
    }

    let canvas;
    try {
        canvas = await processImage(newUser.customBackground, 700, 410);
    } catch (err) {
        logger.error(err);
        return null;
    }

    let fileName = `${sanitizePathSegment(user.username)}-${hash}`;
    const stream = canvas.createPNGStream();
    const out = fs.createWriteStream(buildPngPath('public/img/bgs', fileName));
    stream.on('data', (chunk) => {
        out.write(chunk);
    });
    stream.on('end', () => {
        canvas.dispose();
    });

    return fileName;
}

module.exports.init = function (server, options) {
    userService = options.userService || new UserService(options.configService);
    banlistService = new BanlistService(options.db, configService);

    server.post(
        '/api/account/register',
        registerRateLimit,
        wrapAsync(async (req, res) => {
            let message = validateUserName(req.body.username);
            if (message) {
                return res.send({ success: false, message: message });
            }

            message = validateEmail(req.body.email);
            if (message) {
                return res.send({ success: false, message: message });
            }

            message = validatePassword(req.body.password);
            if (message) {
                return res.send({ success: false, message: message });
            }

            let user = await userService.doesEmailExist(req.body.email);
            if (user) {
                return res.send({
                    success: false,
                    message: 'An account with that email already exists, please use another'
                });
            }

            user = await userService.doesUserExist(req.body.username);
            if (user) {
                return res.send({
                    success: false,
                    message: 'An account with that name already exists, please choose another'
                });
            }

            let emailBlockKey = configService.getValueForSection('lobby', 'emailBlockKey');
            if (
                configService.getValueForSection('lobby', 'blockDisposableEmail') &&
                emailBlockKey
            ) {
                let domain = req.body.email.substring(req.body.email.lastIndexOf('@') + 1);
                try {
                    let response = await util.httpRequest(
                        `http://check.block-disposable-email.com/easyapi/json/${emailBlockKey}/${domain}`,
                        { allowedHosts: ['check.block-disposable-email.com'] }
                    );
                    let answer = JSON.parse(response);

                    if (answer.request_status !== 'success') {
                        logger.warn(`Failed to check email address ${answer}`);
                    }

                    if (answer.domain_status === 'block') {
                        logger.warn(
                            `Blocking ${domain} from registering the account ${req.body.username}`
                        );
                        return res.send({
                            success: false,
                            message:
                                'One time use email services are not permitted on this site.  Please use a real email address'
                        });
                    }
                } catch (err) {
                    logger.warn(`Could not valid email address ${domain}`, err);
                }
            }

            let passwordHash;

            try {
                passwordHash = await bcrypt.hash(req.body.password, 10);
            } catch (error) {
                logger.error(error);

                res.send({
                    success: false,
                    message: 'An error occurred registering your account, please try again later.'
                });
            }

            let ip = req.get('x-real-ip');
            if (!ip) {
                ip = req.headers['x-forwarded-for'] || req.connection.remoteAddress;
            }

            try {
                let lookup = await banlistService.getEntryByIp(ip);
                if (lookup) {
                    return res.send({
                        success: false,
                        message:
                            'An error occurred registering your account, please try again later.'
                    });
                }
            } catch (err) {
                logger.error(err);

                return res.send({
                    success: false,
                    message: 'An error occurred registering your account, please try again later.'
                });
            }

            let newUser = {
                password: passwordHash,
                registered: new Date(),
                username: req.body.username,
                avatar: req.body.username,
                email: req.body.email,
                registerIp: ip
            };

            const requireActivation = configService.getValueForSection(
                'lobby',
                'requireActivation'
            );

            if (requireActivation) {
                const { token, expiry } = buildActivationToken(
                    req.body.username,
                    configService.getValueForSection('lobby', 'hmacSecret')
                );

                newUser.verified = false;
                newUser.activationToken = token;
                newUser.activationTokenExpiry = expiry;
            } else {
                newUser.verified = true;
            }

            user = await userService.addUser(newUser);

            if (requireActivation) {
                const activation = activationEmail(
                    appName,
                    newUser.username,
                    activationUrl(req, user.id, newUser.activationToken)
                );

                const sent = await emailService.sendEmail(
                    user.email,
                    `${appName} - Account activation`,
                    renderTextEmail(activation),
                    renderHtmlEmail(activation)
                );

                // ARCHON: sendEmail returns false rather than throwing, so this
                // used to report success even when nothing was sent - leaving an
                // account that could never be verified, could never log in, and
                // whose username was now taken, with no way to retry. Roll the
                // account back so the name is free and the player can try again
                // once mail is working.
                if (!sent) {
                    logger.error(
                        `Could not send the activation email for ${user.username}; ` +
                            'rolling the registration back rather than leaving an unusable account.'
                    );

                    await userService.deleteUnverifiedUser(user.id);

                    return res.send({
                        success: false,
                        message:
                            'We could not send your confirmation email, so your account was not created. ' +
                            'Please try again shortly.'
                    });
                }
            }

            res.send({ success: true, requiresActivation: !!requireActivation });

            try {
                await getRandomAvatar(user);
            } catch (error) {
                logger.error(`Error downloading avatar for ${user.username}`, error);
            }
        })
    );

    server.post(
        '/api/account/activate',
        activationRateLimit,
        wrapAsync(async (req, res) => {
            if (!req.body.id || !req.body.token) {
                return res.send({ success: false, message: 'Invalid parameters' });
            }

            // ARCHON: this used to test the id against /^[a-f\d]{24}$/i - a
            // MongoDB ObjectId. The platform moved to PostgreSQL, where user
            // ids are integers, so the check rejected every real id and NO
            // account could ever be activated. Nobody noticed because
            // requireActivation was off, which meant the endpoint was never
            // reached in the first place.
            const userId = parseInt(req.body.id, 10);

            if (
                !Number.isInteger(userId) ||
                userId <= 0 ||
                String(userId) !== String(req.body.id)
            ) {
                return res.send({ success: false, message: 'Invalid parameters' });
            }

            let user = await userService.getUserById(userId);
            if (!user) {
                return res.send({
                    success: false,
                    message:
                        'An error occurred activating your account, check the url you have entered and try again.'
                });
            }

            if (!user.activationToken) {
                logger.error('Got unexpected activate request for user %s', user.username);

                return res.send({
                    success: false,
                    message:
                        'An error occurred activating your account, check the url you have entered and try again.'
                });
            }

            if (isActivationExpired(user.activationTokenExpiry)) {
                logger.info(`Activation token expired or unparseable for ${user.username}`);

                return res.send({
                    success: false,
                    message:
                        'That activation link has expired. Request a new one and we will email you another.'
                });
            }

            const tokenMatches = verifyActivationToken(
                user.username,
                user.activationTokenExpiry,
                req.body.token,
                configService.getValueForSection('lobby', 'hmacSecret')
            );

            if (!tokenMatches) {
                logger.error('Invalid activation token for %s', user.username);

                return res.send({
                    success: false,
                    message:
                        'An error occurred activating your account, check the url you have entered and try again.'
                });
            }

            try {
                await userService.activateUser(user);
            } catch (error) {
                logger.error('Error activating', error);

                return res.send({
                    success: false,
                    message:
                        'An error occurred activating your account, check the url you have entered and try again.'
                });
            }

            res.send({ success: true });
        })
    );

    /**
     * ARCHON: send the activation email again.
     *
     * There was no way to do this. If the mail bounced, went to spam, or the
     * link expired, the account was stuck unverified forever with its username
     * taken - the player's only option was to register under a different name.
     *
     * Two deliberate properties:
     *
     * - It never reveals whether the account exists, is already verified, or
     *   is on cooldown. Every outcome is the same `success: true`, sent before
     *   the lookup so the response time does not leak the answer either. This
     *   endpoint would otherwise be a free username *and* verification-status
     *   oracle over an unauthenticated route.
     * - It regenerates the token rather than resending the old one, so the
     *   previous link stops working. That matters when the reason for the
     *   resend is that the first email went somewhere it should not have.
     *   This follows from the cooldown below: the token is an HMAC over the
     *   expiry, which is truncated to the second, so two mints inside the same
     *   second would produce the same token. Five minutes apart, they cannot.
     */
    server.post(
        '/api/account/resend-activation',
        resendActivationRateLimit,
        wrapAsync(async (req, res) => {
            res.send({ success: true });

            const identifier = req.body && req.body.username;
            if (!identifier || typeof identifier !== 'string') {
                return;
            }

            if (!configService.getValueForSection('lobby', 'requireActivation')) {
                return;
            }

            let user = await userService.getUserByUsername(identifier);
            if (!user) {
                user = await userService.getUserByEmail(identifier);
            }

            if (!user || user.verified || user.disabled) {
                logger.info('Activation resend requested for an account that cannot use one');

                return;
            }

            if (user.activationTokenExpiry) {
                const wait = resendCooldownRemaining(user.activationTokenExpiry);

                if (wait > 0) {
                    logger.info(
                        `Activation resend for ${user.username} is on cooldown ` +
                            `for another ${wait.toFixed(1)} minutes`
                    );

                    return;
                }
            }

            const { token, expiry } = buildActivationToken(
                user.username,
                configService.getValueForSection('lobby', 'hmacSecret')
            );

            let stored;
            try {
                stored = await userService.setActivationToken(user.id, token, expiry);
            } catch (err) {
                logger.error(`Could not re-issue an activation token for ${user.username}`, err);

                return;
            }

            // Lost the race with an activation that landed in between: the
            // account is verified now, so sending a link would be wrong.
            if (!stored) {
                return;
            }

            logger.info(`Re-sending the activation email for ${user.username}`);

            const activation = activationEmail(
                appName,
                user.username,
                activationUrl(req, user.id, token)
            );

            const sent = await emailService.sendEmail(
                user.email,
                `${appName} - Account activation`,
                renderTextEmail(activation),
                renderHtmlEmail(activation)
            );

            if (!sent) {
                logger.error(`Could not re-send the activation email for ${user.username}`);
            }
        })
    );

    server.post(
        '/api/account/check-username',
        usernameCheckRateLimit,
        wrapAsync(async (req, res) => {
            let user = await userService.doesUserExist(req.body.username);
            if (user) {
                return res.send({
                    success: true,
                    message: 'An account with that name already exists, please choose another'
                });
            }

            return res.send({ success: true });
        })
    );

    server.post(
        '/api/account/logout',
        passport.authenticate('jwt', { session: false }),
        wrapAsync(async (req, res, next) => {
            req.params.username = req.user ? req.user.username : undefined;

            let user = await checkAuth(req, res);

            if (!user) {
                return;
            }

            try {
                await userService.clearUserSessions(user.username);
            } catch (err) {
                return next(err);
            }

            user.tokens = [];

            res.send({ success: true });
        })
    );

    server.post(
        '/api/account/checkauth',
        passport.authenticate('jwt', { session: false }),
        wrapAsync(async (req, res) => {
            let user = await userService.getFullUserByUsername(req.user.username);
            let userDetails = user.getWireSafeDetails();

            // ARCHON (N12): only reconcile the supporter role while Patreon is
            // actually configured. Unconfigured, every account reports 'none'
            // and this sweep would revoke the role from everyone who has it -
            // including on a deployment that has never turned Patreon on.
            if (patreonService.isEnabled()) {
                let isSupporter = false;

                if (user.patreon && user.patreon.refresh_token) {
                    userDetails.patreon = await patreonService.getPatreonStatusForUser(user);

                    if (userDetails.patreon === 'none') {
                        delete userDetails.patreon;

                        let ret = await patreonService.refreshTokenForUser(user);
                        if (ret) {
                            userDetails.patreon = await patreonService.getPatreonStatusForUser(
                                user
                            );
                        }
                    }
                }

                if (userDetails.patreon === 'pledged') {
                    isSupporter = true;
                }

                if (isSupporter !== req.user.permissions.isSupporter) {
                    if (!req.user.permissions.keepsSupporterWithNoPatreon) {
                        userDetails.permissions.isSupporter = req.user.permissions.isSupporter =
                            isSupporter;
                        await userService.setSupporterStatus(user.id, isSupporter);
                    }
                }
            } else if (user.patreon && user.patreon.access_token) {
                // Integration off but the account still holds a token: report
                // the link so the profile page can offer to unlink it.
                userDetails.patreon = 'linked';
            }

            res.send({ success: true, user: userDetails });
        })
    );

    server.post(
        '/api/account/login',
        loginRateLimit,
        wrapAsync(async (req, res) => {
            if (!req.body.username) {
                return res.send({ success: false, message: 'Username must be specified' });
            }

            if (!req.body.password) {
                return res.send({ success: false, message: 'Password must be specified' });
            }

            // ARCHON: refuse while this address or account is locked out, and
            // count every credential failure below toward that lockout. The
            // message is deliberately the same regardless of which key tripped,
            // so it reveals nothing about whether the account exists.
            const keys = loginKeys(req);
            // ARCHON (I5): the throttle is Redis-backed and therefore async.
            // These must be awaited - an unawaited check would let every
            // attempt through while the lockout was still being read.
            const lockedFor = Math.max(
                ...(await Promise.all(keys.map((key) => loginFailures.blockedFor(key))))
            );

            if (lockedFor > 0) {
                res.set('Retry-After', String(lockedFor));

                return res.status(429).send({
                    success: false,
                    message:
                        'Too many failed login attempts. Please wait a few minutes and try again.'
                });
            }

            const recordFailedLogin = () =>
                Promise.all(keys.map((key) => loginFailures.recordFailure(key)));

            let user = await userService.getFullUserByUsername(req.body.username);
            if (!user) {
                await recordFailedLogin();

                return res.send({ success: false, message: 'Invalid username/password' });
            }

            if (user.disabled) {
                await recordFailedLogin();

                return res.send({ success: false, message: 'Invalid username/password' });
            }

            let isValidPassword;
            try {
                isValidPassword = await verifyPassword(req.body.password, user.password);
            } catch (err) {
                logger.error(err);

                return res.send({
                    success: false,
                    message:
                        'There was an error validating your login details.  Please try again later'
                });
            }

            if (!isValidPassword) {
                await recordFailedLogin();

                return res.send({ success: false, message: 'Invalid username/password' });
            }

            // The password was already checked above, so saying the account
            // exists but is unconfirmed tells the caller nothing they did not
            // already prove they knew. `needsActivation` lets the login page
            // offer a resend instead of leaving them at a dead end.
            if (!user.verified) {
                return res.send({
                    success: false,
                    needsActivation: true,
                    message:
                        'Your account has not been confirmed yet. Check your email for the ' +
                        'confirmation link.'
                });
            }

            // Correct credentials: clear the lockout counters so a legitimate
            // user is never penalised for earlier typos.
            await Promise.all(keys.map((key) => loginFailures.reset(key)));

            let userObj = user.getWireSafeDetails();

            let authToken = jwt.sign(userObj, configService.getValue('secret'), {
                expiresIn: '5m'
            });
            // ARCHON: req.ip (via the `trust proxy` setting in server.js) rather
            // than raw forwarding headers, which the caller controls - a forged
            // value here writes a bogus address into the session list the player
            // is shown and relies on to spot unfamiliar logins.
            let refreshToken = await userService.addRefreshToken(user, authToken, clientIp(req));
            if (!refreshToken) {
                return res.send({
                    success: false,
                    message:
                        'There was an error validating your login details.  Please try again later'
                });
            }

            res.send({
                success: true,
                user: userObj,
                token: authToken,
                refreshToken: refreshToken
            });
        })
    );

    server.post(
        '/api/account/token',
        tokenRateLimit,
        wrapAsync(async (req, res) => {
            if (!req.body.token) {
                return res.send({ success: false, message: 'Refresh token must be specified' });
            }

            let token = req.body.token;

            let user = await userService.getFullUserByUsername(token.username);
            if (!user) {
                return res.send({ success: false, message: 'Invalid refresh token' });
            }

            if (user.username !== token.username) {
                logger.error(
                    `Username ${user.username} did not match token username ${token.username}`
                );
                return res.send({ success: false, message: 'Invalid refresh token' });
            }

            let refreshToken = user.tokens.find((t) => {
                return t.id === token.id;
            });
            if (!refreshToken) {
                return res.send({ success: false, message: 'Invalid refresh token' });
            }

            if (!userService.verifyRefreshToken(user.username, refreshToken, token.token)) {
                return res.send({ success: false, message: 'Invalid refresh token' });
            }

            if (user.disabled) {
                return res.send({ success: false, message: 'Invalid refresh token' });
            }

            let userObj = user.getWireSafeDetails();

            let ip = req.get('x-real-ip');
            if (!ip) {
                ip = req.headers['x-forwarded-for'] || req.connection.remoteAddress;
            }

            let authToken = jwt.sign(userObj, configService.getValue('secret'), {
                expiresIn: '5m'
            });

            await userService.updateRefreshTokenUsage(refreshToken.id, ip);

            res.send({ success: true, user: userObj, token: authToken });
        })
    );

    server.post(
        '/api/account/password-reset-finish',
        passwordResetRateLimit,
        wrapAsync(async (req, res) => {
            let resetUser;

            if (!req.body.id || !req.body.token || !req.body.newPassword) {
                return res.send({ success: false, message: 'Invalid parameters' });
            }

            let user = await userService.getUserById(req.body.id);
            if (!user) {
                return res.send({
                    success: false,
                    message:
                        'An error occurred resetting your password, check the url you have entered and try again.'
                });
            }

            if (!user.resetToken) {
                logger.error('Got unexpected reset request for user %s', user.username);

                return res.send({
                    success: false,
                    message:
                        'An error occurred resetting your password, check the url you have entered and try again.'
                });
            }

            let now = moment().utc();
            if (user.tokenExpires < now) {
                logger.error('Token expired for %s', user.username);

                return res.send({
                    success: false,
                    message: 'The reset token you have provided has expired.'
                });
            }

            let hmac = crypto.createHmac(
                'sha512',
                configService.getValueForSection('lobby', 'hmacSecret')
            );
            let resetToken = hmac
                .update(
                    'RESET ' +
                        user.username +
                        ' ' +
                        moment(user.tokenExpires).format('YYYYMMDD-HH:mm:ss')
                )
                .digest('hex');
            logger.info(
                `${user.username} ${moment(user.tokenExpires).format(
                    'YYYYMMDD-HH:mm:ss'
                )} ${resetToken}`
            );

            if (resetToken !== req.body.token) {
                logger.error(`Invalid reset token for ${user.username}`);

                return res.send({
                    success: false,
                    message:
                        'An error occurred resetting your password, check the url you have entered and try again.'
                });
            }

            resetUser = user;

            let passwordHash = await bcrypt.hash(req.body.newPassword, 10);
            await userService.setPassword(resetUser, passwordHash);
            await userService.clearResetToken(resetUser);

            res.send({ success: true });
        })
    );

    server.post(
        '/api/account/password-reset',
        passwordResetRateLimit,
        wrapAsync(async (req, res) => {
            let resetToken;

            let response = await util.httpRequest('https://hcaptcha.com/siteverify', {
                method: 'POST',
                allowedHosts: ['hcaptcha.com'],
                form: {
                    secret: configService.getValue('captchaKey'),
                    response: req.body.captcha,
                    remoteip: req.ip
                }
            });
            let answer = JSON.parse(response);

            if (!answer.success) {
                return res.send({
                    success: false,
                    message: 'Please complete the captcha correctly'
                });
            }

            res.send({ success: true });

            let user = await userService.getUserByUsername(req.body.username);
            if (!user) {
                user = await userService.getUserByEmail(req.body.username);

                if (!user) {
                    logger.info('Username %s not found for password reset', req.body.username);

                    return;
                }
            }

            let expiration = moment().utc().add(4, 'hours');
            let formattedExpiration = expiration.format('YYYYMMDD-HH:mm:ss');
            let hmac = crypto.createHmac(
                'sha512',
                configService.getValueForSection('lobby', 'hmacSecret')
            );

            resetToken = hmac.update(`RESET ${user.username} ${formattedExpiration}`).digest('hex');

            // SECURITY: never log the reset token - it grants a password reset
            // for this account to anyone who can read the logs.
            logger.info(`Password reset requested for ${user.username}`);

            try {
                await userService.setResetToken(user, resetToken, expiration);
            } catch (err) {
                return;
            }

            let url = `${req.protocol}://${req.get('host')}/reset-password?id=${
                user.id
            }&token=${resetToken}`;
            const reset = {
                appName,
                title: 'Reset your password',
                paragraphs: [
                    `Someone, hopefully you, asked to reset the password for ${user.username} on ${appName}.`,
                    'This link expires in 4 hours.'
                ],
                action: { label: 'Reset my password', url },
                footer:
                    'If you did not ask for this, ignore this email — your account has not been ' +
                    'affected and your password has not been changed.'
            };

            await emailService.sendEmail(
                user.email,
                `${appName} - Password reset`,
                renderTextEmail(reset),
                renderHtmlEmail(reset)
            );
        })
    );

    server.put(
        '/api/account/:username',
        passport.authenticate('jwt', { session: false }),
        wrapAsync(async (req, res) => {
            let userToSet = req.body.data;
            let message;

            if (req.user.username !== req.params.username) {
                return res.status(403).send({ message: 'Unauthorized' });
            }

            let user = await userService.getFullUserByUsername(req.params.username);
            if (!user) {
                return res.status(404).send({ message: 'Not found' });
            }

            message = validateUserName(userToSet.username);
            if (message) {
                return res.send({ success: false, message: message });
            }

            message = validateEmail(userToSet.email);
            if (message) {
                return res.send({ success: false, message: message });
            }

            if (user.username !== userToSet.username) {
                let userTest = await userService.doesUserExist(userToSet.username);
                if (userTest) {
                    return res.send({
                        success: false,
                        message: 'An account with that name already exists, please choose another'
                    });
                }
            }

            if (userToSet.avatar && !isValidImage(userToSet.avatar)) {
                return res.status(400).send({ success: false, message: 'Avatar must be image' });
            }

            if (userToSet.customBackground && !isValidImage(userToSet.customBackground)) {
                return res
                    .status(400)
                    .send({ success: false, message: 'Background must be image' });
            }

            user = user.getDetails();

            user.username = userToSet.username;
            user.email = userToSet.email;
            let oldAvatar = user.settings.avatar;
            let oldCustomBg = user.settings.customBackground;

            user.settings = userToSet.settings;
            user.settings.avatar = oldAvatar;
            user.settings.customBackground = oldCustomBg;

            if (userToSet.password && userToSet.password !== '') {
                user.password = await bcrypt.hash(userToSet.password, 10);
            }

            if (userToSet.avatar) {
                user.settings.avatar = await processAvatar(userToSet, user);
            }

            if (userToSet.customBackground) {
                user.settings.customBackground = await processCustomBackground(userToSet, user);
            }

            await userService.update(user);

            let updatedUser = await userService.getUserById(user.id);
            let safeUser = updatedUser.getWireSafeDetails();
            let authToken;

            // ARCHON: this read `!safeUser.verified` - inverted. A profile save
            // is meant to hand back a fresh token because the claims in the old
            // one (the username, most obviously) may have just changed; minting
            // one for an *unverified* account is exactly backwards. It was
            // harmless only by accident: requireActivation was off so everyone
            // was verified and the branch never ran, and the client ignores the
            // token anyway. Now that unverified accounts genuinely exist, make
            // the condition say what it meant.
            if (!safeUser.disabled && safeUser.verified) {
                authToken = jwt.sign(safeUser, configService.getValue('secret'), {
                    expiresIn: '5m'
                });
            }

            res.send(
                Object.assign(
                    { success: true },
                    { user: updatedUser.getWireSafeDetails(), token: authToken }
                )
            );
        })
    );

    server.get(
        '/api/account/:username/sessions',
        passport.authenticate('jwt', { session: false }),
        wrapAsync(async (req, res) => {
            let user = await checkAuth(req, res);

            if (!user) {
                return;
            }

            let tokens = user.tokens || [];

            res.send({
                success: true,
                tokens: tokens
                    .sort((a, b) => {
                        return a.lastUsed < b.lastUsed;
                    })
                    .map((t) => {
                        return {
                            id: t.id,
                            ip: t.ip,
                            lastUsed: t.lastUsed
                        };
                    })
            });
        })
    );

    server.delete(
        '/api/account/:username/sessions/:id',
        passport.authenticate('jwt', { session: false }),
        wrapAsync(async (req, res) => {
            if (!req.params.username) {
                return res.send({ success: false, message: 'Username is required' });
            }

            if (!req.params.id) {
                return res.send({ success: false, message: 'Session Id is required' });
            }

            let user = await checkAuth(req, res);
            if (!user) {
                return;
            }

            let session = await userService.getRefreshTokenById(user.id, req.params.id);
            if (!session) {
                return res.status(404).send({ message: 'Not found' });
            }

            await userService.removeRefreshToken(user.id, req.params.id);

            res.send({
                success: true,
                message: 'Session deleted successfully',
                tokenId: req.params.id
            });
        })
    );

    server.get(
        '/api/account/:username/blocklist',
        passport.authenticate('jwt', { session: false }),
        wrapAsync(async (req, res) => {
            let user = await checkAuth(req, res);

            if (!user) {
                return;
            }

            let blockList = user.blockList || [];
            res.send({ success: true, blockList: blockList.sort() });
        })
    );

    server.post(
        '/api/account/:username/blocklist',
        passport.authenticate('jwt', { session: false }),
        wrapAsync(async (req, res) => {
            let user = await checkAuth(req, res);

            if (!user) {
                return;
            }

            if (!user.blockList) {
                user.blockList = [];
            }

            let lowerCaseUser = req.body.username.toLowerCase();

            if (
                user.blockList.find((user) => {
                    return user === lowerCaseUser;
                })
            ) {
                return res.send({ success: false, message: 'Entry already on block list' });
            }

            try {
                await userService.addBlocklistEntry(user, lowerCaseUser);
            } catch (err) {
                return res.send({ success: false, message: 'Block list entry failed to add' });
            }

            user.blockList.push(lowerCaseUser);

            userService.emit('onBlocklistChanged', {
                username: user.username,
                blockList: user.blockList
            });

            let updatedUser = await userService.getUserById(user.id);

            res.send({
                success: true,
                message: 'Block list entry added successfully',
                username: lowerCaseUser,
                user: updatedUser.getWireSafeDetails()
            });
        })
    );

    server.delete(
        '/api/account/:username/blocklist/:entry',
        passport.authenticate('jwt', { session: false }),
        wrapAsync(async (req, res) => {
            let user = await checkAuth(req, res);

            if (!user) {
                return;
            }

            user = user.getDetails();

            if (!req.params.entry) {
                return res.send({ success: false, message: 'Parameter "entry" is required' });
            }

            if (!user.blockList) {
                user.blockList = [];
            }

            let lowerCaseUser = req.params.entry.toLowerCase();

            if (
                !user.blockList.find((user) => {
                    return user === lowerCaseUser;
                })
            ) {
                return res.status(404).send({ message: 'Not found' });
            }

            try {
                await userService.deleteBlocklistEntry(user, lowerCaseUser);
            } catch (err) {
                return res.send({ success: false, message: 'Block list entry failed to remove' });
            }

            user.blockList = _.reject(user.blockList, (user) => {
                return user === lowerCaseUser;
            });

            userService.emit('onBlocklistChanged', {
                username: user.username,
                blockList: user.blockList
            });

            let updatedUser = await userService.getUserById(user.id);

            res.send({
                success: true,
                message: 'Block list entry removed successfully',
                username: lowerCaseUser,
                user: updatedUser.getWireSafeDetails()
            });
        })
    );

    server.post(
        '/api/account/:username/delete',
        passport.authenticate('jwt', { session: false }),
        wrapAsync(async (req, res) => {
            let user = await checkAuth(req, res);
            if (!user) {
                return;
            }

            if (!req.body.password) {
                return res.send({ success: false, message: 'Password must be specified' });
            }

            let isValidPassword;
            try {
                isValidPassword = await verifyPassword(req.body.password, user.password);
            } catch (err) {
                logger.error(err);
                return res.send({
                    success: false,
                    message:
                        'There was an error validating your login details.  Please try again later'
                });
            }

            if (!isValidPassword) {
                return res.send({ success: false, message: 'Invalid username/password' });
            }

            const oldAvatar = user.settings && user.settings.avatar;
            const oldCustomBackground = user.settings && user.settings.customBackground;

            await userService.anonymizeUser(user);

            removePng('public/img/avatar', oldAvatar);
            removePng('public/img/bgs', oldCustomBackground);

            return res.send({ success: true });
        })
    );

    // ARCHON (N12): /api/account/linkPatreon and /api/account/unlinkPatreon
    // moved to api/patreon.js, where the OAuth state check lives with the rest
    // of the flow. The paths are unchanged.
};

async function checkAuth(req, res) {
    let user = await userService.getFullUserByUsername(req.params.username);

    if (!req.user) {
        res.status(401).send({ message: 'Unauthorized' });

        return null;
    }

    if (req.user.username !== req.params.username) {
        res.status(403).send({ message: 'Forbidden' });

        return null;
    }

    if (!user) {
        res.status(404).send({ message: 'Not found' });

        return null;
    }

    return user;
}

// ARCHON: shared with the onboarding wizard's lightweight avatar endpoint
// (server/api/onboarding.js) so it reuses the exact same image pipeline.
module.exports.isValidImage = isValidImage;
module.exports.processAvatar = processAvatar;
