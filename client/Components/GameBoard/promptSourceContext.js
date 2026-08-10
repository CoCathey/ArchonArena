/**
 * Whether ActivePlayerPrompt should show a "because of <card>" row for the
 * active control's source card.
 *
 * `controls[0].source` is already used to fill `{{card}}` placeholders in
 * prompt text (see ActivePlayerPrompt's `localizedText`), but a prompt whose
 * text does not happen to carry that placeholder shows the source nowhere -
 * that is the gap this fills. A `targeting` control already renders its
 * source visually via AbilityTargeting, so this deliberately stays quiet
 * there rather than showing the same card twice.
 *
 * @param {Array<{type?: string, source?: object, targets?: object[]}>} [controls]
 * @returns {{source: object, targets: object[]}|null}
 */
export function getPromptSourceContext(controls) {
    const control = Array.isArray(controls) ? controls[0] : null;

    if (!control || !control.source || control.type === 'targeting') {
        return null;
    }

    return {
        source: control.source,
        targets: Array.isArray(control.targets) ? control.targets : []
    };
}
