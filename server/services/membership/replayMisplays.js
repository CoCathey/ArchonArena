const Constants = require('../../constants');

/**
 * ARCHON (F3): the misplay review - moments worth a second look, read out of
 * a recorded game. Part of the Archon tier's `advanced_replays`, like the
 * rest of the replay analysis.
 *
 * ## What "misplay" is allowed to mean here
 *
 * Nothing in this module simulates the game, and nothing here reads card
 * text. A real "what would have happened" engine would have to re-play a
 * prompt-driven, hidden-information, randomised game down a line nobody took -
 * an estimate dressed as a fact. What CAN be said honestly comes from what the
 * recording knows: the board each frame, and (since version 4) what the
 * player's hand held at that frame. So every check below is arithmetic over
 * recorded state, each one names the moment it read, and the UI is expected to
 * present them as questions worth asking - "you called Logos holding one Logos
 * card; Shadows offered five" - never as verdicts. Holding a combo, baiting a
 * board wipe and saving a key card all look like "misplays" to arithmetic, and
 * are exactly the judgement the player is better at than the site is.
 *
 * ## The rules arithmetic this leans on
 *
 * KeyForge as the engine plays it: a turn is forge, choose a house, play /
 * discard / use cards of that house, ready, then draw back up to 6 (less one
 * for every six chains); creatures and artifacts enter play exhausted; a
 * ready creature of the active house could always have reaped for 1 amber.
 *
 * ## What the recording cannot see, and how that is handled
 *
 * House-choice restrictions (Control the Weak and friends), use restrictions,
 * refill modifiers and every card's text are not in the frames. That is why
 * thresholds are conservative, why round one is skipped outright (the first
 * player's opening turn is rule-limited to one card), and why the last turn
 * of a decided game is not read at all - a game that ended mid-turn makes
 * "unused" meaningless. Thinned recordings (frames dropped to fit the store)
 * skip the end-of-turn checks entirely: the frame that proves what a turn
 * ended with may be one of the dropped ones.
 *
 * Hands are hidden information even after the game, so the serving layer
 * (api/games.js) filters moments to the asking player's own - see
 * `filterMisplaysTo`. Board-read moments obey the same rule: the review is a
 * mirror, not a scouting report.
 */

const HOUSES = new Set(Constants.Houses);

/** Flag a house call only this lopsided: called ≤ 2 usable, alternative ≥ +3. */
const HOUSE_CALL_MAX_POTENTIAL = 2;
const HOUSE_CALL_MIN_DELTA = 3;
/** Ready, unstunned creatures of the called house left unused at end of main. */
const UNUSED_CREATURES_MIN = 2;
/** Playable cards kept in hand that cost at least this many fresh draws. */
const HELD_CARDS_MIN_MISSED = 2;
/** A house counts as clogging the hand at this many cards... */
const CLOG_MIN_CARDS = 4;
/** ...held across this many consecutive turns without being called. */
const CLOG_MIN_TURNS = 3;
/** The printed refill target, before chains. */
const HAND_REFILL = 6;

const UNAVAILABLE = (reason) => ({ available: false, reason });

/**
 * Every house a recorded identity can be played or used as: its in-deck house
 * (deck.js already writes a maverick's or anomaly's deck house into
 * `printedHouse`, which is what the card table records) plus any house pips
 * among its enhancements, normalised the way `Card.getHouseEnhancements` does.
 */
function housesOf(identity) {
    const houses = new Set();

    if (!identity) {
        return houses;
    }

    const add = (value) => {
        if (typeof value !== 'string') {
            return;
        }

        const house = value.replace(/\s/g, '').toLowerCase();

        if (HOUSES.has(house)) {
            houses.add(house);
        }
    };

    add(identity.house);

    for (const enhancement of identity.enhancements || []) {
        add(enhancement);
    }

    return houses;
}

/**
 * A creature entry from a recorded `cardsInPlay`, whichever version wrote it:
 * version 3+ holds `{card, uuid, exhausted?, stunned?}` references into the
 * card table, version 2 holds whole summaries inline.
 */
function inPlayCard(entry, cards) {
    if (entry === null || entry === undefined) {
        return null;
    }

    if (typeof entry === 'number') {
        return cards[entry] ? { identity: cards[entry], exhausted: false, stunned: false } : null;
    }

    if (entry.card !== undefined) {
        const identity = cards[entry.card];

        return identity
            ? { identity, exhausted: !!entry.exhausted, stunned: !!entry.stunned }
            : null;
    }

    return { identity: entry, exhausted: !!entry.exhausted, stunned: !!entry.stunned };
}

/** A frame's record of one player, or null. */
function playerIn(board, name) {
    return (board?.players || []).find((player) => player?.name === name) || null;
}

/** The recorded hand at a frame as identities, or null when not recorded. */
function handAt(snapshot, name, handCards) {
    const entries = snapshot?.hands?.[name];

    if (!Array.isArray(entries)) {
        return null;
    }

    return entries
        .map((entry) => (Number.isInteger(entry) ? handCards[entry] : null))
        .filter(Boolean);
}

/**
 * The game as turn runs: consecutive frames sharing a round number and an
 * active player, with the frames kept - unlike the analysis' `buildTurns`,
 * which reads only each run's ends, the review needs to look inside a turn.
 */
function buildTurnRuns(snapshots) {
    const runs = [];
    let current = null;

    for (const snapshot of snapshots || []) {
        const board = snapshot?.board;

        if (!board || board.round == null || !board.activePlayer) {
            continue;
        }

        if (!current || current.round !== board.round || current.player !== board.activePlayer) {
            current = { round: board.round, player: board.activePlayer, frames: [] };
            runs.push(current);
        }

        current.frames.push(snapshot);
    }

    for (const run of runs) {
        run.opening = run.frames[0];
        run.mainFrames = run.frames.filter((frame) => frame.board.phase === 'main');
        run.house = null;

        for (const frame of run.frames) {
            const active = playerIn(frame.board, run.player);

            if (active?.activeHouse) {
                run.house = String(active.activeHouse).toLowerCase();
                break;
            }
        }
    }

    return runs;
}

/**
 * Whether a run's opening frame shows the hand as it stood when the house was
 * chosen. The engine settles (and records) at the choose-house prompt, so an
 * intact recording opens every turn on a 'key' or 'house' frame; a run that
 * opens mid-main (thinning, or a recording that started late) would read a
 * hand already part-spent, and is not read at all.
 */
function opensBeforePlay(run) {
    return ['key', 'house'].includes(run.opening?.board?.phase);
}

/** The player's own turn counter at a frame, when the recording carries it. */
function playerTurnAt(frame, name) {
    const turn = playerIn(frame?.board, name)?.turn;

    return Number.isFinite(turn) ? turn : undefined;
}

/**
 * The review over one recording. Pure, like `analyseReplay`, and for the same
 * reason: it is what lets the arithmetic be tested against hand-built
 * recordings where every flagged moment can be checked by reading the fixture.
 *
 * @param {object} replay a recording as stored in `GameReplays."Data"`
 * @returns {{available: boolean, reason?: string, handsRecorded?: boolean,
 *   thinned?: boolean, moments?: object[]}}
 */
function findMisplays(replay) {
    if (!replay || typeof replay !== 'object') {
        return UNAVAILABLE('No replay was recorded for this game.');
    }

    const snapshots = Array.isArray(replay.snapshots) ? replay.snapshots : [];

    if (snapshots.length === 0) {
        return UNAVAILABLE(
            'This game was recorded before board states were captured, so there is nothing to review.'
        );
    }

    const cards = Array.isArray(replay.cards) ? replay.cards : [];
    const handCards = Array.isArray(replay.handCards) ? replay.handCards : [];
    const handsRecorded = snapshots.some(
        (snapshot) => snapshot && typeof snapshot.hands === 'object' && snapshot.hands !== null
    );
    const thinned = !!replay.thinned;
    const runs = buildTurnRuns(snapshots);
    const lastRun = runs[runs.length - 1];
    const moments = [];

    for (const run of runs) {
        // A decided game's last turn ended when the game did, not when the
        // player chose to stop; nothing about how it ended is a choice to
        // second-guess.
        const cutShort = run === lastRun && !!replay.winner;

        houseCallMoment(run, cards, handCards, moments);

        if (!thinned && !cutShort) {
            unusedCreaturesMoment(run, cards, moments);

            if (handsRecorded) {
                heldCardsMoment(run, handCards, moments);
            }
        }
    }

    if (handsRecorded) {
        cloggedHandMoments(runs, handCards, moments);
    }

    moments.sort((a, b) => a.messageIndex - b.messageIndex);

    return { available: true, handsRecorded, thinned, moments };
}

/**
 * "You called a house that had almost nothing to do while another was full."
 *
 * Potential is what a house call could have acted on at the moment of the
 * choice: cards of that house in hand, plus ready unstunned creatures of it
 * already on the board. Compared only across the deck's own three houses, and
 * only when the recording shows the pre-play hand.
 */
function houseCallMoment(run, cards, handCards, moments) {
    if (run.round <= 1 || !run.house || !opensBeforePlay(run)) {
        return;
    }

    const hand = handAt(run.opening, run.player, handCards);
    const active = playerIn(run.opening.board, run.player);

    if (!hand || !active) {
        return;
    }

    const candidates = (active.houses || [])
        .map((house) => String(house).toLowerCase())
        .filter((house) => HOUSES.has(house));

    if (candidates.length < 2 || !candidates.includes(run.house)) {
        return;
    }

    const potential = Object.fromEntries(candidates.map((house) => [house, 0]));

    for (const identity of hand) {
        for (const house of housesOf(identity)) {
            if (house in potential) {
                potential[house]++;
            }
        }
    }

    for (const entry of active.cardPiles?.cardsInPlay || []) {
        const card = inPlayCard(entry, cards);

        if (!card || card.identity.type !== 'creature' || card.exhausted || card.stunned) {
            continue;
        }

        for (const house of housesOf(card.identity)) {
            if (house in potential) {
                potential[house]++;
            }
        }
    }

    const called = potential[run.house];
    const best = candidates
        .filter((house) => house !== run.house)
        .reduce(
            (top, house) => (top === null || potential[house] > potential[top] ? house : top),
            null
        );

    if (
        best !== null &&
        called <= HOUSE_CALL_MAX_POTENTIAL &&
        potential[best] - called >= HOUSE_CALL_MIN_DELTA
    ) {
        moments.push({
            type: 'house-call',
            player: run.player,
            round: run.round,
            turn: playerTurnAt(run.opening, run.player),
            messageIndex: run.opening.messageIndex,
            house: run.house,
            potential: called,
            bestHouse: best,
            bestPotential: potential[best]
        });
    }
}

/**
 * "Ready creatures of your house did nothing all turn."
 *
 * Read at the last main-phase frame - the board as it stood when the turn was
 * ended, before the ready step wipes the evidence. A creature that is ready
 * and unstunned there was never used: creatures enter play exhausted, so a
 * just-played one cannot be mistaken for an idle one. Each was a reap - an
 * amber - the turn left on the table, barring an unrecorded restriction.
 */
function unusedCreaturesMoment(run, cards, moments) {
    if (run.round <= 1 || !run.house || run.mainFrames.length === 0) {
        return;
    }

    const last = run.mainFrames[run.mainFrames.length - 1];
    const active = playerIn(last.board, run.player);
    const idle = [];

    for (const entry of active?.cardPiles?.cardsInPlay || []) {
        const card = inPlayCard(entry, cards);

        if (
            card &&
            card.identity.type === 'creature' &&
            !card.exhausted &&
            !card.stunned &&
            housesOf(card.identity).has(run.house)
        ) {
            idle.push(card.identity.name);
        }
    }

    if (idle.length >= UNUSED_CREATURES_MIN) {
        moments.push({
            type: 'unused-creatures',
            player: run.player,
            round: run.round,
            turn: playerTurnAt(last, run.player),
            messageIndex: last.messageIndex,
            house: run.house,
            count: idle.length,
            creatures: idle
        });
    }
}

/**
 * "You kept playable cards and drew that many fewer."
 *
 * Any card of the active house could have been played or at worst discarded;
 * one still in hand when the turn ended displaced a fresh draw whenever the
 * refill (6, less one per six chains) was not already met without it. Holding
 * is sometimes right - that is the player's call - but it should be a choice
 * they can see the price of.
 */
function heldCardsMoment(run, handCards, moments) {
    if (run.round <= 1 || !run.house || run.mainFrames.length === 0) {
        return;
    }

    const last = run.mainFrames[run.mainFrames.length - 1];
    const hand = handAt(last, run.player, handCards);
    const active = playerIn(last.board, run.player);

    if (!hand || !active) {
        return;
    }

    const held = hand.filter((identity) => housesOf(identity).has(run.house));
    const chains = active.stats?.chains ?? 0;
    const refillTarget = Math.max(0, HAND_REFILL - Math.ceil(chains / 6));
    const missedDraws = Math.max(
        0,
        Math.min(held.length, refillTarget - (hand.length - held.length))
    );

    if (missedDraws >= HELD_CARDS_MIN_MISSED) {
        moments.push({
            type: 'held-cards',
            player: run.player,
            round: run.round,
            turn: playerTurnAt(last, run.player),
            messageIndex: last.messageIndex,
            house: run.house,
            held: held.map((identity) => ({
                id: identity.id,
                name: identity.name,
                house: identity.house
            })),
            missedDraws
        });
    }
}

/**
 * "A house sat unplayed in your hand for turns on end."
 *
 * Not one bad call but a pattern of them: a house at four-plus cards at the
 * start of several consecutive turns, never called across them. Each hand a
 * clogged house occupies is a card the deck is not drawing. One moment per
 * streak, placed on the turn the streak had grown longest.
 */
function cloggedHandMoments(runs, handCards, moments) {
    const streaks = new Map();
    const keyFor = (player, house) => `${player} ${house}`;

    const flush = (streak) => {
        if (streak && streak.turns >= CLOG_MIN_TURNS) {
            moments.push({
                type: 'clogged-hand',
                player: streak.player,
                round: streak.round,
                turn: streak.playerTurn,
                messageIndex: streak.messageIndex,
                house: streak.house,
                turnsHeld: streak.turns,
                peak: streak.peak
            });
        }
    };

    for (const run of runs) {
        const hand = opensBeforePlay(run) ? handAt(run.opening, run.player, handCards) : null;
        const active = playerIn(run.opening.board, run.player);

        // A turn whose opening hand is unreadable breaks every streak the
        // player had: continuity cannot be claimed across a gap.
        if (!hand || !active || !run.house) {
            for (const [key, streak] of [...streaks]) {
                if (streak.player === run.player) {
                    flush(streak);
                    streaks.delete(key);
                }
            }

            continue;
        }

        const counts = {};

        for (const identity of hand) {
            for (const house of housesOf(identity)) {
                counts[house] = (counts[house] || 0) + 1;
            }
        }

        const candidates = (active.houses || [])
            .map((house) => String(house).toLowerCase())
            .filter((house) => HOUSES.has(house));

        for (const house of candidates) {
            const key = keyFor(run.player, house);
            const clogged = house !== run.house && (counts[house] || 0) >= CLOG_MIN_CARDS;

            if (!clogged) {
                flush(streaks.get(key));
                streaks.delete(key);

                continue;
            }

            const streak = streaks.get(key) || {
                player: run.player,
                house,
                turns: 0,
                peak: 0
            };

            streak.turns++;
            streak.peak = Math.max(streak.peak, counts[house] || 0);
            streak.round = run.round;
            streak.playerTurn = playerTurnAt(run.opening, run.player);
            streak.messageIndex = run.opening.messageIndex;
            streaks.set(key, streak);
        }
    }

    for (const streak of streaks.values()) {
        flush(streak);
    }
}

/**
 * The review as one player may read it: their own moments only. The moments
 * are computed over both hands, but what the opponent held - and what they
 * did not do with it - is not this account's to see. `null` keeps everything,
 * which is the admin read.
 *
 * @param {object} misplays a `findMisplays` result
 * @param {string|null} playerName
 */
function filterMisplaysTo(misplays, playerName) {
    if (!misplays || !misplays.available || !playerName) {
        return misplays;
    }

    return {
        ...misplays,
        moments: (misplays.moments || []).filter((moment) => moment.player === playerName)
    };
}

module.exports = { findMisplays, filterMisplaysTo, housesOf };
