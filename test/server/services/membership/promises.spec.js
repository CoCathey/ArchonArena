const fs = require('fs');
const path = require('path');

const {
    CAPABILITIES,
    CAPABILITY_CATALOG,
    ALL_CAPABILITIES
} = require('../../../../server/services/membership/capabilities');
const {
    TIERS,
    liveCapabilitiesForTier,
    tierCatalog
} = require('../../../../server/services/membership/tiers');

/**
 * ARCHON (N12): every tier promise must either be enforced by code or be
 * marked as planned.
 *
 * This exists because an audit of the tiers against the codebase found
 * thirteen capabilities that were advertised on the pricing page, sold as part
 * of a tier, and referenced by nothing at all - including all five of Vault
 * Master's, which meant $20 a month bought nothing over Archon. Two more were
 * worse than missing: Supporter was sold "Full Elo history" and a "Performance
 * dashboard" whose only endpoint required ARCHON_INTELLIGENCE, so a paying
 * Supporter got a 403 on the things they had paid for.
 *
 * A promise with no gate is not a bug the type system or the tests would
 * otherwise catch - the code is perfectly valid, it just quietly takes money
 * for nothing. So the check is structural: scan the source for references to
 * each capability constant, and require that anything unreferenced is
 * explicitly flagged `planned`.
 *
 * When you ship one of the planned features: gate something on its capability
 * and remove the flag. Both, in the same change - that is what this enforces.
 */
describe('tier promises', function () {
    const ROOT = path.resolve(__dirname, '../../../..');

    /** Every .js/.jsx under a directory, excluding the definitions themselves. */
    const sourceFiles = (dir) => {
        const out = [];
        const walk = (current) => {
            for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
                const full = path.join(current, entry.name);

                if (entry.isDirectory()) {
                    if (entry.name === 'node_modules' || entry.name === 'cards') {
                        continue;
                    }

                    walk(full);
                } else if (/\.(js|jsx)$/.test(entry.name)) {
                    out.push(full);
                }
            }
        };

        walk(dir);

        return out.filter(
            (file) =>
                // These DEFINE the capabilities; a mention here is not a use.
                !file.endsWith(path.join('membership', 'capabilities.js')) &&
                !file.endsWith(path.join('membership', 'tiers.js')) &&
                !file.endsWith(path.join('client', 'membership.js'))
        );
    };

    /**
     * ARCHON (N12): a preview's `graduatesTo` is not a gate.
     *
     * previews.js names the capability each in-progress feature will belong to
     * once it is finished. That is a plan, not a delivery - the feature is
     * currently reachable through the preview programme and NOT through the
     * capability it points at, which is the entire distinction the programme
     * exists to express.
     *
     * Left in, it would read as "advanced_performance_dashboard is referenced,
     * so remove its planned flag" - and Archon would go back to advertising a
     * dashboard it does not have, which is exactly the failure this file was
     * written to catch. The stage capabilities in the same file are real gates
     * and stay in the corpus.
     */
    const withoutGraduationTargets = (source) =>
        source.replace(/graduatesTo:\s*CAPABILITIES\.[A-Z_]+/g, 'graduatesTo: <planned>');

    const corpus = [
        ...sourceFiles(path.join(ROOT, 'server')),
        ...sourceFiles(path.join(ROOT, 'client'))
    ]
        .map((file) => withoutGraduationTargets(fs.readFileSync(file, 'utf8')))
        .join('\n');

    /** Constant name for a capability id, e.g. elo_history -> ELO_HISTORY. */
    const constantFor = (id) => Object.keys(CAPABILITIES).find((key) => CAPABILITIES[key] === id);

    const isReferenced = (id) => {
        const constant = constantFor(id);

        // Both spellings: CAPABILITIES.FOO in code, and the raw id in case
        // anything ever checks the string directly.
        return (
            new RegExp(`CAPABILITIES\\.${constant}\\b`).test(corpus) ||
            new RegExp(`['"\`]${id}['"\`]`).test(corpus)
        );
    };

    it('has copy for every capability', function () {
        for (const capability of ALL_CAPABILITIES) {
            expect(
                CAPABILITY_CATALOG[capability],
                `no catalogue entry for ${capability}`
            ).toBeDefined();
            expect(CAPABILITY_CATALOG[capability].label).toBeTruthy();
            expect(CAPABILITY_CATALOG[capability].learn).toBeTruthy();
        }
    });

    it('never sells a capability that nothing in the code gates on', function () {
        const unkept = ALL_CAPABILITIES.filter(
            (capability) => !isReferenced(capability) && !CAPABILITY_CATALOG[capability].planned
        );

        expect(
            unkept,
            `These capabilities are sold as part of a tier but nothing references them. ` +
                `Either gate a feature on them, or mark them planned: true in capabilities.js.\n  ` +
                unkept.join('\n  ')
        ).toEqual([]);
    });

    it('does not mark a delivered capability as planned', function () {
        // The opposite mistake: shipping the feature and forgetting to remove
        // the flag, so a working feature keeps being advertised as unavailable.
        const stale = ALL_CAPABILITIES.filter(
            (capability) => CAPABILITY_CATALOG[capability].planned && isReferenced(capability)
        );

        expect(
            stale,
            `These are flagged planned but ARE referenced in code - remove the flag:\n  ` +
                stale.join('\n  ')
        ).toEqual([]);
    });

    it('only offers checkout for a tier that delivers something today', function () {
        // The invariant that matters: a tier may exist and be advertised while
        // its features are still being built, but it must not be SOLD until it
        // delivers something the tier below does not already include. Vault
        // Master was on sale at $20 with all five of its capabilities unbuilt.
        for (const tier of tierCatalog({ campaignUrl: 'https://example.test/c' })) {
            if (!tier.purchasable) {
                expect(
                    tier.checkoutUrl,
                    `${tier.name} is not purchasable but still offers a checkout link`
                ).toBeNull();

                continue;
            }

            const below = TIERS.filter((candidate) => candidate.rank < tier.rank).sort(
                (a, b) => b.rank - a.rank
            )[0];
            const inherited = new Set(below ? liveCapabilitiesForTier(below.id) : []);
            const extra = liveCapabilitiesForTier(tier.id).filter(
                (capability) => !inherited.has(capability)
            );

            expect(
                extra.length,
                `${tier.name} ($${tier.priceUsd}) is on sale but delivers nothing ` +
                    `${below ? below.name : 'Free'} does not already include`
            ).toBeGreaterThan(0);
        }
    });

    it('reports which tiers are currently sellable', function () {
        // Not an assertion about WHICH - that changes as features ship. It
        // fails only if nothing at all can be sold, which would mean the
        // membership system has no product behind it.
        const sellable = tierCatalog({}).filter((tier) => tier.purchasable);

        expect(sellable.length, 'no tier delivers enough to be sold').toBeGreaterThan(0);
    });
});
