import React from 'react';
import PropTypes from 'prop-types';
import { useTranslation } from 'react-i18next';

import { TIERS } from '../../membership';
import { keyFinishClass } from '../../cosmetics';

/**
 * ARCHON (N12): the mark shown next to a player's name.
 *
 * Supporter is sold as "show your support next to your name", and a badge only
 * works if it reads at a glance in a dense list - a leaderboard row is 28
 * pixels tall and already carries a rank, an avatar, a rating and a record. So
 * it is a key, sized to the text around it, and the tier is the fill:
 *
 *   Supporter    outline key, emerald  - "I keep the lights on"
 *   Archon       solid key, amber      - the recommended tier, and it looks it
 *   Vault Master solid key with a glow and a ring, violet
 *
 * One shape at three weights rather than three unrelated icons: the ladder is
 * legible without a legend, and a row of names reads as a row of names rather
 * than as a sticker album.
 *
 * Site roles that are not tiers - admin, tournament winners, contributors -
 * keep the name colour they have always had and get no key, because they are
 * not memberships and a badge that means two different things means neither.
 */

const TIER_STYLE = Object.freeze({
    [TIERS.SUPPORTER]: {
        className: 'text-emerald-400',
        fill: 'none',
        ring: false
    },
    [TIERS.ARCHON]: {
        className: 'text-amber-400',
        fill: 'currentColor',
        ring: false
    },
    [TIERS.VAULT_MASTER]: {
        className: 'text-violet-400 drop-shadow-[0_0_3px_rgba(167,139,250,0.65)]',
        fill: 'currentColor',
        ring: true
    }
});

/**
 * A key, drawn to sit on the text baseline next to a name.
 *
 * `em` units rather than a fixed size so it scales with whatever it is placed
 * beside - a 12px table row and a 20px profile heading both get a key in
 * proportion, with no per-call-site sizing.
 */
const KeyGlyph = ({ fill, ring }) => (
    <svg
        aria-hidden='true'
        className='inline-block h-[0.95em] w-[0.95em] shrink-0 align-[-0.1em]'
        fill='none'
        stroke='currentColor'
        strokeLinecap='round'
        strokeLinejoin='round'
        strokeWidth='1.8'
        viewBox='0 0 24 24'
    >
        {ring && <circle cx='12' cy='12' opacity='0.35' r='11' strokeWidth='1.2' />}
        <circle cx='9' cy='9' fill={fill} r='4' />
        <path d='M12 12 19 19' />
        <path d='M16.5 15.5 18.5 13.5' />
        <path d='M19 19 17 21' />
    </svg>
);

KeyGlyph.propTypes = {
    fill: PropTypes.string,
    ring: PropTypes.bool
};

/**
 * ARCHON (N20): the mark on a brand-new account. A pill rather than a key on
 * purpose - the key is a claim about money, and this is a welcome, not a
 * tier. It reads "be nice, they just got here" in any list, and disappears
 * on its own when the new-player window closes server-side.
 */
const NewPill = ({ t }) => (
    <span
        aria-label={t('New player')}
        className='inline-flex items-center rounded-full border border-emerald-500/40 bg-emerald-500/15 px-1 text-[0.62em] font-semibold uppercase tracking-wide text-emerald-300'
        title={t('New to Archon Arena')}
    >
        {t('New')}
    </span>
);

NewPill.propTypes = { t: PropTypes.func };

/**
 * ARCHON (F9): the mark on a practice bot.
 *
 * Same pill shape as the welcome, deliberately: both are facts about who you
 * are looking at rather than claims about money, so neither gets a key. Blue
 * because it is the one colour on the site that is not already a tier, a role
 * or a warning - a bot is none of those, it is simply not a person.
 *
 * It replaces the New pill rather than sitting beside it (publicBadge never
 * sets both): a bot account is days old by definition, and "be nice, they
 * just got here" is advice about a person.
 */
const BotPill = ({ t }) => (
    <span
        aria-label={t('Bot')}
        className='inline-flex items-center rounded-full border border-sky-500/40 bg-sky-500/15 px-1 text-[0.62em] font-semibold uppercase tracking-wide text-sky-300'
        title={t('A practice bot - games against it are never rated')}
    >
        {t('Bot')}
    </span>
);

BotPill.propTypes = { t: PropTypes.func };

/**
 * @param {object} props
 * @param {string} [props.tier] tier id; anything not a paid tier renders no key
 * @param {string} [props.tierName] display name, used for the tooltip
 * @param {object} [props.cosmetics] chosen cosmetics; only the key finish is read
 * @param {boolean} [props.isNew] ARCHON (N20): within the new-player window
 * @param {boolean} [props.isBot] ARCHON (F9): a practice bot, not a person
 * @param {boolean} [props.withLabel] also show the tier name in words
 */
const PlayerBadge = ({
    tier,
    tierName,
    cosmetics,
    isNew = false,
    isBot = false,
    withLabel = false
}) => {
    const { t } = useTranslation();
    const style = TIER_STYLE[tier];
    // A bot never wears the welcome: what matters about it is that it is a
    // bot, and it is new by construction.
    const pill = isBot ? <BotPill t={t} /> : isNew ? <NewPill t={t} /> : null;

    if (!style) {
        return pill;
    }

    // ARCHON (N12): the chosen finish is applied ON TOP of the tier's colour and
    // shape, never instead of them - the key still has to say which tier at a
    // glance, which is the entire reason it is a key and not a sticker.
    const finish = keyFinishClass(cosmetics);

    const label = tierName || tier;
    // Said in full for a screen reader, because a key glyph on its own says
    // nothing at all to one.
    const description = t('{{tier}} member', { tier: label });

    return (
        <span className='inline-flex items-center gap-1'>
            <span
                className={`inline-flex items-center gap-1 ${style.className} ${finish}`.trim()}
                title={description}
                aria-label={description}
                role='img'
            >
                <KeyGlyph fill={style.fill} ring={style.ring} />
                {withLabel && <span className='text-[0.8em] font-medium'>{label}</span>}
            </span>
            {pill}
        </span>
    );
};

PlayerBadge.displayName = 'PlayerBadge';

PlayerBadge.propTypes = {
    cosmetics: PropTypes.object,
    isBot: PropTypes.bool,
    isNew: PropTypes.bool,
    tier: PropTypes.string,
    tierName: PropTypes.string,
    withLabel: PropTypes.bool
};

export default PlayerBadge;
export { TIER_STYLE };
