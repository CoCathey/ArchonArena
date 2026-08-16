import { describe, expect, it } from 'vitest';

import { CAPABILITIES, TIERS } from '../src/membership/capabilities';
import {
    currentTier,
    hasAnyCapability,
    hasCapability,
    isAdmin,
    isMember
} from '../src/membership/entitlements';
import {
    isPatreonCallback,
    outcomeOf,
    parseCallbackUrl,
    RETURN_URL
} from '../src/membership/patreonCallback';
import {
    allowsPaidEvents,
    allowsPurchaseLinks,
    hasEntryFee,
    hidesEvent,
    upgradePromptFor
} from '../src/membership/storePolicy';
import { withoutPurchaseInfo } from '../src/membership/catalogPolicy';
import type { UserDetails } from '../src/api/types';

const user = (extra: Partial<UserDetails> = {}): UserDetails =>
    ({ id: '1', username: 'p', ...extra }) as UserDetails;

describe('mobile entitlements', () => {
    it('reads the capability list the server resolved', () => {
        const supporter = user({ capabilities: [CAPABILITIES.ELO_HISTORY] });

        expect(hasCapability(supporter, CAPABILITIES.ELO_HISTORY)).toBe(true);
        expect(hasCapability(supporter, CAPABILITIES.TOURNAMENT_LAB)).toBe(false);
    });

    it('refuses everything to a signed-out visitor', () => {
        expect(hasCapability(undefined, CAPABILITIES.ELO_HISTORY)).toBe(false);
        expect(isMember(undefined)).toBe(false);
    });

    /**
     * The requirement is that an administrator reaches every feature regardless
     * of Patreon status, tier, or database state. Their capability list already
     * contains everything; this is the floor under the case it cannot cover — a
     * session minted before the membership system shipped, which carries
     * permissions but no capabilities.
     */
    it('unlocks everything for an admin with no capability list at all', () => {
        const admin = user({ permissions: { isAdmin: true } });

        expect(hasCapability(admin, CAPABILITIES.TOURNAMENT_LAB)).toBe(true);
        expect(hasCapability(admin, CAPABILITIES.EXPERIMENTAL_FEATURES)).toBe(true);
        expect(isMember(admin)).toBe(true);
    });

    it('unlocks everything for an admin whose membership says free', () => {
        const admin = user({
            permissions: { isAdmin: true },
            capabilities: [],
            membership: { tier: TIERS.FREE, rank: 0, isAdmin: false }
        });

        expect(hasCapability(admin, CAPABILITIES.ARCHON_INTELLIGENCE)).toBe(true);
    });

    it('reads the admin flag from the membership block too', () => {
        // checkauth resolves it there; older payloads carry it in permissions.
        expect(isAdmin(user({ membership: { isAdmin: true } }))).toBe(true);
    });

    it('does not turn a non-admin with no capabilities into a member', () => {
        // The floor must not become a hole.
        expect(hasCapability(user({ permissions: {} }), CAPABILITIES.ARCHON_INTELLIGENCE)).toBe(
            false
        );
        expect(isMember(user({ membership: { tier: TIERS.FREE, rank: 0 } }))).toBe(false);
    });

    it('admits a caller holding any one of several capabilities', () => {
        // Mirrors the per-section server gate: a Supporter holds the Elo
        // history but not the deck rankings, and must still get the screen.
        const supporter = user({ capabilities: [CAPABILITIES.ELO_HISTORY] });

        expect(
            hasAnyCapability(supporter, [
                CAPABILITIES.ELO_HISTORY,
                CAPABILITIES.PERSONAL_DECK_RANKINGS
            ])
        ).toBe(true);
    });

    it('falls back to free when there is no membership block', () => {
        expect(currentTier(user())).toBe(TIERS.FREE);
    });
});

/**
 * The store rules. These assertions are the App Store submission, in effect:
 * if the iOS case ever flips, the build stops being approvable under Guideline
 * 3.1.1 and this fails rather than a reviewer finding it.
 */
describe('store policy', () => {
    it('never offers a purchase link on iOS', () => {
        expect(allowsPurchaseLinks('ios')).toBe(false);
    });

    it('never mentions buying in the iOS upgrade prompt', () => {
        const prompt = upgradePromptFor('ios').toLowerCase();

        for (const word of ['$', 'subscribe', 'buy', 'purchase', 'patreon.com', 'upgrade for']) {
            expect(prompt, `iOS prompt must not say "${word}"`).not.toContain(word);
        }

        // It must still tell an existing member what to do.
        expect(prompt).toContain('connect your patreon');
    });

    it('does show them on Android', () => {
        expect(allowsPurchaseLinks('android')).toBe(true);
    });

    it('treats an unknown platform as the strictest one', () => {
        // A new target nobody has checked the rules for should behave like iOS,
        // not like the most permissive platform we happen to support.
        expect(allowsPurchaseLinks('visionos')).toBe(false);
        expect(allowsPurchaseLinks('')).toBe(false);
    });
});

/**
 * The strongest form of the store rule: the money is not merely hidden, it is
 * not in the data.
 *
 * A `showMoney &&` guard is something a future edit has to remember. An absent
 * field is something it cannot get wrong — and the type says the field may be
 * absent, so a screen that forgets cannot even compile a price block.
 */
describe('the catalogue an iOS build receives', () => {
    const catalog = {
        success: true,
        tiers: [
            {
                id: 'free',
                name: 'Free',
                rank: 0,
                priceUsd: 0,
                includes: ['Unlimited games'],
                purchasable: false,
                checkoutUrl: null
            },
            {
                id: 'archon',
                name: 'Archon',
                rank: 2,
                priceUsd: 10,
                tagline: 'Understand your decks, your play, and the field.',
                adds: ['archon_intelligence'],
                purchasable: true,
                checkoutUrl: 'https://www.patreon.com/checkout/cocathey?rid=29339861'
            }
        ],
        capabilities: {
            archon_intelligence: { label: 'Archon Intelligence', learn: 'Is this deck good?' }
        }
    };

    const stripped = withoutPurchaseInfo(catalog);

    it('carries no price', () => {
        for (const tier of stripped.tiers ?? []) {
            expect(tier.priceUsd, `${tier.name} still has a price`).toBeUndefined();
        }
    });

    it('carries no checkout link', () => {
        for (const tier of stripped.tiers ?? []) {
            expect(tier.checkoutUrl, `${tier.name} still has a checkout link`).toBeUndefined();
        }
    });

    it('contains no patreon.com anywhere in the payload', () => {
        // The blunt version of the same question, in case a link ever arrives
        // on a field nobody thought about.
        expect(JSON.stringify(stripped)).not.toContain('patreon.com');
        expect(JSON.stringify(stripped)).not.toContain('$');
    });

    it('still says what membership includes', () => {
        // 3.1.3(b) permits exactly this. Stripping the description too would
        // give up the thing the screen is for.
        const archon = (stripped.tiers ?? []).find((tier) => tier.id === 'archon');

        expect(archon?.adds).toEqual(['archon_intelligence']);
        expect(archon?.tagline).toBeTruthy();
        expect(stripped.capabilities?.archon_intelligence.label).toBe('Archon Intelligence');
    });

    it('leaves the tiers themselves in place', () => {
        expect((stripped.tiers ?? []).map((tier) => tier.id)).toEqual(['free', 'archon']);
    });

    it('does not mutate the payload it was given', () => {
        // The caller may hand the same object to something else.
        expect(catalog.tiers[1].priceUsd).toBe(10);
    });
});

describe('patreon callback', () => {
    it('reads the code and state out of the deep link', () => {
        expect(parseCallbackUrl('archonarena://patreon?code=abc123&state=m.xyz')).toEqual({
            code: 'abc123',
            state: 'm.xyz',
            error: undefined
        });
    });

    it('reads Patreon declining as an error rather than a code', () => {
        const callback = parseCallbackUrl('archonarena://patreon?error=access_denied');

        expect(callback.error).toBe('access_denied');
        expect(outcomeOf(callback)).toBe('declined');
    });

    it('treats a callback with no code as declined, not as a failure', () => {
        expect(outcomeOf(parseCallbackUrl('archonarena://patreon'))).toBe('declined');
        expect(outcomeOf(parseCallbackUrl('archonarena://patreon?state=m.only'))).toBe('declined');
    });

    it('is ready only with both halves', () => {
        expect(outcomeOf({ code: 'a', state: 'm.b' })).toBe('ready');
        expect(outcomeOf({ code: 'a' })).toBe('declined');
    });

    it('ignores deep links that are not the Patreon callback', () => {
        expect(isPatreonCallback('archonarena://tournament/7')).toBe(false);
        expect(isPatreonCallback(undefined)).toBe(false);
        expect(isPatreonCallback(`${RETURN_URL}?code=a&state=b`)).toBe(true);
    });

    it('survives a url-encoded value', () => {
        const callback = parseCallbackUrl('archonarena://patreon?code=a%2Fb%2Bc&state=m.x%3Dy');

        expect(callback.code).toBe('a/b+c');
        expect(callback.state).toBe('m.x=y');
    });
});

/**
 * Guideline 5.3.1 requires a contest in an app to be sponsored by the DEVELOPER,
 * with its rules in the app and a statement that Apple is not involved. Archon
 * Arena's paid events are third-party contests created by any signed-in player,
 * for up to $10,000 in fifteen currencies, and the site's own Terms decline the
 * legality certification 5.3.2 asks for. That is structural: hiding a price
 * badge does not cure it, because the events themselves are the contests.
 */
describe('paid events', () => {
    it('are not shown on iOS', () => {
        expect(allowsPaidEvents('ios')).toBe(false);
        expect(hidesEvent({ entryFeeCents: 2500 }, 'ios')).toBe(true);
    });

    it('never hides a free event, on any platform', () => {
        // The overwhelming majority, and everything the app was built for.
        for (const event of [{ entryFeeCents: 0 }, { entryFeeCents: null }, {}]) {
            for (const platform of ['ios', 'android', 'web']) {
                expect(hidesEvent(event, platform)).toBe(false);
            }
        }
    });

    it('recognises a buy-in only when there is one', () => {
        expect(hasEntryFee({ entryFeeCents: 1 })).toBe(true);
        expect(hasEntryFee({ entryFeeCents: 0 })).toBe(false);
        expect(hasEntryFee({ entryFeeCents: null })).toBe(false);
        expect(hasEntryFee(undefined)).toBe(false);
    });

    it('follows the same platform switch as the tier prices', () => {
        // Two independent switches would eventually disagree, and the one that
        // drifted would be the one nobody was testing.
        for (const platform of ['ios', 'android', 'web', 'visionos']) {
            expect(allowsPaidEvents(platform)).toBe(allowsPurchaseLinks(platform));
        }
    });
});
