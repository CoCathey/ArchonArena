import { useSettingsStore } from '../stores/settingsStore';
import type { CardSummary } from './types';

export const CARD_ASPECT = 420 / 300;

export const CARDBACK = require('../../assets/img/cardback.jpg');

/** Card face image served by the lobby web server (same URLs the web client uses). */
export function cardImageUrl(card: Pick<CardSummary, 'image'>): string | undefined {
    if (!card.image) {
        return undefined;
    }
    const server = useSettingsStore.getState().serverUrl;
    return `${server}/img/cards/${card.image}.png`;
}
