/**
 * ARCHON: get the server's actual reason out of a failed request.
 *
 * This API's baseQuery marks a 200 carrying `{ success: false }` as a refusal
 * (see `validateStatus` in api.js), which is the right call - a refusal is not
 * a success - but it has a consequence that is easy to write straight past:
 *
 *     const result = await doThing().unwrap();
 *     if (result.success) { ... }
 *     toast.danger(result.message);      // UNREACHABLE
 *
 * `.unwrap()` throws for a refusal, so the second half never runs and the real
 * message - "Register for the event first", "Check-in is not open", "Only the
 * organizer can pair the next round" - is discarded in favour of whatever
 * generic sentence sits in the catch. Every server-side refusal on the
 * tournament pages read "Action failed".
 *
 * The reason is on the THROWN value instead: RTK Query surfaces a refused
 * response as `{ status, data }`, where `data` is the parsed body.
 */

/**
 * @param {*} error the value thrown by `.unwrap()`
 * @param {string} fallback what to say when the server offered no reason
 * @returns {string}
 */
export const serverMessage = (error, fallback = 'Something went wrong') => {
    if (!error) {
        return fallback;
    }

    // The normal case: a refusal the server explained.
    if (error.data && typeof error.data === 'object' && error.data.message) {
        return error.data.message;
    }

    // Signed out, or a token that expired while the page stayed open. Worth
    // naming, because "try again" is useless advice and signing in is not.
    if (error.status === 401 || error.status === 403) {
        return 'Your session has expired - sign in again and retry.';
    }

    if (error.status === 429) {
        return 'You are doing that too quickly. Wait a moment and try again.';
    }

    // A string body (passport sends "Unauthorized" as text), or a network
    // failure, which fetchBaseQuery reports as FETCH_ERROR.
    if (typeof error.data === 'string' && error.data.trim()) {
        return error.data.trim();
    }

    if (error.status === 'FETCH_ERROR') {
        return 'Could not reach the server. Check your connection and try again.';
    }

    // Anything left: say the status rather than nothing, so a report about it
    // is worth something.
    return typeof error.status === 'number' ? `${fallback} (HTTP ${error.status})` : fallback;
};

/**
 * The refused body itself, for callers that need more than the message - the
 * early-finish confirmation reads `earlyFinish` and the round counts off it.
 */
export const serverPayload = (error) =>
    error && error.data && typeof error.data === 'object' ? error.data : null;

export default serverMessage;
