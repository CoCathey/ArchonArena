/**
 * ARCHON: what the create form is about to build, in one paragraph.
 *
 * Hosting an event means answering about twenty controls, most of which only
 * matter for some of the others - a round timer does nothing in an async
 * league, a SAS band does nothing in a sealed event, a top cut does nothing
 * in a single-elimination bracket. An organizer setting up their first event
 * has no way to tell which of their answers are actually going to do
 * anything, and finds out when the event runs.
 *
 * So the form says it back to them before they commit: what will happen, and
 * which of their settings are not going to matter. These are notes, never
 * blocks - the server validates, this explains.
 *
 * A pure function of the form, so it can be tested as one.
 */

import {
    centsFromAmount,
    computePrizePool,
    formatCents,
    ordinal,
    percentFromBps
} from './prizePool';

/**
 * The create form's starting state, here rather than in the page so the
 * preview can be tested against the form an organizer actually opens. It was
 * a partial fixture that hid the first bug this panel had: the untouched form
 * opened with a warning about a field it does not even render.
 */
export const defaultEventForm = {
    name: '',
    description: '',
    format: 'swiss',
    gameFormat: 'archon',
    mode: 'online',
    pacing: 'live',
    roundDeadlineDays: '3',
    roundCount: '',
    startTime: '',
    playerCap: '',
    bestOf: '1',
    playoffBestOf: '3',
    cutTo: '',
    seedMethod: 'registration',
    visibility: 'public',
    roundTimerMinutes: '',
    gameTimeLimit: '',
    ratedGames: false,
    requireDeckRegistration: false,
    hideDecklists: false,
    sasMin: '',
    sasMax: '',
    deckSwapPolicy: 'locked',
    triad: false,
    sasChainHandicap: false,
    chainsPerMatchWin: '',
    allowedSets: [],
    bannedHouses: [],
    requiredHouses: [],
    // The announced buy-in and split. Recorded only - the platform never
    // collects or pays out. `entryFee` is what the organizer typed, in whole
    // currency; it is converted to integer cents on the way to the server.
    entryFee: '',
    prizeCurrency: 'USD',
    prizeSplits: [],
    prizeNote: '',
    // How players pay, and whether the start button enforces it.
    paymentInstructions: '',
    requirePayment: false
};

const FORMAT_NAMES = {
    swiss: 'Swiss',
    'single-elim': 'single elimination',
    'double-elim': 'double elimination',
    'round-robin': 'round robin'
};

const GAME_FORMAT_NAMES = {
    archon: 'Archon (constructed)',
    sealed: 'Sealed',
    alliance: 'Alliance',
    reversal: 'Reversal',
    'adaptive-bo1': 'Adaptive'
};

const number = (value) => {
    const parsed = parseInt(value, 10);

    return Number.isNaN(parsed) ? null : parsed;
};

/**
 * Swiss needs enough rounds for one player to separate from the field:
 * ceil(log2(players)), the same rule the engine falls back on when the
 * organizer leaves the count blank.
 */
const suggestedRounds = (playerCount) =>
    playerCount && playerCount > 1 ? Math.max(1, Math.ceil(Math.log2(playerCount))) : null;

/**
 * @param {object} form the create form's state
 * @returns {{summary: string[], notes: string[]}} sentences to show, and
 *   settings that will not do anything in this combination
 */
export const describeEvent = (form = {}) => {
    const summary = [];
    const notes = [];

    const format = form.format || 'swiss';
    const gameFormat = form.gameFormat || 'archon';
    const mode = form.mode || 'online';
    const pacing = form.pacing || 'live';
    const isSwiss = format === 'swiss';
    const isBracket = format === 'single-elim' || format === 'double-elim';
    const isSealed = gameFormat === 'sealed';
    const isAsync = pacing === 'async';

    const cap = number(form.playerCap);
    const rounds = number(form.roundCount);
    const cutTo = number(form.cutTo);
    const bestOf = number(form.bestOf) || 1;
    const playoffBestOf = number(form.playoffBestOf) || 1;
    const roundTimer = number(form.roundTimerMinutes);
    const gameClock = number(form.gameTimeLimit);
    const deadlineDays = number(form.roundDeadlineDays);
    const chainsPerWin = number(form.chainsPerMatchWin);
    const sasMin = number(form.sasMin);
    const sasMax = number(form.sasMax);

    // --- shape of the event ---------------------------------------------
    const formatName = FORMAT_NAMES[format] || format;

    if (isSwiss) {
        const suggestion = suggestedRounds(cap);

        summary.push(
            rounds
                ? `${rounds} rounds of Swiss.`
                : suggestion
                ? `Swiss, with the number of rounds set from the turnout - about ${suggestion} for ${cap} players.`
                : 'Swiss, with the number of rounds set from the turnout on the day.'
        );
    } else if (format === 'round-robin') {
        summary.push(
            cap
                ? `Round robin - every player meets every other, ${Math.max(
                      cap - 1,
                      1
                  )} rounds for a full ${cap}.`
                : 'Round robin - every player meets every other.'
        );
    } else {
        summary.push(
            `A ${formatName} bracket${
                format === 'double-elim' ? ' - one loss drops you to the lower bracket' : ''
            }.`
        );
    }

    if (cutTo && isSwiss) {
        summary.push(
            `The top ${cutTo} then cut to a single-elimination playoff${
                playoffBestOf > 1 ? ` at best of ${playoffBestOf}` : ''
            }.`
        );
    }

    summary.push(bestOf > 1 ? `Matches are best of ${bestOf}.` : 'Matches are a single game.');

    // --- who plays -------------------------------------------------------
    summary.push(
        cap
            ? `Up to ${cap} players; anyone after that joins the waitlist.`
            : 'No player cap - the waitlist never opens.'
    );

    // --- where and when --------------------------------------------------
    if (mode === 'irl') {
        summary.push('Played in person; results are typed in at the table.');
    } else if (mode === 'hybrid') {
        summary.push(
            'Played either here or across a table - players open their own online table when they want one, and either way the result feeds one standing.'
        );
    } else {
        summary.push(
            isAsync
                ? 'Played here, with each pair opening their table when they meet.'
                : 'Played here, with tables opened for every pairing as the round is called.'
        );
    }

    if (isAsync) {
        summary.push(
            `Asynchronous: ${
                deadlineDays || 3
            } days per round for the two players to arrange and play their match between themselves.`
        );
    } else if (roundTimer) {
        summary.push(`Live, with a ${roundTimer} minute round clock.`);
    } else {
        summary.push('Live, played in one sitting with no round clock.');
    }

    if (gameClock && mode !== 'irl') {
        summary.push(`Each player gets ${gameClock} minutes on their own clock within a game.`);
    }

    // --- decks -----------------------------------------------------------
    summary.push(`Game format: ${GAME_FORMAT_NAMES[gameFormat] || gameFormat}.`);

    if (form.triad) {
        summary.push(
            'Triad: every player registers three decks, and each match starts with the opponents banning one of each other pool.'
        );
    } else if (isSealed) {
        summary.push('Sealed decks are dealt at the table, so nothing is registered in advance.');
    } else if (form.deckSwapPolicy === 'between-rounds') {
        summary.push(
            'Players may bring a different deck to each round, but never mid-match - the deck is fixed once their pairing starts.'
        );
    } else {
        summary.push('One deck for the whole event, locked when it starts.');
    }

    if (form.requireDeckRegistration && !isSealed) {
        summary.push('A registered deck is required to enter.');
    }

    if (sasMin !== null || sasMax !== null) {
        summary.push(`Decks must rate between ${sasMin ?? 0} and ${sasMax ?? 'any'} SAS.`);
    }

    if (form.requiredHouses?.length > 0) {
        summary.push(`Decks must contain ${form.requiredHouses.join(', ')}.`);
    }

    if (form.bannedHouses?.length > 0) {
        summary.push(`Decks may not contain ${form.bannedHouses.join(', ')}.`);
    }

    if (form.allowedSets?.length > 0) {
        summary.push(`Only decks from ${form.allowedSets.length} set(s) may register.`);
    }

    if (form.sasChainHandicap) {
        summary.push('The stronger deck in each game starts with chains, scaled to the SAS gap.');
    }

    if (chainsPerWin > 0) {
        summary.push(`Every match win adds ${chainsPerWin} chains for the rest of the event.`);
    }

    // --- the money -------------------------------------------------------
    //
    // Said in whole sentences, because this is the one setting a player can be
    // out of pocket over. The platform records it and collects nothing.
    const entryFeeCents = centsFromAmount(form.entryFee);
    const prizeSplits = (form.prizeSplits || []).filter((split) => split.bps > 0);

    if (entryFeeCents > 0) {
        const currency = form.prizeCurrency || 'USD';
        const pool = computePrizePool({
            entryFeeCents,
            splits: prizeSplits,
            entrantCount: cap || 8
        });

        summary.push(
            `${formatCents(entryFeeCents, currency)} to enter, collected by you - the platform ` +
                `does not take payments or pay prizes out.`
        );

        if (prizeSplits.length > 0) {
            summary.push(
                `Prizes go to the top ${prizeSplits.length}: ${prizeSplits
                    .map((split) => `${ordinal(split.rank)} ${percentFromBps(split.bps)}%`)
                    .join(', ')}${
                    cap ? ` - ${formatCents(pool.poolCents, currency)} at a full ${cap}` : ''
                }.`
            );

            if (pool.retainedCents > 0 && cap) {
                summary.push(
                    `${formatCents(pool.retainedCents, currency)} of that is not handed out.`
                );
            }
        } else {
            summary.push('No prize split is set, so the whole pot stays with you.');
        }
    }

    // --- the rest --------------------------------------------------------
    summary.push(
        form.ratedGames ? 'Games move Amber ratings.' : 'Games do not affect Amber ratings.'
    );

    summary.push(
        form.visibility === 'private'
            ? 'Private: players need the join code, which appears on the event page once it exists.'
            : 'Public: listed for anyone to find and join.'
    );

    if (form.hideDecklists) {
        summary.push('Decklists are hidden from other players and visible to staff.');
    }

    // --- settings that will not do anything ------------------------------
    if (cutTo && !isSwiss) {
        notes.push(
            `A top ${cutTo} cut only applies to Swiss - a ${formatName} event already ends in a bracket.`
        );
    }

    if (rounds && isBracket) {
        notes.push(
            `A ${formatName} bracket runs as many rounds as the field needs, so the round count is ignored.`
        );
    }

    if (rounds && format === 'round-robin') {
        notes.push(
            'Round robin runs until everyone has met everyone, so the round count is ignored.'
        );
    }

    if (isAsync && roundTimer) {
        notes.push(
            'An asynchronous event is paced in days per round, so the minutes round clock is ignored.'
        );
    }

    if (isSealed && (sasMin !== null || sasMax !== null)) {
        notes.push('Sealed decks are dealt at the table, so a SAS band cannot be applied to them.');
    }

    if (isSealed && form.requireDeckRegistration) {
        notes.push('Sealed events deal their decks, so there is nothing to register in advance.');
    }

    if (isSealed && (form.requiredHouses?.length > 0 || form.bannedHouses?.length > 0)) {
        notes.push('House restrictions cannot apply to a sealed deck the event deals itself.');
    }

    if (form.triad && form.deckSwapPolicy === 'between-rounds') {
        notes.push(
            'Triad already changes decks each match through the ban and pick, so the swap policy does not apply.'
        );
    }

    if (form.triad && isSealed) {
        notes.push('Triad needs three registered decks, which a sealed event does not have.');
    }

    if (mode === 'irl' && gameClock) {
        notes.push('An in-person event has no game to put a clock on.');
    }

    if (prizeSplits.length > 0 && !entryFeeCents) {
        notes.push(
            'There is no entry fee, so the prize split has nothing to divide - every share works out at zero.'
        );
    }

    const allocatedBps = prizeSplits.reduce((sum, split) => sum + split.bps, 0);

    // Not a note but a refusal in waiting: the server rejects this outright, so
    // saying so here is the difference between fixing it now and being told
    // "Prize shares add up to 125.00%" after filling in everything else.
    if (allocatedBps > 10000) {
        notes.push(
            `The prize shares add up to ${(allocatedBps / 100).toFixed(
                2
            )}% - more than the pot holds, and the event will not save until they come down.`
        );
    }

    // No note for a playoff best-of without a cut: the form only renders that
    // input once a cut is chosen, so the default value can never be something
    // the organizer did - and a warning about a field they cannot see is
    // exactly the noise this panel exists to remove.

    return { summary, notes };
};

export default describeEvent;
