const Constants = require('../../constants');
const { ROLES, rolesFor: knownRolesFor } = require('./cardKnowledge');

/**
 * ARCHON (F3): the misplay review - moments worth a second look, read out of
 * a recorded game. Part of the Archon tier's `advanced_replays`, like the
 * rest of the replay analysis.
 *
 * ## What "misplay" is allowed to mean here
 *
 * Nothing in this module simulates the game. A real "what would have
 * happened" engine would have to re-play a prompt-driven, hidden-information,
 * randomised game down a line nobody took - an estimate dressed as a fact.
 * What CAN be said honestly comes from what the recording knows - the board
 * each frame, the player's hand (v4) and archives (v6) beside it - plus one
 * more source: what each card's own canonical text says it does, classified
 * by cardKnowledge.js into a handful of narrow roles (steals, wipes, key
 * cheats). That is reading versioned card data, not comprehending rules:
 * conditions, costs and targets stay invisible, so card-aware moments are
 * always phrased as availability ("the steal was in hand"), never as outcome.
 * Every check below is arithmetic over recorded state, each one names the
 * moment it read, and the UI presents them as questions worth asking - never
 * as verdicts. Holding a combo, baiting a wipe and saving a key card all look
 * like "misplays" to arithmetic, and are exactly the judgement the player is
 * better at than the site is.
 *
 * ## The rules arithmetic this leans on
 *
 * KeyForge as the engine plays it: a turn is forge, choose a house, play /
 * discard / use cards of that house, ready, then draw back up to 6 (less one
 * for every six chains); creatures and artifacts enter play exhausted; a
 * ready creature of the active house could always have reaped for 1 amber.
 *
 * ## Telling a good decision from a miss
 *
 * A review that second-guesses reasonable play gets closed and never opened
 * again, so every check carries suppressions for the good reasons the
 * recording can actually see. Three kinds:
 *
 * Recorded constraints. Version 5 frames carry the active player's legally
 * callable houses, so a forced or restricted call (Control the Weak and
 * friends) is never a "misplay". Version 6 records the owner's archives, so
 * they are counted into the house-call arithmetic; an older recording's
 * stocked archive - facedown to the review - disqualifies that turn outright
 * rather than judging half a hand.
 *
 * Hindsight. The recording holds the whole game, so a choice that visibly
 * worked is cleared: the thin call that forged mid-turn, out-earned the
 * fuller house, or was followed by the checked opponent NOT forging; the
 * held cards that got played within the player's next two turns (a save,
 * executed - and a game that ended sooner gets the benefit of the doubt);
 * the idle creatures on a turn the winner had already sealed; the clogged
 * house that finally cashed out into a forge or a big amber turn.
 *
 * Card knowledge. A creature whose text forbids reaping is never "unused",
 * and a hold made of nothing but answers - steals, wipes, key cheats - is
 * insurance, not a slip. The same knowledge cuts the other way in
 * `answerHeldMoments`: when a named threat landed and the card that answers
 * that kind of threat sat reachable and unplayed, the review says so by
 * name.
 *
 * ## What the recording still cannot see, and how that is handled
 *
 * Use restrictions, refill modifiers, and every condition, cost and target
 * inside a card's text are not in the frames. That is why thresholds are
 * conservative, why round one is skipped outright (the first player's
 * opening turn is rule-limited to one card), and why the last turn of a
 * decided game is not read at all - a game that ended mid-turn makes
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
/** A clog that resolves into a turn this good was assembly, not a clog. */
const CLOG_PAYOFF_AMBER = 3;
/** The printed refill target, before chains. */
const HAND_REFILL = 6;
/** A board this many creatures wider than yours is a named threat. */
const ANSWER_BOARD_GAP = 4;

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

/** Forged keys in a frame's `stats.keys` - the engine's per-colour map. */
function keyCount(keys) {
    if (typeof keys === 'number') {
        return Number.isFinite(keys) ? keys : 0;
    }

    if (!keys || typeof keys !== 'object') {
        return 0;
    }

    return Object.values(keys).filter(Boolean).length;
}

/** One player's keys at a frame. */
function keysAt(frame, name) {
    return keyCount(playerIn(frame?.board, name)?.stats?.keys);
}

/** One player's amber at a frame. */
function amberAt(frame, name) {
    const amber = playerIn(frame?.board, name)?.stats?.amber;

    return Number.isFinite(amber) ? amber : 0;
}

/** The player's next `count` turn runs after `index`, in order. */
function laterRunsOf(runs, index, name, count) {
    const later = [];

    for (let position = index + 1; position < runs.length && later.length < count; position++) {
        if (runs[position].player === name) {
            later.push(runs[position]);
        }
    }

    return later;
}

/** The recorded hand at a frame as identities, or null when not recorded. */
function handAt(snapshot, name, handCards) {
    return hiddenZoneAt(snapshot, 'hands', name, handCards);
}

/**
 * The owner's recorded archives at a frame (v6), or null when not recorded.
 * Archives matter to every house call: they come to hand on calling ANY
 * house, and their cards then play under their own houses.
 */
function archiveAt(snapshot, name, handCards) {
    return hiddenZoneAt(snapshot, 'archives', name, handCards);
}

function hiddenZoneAt(snapshot, zone, name, handCards) {
    const entries = snapshot?.[zone]?.[name];

    if (!Array.isArray(entries)) {
        return null;
    }

    return entries
        .map((entry) => (Number.isInteger(entry) ? handCards[entry] : null))
        .filter(Boolean);
}

/**
 * The worth a card contributes to a house call: at least the one action of
 * playing or discarding it, more when its bonus icons guarantee amber
 * (`identity.amber` is the recorded pip count). A reap is worth one, which
 * keeps every unit here amber-flavoured.
 */
function cardWorth(identity) {
    const pips = Number.isFinite(identity?.amber) ? identity.amber : 0;

    return Math.max(1, pips);
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
        run.closing = run.frames[run.frames.length - 1];
        run.mainFrames = run.frames.filter((frame) => frame.board.phase === 'main');
        run.house = null;

        for (const frame of run.frames) {
            const active = playerIn(frame.board, run.player);

            if (active?.activeHouse) {
                run.house = String(active.activeHouse).toLowerCase();
                break;
            }
        }

        // What the turn visibly produced, for the "it worked" suppressions:
        // amber swing across the run and any key forged inside it (the
        // opening frame sits after the start-of-turn forge, so a rise within
        // the run is a mid-turn forge - a key cheat that came off).
        run.amberGained = amberAt(run.closing, run.player) - amberAt(run.opening, run.player);
        run.forgedDuring = keysAt(run.closing, run.player) > keysAt(run.opening, run.player);
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
 * @param {{rolesFor?: (cardId: string) => Set<string>}} [options] card
 *   knowledge to review with; defaults to the master-vault classification
 *   (cardKnowledge.js). Injectable so fixtures can state a card's function
 *   instead of depending on the real pool.
 * @returns {{available: boolean, reason?: string, handsRecorded?: boolean,
 *   thinned?: boolean, moments?: object[], toolbox?: object}}
 */
function findMisplays(replay, { rolesFor = knownRolesFor } = {}) {
    if (!replay || typeof replay !== 'object') {
        return UNAVAILABLE('No replay was recorded for this game.');
    }

    const snapshots = Array.isArray(replay.snapshots) ? replay.snapshots : [];

    if (snapshots.length === 0) {
        return UNAVAILABLE(
            'This game was recorded before board states were captured, so there is nothing to review.'
        );
    }

    const handsRecorded = snapshots.some(
        (snapshot) => snapshot && typeof snapshot.hands === 'object' && snapshot.hands !== null
    );
    const runs = buildTurnRuns(snapshots);
    const context = {
        cards: Array.isArray(replay.cards) ? replay.cards : [],
        handCards: Array.isArray(replay.handCards) ? replay.handCards : [],
        runs,
        winner: replay.winner,
        rolesFor,
        // One answer-held moment per card per game: a threat that persists
        // must not flag the same held answer turn after turn.
        answeredCards: new Set(),
        moments: []
    };
    const thinned = !!replay.thinned;
    const lastRun = runs[runs.length - 1];

    for (const [index, run] of runs.entries()) {
        // A decided game's last turn ended when the game did, not when the
        // player chose to stop; nothing about how it ended is a choice to
        // second-guess.
        const cutShort = run === lastRun && !!replay.winner;

        houseCallMoment(run, index, context);

        if (handsRecorded) {
            answerHeldMoments(run, index, context);
        }

        if (!thinned && !cutShort) {
            unusedCreaturesMoment(run, context);

            if (handsRecorded) {
                heldCardsMoment(run, index, context);
            }
        }
    }

    if (handsRecorded) {
        cloggedHandMoments(runs, context.handCards, context.moments);
    }

    // Where a specific "the answer was in hand" moment fired, the generic
    // "that house was thin" one on the same turn is noise beside it.
    const answered = new Set(
        context.moments
            .filter((moment) => moment.type === 'answer-held')
            .map((moment) => `${moment.player} ${moment.round}`)
    );
    const moments = context.moments.filter(
        (moment) =>
            moment.type !== 'house-call' || !answered.has(`${moment.player} ${moment.round}`)
    );

    moments.sort((a, b) => a.messageIndex - b.messageIndex);

    return {
        available: true,
        handsRecorded,
        thinned,
        moments,
        toolbox: handsRecorded ? buildToolbox(replay, snapshots, context) : undefined
    };
}

/**
 * "You called a house that had almost nothing to do while another was full."
 *
 * Potential is what a house call could have acted on at the moment of the
 * choice: cards of that house in hand, plus ready unstunned creatures of it
 * already on the board. Compared only across the houses that were actually
 * callable, and only when the recording shows the pre-play hand.
 *
 * ## When a lopsided call is NOT flagged
 *
 * A thin call is often a good call, and the recording can recognise the
 * common reasons by itself:
 *
 *   - the choice was forced or restricted (v5 records `callableHouses`, so
 *     Control the Weak and friends stop being "misplays");
 *   - the archives held cards (their contents are facedown even to this
 *     review, so the potential arithmetic would be judging half a hand);
 *   - it worked - the turn forged a key mid-run, or earned at least as much
 *     amber as the fuller house had cards;
 *   - the opponent sat at check, and after this turn they did NOT forge -
 *     the call's job was denial, and denial is invisible to card counting.
 *     (A game that ended before their next turn counts as denied.)
 */
function houseCallMoment(run, index, { runs, cards, handCards, moments }) {
    if (run.round <= 1 || !run.house || !opensBeforePlay(run)) {
        return;
    }

    const hand = handAt(run.opening, run.player, handCards);
    const active = playerIn(run.opening.board, run.player);

    if (!hand || !active) {
        return;
    }

    // The archives are picked up on calling ANY house, so they feed every
    // house's potential. A v6 recording shows them to the review; older ones
    // only count them, and two or more unseen cards make the arithmetic
    // below a guess - those turns are not judged.
    const archive = archiveAt(run.opening, run.player, handCards);

    if (!archive && (active.cardPiles?.archives || []).length >= 2) {
        return;
    }

    if (run.forgedDuring) {
        // A key came out of the turn itself: the call produced the one thing
        // that wins games, whatever its card count was.
        return;
    }

    const candidates = (active.callableHouses || active.houses || [])
        .map((house) => String(house).toLowerCase())
        .filter((house) => HOUSES.has(house));

    if (candidates.length < 2 || !candidates.includes(run.house)) {
        return;
    }

    const opponent = (run.opening.board.players || []).find(
        (player) => player?.name !== run.player
    );

    if (opponent) {
        const opponentCost = Number.isFinite(opponent.stats?.keyCost) ? opponent.stats.keyCost : 6;

        if ((opponent.stats?.amber ?? 0) >= opponentCost) {
            // The opponent was at check, so this was an amber-control turn as
            // much as a card-count one. Keep the flag only when the check
            // came in anyway.
            const next = laterRunsOf(runs, index, opponent.name, 1)[0];
            const forgedAnyway =
                next && keysAt(next.opening, opponent.name) > keysAt(run.opening, opponent.name);

            if (!forgedAnyway) {
                return;
            }
        }
    }

    // Worth, not just count: a card is at least one action, plus any amber
    // its pips guarantee; a ready creature is a reap. All amber-flavoured
    // units, so "brobnar offered 2, shadows offered 6" compares like with
    // like.
    const potential = Object.fromEntries(candidates.map((house) => [house, 0]));
    const creditCards = (identities) => {
        for (const identity of identities) {
            for (const house of housesOf(identity)) {
                if (house in potential) {
                    potential[house] += cardWorth(identity);
                }
            }
        }
    };

    creditCards(hand);
    creditCards(archive || []);

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

    if (best !== null && run.amberGained >= potential[best]) {
        // The thin call out-earned the fuller house's worth (steals, board
        // swings - the recording cannot tell, and does not need to).
        return;
    }

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
 *
 * Not flagged when the recording can see it did not matter: a creature that
 * entered ready mid-turn (it did not have the whole turn), a creature whose
 * own text forbids reaping (card knowledge), and the winner's turn that
 * ended already at lethal - two keys forged, the third paid for - where
 * surplus reaps changed nothing.
 */
function unusedCreaturesMoment(run, { cards, winner, rolesFor, moments }) {
    if (run.round <= 1 || !run.house || run.mainFrames.length === 0) {
        return;
    }

    const last = run.mainFrames[run.mainFrames.length - 1];
    const active = playerIn(last.board, run.player);

    if (!active) {
        return;
    }

    if (
        winner === run.player &&
        keyCount(active.stats?.keys) === 2 &&
        (active.stats?.amber ?? 0) >=
            (Number.isFinite(active.stats?.keyCost) ? active.stats.keyCost : 6)
    ) {
        return;
    }

    // Only creatures that were on the board when the turn began had the whole
    // turn in which to act.
    const atStart = new Set(
        (playerIn(run.opening.board, run.player)?.cardPiles?.cardsInPlay || [])
            .map((entry) => entry?.uuid)
            .filter(Boolean)
    );
    const idle = [];

    for (const entry of active.cardPiles?.cardsInPlay || []) {
        const card = inPlayCard(entry, cards);

        if (
            card &&
            card.identity.type === 'creature' &&
            !card.exhausted &&
            !card.stunned &&
            housesOf(card.identity).has(run.house) &&
            (!entry.uuid || atStart.has(entry.uuid)) &&
            !rolesFor(card.identity.id).has(ROLES.CANNOT_REAP)
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
 * is sometimes right - and when it was, the recording usually shows it, so
 * those holds are not flagged:
 *
 *   - the held cards left the hand within the player's next two turns. That
 *     is what saving a card FOR something looks like; the plan ran, and the
 *     draws were its price, not a mistake.
 *   - every held card is an answer by its own text (a steal or capture, a
 *     board wipe, a key cheat). Holding answers is insurance, and insurance
 *     is not judged for going unclaimed.
 *   - the game ended before two more turns could happen. A plan cut short by
 *     the game ending is unjudgeable, and gets the benefit of the doubt.
 *   - the winner ended this turn already at lethal - the refill no longer
 *     mattered.
 *
 * A hold that is still sitting in hand two turns later is the one that gets
 * flagged: it cost the draws AND never became a play.
 */
function heldCardsMoment(run, index, { runs, handCards, winner, rolesFor, moments }) {
    if (run.round <= 1 || !run.house || run.mainFrames.length === 0) {
        return;
    }

    const last = run.mainFrames[run.mainFrames.length - 1];
    const entries = last?.hands?.[run.player];
    const active = playerIn(last.board, run.player);

    if (!Array.isArray(entries) || !active) {
        return;
    }

    if (
        winner === run.player &&
        keyCount(active.stats?.keys) === 2 &&
        (active.stats?.amber ?? 0) >=
            (Number.isFinite(active.stats?.keyCost) ? active.stats.keyCost : 6)
    ) {
        return;
    }

    // Held entries tracked by hand-table index, so the same cards can be
    // recognised in later frames; duplicates are tracked by count.
    const heldCounts = new Map();

    for (const entry of entries) {
        const identity = Number.isInteger(entry) ? handCards[entry] : null;

        if (identity && housesOf(identity).has(run.house)) {
            heldCounts.set(entry, (heldCounts.get(entry) || 0) + 1);
        }
    }

    const held = [...heldCounts.entries()].flatMap(([entry, count]) =>
        Array(count).fill(handCards[entry])
    );
    const handSize = entries.length;
    const chains = active.stats?.chains ?? 0;
    const refillTarget = Math.max(0, HAND_REFILL - Math.ceil(chains / 6));
    const missedDraws = Math.max(0, Math.min(held.length, refillTarget - (handSize - held.length)));

    if (missedDraws < HELD_CARDS_MIN_MISSED) {
        return;
    }

    // The insurance test: a hold made of nothing but answers - steals and
    // captures, board wipes, key cheats, by the cards' own text - is a
    // stance, not a slip, whether or not the threat ever came.
    const ANSWER_ROLES = [ROLES.AMBER_CONTROL, ROLES.BOARD_WIPE, ROLES.KEY_CHEAT];

    if (
        held.length > 0 &&
        held.every((identity) => {
            const roles = rolesFor(identity.id);

            return ANSWER_ROLES.some((role) => roles.has(role));
        })
    ) {
        return;
    }

    // The plan test. No later turns to look at means the game ended first.
    const later = laterRunsOf(runs, index, run.player, 2);

    if (later.length === 0) {
        return;
    }

    for (const laterRun of later) {
        const frame = laterRun.mainFrames[laterRun.mainFrames.length - 1] || laterRun.closing;
        const laterEntries = frame?.hands?.[run.player];

        if (!Array.isArray(laterEntries)) {
            // The trail goes cold (a thinned stretch, a hand not recorded):
            // continuity cannot be claimed, so nothing is.
            return;
        }

        const laterCounts = new Map();

        for (const entry of laterEntries) {
            laterCounts.set(entry, (laterCounts.get(entry) || 0) + 1);
        }

        for (const [entry, count] of heldCounts) {
            if ((laterCounts.get(entry) || 0) < count) {
                // Part of the hold got played or spent: it was a plan.
                return;
            }
        }
    }

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

/**
 * "The answer was in your hand."
 *
 * The card-knowledge moment, and the closest this review comes to "what if
 * you had played differently" - held to the same hindsight bar as everything
 * else. It fires only when ALL of these line up:
 *
 *   - a named threat existed when the turn began: the opponent at check, or
 *     their board four-plus creatures wider than yours;
 *   - a card whose own text answers that kind of threat (a steal or capture
 *     for a check, a board wipe for a board) sat in the player's hand or
 *     recorded archives, in a house that was legally callable;
 *   - the player either called a different house, or called the card's house
 *     and still had it in hand when the turn ended;
 *   - and the threat then LANDED - the opponent forged, or their board was
 *     still that wide at the player's next turn. An answer withheld against
 *     a threat that never materialised was a read, not a miss.
 *
 * Phrased by every consumer as availability, never as outcome: the card's
 * condition or cost may not have been meetable, and the review knows it
 * cannot know. One moment per card per game - a threat that persists must
 * not flag the same held answer turn after turn. When this fires, the
 * generic house-call moment for the same turn is dropped in its favour.
 */
function answerHeldMoments(run, index, context) {
    const { runs, cards, handCards, rolesFor, answeredCards, moments } = context;

    if (run.round <= 1 || !run.house || !opensBeforePlay(run)) {
        return;
    }

    const active = playerIn(run.opening.board, run.player);
    const opponent = (run.opening.board.players || []).find(
        (player) => player?.name !== run.player
    );
    const hand = handAt(run.opening, run.player, handCards);

    if (!active || !opponent || !hand) {
        return;
    }

    const candidates = (active.callableHouses || active.houses || [])
        .map((house) => String(house).toLowerCase())
        .filter((house) => HOUSES.has(house));

    if (candidates.length === 0) {
        return;
    }

    const creaturesOf = (entry) =>
        (entry?.cardPiles?.cardsInPlay || []).filter(
            (pileEntry) => inPlayCard(pileEntry, cards)?.identity?.type === 'creature'
        ).length;

    // The threats the review can name, each with its own "did it land".
    const pressures = [];
    const opponentCost = Number.isFinite(opponent.stats?.keyCost) ? opponent.stats.keyCost : 6;

    if ((opponent.stats?.amber ?? 0) >= opponentCost) {
        const next = laterRunsOf(runs, index, opponent.name, 1)[0];

        if (next && keysAt(next.opening, opponent.name) > keysAt(run.opening, opponent.name)) {
            pressures.push({ kind: 'check', role: ROLES.AMBER_CONTROL });
        }
    }

    const boardGap = creaturesOf(opponent) - creaturesOf(active);

    if (boardGap >= ANSWER_BOARD_GAP) {
        // Landed = the gap was still there when the player's next turn began;
        // a board that got answered some other way (or crashed in) does not
        // count against the wipe that stayed in hand.
        const next = laterRunsOf(runs, index, run.player, 1)[0];
        const nextGap = next
            ? creaturesOf(playerIn(next.opening.board, opponent.name)) -
              creaturesOf(playerIn(next.opening.board, run.player))
            : 0;

        if (nextGap >= ANSWER_BOARD_GAP) {
            pressures.push({ kind: 'board', role: ROLES.BOARD_WIPE });
        }
    }

    if (pressures.length === 0) {
        return;
    }

    // What was still in hand when the turn ended, for the "had the chance all
    // turn" variant.
    const lastMain = run.mainFrames[run.mainFrames.length - 1];
    const endEntries = lastMain?.hands?.[run.player];
    const endCounts = new Map();

    for (const entry of endEntries || []) {
        endCounts.set(entry, (endCounts.get(entry) || 0) + 1);
    }

    const zones = [
        { identities: hand, fromArchives: false },
        { identities: archiveAt(run.opening, run.player, handCards) || [], fromArchives: true }
    ];

    for (const pressure of pressures) {
        for (const zone of zones) {
            for (const identity of zone.identities) {
                if (!identity?.id || answeredCards.has(`${run.player} ${identity.id}`)) {
                    continue;
                }

                if (!rolesFor(identity.id).has(pressure.role)) {
                    continue;
                }

                const cardHouses = [...housesOf(identity)];
                const callable = cardHouses.filter((house) => candidates.includes(house));

                if (callable.length === 0) {
                    continue;
                }

                const houseWasCalled = callable.includes(run.house);
                const stillHeld =
                    !zone.fromArchives &&
                    Array.isArray(endEntries) &&
                    (endCounts.get(handCards.indexOf(identity)) || 0) > 0;

                // Two chances to have missed: called another house entirely
                // (the card never became playable), or called its house and
                // ended the turn with it still in hand. An archive card whose
                // house WAS called is skipped - whether it was even picked up
                // is not recorded, and a guess is not a flag.
                if (houseWasCalled && !stillHeld) {
                    continue;
                }

                answeredCards.add(`${run.player} ${identity.id}`);
                moments.push({
                    type: 'answer-held',
                    player: run.player,
                    round: run.round,
                    turn: playerTurnAt(run.opening, run.player),
                    messageIndex: run.opening.messageIndex,
                    house: run.house,
                    pressure: pressure.kind,
                    card: {
                        id: identity.id,
                        name: identity.name,
                        house: callable[0]
                    },
                    fromArchives: zone.fromArchives,
                    houseWasCalled
                });
            }
        }
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
                const streak = streaks.get(key);

                // A streak that ends because the house finally got called is
                // judged by what the call produced: a forge or a big amber
                // turn means those cards were being assembled, not stuck -
                // holding was the plan, and the plan paid. A weak resolution
                // keeps the flag: the wait cost turns and bought nothing.
                if (
                    streak &&
                    house === run.house &&
                    (run.forgedDuring || run.amberGained >= CLOG_PAYOFF_AMBER)
                ) {
                    streaks.delete(key);

                    continue;
                }

                flush(streak);
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
 * "What this deck actually showed, house by house."
 *
 * The strategy half of the card knowledge: a functional profile of each
 * player's deck as this game revealed it, read at the final frame across
 * every zone the review can see - board, discard, purged, and the owner's
 * hand and archives. Worth per house (cards and pips) says where the amber
 * lives; the role counts say which house holds the steals, the wipes and the
 * key cheats - which is the reading a player plans house calls with.
 *
 * Counted with multiplicity (two Urchins are two steals), and a card counts
 * for every house it can be played under, because that is what a house call
 * weighs. It is "as revealed", not the decklist: cards still in the deck at
 * game end are not in it, and it says so in the UI.
 */
function buildToolbox(replay, snapshots, { cards, handCards, rolesFor }) {
    const last = snapshots[snapshots.length - 1];

    if (!last?.board) {
        return undefined;
    }

    const toolbox = {};

    for (const player of last.board.players || []) {
        if (!player?.name) {
            continue;
        }

        const houses = {};

        const credit = (identity) => {
            if (!identity) {
                return;
            }

            const roles = rolesFor(identity.id);

            for (const house of housesOf(identity)) {
                const entry = (houses[house] = houses[house] || {
                    cards: 0,
                    pips: 0,
                    amberControl: 0,
                    boardWipes: 0,
                    keyCheats: 0
                });

                entry.cards++;
                entry.pips += Number.isFinite(identity.amber) ? identity.amber : 0;
                entry.amberControl += roles.has(ROLES.AMBER_CONTROL) ? 1 : 0;
                entry.boardWipes += roles.has(ROLES.BOARD_WIPE) ? 1 : 0;
                entry.keyCheats += roles.has(ROLES.KEY_CHEAT) ? 1 : 0;
            }
        };

        // The open piles as the game ended. Board archives stay out: they
        // are facedown there, and the owner's real view is credited below.
        for (const pile of ['cardsInPlay', 'discard', 'purged']) {
            for (const entry of player.cardPiles?.[pile] || []) {
                credit(inPlayCard(entry, cards)?.identity);
            }
        }

        for (const identity of handAt(last, player.name, handCards) || []) {
            credit(identity);
        }

        for (const identity of archiveAt(last, player.name, handCards) || []) {
            credit(identity);
        }

        toolbox[player.name] = { houses };
    }

    return toolbox;
}

/**
 * The review as one player may read it: their own moments and toolbox only.
 * The moments are computed over both hands, but what the opponent held - and
 * what they did not do with it - is not this account's to see. `null` keeps
 * everything, which is the admin read.
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
        moments: (misplays.moments || []).filter((moment) => moment.player === playerName),
        ...(misplays.toolbox
            ? {
                  toolbox: misplays.toolbox[playerName]
                      ? { [playerName]: misplays.toolbox[playerName] }
                      : {}
              }
            : {})
    };
}

module.exports = { findMisplays, filterMisplaysTo, housesOf };
