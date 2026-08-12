const { SESv2Client, SendEmailCommand } = require('@aws-sdk/client-sesv2');
const nodemailer = require('nodemailer');
const logger = require('../log.js');
const MailBudget = require('./MailBudget');

/**
 * Outbound transactional email (account activation, password reset) and
 * notification mail (round pairings, match scheduling, deadlines).
 *
 * Three transports, because the choice of provider should not be a code
 * decision:
 *
 *   resend  Resend over its HTTP API. One setting - RESEND_API_KEY - and no
 *           SMTP at all, which matters more than it sounds: a great many hosts
 *           block outbound 587 and 465 by default, and the failure that
 *           produces is a connection that hangs rather than an error that says
 *           what is wrong. An HTTPS POST goes out wherever the rest of the app
 *           already reaches the internet.
 *   smtp    any provider that speaks SMTP - Resend, Brevo, Postmark, Mailgun,
 *           Fastmail, a company relay. Sign up, verify the domain with DNS
 *           records, paste the credentials into .env.production.
 *   ses     AWS Simple Email Service, over its own API. Cheapest at volume, but
 *           it needs an AWS account and its sandbox has to be lifted by a
 *           support request before you can email anyone who has not verified
 *           themselves.
 *
 * Which one runs is decided by `lobby.emailTransport`: 'resend', 'smtp', 'ses',
 * or 'auto' (the default). Auto picks Resend when an API key is configured,
 * then SMTP when a host is, and SES otherwise - so a deployment already using
 * either keeps working with no change at all, and a new one only has to fill in
 * the one setting it actually has.
 *
 * ARCHON: the sender address is read from `lobby.emailFromAddress` - the key the
 * config files actually define. This used to read `lobby.emailFrom`, which is
 * defined nowhere, so `fromAddress` was always undefined and every send hit the
 * not-configured guard below: on a production deploy no activation or
 * password-reset mail could ever go out, and the only trace was an info-level
 * log line. A player who forgot their password had no way back into their
 * account.
 *
 * The client is injectable so the send path can be unit-tested without talking
 * to a real provider.
 */
class EmailService {
    /**
     * @param {object} configService
     * @param {object} [client] injected transport - the tests and check:email
     *   pass one so the send path can be exercised without a provider
     * @param {object} [options]
     * @param {object} [options.budget] a MailBudget, or null to disable the cap
     * @param {object} [options.db] database for the default budget
     */
    constructor(configService, client, options = {}) {
        this.fromAddress = configService.getValueForSection('lobby', 'emailFromAddress');
        this.replyToAddress = configService.getValueForSection('lobby', 'emailReplyTo');

        this.smtp = {
            host: configService.getValueForSection('lobby', 'smtpHost'),
            port: parseInt(configService.getValueForSection('lobby', 'smtpPort'), 10) || 587,
            user: configService.getValueForSection('lobby', 'smtpUser'),
            password: configService.getValueForSection('lobby', 'smtpPassword')
        };
        // Implicit TLS on 465, STARTTLS on everything else. That is the near
        // universal convention, and getting it backwards produces a connection
        // that hangs rather than an error that says what is wrong.
        const secureSetting = configService.getValueForSection('lobby', 'smtpSecure');
        this.smtp.secure =
            secureSetting === undefined || secureSetting === null || secureSetting === ''
                ? this.smtp.port === 465
                : !!secureSetting;

        this.sesRegion = configService.getValueForSection('lobby', 'awsSesRegion');
        this.resendApiKey = configService.getValueForSection('lobby', 'resendApiKey');

        this.transport = EmailService.resolveTransport(
            configService.getValueForSection('lobby', 'emailTransport'),
            this.smtp.host,
            this.resendApiKey
        );

        /**
         * The provider's plan, as a cap this service will not exceed.
         *
         * Off unless a limit is configured, so nothing changes for a deployment
         * on a paid plan or its own relay. `options.budget === null` disables it
         * outright, which is what the tests of the send path itself want.
         */
        if (options.budget !== undefined) {
            this.budget = options.budget;
        } else {
            const dailyLimit = configService.getValueForSection('lobby', 'emailDailyLimit');
            const monthlyLimit = configService.getValueForSection('lobby', 'emailMonthlyLimit');

            this.budget =
                dailyLimit || monthlyLimit
                    ? new MailBudget(options.db || require('../db'), {
                          dailyLimit,
                          monthlyLimit,
                          reserveFraction: configService.getValueForSection(
                              'lobby',
                              'emailBulkReserve'
                          )
                      })
                    : null;
        }

        if (client) {
            // Injected: the caller decides what it is. Used by the tests and by
            // check:email, which needs the same object the app would build.
            this.client = client;
        } else if (this.transport === 'resend') {
            // No SDK: one POST, and a dependency that exists only to build it
            // is a dependency to keep patched. `fetch` is built in on Node 18+.
            this.client = this.resendApiKey ? { apiKey: this.resendApiKey } : null;
        } else if (this.transport === 'smtp') {
            this.client = this.smtp.host
                ? nodemailer.createTransport({
                      host: this.smtp.host,
                      port: this.smtp.port,
                      secure: this.smtp.secure,
                      // Omitted entirely rather than passed empty: an unauthenticated
                      // relay is a real configuration, and nodemailer treats
                      // `auth: {user: undefined}` as an attempt to authenticate.
                      auth: this.smtp.user
                          ? { user: this.smtp.user, pass: this.smtp.password }
                          : undefined
                  })
                : null;
        } else {
            const awsAccessKeyId = configService.getValueForSection('lobby', 'awsAccessKeyId');
            const awsSecretAccessKey = configService.getValueForSection(
                'lobby',
                'awsSecretAccessKey'
            );

            this.client = new SESv2Client({
                region: this.sesRegion,
                // Omitted credentials let the SDK fall back to the instance role
                // or the standard AWS_* environment variables.
                credentials:
                    awsAccessKeyId && awsSecretAccessKey
                        ? { accessKeyId: awsAccessKeyId, secretAccessKey: awsSecretAccessKey }
                        : undefined
            });
        }
    }

    /**
     * 'resend' | 'smtp' | 'ses'. Exposed so the diagnostics can explain the
     * choice.
     *
     * Resend first in the automatic order because it is the one that can be
     * fully configured with a single setting, so a deployment that has set it
     * has said what it wants. SES stays last and stays the fallback: it is what
     * an existing deployment with AWS credentials in the environment and
     * nothing in the config file is already using.
     */
    static resolveTransport(setting, smtpHost, resendApiKey) {
        const requested = String(setting || 'auto').toLowerCase();

        if (requested === 'resend' || requested === 'smtp' || requested === 'ses') {
            return requested;
        }

        if (resendApiKey) {
            return 'resend';
        }

        return smtpHost ? 'smtp' : 'ses';
    }

    /**
     * What this deployment can and cannot do, as one answer.
     *
     * Everything that needs to know whether email works asks here - the startup
     * guard, `npm run check:email`, the health check - so they cannot drift into
     * disagreeing. `problems` is empty exactly when a send is worth attempting;
     * each entry names the setting to fix.
     */
    describeConfiguration() {
        // problems: this send cannot possibly work.
        // warnings: it probably will not, but something outside this config
        //           could still supply the missing piece, so refusing to try
        //           would be presumptuous - and would break a deployment that
        //           currently works.
        const problems = [];
        const warnings = [];

        if (!this.fromAddress) {
            problems.push(
                'No sender address (lobby.emailFromAddress / EMAIL_FROM_ADDRESS). ' +
                    'It must be an address at a domain the provider has verified.'
            );
        }

        if (this.transport === 'resend') {
            if (!this.resendApiKey) {
                problems.push('No Resend API key (lobby.resendApiKey / RESEND_API_KEY).');
            }
        } else if (this.transport === 'smtp') {
            if (!this.smtp.host) {
                problems.push('No SMTP host (lobby.smtpHost / SMTP_HOST).');
            }
            // A host with a username but no password is always a mistake; a host
            // with neither is a legitimate unauthenticated relay.
            if (this.smtp.user && !this.smtp.password) {
                problems.push(
                    'An SMTP username is set but no password (lobby.smtpPassword / SMTP_PASSWORD).'
                );
            }
        } else if (!this.sesRegion) {
            /**
             * ARCHON: a region from SOMEWHERE, or this is a problem.
             *
             * This used to be a warning unconditionally, and the reasoning was
             * sound as far as it went - the SESv2 client resolves a region from
             * AWS_REGION, AWS_DEFAULT_REGION or an instance profile, so
             * refusing to send would break a deployment quietly living off one
             * of those. What it missed is that SES is also the FALLBACK
             * transport, chosen when nothing at all is configured, and the
             * sender address is hardcoded in default.json5. So a deployment
             * that had configured no email whatsoever reported ready:true, the
             * health check printed "email configured", and every send then died
             * inside the AWS SDK where only an error log saw it. Green board, no
             * mail, and no reason on screen to look at email at all.
             *
             * Checking the environment the SDK would actually read keeps the
             * working deployment working and makes the empty one say so.
             */
            const environmentRegion = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION;

            if (environmentRegion) {
                warnings.push(
                    `No lobby.awsSesRegion / AWS_SES_REGION, falling back to ${environmentRegion} ` +
                        'from the environment.'
                );
            } else {
                problems.push(
                    'No email transport is configured. SES is the fallback and it has no region ' +
                        '(lobby.awsSesRegion / AWS_SES_REGION, or AWS_REGION in the environment), ' +
                        'so every send fails with "Region is missing". Set RESEND_API_KEY for ' +
                        'Resend, or SMTP_HOST for an SMTP provider.'
                );
            }
        }

        return {
            transport: this.transport,
            from: this.fromAddress,
            replyTo: this.replyToAddress,
            smtpHost: this.smtp.host,
            smtpPort: this.smtp.port,
            smtpSecure: this.smtp.secure,
            smtpUser: this.smtp.user,
            sesRegion: this.sesRegion,
            // Never the key itself - this object is printed by check:email and
            // by the health check.
            resendKeySet: !!this.resendApiKey,
            ready: problems.length === 0,
            problems,
            warnings
        };
    }

    /**
     * Whether email is configured well enough to be worth attempting.
     *
     * Deliberately stricter than "is there a sender address", which is what this
     * used to test. config/production.json5 hardcodes a sender, so that question
     * is always answered yes in production and the check was silent about a
     * deployment with no transport settings whatsoever.
     */
    isConfigured() {
        return this.describeConfiguration().ready;
    }

    /**
     * Send a message with both an HTML and a plain-text body. `html` is
     * optional - without it this behaves exactly as the text-only send always
     * did, so existing callers are unaffected.
     *
     * Returns false rather than throwing: a dropped notification must never
     * break the request that triggered it. Callers that need to know (like
     * registration, which rolls the account back) check the return value.
     *
     * `options.priority` is 'transactional' (the default) or 'bulk', and it
     * decides who yields when the provider's plan runs low - see MailBudget.
     * Anything a player is waiting on right now is transactional; anything the
     * site decided to tell them about is bulk.
     */
    async sendEmail(address, subject, text, html, options = {}) {
        const configuration = this.describeConfiguration();

        if (!configuration.ready) {
            // warn, not info: dropping an activation or reset mail locks a real
            // player out of their account, so it must stand out in the logs.
            logger.warn(
                `Email is not configured, dropped "${subject}". ` +
                    `${configuration.problems.join(' ')} ` +
                    'Account activation and password reset cannot work until this is fixed.'
            );

            return false;
        }

        const priority = options.priority === 'bulk' ? 'bulk' : 'transactional';

        if (this.budget) {
            const allowed = await this.budget.claim(priority);

            if (!allowed.ok) {
                // info for bulk: a pairing email skipped because the day's quota
                // is nearly gone is the budget working, and the in-app
                // notification still landed. warn for transactional, which
                // means somebody is locked out.
                const log = priority === 'bulk' ? logger.info : logger.warn;

                log.call(
                    logger,
                    `Email budget exhausted (${allowed.reason}), dropped ${priority} "${subject}". ` +
                        `${allowed.sentToday}/${allowed.dailyLimit} today, ` +
                        `${allowed.sentThisMonth}/${allowed.monthlyLimit} this month.`
                );

                return false;
            }
        }

        try {
            if (this.transport === 'resend') {
                await this.sendViaResend(address, subject, text, html);
            } else if (this.transport === 'smtp') {
                await this.client.sendMail({
                    from: this.fromAddress,
                    to: address,
                    replyTo: this.replyToAddress || undefined,
                    subject,
                    text,
                    html: html || undefined
                });
            } else {
                await this.client.send(
                    new SendEmailCommand({
                        FromEmailAddress: this.fromAddress,
                        Destination: { ToAddresses: [address] },
                        ReplyToAddresses: this.replyToAddress ? [this.replyToAddress] : undefined,
                        Content: {
                            Simple: {
                                Subject: { Data: subject },
                                // Both bodies when HTML is supplied: the provider
                                // sends a multipart/alternative and the client
                                // picks, so a text-only reader still gets a
                                // readable message.
                                Body: html
                                    ? { Text: { Data: text }, Html: { Data: html } }
                                    : { Text: { Data: text } }
                            }
                        }
                    })
                );
            }
        } catch (err) {
            // Named transport and the provider's own words. Every one of these
            // failures is a configuration problem with a specific cause -
            // an unverified sending domain, a key from the wrong environment,
            // a blocked SMTP port, an SES sandbox - and each provider says
            // which in the text it returns. "Unable to send email" alone left
            // an operator with nothing to pull on.
            logger.error(
                `Unable to send email via ${this.transport}: ${
                    err && err.message ? err.message : err
                }`
            );

            if (this.budget) {
                // The claim was optimistic - it had to be, since the provider's
                // counter is the one that matters and it only moves on a real
                // send. Give it back so a provider outage does not eat the day's
                // quota and leave activation mail refused after it recovers.
                await this.budget.release();
            }

            return false;
        }

        return true;
    }

    /**
     * Resend's send endpoint. One POST, no SDK.
     *
     * Throws on a non-2xx with the provider's own message in it, so the catch
     * above logs something an operator can act on: Resend's failures are almost
     * always one of three specific things - an unverified sending domain, a key
     * from the wrong environment, or the free plan's cap - and each says so
     * plainly in the response body.
     */
    async sendViaResend(address, subject, text, html) {
        const response = await fetch('https://api.resend.com/emails', {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${this.client.apiKey}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                from: this.fromAddress,
                to: [address],
                reply_to: this.replyToAddress || undefined,
                subject,
                text,
                html: html || undefined
            })
        });

        if (!response.ok) {
            const detail = await response.text().catch(() => '');

            throw new Error(
                `Resend refused the message (HTTP ${response.status}): ${detail.slice(0, 500)}`
            );
        }

        return response.json().catch(() => ({}));
    }
}

module.exports = EmailService;
