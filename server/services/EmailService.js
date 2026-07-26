const { SESv2Client, SendEmailCommand } = require('@aws-sdk/client-sesv2');
const logger = require('../log.js');

/**
 * Outbound transactional email (account activation, password reset) over AWS SES.
 *
 * ARCHON: the sender address is read from `lobby.emailFromAddress` - the key the
 * config files actually define (config/default.json5, config/production.json5).
 * This used to read `lobby.emailFrom`, which is defined nowhere, so `fromAddress`
 * was always undefined and every send hit the not-configured guard below: on a
 * production deploy no activation or password-reset mail could ever go out, and
 * the only trace was an info-level log line. A player who forgot their password
 * had no way back into their account.
 *
 * The SES client is injectable so the send path can be unit-tested without
 * talking to AWS.
 */
class EmailService {
    constructor(configService, client) {
        this.fromAddress = configService.getValueForSection('lobby', 'emailFromAddress');
        this.replyToAddress = configService.getValueForSection('lobby', 'emailReplyTo');
        const awsAccessKeyId = configService.getValueForSection('lobby', 'awsAccessKeyId');
        const awsSecretAccessKey = configService.getValueForSection('lobby', 'awsSecretAccessKey');

        this.client =
            client ||
            new SESv2Client({
                region: configService.getValueForSection('lobby', 'awsSesRegion'),
                // Omitted credentials let the SDK fall back to the instance role
                // or the standard AWS_* environment variables.
                credentials:
                    awsAccessKeyId && awsSecretAccessKey
                        ? { accessKeyId: awsAccessKeyId, secretAccessKey: awsSecretAccessKey }
                        : undefined
            });
    }

    /**
     * Whether a sender address is configured. Surfaced so startup and the
     * production health check can flag a site that silently cannot send mail.
     */
    isConfigured() {
        return !!this.fromAddress;
    }

    async sendEmail(address, subject, text) {
        if (!this.fromAddress) {
            // warn, not info: dropping an activation or reset mail locks a real
            // player out of their account, so it must stand out in the logs.
            logger.warn(
                `Email not configured (lobby.emailFromAddress is unset) - dropped "${subject}". ` +
                    'Account activation and password reset cannot work until it is set.'
            );

            return false;
        }

        try {
            await this.client.send(
                new SendEmailCommand({
                    FromEmailAddress: this.fromAddress,
                    Destination: { ToAddresses: [address] },
                    ReplyToAddresses: this.replyToAddress ? [this.replyToAddress] : undefined,
                    Content: {
                        Simple: {
                            Subject: { Data: subject },
                            Body: { Text: { Data: text } }
                        }
                    }
                })
            );
        } catch (err) {
            logger.error('Unable to send email %s', err);

            return false;
        }

        return true;
    }
}

module.exports = EmailService;
