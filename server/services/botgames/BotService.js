const logger = require('../../log');
const { BOT_ROSTER, houseLabel, isBotHouse } = require('./roster');

/**
 * ARCHON (F9): the practice bots - who they are, and which decks they play.
 *
 * The lobby's sweep does the hosting, joining and starting, because those are
 * lobby concerns; what lives here is everything the sweep needs that is NOT
 * lobby state: the roster and its accounts, the admin-configured knobs, the
 * bot chosen to host the next table, and the random deck it plays.
 *
 * ## Thirteen characters, one per house
 *
 * A bot belongs to a house, is named for it, and only ever plays decks that
 * contain it (see roster.js). That is what makes the open table worth
 * returning to: sit down against Snudge and you know you are getting Dis.
 * The house is the bot's identity and is fixed; its name, picture and
 * profile are an admin's to change from the Bot Settings page, which is why
 * the binding lives in the "Bots" table keyed on house rather than on a name
 * that can move.
 *
 * ## The accounts are real, and provably ours
 *
 * Every bot plays as an ordinary row in "Users" - that is what lets the
 * pending game, deck selection and the game node treat it as just another
 * player, and what lets an admin edit its profile with the machinery that
 * edits a person's. Two properties keep those accounts safe:
 *
 *  - **Nobody can log into them.** The stored password is a sentinel that is
 *    not a bcrypt hash, so every login comparison simply fails. There is no
 *    password to guess, because there is no password.
 *  - **A bot can never capture a person's account.** Bots are recognised by
 *    a sentinel email no human can register, minted from the bot's HOUSE
 *    (not its name, which changes). An account that exists under a wanted
 *    name with any other email is left alone and that bot simply does not
 *    play, rather than the site seating a bot in somebody's name.
 */

/** What may be set as a bot's name - the site's own username rule. */
const USERNAME_PATTERN = /^[A-Za-z0-9_-]{3,15}$/;

/**
 * Deliberately not a bcrypt hash: bcrypt.compare against it is always false,
 * which makes the account impossible to log into rather than hard to.
 */
const LOGIN_DISABLED_PASSWORD = '!bot-login-disabled!';

/** Bios are the admin's words, but not unbounded ones. */
const MAX_BIO = 500;

class BotService {
    constructor({ userService, deckService, settingsService, db } = {}) {
        this.userService = userService;
        this.deckService = deckService;
        this.settingsService = settingsService || require('../settings');
        this.db = db || require('../../db');

        this.lastEnsureFailureLogMs = {};
    }

    /** Admin-configurable knobs, defaults from the settings registry. */
    getConfig() {
        return this.settingsService.getSectionWithDefaults('bots');
    }

    /**
     * The sentinel email that marks a Users row as a given bot's.
     *
     * Keyed on the HOUSE: a bot's name is editable, so an email built from
     * the name would stop proving anything the moment an admin renamed one.
     */
    botEmail(house) {
        return `bot+${house}@archon-bots.invalid`;
    }

    /**
     * Make sure every enabled house has an account, and return the roster.
     *
     * Idempotent and cheap after the first run: one query for the bindings,
     * one for the accounts. A bot whose default name is already taken by a
     * real person is reported once and skipped - an admin can give it
     * another name on the Bot Settings page, and everything else keeps
     * playing meanwhile.
     *
     * @returns {Promise<Array>} `[{ house, label, enabled, user }]`
     */
    async ensureRoster() {
        const bindings = await this.readBindings();
        const roster = [];

        for (const entry of BOT_ROSTER) {
            const binding = bindings[entry.house];
            let user = null;

            if (binding) {
                user = await this.userService.getUserById(binding.userId);
            }

            if (!user) {
                user = await this.createBotAccount(entry.house, entry.defaultName);

                if (!user) {
                    continue;
                }
            }

            roster.push({
                house: entry.house,
                label: houseLabel(entry.house),
                enabled: binding ? binding.enabled : true,
                user
            });
        }

        return roster;
    }

    /** house -> { userId, enabled }, from the Bots table. */
    async readBindings() {
        const rows = await this.db.query(
            'SELECT "House", "UserId", "Enabled" FROM "Bots" WHERE "House" = ANY($1)',
            [BOT_ROSTER.map((entry) => entry.house)]
        );

        const bindings = {};

        for (const row of rows || []) {
            bindings[row.House] = { userId: row.UserId, enabled: row.Enabled !== false };
        }

        return bindings;
    }

    /**
     * Find or create the account for a house and bind it.
     *
     * The account may already exist without a binding - a site upgrading
     * from the single Helper Bot, or a row whose binding was deleted - so
     * this looks the sentinel email up before creating anything.
     */
    async createBotAccount(house, name) {
        try {
            const existing = await this.userService.getUserByEmail(this.botEmail(house));

            if (existing) {
                await this.bind(house, existing.id);

                return existing;
            }

            const taken = await this.userService.getUserByUsername(name);

            if (taken) {
                this.logOnce(
                    house,
                    `The ${houseLabel(house)} bot cannot use the name '${name}' - an account ` +
                        'already has it. Give that bot another name on the Bot Settings page.'
                );

                return null;
            }

            await this.userService.addUser({
                username: name,
                password: LOGIN_DISABLED_PASSWORD,
                email: this.botEmail(house),
                registered: new Date(),
                registerIp: '127.0.0.1',
                avatar: name,
                verified: true,
                activationToken: null,
                activationTokenExpiry: null,
                termsAcceptedAt: new Date()
            });

            // Re-read rather than trusting the insert's return: everything
            // downstream wants the full User model, not the raw row.
            const created = await this.userService.getUserByUsername(name);

            if (!created) {
                return null;
            }

            await this.bind(house, created.id);

            logger.info(`Created the ${houseLabel(house)} practice bot '${name}'`);

            return created;
        } catch (err) {
            this.logOnce(house, `Failed to prepare the ${houseLabel(house)} practice bot`, err);

            return null;
        }
    }

    /** Record which account plays a house. */
    async bind(house, userId) {
        await this.db.query(
            'INSERT INTO "Bots" ("House", "UserId") VALUES ($1, $2) ' +
                'ON CONFLICT ("House") DO UPDATE SET "UserId" = EXCLUDED."UserId"',
            [house, userId]
        );
    }

    /**
     * The roster as the Bot Settings page shows it: who each bot is, what it
     * looks like, and how many decks it can actually play.
     */
    async listBots() {
        const roster = await this.ensureRoster();
        const bots = [];

        for (const bot of roster) {
            bots.push({
                house: bot.house,
                label: bot.label,
                enabled: bot.enabled,
                username: bot.user.username,
                avatar: bot.user.avatar || null,
                bio: bot.user.userData?.bio || '',
                country: bot.user.userData?.country || '',
                state: bot.user.userData?.state || '',
                // What an admin most needs to know: a bot with no deck of its
                // house cannot host, however enabled it is.
                deckCount: await this.countPlayableDecks(bot)
            });
        }

        return bots;
    }

    /** How many decks of this bot's house it can choose from. */
    async countPlayableDecks(bot) {
        let owned = 0;

        try {
            owned = await this.deckService.countDecksForUserWithHouse(bot.user.id, bot.house);
        } catch (err) {
            logger.error(`Failed to count decks for the ${bot.label} bot`, err);
        }

        if (owned > 0) {
            return owned;
        }

        const standalones = await this.standaloneDecksForHouse(bot.house);

        return standalones.length;
    }

    /**
     * Apply an admin's edit to one bot: its name, picture, profile, and
     * whether it plays at all.
     *
     * Returns `{ success, message }` rather than throwing, because every
     * refusal here is something the admin needs to read (a name that is
     * taken, a name the site would not allow anybody).
     */
    async updateBot(house, changes = {}) {
        if (!isBotHouse(house)) {
            return { success: false, message: 'Unknown bot' };
        }

        const roster = await this.ensureRoster();
        const bot = roster.find((candidate) => candidate.house === house);

        if (!bot) {
            return { success: false, message: 'That bot has no account yet' };
        }

        if (changes.username !== undefined) {
            const wanted = String(changes.username || '').trim();

            if (!USERNAME_PATTERN.test(wanted)) {
                return {
                    success: false,
                    message: 'A bot name must be 3-15 letters, numbers, - or _'
                };
            }

            if (wanted.toLowerCase() !== bot.user.username.toLowerCase()) {
                const taken = await this.userService.getUserByUsername(wanted);

                if (taken) {
                    return { success: false, message: `${wanted} is already taken` };
                }

                await this.db.query('UPDATE "Users" SET "Username" = $1 WHERE "Id" = $2', [
                    wanted,
                    bot.user.id
                ]);
            }
        }

        const profile = [];
        const values = [];

        if (changes.bio !== undefined) {
            values.push(String(changes.bio || '').slice(0, MAX_BIO) || null);
            profile.push(`"Bio" = $${values.length}`);
        }

        if (changes.country !== undefined) {
            values.push(
                String(changes.country || '')
                    .slice(0, 2)
                    .toUpperCase() || null
            );
            profile.push(`"Country" = $${values.length}`);
        }

        if (changes.state !== undefined) {
            values.push(String(changes.state || '').slice(0, 64) || null);
            profile.push(`"State" = $${values.length}`);
        }

        if (changes.avatar !== undefined) {
            values.push(changes.avatar || null);
            profile.push(`"Settings_Avatar" = $${values.length}`);
        }

        if (profile.length) {
            values.push(bot.user.id);
            await this.db.query(
                `UPDATE "Users" SET ${profile.join(', ')} WHERE "Id" = $${values.length}`,
                values
            );
        }

        if (changes.enabled !== undefined) {
            await this.db.query('UPDATE "Bots" SET "Enabled" = $1 WHERE "House" = $2', [
                !!changes.enabled,
                house
            ]);
        }

        return { success: true };
    }

    /**
     * Choose the bot to host the next open table.
     *
     * Random among the bots that can actually play right now: enabled, with
     * a deck of their house, and not already sitting at another table -
     * because an account in two games at once is one seat pretending to be
     * two, and because the point of thirteen characters is meeting a
     * different one each time.
     *
     * Candidates are tried in random order and the first that yields a deck
     * wins, so a bot whose collection is empty costs one query rather than
     * an empty table. Returns `{ bot, deck }` or null when nobody can host.
     *
     * @param {string[]} [busyUsernames] accounts already seated somewhere
     */
    async pickHost(busyUsernames = []) {
        const busy = new Set(busyUsernames.map((name) => String(name).toLowerCase()));
        const roster = await this.ensureRoster();
        const candidates = roster.filter(
            (bot) => bot.enabled && !busy.has(bot.user.username.toLowerCase())
        );

        for (const bot of this.shuffle(candidates)) {
            const deck = await this.pickDeckSelection(bot);

            if (deck) {
                return { bot, deck };
            }
        }

        return null;
    }

    /**
     * A random deck for this bot to play: one of its own containing its
     * house, or - so a fresh site has working bots with no setup at all - a
     * standalone deck containing it.
     *
     * @returns {Promise<{deckId: number, isStandalone: boolean} | null>}
     */
    async pickDeckSelection(bot) {
        let ownDeckId = null;

        try {
            ownDeckId = await this.deckService.getRandomDeckIdForUser(bot.user.id, {
                isAlliance: false,
                house: bot.house
            });
        } catch (err) {
            logger.error(`The ${bot.label} bot could not pick from its collection`, err);
        }

        if (ownDeckId) {
            return { deckId: ownDeckId, isStandalone: false };
        }

        const standalones = await this.standaloneDecksForHouse(bot.house);

        if (!standalones.length) {
            return null;
        }

        const deck = standalones[Math.floor(Math.random() * standalones.length)];

        return { deckId: deck.id, isStandalone: true };
    }

    /** The curated standalone decks that contain a house. */
    async standaloneDecksForHouse(house) {
        let decks;

        try {
            decks = await this.deckService.getStandaloneDecks();
        } catch (err) {
            logger.error('Could not list standalone decks for the practice bots', err);

            return [];
        }

        return (decks || []).filter((deck) => (deck.houses || []).includes(house));
    }

    /** Fisher-Yates, so every bot is equally likely to host. */
    shuffle(list) {
        const shuffled = [...list];

        for (let index = shuffled.length - 1; index > 0; index--) {
            const swap = Math.floor(Math.random() * (index + 1));

            [shuffled[index], shuffled[swap]] = [shuffled[swap], shuffled[index]];
        }

        return shuffled;
    }

    /**
     * Report a per-bot problem at most once a minute. This is called from a
     * sweep: one clear line beats a scrolling wall, and the conditions that
     * reach here (a name collision, a database fault) persist until somebody
     * acts on them.
     */
    logOnce(house, message, err) {
        const now = Date.now();

        if (now - (this.lastEnsureFailureLogMs[house] || 0) < 60 * 1000) {
            return;
        }

        this.lastEnsureFailureLogMs[house] = now;

        if (err) {
            logger.error(message, err);
        } else {
            logger.error(message);
        }
    }
}

module.exports = BotService;
module.exports.USERNAME_PATTERN = USERNAME_PATTERN;
module.exports.LOGIN_DISABLED_PASSWORD = LOGIN_DISABLED_PASSWORD;
