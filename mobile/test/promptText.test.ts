import { describe, expect, it } from 'vitest';
import { formatButtonText, formatPromptText } from '../src/game/promptText';

describe('formatPromptText', () => {
    it('passes plain strings through', () => {
        expect(formatPromptText('Waiting for opponent')).toBe('Waiting for opponent');
    });

    it('interpolates {{key}} values from a {text, values} title', () => {
        expect(
            formatPromptText({ text: 'Play {{card}}:', values: { card: 'Z.Y.X. Researcher' } })
        ).toBe('Play Z.Y.X. Researcher:');
    });

    it('fills a value-less {{card}} from the control source card', () => {
        expect(formatPromptText('{{card}}', { name: 'Harvest Skimmer' })).toBe('Harvest Skimmer');
    });

    it('prefers explicit values over the source card', () => {
        expect(
            formatPromptText({ text: '{{card}}', values: { card: 'From Values' } }, { name: 'Src' })
        ).toBe('From Values');
    });

    it('handles numbers and empty input', () => {
        expect(formatPromptText(0)).toBe('0');
        expect(formatPromptText(undefined)).toBeUndefined();
        expect(formatPromptText('')).toBeUndefined();
    });
});

describe('formatButtonText', () => {
    it('interpolates {{card}} from button values (triggered-ability buttons)', () => {
        expect(
            formatButtonText({
                text: '{{card}} (play)',
                values: { card: 'Precocious Fragment' },
                card: { uuid: 'x', name: 'Precocious Fragment' }
            })
        ).toBe('Precocious Fragment (play)');
    });

    it('falls back to the attached card when no values are sent', () => {
        expect(
            formatButtonText({ text: '{{card}}', card: { uuid: 'x', name: 'Groke' } })
        ).toBe('Groke');
    });

    it('uses the card name when there is no text at all', () => {
        expect(formatButtonText({ card: { uuid: 'x', name: 'Ogopogo' } })).toBe('Ogopogo');
    });

    it('leaves ordinary buttons alone', () => {
        expect(formatButtonText({ text: 'Autoresolve', arg: 'autoresolve' })).toBe('Autoresolve');
        expect(formatButtonText({ text: 'Done', card: { uuid: 'x', name: 'Groke' } })).toBe('Done');
    });
});
