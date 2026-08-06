/**
 * Patreon link states, as the server reports them on `user.patreon`.
 *
 * ARCHON (N12): these used to be the numbers 0/1/2, which never matched
 * anything - the API has always sent the strings below (and omitted the field
 * entirely when there is no link), so every comparison against the enum was
 * silently false.
 */
export const PatreonStatus = Object.freeze({
    Unlinked: 'none',
    Linked: 'linked',
    Pledged: 'pledged'
});

/** True when the account has no usable Patreon link. */
export const isPatreonUnlinked = (status) => !status || status === PatreonStatus.Unlinked;
