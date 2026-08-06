const { io } = require('socket.io-client');
const jsondiffpatch = require('jsondiffpatch').create({
    objectHash: (obj, index) => obj.uuid || obj.name || obj.id || obj._id || '$$index:' + index
});

/**
 * Live protocol check for game-state sync, against a running stack.
 *
 * Skipped unless AA_E2E=1, because it needs the real thing: postgres + redis,
 * cards and standalone decks imported, the dev-seed accounts, the lobby on
 * :4000 and a game node on :9500 (docs/local-development.md).
 *
 *     AA_E2E=1 npm test -- test/server/gamestate.sync.live.spec.js \
 *         --testTimeout=180000
 *
 * The timeout has to come from the command line: test/helpers/integrationhelper
 * rebinds `it` to carry the card-test context and drops the options argument
 * along the way, so a per-test timeout set in the file is ignored.
 *
 * `gamestate.sync.spec.js` covers the same rules against a stubbed node and
 * runs everywhere; this one proves the two ends actually agree on the wire,
 * which is precisely what they had silently stopped doing
 * (docs/design/game-state-sync.md).
 */

const SERVER = process.env.AA_SERVER || 'http://127.0.0.1:4000';
const GAME_NODE = process.env.AA_GAME_NODE || 'http://127.0.0.1:9500';
const RUN = process.env.AA_E2E === '1';

async function api(path, body, token) {
    const response = await fetch(`${SERVER}${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: {
            'Content-Type': 'application/json',
            ...(token ? { Authorization: `Bearer ${token}` } : {})
        },
        body: body === undefined ? undefined : JSON.stringify(body)
    });

    return response.json();
}

function waitFor(socket, event, predicate = () => true, timeoutMs = 20000, label = event) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            socket.off(event, handler);
            reject(new Error(`Timed out waiting for ${label}`));
        }, timeoutMs);
        const handler = (...args) => {
            try {
                if (predicate(...args)) {
                    clearTimeout(timer);
                    socket.off(event, handler);
                    resolve(args);
                }
            } catch {
                // predicate errors mean "not yet"
            }
        };

        socket.on(event, handler);
    });
}

function waitUntil(condition, timeoutMs = 20000, label = 'condition') {
    return new Promise((resolve, reject) => {
        const started = Date.now();
        const tick = () => {
            if (condition()) {
                return resolve();
            }
            if (Date.now() - started > timeoutMs) {
                return reject(new Error(`Timed out waiting for ${label}`));
            }
            setTimeout(tick, 100);
        };

        tick();
    });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** The web client's pipeline: believe the node's marker, patch, count mistakes. */
class Mirror {
    constructor(seed) {
        this.rootState = seed;
        this.full = 0;
        this.deltas = 0;
        this.unmarked = 0;
        this.orphanDeltas = 0;
        this.fullWhileHolding = 0;
        this.patchErrors = [];
    }

    handle(payload, meta) {
        if (payload === undefined || payload === null) {
            return;
        }

        if (!meta) {
            this.unmarked++;

            return;
        }

        if (meta.full) {
            this.full++;
            if (this.rootState) {
                this.fullWhileHolding++;
            }
            this.rootState = payload;

            return;
        }

        this.deltas++;
        if (!this.rootState) {
            this.orphanDeltas++;

            return;
        }

        try {
            this.rootState = jsondiffpatch.patch(jsondiffpatch.clone(this.rootState), payload);
        } catch (err) {
            this.patchErrors.push(err.message);
        }
    }

    player(username) {
        return this.rootState && this.rootState.players && this.rootState.players[username];
    }
}

// `describe.skipIf` is not one of the shims the harness provides.
const suite = RUN ? describe : describe.skip;

suite('game state sync over a live node', function () {
    const sockets = [];
    const gameSockets = [];

    // Leave the game before closing, so the accounts are free and a second run
    // of this file can start one. Without it the lobby still has test0 and test1
    // in a game and the next run cannot get past 'joingame'.
    afterAll(async function () {
        for (const socket of gameSockets) {
            if (socket.connected) {
                socket.emit('game', 'leavegame');
            }
        }

        await sleep(500);

        for (const socket of sockets) {
            socket.close();
        }
    });

    const track = (socket) => {
        sockets.push(socket);

        return socket;
    };

    const lobbySocket = (token) =>
        track(
            io(SERVER, {
                transports: ['websocket'],
                reconnection: false,
                auth: { token, version: 'live-spec' }
            })
        );

    const gameNodeSocket = (nodeName, token) => {
        const socket = track(
            io(GAME_NODE, {
                path: `/${nodeName}/socket.io`,
                transports: ['websocket'],
                reconnection: false,
                auth: { token }
            })
        );
        gameSockets.push(socket);

        return socket;
    };

    it('marks whole boards, keeps deltas applying, resyncs live and hands over cleanly', async function () {
        // The dev-seed accounts; registering would need a mail sender.
        const tokens = [];
        for (const username of ['test0', 'test1']) {
            const result = await api('/api/account/login', { username, password: 'password' });
            expect(result.success, `login ${username}: ${result.message}`).toBe(true);
            tokens.push(result.token);
        }

        const lobby1 = lobbySocket(tokens[0]);
        const lobby2 = lobbySocket(tokens[1]);
        await waitFor(lobby1, 'connect');
        await waitFor(lobby2, 'connect');

        // The lobby authenticates after the transport connects; the 'users'
        // broadcast containing yourself is the signal that it is done.
        const authed = (socket, username) =>
            waitFor(
                socket,
                'users',
                (list) => list.some((entry) => entry.username === username),
                20000,
                `${username} authenticated`
            );
        await Promise.all([authed(lobby1, 'test0'), authed(lobby2, 'test1')]);

        const gameName = `state sync ${Date.now() % 1000000}`;
        lobby1.emit('newgame', {
            name: gameName,
            password: '',
            requirePassword: false,
            allowSpectators: true,
            showHand: false,
            gamePrivate: false,
            gameFormat: 'normal',
            useGameTimeLimit: false,
            gameTimeLimit: 45,
            quickJoin: false,
            expansions: { pv: true }
        });
        const [pending] = await waitFor(
            lobby1,
            'gamestate',
            (game) => game && game.name === gameName,
            20000,
            'pending game'
        );

        lobby2.emit('joingame', pending.id);
        await waitFor(
            lobby2,
            'gamestate',
            (game) => game && game.id === pending.id,
            20000,
            'opponent joined'
        );

        const standalone = await api('/api/standalone-decks', undefined, tokens[0]);
        expect(standalone.decks.length).toBeGreaterThan(0);
        const deckId = standalone.decks[0].id;
        lobby1.emit('selectdeck', pending.id, deckId, true);
        lobby2.emit('selectdeck', pending.id, deckId, true);
        await waitFor(
            lobby1,
            'gamestate',
            (game) => Object.values(game.players || {}).every((p) => p.deck && p.deck.selected),
            20000,
            'decks selected'
        );

        const handoffs = [];
        const bothHandoffs = Promise.all([
            waitFor(lobby1, 'handoff', () => true, 25000, 'handoff p1').then(([h]) =>
                handoffs.push(h)
            ),
            waitFor(lobby2, 'handoff', () => true, 25000, 'handoff p2').then(([h]) =>
                handoffs.push(h)
            )
        ]);
        lobby1.emit('startgame', pending.id);
        await bothHandoffs;

        const h1 = handoffs.find((h) => h.user.username === 'test0');
        const h2 = handoffs.find((h) => h.user.username === 'test1');

        const mirror1 = new Mirror();
        const mirror2 = new Mirror();
        const game1 = gameNodeSocket(h1.name, h1.authToken);
        const game2 = gameNodeSocket(h2.name, h2.authToken);
        game1.on('gamestate', (payload, meta) => mirror1.handle(payload, meta));
        game2.on('gamestate', (payload, meta) => mirror2.handle(payload, meta));
        await waitFor(game1, 'connect');
        await waitFor(game2, 'connect');
        await waitUntil(
            () => mirror1.rootState && mirror1.rootState.started && mirror2.rootState,
            25000,
            'the opening board'
        );

        expect(mirror1.full).toBe(1);
        expect(mirror1.unmarked).toBe(0);

        const press = (socket, mirror, username) => {
            const buttons = (mirror.player(username) || {}).buttons || [];
            if (buttons.length === 0) {
                return;
            }
            const button = buttons[0];
            socket.emit('game', 'menuButton', button.arg, button.uuid, button.method);
        };

        for (let round = 0; round < 40; round++) {
            press(game1, mirror1, 'test0');
            press(game2, mirror2, 'test1');
            await sleep(120);
        }

        expect(mirror1.deltas).toBeGreaterThan(3);
        expect(mirror2.deltas).toBeGreaterThan(3);
        expect(mirror1.patchErrors).toEqual([]);
        expect(mirror2.patchErrors).toEqual([]);
        expect(mirror1.orphanDeltas).toBe(0);
        // Proof the patched board is a board, not the wreckage a mistaken
        // delta leaves behind.
        expect(typeof mirror1.rootState.name).toBe('string');
        expect(mirror1.player('test0').cardPiles).toBeTruthy();

        // Resync over the live socket: a whole board, no reconnect, and the
        // opponent left alone.
        const fullBefore = mirror1.full;
        const opponentFullBefore = mirror2.full;
        game1.emit('game', 'resync');
        await waitUntil(() => mirror1.full > fullBefore, 15000, 'the resync snapshot');

        expect(mirror1.full).toBe(fullBefore + 1);
        expect(game1.connected).toBe(true);
        expect(mirror2.full).toBe(opponentFullBefore);

        const deltasBefore = mirror1.deltas;
        press(game1, mirror1, 'test0');
        press(game2, mirror2, 'test1');
        await sleep(800);
        expect(mirror1.deltas).toBeGreaterThan(deltasBefore);

        // The lobby re-sends the handoff on any fresh lobby connection while
        // a game is running. This is the event the web client used to answer
        // by rebuilding its game socket.
        const lobby3 = lobbySocket(tokens[0]);
        await waitFor(lobby3, 'connect');
        const [rehandoff] = await waitFor(lobby3, 'handoff', () => true, 20000, 're-handoff');
        expect(rehandoff.gameId).toBe(pending.id);
        expect(rehandoff.authToken).toBeTruthy();

        // A second connection for the same account. The board this mirror is
        // seeded with makes it the exact shape of the old failure: a client
        // already holding a board being sent a whole one.
        const evicted = waitFor(game1, 'disconnect', () => true, 15000, 'the eviction');
        const mirror1b = new Mirror(JSON.parse(JSON.stringify(mirror1.rootState)));
        const game1b = gameNodeSocket(rehandoff.name, rehandoff.authToken);
        game1b.on('gamestate', (payload, meta) => mirror1b.handle(payload, meta));
        await waitFor(game1b, 'connect');
        await waitUntil(() => mirror1b.full > 0, 20000, 'the takeover board');

        const [reason] = await evicted;
        expect(game1.connected).toBe(false);
        // Not merely closed: closed in the way socket.io does not silently
        // retry, so the two clients cannot take turns evicting each other.
        expect(reason).toBe('io server disconnect');
        expect(mirror1b.fullWhileHolding).toBe(1);
        expect(mirror1b.patchErrors).toEqual([]);
        expect(typeof mirror1b.rootState.name).toBe('string');

        // And the game carries on through the takeover.
        const opponentDeltasBefore = mirror2.deltas;
        for (let round = 0; round < 20; round++) {
            press(game1b, mirror1b, 'test0');
            press(game2, mirror2, 'test1');
            await sleep(120);
        }

        expect(mirror2.deltas).toBeGreaterThan(opponentDeltasBefore);
        expect(mirror2.patchErrors).toEqual([]);
        expect(mirror1b.patchErrors).toEqual([]);
        expect(mirror1b.orphanDeltas).toBe(0);
    });
});
