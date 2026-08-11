const { clubJoinOutcome } = require('../../client/Components/Community/clubJoinOutcome');

/**
 * ARCHON: what a player is told after trying to join a club.
 *
 * The interesting case is the one that reads like success and is not: a club
 * with an approval policy files a request and admits nobody. Three call sites
 * used to decide this independently and two of them got it wrong, so the
 * decision lives in one function and is checked here.
 */
describe('clubJoinOutcome', function () {
    it('reports an ordinary join as joined, with the club name', function () {
        const outcome = clubJoinOutcome({ success: true, id: 3, name: 'Austin Archons' });

        expect(outcome).toMatchObject({ ok: true, pending: false, name: 'Austin Archons' });
        expect(outcome.key).toBe('Joined {{name}}');
    });

    // The whole point: "Joined" here would send the player away believing they
    // are in a club that has not admitted them.
    it('never says joined when the club is holding the join for approval', function () {
        const outcome = clubJoinOutcome({
            success: true,
            id: 3,
            name: 'Austin Archons',
            pending: true
        });

        expect(outcome).toMatchObject({ ok: true, pending: true });
        expect(outcome.key).not.toMatch(/^Joined/);
        expect(outcome.key).toMatch(/approve/);
    });

    // The club page knows the club it is on; join-by-code does not, and the
    // reply carries the name instead. Both have to produce a usable sentence.
    it('takes the name from the reply, or from the caller when the reply has none', function () {
        expect(clubJoinOutcome({ success: true, pending: false }, 'Dallas Dis').name).toBe(
            'Dallas Dis'
        );
        expect(clubJoinOutcome({ success: true, name: 'From Reply' }, 'From Caller').name).toBe(
            'From Reply'
        );
    });

    it('falls back to a nameless message rather than an empty one', function () {
        expect(clubJoinOutcome({ success: true }).key).toBe('Joined the club');
        expect(clubJoinOutcome({ success: true, pending: true }).key).toMatch(/^Request sent/);
    });

    it('passes the server reason through on failure', function () {
        const outcome = clubJoinOutcome({
            success: false,
            message: 'No club matches that join code'
        });

        expect(outcome.ok).toBe(false);
        expect(outcome.key).toBe('No club matches that join code');
    });

    // A rejected request can arrive as a thrown error whose body never reaches
    // here, so undefined must not become "Joined".
    it('treats a missing or malformed reply as a failure', function () {
        expect(clubJoinOutcome(undefined).ok).toBe(false);
        expect(clubJoinOutcome({}).ok).toBe(false);
        expect(clubJoinOutcome(undefined).key).toBe('Could not join club');
    });
});
