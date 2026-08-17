const logger = require('../../log');
const { findMisplays, filterMisplaysTo } = require('./replayMisplays');
const { winProbabilityCurve } = require('./replayValue');
const BotPolicyService = require('../championschallenge/BotPolicyService');

/**
 * ARCHON (N12): replay analysis - the Archon tier's `advanced_replays`.
 *
 * ## What this is, and what it deliberately is not
 *
 * Stepping through a replay is free for everyone and always will be. What is
 * sold here is the reading of it: the shape of the game as numbers, so a player
 * can answer "where did that game actually go wrong" without scrubbing a
 * 300-entry log and counting amber by eye.
 *
 * ## Everything here is derived from recorded board state
 *
 * Not from the message log. The log is localised, its wording changes with the
 * engine, and parsing it would produce a metric that silently breaks the next
 * time a card's message is reworded. Board frames carry each player's amber,
 * keys, chains, piles and chosen house at a known point in the log, and those
 * do not change meaning.
 *
 * That constraint is also why some obvious-sounding metrics are absent. "Cards
 * played this turn" cannot be counted honestly from board state - a creature
 * played and destroyed in the same turn leaves the same trace as no creature at
 * all - so it is not reported rather than reported wrongly.
 *
 * ## The one thing only replays know
 *
 * Which house a player called on each turn. `ArchonIntelligenceService` says so
 * in its own header: that fact exists nowhere in a queryable column, only
 * inside `GameReplays."Data"`. It is the reason this analysis is worth having
 * next to the rest of Archon Intelligence rather than being a prettier replay
 * page - "you call Shadows on turn one 80% of the time and win 35% of those" is
 * not a question any other table on the site can answer.
 */

const UNAVAILABLE = (reason) => ({ available: false, reason });

/**
 * How many keys a player had forged, from a board frame's `stats.keys`.
 *
 * `stats.keys` is the engine's per-colour map (`{red, blue, yellow}`); a plain
 * number is accepted too, for any recording or caller that has one.
 */
function keyCount(keys) {
    if (typeof keys === 'number') {
        return Number.isFinite(keys) ? keys : 0;
    }

    if (!keys || typeof keys !== 'object') {
        return 0;
    }

    return Object.values(keys).filter(Boolean).length;
}

/**
 * The type of a card in a recorded pile.
 *
 * Version 3 recordings hold pile entries as references into the recording's
 * card table; version 2 holds whole card summaries inline. Both are read here
 * so an analysis works on games recorded before the format changed.
 */
function cardType(entry, cards) {
    if (entry === null || entry === undefined) {
        return undefined;
    }

    if (typeof entry === 'number') {
        return cards[entry] ? cards[entry].type : undefined;
    }

    if (entry.card !== undefined) {
        return cards[entry.card] ? cards[entry.card].type : undefined;
    }

    return entry.type;
}

/** How many creatures a player had on the board in this frame. */
function creatureCount(player, cards) {
    const inPlay = player?.cardPiles?.cardsInPlay || [];

    return inPlay.filter((entry) => cardType(entry, cards) === 'creature').length;
}

/** A frame's record of one player, or null. */
function playerIn(board, name) {
    return (board?.players || []).find((player) => player?.name === name) || null;
}

const average = (values) =>
    values.length === 0
        ? null
        : Math.round((values.reduce((sum, value) => sum + value, 0) / values.length) * 100) / 100;

/**
 * Analyse one recording.
 *
 * Pure: no database, no clock, no configuration. That is what lets the same
 * function serve a single game's panel and the aggregate across a player's
 * whole history without either being a second implementation.
 *
 * @param {object} replay a recording as stored in `GameReplays."Data"`
 */
function analyseReplay(replay) {
    if (!replay || typeof replay !== 'object') {
        return UNAVAILABLE('No replay was recorded for this game.');
    }

    const snapshots = Array.isArray(replay.snapshots) ? replay.snapshots : [];
    const cards = Array.isArray(replay.cards) ? replay.cards : [];

    if (snapshots.length === 0) {
        // Version 1 recordings are the message log alone. There is nothing to
        // measure, and saying so is better than an empty chart.
        return UNAVAILABLE(
            'This game was recorded before board states were captured, so there is nothing to analyse.'
        );
    }

    const names = (replay.players || []).map((player) => player.name).filter(Boolean);
    // Fall back to the frames when the header has no players - a recording is
    // meant to be self-contained, but the frames are the authority on who was
    // actually at the table.
    const playerNames = names.length
        ? names
        : [...new Set(snapshots.flatMap((s) => (s.board?.players || []).map((p) => p.name)))];

    if (playerNames.length === 0) {
        return UNAVAILABLE('This recording has no players in it.');
    }

    const turns = buildTurns(snapshots, cards);
    const keyEvents = buildKeyEvents(snapshots);
    const summary = Object.fromEntries(
        playerNames.map((name) => [name, summarise(name, turns, keyEvents, replay)])
    );
    const { lead, decisive } = readTheRace(turns, playerNames, replay.winner);

    const durationSeconds =
        replay.startedAt && replay.finishedAt
            ? Math.max(
                  0,
                  Math.round(
                      (new Date(replay.finishedAt).getTime() -
                          new Date(replay.startedAt).getTime()) /
                          1000
                  )
              )
            : null;

    return {
        available: true,
        version: replay.version || 1,
        gameId: replay.gameId,
        winner: replay.winner,
        winReason: replay.winReason,
        firstPlayer: replay.firstPlayer,
        durationSeconds,
        // Board frames are dropped from the middle of a long game, which makes
        // per-turn numbers coarser. Said here so the UI can say it too.
        thinned: !!replay.thinned,
        players: playerNames.map((name) => {
            const header = (replay.players || []).find((player) => player.name === name) || {};

            return {
                name,
                deck: header.deck,
                deckName: header.deckName,
                houses: header.houses,
                won: replay.winner ? replay.winner === name : null
            };
        }),
        turns,
        keyEvents,
        summary,
        lead,
        decisive
    };
}

/**
 * The game as a list of turns.
 *
 * A turn is a run of consecutive frames sharing a round number and an active
 * player. Its numbers are read at the run's first and last frame, so a delta is
 * "between the board states recorded either side of this turn" - which is what
 * it is, and why the UI does not call it "amber gained this turn" exactly.
 */
function buildTurns(snapshots, cards) {
    const turns = [];
    let current = null;

    for (const snapshot of snapshots) {
        const board = snapshot?.board;

        if (!board || board.round == null || !board.activePlayer) {
            continue;
        }

        const active = playerIn(board, board.activePlayer);

        if (!active) {
            continue;
        }

        const opponent = (board.players || []).find((player) => player.name !== board.activePlayer);

        if (!current || current.round !== board.round || current.player !== board.activePlayer) {
            current = {
                index: turns.length,
                messageIndex: snapshot.messageIndex,
                round: board.round,
                player: board.activePlayer,
                house: active.activeHouse,
                amberStart: active.stats?.amber ?? 0,
                amberEnd: active.stats?.amber ?? 0,
                keysStart: keyCount(active.stats?.keys),
                keysEnd: keyCount(active.stats?.keys),
                creatures: creatureCount(active, cards),
                opponentCreatures: opponent ? creatureCount(opponent, cards) : null,
                opponentAmber: opponent ? opponent.stats?.amber ?? 0 : null,
                opponentKeys: opponent ? keyCount(opponent.stats?.keys) : null,
                chains: active.stats?.chains ?? 0,
                handEnd: active.numHandCards ?? null,
                deckEnd: active.numDeckCards ?? null,
                discardEnd: active.cardPiles?.discard?.length ?? null
            };

            turns.push(current);

            continue;
        }

        // Still the same turn: carry the end state forward.
        current.house = current.house || active.activeHouse;
        current.amberEnd = active.stats?.amber ?? current.amberEnd;
        current.keysEnd = keyCount(active.stats?.keys);
        current.creatures = creatureCount(active, cards);
        current.opponentCreatures = opponent
            ? creatureCount(opponent, cards)
            : current.opponentCreatures;
        current.opponentAmber = opponent ? opponent.stats?.amber ?? 0 : current.opponentAmber;
        current.opponentKeys = opponent ? keyCount(opponent.stats?.keys) : current.opponentKeys;
        current.chains = active.stats?.chains ?? current.chains;
        current.handEnd = active.numHandCards ?? current.handEnd;
        current.deckEnd = active.numDeckCards ?? current.deckEnd;
        current.discardEnd = active.cardPiles?.discard?.length ?? current.discardEnd;
    }

    // Keys are attributed by comparing each turn's end against the same
    // player's previous turn, rather than against the frame that opened this
    // one. Forging normally happens at the start of a turn, so the opening
    // frame already shows the key - but cards can forge mid-turn too, and
    // reading only the opening frame would miss every one of those.
    const lastKeysFor = new Map();

    for (const turn of turns) {
        turn.amberGained = turn.amberEnd - turn.amberStart;
        turn.forged = Math.max(0, turn.keysEnd - (lastKeysFor.get(turn.player) ?? 0));
        lastKeysFor.set(turn.player, turn.keysEnd);
    }

    return turns;
}

/** Every point a player's key count went up, with the turn it happened on. */
function buildKeyEvents(snapshots) {
    const events = [];
    const seen = new Map();

    for (const snapshot of snapshots) {
        for (const player of snapshot?.board?.players || []) {
            if (!player?.name) {
                continue;
            }

            const keys = keyCount(player.stats?.keys);
            const before = seen.get(player.name);

            // The first frame is a baseline, not a forge.
            if (before !== undefined && keys > before) {
                events.push({
                    messageIndex: snapshot.messageIndex,
                    round: snapshot.board.round,
                    player: player.name,
                    keys
                });
            }

            seen.set(player.name, keys);
        }
    }

    return events;
}

/** One player's game, as a handful of numbers. */
function summarise(name, turns, keyEvents, replay) {
    const own = turns.filter((turn) => turn.player === name);
    const forges = keyEvents.filter((event) => event.player === name);
    const houses = {};

    for (const turn of own) {
        if (turn.house) {
            houses[turn.house] = (houses[turn.house] || 0) + 1;
        }
    }

    const gains = own.map((turn) => turn.amberGained).filter((value) => Number.isFinite(value));
    const best = own.reduce(
        (bestSoFar, turn) =>
            !bestSoFar || (turn.amberGained ?? 0) > (bestSoFar.amberGained ?? 0) ? turn : bestSoFar,
        null
    );
    const header = (replay.players || []).find((player) => player.name === name) || {};

    return {
        turns: own.length,
        // Only the turns that gained anything count towards the average: a turn
        // spent forging shows as a large negative and would drag an "amber per
        // turn" figure into nonsense.
        amberGained: gains.filter((value) => value > 0).reduce((sum, value) => sum + value, 0),
        amberPerTurn: average(gains.filter((value) => value > 0)),
        keys: forges.length ? forges[forges.length - 1].keys : keyCount(header.keys),
        firstKeyRound: forges.length ? forges[0].round : null,
        keyRounds: forges.map((forge) => forge.round),
        avgCreatures: average(own.map((turn) => turn.creatures).filter(Number.isFinite)),
        bestTurn:
            best && best.amberGained > 0 ? { round: best.round, amber: best.amberGained } : null,
        houses,
        chains: own.length ? own[own.length - 1].chains : null
    };
}

/**
 * The key race, and where it was settled.
 *
 * `lead` is the eventual winner's advantage at the end of each turn, measured
 * as forged keys times the key cost plus amber in the pool. That is a crude
 * currency - it ignores board, hand and deck - and is treated as one: it is
 * used to find the point after which the winner was never behind again, and
 * labelled in the UI as the moment the game stopped changing hands rather than
 * as a verdict on why.
 */
function readTheRace(turns, playerNames, winnerName) {
    if (playerNames.length !== 2 || !winnerName || !playerNames.includes(winnerName)) {
        return { lead: [], decisive: null };
    }

    const KEY_VALUE = 6;
    const lead = [];
    const state = Object.fromEntries(playerNames.map((name) => [name, { amber: 0, keys: 0 }]));

    for (const turn of turns) {
        const opponentName = playerNames.find((name) => name !== turn.player);

        state[turn.player] = { amber: turn.amberEnd, keys: turn.keysEnd };

        if (opponentName && turn.opponentAmber !== null) {
            state[opponentName] = { amber: turn.opponentAmber, keys: turn.opponentKeys ?? 0 };
        }

        const value = (name) => state[name].keys * KEY_VALUE + state[name].amber;
        const loserName = playerNames.find((name) => name !== winnerName);

        lead.push({
            round: turn.round,
            messageIndex: turn.messageIndex,
            turn: turn.index,
            value: value(winnerName) - value(loserName)
        });
    }

    if (lead.length === 0) {
        return { lead, decisive: null };
    }

    // The first point after which the winner is never behind or level again.
    let decisiveIndex = lead.length - 1;

    for (let index = lead.length - 1; index >= 0; index--) {
        if (lead[index].value > 0) {
            decisiveIndex = index;
        } else {
            break;
        }
    }

    const point = lead[decisiveIndex];

    return {
        lead,
        decisive: {
            round: point.round,
            messageIndex: point.messageIndex,
            turn: point.turn,
            player: winnerName,
            // Told apart because they mean different games: one player was
            // never headed, versus a game that turned at a point you can name.
            wireToWire: decisiveIndex === 0
        }
    };
}

class ReplayAnalysisService {
    constructor(db = require('../../db'), policyService = null) {
        this.db = db;
        // ARCHON (N26): the Champion's Challenge value model, which is what
        // turns a recording into a win-probability curve. Injected for tests;
        // its champion lookup is cached, so asking per replay is cheap.
        this.policyService =
            policyService || new BotPolicyService({ getValue: () => ({}) }, db, undefined);
    }

    /** Analytics degrade a panel rather than 500 a page. */
    async safeQuery(sql, params, label) {
        try {
            return await this.db.query(sql, params);
        } catch (err) {
            logger.error('Replay analysis query failed (%s): %s', label, err.message);

            return null;
        }
    }

    /** Analyse one recording. */
    analyse(replay) {
        try {
            return analyseReplay(replay);
        } catch (err) {
            logger.error('Replay analysis failed: %s', err.message);

            return UNAVAILABLE('This replay could not be analysed.');
        }
    }

    /**
     * ARCHON (N26): the win-probability curve over one recording.
     *
     * Read from `seat`'s point of view - the asking player's own seat for their
     * own game, the first player's for a shared one, because a curve has to
     * belong to somebody to mean anything. Board-derived throughout, so it
     * carries no hidden information and is safe on a shared replay.
     *
     * Degrades to unavailable rather than throwing: a member's replay page must
     * not fail because the bot has never trained or a recording is odd.
     *
     * @param {object} replay a recording as stored in `GameReplays."Data"`
     * @param {string} seat
     */
    async winProbability(replay, seat) {
        try {
            const model = await this.policyService.champion();

            return winProbabilityCurve(replay, model, seat);
        } catch (err) {
            logger.error('Win-probability curve failed: %s', err.message);

            return UNAVAILABLE('The win-probability curve could not be computed.');
        }
    }

    /**
     * ARCHON (F3): the misplay review over one recording, as one viewer may
     * read it.
     *
     * The review reads the recorded hands (replayMisplays.js), so it is
     * filtered to the asking player's own moments before it leaves the
     * service; `null` is the admin read and keeps both sides. Same
     * degrade-not-500 posture as `analyse`.
     *
     * @param {object} replay a recording as stored in `GameReplays."Data"`
     * @param {string|null} viewerName
     */
    misplaysFor(replay, viewerName = null) {
        try {
            return filterMisplaysTo(findMisplays(replay), viewerName);
        } catch (err) {
            logger.error('Misplay review failed: %s', err.message);

            return UNAVAILABLE('This replay could not be reviewed for misplays.');
        }
    }

    /**
     * ARCHON (N12): what a player's recent replays say about how they play.
     *
     * This is the cross-game half of the feature, and the part that belongs on
     * the Archon Intelligence page rather than on one game's replay: which
     * houses you actually call, how that compares with how often you win when
     * you call them, how much amber a turn earns you, and how long your games
     * run.
     *
     * Bounded by `limit` recordings rather than by a date range, because the
     * work is proportional to recordings parsed and an unbounded history is an
     * easy way to make one request do a great deal of it.
     *
     * @param {number} userId
     * @param {{limit?: number}} [options]
     */
    async playerInsights(userId, { limit = 25 } = {}) {
        if (!userId) {
            return UNAVAILABLE('Sign in to see your replay analysis.');
        }

        const capped = Math.min(Math.max(parseInt(limit, 10) || 25, 1), 100);
        const rows = await this.safeQuery(
            'SELECT gr."Data" AS "Data", g."GameId", g."FinishedAt", ' +
                'CASE WHEN g."WinnerId" = $1 THEN true ELSE false END AS "Won" ' +
                'FROM "GameReplays" gr ' +
                'JOIN "Games" g ON g."Id" = gr."GameDbId" ' +
                'JOIN "GamePlayers" gp ON gp."GameId" = g."Id" AND gp."PlayerId" = $1 ' +
                'WHERE g."FinishedAt" IS NOT NULL ' +
                'ORDER BY g."FinishedAt" DESC LIMIT $2',
            [userId, capped],
            'playerInsights'
        );

        if (rows === null) {
            return UNAVAILABLE('Replay storage is unavailable.');
        }

        if (rows.length === 0) {
            return UNAVAILABLE(
                'No recorded games yet. Replays are analysed here as soon as you finish one.'
            );
        }

        // Which side of each recording is this player? The recording names
        // players by username, so the account's own name has to come from the
        // one game row that is certain: the row this query joined on.
        const usernameRows = await this.safeQuery(
            'SELECT "Username" FROM "Users" WHERE "Id" = $1',
            [userId],
            'playerInsights.username'
        );
        const username = usernameRows && usernameRows[0] ? usernameRows[0].Username : null;

        if (!username) {
            return UNAVAILABLE('Replay analysis could not identify your account.');
        }

        return this.aggregate(username, rows);
    }

    /**
     * Roll a set of recordings up into one picture of a player.
     *
     * Split out from the query so it is testable without a database, which is
     * the only way the arithmetic here gets checked at all.
     *
     * @param {string} username
     * @param {Array<{Data: object, GameId: string, Won: boolean}>} rows
     */
    aggregate(username, rows) {
        const byHouse = new Map();
        const vsHouse = new Map();
        const amberPerTurn = [];
        const turnsPerGame = [];
        const firstKeyRounds = [];
        const decisiveRounds = [];
        const games = [];
        let analysed = 0;
        let skipped = 0;

        for (const row of rows) {
            const analysis = this.analyse(row.Data);

            if (!analysis.available) {
                skipped++;

                continue;
            }

            const mine = analysis.summary[username];

            if (!mine) {
                // A recording this account is not named in. Should not happen,
                // and is skipped rather than guessed at.
                skipped++;

                continue;
            }

            analysed++;

            const won = !!row.Won;
            const opponent = analysis.players.find((player) => player.name !== username);
            const theirs = opponent ? analysis.summary[opponent.name] : null;

            for (const [house, count] of Object.entries(mine.houses || {})) {
                const entry = byHouse.get(house) || { house, turns: 0, games: 0, wins: 0 };

                entry.turns += count;
                entry.games += 1;
                entry.wins += won ? 1 : 0;
                byHouse.set(house, entry);
            }

            for (const house of Object.keys(theirs?.houses || {})) {
                const entry = vsHouse.get(house) || { house, games: 0, wins: 0 };

                entry.games += 1;
                entry.wins += won ? 1 : 0;
                vsHouse.set(house, entry);
            }

            if (mine.amberPerTurn !== null) {
                amberPerTurn.push(mine.amberPerTurn);
            }

            if (mine.turns) {
                turnsPerGame.push(mine.turns);
            }

            if (mine.firstKeyRound !== null) {
                firstKeyRounds.push(mine.firstKeyRound);
            }

            if (analysis.decisive) {
                decisiveRounds.push(analysis.decisive.round);
            }

            games.push({
                gameId: analysis.gameId || row.GameId,
                won,
                opponent: opponent ? opponent.name : null,
                turns: mine.turns,
                keys: mine.keys,
                amberPerTurn: mine.amberPerTurn,
                firstKeyRound: mine.firstKeyRound,
                decisiveRound: analysis.decisive ? analysis.decisive.round : null
            });
        }

        if (analysed === 0) {
            return UNAVAILABLE(
                'Your recorded games are all from before board states were captured, so there is ' +
                    'nothing to analyse yet.'
            );
        }

        const totalTurns = [...byHouse.values()].reduce((sum, entry) => sum + entry.turns, 0);
        const withRates = (entries, includeShare) =>
            [...entries]
                .map((entry) => ({
                    ...entry,
                    winRate: entry.games ? entry.wins / entry.games : null,
                    ...(includeShare ? { share: totalTurns ? entry.turns / totalTurns : null } : {})
                }))
                .sort((a, b) => (b.turns ?? b.games) - (a.turns ?? a.games));

        return {
            available: true,
            games: analysed,
            // Recordings that could not contribute, so a small sample is
            // explained rather than just small.
            skipped,
            wins: games.filter((game) => game.won).length,
            amberPerTurn: average(amberPerTurn),
            turnsPerGame: average(turnsPerGame),
            firstKeyRound: average(firstKeyRounds),
            decisiveRound: average(decisiveRounds),
            byHouse: withRates(byHouse.values(), true),
            vsHouse: withRates(vsHouse.values(), false),
            recent: games.slice(0, 10)
        };
    }
}

module.exports = ReplayAnalysisService;
module.exports.analyseReplay = analyseReplay;
module.exports.keyCount = keyCount;
