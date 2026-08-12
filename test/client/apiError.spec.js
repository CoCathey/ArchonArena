import { serverMessage, serverPayload } from '../../client/redux/apiError';

/**
 * ARCHON: the server's reason has to reach the person who caused it.
 *
 * This API's baseQuery marks a 200 carrying `{ success: false }` as a refusal
 * (validateStatus in api.js). That is the right call, and it has a consequence
 * that is very easy to write straight past:
 *
 *     const result = await doThing().unwrap();
 *     if (result.success) { ... }
 *     toast.danger(result.message);      // never runs
 *
 * `.unwrap()` throws for a refusal, so every server-side "no" on the
 * tournament pages was swallowed and replaced with a generic sentence -
 * "Action failed", "That code did not check you in" - while the server had
 * said exactly what was wrong. A player scanning the check-in QR was told
 * nothing at all when the real answer was "Register for the event first".
 */
describe('serverMessage', function () {
    // The shape RTK Query throws for a refused response.
    const refusal = (data, status = 200) => ({ status, data });

    it('uses the reason the server gave', function () {
        expect(serverMessage(refusal({ success: false, message: 'Check-in is not open' }))).toBe(
            'Check-in is not open'
        );
        expect(
            serverMessage(refusal({ success: false, message: 'Register for the event first' }))
        ).toBe('Register for the event first');
    });

    // Signing in again is advice somebody can act on; "try again" is not.
    it('names an expired session rather than blaming the input', function () {
        for (const status of [401, 403]) {
            expect(serverMessage(refusal('Unauthorized', status))).toMatch(/sign in again/i);
        }
    });

    it('names rate limiting', function () {
        expect(serverMessage(refusal({}, 429))).toMatch(/too quickly/i);
    });

    it('names a network failure as a network failure', function () {
        expect(serverMessage({ status: 'FETCH_ERROR', error: 'TypeError' })).toMatch(
            /Could not reach the server/i
        );
    });

    it('passes through a plain-text body', function () {
        expect(serverMessage(refusal('Unauthorized', 500))).toBe('Unauthorized');
    });

    // Never a bare fallback where a status is known: a report saying "it said
    // Action failed" is worth nothing, "Action failed (HTTP 502)" is worth
    // something.
    it('carries the status when it has nothing better', function () {
        expect(serverMessage(refusal({ success: false }, 502), 'Action failed')).toBe(
            'Action failed (HTTP 502)'
        );
    });

    it('falls back cleanly when there is nothing to go on', function () {
        expect(serverMessage(null, 'Action failed')).toBe('Action failed');
        expect(serverMessage(undefined, 'Action failed')).toBe('Action failed');
        expect(serverMessage({}, 'Action failed')).toBe('Action failed');
    });
});

describe('serverPayload', function () {
    // The early-finish confirmation reads the round counts off the refusal,
    // which only exists because a refusal is thrown rather than returned.
    it('hands back the refused body for callers that need more than a message', function () {
        const body = { success: false, earlyFinish: true, roundsPlayed: 1, roundsPlanned: 3 };

        expect(serverPayload({ status: 200, data: body })).toEqual(body);
    });

    it('is null when there is no body to read', function () {
        expect(serverPayload({ status: 'FETCH_ERROR' })).toBeNull();
        expect(serverPayload({ status: 401, data: 'Unauthorized' })).toBeNull();
        expect(serverPayload(null)).toBeNull();
    });
});
