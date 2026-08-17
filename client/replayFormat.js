/**
 * ARCHON: reading a recording, whichever version wrote it.
 *
 * A replay's board frames changed shape when the capture was made compact
 * (`Game.getBoardSnapshot`): piles used to be arrays of full card summaries and
 * are now references into a card table held once for the whole recording. That
 * change is why replays are stored at all - the old format put a normal game's
 * recording eight times over the store limit, so every one of them was dropped
 * - but recordings written before it are still in the database and still have
 * to render.
 *
 * Everything here takes both and returns one shape, so the viewer and the
 * analysis never branch on a version number.
 */

/**
 * Turn a pile entry into something `CardImage` can draw.
 *
 * @param {number|object} entry an index into the card table, a `{card, …}`
 *   reference with live state, or (version 2) a whole card summary
 * @param {object[]} cards the recording's card table
 * @param {string} location the pile it is in, which is what tells CardImage
 *   whether to draw the plain image or the canvas with tokens on it
 */
export function hydrateCard(entry, cards = [], location = 'discard') {
    if (entry === null || entry === undefined) {
        return null;
    }

    // Version 2: the whole summary is inline.
    if (typeof entry === 'object' && entry.card === undefined) {
        return { ...entry, location: entry.location || location };
    }

    const index = typeof entry === 'number' ? entry : entry.card;
    const identity = cards[index];

    if (!identity) {
        return null;
    }

    const card = {
        ...identity,
        // The card table keeps the printed values under short names; the card
        // renderer reads the long ones the live game state uses.
        printedHouse: identity.house,
        powerPrinted: identity.power,
        armorPrinted: identity.armor,
        cardPrintedAmber: identity.amber,
        location
    };

    if (typeof entry === 'number') {
        return card;
    }

    // A card in play: identity plus only what was changing.
    return {
        ...card,
        uuid: entry.uuid,
        exhausted: !!entry.exhausted,
        stunned: !!entry.stunned,
        taunt: !!entry.taunt,
        tokens: entry.tokens || {},
        modifiedPower: entry.power != null ? entry.power : identity.power,
        childCards: (entry.upgrades || []).map((upgrade) =>
            hydrateCard(upgrade, cards, 'play area')
        )
    };
}

/** Every card in a pile, drawable. */
export function hydratePile(pile, cards, location) {
    return (pile || []).map((entry) => hydrateCard(entry, cards, location)).filter(Boolean);
}

/**
 * A board frame with its piles resolved.
 *
 * @param {object} board a snapshot's `board`
 * @param {object[]} cards the recording's card table
 */
export function hydrateBoard(board, cards) {
    if (!board || !Array.isArray(board.players)) {
        return null;
    }

    return {
        ...board,
        players: board.players.map((player) => ({
            ...player,
            cardPiles: {
                cardsInPlay: hydratePile(player.cardPiles?.cardsInPlay, cards, 'play area'),
                archives: hydratePile(player.cardPiles?.archives, cards, 'archives'),
                discard: hydratePile(player.cardPiles?.discard, cards, 'discard'),
                purged: hydratePile(player.cardPiles?.purged, cards, 'purged')
            }
        }))
    };
}

/**
 * The frame to show at a position in the log: the last one recorded at or
 * before it.
 *
 * Returns null before the first frame rather than falling back to it. Showing
 * frame zero for every step ahead of it drew a board from later in the game
 * than the log the reader was looking at, which is worse than drawing none.
 *
 * @param {Array<{messageIndex: number, board?: object}>} snapshots
 * @param {number} step how far through the log the viewer is
 */
export function snapshotAtStep(snapshots, step) {
    let found = null;

    for (const snapshot of snapshots || []) {
        if (snapshot.messageIndex <= step) {
            found = snapshot;
        } else {
            break;
        }
    }

    return found;
}

/** The board half of that frame, which is all most callers draw. */
export function boardAtStep(snapshots, step) {
    return snapshotAtStep(snapshots, step)?.board || null;
}

/**
 * ARCHON (F3): the recorded hands at a step, drawable.
 *
 * A version 4 recording carries hands beside each frame (`snapshot.hands`),
 * as references into its own `handCards` table - and only the hands this
 * reader was allowed: the server serves a player their own alone, an admin
 * both, and a share link none, so whatever arrives here is safe to draw.
 * Returns a map of player name to cards; empty when this frame (or this
 * recording, or this reader) has none.
 *
 * @param {Array<{messageIndex: number, hands?: object}>} snapshots
 * @param {number} step how far through the log the viewer is
 * @param {object[]} handCards the recording's hand-card table
 * @returns {Object<string, object[]>}
 */
export function handsAtStep(snapshots, step, handCards) {
    return hiddenZoneAtStep(snapshots, step, handCards, 'hands', 'hand');
}

/**
 * ARCHON (F3): the recorded archives at a step, drawable - the owner's view
 * of the pile the board frame only shows facedown. Same serving rules as the
 * hands: whatever arrives here is safe to draw.
 */
export function archivesAtStep(snapshots, step, handCards) {
    return hiddenZoneAtStep(snapshots, step, handCards, 'archives', 'archives');
}

function hiddenZoneAtStep(snapshots, step, handCards, zone, location) {
    const piles = snapshotAtStep(snapshots, step)?.[zone];

    if (!piles || typeof piles !== 'object') {
        return {};
    }

    const resolved = {};

    for (const [name, entries] of Object.entries(piles)) {
        if (Array.isArray(entries)) {
            resolved[name] = hydratePile(entries, handCards, location);
        }
    }

    return resolved;
}
