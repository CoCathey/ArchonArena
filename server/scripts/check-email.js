#!/usr/bin/env node
/*
 * Prove that transactional email actually works, before players depend on it.
 *
 * With `lobby.requireActivation` on, registration depends on outbound mail: if
 * a send fails the account is rolled back, so a broken SES setup means the site
 * takes no new accounts at all. This is the check that tells you which of those
 * you have, without needing a volunteer to try registering.
 *
 * It matters because the boot-time guard cannot cover this case. That guard
 * asks whether a sender address is configured - and config/production.json5
 * hardcodes one, so in production it is always satisfied and always silent,
 * even with no region and no credentials. The only honest test of "can this
 * deployment send email" is to send an email.
 *
 * Deliberately uses the same ConfigService and EmailService the app uses. A
 * check that builds its own client would prove that AWS works, which is not the
 * question - the question is whether *this app, as configured here* works.
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

    const from = configService.getValueForSection('lobby', 'emailFromAddress');
    const replyTo = configService.getValueForSection('lobby', 'emailReplyTo');
    const region = configService.getValueForSection('lobby', 'awsSesRegion');
    const keyId = configService.getValueForSection('lobby', 'awsAccessKeyId');
    const appName = configService.getValueForSection('lobby', 'appName');
    const requireActivation = configService.getValueForSection('lobby', 'requireActivation');

    say('Resolved configuration');
    say(`  environment           ${process.env.NODE_ENV || '(unset)'}`);
    say(`  emailFromAddress      ${from || '(not set)'}`);
    say(`  emailReplyTo          ${replyTo || '(not set)'}`);
    say(`  awsSesRegion          ${region || '(not set)'}`);
    // Never print the secret; whether a key id is present is the useful signal.
    say(
        `  credentials           ${
            keyId ? 'explicit key configured' : 'none set (instance role, if any)'
        }`
    );
    say(`  requireActivation     ${requireActivation}`);

    if (requireActivation) {
        say('\nVerification is REQUIRED, so registration depends on this working.');
        say('A failure here means the site cannot take new accounts.');
    } else {
        say('\nVerification is OFF, so registration does not depend on this.');
        say('Password reset still does - a player who forgets their password has no');
        say('way back into their account without working email.');
    }

    if (!emailService.isConfigured()) {
        fail(
            'No sender address configured.',
            'Set EMAIL_FROM_ADDRESS in .env.production. Note that config/production.json5\n' +
                'sets one by default, so seeing this in production usually means NODE_ENV or\n' +
                'NODE_CONFIG_ENV is not "production".'
        );
    }

    if (!region) {
        fail(
            'No AWS region configured.',
            'The SES client cannot send without one. Set AWS_SES_REGION in\n' +
                '.env.production (e.g. us-east-1) - and check that\n' +
                'docker-compose.prod.yml actually forwards it into the container.'
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
        say(`\n✓ SES accepted the message for ${target}.`);
        say('\nSES accepting it is not the same as it arriving. Open the inbox and');
        say('check the spam folder too - a message that lands in spam will lose you');
        say('sign-ups just as effectively as one that is never sent.');

        return;
    }

    let underlying;
    try {
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
