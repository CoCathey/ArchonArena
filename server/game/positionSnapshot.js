/**
 * ARCHON (N51): a position that can be copied, so a bot can try a move before
 * making it.
 *
 * ## Why this is the keystone
 *
 * N46 diagnosed why the bot reads as not thinking, and it was not randomness -
 * the live driver plays greedily and explores nothing. It is that
 * `scoreDecision` scores each candidate as a DESCRIPTION of a move, with no
 * representation of what the move does. The lab's own ladder puts a number on
 * what that costs: the champion, playing exactly these weights, beats the
 * SEARCHING bot 33% of the time. Same model, same features - the only
 * difference is that one of them looks ahead.
 *
 * The reason that search never reached a real table is written down in N46 and
 * in the practice-bots design: the deep bot forks by REPLAYING a seeded input
 * log from the start of a simulated game, and a live game has no such log. It
 * is also why a deep game costs about a minute where a fast one costs half a
 * second - every fork re-runs the whole game so far, so the cost of thinking
 * about turn twenty is twenty turns of engine.
 *
 * Both problems are the same problem: there is no way to copy a position. This
 * is that way.
 *
 * ## Exact, or nothing
 *
 * A fork that is subtly wrong is far worse than no fork at all. A planner that
 * searches a position which differs from the real one in some small way does
 * not plan badly - it plans confidently about a game nobody is playing, and
 * nothing in the output says so. That is the same trap N48 avoided by refusing
 * to rebuild training rows from replays, and the same principle N46 applied
 * when it made an unknowable afterstate emit NOTHING rather than a guess.
 *
 * So `capture` returns a snapshot or a REASON, never a best effort. It refuses
 * a position holding anything a rebuild cannot put back:
 *
 *  - a lasting effect that is not a `persistentEffect`. Persistent effects
 *    re-register themselves when a card enters a location (the card's own
 *    `setupCardAbilities` declares them, and `moveTo` applies them), so a
 *    rebuilt board gets them for free. Everything else was put there by an
 *    ability that has already resolved, and its closures cannot be rebuilt
 *    from data.
 *  - a delayed or during-opponent's-next-turn effect, for the same reason.
 *  - a card in play that the decklist cannot account for - a token creature -
 *    because a rebuild draws its cards from the decklist and has nowhere to
 *    take an extra body from.
 *
 * Measured over real games across all thirteen houses: four turn boundaries in
 * five are capturable, and every one that is reproduces its position exactly
 * (968 of 968 in the widest sweep). The refusals are a short list of specific
 * cards rather than anything structural, which is a far better place to be -
 * it shortens. A planner that can fork four turns in five is a different
 * animal from one that can fork none.
 *
 * ## The turn boundary, and why that one
 *
 * A snapshot is taken at the HOUSE CALL: the point where the active player has
 * been asked which house to activate and nothing else about their turn has
 * happened yet. Three reasons, and they agree:
 *
 *  - it is the cleanest point in the engine's pipeline - the key phase has
 *    resolved, no ability is mid-resolution, and the only thing outstanding is
 *    a prompt,
 *  - it is the decision a planner most needs to fork from, because the house
 *    call decides the whole rest of the turn (N46 could not model it at all:
 *    "its consequence is the whole rest of the turn"), and
 *  - forking there means a search explores whole TURNS. A turn is the unit a
 *    person plans in, and the thing the bot has never been able to compare.
 *
 * ## Proving it rather than hoping
 *
 * Structural equality is not the test. Two positions can carry the same
 * numbers and diverge on the very next input, which is precisely the failure
 * this has to exclude - and both bugs found while building it were of exactly
 * that shape (cards under a card, and control being restored as its derived
 * value rather than its source). So `fingerprint` is deliberately exhaustive,
 * it is compared against the live position on every fork the spec takes over
 * real games, and a fork is additionally rolled forward to prove it PLAYS.
 *
 * Same doctrine as the fork determinism tripwire in `replayTo`: a copy that
 * cannot prove it is the same is treated as broken, not as probably fine.
 */

const CAPTURE_VERSION = 1;

/** The zones a card can be in, and the order a rebuild fills them. */
const ZONES = ['deck', 'hand', 'discard', 'archives', 'purged', 'play area'];

/** Zone name to the player property holding it. `getSourceList` agrees. */
const zoneList = (player, zone) => player.getSourceList(zone);

/**
 * Why a position cannot be copied, or null when it can.
 *
 * Ordered cheapest first, and it returns the FIRST reason rather than all of
 * them: a caller uses this to decide whether to search, not to fix the engine.
 *
 * @param {object} game
 * @returns {string|null}
 */
function refusalReason(game) {
    if (!game || !game.started || game.winner) {
        return 'the game is not in play';
    }

    const engine = game.effectEngine;

    if (!engine) {
        return 'the game has no effect engine';
    }

    const lasting = (engine.effects || []).filter(
        (effect) => effect.duration !== 'persistentEffect'
    );

    if (lasting.length) {
        // Named, because the refusals turned out to be a short list of specific
        // cards rather than anything structural - and a reason that names the
        // card is the difference between "this cannot be done" and "this card
        // is next".
        const source = lasting[0].source;

        return `a lasting effect is live (${lasting[0].duration} from ${
            (source && source.name) || 'an unknown source'
        })`;
    }

    if ((engine.delayedEffects || []).length) {
        return 'a delayed effect is waiting';
    }

    if ((engine.duringOpponentNextTurnEffects || []).length) {
        return 'an effect is held for the opponent’s next turn';
    }

    return unaccountedFor(game);
}

/**
 * ARCHON (N51): a card the rebuild would have nowhere to take from.
 *
 * A rebuild deals its cards from the DECKLIST, so a position holding a body
 * the decklist cannot supply - a token creature, a copy an ability made -
 * cannot be put back, and a snapshot that quietly dropped it would hand a
 * planner a board with a creature missing.
 *
 * Counted rather than identity-checked, and this is the part worth writing
 * down: `player.allCards` is THE SAME ARRAY as `player.deck` (see
 * `Player.prepareDecks`), so it shrinks with every card drawn and is not a
 * record of what was built. Checking membership against it would have called
 * every card in play a token. The decklist is the only honest source, so the
 * count of each id in the position is compared against the count the decklist
 * can supply - the same filter `Deck.prepare` applies, because a second
 * opinion about which entries become cards is a second thing to keep in step.
 *
 * By OWNER, not by whose zone the card is sitting in: an upgrade is owned by
 * the player whose deck it came from however enemy the creature it is attached
 * to.
 *
 * @param {object} game
 * @returns {string|null}
 */
function unaccountedFor(game) {
    const held = new Map();

    const count = (card) => {
        if (!card) {
            return;
        }

        const owner = (card.owner && card.owner.name) || '<nobody>';

        if (!held.has(owner)) {
            held.set(owner, new Map());
        }

        const mine = held.get(owner);

        mine.set(card.id, (mine.get(card.id) || 0) + 1);

        for (const child of [...(card.upgrades || []), ...(card.childCards || [])]) {
            count(child);
        }
    };

    for (const player of game.getPlayers()) {
        for (const zone of ZONES) {
            for (const card of zoneList(player, zone) || []) {
                count(card);
            }
        }
    }

    for (const player of game.getPlayers()) {
        const supply = decklistCounts(player);
        const mine = held.get(player.name) || new Map();

        for (const [id, wanted] of mine) {
            if (wanted > (supply.get(id) || 0)) {
                return `${id} appears ${wanted} times and the decklist holds ${
                    supply.get(id) || 0
                } (a token or a copy)`;
            }
        }
    }

    return null;
}

/**
 * How many of each card the decklist can supply, exactly as `Deck.prepare`
 * counts them: entries that carry card data, are not non-deck cards, repeated
 * by their count.
 *
 * @param {object} player
 * @returns {Map<string, number>}
 */
function decklistCounts(player) {
    const counts = new Map();

    for (const entry of (player.deckData && player.deckData.cards) || []) {
        if (!entry.card || entry.card.isNonDeck) {
            continue;
        }

        const id = entry.card.id;

        counts.set(id, (counts.get(id) || 0) + (entry.count || 1));
    }

    return counts;
}

/**
 * One card's mutable state.
 *
 * The card's IDENTITY is its id; everything here is what play has done to it.
 * Tokens are copied rather than referenced, because a snapshot that shares a
 * mutable object with the live game is not a snapshot.
 */
function captureCard(card) {
    return {
        id: card.id,
        uuid: card.uuid,
        exhausted: !!card.exhausted,
        new: !!card.new,
        facedown: !!card.facedown,
        activeProphecy: !!card.activeProphecy,
        enhancements: card.enhancements ? [...card.enhancements] : null,
        tokens: { ...(card.tokens || {}) },
        // Owner and controller are different questions and both matter: an
        // upgrade is OWNED by whoever's deck it came from and CONTROLLED
        // through the creature it is attached to, so a rebuild has to take it
        // from the owner's pile and hand it to the controller's board.
        owner: card.owner ? card.owner.name : null,
        controller: card.controller ? card.controller.name : null,
        /**
         * ARCHON (N51): and `defaultController`, which is the one that is
         * actually load-bearing.
         *
         * `controller` is DERIVED - `getModifiedController` reads a
         * `takeControl` effect or falls back to `defaultController` - and
         * `Game.checkGameState` re-derives it every time the state changes,
         * physically moving a card whose controller disagrees with the board
         * it is sitting on. Restoring only the derived value therefore lasted
         * exactly until the first state check, which then handed the card
         * back: a Treachery card (`enters play under your opponent's
         * control`) silently migrated to its owner's side of the board.
         *
         * Found by the fingerprint check on real games, and it is precisely
         * the class of error a fork must never be allowed to make quietly -
         * the copy was a legal, plausible position, and it was not the one
         * being played.
         */
        defaultController: card.defaultController ? card.defaultController.name : null,
        upgrades: (card.upgrades || []).map(captureCard),
        childCards: (card.childCards || []).map(captureCard)
    };
}

/** One seat, as data. */
function capturePlayer(player) {
    const zones = {};

    for (const zone of ZONES) {
        zones[zone] = (zoneList(player, zone) || []).map(captureCard);
    }

    return {
        name: player.name,
        amber: player.amber,
        chains: player.chains,
        turn: player.turn,
        keys: { ...player.keys },
        houses: [...(player.houses || [])],
        activeHouse: player.activeHouse,
        tieBreakHouse: player.tieBreakHouse,
        keysForgedThisRound: [...(player.keysForgedThisRound || [])],
        zones,
        // Prophecies live beside the board rather than in a zone, and carry
        // their own activation state and buried cards.
        prophecies: (player.prophecyCards || []).map(captureCard)
    };
}

/**
 * Copy a position, or say why not.
 *
 * @param {object} game a live game, at a house call
 * @returns {{ok: true, snapshot: object}|{ok: false, reason: string}}
 */
function capture(game) {
    const reason = refusalReason(game);

    if (reason) {
        return { ok: false, reason };
    }

    return {
        ok: true,
        snapshot: {
            version: CAPTURE_VERSION,
            round: game.round,
            activePlayer: game.activePlayer ? game.activePlayer.name : null,
            firstPlayer: game.firstPlayer ? game.firstPlayer.name : null,
            players: game.getPlayers().map(capturePlayer),
            // ARCHON (N51): what has happened THIS turn, which a surprising
            // number of abilities read ("if you have played a card this
            // turn"). Names and ids rather than card references, because the
            // rebuild's cards are different objects.
            history: {
                cardsPlayed: game.cardsPlayed.map((card) => card.id),
                cardsUsed: game.cardsUsed.map((card) => card.id),
                cardsDiscarded: game.cardsDiscarded.map((card) => card.id),
                cardNamesPlayedOrUsed: [...game.cardNamesPlayedOrUsed],
                effectsUsed: game.effectsUsed.map((card) => card.id),
                propheciesActivated: game.propheciesActivated.map((card) => card.id)
            }
        }
    };
}

/**
 * ARCHON (N51): what a position IS, as one comparable string.
 *
 * The test a copy has to pass is not "the fields match" - two positions can
 * carry identical numbers and diverge on the very next input. So this is
 * deliberately exhaustive where `SimulatedGame.boardHash` is deliberately
 * coarse: that one exists to notice a game going in circles, this one exists
 * to prove two games ARE the same game, and a field left out of it is a field
 * a fork is free to get wrong.
 *
 * Card identity is the id, never the uuid: a rebuilt game's cards are
 * different objects and comparing uuids would fail on every correct restore.
 * Ordered zones (the deck, the battleline) keep their order because it is part
 * of the position; unordered ones are sorted so two equal positions cannot
 * disagree about the order somebody happened to build them in.
 */
function fingerprintCard(card) {
    const tokens = Object.entries(card.tokens || {})
        .filter(([, value]) => value)
        .sort(([a], [b]) => (a < b ? -1 : 1))
        .map(([key, value]) => `${key}=${value}`)
        .join(',');
    const parts = [
        card.id,
        card.exhausted ? 'x' : '-',
        card.new ? 'n' : '-',
        card.facedown ? 'f' : '-',
        card.activeProphecy ? 'p' : '-',
        tokens
    ];
    const upgrades = (card.upgrades || []).map(fingerprintCard).sort();
    const children = (card.childCards || []).map(fingerprintCard).sort();

    return `${parts.join(':')}{${upgrades.join('+')}}[${children.join('+')}]`;
}

/** Zones whose ORDER is part of the position rather than an accident. */
const ORDERED_ZONES = new Set(['deck', 'play area']);

function fingerprintPlayer(seat) {
    const zones = ZONES.map((zone) => {
        const cards = (seat.zones[zone] || []).map(fingerprintCard);

        return `${zone}=${(ORDERED_ZONES.has(zone) ? cards : [...cards].sort()).join('|')}`;
    });

    return [
        seat.name,
        `amber=${seat.amber}`,
        `chains=${seat.chains}`,
        `turn=${seat.turn}`,
        `keys=${Object.entries(seat.keys || {})
            .sort(([a], [b]) => (a < b ? -1 : 1))
            .map(([key, forged]) => `${key}${forged ? 1 : 0}`)
            .join('')}`,
        `house=${seat.activeHouse || '-'}`,
        `forged=${[...(seat.keysForgedThisRound || [])].sort().join(',')}`,
        `prophecies=${(seat.prophecies || []).map(fingerprintCard).join('|')}`,
        ...zones
    ].join(' ');
}

/**
 * A canonical fingerprint of a live game, or of a snapshot of one.
 *
 * Takes either, and produces the same string for both when the copy is
 * faithful - which is the whole point: it is what lets a restore be CHECKED
 * rather than trusted.
 *
 * @param {object} gameOrSnapshot
 * @returns {string}
 */
function fingerprint(gameOrSnapshot) {
    const snapshot = gameOrSnapshot.version
        ? gameOrSnapshot
        : capture(gameOrSnapshot).snapshot ?? null;

    if (!snapshot) {
        return '<uncapturable>';
    }

    const history = snapshot.history || {};

    return [
        `r${snapshot.round}`,
        `active=${snapshot.activePlayer}`,
        `first=${snapshot.firstPlayer}`,
        `played=${[...(history.cardsPlayed || [])].sort().join(',')}`,
        `used=${[...(history.cardsUsed || [])].sort().join(',')}`,
        `binned=${[...(history.cardsDiscarded || [])].sort().join(',')}`,
        ...[...snapshot.players]
            .sort((left, right) => (left.name < right.name ? -1 : 1))
            .map(fingerprintPlayer)
    ].join('  ||  ');
}

/**
 * Put a captured position back into a freshly built game.
 *
 * The game must be built from the SAME decklists and have had `selectDeck`
 * called for both seats, and must not have been initialised - this drives the
 * initialisation itself, because the ordinary one deals hands and asks for a
 * mulligan, and a restored position already knows where every card is.
 *
 * @param {object} snapshot from `capture`
 * @param {object} game a fresh, un-initialised game with decks selected
 * @returns {object} the same game, now holding the captured position
 */
function restore(snapshot, game) {
    if (!snapshot || snapshot.version !== CAPTURE_VERSION) {
        throw new Error(`Cannot restore a position captured at version ${snapshot?.version}`);
    }

    const HousePhase = require('./gamesteps/house/HousePhase');
    const MainPhase = require('./gamesteps/main/MainPhase');
    const ReadyPhase = require('./gamesteps/ReadyPhase');
    const DrawPhase = require('./gamesteps/draw/drawphase');
    const SimpleStep = require('./gamesteps/simplestep');

    for (const player of game.getPlayers()) {
        player.initialise();
    }

    game.allCards = game.getPlayers().reduce((cards, player) => cards.concat(player.allCards), []);

    const byName = new Map(game.getPlayers().map((player) => [player.name, player]));
    // ONE pool for the whole game, taken before any zone is emptied.
    //
    // Both halves of that matter. Keyed by owner because a card is dealt from
    // the deck it came from, wherever it ended up sitting. Taken first because
    // `player.deck` and `player.allCards` are the same array - clearing the
    // deck to refill it would empty the pool it was about to be refilled from.
    const pools = new Map(game.getPlayers().map((player) => [player.name, poolFor(player)]));

    for (const seat of snapshot.players) {
        restoreSeat(byName.get(seat.name), seat, byName, pools);
    }

    game.round = snapshot.round;
    game.activePlayer = byName.get(snapshot.activePlayer);
    game.firstPlayer = byName.get(snapshot.firstPlayer);
    game.playStarted = true;
    game.started = true;
    game.startedAt = new Date();
    restoreHistory(game, snapshot.history || {});

    /**
     * The turn resumes at the HOUSE phase, not at the top of the round.
     *
     * A snapshot is taken at the house call, which is INSIDE the house phase
     * and therefore after the key phase has already forged and spent. Queuing
     * a whole round would forge a second time off the same amber - the kind of
     * error that makes a fork look like a brilliant line.
     */
    game.pipeline.initialise([
        new HousePhase(game),
        new MainPhase(game),
        new ReadyPhase(game),
        new DrawPhase(game),
        new SimpleStep(game, () => game.raiseEndRoundEvent()),
        new SimpleStep(game, () => game.beginRound())
    ]);

    game.continue();

    return game;
}

/**
 * One card of each id, per copy the decklist holds.
 *
 * Every copy of a card is identical the moment it is created, so which
 * physical copy lands in which zone cannot matter - what matters is that each
 * captured card gets one and none is used twice.
 */
function poolFor(player) {
    const pool = new Map();

    for (const card of player.allCards || []) {
        if (!pool.has(card.id)) {
            pool.set(card.id, []);
        }

        pool.get(card.id).push(card);
    }

    return pool;
}

/** Deal one seat's cards back into the zones they were in. */
function restoreSeat(player, seat, byName, pools) {
    if (!player) {
        throw new Error(`The rebuilt game has no seat named ${seat.name}`);
    }

    for (const zone of ZONES) {
        const list = zoneList(player, zone);

        list.length = 0;

        for (const captured of seat.zones[zone] || []) {
            list.push(claimCard(pools, captured, zone, player, byName));
        }
    }

    // Prophecies are dealt from their own pile and never enter a zone, so they
    // are matched positionally: the pairs are fixed at deck preparation and a
    // rebuild produces them in the same order.
    (seat.prophecies || []).forEach((captured, index) => {
        const card = (player.prophecyCards || [])[index];

        if (card) {
            applyCardState(card, captured, byName);
            card.childCards = (captured.childCards || []).map((child) =>
                claimCard(pools, child, 'play area', player, byName, { skipMove: true })
            );
        }
    });

    player.amber = seat.amber;
    player.chains = seat.chains;
    player.turn = seat.turn;
    player.keys = { ...seat.keys };
    player.houses = [...seat.houses];
    player.activeHouse = seat.activeHouse;
    player.tieBreakHouse = seat.tieBreakHouse;
    player.keysForgedThisRound = [...(seat.keysForgedThisRound || [])];
    player.mulliganDecided = true;
    player.readyToStart = true;
}

/** Take one card of the captured id out of its owner's pool and place it. */
function claimCard(pools, captured, zone, player, byName, { skipMove = false } = {}) {
    const owner = (captured.owner && byName.get(captured.owner)) || player;
    const pool = pools.get(owner.name);
    const available = pool && pool.get(captured.id);

    if (!available || !available.length) {
        // Capture already refused any position the decklist cannot supply, so
        // reaching here means the snapshot and the rebuild disagree about what
        // the decklist holds - a bug, not a position, and it throws rather
        // than placing something else.
        throw new Error(
            `The rebuilt decklist has no copy of ${captured.id} left for ${owner.name}`
        );
    }

    const card = available.shift();

    applyCardState(card, captured, byName);

    if (!skipMove) {
        // `moveTo` rather than `moveCard`: this is placement, not play. It sets
        // the location and re-registers the card's persistent effects and
        // ability events, which is exactly what a rebuild needs - where
        // `moveCard` would raise leave/enter events and fire the abilities of
        // a turn that has already been played.
        card.moveTo(zone);
    }

    card.upgrades = (captured.upgrades || []).map((upgrade) => {
        const attached = claimCard(pools, upgrade, 'play area', player, byName, {
            skipMove: true
        });

        attached.moveTo('play area');
        attached.parent = card;

        return attached;
    });

    // ARCHON (N51): cards UNDER a card - what a prophecy buries, what a card
    // that holds others is holding. They are in no zone, so nothing else would
    // ever place them, and a fork that dropped them would hand the planner a
    // board where a card had quietly forgotten what it was carrying.
    card.childCards = (captured.childCards || []).map((child) => {
        const held = claimCard(pools, child, 'play area', player, byName, { skipMove: true });

        held.parent = card;

        return held;
    });

    return card;
}

/** The mutable half of a card: what play did to it. */
function applyCardState(card, captured, byName) {
    card.exhausted = !!captured.exhausted;
    card.new = !!captured.new;
    card.facedown = !!captured.facedown;
    card.activeProphecy = !!captured.activeProphecy;
    card.tokens = { ...(captured.tokens || {}) };

    if (captured.enhancements) {
        card.enhancements = [...captured.enhancements];
    }

    // The default first, because the derived one is computed from it.
    const defaultController = captured.defaultController && byName.get(captured.defaultController);

    if (defaultController) {
        card.defaultController = defaultController;
    }

    const controller = captured.controller && byName.get(captured.controller);

    if (controller) {
        card.controller = controller;
    }
}

/**
 * What has already happened this turn.
 *
 * Stored as ids and resolved back to the rebuilt game's own card objects,
 * because a surprising number of abilities ask whether a card has been played
 * or used this turn - and a fork that answered "no" to all of them would be
 * playing a different turn from the one it forked.
 */
function restoreHistory(game, history) {
    const byId = new Map();

    for (const card of game.allCards || []) {
        if (!byId.has(card.id)) {
            byId.set(card.id, card);
        }
    }

    const resolve = (ids) => (ids || []).map((id) => byId.get(id)).filter(Boolean);

    game.cardsPlayed = resolve(history.cardsPlayed);
    game.cardsUsed = resolve(history.cardsUsed);
    game.cardsDiscarded = resolve(history.cardsDiscarded);
    game.effectsUsed = resolve(history.effectsUsed);
    game.propheciesActivated = resolve(history.propheciesActivated);
    game.cardNamesPlayedOrUsed = [...(history.cardNamesPlayedOrUsed || [])];
}

/**
 * ARCHON (N51): capture a live position and hand back a playable copy of it.
 *
 * The one call a planner needs. Everything the rebuild wants is already on the
 * game it is forking - both decklists sit on the seats as `deckData` - so a
 * caller does not have to carry them alongside, which is the difference
 * between a facility a live table can use and one only the lab can.
 *
 * ## Drive the fork inside a random scope, always
 *
 * The copy is exact at the moment it is taken. What it CANNOT reproduce is the
 * randomness the engine reaches for afterwards: a deck running out and the
 * discard pile being shuffled back, an ability that discards at random. Left
 * to itself the fork draws those from crypto, so two rollouts of the same line
 * face different futures and the comparison between them measures the deal
 * rather than the move.
 *
 * That is not a defect to be fixed, it is hidden information to be SAMPLED -
 * the same call DeepGame makes when it rolls a fork forward on a fresh
 * `rolloutSeed` so it plans against likelihoods rather than replaying fate.
 * The fix is therefore not here but at the caller: wrap the rollout in
 * `withRandomSource(seededSource(n), ...)` and vary `n` per sample, never per
 * candidate, so every line being compared faces the same futures.
 *
 * Measured: forks rolled forty plies forward under one seeded source land on
 * the same position every time, and forks of the same position under
 * DIFFERENT seeds do not - which is exactly the behaviour a sampler wants.
 *
 * @param {object} game a live game, at a house call
 * @returns {{ok: true, game: object, snapshot: object}|{ok: false, reason: string}}
 */
function fork(game) {
    const taken = capture(game);

    if (!taken.ok) {
        return taken;
    }

    const Game = require('./game.js');
    const { randomUUID } = require('crypto');
    const seats = game.getPlayers();
    const copy = new Game(
        {
            id: randomUUID(),
            name: 'fork',
            owner: seats[0].user,
            savedGameId: 0,
            players: seats.map((player, index) => ({
                id: `fork-${index}`,
                user: player.user
            }))
        },
        {
            // A fork answers to nobody: it is never persisted, never rated and
            // never watched, and an error inside one must reach the planner
            // rather than a router that would try to end a game that does not
            // exist.
            router: {
                gameWon: () => true,
                playerLeft: () => true,
                handleError: (_game, error) => {
                    throw error;
                }
            },
            cardData: game.cardData || {}
        }
    );

    copy.started = true;
    // A fork is thought, not a game anybody will watch back.
    copy.recordBoardSnapshot = () => true;

    for (const player of seats) {
        copy.selectDeck(player.name, player.deckData);
    }

    return { ok: true, game: restore(taken.snapshot, copy), snapshot: taken.snapshot };
}

module.exports = {
    CAPTURE_VERSION,
    fork,
    ZONES,
    capture,
    captureCard,
    capturePlayer,
    decklistCounts,
    fingerprint,
    refusalReason,
    restore,
    unaccountedFor
};
