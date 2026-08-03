const { SESv2Client, SendEmailCommand } = require('@aws-sdk/client-sesv2');
const nodemailer = require('nodemailer');
const logger = require('../log.js');

/**
 * Outbound transactional email (account activation, password reset).
 *
 * Two transports, because the choice of provider should not be a code decision:
 *
 *   smtp  any provider that speaks SMTP - Resend, Brevo, Postmark, Mailgun,
 *         Fastmail, a company relay. Sign up, verify the domain with DNS
 *         records, paste the credentials into .env.production.
 *   ses   AWS Simple Email Service, over its own API. Cheapest at volume, but
 *         it needs an AWS account and its sandbox has to be lifted by a support
 *         request before you can email anyone who has not verified themselves.
 *
 * Which one runs is decided by `lobby.emailTransport`: 'smtp', 'ses', or 'auto'
 * (the default). Auto picks SMTP when an SMTP host is configured and SES
 * otherwise, so a deployment that was already using SES keeps working with no
 * change at all, and a new one only has to fill in the settings it actually has.
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
    constructor(configService, client) {
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

        this.transport = EmailService.resolveTransport(
            configService.getValueForSection('lobby', 'emailTransport'),
            this.smtp.host
        );

        if (client) {
            // Injected: the caller decides what it is. Used by the tests and by
            // check:email, which needs the same object the app would build.
            this.client = client;
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

    /** 'smtp' | 'ses'. Exposed so the diagnostics can explain the choice. */
    static resolveTransport(setting, smtpHost) {
        const requested = String(setting || 'auto').toLowerCase();

        if (requested === 'smtp' || requested === 'ses') {
            return requested;
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

        if (this.transport === 'smtp') {
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
            // A warning rather than a problem: the SESv2 client has no built-in
            // default region, but the SDK still resolves one from AWS_REGION,
            // AWS_DEFAULT_REGION or an instance profile. Treating this as fatal
            // would refuse to send on a deployment that has been working fine
            // off AWS_REGION all along.
            warnings.push(
                'No lobby.awsSesRegion / AWS_SES_REGION. The AWS SDK may still find a region ' +
                    'in AWS_REGION or an instance profile; if it cannot, the send fails with ' +
                    '"Region is missing".'
            );
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
     */
    async sendEmail(address, subject, text, html) {
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

        try {
            if (this.transport === 'smtp') {
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
            logger.error('Unable to send email %s', err);

            return false;
        }

        return true;
    }
}

module.exports = EmailService;
