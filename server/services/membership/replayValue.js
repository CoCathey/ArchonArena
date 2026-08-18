const { stateFeaturesFrom } = require('../championschallenge/labFeatures');
const { scoreState } = require('../championschallenge/labPolicy');

/**
 * ARCHON (N26): the win-probability curve over a recorded game.
 *
 * The Champion's Challenge trained a value model on tens of thousands of games
 * (N21/N25) and until now it only ever looked at the lab's own sparring. This
 * points it at a REAL game: every recorded board frame is scored from one
 * player's seat, which turns a replay into a curve and the sharpest drops in
 * that curve into the moments worth a second look.
 *
 * ## Why this can be trusted at all
 *
 * The model's weights are meaningless against features scaled differently from
 * the ones it trained on. So this does NOT re-implement the extractor: it builds
 * the same VIEW the live engine builds and hands it to the same
 * `stateFeaturesFrom`. One arithmetic, two adapters - the parity is structural,
 * and a spec asserts a live position and its recorded frame produce identical
 * features anyway.
 *
 * ## What it deliberately does not claim
 *
 * **No counterfactual lines.** "What would have happened if you had reaped
 * instead" needs the game replayed down a different branch, and that needs a
 * seed and an input log. Real games have neither - they are human games, played
 * against crypto randomness, recorded as board frames. The deep bot can fork its
 * OWN games because it seeds them deliberately; nothing here can fork yours. So
 * this reports where the game turned, never what the other road held, and the
 * panel says so rather than letting a reader assume the harder claim.
 *
 * **No blame.** A drop between two frames is a change in position, which may be
 * the opponent's good play, a card doing what it says, or a bad choice. The
 * moments are offered as "look here", the same voice the misplay review uses.
 *
 * **Nothing without a model.** A site whose bot has never trained has no value
 * model, and this returns unavailable rather than inventing a heuristic curve
 * that would look identical to a real one.
 */

/** Keys forged, from a replay frame's per-colour map or a plain number. */
function keyCount(keys) {
    if (typeof keys === 'number') {
        return Number.isFinite(keys) ? keys : 0;
    }

    if (!keys || typeof keys !== 'object') {
        return 0;
    }

    return Object.values(keys).filter(Boolean).length;
}

/** A recorded pile entry's card identity, across recording versions. */
function identityOf(entry, cards) {
    if (entry === null || entry === undefined) {
        return null;
    }

    if (typeof entry === 'number') {
        return cards[entry] || null;
    }

    if (entry.card !== undefined) {
        return typeof entry.card === 'number' ? cards[entry.card] || null : entry.card;
    }

    return entry;
}

/**
 * One recorded seat, as the view `stateFeaturesFrom` wants.
 *
 * Power comes from the frame when an effect changed it and from the card table
 * otherwise, which is exactly how the recording stores it: printed values live
 * in the shared table, and only a modified power is written per frame.
 */
function seatViewFromFrame(player, cards) {
    if (!player) {
        return null;
    }

    const inPlay = player.cardPiles?.cardsInPlay || [];
    const creatures = [];
    let artifacts = 0;

    for (const entry of inPlay) {
        const identity = identityOf(entry, cards);

        if (!identity) {
            continue;
        }

        if (identity.type === 'creature') {
            creatures.push({
                power: typeof entry.power === 'number' ? entry.power : identity.power || 0,
                exhausted: !!entry.exhausted,
                // ARCHON (N42): captured amber, when the recording carries the
                // token counts. A frame without them reads as zero, which is
                // the graceful half of the N26 parity contract - a missing
                // fact must degrade a feature, never invent one.
                amber: (entry.tokens && entry.tokens.amber) || 0
            });
        } else if (identity.type === 'artifact') {
            artifacts++;
        }
    }

    const stats = player.stats || {};

    return {
        amber: stats.amber || 0,
        keys: keyCount(stats.keys),
        // A recording carries the cost as it stood, which is the whole point of
        // recording it: key cost moves during a game.
        keyCost: typeof stats.keyCost === 'number' ? stats.keyCost : 6,
        creatures,
        artifacts,
        hand: player.numHandCards || 0,
        archives: (player.cardPiles?.archives || []).length,
        deck: player.numDeckCards || 0,
        // The discard pile is public and recorded, so this side knows it too -
        // which is the test every field here has to pass.
        discard: (player.cardPiles?.discard || []).length
    };
}

/** The view for one frame, from `name`'s seat. */
function viewFromFrame(board, cards, name) {
    const players = board?.players || [];
    const me = players.find((player) => player?.name === name);
    const them = players.find((player) => player?.name !== name);

    if (!me) {
        return null;
    }

    return {
        round: board.round,
        me: seatViewFromFrame(me, cards),
        them: seatViewFromFrame(them, cards)
    };
}

/** How large a drop has to be before it is worth pointing at. */
const SWING_THRESHOLD = 0.12;

/** Most moments offered, however swingy the game was. */
const MAX_MOMENTS = 5;

/**
 * Score a recording frame by frame.
 *
 * @param {object} replay a recording as stored in GameReplays."Data"
 * @param {object|null} model the champion value model
 * @param {string} seat whose point of view the curve is from
 * @returns {{available: boolean, reason?: string, points?: object[],
 *           moments?: object[], seat?: string, modelVersion?: number}}
 */
function winProbabilityCurve(replay, model, seat) {
    if (!model) {
        return {
            available: false,
            reason:
                'The win-probability model has not been trained yet. It learns from the ' +
                'Champion’s Challenge, and appears here once the site has played enough games.'
        };
    }

    const frames = Array.isArray(replay?.snapshots) ? replay.snapshots : [];
    const cards = replay?.cards || [];

    if (!frames.length) {
        return {
            available: false,
            reason: 'This game was recorded before board states were captured.'
        };
    }

    if (!seat) {
        return { available: false, reason: 'No seat to read this game from.' };
    }

    const points = [];

    for (const frame of frames) {
        const view = viewFromFrame(frame.board || frame, cards, seat);

        if (!view || !view.me) {
            continue;
        }

        points.push({
            messageIndex: frame.messageIndex,
            round: view.round || 0,
            winProbability: Math.round(scoreState(model, stateFeaturesFrom(view)) * 1000) / 1000,
            keys: view.me.keys,
            opponentKeys: view.them ? view.them.keys : 0,
            amber: view.me.amber,
            opponentAmber: view.them ? view.them.amber : 0
        });
    }

    if (points.length < 2) {
        return {
            available: false,
            reason: 'This recording has too few board frames to draw a curve from.'
        };
    }

    return {
        available: true,
        seat,
        modelVersion: model.version || 0,
        trainedGames: model.trainedGames || 0,
        points,
        moments: findMoments(points)
    };
}

/**
 * The sharpest drops, as moments worth reviewing.
 *
 * A drop is a change in the position, not a verdict on a decision: the opponent
 * playing well produces one just as surely as a misstep does. Reported largest
 * first and capped, because a list of thirty moments is a list of none.
 */
function findMoments(points) {
    const drops = [];

    for (let i = 1; i < points.length; i++) {
        const before = points[i - 1];
        const after = points[i];
        const swing = before.winProbability - after.winProbability;

        if (swing >= SWING_THRESHOLD) {
            drops.push({
                fromMessageIndex: before.messageIndex,
                messageIndex: after.messageIndex,
                round: after.round,
                before: before.winProbability,
                after: after.winProbability,
                swing: Math.round(swing * 1000) / 1000
            });
        }
    }

    return drops.sort((a, b) => b.swing - a.swing).slice(0, MAX_MOMENTS);
}

module.exports = {
    winProbabilityCurve,
    viewFromFrame,
    seatViewFromFrame,
    findMoments,
    SWING_THRESHOLD
};
