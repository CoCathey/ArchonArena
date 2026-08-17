const Settings = require('../settings');
// ARCHON (N12): the single authority on premium access. See its header for why
// the admin override lives there and nowhere else.
const { resolveEntitlements } = require('../services/membership/entitlements');
const { publicBadge } = require('../services/membership/publicBadge');
// ARCHON (N12): profile cosmetics ride along with the user so a lobby seat
// shows them without a second lookup per player.
const { publicCosmetics: cosmeticsFor } = require('../services/membership/cosmetics');

class User {
    constructor(userData) {
        this.userData = userData;
        this.invalidDecks = undefined;
    }

    get id() {
        return this.userData.id;
    }

    get disabled() {
        return this.userData.disabled;
    }

    get username() {
        return this.userData.username;
    }

    get tokens() {
        return this.userData.tokens;
    }

    get activationToken() {
        return this.userData.activationToken;
    }

    get activationTokenExpiry() {
        return this.userData.activationTokenExpiry;
    }

    get resetToken() {
        return this.userData.resetToken;
    }

    get tokenExpires() {
        return this.userData.tokenExpires;
    }

    get blockList() {
        return this.userData.blockList || [];
    }

    set blockList(value) {
        this.userData.blockList = value;
    }

    get password() {
        return this.userData.password;
    }

    get permissions() {
        return this.userData.permissions || [];
    }

    get email() {
        return this.userData.email;
    }

    get verified() {
        return this.userData.verified;
    }

    get registered() {
        return this.userData.registered;
    }

    get isAdmin() {
        return this.userData.permissions && this.userData.permissions.isAdmin;
    }

    get isWinner() {
        return this.userData.permissions && this.userData.permissions.isWinner;
    }

    get isPreviousWinner() {
        return this.userData.permissions && this.userData.permissions.isPreviousWinner;
    }

    get keepsSupporter() {
        return this.userData.permissions && this.userData.permissions.keepsSupporterWithNoPatreon;
    }

    get isContributor() {
        return this.userData.permissions && this.userData.permissions.isContributor;
    }

    get isSupporter() {
        return this.userData.permissions && this.userData.permissions.isSupporter;
    }

    /**
     * ARCHON (N12): what other people see next to this account's name.
     *
     * `isSupporter` above is the legacy Roles-table flag, granted by hand. The
     * Supporter tier sells "show your support next to your name", and paying on
     * Patreon does not touch that table - so every Patreon member was buying a
     * badge that nobody, including them, could see.
     *
     * Resolved through `publicBadge` rather than here, so the badge on a lobby
     * seat, in chat, on a leaderboard row and on a profile all come from one
     * function. Note it does NOT apply the admin override: see publicBadge.
     */
    get publicBadge() {
        return publicBadge({
            permissions: this.userData.permissions || {},
            membership: this.userData.membership,
            // ARCHON (N12): the cosmetic slots this account has chosen. Filtered
            // against the same entitlements the tier comes from inside
            // publicBadge, so a lapsed membership stops rendering its nameplate
            // on exactly the day it stops unlocking features.
            cosmetics: this.userData.cosmetics,
            // ARCHON (N20): the New pill for fresh accounts.
            registered: this.userData.registered
        });
    }

    get role() {
        return this.publicBadge.role;
    }

    /** The tier id other people may see, or 'free'. */
    get publicTier() {
        return this.publicBadge.tier;
    }

    get avatar() {
        return this.userData && this.userData.settings && this.userData.settings.avatar;
    }

    get patreon() {
        return this.userData.patreon;
    }

    set patreon(value) {
        this.userData.patreon = value;
    }

    block(otherUser) {
        this.userData.blockList = this.userData.blockList || [];
        this.userData.blockList.push(otherUser.username.toLowerCase());
    }

    hasUserBlocked(otherUser) {
        return this.blockList.includes(otherUser.username.toLowerCase());
    }

    /** ARCHON (N12): the Memberships row, loaded alongside roles. */
    get membership() {
        return this.userData.membership;
    }

    set membership(value) {
        this.userData.membership = value;
    }

    /**
     * ARCHON (N12): what this account may use, resolved from its roles and its
     * membership.
     *
     * Computed here rather than by each caller because every path that hands a
     * user to the client goes through getWireSafeDetails - login, checkauth,
     * the OIDC callback, the lobby socket handshake. Putting it here means all
     * of them agree, including the admin override, and none of them had to be
     * found and changed.
     *
     * Synchronous on purpose: `resolveEntitlements` is pure, and the membership
     * row it needs is loaded with the roles in
     * UserService.populatedLinkedUserDetails. A user built without that step
     * simply has no membership row, which resolves to free - never to an error.
     */
    getEntitlements() {
        return resolveEntitlements({ user: this, membership: this.userData.membership });
    }

    /**
     * The membership block as the client receives it.
     *
     * Split out of getWireSafeDetails so a caller that changes this account's
     * roles mid-request can re-resolve without writing the shape a second time
     * - see the supporter sweep in api/account.js checkauth, which is exactly
     * that case.
     *
     * @param {import('../services/membership/entitlements').Entitlements} [entitlements]
     */
    getMembershipSummary(entitlements = this.getEntitlements()) {
        return {
            membership: {
                tier: entitlements.tierId,
                tierName: entitlements.tierName,
                rank: entitlements.rank,
                isAdmin: entitlements.isAdmin,
                complimentary: entitlements.complimentary,
                expiresAt: entitlements.expiresAt,
                source: entitlements.source
            },
            capabilities: entitlements.capabilities,
            // ARCHON (N12): what this account has chosen to look like, filtered
            // to what it may still use. Sent with the user so the profile panel
            // and the player's own name render their choice immediately rather
            // than after a second request.
            cosmetics: cosmeticsFor(this.userData.cosmetics, entitlements)
        };
    }

    /**
     * Update the permission flags this model resolves entitlements from.
     *
     * Needed because getWireSafeDetails hands out a COPY of the permissions
     * object (server/settings.js `getUserWithDefaultsSet`), so mutating the
     * serialized user does not change what `getEntitlements()` will read.
     */
    setPermission(name, value) {
        this.userData.permissions = this.userData.permissions || {};
        this.userData.permissions[name] = value;
    }

    getWireSafeDetails() {
        const entitlements = this.getEntitlements();

        let user = {
            id: this.userData.id,
            avatar: this.userData.settings && this.userData.settings.avatar,
            username: this.userData.username,
            email: this.userData.email,
            settings: this.userData.settings,
            permissions: this.userData.permissions,
            verified: this.userData.verified,
            // ARCHON (N20): carried so an entitlement re-resolution from the
            // wire user (requireCapability's fallback for older tokens) still
            // sees the new-player trial. Not sensitive - profiles already
            // show when a member joined.
            registered: this.userData.registered,
            // ARCHON: drives the first-run wizard redirect (Phase 9)
            onboarded: !!this.userData.onboarded,
            // ARCHON: linked Decks of KeyForge account (prefills bulk import)
            dokUsername: this.userData.dokUsername || null,
            // ARCHON (N12): premium membership. The client gates UI on
            // `capabilities` and never re-derives it from the tier - the server
            // is the only thing that decides, so a hand-edited client cannot
            // grant itself anything the API would not also allow.
            ...this.getMembershipSummary(entitlements)
        };

        user = Settings.getUserWithDefaultsSet(user);

        return user;
    }

    getShortSummary() {
        // Resolved once: `role` and `tier` both come from the same badge, and
        // this runs for every user in every lobby broadcast.
        const badge = this.publicBadge;

        return {
            username: this.username,
            avatar: this.avatar,
            name: this.username,
            role: badge.role,
            // ARCHON (N12): the tier, so a lobby seat can show which one
            // without a second lookup. Name only - never expiry or provider.
            tier: badge.tier,
            tierName: badge.tierName,
            // Carried for the same reason as the tier: a seat that already
            // has the tier skips the badge lookup entirely, so without this a
            // member's frame and name effect would appear everywhere except
            // the lobby. Already absent when nothing is set - publicBadge omits
            // it - which matters on a message sent to every client on every
            // lobby update.
            cosmetics: badge.cosmetics,
            // ARCHON (N20): the New pill, for the same reason again. Omitted
            // by publicBadge for everyone past their first fortnight.
            isNew: badge.isNew
        };
    }

    getFullDetails() {
        let user = Object.assign({ invalidDecks: this.invalidDecks }, this.userData);

        delete user.password;

        user = Settings.getUserWithDefaultsSet(user);
        user.avatar = this.avatar;

        return user;
    }

    getDetails() {
        let user = Object.assign({ invalidDecks: this.invalidDecks }, this.userData);

        delete user.password;
        delete user.tokens;

        user = Settings.getUserWithDefaultsSet(user);
        user.role = this.role;
        user.avatar = this.avatar;

        return user;
    }
}

module.exports = User;
