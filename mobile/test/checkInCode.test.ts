import { describe, expect, it } from 'vitest';
import { codeFromScan } from '../src/tournaments/checkInCode';

/**
 * The printed QR encodes `/check-in/<code>`, but organizers print posters with
 * whatever their tooling produces — a full https URL, a bare path, or the code
 * on its own. All three have to check somebody in, and anything else has to be
 * ignored rather than posted to the server as a code.
 */
describe('check-in QR parsing', () => {
    it('reads a full site URL', () => {
        expect(codeFromScan('https://archonarena.com/check-in/ABC123')).toBe('ABC123');
    });

    it('reads a bare path', () => {
        expect(codeFromScan('/check-in/ABC123')).toBe('ABC123');
    });

    it('ignores a trailing query or fragment', () => {
        expect(codeFromScan('https://archonarena.com/check-in/ABC123?utm=poster')).toBe('ABC123');
        expect(codeFromScan('https://archonarena.com/check-in/ABC123#top')).toBe('ABC123');
    });

    it('percent-decodes the code', () => {
        expect(codeFromScan('https://archonarena.com/check-in/AB%20C')).toBe('AB C');
    });

    it('takes a bare code, which is what the printed card carries', () => {
        expect(codeFromScan('ABC123')).toBe('ABC123');
        expect(codeFromScan('  ABC123 ')).toBe('ABC123');
    });

    it('refuses a URL that is not a check-in link', () => {
        // Posters get scanned at events where other QR codes are on the same
        // table. Posting a wifi URL to the check-in endpoint is worse than
        // doing nothing.
        expect(codeFromScan('https://example.com/somewhere')).toBeUndefined();
        expect(codeFromScan('WIFI:S:venue;T:WPA;P:hunter2;;')).toBeUndefined();
    });

    it('refuses nothing at all', () => {
        expect(codeFromScan('')).toBeUndefined();
        expect(codeFromScan('   ')).toBeUndefined();
    });
});
