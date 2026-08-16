const UserService = require('../../server/services/UserService');
const db = require('../../server/db');

/**
 * ARCHON: deleting your account.
 *
 * Apple's Guideline 5.1.1(v) requires an app with account creation to offer
 * account deletion from inside the app, which is why the phone app grew a
 * screen for it. This covers what that screen calls, which had no tests at all
 * despite being the one irreversible thing a player can do to themselves.
 *
 * The design is anonymise-in-place rather than DELETE FROM "Users": a finished
 * game belongs to the opponent too, and a tournament's standings belong to the
 * event. Dropping the row would either cascade away other people's history or
 * fail on the foreign keys that do not cascade. So identity is erased and the
 * shared records keep an unnamed placeholder.
 *
 * Which makes the interesting question "what is still readable afterwards", and
 * that is what these assert.
 */
describe('account deletion', function () {
    let service;
    let statements;

    beforeEach(function () {
        statements = [];

        vi.spyOn(db, 'startTransaction').mockResolvedValue({ release: vi.fn() });
        vi.spyOn(db, 'queryTran').mockImplementation(async (client, sql, params) => {
            statements.push({ sql, params });

            return [];
        });

        service = new UserService({ getValue: () => undefined });
    });

    afterEach(function () {
        vi.restoreAllMocks();
    });

    /** The columns set to something by the UPDATE on "Users". */
    const usersUpdate = () => statements.find((entry) => entry.sql.includes('UPDATE "Users"')).sql;

    const deletedFrom = () =>
        statements
            .filter((entry) => entry.sql.startsWith('DELETE FROM'))
            .map((entry) => entry.sql.match(/DELETE FROM "([A-Za-z]+)"/)[1]);

    it('erases the identity the account was created with', async function () {
        await service.anonymizeUser({ id: 42 });

        const update = usersUpdate();

        expect(update).toContain('"Password" = NULL');
        expect(update).toContain('"Disabled" = true');
        expect(update).toContain('"Verified" = false');
    });

    it('renames and re-emails the account to an unroutable placeholder', async function () {
        const result = await service.anonymizeUser({ id: 42 });

        expect(result.username).toBe('deleted-user-42');
        // .invalid is reserved by RFC 2606 and can never be delivered to, so a
        // stray notification cannot reach the person who left.
        expect(result.email).toBe('deleted-user-42@example.invalid');
    });

    /**
     * The one that was actually wrong. PlayerProfileService selects Bio,
     * Country and State for the PUBLIC profile, and none of the three were
     * cleared - so `deleted-user-42` went on showing the biography and location
     * its owner wrote.
     */
    it('clears the personal fields the public profile renders', async function () {
        await service.anonymizeUser({ id: 42 });

        const update = usersUpdate();

        for (const column of ['Bio', 'Country', 'State']) {
            expect(update, `${column} survives deletion and is publicly visible`).toContain(
                `"${column}" = NULL`
            );
        }
    });

    it('destroys every credential the account held for a third party', async function () {
        await service.anonymizeUser({ id: 42 });

        const update = usersUpdate();

        // Live credentials for somebody else's account. These must not outlive
        // the person who authorised them.
        expect(update).toContain('"PatreonToken" = NULL');
        expect(update).toContain('"DokApiKey" = NULL');
        expect(update).toContain('"DokUsername" = NULL');
        expect(update).toContain('"DokAutoSync" = false');
    });

    it('clears the tokens that could re-open the account', async function () {
        await service.anonymizeUser({ id: 42 });

        const update = usersUpdate();

        expect(update).toContain('"ResetToken" = NULL');
        expect(update).toContain('"ActivationToken" = NULL');
        expect(deletedFrom()).toContain('RefreshToken');
    });

    it('drops the registration IP', async function () {
        await service.anonymizeUser({ id: 42 });

        expect(usersUpdate()).toContain('"RegisterIp" = NULL');
    });

    it('unlinks any SSO identity', async function () {
        // Not a takeover risk - the OIDC callback refuses a disabled account -
        // but leaving it bound the identity to the dead account forever, since
        // linkIdentity is ON CONFLICT DO NOTHING. Deleting your account then
        // cost you the ability to ever use SSO again.
        await service.anonymizeUser({ id: 42 });

        expect(deletedFrom()).toContain('UserOidcIdentities');
    });

    it("stops the account's devices receiving push", async function () {
        // The FK cascades on a real row delete, which never happens here.
        await service.anonymizeUser({ id: 42 });

        expect(deletedFrom()).toContain('PushTokens');
    });

    it('removes the chosen cosmetics', async function () {
        // A tombstone wearing somebody's old banner and accent colour is not
        // anonymous.
        await service.anonymizeUser({ id: 42 });

        expect(deletedFrom()).toContain('ProfileCosmetics');
    });

    it('removes notifications, which name other people', async function () {
        await service.anonymizeUser({ id: 42 });

        expect(deletedFrom()).toContain('Notifications');
    });

    it("takes the account out of everyone's friends list, in both directions", async function () {
        await service.anonymizeUser({ id: 42 });

        const friendships = statements.find((entry) => entry.sql.includes('"Friendships"'));

        expect(friendships).toBeTruthy();
        // A friendship is one row with two ends; matching only one would leave
        // half of them behind.
        expect(friendships.sql).toContain('"RequesterId"');
        expect(friendships.sql).toContain('"AddresseeId"');
    });

    it('does not touch games, decks, ratings or tournaments', async function () {
        // The deliberate half of the design: those records belong to opponents
        // and events as much as to the player, and a delete that reached them
        // would rewrite other people's history.
        await service.anonymizeUser({ id: 42 });

        for (const table of [
            'Games',
            'GamePlayers',
            'Decks',
            'Ratings',
            'RatingHistory',
            'TournamentPlayers',
            'TournamentMatches'
        ]) {
            expect(deletedFrom(), `${table} must survive deletion`).not.toContain(table);
        }
    });

    it('records when the account was deleted, distinctly from disabled', async function () {
        // "Disabled" means banned OR deleted, and every read path treats them
        // the same - correctly, for suppression. DeletedAt is what tells them
        // apart for the paths where the difference matters.
        await service.anonymizeUser({ id: 42 });

        expect(usersUpdate()).toContain('"DeletedAt" = now()');
    });

    it('does all of it in one transaction', async function () {
        // A half-deleted account is the worst outcome available: identity gone,
        // credentials live.
        await service.anonymizeUser({ id: 42 });

        expect(statements[statements.length - 1].sql).toBe('COMMIT');
    });

    it('rolls back and reports failure rather than half-deleting', async function () {
        db.queryTran.mockImplementation(async (client, sql) => {
            if (sql.includes('PushTokens')) {
                throw new Error('db down');
            }

            statements.push({ sql });

            return [];
        });

        await expect(service.anonymizeUser({ id: 42 })).rejects.toThrow('Failed to anonymize user');
        expect(statements.map((entry) => entry.sql)).toContain('ROLLBACK');
        expect(statements.map((entry) => entry.sql)).not.toContain('COMMIT');
    });

    it('scopes every statement to the one account', async function () {
        await service.anonymizeUser({ id: 42 });

        for (const entry of statements) {
            if (entry.params) {
                expect(entry.params).toContain(42);
            }
        }
    });
});
