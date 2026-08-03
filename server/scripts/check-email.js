#!/usr/bin/env node
/*
 * Prove that transactional email actually works, before players depend on it.
 *
 * With `lobby.requireActivation` on, registration depends on outbound mail: if
 * a send fails the account is rolled back, so broken email means the site takes
 * no new accounts at all. This is the check that tells you which of those you
 * have, without needing a volunteer to try registering.
 *
 * The boot-time guard cannot answer this. It can only see whether the settings
 * look complete - not whether the provider accepts them, the DNS is verified,
 * or the credentials are live. The only honest test of "can this deployment
 * send email" is to send an email.
 *
 * Works with whichever transport is configured, SMTP or SES, and deliberately
 * uses the same ConfigService and EmailService the app uses. A check that built
 * its own client would prove the provider works, which is not the question -
 * the question is whether *this app, as configured here* works.
 *
 * Usage, on the server, in the app directory:
 *   npm run check:email -- you@example.com
 *   docker compose -f docker-compose.prod.yml exec lobby npm run check:email -- you@example.com
 */
const ConfigService = require('../services/ConfigService');
const EmailService = require('../services/EmailService');
const { renderHtmlEmail, renderTextEmail } = require('../services/emailTemplate');

const target = process.argv[2];

const say = (...parts) => console.log(...parts);

const fail = (headline, detail) => {
    say(`\n✗ ${headline}`);
    if (detail) {
        say(`\n${detail}`);
    }
    process.exit(1);
};

if (!target || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(target)) {
    say('Usage: npm run check:email -- <address-to-send-a-test-message-to>');
    say('\nUse an address you can actually open. In the SES sandbox it must also');
    say('be a verified identity, or the send is rejected.');
    process.exit(1);
}

/**
 * Turn an AWS error into the thing to go and fix. These are the failures a real
 * setup hits, in the order people hit them; anything unrecognised is printed
 * raw rather than guessed at.
 */
const explain = (err) => {
    const name = err.name || '';
    const message = err.message || String(err);
    const code = err.code || '';

    // --- SMTP ---------------------------------------------------------------
    if (/EAUTH/i.test(code + name) || /535|authentication failed|Invalid login/i.test(message)) {
        return (
            'The SMTP server rejected the credentials.\n' +
            '  Check SMTP_USER and SMTP_PASSWORD. Most providers want an API key or an\n' +
            '  app-specific password here, not your account password.'
        );
    }

    if (/ENOTFOUND|EAI_AGAIN/i.test(code + message)) {
        return (
            'The SMTP host could not be resolved.\n' +
            '  Check SMTP_HOST for a typo, and that the container has DNS.'
        );
    }

    if (/ECONNREFUSED|ETIMEDOUT|ESOCKET/i.test(code + message)) {
        return (
            'Could not connect to the SMTP server.\n' +
            '  Check SMTP_PORT (587 for STARTTLS, 465 for implicit TLS) and that the host\n' +
            '  firewall allows outbound connections on it. Many providers block 25.\n' +
            '  A port/TLS mismatch usually looks like a hang rather than a refusal: if\n' +
            '  SMTP_PORT is 465 leave SMTP_SECURE blank or true, and false for 587.'
        );
    }

    if (/wrong version number|SSL routines|self.signed/i.test(message)) {
        return (
            'TLS handshake failed - the port and the TLS mode disagree.\n' +
            '  Use 587 with SMTP_SECURE unset/false (STARTTLS), or 465 with it true.'
        );
    }

    if (/550|553|relay|not allowed|sender/i.test(message) && /smtp/i.test(name + code + message)) {
        return (
            'The server accepted the connection but refused the sender.\n' +
            '  EMAIL_FROM_ADDRESS must be at a domain this provider has verified for you.'
        );
    }

    // --- SES ----------------------------------------------------------------
    if (/Region is missing|Invalid region/i.test(message)) {
        return (
            'No AWS region reached the app.\n' +
            '  Set AWS_SES_REGION in .env.production (e.g. us-east-1) and confirm\n' +
            '  docker-compose.prod.yml forwards it to the lobby service.'
        );
    }

    if (/Could not load credentials|CredentialsProviderError|security token/i.test(message)) {
        return (
            'No usable AWS credentials.\n' +
            '  Set AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY in .env.production,\n' +
            '  or give the host an instance role with ses:SendEmail.'
        );
    }

    if (/not verified/i.test(message)) {
        return (
            'SES rejected the send because an address is not a verified identity.\n' +
            '  If the account is still in the SES sandbox, BOTH the sender and the\n' +
            '  recipient must be verified. Verify the domain (or this recipient), or\n' +
            '  request production access to lift the sandbox.'
        );
    }

    if (/AccessDenied|not authorized/i.test(name + message)) {
        return (
            'The credentials work but are not allowed to send.\n' +
            '  The IAM policy needs ses:SendEmail (and ses:SendRawEmail).'
        );
    }

    if (/Throttl|Limit|Quota/i.test(name + message)) {
        return 'SES is throttling or the sending quota is exhausted. Check the SES console.';
    }

    return `Unrecognised failure - the raw error was:\n  ${name}${name ? ': ' : ''}${message}`;
};

async function main() {
    const configService = new ConfigService();
    const emailService = new EmailService(configService);

    const appName = configService.getValueForSection('lobby', 'appName');
    const requireActivation = configService.getValueForSection('lobby', 'requireActivation');
    const configuration = emailService.describeConfiguration();

    say('Resolved configuration');
    say(`  environment           ${process.env.NODE_ENV || '(unset)'}`);
    say(`  transport             ${configuration.transport}`);
    say(`  from                  ${configuration.from || '(not set)'}`);
    say(`  reply-to              ${configuration.replyTo || '(not set)'}`);

    if (configuration.transport === 'smtp') {
        say(`  smtp host             ${configuration.smtpHost || '(not set)'}`);
        say(
            `  smtp port             ${configuration.smtpPort} ` +
                `(${configuration.smtpSecure ? 'implicit TLS' : 'STARTTLS'})`
        );
        // Never print the password; whether a username is present is the signal.
        say(
            `  smtp auth             ${
                configuration.smtpUser
                    ? `as ${configuration.smtpUser}`
                    : 'none (unauthenticated relay)'
            }`
        );
    } else {
        say(`  aws region            ${configuration.sesRegion || '(not set)'}`);
        say(
            `  credentials           ${
                configService.getValueForSection('lobby', 'awsAccessKeyId')
                    ? 'explicit key configured'
                    : 'none set (instance role or AWS_* environment, if any)'
            }`
        );
    }

    say(`  requireActivation     ${requireActivation}`);

    for (const warning of configuration.warnings) {
        say(`\n  ! ${warning}`);
    }

    if (requireActivation) {
        say('\nVerification is REQUIRED, so registration depends on this working.');
        say('A failure here means the site cannot take new accounts.');
    } else {
        say('\nVerification is OFF, so registration does not depend on this.');
        say('Password reset still does - a player who forgets their password has no');
        say('way back into their account without working email.');
    }

    if (!configuration.ready) {
        fail(
            'Email is not configured well enough to attempt a send.',
            `${configuration.problems.map((problem) => `  - ${problem}`).join('\n')}\n\n` +
                'Note that config/production.json5 sets a sender address by default, so a\n' +
                'complaint about that one in production usually means NODE_ENV or\n' +
                'NODE_CONFIG_ENV is not "production".'
        );
    }

    const body = {
        appName,
        title: 'Email is working',
        paragraphs: [
            `This is a test message from ${appName}, sent by \`npm run check:email\`.`,
            'If you are reading it, activation and password-reset mail can reach players.'
        ],
        footer: 'Nobody was signed up and nothing was changed by this check.'
    };

    say(`\nSending a test message to ${target} ...`);

    // sendEmail catches its own errors and returns false, which is right for the
    // request path but useless for diagnosis - so go through the client directly
    // when the friendly path fails, purely to get the underlying error out.
    const sent = await emailService.sendEmail(
        target,
        `${appName} - email check`,
        renderTextEmail(body),
        renderHtmlEmail(body)
    );

    if (sent) {
        const via = configuration.transport === 'smtp' ? configuration.smtpHost : 'SES';

        say(`\n✓ ${via} accepted the message for ${target}.`);
        say('\nAccepted is not the same as arrived. Open the inbox, and check the spam');
        say('folder too - activation mail that lands in spam costs you sign-ups exactly');
        say('as effectively as mail that was never sent.');

        return;
    }

    // sendEmail catches its own errors and returns false, which is right for the
    // request path but useless for diagnosis - so repeat the send through the
    // client directly, purely to get the underlying error out.
    let underlying;
    try {
        if (configuration.transport === 'smtp') {
            await emailService.client.sendMail({
                from: emailService.fromAddress,
                to: target,
                subject: `${appName} - email check`,
                text: renderTextEmail(body)
            });
        } else {
            const { SendEmailCommand } = require('@aws-sdk/client-sesv2');

            await emailService.client.send(
                new SendEmailCommand({
                    FromEmailAddress: emailService.fromAddress,
                    Destination: { ToAddresses: [target] },
                    Content: {
                        Simple: {
                            Subject: { Data: `${appName} - email check` },
                            Body: { Text: { Data: renderTextEmail(body) } }
                        }
                    }
                })
            );
        }
    } catch (err) {
        underlying = err;
    }

    fail(
        'The message was not sent.',
        underlying ? explain(underlying) : 'No error was surfaced - check the application log.'
    );
}

main().catch((err) => {
    fail('The check itself failed to run.', explain(err));
});
