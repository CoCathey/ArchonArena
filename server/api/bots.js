const passport = require('passport');

const BotService = require('../services/botgames/BotService');
const DeckService = require('../services/DeckService');
const UserService = require('../services/UserService');
const ConfigService = require('../services/ConfigService');
const { isValidImage, saveAvatarImage } = require('../services/images/userImages');
const { wrapAsync } = require('../util.js');
const logger = require('../log.js');

const configService = new ConfigService();
const botService = new BotService({
    userService: new UserService(configService),
    deckService: new DeckService(configService)
});

/**
 * ARCHON (F9): the Bot Settings screen's API. isAdmin only, throughout.
 *
 * The roster is not a settings section - it is thirteen accounts with names,
 * pictures and profiles - so it gets routes of its own rather than being
 * forced into the settings registry's shape. The handful of knobs that ARE
 * registry-shaped (how many tables, the grace period, the turn cap) stay in
 * the settings service and are edited on the same screen through the
 * existing admin settings routes; only where they are edited changed.
 */
const requireAdmin = (req, res, next) => {
    if (!req.user?.permissions?.isAdmin) {
        return res.status(403).send({ success: false, message: 'Forbidden' });
    }

    next();
};

module.exports.init = function (server) {
    server.get(
        '/api/admin/bots',
        passport.authenticate('jwt', { session: false }),
        requireAdmin,
        wrapAsync(async (req, res) => {
            const bots = await botService.listBots();

            res.send({ success: true, bots });
        })
    );

    server.put(
        '/api/admin/bots/:house',
        passport.authenticate('jwt', { session: false }),
        requireAdmin,
        wrapAsync(async (req, res) => {
            const house = String(req.params.house || '').toLowerCase();
            const changes = {};

            for (const field of ['username', 'bio', 'country', 'state']) {
                if (req.body[field] !== undefined) {
                    changes[field] = req.body[field];
                }
            }

            if (req.body.enabled !== undefined) {
                changes.enabled = !!req.body.enabled;
            }

            // The picture arrives as base64, the same way a member's own
            // avatar does, and goes through the same writer: same size, same
            // directory, same path checks, same cache-busting name.
            if (req.body.avatar) {
                if (!isValidImage(req.body.avatar)) {
                    return res
                        .status(400)
                        .send({ success: false, message: 'That picture is not a PNG or JPEG' });
                }

                const bots = await botService.listBots();
                const bot = bots.find((candidate) => candidate.house === house);

                if (!bot) {
                    return res.status(404).send({ success: false, message: 'Unknown bot' });
                }

                const saved = await saveAvatarImage({
                    base64Image: req.body.avatar,
                    // The name the file is built from is the name AFTER any
                    // rename in this same request, so the two agree.
                    username: changes.username || bot.username,
                    previousAvatar: bot.avatar
                });

                if (!saved) {
                    return res
                        .status(400)
                        .send({ success: false, message: 'That picture could not be read' });
                }

                changes.avatar = saved;
            }

            const result = await botService.updateBot(house, changes);

            if (!result.success) {
                return res.status(400).send(result);
            }

            logger.info(
                `${req.user.username} updated the ${house} bot: ${Object.keys(changes).join(', ')}`
            );

            const bots = await botService.listBots();

            res.send({ success: true, bots });
        })
    );
};

// The lobby reuses this instance for its sweep, the same way the Champion's
// Challenge does - one service, one roster, one settings read.
module.exports.botService = botService;
