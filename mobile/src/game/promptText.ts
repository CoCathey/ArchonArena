import type { CardSummary, PromptButton } from './types';

/**
 * i18next-style prompt text interpolation, mirroring the web client's
 * ActivePlayerPrompt (client/Components/GameBoard/ActivePlayerPrompt.jsx).
 * The server sends prompt text either as a plain string or as
 * `{ text, values }`, where the text contains `{{key}}` placeholders —
 * most importantly `{{card}}` (e.g. playing a card from the archives sends
 * buttons `{ text: '{{card}}', values: { card: name }, card: summary }`).
 * The web client resolves these through i18next; in English that collapses
 * to plain `{{key}}` → values[key] substitution, which is what we do here.
 */

export type PromptTextValue =
    | string
    | number
    | { text?: string; values?: Record<string, unknown>; [key: string]: unknown }
    | undefined;

function substitute(text: string, values?: Record<string, unknown>): string {
    if (!values) {
        return text;
    }
    let result = text;
    for (const [key, replacement] of Object.entries(values)) {
        if (replacement === undefined || replacement === null) {
            continue;
        }
        result = result.split(`{{${key}}}`).join(String(replacement));
    }
    return result;
}

/**
 * Resolve a prompt title (menuTitle / promptTitle) to display text.
 * `sourceCard` fills a `{{card}}` placeholder that arrives without a value —
 * the web client uses `controls[0].source` for exactly this.
 */
export function formatPromptText(
    value: PromptTextValue,
    sourceCard?: Pick<CardSummary, 'name' | 'label'>
): string | undefined {
    if (value === undefined || value === null) {
        return undefined;
    }
    let text: string;
    let values: Record<string, unknown> | undefined;
    if (typeof value === 'string' || typeof value === 'number') {
        text = String(value);
    } else {
        text = value.text ?? '';
        values = value.values;
    }
    text = substitute(text, values);
    const sourceName = sourceCard?.name ?? sourceCard?.label;
    if (sourceName && text.includes('{{card}}')) {
        text = text.split('{{card}}').join(String(sourceName));
    }
    return text || undefined;
}

/**
 * Resolve a prompt button's label. Buttons may carry `values` for their
 * `{{key}}` placeholders and/or a serialized `card`; when the text still
 * contains `{{card}}` after interpolation (or there is no text at all), the
 * card's name fills in — so "{{card}} (play)" renders as "Krump (play)".
 */
export function formatButtonText(button: PromptButton): string {
    const raw = button.text;
    let text: string;
    let values: Record<string, unknown> | undefined =
        (button.values as Record<string, unknown> | undefined) ?? undefined;
    if (raw === undefined || raw === null) {
        text = '';
    } else if (typeof raw === 'string' || typeof raw === 'number') {
        text = String(raw);
    } else {
        const complex = raw as { text?: string; values?: Record<string, unknown> };
        text = complex.text ?? '';
        values = complex.values ?? values;
    }
    text = substitute(text, values);
    const cardName = button.card?.name ?? button.card?.label;
    if (cardName) {
        if (!text) {
            text = String(cardName);
        } else if (text.includes('{{card}}')) {
            text = text.split('{{card}}').join(String(cardName));
        }
    }
    return text;
}
