const logger = require('../../log');

/**
 * ARCHON (F9): the Helper Bot - a house player that always has a table open.
 *
 * The lobby's sweep (Lobby.runHelperBotSweep) does the hosting, joining and
 * starting, because those are lobby concerns; what lives here is everything
 * the sweep needs that is NOT lobby state: the admin-configured knobs, the
 * bot's account, and the random deck it plays.
 *
 * ## The account is real, and provably ours
 *
 * The bot plays as an ordinary row in "Users" - that is what lets every
 * existing path (pending games, deck selection, the game node's player
 * construction) treat it as just another player. Two properties keep the
 * account safe:
 *
 *  - **Nobody can log into it.** The stored password is a sentinel that is
 *    not a bcrypt hash, so every login comparison simply fails. There is no
 *    password to guess, because there is no password.
 *  - **A configured name can never capture a person's account.** The bot is
 *    recognised by its sentinel email, which no human can register (it is
 *    minted from the username under a reserved local-part). If the
 *    configured username belongs to a row with any other email, the service
 *    refuses to run rather than seat a bot in somebody's name.
 *
 * ## The deck is random, from the bot's shelf first
 *
 * "Picks a random deck" means: a random deck the bot account owns (an admin
 * can import any collection into it), and when it owns none, a random
 * standalone deck - the curated set shipped with the site - so a fresh
 * deployment has a working bot with zero setup. Bot games are never
 * persisted or rated, so the pick pollutes nothing.
 */

/** What may be configured as the bot's username - the site's own rule. */
const USERNAME_PATTERN = /^[A-Za-z0-9_-]{3,15}$/;

/**
 * Deliberately not a bcrypt hash: bcrypt.compare against it is always false,
 * which makes the account impossible to log into rather than hard to.
 */
const LOGIN_DISABLED_PASSWORD = '!helper-bot-login-disabled!';

class HelperBotService {
    constructor({ userService, deckService, settingsService } = {}) {
        this.userService = userService;
        this.deckService = deckService;
        this.settingsService = settingsService || require('../settings');

        this.cachedUser = null;
        this.lastEnsureFailureLogMs = 0;
    }

    /** Admin-configurable knobs, defaults from the settings registry. */
    getConfig() {
        return this.settingsService.getSectionWithDefaults('helperBot');
    }

    /** The sentinel email that marks a Users row as this bot's. */
    botEmail(username) {
        return `bot+${username.toLowerCase()}@helper-bot.invalid`;
    }

    /**
     * Find or create the bot's account. Returns the User model, or null when
     * the bot cannot safely run (invalid name, or the name belongs to a real
     * account). Failures are logged at most once a minute - this is called
     * from a sweep, and one clear line beats a scrolling wall.
     */
    async ensureBotUser() {
        const username = String(this.getConfig().botUsername || '').trim();

        if (this.cachedUser && this.cachedUser.username === username) {
            return this.cachedUser;
        }

        this.cachedUser = null;

        if (!USERNAME_PATTERN.test(username)) {
            this.logEnsureFailure(
                `Helper Bot is configured with an invalid username '${username}' - it must match ${USERNAME_PATTERN}`
            );

            return null;
        }

        try {
            let user = await this.userService.getUserByUsername(username);

            if (!user) {
                await this.userService.addUser({
                    username,
                    password: LOGIN_DISABLED_PASSWORD,
                    email: this.botEmail(username),
                    registered: new Date(),
                    registerIp: '127.0.0.1',
                    avatar: username,
                    verified: true,
                    activationToken: null,
                    activationTokenExpiry: null,
                    termsAcceptedAt: new Date()
                });

                // Re-fetched rather than used as returned: addUser hands back
                // the raw insert row, and everything downstream wants the
                // full User model with settings and permissions attached.
                user = await this.userService.getUserByUsername(username);

                logger.info(`Helper Bot account '${username}' created`);
            }

            if (!user || user.email !== this.botEmail(username)) {
                this.logEnsureFailure(
                    `Helper Bot username '${username}' belongs to an existing account - ` +
                        'refusing to play as it. Configure a different bot username.'
                );

                return null;
            }

            this.cachedUser = user;

            return user;
        } catch (err) {
            this.logEnsureFailure(`Failed to ensure the Helper Bot account '${username}'`, err);

            return null;
        }
    }

    /**
     * A random deck for the bot to play: its own collection first, the
     * standalone shelf when the collection is empty.
     *
     * @returns {Promise<{deckId: number, isStandalone: boolean} | null>}
     */
    async pickDeckSelection(botUser) {
        const ownDeckId = await this.deckService.getRandomDeckIdForUser(botUser.id, {
            isAlliance: false
        });

        if (ownDeckId) {
            return { deckId: ownDeckId, isStandalone: false };
        }

        let standalones;

        try {
            standalones = await this.deckService.getStandaloneDecks();
        } catch (err) {
            logger.error('Helper Bot could not list standalone decks', err);

            standalones = null;
        }

        if (!standalones || standalones.length === 0) {
            return null;
        }

        const deck = standalones[Math.floor(Math.random() * standalones.length)];

        return { deckId: deck.id, isStandalone: true };
    }

    logEnsureFailure(message, err) {
        const now = Date.now();

        if (now - this.lastEnsureFailureLogMs < 60 * 1000) {
            return;
        }

        this.lastEnsureFailureLogMs = now;

        if (err) {
            logger.error(message, err);
        } else {
            logger.error(message);
        }
    }
}

module.exports = HelperBotService;
