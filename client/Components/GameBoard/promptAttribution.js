// Control types that already render their source card as part of their own
// widget (AbilityTargeting draws source -> targets). Surfacing it a second
// time as a "because of" row would just repeat the same thumbnail.
const SELF_ATTRIBUTING_CONTROL_TYPES = new Set(['targeting']);

/**
 * The source card to attribute a prompt to, for control types (house-select,
 * options-select, card-name, trait-name) that don't already show it. Mirrors
 * the Expo app's PromptPanel `EffectContext` row
 * (mobile/src/game/PromptPanel.tsx), which is the model this ports.
 *
 * @param {Object[]} controls
 * @returns {Object|null} a short card summary, or null if nothing should be shown
 */
export function getPromptSourceAttribution(controls) {
    if (!Array.isArray(controls) || controls.length === 0) {
        return null;
    }

    const control = controls.find((c) => c && c.source);
    if (!control || SELF_ATTRIBUTING_CONTROL_TYPES.has(control.type)) {
        return null;
    }

    return control.source;
}
