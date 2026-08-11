/**
 * What to tell a player after they try to join a club.
 *
 * This is a shared function rather than a line of JSX in each page because a
 * club whose join policy is `approval` does not join anyone: it files a request
 * and waits for the owner. Saying "Joined" there is wrong in the way that
 * matters - the player closes the tab believing they are in, and nothing tells
 * them otherwise until they notice they never were.
 *
 * The callers reach that fact by different routes, which is how they came to
 * disagree: the club page knows the club and reads `joinPolicy === 'approval'`;
 * onboarding's search list had the flag on the response and ignored it; and
 * anyone arriving with only an invite code has no club to read at all, so the
 * server has to say so. One function, so the next caller cannot invent another
 * answer.
 *
 * It returns a translation key rather than a sentence, so the message is still
 * translated where it is shown.
 *
 * @param {object} result - the server's reply to a join or join-by-code
 * @param {string} [name] - the club's name, when the caller knows it and the
 *   reply does not carry one
 * @returns {{ ok: boolean, pending: boolean, name: string, key: string }}
 */
export function clubJoinOutcome(result, name) {
    const clubName = result?.name || name || '';

    if (!result?.success) {
        return {
            ok: false,
            pending: false,
            name: clubName,
            key: result?.message || 'Could not join club'
        };
    }

    if (result.pending) {
        return {
            ok: true,
            pending: true,
            name: clubName,
            key: clubName
                ? 'Asked to join {{name}} - the owner still has to approve it'
                : 'Request sent - the owner still has to approve it'
        };
    }

    return {
        ok: true,
        pending: false,
        name: clubName,
        key: clubName ? 'Joined {{name}}' : 'Joined the club'
    };
}
