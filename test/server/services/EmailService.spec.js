const EmailService = require('../../../server/services/EmailService');

// Minimal stand-in for ConfigService: returns whatever the test put in the
// 'lobby' section and undefined for anything absent, matching how the real
// service reads config.
const createConfigService = (lobby = {}) => ({
    getValueForSection: (section, key) => (section === 'lobby' ? lobby[key] : undefined)
});

const createClient = () => ({ send: vi.fn(async () => ({})) });

describe('EmailService', function () {
    describe('configuration', function () {
        it('reads the sender from lobby.emailFromAddress', function () {
            const service = new EmailService(
                createConfigService({ emailFromAddress: 'noreply@archonarena.com' }),
                createClient()
            );

            expect(service.isConfigured()).toBe(true);
            expect(service.fromAddress).toBe('noreply@archonarena.com');
        });

        // Regression: the service used to read 'emailFrom', a key no config
        // file defines, so email was silently dead on every deployment.
        it('does not read the sender from the undefined lobby.emailFrom key', function () {
            const service = new EmailService(
                createConfigService({ emailFrom: 'noreply@archonarena.com' }),
                createClient()
            );

            expect(service.isConfigured()).toBe(false);
        });

        it('reports not configured when no sender is set', function () {
            const service = new EmailService(createConfigService({}), createClient());

            expect(service.isConfigured()).toBe(false);
        });
    });

    describe('sendEmail', function () {
        it('sends through SES and reports success', async function () {
            const client = createClient();
            const service = new EmailService(
                createConfigService({
                    emailFromAddress: 'noreply@archonarena.com',
                    emailReplyTo: 'support@archonarena.com'
                }),
                client
            );

            const sent = await service.sendEmail('player@example.com', 'Subject', 'Body');

            expect(sent).toBe(true);
            expect(client.send).toHaveBeenCalledTimes(1);

            const { input } = client.send.mock.calls[0][0];
            expect(input.FromEmailAddress).toBe('noreply@archonarena.com');
            expect(input.Destination.ToAddresses).toEqual(['player@example.com']);
            expect(input.ReplyToAddresses).toEqual(['support@archonarena.com']);
            expect(input.Content.Simple.Subject.Data).toBe('Subject');
            expect(input.Content.Simple.Body.Text.Data).toBe('Body');
        });

        it('omits ReplyToAddresses when no reply-to is configured', async function () {
            const client = createClient();
            const service = new EmailService(
                createConfigService({ emailFromAddress: 'noreply@archonarena.com' }),
                client
            );

            await service.sendEmail('player@example.com', 'Subject', 'Body');

            expect(client.send.mock.calls[0][0].input.ReplyToAddresses).toBeUndefined();
        });

        it('reports failure and sends nothing when email is not configured', async function () {
            const client = createClient();
            const service = new EmailService(createConfigService({}), client);

            const sent = await service.sendEmail('player@example.com', 'Subject', 'Body');

            expect(sent).toBe(false);
            expect(client.send).not.toHaveBeenCalled();
        });

        it('reports failure instead of throwing when SES rejects the send', async function () {
            const client = {
                send: vi.fn(async () => {
                    throw new Error('SES down');
                })
            };
            const service = new EmailService(
                createConfigService({ emailFromAddress: 'noreply@archonarena.com' }),
                client
            );

            const sent = await service.sendEmail('player@example.com', 'Subject', 'Body');

            expect(sent).toBe(false);
        });
    });
    /**
     * SMTP exists so the choice of email provider is not a code decision: any
     * of Resend, Brevo, Postmark, Mailgun or a company relay works without
     * touching this file. The transport is chosen from configuration, and these
     * pin down that choice - getting it wrong silently sends nothing.
     */
    describe('transport selection', function () {
        const smtpClient = () => ({ sendMail: vi.fn(async () => ({ messageId: 'x' })) });

        it('uses SES when nothing SMTP is configured', function () {
            const service = new EmailService(
                createConfigService({ emailFromAddress: 'noreply@archonarena.com' }),
                createClient()
            );

            expect(service.transport).toBe('ses');
        });

        // The whole point of the default: an existing SES deployment must not
        // change behaviour because SMTP support was added.
        it('uses SMTP as soon as a host is configured', function () {
            const service = new EmailService(
                createConfigService({
                    emailFromAddress: 'noreply@archonarena.com',
                    smtpHost: 'smtp.resend.com'
                }),
                smtpClient()
            );

            expect(service.transport).toBe('smtp');
        });

        it('honours an explicit setting over what happens to be configured', function () {
            const forcedSes = new EmailService(
                createConfigService({
                    emailFromAddress: 'noreply@archonarena.com',
                    smtpHost: 'smtp.resend.com',
                    emailTransport: 'ses'
                }),
                createClient()
            );
            const forcedSmtp = new EmailService(
                createConfigService({
                    emailFromAddress: 'noreply@archonarena.com',
                    emailTransport: 'smtp'
                }),
                smtpClient()
            );

            expect(forcedSes.transport).toBe('ses');
            expect(forcedSmtp.transport).toBe('smtp');
        });

        // 465 is implicit TLS, everything else STARTTLS. Backwards, the
        // connection hangs rather than reporting anything useful.
        it('infers implicit TLS from port 465 and STARTTLS otherwise', function () {
            const base = { emailFromAddress: 'a@b.com', smtpHost: 'smtp.example.com' };
            const implicit = new EmailService(
                createConfigService({ ...base, smtpPort: 465 }),
                smtpClient()
            );
            const starttls = new EmailService(
                createConfigService({ ...base, smtpPort: 587 }),
                smtpClient()
            );
            const overridden = new EmailService(
                createConfigService({ ...base, smtpPort: 587, smtpSecure: true }),
                smtpClient()
            );

            expect(implicit.smtp.secure).toBe(true);
            expect(starttls.smtp.secure).toBe(false);
            expect(overridden.smtp.secure).toBe(true);
        });

        it('defaults to port 587 when none is given', function () {
            const service = new EmailService(
                createConfigService({ emailFromAddress: 'a@b.com', smtpHost: 'smtp.example.com' }),
                smtpClient()
            );

            expect(service.smtp.port).toBe(587);
        });
    });

    describe('sending over SMTP', function () {
        const smtpConfig = {
            emailFromAddress: 'noreply@archonarena.com',
            emailReplyTo: 'support@archonarena.com',
            smtpHost: 'smtp.resend.com',
            smtpUser: 'resend',
            smtpPassword: 'secret'
        };

        it('sends and reports success', async function () {
            const client = { sendMail: vi.fn(async () => ({ messageId: 'x' })) };
            const service = new EmailService(createConfigService(smtpConfig), client);

            const sent = await service.sendEmail(
                'player@example.com',
                'Subject',
                'Body',
                '<p>Body</p>'
            );

            expect(sent).toBe(true);
            expect(client.sendMail).toHaveBeenCalledTimes(1);

            const message = client.sendMail.mock.calls[0][0];
            expect(message.from).toBe('noreply@archonarena.com');
            expect(message.to).toBe('player@example.com');
            expect(message.replyTo).toBe('support@archonarena.com');
            expect(message.subject).toBe('Subject');
            expect(message.text).toBe('Body');
            expect(message.html).toBe('<p>Body</p>');
        });

        // A text-only send must not carry an empty html part, which some clients
        // render as a blank message in preference to the text.
        it('omits the html part when none is supplied', async function () {
            const client = { sendMail: vi.fn(async () => ({ messageId: 'x' })) };
            const service = new EmailService(createConfigService(smtpConfig), client);

            await service.sendEmail('player@example.com', 'Subject', 'Body');

            expect(client.sendMail.mock.calls[0][0].html).toBeUndefined();
        });

        it('reports failure instead of throwing when the server rejects it', async function () {
            const client = {
                sendMail: vi.fn(async () => {
                    throw new Error('535 authentication failed');
                })
            };
            const service = new EmailService(createConfigService(smtpConfig), client);

            expect(await service.sendEmail('player@example.com', 'S', 'B')).toBe(false);
        });

        it('does not attempt a send with no host', async function () {
            const client = { sendMail: vi.fn() };
            const service = new EmailService(
                createConfigService({
                    emailFromAddress: 'noreply@archonarena.com',
                    emailTransport: 'smtp'
                }),
                client
            );

            expect(await service.sendEmail('player@example.com', 'S', 'B')).toBe(false);
            expect(client.sendMail).not.toHaveBeenCalled();
        });

        // Half-configured auth is always a mistake - and one that produces a
        // confusing server-side rejection rather than an obvious local error.
        it('refuses a username with no password', async function () {
            const client = { sendMail: vi.fn() };
            const service = new EmailService(
                createConfigService({
                    emailFromAddress: 'noreply@archonarena.com',
                    smtpHost: 'smtp.example.com',
                    smtpUser: 'someone'
                }),
                client
            );

            const description = service.describeConfiguration();

            expect(description.ready).toBe(false);
            expect(description.problems.join(' ')).toMatch(/password/i);
            expect(await service.sendEmail('player@example.com', 'S', 'B')).toBe(false);
            expect(client.sendMail).not.toHaveBeenCalled();
        });

        it('allows an unauthenticated relay', function () {
            const service = new EmailService(
                createConfigService({
                    emailFromAddress: 'noreply@archonarena.com',
                    smtpHost: 'relay.internal'
                }),
                { sendMail: vi.fn() }
            );

            expect(service.describeConfiguration().ready).toBe(true);
        });
    });

    describe('describeConfiguration', function () {
        // A missing SES region is NOT fatal: the AWS SDK still resolves one from
        // AWS_REGION or an instance profile, and refusing to send would break a
        // deployment that has been working off that all along.
        it('warns about a missing SES region without blocking the send', function () {
            const service = new EmailService(
                createConfigService({ emailFromAddress: 'noreply@archonarena.com' }),
                createClient()
            );
            const description = service.describeConfiguration();

            expect(description.ready).toBe(true);
            expect(description.warnings.join(' ')).toMatch(/AWS_SES_REGION/);
            expect(description.problems).toEqual([]);
        });

        it('treats a missing sender as fatal on either transport', function () {
            for (const extra of [{}, { smtpHost: 'smtp.example.com' }]) {
                const description = new EmailService(
                    createConfigService(extra),
                    createClient()
                ).describeConfiguration();

                expect(description.ready).toBe(false);
                expect(description.problems.join(' ')).toMatch(/sender address/i);
            }
        });
    });
});
