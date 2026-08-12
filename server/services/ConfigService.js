const config = require('config');
const logger = require('../log.js');

/**
 * ARCHON: "not configured" means ABSENT, not falsy.
 *
 * These warnings used to fire on any falsy value, which is a different question
 * from the one they claim to answer. Plenty of settings are legitimately empty,
 * zero or false - an unset smtpHost on an SES deployment, `emailDailyLimit: 0`
 * meaning "no cap", `requireActivation: false` - and every read of one logged a
 * line saying it "was not configured" when the config file says exactly what it
 * should be. On a deployment not using SMTP that is several lines every time an
 * EmailService is built.
 *
 * The cost is not the noise itself, it is what the noise does to the real ones:
 * a warning that fires when nothing is wrong teaches everybody to skip warnings,
 * and this file's whole purpose is to say when a setting is genuinely missing.
 */
const isAbsent = (holder, key) =>
    !holder || !Object.prototype.hasOwnProperty.call(holder, key) || holder[key] === undefined;

class ConfigService {
    getValue(key) {
        if (isAbsent(config, key)) {
            logger.warn(`Asked for config value '${key}', but it was not configured`);
        }

        return config[key];
    }

    getValueForSection(section, key) {
        if (isAbsent(config, section)) {
            logger.warn(`Asked for config section '${section}', but it was not configured`);

            return undefined;
        }

        if (isAbsent(config[section], key)) {
            logger.warn(
                `Asked for config value '${key}' from section '${section}', but it was not configured`
            );
        }

        return config[section][key];
    }
}

module.exports = ConfigService;
