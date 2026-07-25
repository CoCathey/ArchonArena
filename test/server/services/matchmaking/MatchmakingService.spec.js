const MatchmakingService = require('../../../../server/services/matchmaking/MatchmakingService');

describe('MatchmakingService', function () {
    let service;
    // Fixed clock so pairing is deterministic; entries set joinedAt relative to it.
    const NOW = 1000000;

    beforeEach(function () {
        service = new MatchmakingService();
    });

    const enqueue = (username, amber, { format = 'normal', waitedMs = 0 } = {}) =>
        service.enqueue({ username, format, amber, joinedAt: NOW - waitedMs });

    describe('queue bookkeeping', function () {
        it('enqueues, reports membership and size, and dequeues', function () {
            enqueue('alice', 1200);
            enqueue('bob', 1200, { format: 'sealed' });

            expect(service.has('alice')).toBe(true);
            expect(service.size()).toBe(2);
            expect(service.size('normal')).toBe(1);
            expect(service.size('sealed')).toBe(1);

            expect(service.dequeue('alice')).toBe(true);
            expect(service.has('alice')).toBe(false);
            expect(service.size()).toBe(1);
        });

        it('lists queued players with their formats', function () {
            enqueue('alice', 1200, { format: 'normal' });
            enqueue('bob', 1300, { format: 'sealed' });

            const list = service.list().sort((a, b) => a.username.localeCompare(b.username));

            expect(list).toEqual([
                { username: 'alice', format: 'normal' },
                { username: 'bob', format: 'sealed' }
            ]);
        });

        it('ignores entries missing a username or format', function () {
            expect(service.enqueue({ username: '', format: 'normal', amber: 1200 })).toBe(false);
            expect(service.enqueue({ username: 'x', format: '', amber: 1200 })).toBe(false);
            expect(service.size()).toBe(0);
        });

        it('defaults a missing/invalid Amber to the starting rating', function () {
            service.enqueue({ username: 'newbie', format: 'normal', joinedAt: NOW });
            enqueue('rated', 1200);

            const pairs = service.collectMatches(NOW);
            // 1200 vs default 1200 -> gap 0, pairs immediately.
            expect(pairs).toHaveLength(1);
        });
    });

    describe('pairing', function () {
        it('pairs two same-format players within tolerance and removes them', function () {
            enqueue('alice', 1200);
            enqueue('bob', 1300); // gap 100 <= base 150

            const pairs = service.collectMatches(NOW);

            expect(pairs).toHaveLength(1);
            const names = pairs[0].map((e) => e.username).sort();
            expect(names).toEqual(['alice', 'bob']);
            expect(service.size()).toBe(0); // both removed
        });

        it('does not pair players in different formats', function () {
            enqueue('alice', 1200, { format: 'normal' });
            enqueue('bob', 1200, { format: 'sealed' });

            expect(service.collectMatches(NOW)).toHaveLength(0);
            expect(service.size()).toBe(2); // both remain queued
        });

        it('does not pair when the Amber gap exceeds a fresh tolerance', function () {
            enqueue('alice', 1200);
            enqueue('bob', 1600); // gap 400 > base 150

            expect(service.collectMatches(NOW)).toHaveLength(0);
            expect(service.size()).toBe(2);
        });

        it('widens tolerance with wait time so distant players eventually pair', function () {
            // gap 300; base 150 + 25/s. Needs >=6s of wait to reach 300.
            enqueue('alice', 1200, { waitedMs: 6000 });
            enqueue('bob', 1500, { waitedMs: 6000 });

            expect(service.collectMatches(NOW)).toHaveLength(1);
        });

        it('matches anyone once a player passes the max wait', function () {
            enqueue('alice', 1000, { waitedMs: 60000 }); // tolerance Infinity
            enqueue('bob', 2500);

            expect(service.collectMatches(NOW)).toHaveLength(1);
        });

        it('prefers the closest-Amber opponent', function () {
            enqueue('alice', 1200);
            enqueue('faraway', 1340); // gap 140
            enqueue('closest', 1210); // gap 10

            const pairs = service.collectMatches(NOW);

            expect(pairs).toHaveLength(1);
            expect(pairs[0].map((e) => e.username).sort()).toEqual(['alice', 'closest']);
            expect(service.has('faraway')).toBe(true); // left waiting
        });

        it('pairs the longest-waiting player first (FIFO fairness)', function () {
            enqueue('old', 1200, { waitedMs: 30000 });
            enqueue('mid', 1200, { waitedMs: 10000 });
            enqueue('new', 1200, { waitedMs: 0 });

            const pairs = service.collectMatches(NOW);

            expect(pairs).toHaveLength(1);
            // 'old' anchors and takes the next-oldest ('mid'); 'new' waits.
            expect(pairs[0].map((e) => e.username).sort()).toEqual(['mid', 'old']);
            expect(service.has('new')).toBe(true);
        });

        it('honours the canPair veto and leaves vetoed players queued', function () {
            enqueue('alice', 1200);
            enqueue('blocked', 1200);

            const canPair = (a, b) =>
                !(
                    (a.username === 'alice' && b.username === 'blocked') ||
                    (a.username === 'blocked' && b.username === 'alice')
                );

            expect(service.collectMatches(NOW, canPair)).toHaveLength(0);
            expect(service.size()).toBe(2);
        });

        it('produces multiple simultaneous pairs', function () {
            enqueue('a1', 1200);
            enqueue('a2', 1200);
            enqueue('b1', 1200);
            enqueue('b2', 1200);

            const pairs = service.collectMatches(NOW);

            expect(pairs).toHaveLength(2);
            expect(service.size()).toBe(0);
        });
    });

    describe('re-enqueue', function () {
        it('keeps the original wait when re-queued for the same format', function () {
            enqueue('alice', 1200, { waitedMs: 30000 });
            // Re-enqueue "now" with the same format; wait must be preserved.
            service.enqueue({ username: 'alice', format: 'normal', amber: 1200, joinedAt: NOW });
            enqueue('bob', 1900); // gap 700; only matchable via alice's widened tolerance

            // alice's preserved 30s wait -> tolerance 150 + 750 = 900 >= 700.
            expect(service.collectMatches(NOW)).toHaveLength(1);
        });

        it('resets the wait when switching format', function () {
            enqueue('alice', 1200, { format: 'normal', waitedMs: 30000 });
            service.enqueue({ username: 'alice', format: 'sealed', amber: 1200, joinedAt: NOW });
            enqueue('bob', 1900, { format: 'sealed' }); // gap 700, fresh tolerance 150

            expect(service.collectMatches(NOW)).toHaveLength(0);
        });
    });
});
