/**
 * Card overlay icons the web client composites onto cards via canvas
 * (archonMaker.js) but which are absent from the raw /img/cards art:
 * enhancement "bonus" pips and the enrage/stun/ward status tokens.
 */

// Enhancement bonus-icon pips. Values come from card.enhancements — the four
// standard bonus icons plus the house-enhancement pips.
export const ENHANCEMENT_PIPS: Record<string, number> = {
    amber: require('../../assets/img/enhancements/amber.png'),
    capture: require('../../assets/img/enhancements/capture.png'),
    draw: require('../../assets/img/enhancements/draw.png'),
    damage: require('../../assets/img/enhancements/damage.png'),
    discard: require('../../assets/img/enhancements/discard.png'),
    power: require('../../assets/img/enhancements/power.png'),
    brobnar: require('../../assets/img/enhancements/brobnar.png'),
    dis: require('../../assets/img/enhancements/dis.png'),
    ekwidon: require('../../assets/img/enhancements/ekwidon.png'),
    geistoid: require('../../assets/img/enhancements/geistoid.png'),
    logos: require('../../assets/img/enhancements/logos.png'),
    mars: require('../../assets/img/enhancements/mars.png'),
    ouboros: require('../../assets/img/enhancements/ouboros.png'),
    redemption: require('../../assets/img/enhancements/redemption.png'),
    sanctum: require('../../assets/img/enhancements/sanctum.png'),
    saurian: require('../../assets/img/enhancements/saurian.png'),
    shadows: require('../../assets/img/enhancements/shadows.png'),
    skyborn: require('../../assets/img/enhancements/skyborn.png'),
    staralliance: require('../../assets/img/enhancements/staralliance.png'),
    unfathomable: require('../../assets/img/enhancements/unfathomable.png'),
    untamed: require('../../assets/img/enhancements/untamed.png')
};

// Status tokens shown as their real icon rather than a text pip.
export const STATUS_TOKEN_ICONS: Record<string, number> = {
    enrage: require('../../assets/img/tokens/enrage.png'),
    stun: require('../../assets/img/tokens/stun.png'),
    ward: require('../../assets/img/tokens/ward.png')
};

export function enhancementPip(name: string): number | undefined {
    return ENHANCEMENT_PIPS[name.toLowerCase().replace(/\s+/g, '')];
}
