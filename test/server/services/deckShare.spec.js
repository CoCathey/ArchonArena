const DeckShareService = require('../../../server/services/community/DeckShareService');

/**
 * ARCHON: lending a deck to a friend.
 *
 * The rules are the whole feature: it goes to a friend, it is an offer rather
 * than a write into their collection, and once accepted it is theirs. Each of
 * those is a refusal somebody will hit, so each is named rather than collapsed
 * into "could not share".
 */
describe('DeckShareService', function () {
    let db;
    let notifications;
    let service;
    let state;

    const alice = { id: 1, username: 'alice' };
    const bob = { id: 2, username: 'bob' };

    beforeEach(function () {
        state = {
            deck: { Id: 7, Uuid: 'uuid-1', Name: 'Test Deck', UserId: 1, IsAlliance: false },
            friends: true,
            recipient: { Id: 2, Username: 'bob' },
            recipientHasIt: false,
            insertFails: null,
            pendingShare: null
        };
        notifications = [];

        db = {
            query: vi.fn(async (sql, params) => {
                if (/FROM "Decks" WHERE "Id" = \$1/.test(sql)) {
                    return state.deck ? [state.deck] : [];
                }

                if (/FROM "Users" WHERE lower/.test(sql)) {
                    return state.recipient &&
                        state.recipient.Username.toLowerCase() === String(params[0]).toLowerCase()
                        ? [state.recipient]
                        : [];
                }

                if (/FROM "Friendships"/.test(sql)) {
                    return state.friends ? [{ ok: 1 }] : [];
                }

                if (/FROM "Decks" WHERE "UserId" = \$1 AND "Identity" = \$2/.test(sql)) {
                    return state.recipientHasIt ? [{ ok: 1 }] : [];
                }

                if (/INSERT INTO "DeckShares"/.test(sql)) {
                    if (state.insertFails) {
                        throw state.insertFails;
                    }

                    return [{ Id: 55 }];
                }

                if (/FROM "DeckShares" s/.test(sql)) {
                    return state.pendingShare ? [state.pendingShare] : [];
                }

                if (/FROM "DeckShares" WHERE "Id"/.test(sql)) {
                    return state.pendingShare ? [state.pendingShare] : [];
                }

                if (/INSERT INTO "Decks"/.test(sql)) {
                    return [{ Id: 99 }];
                }

                return [];
            })
        };

        // The accept runs on a dedicated transaction client rather than on the
        // pool, so the fake has to offer one: a bare BEGIN on a pool can open a
        // transaction on one connection and COMMIT on another.
        db.startTransaction = vi.fn(async () => ({ release: vi.fn() }));
        db.queryTran = vi.fn(async (client, sql, params) => db.query(sql, params));

        service = new DeckShareService(db, {
            notificationService: { notify: async (event) => notifications.push(event) }
        });
    });

    // queryTran delegates to query, so every statement lands in one place
    // whichever connection it was issued on.
    const sqlMatching = (pattern) =>
        db.query.mock.calls.map((call) => call[0]).filter((sql) => pattern.test(sql));

    describe('who may lend what to whom', function () {
        it('refuses a deck you do not own', async function () {
            state.deck.UserId = 999;

            expect((await service.share(alice, 7, 'bob')).reason).toBe('not-yours');
        });

        it('refuses somebody who is not a friend', async function () {
            state.friends = false;

            const result = await service.share(alice, 7, 'bob');

            expect(result.reason).toBe('not-friends');
            expect(result.message).toContain('friends');
        });

        it('refuses yourself', async function () {
            state.recipient = { Id: 1, Username: 'alice' };

            expect((await service.share(alice, 7, 'alice')).reason).toBe('self');
        });

        it('refuses a player who does not exist', async function () {
            state.recipient = null;

            expect((await service.share(alice, 7, 'nobody')).reason).toBe('no-such-user');
        });

        it('says so when they already have the deck', async function () {
            state.recipientHasIt = true;

            const result = await service.share(alice, 7, 'bob');

            // Rather than letting the accept fail later on a unique index the
            // player cannot see.
            expect(result.reason).toBe('already-has-it');
            expect(result.message).toContain('bob');
        });

        it('turns a duplicate offer into an answer, not a 500', async function () {
            const duplicate = new Error('duplicate key');
            duplicate.code = '23505';
            state.insertFails = duplicate;

            expect((await service.share(alice, 7, 'bob')).reason).toBe('already-offered');
        });
    });

    describe('the offer', function () {
        it('writes nothing into the recipient collection', async function () {
            const result = await service.share(alice, 7, 'bob');

            expect(result.ok).toBe(true);
            // The offer row, and nothing that copies a deck.
            expect(sqlMatching(/INSERT INTO "DeckShares"/)).toHaveLength(1);
            expect(sqlMatching(/INSERT INTO "Decks"/)).toHaveLength(0);
            expect(sqlMatching(/INSERT INTO "DeckCards"/)).toHaveLength(0);
        });

        it('tells the friend it is waiting for them', async function () {
            await service.share(alice, 7, 'bob');

            expect(notifications[0]).toMatchObject({ userId: 2, category: 'deck.shared' });
            expect(notifications[0].body).toContain('Test Deck');
        });
    });

    describe('accepting', function () {
        beforeEach(function () {
            state.pendingShare = {
                Id: 55,
                DeckId: 7,
                FromUserId: 1,
                ToUserId: 2,
                Status: 'pending',
                Uuid: 'uuid-1',
                DeckName: 'Test Deck',
                FromUsername: 'alice'
            };
        });

        it('copies the deck, its cards and its houses', async function () {
            const result = await service.accept(bob, 55);

            expect(result.ok).toBe(true);
            expect(sqlMatching(/INSERT INTO "Decks"/)).toHaveLength(1);
            expect(sqlMatching(/INSERT INTO "DeckCards"/)).toHaveLength(1);
            expect(sqlMatching(/INSERT INTO "DeckHouses"/)).toHaveLength(1);
        });

        it('marks the copy as a loan', async function () {
            await service.accept(bob, 55);

            expect(sqlMatching(/INSERT INTO "Decks"/)[0]).toContain('"SharedFromUserId"');
        });

        it("does not copy the lender's verification", async function () {
            await service.accept(bob, 55);

            // Verification is a moderator's judgement about one player's deck,
            // not a property of the cards.
            expect(sqlMatching(/INSERT INTO "Decks"/)[0]).toMatch(/false, "ExpansionId"/);
        });

        it('is one transaction on one connection, and gives it back', async function () {
            // A half-copied deck - a "Decks" row with no cards - is worse than a
            // failed accept: it shows up in the collection as something the
            // player can neither play nor explain.
            await service.accept(bob, 55);

            expect(db.startTransaction).toHaveBeenCalled();
            expect(db.queryTran.mock.calls.map((call) => call[1])).toContain('COMMIT');
            // Every copy statement goes through the transaction client, not the
            // pool - a single one left on `query` would land outside it.
            expect(sqlMatching(/INSERT INTO "Deck(s|Cards|Houses)"/).length).toBe(
                db.queryTran.mock.calls.filter((call) => /INSERT INTO "Deck/.test(call[1])).length
            );

            const client = await db.startTransaction.mock.results[0].value;
            expect(client.release).toHaveBeenCalled();
        });

        it('adopts games this account already played with the deck', async function () {
            await service.accept(bob, 55);

            const relink = sqlMatching(/UPDATE "GamePlayers" SET "DeckId"/);

            expect(relink).toHaveLength(1);
            expect(relink[0]).toContain('"DeckUuid" = $3');
        });

        it('tells the lender', async function () {
            await service.accept(bob, 55);

            expect(notifications.pop()).toMatchObject({
                userId: 1,
                category: 'deck.share.accepted'
            });
        });

        it('cannot be done twice', async function () {
            state.pendingShare = null;

            expect((await service.accept(bob, 55)).reason).toBe('no-such-offer');
        });
    });

    describe('withdrawing', function () {
        it('works while the offer is open', async function () {
            state.pendingShare = { Id: 55, FromUserId: 1, Status: 'pending' };

            expect((await service.revoke(alice, 55)).ok).toBe(true);
        });

        it('does not reach into a collection once they have accepted', async function () {
            // The copy is a deck of theirs by then: it has its own games and
            // may be in an event.
            state.pendingShare = { Id: 55, FromUserId: 1, Status: 'accepted' };

            const result = await service.revoke(alice, 55);

            expect(result.reason).toBe('already-accepted');
            expect(sqlMatching(/DELETE FROM "Decks"/)).toHaveLength(0);
        });
    });

    describe('declining', function () {
        it('closes the offer without telling the lender', async function () {
            state.pendingShare = { Id: 55, FromUserId: 1, ToUserId: 2, Status: 'pending' };

            expect((await service.decline(bob, 55)).ok).toBe(true);
            // A decline is a small no. A notification would make it a large one.
            expect(notifications).toHaveLength(0);
        });
    });
});
