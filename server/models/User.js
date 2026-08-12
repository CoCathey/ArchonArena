const Settings = require('../settings');
// ARCHON (N12): the single authority on premium access. See its header for why
// the admin override lives there and nowhere else.
const { resolveEntitlements } = require('../services/membership/entitlements');

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

    get role() {
        if (this.isAdmin) {
            return 'admin';
        }

        if (this.isWinner) {
            return 'winner';
        }

        if (this.isPreviousWinner) {
            return 'previouswinner';
        }

        if (this.isContributor) {
            return 'contributor';
        }

        if (this.isSupporter) {
            return 'supporter';
        }

        return 'user';
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
            // ARCHON: drives the first-run wizard redirect (Phase 9)
            onboarded: !!this.userData.onboarded,
            // ARCHON: linked Decks of KeyForge account (prefills bulk import)
            dokUsername: this.userData.dokUsername || null,
            // ARCHON (N12): premium membership. The client gates UI on
            // `capabilities` and never re-derives it from the tier - the server
            // is the only thing that decides, so a hand-edited client cannot
            // grant itself anything the API would not also allow.
            membership: {
                tier: entitlements.tierId,
                tierName: entitlements.tierName,
                rank: entitlements.rank,
                isAdmin: entitlements.isAdmin,
                complimentary: entitlements.complimentary,
                expiresAt: entitlements.expiresAt,
                source: entitlements.source
            },
            capabilities: entitlements.capabilities
        };

        user = Settings.getUserWithDefaultsSet(user);

        return user;
    }

    getShortSummary() {
        return {
            username: this.username,
            avatar: this.avatar,
            name: this.username,
            role: this.role
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
