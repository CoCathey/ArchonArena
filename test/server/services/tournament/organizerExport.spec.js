const {
    DATASETS,
    DATASET_IDS,
    buildExport,
    toCsv,
    csvCell,
    exportFilename
} = require('../../../../server/services/tournament/organizerExport');

/**
 * ARCHON (N12): the organiser export is the first thing behind ORGANIZER_TOOLS,
 * and it is a file that opens on somebody's own machine. That makes two things
 * worth testing harder than the column list:
 *
 *   - CSV escaping, because a deck called `Ortannu, the Chained` must not
 *     become two columns and shift every field after it;
 *   - formula injection, because usernames, deck names and dispute notes are
 *     player-supplied and a spreadsheet will happily execute a cell beginning
 *     with `=`.
 */
describe('organizer exports', function () {
    const detail = {
        tournament: {
            id: 7,
            name: 'Summer Vault Open 2026',
            entryFeeCents: 500,
            canManage: true
        },
        players: [
            {
                userId: 1,
                username: 'alice',
                seed: 1,
                checkedIn: true,
                dropped: false,
                waitlisted: false,
                paid: true,
                paidAt: '2026-08-01T10:00:00.000Z',
                paidBy: 'organiser',
                deckName: 'Ortannu, the Chained',
                deckSas: 72,
                amber: 1550,
                eventChains: 0,
                finalRank: 1
            },
            {
                userId: 2,
                username: 'bob',
                seed: 2,
                checkedIn: false,
                dropped: true,
                waitlisted: false,
                paid: false,
                paidAt: null,
                paidBy: null,
                deckName: '=cmd|calc',
                deckSas: 61,
                amber: 1490,
                eventChains: 1,
                finalRank: null
            }
        ],
        matches: [
            {
                id: 10,
                round: 1,
                table: 1,
                bracket: null,
                player1Id: 1,
                player2Id: 2,
                player1: 'alice',
                player2: 'bob',
                player1Wins: 2,
                player2Wins: 0,
                winnerId: 1,
                resultType: 'played',
                confirmed: true,
                disputedBy: null,
                scheduledAt: '2026-08-02T18:00:00.000Z'
            },
            {
                id: 11,
                round: 2,
                table: 1,
                player1Id: 1,
                player2Id: null,
                player1: 'alice',
                player2: null,
                winnerId: null,
                confirmed: false,
                scheduledAt: null
            }
        ],
        standings: [
            {
                id: 1,
                username: 'alice',
                points: 2,
                byes: 1,
                wins: 2,
                losses: 0,
                gameWins: 4,
                gameLosses: 0,
                matchWinRate: 1,
                gameWinRate: 1,
                opponentMatchWinRate: 0.25,
                opponentGameWinRate: 0.25,
                dropped: false,
                finalRank: 1
            },
            {
                id: 2,
                username: 'bob',
                points: 0,
                byes: 0,
                wins: 0,
                losses: 1,
                gameWins: 0,
                gameLosses: 2,
                matchWinRate: 0,
                gameWinRate: 0,
                opponentMatchWinRate: 1,
                opponentGameWinRate: 1,
                dropped: true,
                finalRank: null
            }
        ]
    };

    describe('csvCell', function () {
        it('leaves an ordinary value alone', function () {
            expect(csvCell('alice')).toBe('alice');
            expect(csvCell(7)).toBe('7');
        });

        it('renders null and undefined as empty rather than as words', function () {
            expect(csvCell(null)).toBe('');
            expect(csvCell(undefined)).toBe('');
        });

        it('quotes a value containing a comma, quote or newline', function () {
            expect(csvCell('Ortannu, the Chained')).toBe('"Ortannu, the Chained"');
            expect(csvCell('say "hi"')).toBe('"say ""hi"""');
            expect(csvCell('two\nlines')).toBe('"two\nlines"');
        });

        it('neutralises a formula so a spreadsheet does not run it', function () {
            for (const hostile of ['=1+1', '+1', '-1', '@SUM(A1)']) {
                expect(csvCell(hostile).startsWith("'")).toBe(true);
            }
        });

        it('still quotes a neutralised formula that also contains a comma', function () {
            // Both defences apply, in that order, or the escaping undoes itself.
            expect(csvCell('=cmd,calc')).toBe('"\'=cmd,calc"');
        });
    });

    describe('toCsv', function () {
        it('writes a header row and CRLF line endings', function () {
            const csv = toCsv({ columns: ['a', 'b'], rows: [[1, 2]] });

            expect(csv).toBe('a,b\r\n1,2\r\n');
        });
    });

    describe('datasets', function () {
        it('refuses an unknown one rather than serving an empty file', function () {
            // An empty file looks like an event with nobody in it, which is a
            // much worse answer than an error.
            expect(buildExport(detail, 'nonsense')).toBeNull();
            expect(buildExport(null, DATASETS.STANDINGS)).toBeNull();
        });

        it('builds every dataset it advertises', function () {
            for (const dataset of DATASET_IDS) {
                const built = buildExport(detail, dataset);

                expect(built, `${dataset} did not build`).not.toBeNull();
                expect(built.columns.length).toBeGreaterThan(0);

                for (const row of built.rows) {
                    expect(row.length, `${dataset} has a ragged row`).toBe(built.columns.length);
                }
            }
        });

        it('exports standings in the order the page shows them', function () {
            const built = buildExport(detail, DATASETS.STANDINGS);

            expect(built.rows[0][built.columns.indexOf('player')]).toBe('alice');
            expect(built.rows[0][built.columns.indexOf('rank')]).toBe(1);
            expect(built.rows[1][built.columns.indexOf('dropped')]).toBe('yes');
            // Tiebreakers as their own columns: "why am I eighth" is answered
            // by a column, not by a rank.
            expect(built.columns).toContain('opponentMatchWinRate');
            expect(built.rows[0][built.columns.indexOf('opponentMatchWinRate')]).toBe('25.0%');
        });

        it('names a bye rather than leaving the cell blank', function () {
            const built = buildExport(detail, DATASETS.PAIRINGS);
            const secondRound = built.rows.find((row) => row[0] === 2);

            expect(secondRound[built.columns.indexOf('player2')]).toBe('bye');
            // An undecided match has no confirmation state to report, and 'no'
            // would read as "the opponent disagreed".
            expect(secondRound[built.columns.indexOf('confirmed')]).toBe('');
        });

        it('includes payment columns only when there is a fee', function () {
            const paid = buildExport(detail, DATASETS.PLAYERS);

            expect(paid.columns).toContain('paid');

            const free = buildExport(
                { ...detail, tournament: { ...detail.tournament, entryFeeCents: null } },
                DATASETS.PLAYERS
            );

            // An empty 'paid' column on a free event reads as "nobody paid".
            expect(free.columns).not.toContain('paid');

            for (const row of free.rows) {
                expect(row.length).toBe(free.columns.length);
            }
        });

        it('carries a hostile deck name through as text, not as a formula', function () {
            const csv = toCsv(buildExport(detail, DATASETS.PLAYERS));

            expect(csv).toContain("'=cmd|calc");
            expect(csv).not.toMatch(/,=cmd/);
        });

        it('survives an event with nothing in it yet', function () {
            const empty = { tournament: { name: 'New Event' } };

            for (const dataset of DATASET_IDS) {
                const built = buildExport(empty, dataset);

                expect(built.rows).toEqual([]);
                expect(built.columns.length).toBeGreaterThan(0);
            }
        });
    });

    describe('the filename', function () {
        it('is derived from the event name', function () {
            expect(exportFilename(detail, 'standings')).toBe(
                'summer-vault-open-2026-standings.csv'
            );
        });

        it('cannot contain a quote, a slash or a newline', function () {
            // It goes into a Content-Disposition header, so anything that could
            // break out of the quoted filename has to be gone by here.
            const nasty = {
                tournament: { name: 'a"b/c\r\nd; filename="evil' }
            };
            const filename = exportFilename(nasty, 'players');

            expect(filename).toMatch(/^[a-z0-9-]+-players\.csv$/);
        });

        it('falls back to something rather than an empty name', function () {
            expect(exportFilename({ tournament: { name: '???' } }, 'players')).toBe(
                'tournament-players.csv'
            );
            expect(exportFilename({}, 'players')).toBe('tournament-players.csv');
        });
    });
});
