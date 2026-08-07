import { Constants } from '../../constants';

import AmberToken from '../../assets/img/amber.png';
import ArmorToken from '../../assets/img/armor.png';
import ChainsIcon from '../../assets/img/chains.png';
import DamageToken from '../../assets/img/damage.png';
import KeyCostIcon from '../../assets/img/keyCost.png';
import StunToken from '../../assets/img/stun.png';
import WardToken from '../../assets/img/ward.png';
import ForgedKeyBlue from '../../assets/img/forgedkeyblue.png';
import ForgedKeyRed from '../../assets/img/forgedkeyred.png';
import ForgedKeyYellow from '../../assets/img/forgedkeyyellow.png';
import UnforgedKeyBlue from '../../assets/img/unforgedkeyblue.png';
import UnforgedKeyRed from '../../assets/img/unforgedkeyred.png';
import UnforgedKeyYellow from '../../assets/img/unforgedkeyyellow.png';
import AmberPip from '../../assets/img/enhancements/amberui.png';
import CapturePip from '../../assets/img/enhancements/captureui.png';
import DamagePip from '../../assets/img/enhancements/damageui.png';
import DiscardPip from '../../assets/img/enhancements/discardui.png';
import DrawPip from '../../assets/img/enhancements/drawui.png';
import PowerPip from '../../assets/img/enhancements/powerui.png';

/**
 * ARCHON (N11): the icons the tutorial board and its prose share. The tutorial
 * deliberately reuses the same token art the real game board uses, so a player
 * who finishes the tutorial recognises every counter when they sit down at a
 * real table.
 */
export const LearnIcons = {
    amber: AmberToken,
    armor: ArmorToken,
    chains: ChainsIcon,
    damage: DamageToken,
    keyCost: KeyCostIcon,
    stun: StunToken,
    ward: WardToken
};

/** Bonus-icon art, also used for the {A} {D} {C} {R} tokens in tutorial prose. */
export const BonusIcons = {
    amber: AmberPip,
    capture: CapturePip,
    damage: DamagePip,
    discard: DiscardPip,
    draw: DrawPip,
    power: PowerPip
};

export const KeyImages = {
    red: { forged: ForgedKeyRed, unforged: UnforgedKeyRed },
    blue: { forged: ForgedKeyBlue, unforged: UnforgedKeyBlue },
    yellow: { forged: ForgedKeyYellow, unforged: UnforgedKeyYellow }
};

export const KeyColours = ['red', 'blue', 'yellow'];

export const houseIcon = (house) => Constants.HouseIconPaths[house];
