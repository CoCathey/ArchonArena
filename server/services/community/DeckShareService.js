const logger = require('../../log');

/**
 * ARCHON: lending a deck to a friend.
 *
 * ## Why this is an offer rather than a copy
 *
 * The deck ends up in somebody else's collection, and a collection is theirs.
 * So sharing creates an OFFER; the friend accepts or declines, and only an
 * accept writes anything into their decks. That also gives the lender a share
 * they can revoke, which a link they have already sent does not.
 *
 * ## Why a copy rather than a reference
 *
 * A borrowed deck has to behave like a deck: it is selected in the lobby, put
 * into events, and read by the deck page, all of which take a "Decks" row that
 * belongs to the player holding it. A reference would mean every one of those
 * paths learning about a second kind of deck. The copy carries
 * "SharedFromUserId" so it can still be told apart - that is what the badge
 * reads, and it is what an event with an ownership rule would check.
 *
 * The copy is made from the rows we already have rather than by re-importing
 * from Master Vault: the cards are identical by definition, and an import would
 * spend the site's rate limit re-fetching a deck it already holds.
 *
 * ## Why the statistics take care of themselves
 *
 * Both copies carry the same Uuid, and games record that uuid, so the friend's
 * games land in the deck's pooled record with no further work. That is the
 * whole reason the pooled record is keyed on the uuid rather than on a row.
 */
class DeckShareService {
    constructor(db = require('../../db'), { notificationService = null } = {}) {
        this.db = db;
        this.notificationService = notificationService;
    }

    async areFriends(userIdA, userIdB) {
        const rows = await this.db.query(
            'SELECT 1 FROM "Friendships" WHERE "Status" = \'accepted\' AND ' +
                '(("RequesterId" = $1 AND "AddresseeId" = $2) OR ' +
                ' ("RequesterId" = $2 AND "AddresseeId" = $1))',
            [userIdA, userIdB]
        );

        return !!(rows && rows.length);
    }

    async findUserByUsername(username) {
        const rows = await this.db.query(
            'SELECT "Id", "Username" FROM "Users" WHERE lower("Username") = lower($1)',
            [username]
        );

        return rows && rows[0];
    }

    /**
     * Offer a deck to a friend.
     *
     * Every refusal names its reason, because "could not share" is useless to
     * someone who cannot see the rules.
     */
    async share(fromUser, deckId, toUsername) {
        const deck = (
            await this.db.query(
                'SELECT "Id", "Uuid", "Name", "UserId", "IsAlliance" FROM "Decks" WHERE "Id" = $1',
                [deckId]
            )
        )[0];

        if (!deck) {
            return { ok: false, reason: 'no-such-deck', message: 'No such deck' };
        }

        if (deck.UserId !== fromUser.id) {
            return { ok: false, reason: 'not-yours', message: 'That is not your deck' };
        }

        const to = await this.findUserByUsername(toUsername);

        if (!to) {
            return { ok: false, reason: 'no-such-user', message: 'No such player' };
        }

        if (to.Id === fromUser.id) {
            return {
                ok: false,
                reason: 'self',
                message: 'You already have that deck'
            };
        }

        if (!(await this.areFriends(fromUser.id, to.Id))) {
            return {
                ok: false,
                reason: 'not-friends',
                message: 'You can only lend decks to friends'
            };
        }

        // "Decks" is unique on ("Identity","UserId"), so a friend who already
        // holds this deck cannot take a second copy. Saying so is far better
        // than letting the accept fail later on a constraint they cannot see.
        const already = await this.db.query(
            'SELECT 1 FROM "Decks" WHERE "UserId" = $1 AND "Identity" = $2',
            [to.Id, deck.Name]
        );

        if (already && already.length) {
            return {
                ok: false,
                reason: 'already-has-it',
                message: `${to.Username} already has that deck`
            };
        }

        let row;

        try {
            row = (
                await this.db.query(
                    'INSERT INTO "DeckShares" ("DeckId", "FromUserId", "ToUserId") ' +
                        'VALUES ($1, $2, $3) RETURNING "Id"',
                    [deck.Id, fromUser.id, to.Id]
                )
            )[0];
        } catch (err) {
            // The partial unique index. A second offer of the same deck to the
            // same person is not an error worth a 500.
            if (err && err.code === '23505') {
                return {
                    ok: false,
                    reason: 'already-offered',
                    message: `You have already offered that deck to ${to.Username}`
                };
            }

            logger.error('Failed to share deck', err);

            throw err;
        }

        await this.notify({
            userId: to.Id,
            category: 'deck.shared',
            title: `${fromUser.username} shared a deck with you`,
            body: `${fromUser.username} has offered to lend you ${deck.Name}.`,
            url: '/decks',
            data: { shareId: row.Id, deckName: deck.Name, from: fromUser.username }
        });

        return { ok: true, shareId: row.Id, to: to.Username, deckName: deck.Name };
    }

    /** Offers waiting on this player, and offers they have made. */
    async overview(userId) {
        const incoming = await this.db.query(
            'SELECT s."Id", s."Status", s."CreatedAt", d."Name" AS "DeckName", ' +
                '  d."Uuid" AS "DeckUuid", d."Id" AS "DeckId", u."Username" AS "FromUsername", ' +
                '  ds."SasRating" ' +
                'FROM "DeckShares" s ' +
                'JOIN "Decks" d ON d."Id" = s."DeckId" ' +
                'JOIN "Users" u ON u."Id" = s."FromUserId" ' +
                'LEFT JOIN "DeckSas" ds ON ds."Uuid" = d."Uuid" ' +
                'WHERE s."ToUserId" = $1 AND s."Status" = \'pending\' ' +
                'ORDER BY s."CreatedAt" DESC',
            [userId]
        );

        const outgoing = await this.db.query(
            'SELECT s."Id", s."Status", s."CreatedAt", s."RespondedAt", d."Name" AS "DeckName", ' +
                '  d."Id" AS "DeckId", u."Username" AS "ToUsername" ' +
                'FROM "DeckShares" s ' +
                'JOIN "Decks" d ON d."Id" = s."DeckId" ' +
                'JOIN "Users" u ON u."Id" = s."ToUserId" ' +
                'WHERE s."FromUserId" = $1 AND s."Status" IN (\'pending\', \'accepted\') ' +
                'ORDER BY s."CreatedAt" DESC',
            [userId]
        );

        return {
            incoming: (incoming || []).map((row) => ({
                id: row.Id,
                deckId: row.DeckId,
                deckName: row.DeckName,
                deckUuid: row.DeckUuid,
                sasRating: row.SasRating,
                from: row.FromUsername,
                createdAt: row.CreatedAt
            })),
            outgoing: (outgoing || []).map((row) => ({
                id: row.Id,
                deckId: row.DeckId,
                deckName: row.DeckName,
                to: row.ToUsername,
                status: row.Status,
                createdAt: row.CreatedAt,
                respondedAt: row.RespondedAt
            }))
        };
    }

    async pendingFor(shareId, userId) {
        const rows = await this.db.query(
            'SELECT s.*, d."Name" AS "DeckName", u."Username" AS "FromUsername" ' +
                'FROM "DeckShares" s ' +
                'JOIN "Decks" d ON d."Id" = s."DeckId" ' +
                'JOIN "Users" u ON u."Id" = s."FromUserId" ' +
                'WHERE s."Id" = $1 AND s."ToUserId" = $2 AND s."Status" = \'pending\'',
            [shareId, userId]
        );

        return rows && rows[0];
    }

    /**
     * Accept an offer: copy the deck into the recipient's collection.
     *
     * One transaction, because a half-copied deck - a "Decks" row with no cards,
     * or cards with no houses - is worse than a failed accept: it shows up in
     * the deck list as something the player cannot play and cannot explain.
     */
    async accept(user, shareId) {
        const share = await this.pendingFor(shareId, user.id);

        if (!share) {
            return { ok: false, reason: 'no-such-offer', message: 'That offer is no longer open' };
        }

        const already = await this.db.query(
            'SELECT 1 FROM "Decks" WHERE "UserId" = $1 AND "Identity" = $2',
            [user.id, share.DeckName]
        );

        if (already && already.length) {
            return {
                ok: false,
                reason: 'already-has-it',
                message: 'You already have that deck'
            };
        }

        let newDeckId;

        // ARCHON: a real transaction client, not BEGIN on the pool. The pool
        // hands out a connection per query, so a bare BEGIN can open a
        // transaction on one connection and COMMIT on another - which reads as
        // working right up until it does not, and the failure mode here is a
        // "Decks" row with no cards sitting in somebody's collection.
        const client = await this.db.startTransaction();

        try {
            newDeckId = (
                await this.db.queryTran(
                    client,
                    'INSERT INTO "Decks" ' +
                        '("UserId", "Uuid", "Identity", "Name", "Banned", "IncludeInSealed", ' +
                        ' "LastUpdated", "Verified", "ExpansionId", "Flagged", "IsAlliance", ' +
                        ' "AlliancePods", "SharedFromUserId") ' +
                        'SELECT $1, "Uuid", "Identity", "Name", "Banned", "IncludeInSealed", ' +
                        '  (now() AT TIME ZONE \'utc\'), false, "ExpansionId", false, "IsAlliance", ' +
                        // Verified is deliberately NOT copied: verification is a
                        // moderator's judgement about one player's deck, not a
                        // property of the cards, so a borrowed copy starts
                        // unverified like any other import.
                        '  "AlliancePods", $3 ' +
                        'FROM "Decks" WHERE "Id" = $2 RETURNING "Id"',
                    [user.id, share.DeckId, share.FromUserId]
                )
            )[0].Id;

            await this.db.queryTran(
                client,
                'INSERT INTO "DeckCards" ' +
                    '("CardId", "Count", "Maverick", "Anomaly", "ImageUrl", "HouseId", ' +
                    ' "Enhancements", "IsNonDeck", "ProphecyId", "DeckId") ' +
                    'SELECT "CardId", "Count", "Maverick", "Anomaly", "ImageUrl", "HouseId", ' +
                    '  "Enhancements", "IsNonDeck", "ProphecyId", $1 ' +
                    'FROM "DeckCards" WHERE "DeckId" = $2',
                [newDeckId, share.DeckId]
            );

            await this.db.queryTran(
                client,
                'INSERT INTO "DeckHouses" ("DeckId", "HouseId") ' +
                    'SELECT $1, "HouseId" FROM "DeckHouses" WHERE "DeckId" = $2',
                [newDeckId, share.DeckId]
            );

            await this.db.queryTran(
                client,
                'UPDATE "DeckShares" SET "Status" = \'accepted\', ' +
                    '"AcceptedDeckId" = $2, "RespondedAt" = (now() AT TIME ZONE \'utc\') ' +
                    'WHERE "Id" = $1',
                [shareId, newDeckId]
            );

            await this.db.queryTran(client, 'COMMIT');
        } catch (err) {
            await this.db.queryTran(client, 'ROLLBACK');
            logger.error('Failed to accept deck share', err);

            throw err;
        } finally {
            if (client.release) {
                client.release();
            }
        }

        // ARCHON: games this account already played with the deck - it may have
        // held and deleted a copy before - belong to the copy it holds now.
        // Same rule as re-importing, for the same reason.
        if (share.Uuid) {
            await this.db.query(
                'UPDATE "GamePlayers" SET "DeckId" = $1 ' +
                    'WHERE "PlayerId" = $2 AND "DeckId" IS NULL AND "DeckUuid" = $3',
                [newDeckId, user.id, share.Uuid]
            );
        }

        await this.notify({
            userId: share.FromUserId,
            category: 'deck.share.accepted',
            title: `${user.username} took you up on a deck`,
            body: `${user.username} accepted ${share.DeckName}. Their games with it count towards the deck's record.`,
            url: '/decks',
            data: { deckName: share.DeckName, by: user.username }
        });

        return { ok: true, deckId: newDeckId, deckName: share.DeckName };
    }

    async decline(user, shareId) {
        const share = await this.pendingFor(shareId, user.id);

        if (!share) {
            return { ok: false, reason: 'no-such-offer', message: 'That offer is no longer open' };
        }

        await this.db.query(
            'UPDATE "DeckShares" SET "Status" = \'declined\', ' +
                '"RespondedAt" = (now() AT TIME ZONE \'utc\') WHERE "Id" = $1',
            [shareId]
        );

        // The lender is not told. A decline is a small no, and a notification
        // saying "they did not want your deck" makes it a large one.
        return { ok: true };
    }

    /**
     * Withdraw an offer.
     *
     * Only a PENDING offer can be withdrawn. Once a friend has accepted, the
     * copy is a deck in their collection: it has its own games and may be in an
     * event, and reaching in to delete it is not a thing a lender gets to do.
     */
    async revoke(user, shareId) {
        const rows = await this.db.query(
            'SELECT * FROM "DeckShares" WHERE "Id" = $1 AND "FromUserId" = $2',
            [shareId, user.id]
        );
        const share = rows && rows[0];

        if (!share) {
            return { ok: false, reason: 'no-such-offer', message: 'No such offer' };
        }

        if (share.Status === 'accepted') {
            return {
                ok: false,
                reason: 'already-accepted',
                message: 'They have already added that deck. It is theirs now.'
            };
        }

        if (share.Status !== 'pending') {
            return { ok: false, reason: 'not-pending', message: 'That offer is already closed' };
        }

        await this.db.query(
            'UPDATE "DeckShares" SET "Status" = \'revoked\', ' +
                '"RespondedAt" = (now() AT TIME ZONE \'utc\') WHERE "Id" = $1',
            [shareId]
        );

        return { ok: true };
    }

    /** Never lets a notification failure break the operation that raised it. */
    async notify(event) {
        if (!this.notificationService) {
            return;
        }

        try {
            await this.notificationService.notify(event);
        } catch (err) {
            logger.error('Failed to send deck share notification', err);
        }
    }
}

module.exports = DeckShareService;
