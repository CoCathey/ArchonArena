/**
 * Why a replay could not be shown, in words the reader can act on.
 *
 * The page used to say "No replay is available for this game" for every cause:
 * a game played before recording existed, a capture that blew the size limit,
 * a site with recording switched off, a deployment whose replay table was never
 * created, and - since replays became your-games-only - somebody else's game.
 * Each of those has a different next step, and the reader was told none of them.
 *
 * Returns an i18n key so the sentence is still translated where it is shown.
 *
 * @param {object} error the RTK Query error, whose `data` carries the reason
 * @returns {{ key: string, isOwnershipProblem: boolean }}
 */
export function replayUnavailable(error) {
    const reason = error?.data?.reason;

    switch (reason) {
        case 'not-your-game':
            return {
                key: 'You can only watch replays of your own games.',
                isOwnershipProblem: true
            };
        case 'recording-disabled':
            return {
                key: 'Replay recording is switched off for this site, so this game was not recorded.',
                isOwnershipProblem: false
            };
        case 'storage-missing':
            // An operator problem rather than a player one, and it means every
            // replay on the site is missing - worth saying plainly rather than
            // letting each player conclude the feature is broken for them.
            return {
                key: 'Replays are not set up on this server yet. Nothing was recorded - let an administrator know.',
                isOwnershipProblem: false
            };
        case 'no-such-game':
            return { key: 'That game does not exist.', isOwnershipProblem: false };
        case 'not-recorded':
            return {
                key: 'This game was not recorded. Games played before replays were switched on, and games too large to store, have no replay.',
                isOwnershipProblem: false
            };
        default:
            return { key: 'No replay is available for this game.', isOwnershipProblem: false };
    }
}
