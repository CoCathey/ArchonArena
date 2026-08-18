/**
 * ARCHON (N9): reading a check-in code off a scanned QR.
 *
 * The organizer's printed QR encodes `/check-in/<code>`, but posters get made
 * with whatever tooling the organizer has — a full https URL, a bare path, or
 * the code on its own. All three have to work.
 *
 * Anything else has to return nothing. A phone pointed at a table scans every
 * QR on it, and posting a venue's wifi string to the check-in endpoint is a
 * worse outcome than doing nothing at all.
 *
 * Lives here rather than in the screen because it is the only part with
 * anything to get wrong, and a component is the one thing in this project that
 * cannot be unit tested.
 */
export function codeFromScan(raw: string): string | undefined {
    const text = (raw || '').trim();
    if (!text) {
        return undefined;
    }

    const match = text.match(/check-in\/([^/?#\s]+)/i);
    if (match) {
        return decodeURIComponent(match[1]);
    }

    // A bare code, as printed on the card next to the QR. Codes are
    // alphanumeric — the server itself strips everything else before looking
    // one up (`normalizeJoinCode`) — so anything carrying punctuation is some
    // other QR on the same table, not a code.
    return /^[A-Za-z0-9]+$/.test(text) ? text : undefined;
}
