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
            // A region as well as a sender: SES with neither a region here nor
            // one in the environment is not a configuration that can send, and
            // this test is about which key the sender is read from.
            const service = new EmailService(
                createConfigService({
                    emailFromAddress: 'noreply@archonarena.com',
                    awsSesRegion: 'us-east-1'
                }),
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
                    emailReplyTo: 'support@archonarena.com',
                    awsSesRegion: 'us-east-1'
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
                createConfigService({
                    emailFromAddress: 'noreply@archonarena.com',
                    awsSesRegion: 'us-east-1'
                }),
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
        /**
         * ARCHON: a missing SES region is a warning only when the SDK can still
         * find one somewhere.
         *
         * This pair used to be a single test asserting ready:true whatever the
         * environment held, and the reasoning behind it was half right: the
         * SESv2 client does resolve a region from AWS_REGION, AWS_DEFAULT_REGION
         * or an instance profile, so refusing to send would break a deployment
         * quietly living off one of those.
         *
         * What it missed is that SES is also the FALLBACK transport - the one
         * chosen when nothing at all is configured - and the sender address is
         * hardcoded in default.json5. So a deployment that had configured no
         * email whatsoever reported ready:true, the health check printed "email
         * configured", and every send then died inside the AWS SDK where only an
         * error log saw it. A green board and no mail, with nothing on screen
         * suggesting email was even worth looking at.
         */
        it('warns about a missing SES region when the environment supplies one', function () {
            const previous = process.env.AWS_REGION;

            process.env.AWS_REGION = 'us-east-1';

            try {
                const description = new EmailService(
                    createConfigService({ emailFromAddress: 'noreply@archonarena.com' }),
                    createClient()
                ).describeConfiguration();

                expect(description.ready).toBe(true);
                expect(description.warnings.join(' ')).toMatch(/us-east-1/);
                expect(description.problems).toEqual([]);
            } finally {
                if (previous === undefined) {
                    delete process.env.AWS_REGION;
                } else {
                    process.env.AWS_REGION = previous;
                }
            }
        });

        it('refuses to claim it is configured when nothing at all is set', function () {
            const previousRegion = process.env.AWS_REGION;
            const previousDefault = process.env.AWS_DEFAULT_REGION;

            delete process.env.AWS_REGION;
            delete process.env.AWS_DEFAULT_REGION;

            try {
                // Exactly the state a fresh deployment is in: the sender comes
                // from default.json5 and the operator has set nothing.
                const description = new EmailService(
                    createConfigService({ emailFromAddress: 'noreply@archonarena.com' }),
                    createClient()
                ).describeConfiguration();

                expect(description.ready).toBe(false);
                expect(description.problems.join(' ')).toMatch(/No email transport is configured/);
                // And it names the two ways out, because "not configured" with
                // no next step is the same as no message at all.
                expect(description.problems.join(' ')).toMatch(/RESEND_API_KEY/);
                expect(description.problems.join(' ')).toMatch(/SMTP_HOST/);
            } finally {
                if (previousRegion !== undefined) {
                    process.env.AWS_REGION = previousRegion;
                }

                if (previousDefault !== undefined) {
                    process.env.AWS_DEFAULT_REGION = previousDefault;
                }
            }
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

    /**
     * ARCHON: Resend over its HTTP API.
     *
     * One setting instead of four, and no SMTP at all - which is the reason to
     * have it rather than just pointing the SMTP transport at smtp.resend.com.
     * A great many hosts block outbound 587 and 465 by default, and what that
     * produces is a connection that hangs rather than an error that says what
     * is wrong. An HTTPS POST goes out wherever the rest of the app already
     * reaches the internet.
     */
    describe('Resend', function () {
        const resendConfig = {
            emailFromAddress: 'noreply@archonarena.com',
            resendApiKey: 're_test_key'
        };

        it('is chosen as soon as an API key is set', function () {
            const service = new EmailService(createConfigService(resendConfig), null, {
                budget: null
            });

            expect(service.transport).toBe('resend');
            expect(service.isConfigured()).toBe(true);
        });

        // A key beats a host: a deployment that set both has said which one it
        // wants by setting the one that needs no other settings.
        it('is preferred over SMTP when both are configured', function () {
            const service = new EmailService(
                createConfigService({ ...resendConfig, smtpHost: 'smtp.example.com' }),
                null,
                { budget: null }
            );

            expect(service.transport).toBe('resend');
        });

        it('can be forced off in favour of SMTP', function () {
            const service = new EmailService(
                createConfigService({
                    ...resendConfig,
                    smtpHost: 'smtp.example.com',
                    emailTransport: 'smtp'
                }),
                null,
                { budget: null }
            );

            expect(service.transport).toBe('smtp');
        });

        it('says what is missing when the transport is forced without a key', function () {
            const description = new EmailService(
                createConfigService({
                    emailFromAddress: 'noreply@archonarena.com',
                    emailTransport: 'resend'
                }),
                null,
                { budget: null }
            ).describeConfiguration();

            expect(description.ready).toBe(false);
            expect(description.problems.join(' ')).toMatch(/RESEND_API_KEY/);
        });

        it('never puts the API key in the description', function () {
            const description = new EmailService(createConfigService(resendConfig), null, {
                budget: null
            }).describeConfiguration();

            // check:email and the health check both print this object.
            expect(JSON.stringify(description)).not.toContain('re_test_key');
            expect(description.resendKeySet).toBe(true);
        });

        describe('the send itself', function () {
            let fetchMock;
            const originalFetch = global.fetch;

            beforeEach(function () {
                fetchMock = vi.fn(async () => ({
                    ok: true,
                    status: 200,
                    json: async () => ({ id: 'msg_1' }),
                    text: async () => ''
                }));
                global.fetch = fetchMock;
            });

            afterEach(function () {
                global.fetch = originalFetch;
            });

            it('posts the message and reports success', async function () {
                const service = new EmailService(
                    createConfigService({
                        ...resendConfig,
                        emailReplyTo: 'support@archonarena.com'
                    }),
                    null,
                    { budget: null }
                );

                const sent = await service.sendEmail(
                    'player@example.com',
                    'Subject',
                    'Body',
                    '<p>Body</p>'
                );

                expect(sent).toBe(true);
                expect(fetchMock).toHaveBeenCalledTimes(1);

                const [url, init] = fetchMock.mock.calls[0];

                expect(url).toBe('https://api.resend.com/emails');
                expect(init.method).toBe('POST');
                expect(init.headers.Authorization).toBe('Bearer re_test_key');

                const body = JSON.parse(init.body);

                expect(body.from).toBe('noreply@archonarena.com');
                expect(body.to).toEqual(['player@example.com']);
                expect(body.reply_to).toBe('support@archonarena.com');
                expect(body.subject).toBe('Subject');
                expect(body.text).toBe('Body');
                expect(body.html).toBe('<p>Body</p>');
            });

            it('omits the html part when none is supplied', async function () {
                const service = new EmailService(createConfigService(resendConfig), null, {
                    budget: null
                });

                await service.sendEmail('player@example.com', 'Subject', 'Body');

                expect(JSON.parse(fetchMock.mock.calls[0][1].body).html).toBeUndefined();
            });

            /**
             * Resend refuses for three reasons in practice - an unverified
             * sending domain, a key from the wrong environment, and the free
             * plan's cap - and it says which in the response body. Losing that
             * body would leave an operator with "email doesn't work" and no
             * thread to pull.
             */
            it('reports failure instead of throwing, keeping the provider reason', async function () {
                const logger = require('../../../server/log');
                const errors = [];

                vi.spyOn(logger, 'error').mockImplementation((...args) => errors.push(args));

                global.fetch = vi.fn(async () => ({
                    ok: false,
                    status: 403,
                    text: async () => '{"message":"The archonarena.com domain is not verified."}',
                    json: async () => ({})
                }));

                const service = new EmailService(createConfigService(resendConfig), null, {
                    budget: null
                });

                const sent = await service.sendEmail('player@example.com', 'Subject', 'Body');

                expect(sent).toBe(false);

                const logged = errors.flat().join(' ');

                expect(logged).toMatch(/not verified/);
                expect(logged).toMatch(/403/);
                // And which transport refused, so an operator knows where to
                // look without reading the config first.
                expect(logged).toMatch(/resend/);

                vi.restoreAllMocks();
            });
        });
    });

    /**
     * ARCHON: the provider's plan is a cliff.
     *
     * Past a free plan's daily cap the provider refuses ALL mail, and
     * registration rolls an account back when its activation email fails - so
     * an afternoon of pairing emails can stop new sign-ups entirely. The budget
     * makes notification mail run out first. The arithmetic is MailBudget's;
     * what matters here is that sendEmail consults it and honours the answer.
     */
    describe('the send budget', function () {
        const allow = () => ({
            claim: vi.fn(async () => ({ ok: true })),
            release: vi.fn(async () => {})
        });
        const refuse = () => ({
            claim: vi.fn(async () => ({
                ok: false,
                reason: 'daily',
                sentToday: 80,
                sentThisMonth: 80,
                dailyLimit: 100,
                monthlyLimit: 3000
            })),
            release: vi.fn(async () => {})
        });
        const sesConfig = {
            emailFromAddress: 'noreply@archonarena.com',
            awsSesRegion: 'us-east-1'
        };

        it('sends nothing when the budget refuses', async function () {
            const client = createClient();
            const budget = refuse();
            const service = new EmailService(createConfigService(sesConfig), client, { budget });

            const sent = await service.sendEmail('a@b.com', 'Subject', 'Body', undefined, {
                priority: 'bulk'
            });

            expect(sent).toBe(false);
            expect(client.send).not.toHaveBeenCalled();
        });

        it('classes a send as transactional unless told otherwise', async function () {
            const budget = allow();
            const service = new EmailService(createConfigService(sesConfig), createClient(), {
                budget
            });

            await service.sendEmail('a@b.com', 'Subject', 'Body');

            expect(budget.claim).toHaveBeenCalledWith('transactional');
        });

        it('passes the callers priority through', async function () {
            const budget = allow();
            const service = new EmailService(createConfigService(sesConfig), createClient(), {
                budget
            });

            await service.sendEmail('a@b.com', 'Subject', 'Body', undefined, { priority: 'bulk' });

            expect(budget.claim).toHaveBeenCalledWith('bulk');
        });

        // The claim is optimistic - it has to be, or two sends race and both
        // read the same count. A provider outage must not then eat the day's
        // quota and leave activation mail refused after it recovers.
        it('gives the claim back when the provider refuses the message', async function () {
            const budget = allow();
            const service = new EmailService(
                createConfigService(sesConfig),
                {
                    send: vi.fn(async () => {
                        throw new Error('SES down');
                    })
                },
                { budget }
            );

            expect(await service.sendEmail('a@b.com', 'Subject', 'Body')).toBe(false);
            expect(budget.release).toHaveBeenCalledTimes(1);
        });

        it('keeps the claim when the send succeeds', async function () {
            const budget = allow();
            const service = new EmailService(createConfigService(sesConfig), createClient(), {
                budget
            });

            expect(await service.sendEmail('a@b.com', 'Subject', 'Body')).toBe(true);
            expect(budget.release).not.toHaveBeenCalled();
        });

        // A deployment on a paid plan or its own relay configures no limits and
        // must be unaffected.
        it('is absent entirely when no limits are configured', function () {
            const service = new EmailService(createConfigService(sesConfig), createClient());

            expect(service.budget).toBeNull();
        });

        it('is built from the configured limits', function () {
            const service = new EmailService(
                createConfigService({
                    ...sesConfig,
                    emailDailyLimit: 100,
                    emailMonthlyLimit: 3000,
                    emailBulkReserve: 0.2
                }),
                createClient(),
                { db: { query: vi.fn() } }
            );

            expect(service.budget).toBeTruthy();
            expect(service.budget.dailyLimit).toBe(100);
            expect(service.budget.monthlyLimit).toBe(3000);
            expect(service.budget.ceilingFor('bulk', 100)).toBe(80);
        });
    });
});
