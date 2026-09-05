const DirectMessageService = require('../../../../server/services/community/DirectMessageService');
const directMessageEvents = require('../../../../server/services/community/directMessageEvents');

/**
 * ARCHON: direct messages between two players.
 *
 * The service owns who may message whom (the block list both ways, a mute,
 * never yourself, never a deleted account), what a thread and an inbox look
 * like, and what "read" means. Delivery is the lobby's job and is tested
 * there; here the announcement is only checked to have been made.
 */
describe('DirectMessageService', function () {
    let db;
    let state;
    let service;
    let moderationService;
    let announced;

    const alice = { id: 1, username: 'alice' };
    const bob = { id: 2, username: 'bob' };

    const createFakeDb = () => {
        state = {
            users: [
                { Id: 1, Username: 'alice', Settings_Avatar: 'a', Disabled: false },
                { Id: 2, Username: 'bob', Settings_Avatar: 'b', Disabled: false },
                { Id: 3, Username: 'carol', Settings_Avatar: null, Disabled: false },
                { Id: 4, Username: 'gone', Settings_Avatar: null, Disabled: true }
            ],
            blocks: [],
            messages: [],
            nextId: 1
        };

        const pairOf = (row) => [
            Math.min(row.SenderId, row.RecipientId),
            Math.max(row.SenderId, row.RecipientId)
        ];

        return {
            query: vi.fn(async (sql, params = []) => {
                if (sql.includes('FROM "Users"') && sql.includes('lower("Username")')) {
                    return state.users.filter(
                        (user) => user.Username.toLowerCase() === String(params[0]).toLowerCase()
                    );
                }

                if (sql.includes('FROM "Users"') && sql.includes('ANY($1)')) {
                    return state.users.filter((user) => params[0].includes(user.Id));
                }

                if (sql.includes('FROM "Users"') && sql.includes('"Id" = $1')) {
                    return state.users.filter((user) => user.Id === params[0]);
                }

                if (sql.includes('FROM "BlockList"')) {
                    const [aId, bName, bId, aName] = params;

                    return state.blocks.some(
                        (block) =>
                            (block.UserId === aId &&
                                block.Entry.toLowerCase() === bName.toLowerCase()) ||
                            (block.UserId === bId &&
                                block.Entry.toLowerCase() === aName.toLowerCase())
                    )
                        ? [{ '?column?': 1 }]
                        : [];
                }

                if (sql.includes('INSERT INTO "DirectMessages"')) {
                    const row = {
                        Id: state.nextId++,
                        SenderId: params[0],
                        RecipientId: params[1],
                        Text: params[2],
                        MatchId: params[3],
                        SentAt: new Date(2026, 7, 20, 12, 0, state.nextId),
                        ReadAt: null
                    };

                    state.messages.push(row);

                    return [{ Id: row.Id, SentAt: row.SentAt }];
                }

                if (sql.includes('SELECT MAX("Id")')) {
                    const me = params[0];
                    const latestByPair = {};

                    for (const row of state.messages) {
                        if (row.SenderId !== me && row.RecipientId !== me) {
                            continue;
                        }

                        const key = pairOf(row).join(':');

                        if (!latestByPair[key] || latestByPair[key].Id < row.Id) {
                            latestByPair[key] = row;
                        }
                    }

                    return Object.values(latestByPair)
                        .sort((a, b) => b.Id - a.Id)
                        .map((row) => ({
                            ...row,
                            OtherId: row.SenderId === me ? row.RecipientId : row.SenderId
                        }));
                }

                if (sql.includes('COUNT(DISTINCT "SenderId")')) {
                    const unread = state.messages.filter(
                        (row) => row.RecipientId === params[0] && !row.ReadAt
                    );

                    return [
                        {
                            Unread: String(unread.length),
                            Senders: String(new Set(unread.map((row) => row.SenderId)).size)
                        }
                    ];
                }

                if (sql.includes('COUNT(*) AS "Unread"')) {
                    const counts = {};

                    for (const row of state.messages) {
                        if (row.RecipientId === params[0] && !row.ReadAt) {
                            counts[row.SenderId] = (counts[row.SenderId] || 0) + 1;
                        }
                    }

                    return Object.entries(counts).map(([SenderId, Unread]) => ({
                        SenderId: Number(SenderId),
                        Unread: String(Unread)
                    }));
                }

                if (sql.includes('FROM "DirectMessages"') && sql.includes('LEAST("SenderId"')) {
                    const [me, other, before] = params;
                    const limit = parseInt(sql.match(/LIMIT (\d+)/)[1], 10);

                    return state.messages
                        .filter((row) => {
                            const [low, high] = pairOf(row);

                            return (
                                low === Math.min(me, other) &&
                                high === Math.max(me, other) &&
                                (before === undefined || row.Id < before)
                            );
                        })
                        .sort((a, b) => b.Id - a.Id)
                        .slice(0, limit);
                }

                if (sql.includes('UPDATE "DirectMessages" SET "ReadAt"')) {
                    const updated = [];

                    for (const row of state.messages) {
                        if (
                            row.RecipientId === params[0] &&
                            row.SenderId === params[1] &&
                            !row.ReadAt
                        ) {
                            row.ReadAt = new Date();
                            updated.push({ Id: row.Id });
                        }
                    }

                    return updated;
                }

                throw new Error(`Unexpected SQL in fake: ${sql}`);
            })
        };
    };

    beforeEach(function () {
        db = createFakeDb();
        moderationService = { checkRestriction: vi.fn(async () => ({ allowed: true })) };
        service = new DirectMessageService(db, { moderationService });
        announced = [];
        directMessageEvents.on('sent', (payload) => announced.push(payload));
    });

    afterEach(function () {
        directMessageEvents.removeAllListeners('sent');
    });

    describe('sending', function () {
        it('writes the message and announces it', async function () {
            const result = await service.send(alice, 'bob', 'Can we play at 8 instead of 7?', {
                matchId: 42
            });

            expect(result.success, result.message).toBe(true);
            expect(result.message).toEqual(
                expect.objectContaining({
                    id: 1,
                    senderId: 1,
                    senderUsername: 'alice',
                    recipientId: 2,
                    recipientUsername: 'bob',
                    text: 'Can we play at 8 instead of 7?',
                    matchId: 42,
                    readAt: null
                })
            );
            expect(announced).toHaveLength(1);
            expect(announced[0].message.id).toBe(1);
        });

        it('finds the recipient case-insensitively', async function () {
            expect((await service.send(alice, 'BOB', 'hi')).success).toBe(true);
            expect(state.messages[0].RecipientId).toBe(2);
        });

        it('refuses an empty message', async function () {
            expect((await service.send(alice, 'bob', '   ')).success).toBe(false);
            expect(state.messages).toHaveLength(0);
        });

        it('refuses a message that is too long', async function () {
            const result = await service.send(alice, 'bob', 'x'.repeat(2001));

            expect(result.success).toBe(false);
            expect(result.message).toMatch(/at most 2000/);
        });

        it('refuses messaging yourself', async function () {
            const result = await service.send(alice, 'alice', 'hello me');

            expect(result.success).toBe(false);
            expect(result.message).toMatch(/yourself/);
        });

        it('refuses an unknown or deleted recipient', async function () {
            expect((await service.send(alice, 'nobody', 'hi')).message).toBe('No such player');
            expect((await service.send(alice, 'gone', 'hi')).message).toBe('No such player');
        });

        it('refuses when the recipient has blocked the sender', async function () {
            state.blocks.push({ UserId: 2, Entry: 'alice' });

            const result = await service.send(alice, 'bob', 'hi');

            expect(result.success).toBe(false);
            expect(result.message).toBe('You cannot message this player');
        });

        it('refuses when the sender has blocked the recipient, with the same words', async function () {
            state.blocks.push({ UserId: 1, Entry: 'Bob' });

            const result = await service.send(alice, 'bob', 'hi');

            expect(result.success).toBe(false);
            expect(result.message).toBe('You cannot message this player');
        });

        it('enforces a chat mute and passes the reason on', async function () {
            moderationService.checkRestriction.mockResolvedValue({
                allowed: false,
                reason: 'mute',
                message: 'You have been muted until tomorrow'
            });

            const result = await service.send(alice, 'bob', 'hi');

            expect(result.success).toBe(false);
            expect(result.message).toBe('You have been muted until tomorrow');
            expect(moderationService.checkRestriction).toHaveBeenCalledWith(1, 'chat');
            expect(state.messages).toHaveLength(0);
        });

        it('works without a moderation service', async function () {
            service = new DirectMessageService(db);

            expect((await service.send(alice, 'bob', 'hi')).success).toBe(true);
        });

        it('drops a match id that is not one', async function () {
            await service.send(alice, 'bob', 'hi', { matchId: 'abc' });

            expect(state.messages[0].MatchId).toBeNull();
        });

        it('does not announce a message that was not written', async function () {
            db.query.mockImplementationOnce(async (sql) => {
                if (sql.includes('FROM "Users"')) {
                    return [state.users[1]];
                }

                return [];
            });
            db.query.mockImplementationOnce(async () => []);
            db.query.mockImplementationOnce(async () => {
                throw new Error('disk full');
            });

            const result = await service.send(alice, 'bob', 'hi');

            expect(result.success).toBe(false);
            expect(announced).toHaveLength(0);
        });
    });

    describe('the inbox', function () {
        it('lists each conversation once, newest first, with unread counts', async function () {
            await service.send(alice, 'bob', 'first');
            await service.send(bob, 'alice', 'second');
            await service.send({ id: 3, username: 'carol' }, 'alice', 'hey alice');
            await service.send({ id: 3, username: 'carol' }, 'alice', 'you there?');

            const inbox = await service.conversations(1);

            expect(inbox.map((entry) => entry.username)).toEqual(['carol', 'bob']);
            expect(inbox[0]).toEqual(
                expect.objectContaining({
                    userId: 3,
                    unread: 2,
                    lastMessage: expect.objectContaining({ text: 'you there?', fromMe: false })
                })
            );
            expect(inbox[1]).toEqual(
                expect.objectContaining({
                    userId: 2,
                    avatar: 'b',
                    unread: 1,
                    lastMessage: expect.objectContaining({ text: 'second', fromMe: false })
                })
            );
        });

        it('shows what I sent as the last message when it is', async function () {
            await service.send(bob, 'alice', 'ping');
            await service.send(alice, 'bob', 'pong');

            const [entry] = await service.conversations(1);

            expect(entry.lastMessage.fromMe).toBe(true);
            expect(entry.unread).toBe(1);
        });

        it('is empty for somebody who has never messaged', async function () {
            expect(await service.conversations(3)).toEqual([]);
        });
    });

    describe('a thread', function () {
        beforeEach(async function () {
            await service.send(alice, 'bob', 'one');
            await service.send(bob, 'alice', 'two');
            await service.send(alice, 'bob', 'three');
            // Noise in another conversation.
            await service.send(alice, 'carol', 'not this one');
        });

        it('returns the pair’s messages oldest first, from either side', async function () {
            const fromAlice = await service.thread(1, 'bob');
            const fromBob = await service.thread(2, 'alice');

            expect(fromAlice.success).toBe(true);
            expect(fromAlice.messages.map((m) => m.text)).toEqual(['one', 'two', 'three']);
            expect(fromAlice.messages.map((m) => m.fromMe)).toEqual([true, false, true]);
            expect(fromBob.messages.map((m) => m.fromMe)).toEqual([false, true, false]);
            expect(fromAlice.other).toEqual({ userId: 2, username: 'bob', avatar: 'b' });
        });

        it('pages backwards with before', async function () {
            const latest = await service.thread(1, 'bob', { limit: 2 });

            expect(latest.messages.map((m) => m.text)).toEqual(['two', 'three']);
            expect(latest.hasMore).toBe(true);

            const earlier = await service.thread(1, 'bob', {
                limit: 2,
                before: latest.messages[0].id
            });

            expect(earlier.messages.map((m) => m.text)).toEqual(['one']);
            expect(earlier.hasMore).toBe(false);
        });

        it('says whether a reply is possible', async function () {
            expect((await service.thread(1, 'bob')).canMessage).toBe(true);

            state.blocks.push({ UserId: 2, Entry: 'alice' });

            expect((await service.thread(1, 'bob')).canMessage).toBe(false);
        });

        it('names a deleted account without exposing it', async function () {
            const result = await service.thread(1, 'gone');

            expect(result.success).toBe(true);
            expect(result.other.username).toBe('Deleted user');
            expect(result.canMessage).toBe(false);
        });

        it('refuses an unknown player', async function () {
            expect((await service.thread(1, 'nobody')).success).toBe(false);
        });
    });

    describe('reading', function () {
        it('marks only that sender’s messages to me as read', async function () {
            await service.send(bob, 'alice', 'one');
            await service.send({ id: 3, username: 'carol' }, 'alice', 'two');
            await service.send(alice, 'bob', 'three');

            expect(await service.unreadCount(1)).toEqual({ unread: 2, senders: 2 });

            const result = await service.markRead(1, 'bob');

            expect(result).toEqual({ success: true, updated: 1 });
            expect(await service.unreadCount(1)).toEqual({ unread: 1, senders: 1 });
            // Bob's own unread (alice's 'three') is untouched.
            expect(await service.unreadCount(2)).toEqual({ unread: 1, senders: 1 });
        });

        it('is a no-op the second time', async function () {
            await service.send(bob, 'alice', 'one');
            await service.markRead(1, 'bob');

            expect((await service.markRead(1, 'bob')).updated).toBe(0);
        });
    });
});
