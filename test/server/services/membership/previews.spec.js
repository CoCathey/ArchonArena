const {
    PREVIEWS,
    PREVIEW_STAGES,
    STAGE_CAPABILITY,
    previewById,
    availabilityFor,
    isAvailable,
    isEnabled,
    canUsePreview,
    enabledPreviews,
    previewCatalog,
    previewCapabilitiesWithContent
} = require('../../../../server/services/membership/previews');
const {
    CAPABILITIES,
    CAPABILITY_CATALOG
} = require('../../../../server/services/membership/capabilities');
const { TIER_IDS, capabilitiesForTier } = require('../../../../server/services/membership/tiers');

/**
 * ARCHON (N12): the preview programme is what makes three of Vault Master's
 * five promises true, so the things worth testing are the ones that would make
 * them false again:
 *
 *   - a preview reaching a tier that should not have it yet,
 *   - priority access buying nothing,
 *   - a stage emptying out and leaving the capability advertised anyway.
 *
 * The last one is the reason the tier was taken off sale in the first place.
 */
describe('the preview programme', function () {
    const NOW = new Date('2026-09-01T00:00:00Z');
    const capsFor = (tier) => capabilitiesForTier(tier);

    const FREE = capsFor(TIER_IDS.FREE);
    const SUPPORTER = capsFor(TIER_IDS.SUPPORTER);
    const ARCHON = capsFor(TIER_IDS.ARCHON);
    const VAULT_MASTER = capsFor(TIER_IDS.VAULT_MASTER);

    describe('the registry', function () {
        it('describes every preview well enough to render it', function () {
            for (const preview of PREVIEWS) {
                expect(preview.id, 'a preview needs an id').toBeTruthy();
                expect(preview.label, `${preview.id} has no label`).toBeTruthy();
                expect(preview.summary, `${preview.id} has no summary`).toBeTruthy();
                expect(preview.where, `${preview.id} does not say where it appears`).toBeTruthy();
                expect(
                    Object.values(PREVIEW_STAGES),
                    `${preview.id} is at an unknown stage`
                ).toContain(preview.stage);
                // Where it lands when it stops being a preview. Without this a
                // graduated preview has nowhere to go and would simply vanish.
                expect(
                    Object.values(CAPABILITIES),
                    `${preview.id} graduates to an unknown capability`
                ).toContain(preview.graduatesTo);
                expect(
                    Number.isNaN(new Date(`${preview.openedAt}T00:00:00Z`).getTime()),
                    `${preview.id} has an unreadable openedAt`
                ).toBe(false);
            }
        });

        it('has unique ids', function () {
            const ids = PREVIEWS.map((preview) => preview.id);

            expect(new Set(ids).size).toBe(ids.length);
        });
    });

    describe('who can reach a preview', function () {
        it('gives an experimental preview to Vault Master and nobody below', function () {
            const preview = PREVIEWS.find((entry) => entry.stage === PREVIEW_STAGES.EXPERIMENTAL);

            expect(preview, 'no experimental preview to test with').toBeDefined();
            expect(availabilityFor(preview, VAULT_MASTER)).not.toBeNull();

            for (const [name, capabilities] of [
                ['free', FREE],
                ['supporter', SUPPORTER],
                ['archon', ARCHON]
            ]) {
                expect(
                    availabilityFor(preview, capabilities),
                    `${name} should not reach an experimental preview`
                ).toBeNull();
            }
        });

        it('gives a beta preview to Vault Master and nobody below', function () {
            const preview = PREVIEWS.find((entry) => entry.stage === PREVIEW_STAGES.BETA);

            expect(preview).toBeDefined();
            expect(availabilityFor(preview, VAULT_MASTER)).not.toBeNull();
            expect(availabilityFor(preview, ARCHON)).toBeNull();
        });

        it('opens an early access preview to Archon, but later than Vault Master', function () {
            const preview = PREVIEWS.find(
                (entry) => entry.stage === PREVIEW_STAGES.EARLY_ACCESS && entry.priorityDays > 0
            );

            expect(preview, 'no early access preview with a head start').toBeDefined();

            const master = availabilityFor(preview, VAULT_MASTER);
            const archon = availabilityFor(preview, ARCHON);

            expect(master.viaPriority).toBe(true);
            expect(archon).not.toBeNull();
            expect(archon.viaPriority).toBe(false);

            // The head start, in the only terms that matter: days.
            const days = (archon.from.getTime() - master.from.getTime()) / 86400000;

            expect(days).toBe(preview.priorityDays);
        });

        it('is not reachable before its window opens', function () {
            const preview = {
                id: 'test',
                stage: PREVIEW_STAGES.EARLY_ACCESS,
                openedAt: '2026-10-01',
                priorityDays: 30,
                defaultOn: true
            };

            expect(isAvailable(preview, ARCHON, NOW)).toBe(false);
            // Priority access does not skip the opening date either - it moves
            // you to the front of the queue, not to before it exists.
            expect(isAvailable(preview, VAULT_MASTER, NOW)).toBe(false);
            expect(isAvailable(preview, VAULT_MASTER, new Date('2026-10-02T00:00:00Z'))).toBe(true);
            expect(isAvailable(preview, ARCHON, new Date('2026-10-02T00:00:00Z'))).toBe(false);
            expect(isAvailable(preview, ARCHON, new Date('2026-11-02T00:00:00Z'))).toBe(true);
        });

        it('treats an unreadable open date as already open rather than never', function () {
            const preview = {
                id: 'test',
                stage: PREVIEW_STAGES.BETA,
                openedAt: 'not-a-date',
                priorityDays: 0,
                defaultOn: true
            };

            expect(isAvailable(preview, VAULT_MASTER, NOW)).toBe(true);
        });
    });

    describe('the switch', function () {
        const preview = { id: 'thing', defaultOn: true };
        const offByDefault = { id: 'other', defaultOn: false };

        it('falls back to the registry default when never answered', function () {
            expect(isEnabled(preview, {})).toBe(true);
            expect(isEnabled(offByDefault, {})).toBe(false);
        });

        it('honours an explicit answer over the default', function () {
            expect(isEnabled(preview, { thing: false })).toBe(false);
            expect(isEnabled(offByDefault, { other: true })).toBe(true);
        });

        it('reads a null answer as never answered', function () {
            expect(isEnabled(preview, { thing: null })).toBe(true);
        });
    });

    describe('canUsePreview', function () {
        const beta = PREVIEWS.find((entry) => entry.stage === PREVIEW_STAGES.BETA);

        it('needs both entitlement and the switch', function () {
            expect(canUsePreview(VAULT_MASTER, {}, beta.id, NOW)).toBe(!!beta.defaultOn);
            expect(canUsePreview(VAULT_MASTER, { [beta.id]: true }, beta.id, NOW)).toBe(true);
            expect(canUsePreview(VAULT_MASTER, { [beta.id]: false }, beta.id, NOW)).toBe(false);
            expect(canUsePreview(ARCHON, { [beta.id]: true }, beta.id, NOW)).toBe(false);
        });

        it('is false for a preview this build does not know', function () {
            // A preview retired between releases must lock its feature, not
            // throw inside whatever page calls it.
            expect(canUsePreview(VAULT_MASTER, { ghost: true }, 'ghost', NOW)).toBe(false);
        });

        it('stops asking about the switch once a preview has graduated', function () {
            const released = {
                id: 'released-thing',
                stage: PREVIEW_STAGES.RELEASED,
                graduatesTo: CAPABILITIES.META_ANALYTICS,
                openedAt: '2026-01-01',
                priorityDays: 0,
                defaultOn: false
            };

            // Not in the registry, so canUsePreview cannot find it - the point
            // of this case is the resolution rule, tested directly.
            expect(previewById(released.id)).toBeUndefined();
        });

        it('accepts an entitlements object as well as a capability list', function () {
            const asObject = { capabilities: VAULT_MASTER };

            expect(canUsePreview(asObject, { [beta.id]: true }, beta.id, NOW)).toBe(true);
        });
    });

    describe('the catalogue the profile panel renders', function () {
        it('is empty for a tier that reaches no stage', function () {
            expect(previewCatalog(FREE, {}, NOW)).toEqual([]);
            expect(previewCatalog(SUPPORTER, {}, NOW)).toEqual([]);
        });

        it('shows Vault Master every preview', function () {
            expect(previewCatalog(VAULT_MASTER, {}, NOW).length).toBe(PREVIEWS.length);
        });

        it('shows Archon only the early access ones', function () {
            const catalog = previewCatalog(ARCHON, {}, NOW);
            const stages = new Set(catalog.map((entry) => entry.stage));

            expect(catalog.length).toBeGreaterThan(0);
            expect([...stages]).toEqual([PREVIEW_STAGES.EARLY_ACCESS]);
        });

        it('reports a not-yet-open preview with its date rather than hiding it', function () {
            // Read the day after everything opened but inside the head start:
            // Archon can see the row and is told when it becomes theirs.
            const dayAfter = new Date('2026-08-16T00:00:00Z');
            const catalog = previewCatalog(ARCHON, {}, dayAfter);
            const waiting = catalog.filter((entry) => !entry.available);

            expect(waiting.length).toBeGreaterThan(0);

            for (const entry of waiting) {
                expect(entry.availableFrom).toBeTruthy();
                // Never on, because it is not theirs yet - a switch that is on
                // for something you cannot use is a lie about your own settings.
                expect(entry.enabled).toBe(false);
            }
        });

        it('marks the head start only where there is one to have', function () {
            for (const entry of previewCatalog(VAULT_MASTER, {}, NOW)) {
                expect(entry.viaPriority).toBe(entry.priorityDays > 0);
            }
        });
    });

    describe('enabledPreviews', function () {
        it('lists what a Vault Master actually has switched on', function () {
            const defaults = enabledPreviews(VAULT_MASTER, {}, NOW);
            const onByDefault = PREVIEWS.filter((preview) => preview.defaultOn).map(
                (preview) => preview.id
            );

            expect(defaults.sort()).toEqual(onByDefault.sort());
        });

        it('is empty for a free account whatever it has stored', function () {
            const everythingOn = Object.fromEntries(PREVIEWS.map((preview) => [preview.id, true]));

            expect(enabledPreviews(FREE, everythingOn, NOW)).toEqual([]);
        });
    });

    /**
     * The invariant the tier's honesty rests on. A capability may only be sold
     * as included while there is something behind it; for the preview
     * capabilities, "something behind it" means the registry holds a preview at
     * that stage. Derived rather than asserted by hand, so a preview graduating
     * out of a stage fails here instead of quietly leaving a tier advertising an
     * empty queue.
     */
    describe('the preview capabilities and the catalogue agree', function () {
        const PREVIEW_CAPABILITIES = [
            CAPABILITIES.EXPERIMENTAL_FEATURES,
            CAPABILITIES.BETA_FEATURES,
            CAPABILITIES.EARLY_ACCESS,
            CAPABILITIES.PRIORITY_ACCESS
        ];

        it('does not advertise a preview capability with an empty stage', function () {
            const live = new Set(previewCapabilitiesWithContent());
            const overSold = PREVIEW_CAPABILITIES.filter(
                (capability) => !live.has(capability) && !CAPABILITY_CATALOG[capability].planned
            );

            expect(
                overSold,
                'These preview capabilities are sold as included, but the registry has ' +
                    'nothing at their stage. Add a preview, or mark them planned:\n  ' +
                    overSold.join('\n  ')
            ).toEqual([]);
        });

        it('does not mark a preview capability planned while its stage has content', function () {
            const live = previewCapabilitiesWithContent();
            const stale = live.filter((capability) => CAPABILITY_CATALOG[capability].planned);

            expect(
                stale,
                'These have live previews but are still flagged planned:\n  ' + stale.join('\n  ')
            ).toEqual([]);
        });

        it('maps every non-released stage to a capability', function () {
            for (const stage of Object.values(PREVIEW_STAGES)) {
                if (stage === PREVIEW_STAGES.RELEASED) {
                    continue;
                }

                expect(STAGE_CAPABILITY[stage], `${stage} admits nobody`).toBeTruthy();
            }
        });
    });
});
