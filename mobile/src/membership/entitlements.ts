import type { UserDetails } from '../api/types';
import { TIERS } from './capabilities';

/**
 * ARCHON (N12): does this account hold a capability?
 *
 * ## The admin floor
 *
 * An admin's `capabilities` array already contains everything, because
 * `resolveEntitlements` on the server put it there before reading any
 * membership row. The explicit check below is a floor under that, for the one
 * case the array cannot cover: a session minted before the membership system
 * shipped carries `permissions` but no `capabilities`, and without this an
 * administrator would be shown a locked screen on their own site.
 *
 * It is the only admin check on this side, deliberately - the same rule the web
 * client follows. Screens ask about capabilities and never about tiers or
 * about being an admin, so there is nothing to keep in step.
 */
export function hasCapability(user: UserDetails | undefined, capability: string): boolean {
    if (!user) {
        return false;
    }

    if (isAdmin(user)) {
        return true;
    }

    const capabilities = user.capabilities;

    return Array.isArray(capabilities) && capabilities.includes(capability);
}

/** True if any one of these is held. Mirrors the per-section server gate. */
export function hasAnyCapability(user: UserDetails | undefined, capabilities: string[]): boolean {
    return capabilities.some((capability) => hasCapability(user, capability));
}

export function isAdmin(user: UserDetails | undefined): boolean {
    if (!user) {
        return false;
    }

    const permissions = user.permissions as Record<string, boolean> | undefined;
    const membership = user.membership as { isAdmin?: boolean } | undefined;

    return !!(permissions?.isAdmin || membership?.isAdmin);
}

/** The tier the signed-in account is on, as the server resolved it. */
export function currentTier(user: UserDetails | undefined): string {
    const membership = user?.membership as { tier?: string } | undefined;

    return membership?.tier ?? TIERS.FREE;
}

export function currentTierName(user: UserDetails | undefined): string | undefined {
    const membership = user?.membership as { tierName?: string } | undefined;

    return membership?.tierName;
}

/** Is this account on any paid tier (or an admin, who is treated as one)? */
export function isMember(user: UserDetails | undefined): boolean {
    if (isAdmin(user)) {
        return true;
    }

    const membership = user?.membership as { rank?: number } | undefined;

    return (membership?.rank ?? 0) > 0;
}
