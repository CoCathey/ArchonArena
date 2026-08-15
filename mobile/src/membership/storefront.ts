import { Platform } from 'react-native';

import { allowsPurchaseLinks, upgradePromptFor } from './storePolicy';

/**
 * ARCHON (N12): the store rules, bound to this device's platform.
 *
 * The rules themselves — and the reasoning behind them, which is the part worth
 * reading — live in storePolicy.ts. This file is only the binding, kept
 * separate so the policy can be tested without React Native.
 */

/** May this build show prices, checkout links, and "subscribe" wording? */
export const canShowPurchaseLinks = (): boolean => allowsPurchaseLinks(Platform.OS);

/** The line shown on a locked panel to somebody who is not a member. */
export const upgradePrompt = (): string => upgradePromptFor(Platform.OS);
