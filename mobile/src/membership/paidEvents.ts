import { Platform } from 'react-native';

import { allowsPaidEvents, hasEntryFee as hasFee, hidesEvent } from './storePolicy';

/**
 * ARCHON: paid events, bound to this device's platform.
 *
 * The rules themselves - and the reasoning, which is the part worth reading -
 * live in storePolicy.ts alongside the rest of the store policy. This file is
 * only the binding, kept separate so the rules can be tested without React
 * Native.
 */

/** May this build show or join an event with a buy-in? */
export const canJoinPaidEvents = (): boolean => allowsPaidEvents(Platform.OS);

/** Does this event carry a buy-in? */
export const hasEntryFee = hasFee;

/** Should this event be hidden from the list entirely? */
export const shouldHideEvent = (event: { entryFeeCents?: number | null }): boolean =>
    hidesEvent(event, Platform.OS);
