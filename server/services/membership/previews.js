const { CAPABILITIES } = require('./capabilities');

/**
 * ARCHON (N12): the preview programme - how an unfinished feature reaches
 * players, and which tier reaches it first.
 *
 * Vault Master is sold on three promises that are all the same promise wearing
 * different hats: experimental features, beta features, and priority access.
 * None of them is a feature. Each is a *position in a queue*, and a queue needs
 * a mechanism or the tier is selling a feeling.
 *
 * This is the mechanism. A feature that is not finished is registered here with
 * the stage it is at, and the stage decides which capability admits an account
 * to it:
 *
 *   experimental  -> EXPERIMENTAL_FEATURES   (Vault Master)
 *   beta          -> BETA_FEATURES           (Vault Master)
 *   early_access  -> EARLY_ACCESS            (Archon and above)
 *   released      -> the capability in `graduatesTo`, and the preview is over
 *
 * A feature moves down that list as it settles, so the audience widens one tier
 * at a time and the registry is the record of where each one currently is.
 *
 * ## What PRIORITY_ACCESS actually buys
 *
 * A head start, in days, measured from the date the preview opened. Holders of
 * PRIORITY_ACCESS get a preview on `openedAt`; everyone else who holds the
 * stage's capability gets it `priorityDays` later. With `priorityDays: 0` the
 * two are the same day and priority buys nothing - which is the honest state
 * for a stage only Vault Master can reach anyway, and why the value is per
 * preview rather than a global constant.
 *
 * ## Opt-in
 *
 * Being entitled to a preview is not the same as wanting it. Every preview is a
 * switch in Profile -> Previews, and `defaultOn` decides where that switch
 * starts: on for something that is merely early, off for something that is
 * genuinely half-built and might be wrong. A player who has never touched the
 * page still gets the settled ones.
 *
 * ## The invariant this file exists to protect
 *
 * A preview capability must not be advertised as included until the registry
 * has something live at that stage - otherwise Vault Master is selling an empty
 * queue, which is exactly the audit finding that took the tier off sale.
 * `previewCapabilitiesWithContent()` derives the truth, and the spec asserts the
 * catalogue's `planned` flags agree with it.
 */

const PREVIEW_STAGES = Object.freeze({
    EXPERIMENTAL: 'experimental',
    BETA: 'beta',
    EARLY_ACCESS: 'early_access',
    RELEASED: 'released'
});

/** Which capability admits an account to each stage. */
const STAGE_CAPABILITY = Object.freeze({
    [PREVIEW_STAGES.EXPERIMENTAL]: CAPABILITIES.EXPERIMENTAL_FEATURES,
    [PREVIEW_STAGES.BETA]: CAPABILITIES.BETA_FEATURES,
    [PREVIEW_STAGES.EARLY_ACCESS]: CAPABILITIES.EARLY_ACCESS
});

/** How each stage is described to the player. */
const STAGE_COPY = Object.freeze({
    [PREVIEW_STAGES.EXPERIMENTAL]: {
        label: 'Experimental',
        caution: 'Still being designed. It may change shape, or be withdrawn.'
    },
    [PREVIEW_STAGES.BETA]: {
        label: 'Beta',
        caution: 'Built and working, still being tested. The numbers are real.'
    },
    [PREVIEW_STAGES.EARLY_ACCESS]: {
        label: 'Early access',
        caution: 'Finished, and on its way to a wider tier.'
    },
    [PREVIEW_STAGES.RELEASED]: {
        label: 'Released',
        caution: 'Out of preview. It is part of the tier it graduated to.'
    }
});

/**
 * The registry.
 *
 * Every entry is a feature that EXISTS - the code behind it is written and the
 * gate that hides it is real. A planned feature does not belong here; it
 * belongs in the capability catalogue with `planned: true`, where it is
 * displayed as a roadmap item rather than as something a preview switch can
 * turn on.
 *
 * @typedef Preview
 * @property {string} id            stable; stored per user, never renamed
 * @property {string} label
 * @property {string} summary       what the player gets, in their terms
 * @property {string} stage         PREVIEW_STAGES
 * @property {string} graduatesTo   the capability that will own it afterwards
 * @property {string} where         where in the UI it shows up
 * @property {string} openedAt      ISO date the preview opened
 * @property {number} priorityDays  head start PRIORITY_ACCESS holders get
 * @property {boolean} defaultOn    on for an account that has never chosen
 */
const PREVIEWS = [
    {
        id: 'form-and-streaks',
        label: 'Form and streaks',
        summary:
            'Your last twenty rated games as a run of results, with your current streak and the ' +
            'best one you have had.',
        stage: PREVIEW_STAGES.EXPERIMENTAL,
        graduatesTo: CAPABILITIES.ADVANCED_PLAYER_STATS,
        where: 'Archon Intelligence → Player Intelligence',
        openedAt: '2026-08-15',
        priorityDays: 0,
        // Off by default: it is the least settled thing here, and a panel that
        // appears unasked is how an experiment becomes a complaint.
        defaultOn: false
    },
    {
        id: 'performance-trend',
        label: 'Performance trend',
        summary:
            'The performance dashboard with a time axis: how far ahead of - or behind - your ' +
            'rating you have been in each of the last several months, rather than one lifetime ' +
            'figure.',
        stage: PREVIEW_STAGES.BETA,
        graduatesTo: CAPABILITIES.ADVANCED_PERFORMANCE_DASHBOARD,
        where: 'Archon Intelligence → Player Intelligence',
        openedAt: '2026-08-15',
        priorityDays: 0,
        defaultOn: true
    },
    {
        id: 'turn-order-insights',
        label: 'Turn order insights',
        summary:
            'Whether you win more going first or second, across every game where the order was ' +
            'recorded.',
        stage: PREVIEW_STAGES.EARLY_ACCESS,
        graduatesTo: CAPABILITIES.ADVANCED_PLAYER_STATS,
        where: 'Archon Intelligence → Player Intelligence',
        openedAt: '2026-08-15',
        // The one place priority currently bites: this stage admits Archon, and
        // Vault Master has it a month before they do.
        priorityDays: 30,
        defaultOn: true
    }
];

const PREVIEWS_BY_ID = new Map(PREVIEWS.map((preview) => [preview.id, preview]));

/** @returns {Preview|undefined} */
function previewById(id) {
    return PREVIEWS_BY_ID.get(id);
}

function holds(capabilities, capability) {
    return !!capability && Array.isArray(capabilities) && capabilities.includes(capability);
}

/** The capability list off an entitlements object, however it was handed over. */
function capabilitiesOf(entitlements) {
    if (Array.isArray(entitlements)) {
        return entitlements;
    }

    return (entitlements && entitlements.capabilities) || [];
}

/** Midnight UTC on the day this preview opened. */
function openedOn(preview) {
    const opened = new Date(`${preview.openedAt}T00:00:00Z`);

    // A malformed date must not silently open a preview to nobody forever; the
    // safe reading is "already open", because everything in this registry is by
    // definition already built.
    return Number.isNaN(opened.getTime()) ? new Date(0) : opened;
}

/**
 * The date this account can first reach a preview, or null if its tier never
 * reaches this stage at all.
 *
 * @param {Preview} preview
 * @param {object|string[]} entitlements
 * @returns {{from: Date, viaPriority: boolean}|null}
 */
function availabilityFor(preview, entitlements) {
    const capabilities = capabilitiesOf(entitlements);
    const stageCapability = STAGE_CAPABILITY[preview.stage];
    const opened = openedOn(preview);

    if (holds(capabilities, CAPABILITIES.PRIORITY_ACCESS)) {
        return { from: opened, viaPriority: true };
    }

    if (!holds(capabilities, stageCapability)) {
        return null;
    }

    const delayDays = Math.max(0, Number(preview.priorityDays) || 0);

    return {
        from: new Date(opened.getTime() + delayDays * 86400000),
        viaPriority: false
    };
}

/** Has this account's window opened yet? */
function isAvailable(preview, entitlements, now = new Date()) {
    const availability = availabilityFor(preview, entitlements);

    return !!availability && availability.from.getTime() <= now.getTime();
}

/**
 * Whether the switch is on for this account.
 *
 * `choices` is the account's explicit answers only - a preview it has never
 * been asked about falls back to `defaultOn`, so a new preview does not arrive
 * switched off for everybody who has ever visited the page.
 *
 * @param {Preview} preview
 * @param {Object<string, boolean>} [choices]
 */
function isEnabled(preview, choices = {}) {
    const chosen = choices ? choices[preview.id] : undefined;

    return chosen === undefined || chosen === null ? !!preview.defaultOn : !!chosen;
}

/**
 * ARCHON (N12): the gate a preview-shipped feature calls.
 *
 * Two ways in, and they are genuinely different states rather than two spellings
 * of one:
 *
 *   - the preview is still running, this account's window has opened, and they
 *     have it switched on;
 *   - the preview is over, and the account holds the capability it graduated
 *     into - at which point the switch is irrelevant, because it is not a
 *     preview any more, it is a feature of their tier.
 *
 * An unknown id is false rather than an exception: a preview retired between
 * releases must lock its feature, not crash the page that calls it.
 *
 * @param {object|string[]} entitlements
 * @param {Object<string, boolean>} choices
 * @param {string} previewId
 * @param {Date} [now]
 */
function canUsePreview(entitlements, choices, previewId, now = new Date()) {
    const preview = previewById(previewId);

    if (!preview) {
        return false;
    }

    if (preview.stage === PREVIEW_STAGES.RELEASED) {
        return holds(capabilitiesOf(entitlements), preview.graduatesTo);
    }

    return isAvailable(preview, entitlements, now) && isEnabled(preview, choices);
}

/**
 * Every preview id this account may currently use, for handing to a request
 * handler that then decides which sections of a payload to build.
 */
function enabledPreviews(entitlements, choices, now = new Date()) {
    return PREVIEWS.filter((preview) => canUsePreview(entitlements, choices, preview.id, now)).map(
        (preview) => preview.id
    );
}

/**
 * The programme as the Profile panel renders it.
 *
 * Includes previews whose window has NOT opened yet, with the date it does -
 * "you will have this on 14 September" is the readable form of a head start, and
 * omitting them would make priority access invisible to the people who are not
 * getting it yet. Previews whose stage this account can never reach are left
 * out entirely: an upsell dressed as a settings row is not a setting.
 */
function previewCatalog(entitlements, choices = {}, now = new Date()) {
    return PREVIEWS.map((preview) => {
        const availability = availabilityFor(preview, entitlements);

        if (!availability) {
            return null;
        }

        const available = availability.from.getTime() <= now.getTime();

        return {
            id: preview.id,
            label: preview.label,
            summary: preview.summary,
            stage: preview.stage,
            stageLabel: STAGE_COPY[preview.stage].label,
            caution: STAGE_COPY[preview.stage].caution,
            where: preview.where,
            graduatesTo: preview.graduatesTo,
            requiresCapability: STAGE_CAPABILITY[preview.stage] || null,
            available,
            availableFrom: availability.from.toISOString(),
            // Shown as "you have this early" rather than as a tick, because that
            // is the thing that was paid for.
            viaPriority: availability.viaPriority && (Number(preview.priorityDays) || 0) > 0,
            priorityDays: Number(preview.priorityDays) || 0,
            enabled: available && isEnabled(preview, choices),
            defaultOn: !!preview.defaultOn
        };
    }).filter(Boolean);
}

/**
 * Which preview capabilities have something live behind them today.
 *
 * This is what makes "experimental features" an honest line on a price list
 * rather than an aspiration: the capability is only real while the registry
 * holds a preview at its stage. Derived, so a preview graduating out of a stage
 * cannot leave the tier advertising an empty queue.
 *
 * @returns {string[]}
 */
function previewCapabilitiesWithContent() {
    const live = new Set();

    for (const preview of PREVIEWS) {
        const capability = STAGE_CAPABILITY[preview.stage];

        if (capability) {
            live.add(capability);
        }

        // Priority access is only true where a preview actually holds a stage
        // open to a lower tier and makes them wait for it.
        if (capability && (Number(preview.priorityDays) || 0) > 0) {
            live.add(CAPABILITIES.PRIORITY_ACCESS);
        }
    }

    return [...live];
}

module.exports = {
    PREVIEW_STAGES,
    STAGE_CAPABILITY,
    STAGE_COPY,
    PREVIEWS,
    previewById,
    availabilityFor,
    isAvailable,
    isEnabled,
    canUsePreview,
    enabledPreviews,
    previewCatalog,
    previewCapabilitiesWithContent
};
