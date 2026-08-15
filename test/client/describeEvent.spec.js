import { describeEvent, defaultEventForm } from '../../client/Components/Tournaments/describeEvent';

/**
 * ARCHON: the create form's plain-English preview.
 *
 * Hosting an event means answering about twenty controls, and most of them
 * only matter for some of the others. An organizer could set a top cut on a
 * single-elimination bracket, a minutes round clock on an asynchronous
 * league, or a SAS band on a sealed event, and nothing would tell them - the
 * server accepts all three, because none is invalid, they just do nothing.
 * They would find out when the event ran.
 *
 * What is worth testing here is not the prose but which sentences appear for
 * which combination: the notes are the whole point, and a note that never
 * fires is the same as not having written it.
 */
describe('describeEvent', function () {
    const form = (overrides = {}) => ({
        format: 'swiss',
        gameFormat: 'archon',
        mode: 'online',
        pacing: 'live',
        deckSwapPolicy: 'locked',
        visibility: 'public',
        ...overrides
    });

    const has = (lines, pattern) => lines.some((line) => pattern.test(line));

    describe('the shape of the event', function () {
        it('names the rounds when they are set, and explains when they are not', function () {
            expect(has(describeEvent(form({ roundCount: '5' })).summary, /5 rounds of Swiss/)).toBe(
                true
            );

            const openEnded = describeEvent(form()).summary;
            expect(has(openEnded, /set from the turnout/)).toBe(true);
        });

        // The count the engine itself falls back on, so the organizer sees the
        // same number the event will actually use.
        it('suggests a round count from the player cap', function () {
            expect(
                has(describeEvent(form({ playerCap: '16' })).summary, /about 4 for 16 players/)
            ).toBe(true);
            expect(
                has(describeEvent(form({ playerCap: '32' })).summary, /about 5 for 32 players/)
            ).toBe(true);
        });

        it('counts the rounds a full round robin needs', function () {
            expect(
                has(
                    describeEvent(form({ format: 'round-robin', playerCap: '8' })).summary,
                    /7 rounds for a full 8/
                )
            ).toBe(true);
        });

        it('explains what the lower bracket is for', function () {
            expect(
                has(describeEvent(form({ format: 'double-elim' })).summary, /lower bracket/)
            ).toBe(true);
        });

        it('describes the cut and its series length together', function () {
            const lines = describeEvent(form({ cutTo: '8', playoffBestOf: '3' })).summary;

            expect(has(lines, /top 8 then cut.*best of 3/)).toBe(true);
        });
    });

    describe('how it is played', function () {
        it('tells an async organizer their rounds are days', function () {
            const lines = describeEvent(form({ pacing: 'async', roundDeadlineDays: '5' })).summary;

            expect(has(lines, /5 days per round/)).toBe(true);
        });

        it('says how tables open, which differs by mode and pacing', function () {
            expect(has(describeEvent(form()).summary, /tables opened for every pairing/)).toBe(
                true
            );
            expect(
                has(
                    describeEvent(form({ pacing: 'async' })).summary,
                    /opening their table when they meet/
                )
            ).toBe(true);
            expect(has(describeEvent(form({ mode: 'hybrid' })).summary, /one standing/)).toBe(true);
            expect(has(describeEvent(form({ mode: 'irl' })).summary, /in person/)).toBe(true);
        });
    });

    describe('the deck rules', function () {
        // The setting the whole deck lock exists to serve: an organizer has to
        // be able to see which of the two they picked.
        it('spells out the difference between the two deck policies', function () {
            expect(
                has(
                    describeEvent(form({ deckSwapPolicy: 'locked' })).summary,
                    /One deck for the whole event/
                )
            ).toBe(true);

            const swap = describeEvent(form({ deckSwapPolicy: 'between-rounds' })).summary;
            expect(has(swap, /different deck to each round/)).toBe(true);
            // And the limit on it, which is the part players argue about.
            expect(has(swap, /never mid-match/)).toBe(true);
        });

        it('describes a Triad pool rather than a deck', function () {
            expect(has(describeEvent(form({ triad: true })).summary, /three decks/)).toBe(true);
        });

        it('reports the SAS band and house rules', function () {
            const lines = describeEvent(
                form({
                    sasMin: '50',
                    sasMax: '75',
                    bannedHouses: ['brobnar'],
                    requiredHouses: ['logos']
                })
            ).summary;

            expect(has(lines, /between 50 and 75 SAS/)).toBe(true);
            expect(has(lines, /may not contain brobnar/)).toBe(true);
            expect(has(lines, /must contain logos/)).toBe(true);
        });
    });

    /**
     * The reason this exists. Each of these is a setting the server accepts
     * without complaint and then ignores.
     */
    describe('settings that will not do anything', function () {
        const noteFor = (overrides) => describeEvent(form(overrides)).notes;

        it('flags a top cut on a format that already ends in a bracket', function () {
            expect(
                has(noteFor({ format: 'single-elim', cutTo: '8' }), /only applies to Swiss/)
            ).toBe(true);
            expect(noteFor({ format: 'swiss', cutTo: '8' })).toEqual([]);
        });

        it('flags a round count on a format that sets its own', function () {
            expect(
                has(noteFor({ format: 'double-elim', roundCount: '5' }), /round count is ignored/)
            ).toBe(true);
            expect(
                has(noteFor({ format: 'round-robin', roundCount: '5' }), /round count is ignored/)
            ).toBe(true);
            expect(noteFor({ format: 'swiss', roundCount: '5' })).toEqual([]);
        });

        it('flags a minutes clock on an event paced in days', function () {
            expect(
                has(noteFor({ pacing: 'async', roundTimerMinutes: '50' }), /paced in days/)
            ).toBe(true);
            expect(noteFor({ pacing: 'live', roundTimerMinutes: '50' })).toEqual([]);
        });

        it('flags deck rules on an event that deals its own decks', function () {
            const sealed = noteFor({
                gameFormat: 'sealed',
                sasMin: '50',
                requireDeckRegistration: true,
                bannedHouses: ['dis']
            });

            expect(has(sealed, /SAS band/)).toBe(true);
            expect(has(sealed, /nothing to register/)).toBe(true);
            expect(has(sealed, /House restrictions/)).toBe(true);
        });

        it('flags a swap policy on a Triad event, which swaps by its own rules', function () {
            expect(
                has(noteFor({ triad: true, deckSwapPolicy: 'between-rounds' }), /does not apply/)
            ).toBe(true);
            expect(noteFor({ triad: true, deckSwapPolicy: 'locked' })).toEqual([]);
        });

        it('flags a game clock on an event with no game to clock', function () {
            expect(
                has(noteFor({ mode: 'irl', gameTimeLimit: '30' }), /no game to put a clock on/)
            ).toBe(true);
            expect(noteFor({ mode: 'online', gameTimeLimit: '30' })).toEqual([]);
        });

        /**
         * The form an organizer actually opens, not a fixture standing in for
         * it. That distinction is not pedantic: the first version of this
         * panel opened with "The playoff best-of only applies once a top cut
         * is set" on an untouched form, because the default carries a playoff
         * best-of and no cut - and the partial fixture these tests were built
         * on did not carry either, so nothing caught it. A warning about a
         * field the form does not even render is exactly the noise this panel
         * exists to remove.
         */
        it('says nothing about the form an organizer opens', function () {
            expect(describeEvent(defaultEventForm).notes).toEqual([]);
            expect(describeEvent(form()).notes).toEqual([]);
            expect(describeEvent({}).notes).toEqual([]);
        });

        // ...and it still describes that form usefully rather than going quiet
        // in both directions.
        it('still describes the default form', function () {
            const lines = describeEvent(defaultEventForm).summary;

            expect(has(lines, /Swiss/)).toBe(true);
            expect(has(lines, /One deck for the whole event/)).toBe(true);
            // The default is a rated event, and the summary has to say so:
            // this line is the only place an organizer is told, before they
            // press create, that these games will move the ladder.
            expect(has(lines, /move Amber/)).toBe(true);
        });
    });

    /**
     * The buy-in is the one setting a player can be out of pocket over, so the
     * preview says it in whole sentences rather than leaving the organizer to
     * infer it from a number in a box - including, every time, that the
     * platform is not the one collecting it.
     */
    describe('the money', function () {
        it('says nothing at all when the event is free', function () {
            const free = describeEvent(form()).summary;

            expect(has(free, /to enter/)).toBe(false);
            expect(has(free, /[Pp]rize/)).toBe(false);
        });

        it('names the fee and who is actually collecting it', function () {
            const paid = describeEvent(form({ entryFee: '10' })).summary;

            expect(has(paid, /\$10\.00 to enter/)).toBe(true);
            expect(has(paid, /does not take payments or pay prizes out/)).toBe(true);
        });

        it('reads the split back as places and shares', function () {
            const paid = describeEvent(
                form({
                    entryFee: '10',
                    playerCap: '8',
                    prizeSplits: [
                        { rank: 1, bps: 7500 },
                        { rank: 2, bps: 2000 }
                    ]
                })
            ).summary;

            expect(has(paid, /top 2: 1st 75%, 2nd 20%/)).toBe(true);
            // Eight players at $10 is an $80 pot, of which 5% - $4.00 - is not
            // handed out. Both numbers stated, because "where did the rest go"
            // is the question this panel exists to pre-empt.
            expect(has(paid, /\$80\.00 at a full 8/)).toBe(true);
            expect(has(paid, /\$4\.00 of that is not handed out/)).toBe(true);
        });

        it('says so when a fee is set with no split behind it', function () {
            const paid = describeEvent(form({ entryFee: '5' })).summary;

            expect(has(paid, /whole pot stays with you/)).toBe(true);
        });

        it('flags a split with no fee to divide', function () {
            const notes = describeEvent(form({ prizeSplits: [{ rank: 1, bps: 10000 }] })).notes;

            expect(has(notes, /no entry fee/)).toBe(true);
        });

        // The server refuses this outright. Saying so here is the difference
        // between fixing it now and being told after filling in everything else.
        it('warns before the server refuses a table that adds up to more than the pot', function () {
            const notes = describeEvent(
                form({
                    entryFee: '10',
                    prizeSplits: [
                        { rank: 1, bps: 7500 },
                        { rank: 2, bps: 5000 }
                    ]
                })
            ).notes;

            expect(has(notes, /125\.00%/)).toBe(true);
        });
    });

    it('describes an empty form without falling over', function () {
        const empty = describeEvent();

        expect(empty.summary.length).toBeGreaterThan(0);
        expect(empty.notes).toEqual([]);
    });
});
