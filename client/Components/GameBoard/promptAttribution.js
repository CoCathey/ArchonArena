/**
 * Resolve the display name of a prompt's source card (`controls[0].source`,
 * a `GameObject#getShortSummary()` payload) in the active UI language.
 * Mirrors the locale fallback `ActivePlayerPrompt`'s `localizedText` already
 * uses for `{{card}}` substitution, so the "because of <card>" attribution
 * row agrees with the interpolated text when both are shown.
 */
export function getLocalizedSourceName(source, language) {
    if (!source) {
        return null;
    }

    if (language && language !== 'en' && source.locale && source.locale[language]) {
        return source.locale[language].name;
    }

    return source.name;
}
