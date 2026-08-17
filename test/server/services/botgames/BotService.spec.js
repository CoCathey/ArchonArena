const BotService = require('../../../../server/services/botgames/BotService');
const { BOT_ROSTER } = require('../../../../server/services/botgames/roster');
const User = require('../../../../server/models/User');

/**
 * ARCHON (F9): the practice bot roster.
 *
 * Three properties are load-bearing and each has a spec here:
 *
 *  - **A bot is its house.** It only ever plays decks containing it, and the
 *    account binding is keyed on the house, so renaming a character cannot
 *    rebind it to a different set of decks.
 *  - **A bot can never capture a person's account.** The sentinel email is
 *    the proof of ownership; a name already held by anybody else means that
 *    bot does not play, rather than the site seating a bot in their name.
 *  - **Only a bot that can actually play is offered a table.** Enabled, with
 *    a deck of its house, and not already sitting somewhere else.
 */

const botUser = (id, username, house) =>
    new User({
        id,
        username,
        email: `bot+${house}@archon-bots.invalid`,
        settings: {},
        permissions: {},
        blockList: []
    });

const personCalled = (username) =>
    new User({
        id: 999,
        username,
        email: 'a-real-person@example.com',
        settings: {},
        permissions: {},
        blockList: []
    });

/** A database with the Bots table and the queries the service runs on it. */
const makeDb = ({ bound = [] } = {}) => {
    const rows = new Map(bound.map((entry) => [entry.house, entry]));
    const db = {
        rows,
        writes: [],
        query: async (sql, params) => {
            if (sql.includes('FROM "Bots"')) {
                return [...rows.values()].map((entry) => ({
                    House: entry.house,
                    UserId: entry.userId,
                    Enabled: entry.enabled !== false
                }));
            }

            db.writes.push({ sql, params });

            if (sql.startsWith('INSERT INTO "Bots"')) {
                rows.set(params[0], { house: params[0], userId: params[1], enabled: true });
            }

            if (sql.startsWith('UPDATE "Bots"')) {
                const entry = rows.get(params[1]);

                if (entry) {
                    entry.enabled = params[0];
                }
            }

            return [];
        }
    };

    return db;
};

const makeService = ({ db, users = [], decks = {}, standalones = [] } = {}) => {
    const byId = new Map(users.map((user) => [user.id, user]));
    const created = [];

    const service = new BotService({
        userService: {
            getUserById: async (id) => byId.get(id) || null,
            getUserByEmail: async (email) => users.find((user) => user.email === email) || null,
            getUserByUsername: async (name) =>
                users.find((user) => user.username.toLowerCase() === String(name).toLowerCase()) ||
                null,
            addUser: async (user) => {
                created.push(user);

                const model = botUser(700 + created.length, user.username, 'created');

                model.userData.email = user.email;
                users.push(model);
                byId.set(model.id, model);

                return user;
            }
        },
        deckService: {
            // The imported library, filtered to a house (and, at a real site,
            // to the difficulty's ARI band).
            getRandomPracticeDeckId: async ({ house } = {}) => decks[house] || null,
            getStandaloneDecks: async () => standalones,
            countPracticeDecks: async ({ house } = {}) => (decks[house] ? 1 : 0)
        },
        settingsService: { getSectionWithDefaults: () => ({ enabled: true }) },
        db: db || makeDb()
    });

    return { service, created };
};

describe('the practice bot roster', function () {
    it('creates an account per house, keyed by a sentinel email nobody can register', async function () {
        const { service, created } = makeService();

        const roster = await service.ensureRoster();

        expect(roster.length).toBe(BOT_ROSTER.length);
        expect(created.length).toBe(BOT_ROSTER.length);

        for (const entry of BOT_ROSTER) {
            const made = created.find((user) => user.username === entry.defaultName);

            expect(made).toBeDefined();
            expect(made.email).toBe(`bot+${entry.house}@archon-bots.invalid`);
            expect(made.verified).toBe(true);
            // Deliberately not a bcrypt hash: every login comparison fails.
            expect(made.password.startsWith('$2')).toBe(false);
        }
    });

    it('adopts an existing account by its sentinel email rather than making a second', async function () {
        // The Logos bot, renamed by an admin: bound by house, not by name.
        const existing = botUser(42, 'Archie', 'logos');
        const { service, created } = makeService({ users: [existing] });

        const roster = await service.ensureRoster();
        const logos = roster.find((bot) => bot.house === 'logos');

        expect(logos.user.username).toBe('Archie');
        expect(created.some((user) => user.email.includes('logos'))).toBe(false);
    });

    it("refuses to seat a bot in a person's account", async function () {
        const { service, created } = makeService({ users: [personCalled('HelperBot')] });

        const roster = await service.ensureRoster();

        // Logos is skipped entirely; every other house still gets its bot.
        expect(roster.some((bot) => bot.house === 'logos')).toBe(false);
        expect(roster.length).toBe(BOT_ROSTER.length - 1);
        expect(created.some((user) => user.username === 'HelperBot')).toBe(false);
    });

    it('keeps its binding across a rename', async function () {
        const db = makeDb({ bound: [{ house: 'dis', userId: 7 }] });
        const { service } = makeService({ db, users: [botUser(7, 'Snudge', 'dis')] });

        const result = await service.updateBot('dis', { username: 'Grumbleweed' });

        expect(result.success).toBe(true);
        expect(
            db.writes.some(
                (write) =>
                    write.sql.includes('UPDATE "Users" SET "Username"') &&
                    write.params[0] === 'Grumbleweed'
            )
        ).toBe(true);
        // Still the Dis bot: the house is what the binding is keyed on.
        expect(db.rows.get('dis').userId).toBe(7);
    });

    it('refuses a name that is taken, or one the site would not allow', async function () {
        const db = makeDb({ bound: [{ house: 'dis', userId: 7 }] });
        const { service } = makeService({
            db,
            users: [botUser(7, 'Snudge', 'dis'), personCalled('Somebody')]
        });

        expect((await service.updateBot('dis', { username: 'Somebody' })).success).toBe(false);
        expect((await service.updateBot('dis', { username: 'no spaces!' })).success).toBe(false);
        expect((await service.updateBot('dis', { username: 'ab' })).success).toBe(false);
        expect(db.writes.some((write) => write.sql.includes('SET "Username"'))).toBe(false);
    });

    it('saves the picture and profile onto the account itself', async function () {
        const db = makeDb({ bound: [{ house: 'dis', userId: 7 }] });
        const { service } = makeService({ db, users: [botUser(7, 'Snudge', 'dis')] });

        await service.updateBot('dis', {
            bio: 'I deal in bad bargains.',
            country: 'us',
            state: 'Ohio',
            avatar: 'Snudge-abc123'
        });

        const write = db.writes.find((entry) => entry.sql.startsWith('UPDATE "Users" SET "Bio"'));

        expect(write).toBeDefined();
        expect(write.params).toEqual([
            'I deal in bad bargains.',
            // Country is normalised the way the profile stores it.
            'US',
            'Ohio',
            'Snudge-abc123',
            7
        ]);
    });

    it('turns one bot off without touching the others', async function () {
        const db = makeDb({ bound: [{ house: 'dis', userId: 7 }] });
        const { service } = makeService({ db, users: [botUser(7, 'Snudge', 'dis')] });

        await service.updateBot('dis', { enabled: false });

        expect(db.rows.get('dis').enabled).toBe(false);
    });

    describe('choosing who hosts', function () {
        const roster = () =>
            BOT_ROSTER.map((entry, index) => ({
                house: entry.house,
                userId: 100 + index,
                enabled: true
            }));

        const withRoster = (overrides = {}) => {
            const bound = roster();
            const db = makeDb({ bound });
            const users = bound.map((entry) => {
                const name = BOT_ROSTER.find((item) => item.house === entry.house).defaultName;

                return botUser(entry.userId, name, entry.house);
            });

            return { db, ...makeService({ db, users, ...overrides }) };
        };

        it('offers only a bot that has a deck of its house', async function () {
            const { service } = withRoster({ decks: { saurian: 55 } });

            const host = await service.pickHost();

            expect(host.bot.house).toBe('saurian');
            expect(host.deck).toEqual({ deckId: 55, isStandalone: false });
        });

        it('falls back to a standalone deck containing the house', async function () {
            const { service } = withRoster({
                standalones: [
                    { id: 3, houses: ['mars', 'shadows', 'untamed'] },
                    { id: 4, houses: ['brobnar', 'dis', 'logos'] }
                ]
            });

            const host = await service.pickHost();

            expect(host.deck.isStandalone).toBe(true);
            // Whichever bot was picked, the deck it got contains its house.
            const deck = [
                { id: 3, houses: ['mars', 'shadows', 'untamed'] },
                { id: 4, houses: ['brobnar', 'dis', 'logos'] }
            ].find((candidate) => candidate.id === host.deck.deckId);

            expect(deck.houses).toContain(host.bot.house);
        });

        it('never offers a bot that is already sitting at a table', async function () {
            const { service } = withRoster({ decks: { dis: 1, logos: 2 } });

            const host = await service.pickHost(['Snudge']);

            expect(host.bot.house).toBe('logos');
        });

        it('never offers a disabled bot', async function () {
            const { db, service } = withRoster({ decks: { dis: 1, logos: 2 } });

            db.rows.get('dis').enabled = false;

            const host = await service.pickHost();

            expect(host.bot.house).toBe('logos');
        });

        it('hands back nothing when nobody can play', async function () {
            const { service } = withRoster();

            expect(await service.pickHost()).toBeNull();
        });

        it('spreads hosting across the roster rather than favouring one bot', async function () {
            const decks = Object.fromEntries(BOT_ROSTER.map((entry) => [entry.house, 1]));
            const { service } = withRoster({ decks });
            const seen = new Set();

            for (let attempt = 0; attempt < 60; attempt++) {
                const host = await service.pickHost();

                seen.add(host.bot.house);
            }

            // Not a distribution test - just that the choice is not fixed.
            expect(seen.size).toBeGreaterThan(3);
        });
    });
});
