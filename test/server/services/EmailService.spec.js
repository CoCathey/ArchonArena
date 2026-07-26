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
});
