/**
 * Live end-to-end protocol test against a running ArchonArena backend.
 *
 * Skipped unless AA_E2E=1 is set, because it needs the real stack:
 *   postgres + redis running, cards + standalone decks imported,
 *   lobby (`node .`) on :4000 and a game node (`node server/gamenode`)
 *   on :9500 (see docs/local-development.md in the platform repo).
 *
 * It drives two players through the exact protocol the mobile app uses —
 * REST auth, lobby socket, deck select, handoff, game-node socket — and pipes
 * every gamestate through the app's own jsondiffpatch-compatible patcher
 * (src/net/jsonpatch.ts), proving the app's state pipeline against real
 * server deltas.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { io, Socket } from 'socket.io-client';
import { patch } from '../src/net/jsonpatch';

const SERVER = process.env.AA_SERVER ?? 'http://127.0.0.1:4000';
const GAME_NODE = process.env.AA_GAME_NODE ?? 'http://127.0.0.1:9500';
const RUN = process.env.AA_E2E === '1';

interface Json {
    [key: string]: any;
}

async function api(path: string, body?: Json, token?: string): Promise<Json> {
    const response = await fetch(`${SERVER}${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: {
            'Content-Type': 'application/json',
            ...(token ? { Authorization: `Bearer ${token}` } : {})
        },
        body: body === undefined ? undefined : JSON.stringify(body)
    });
    return (await response.json()) as Json;
}

function waitForEvent<T = any>(
    socket: Socket,
    event: string,
    predicate: (payload: T) => boolean = () => true,
    timeoutMs = 15000,
    label = event
): Promise<T> {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            socket.off(event, handler);
            reject(new Error(`Timed out waiting for '${label}'`));
        }, timeoutMs);
        const handler = (payload: T) => {
            try {
                if (predicate(payload)) {
                    clearTimeout(timer);
                    socket.off(event, handler);
                    resolve(payload);
                }
            } catch {
                // predicate errors are treated as "not yet"
            }
        };
        socket.on(event, handler);
    });
}

function waitUntil(check: () => boolean, timeoutMs = 15000, label = 'condition'): Promise<void> {
    return new Promise((resolve, reject) => {
        const started = Date.now();
        const tick = () => {
            if (check()) {
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

/** Mirrors the mobile app's game store: full state on first message, patch after. */
class AppStateMirror {
    rootState: Json | undefined;
    patchCount = 0;
    errors: unknown[] = [];

    handle(payload: unknown) {
        if (payload === undefined || payload === null) {
            return;
        }
        try {
            if (this.rootState) {
                this.rootState = patch(this.rootState, payload) as Json;
                this.patchCount++;
            } else {
                this.rootState = payload as Json;
            }
        } catch (err) {
            this.errors.push(err);
        }
    }

    player(name: string): Json | undefined {
        return this.rootState?.players?.[name];
    }
}

const sockets: Socket[] = [];

function lobbySocket(token: string): Socket {
    const socket = io(SERVER, {
        transports: ['websocket'],
        reconnection: false,
        auth: { token, version: 'archon-arena-mobile' }
    });
    sockets.push(socket);
    return socket;
}

function gameSocket(nodeName: string, token: string): Socket {
    const socket = io(GAME_NODE, {
        path: `/${nodeName}/socket.io`,
        transports: ['websocket'],
        reconnection: false,
        auth: { token }
    });
    sockets.push(socket);
    return socket;
}

afterAll(() => {
    for (const socket of sockets) {
        socket.close();
    }
});

describe.skipIf(!RUN)('live server protocol', () => {
    it(
        'plays through lobby, handoff and game patching end to end',
        { timeout: 120000 },
        async () => {
            const suffix = `${Date.now() % 1000000}`;
            const users = [
                { username: `mob1${suffix}`, password: 'secret123' },
                { username: `mob2${suffix}`, password: 'secret123' }
            ];

            // -- REST: register + login (same calls as src/api/client.ts) --
            for (const user of users) {
                const result = await api('/api/account/register', {
                    username: user.username,
                    email: `${user.username}@example.com`,
                    password: user.password
                });
                expect(result.success, `register: ${result.message}`).toBe(true);
            }

            const tokens: string[] = [];
            for (const user of users) {
                const result = await api('/api/account/login', {
                    username: user.username,
                    password: user.password
                });
                expect(result.success, `login: ${result.message}`).toBe(true);
                expect(result.token).toBeTruthy();
                expect(result.refreshToken?.id).toBeTruthy();
                tokens.push(result.token);
            }

            // Refresh-token flow used by the app on JWT expiry.
            const loginAgain = await api('/api/account/login', users[0]);
            const refreshed = await api('/api/account/token', {
                token: loginAgain.refreshToken
            });
            expect(refreshed.success).toBe(true);
            expect(refreshed.token).toBeTruthy();

            // -- Lobby sockets --
            const l1 = lobbySocket(tokens[0]);
            const l2 = lobbySocket(tokens[1]);
            await waitForEvent(l1, 'connect');
            await waitForEvent(l2, 'connect');

            // The lobby authenticates the socket asynchronously after the
            // transport connects; events emitted before that completes are
            // silently dropped. The 'users' broadcast that includes yourself
            // is the auth-complete signal.
            const authed = (socket: Socket, username: string) =>
                waitForEvent<Json[]>(
                    socket,
                    'users',
                    (list) => list.some((entry) => entry.username === username),
                    15000,
                    `${username} socket authenticated`
                );
            await Promise.all([authed(l1, users[0].username), authed(l2, users[1].username)]);

            // -- Create + join a game (payload shape from app/new-game.tsx) --
            const gameName = `mobile e2e ${suffix}`;
            l1.emit('newgame', {
                name: gameName,
                password: '',
                requirePassword: false,
                allowSpectators: true,
                showHand: false,
                gamePrivate: false,
                gameFormat: 'normal',
                gameType: 'casual',
                useGameTimeLimit: false,
                gameTimeLimit: 45,
                quickJoin: false,
                expansions: { pv: true }
            });

            const pending1 = await waitForEvent<Json>(
                l1,
                'gamestate',
                (game) => game?.name === gameName,
                15000,
                'pending game for p1'
            );
            const gameId = pending1.id as string;
            expect(gameId).toBeTruthy();

            l2.emit('joingame', gameId);
            await waitForEvent<Json>(
                l2,
                'gamestate',
                (game) => game?.id === gameId,
                15000,
                'pending game for p2'
            );

            // -- Standalone decks + selectdeck --
            const standalone = await api('/api/standalone-decks', undefined, tokens[0]);
            expect(standalone.success).toBe(true);
            expect(standalone.decks.length).toBeGreaterThan(0);
            const deckId = standalone.decks[0].id;

            l1.emit('selectdeck', gameId, deckId, true);
            l2.emit('selectdeck', gameId, deckId, true);

            await waitForEvent<Json>(
                l1,
                'gamestate',
                (game) =>
                    Object.values(game?.players ?? {}).every(
                        (player: any) => player.deck?.selected
                    ),
                15000,
                'both decks selected'
            );

            // -- Start + handoff --
            const handoffs: Json[] = [];
            const handoffWait = Promise.all([
                waitForEvent<Json>(l1, 'handoff', () => true, 20000, 'handoff p1').then((h) =>
                    handoffs.push(h)
                ),
                waitForEvent<Json>(l2, 'handoff', () => true, 20000, 'handoff p2').then((h) =>
                    handoffs.push(h)
                )
            ]);
            l1.emit('startgame', gameId);
            await handoffWait;

            const h1 = handoffs.find((h) => h.user.username === users[0].username)!;
            const h2 = handoffs.find((h) => h.user.username === users[1].username)!;
            expect(h1?.name).toBeTruthy();
            expect(h1.gameId).toBe(gameId);
            expect(h1.authToken).toBeTruthy();

            // -- Game node sockets + the app's patching pipeline --
            const s1 = new AppStateMirror();
            const s2 = new AppStateMirror();
            const g1 = gameSocket(h1.name, h1.authToken);
            const g2 = gameSocket(h2.name, h2.authToken);
            g1.on('gamestate', (payload) => s1.handle(payload));
            g2.on('gamestate', (payload) => s2.handle(payload));
            await waitForEvent(g1, 'connect');
            await waitForEvent(g2, 'connect');

            await waitUntil(
                () => !!s1.rootState?.started && !!s2.rootState?.started,
                20000,
                'initial full game state'
            );
            expect(s1.player(users[0].username)).toBeTruthy();
            expect(s1.player(users[1].username)).toBeTruthy();

            // -- Drive the game like the UI would: press prompt buttons --
            // (mulligan prompts, house choice, end-turn loop...)
            const clickButton = (
                socket: Socket,
                mirror: AppStateMirror,
                username: string
            ): boolean => {
                const player = mirror.player(username);
                const buttons: Json[] = player?.buttons ?? [];
                if (buttons.length === 0) {
                    return false;
                }
                const preferred =
                    buttons.find((b) => /keep/i.test(String(b.text))) ??
                    buttons.find((b) => /done|yes|end turn|continue/i.test(String(b.text))) ??
                    buttons[0];
                socket.emit(
                    'game',
                    preferred.command ?? 'menuButton',
                    preferred.arg,
                    preferred.uuid,
                    preferred.method
                );
                return true;
            };

            const phasesSeen = new Set<string>();
            for (let step = 0; step < 40; step++) {
                for (const player of Object.values<Json>(s1.rootState?.players ?? {})) {
                    if (player.phase) {
                        phasesSeen.add(String(player.phase));
                    }
                }
                const acted1 = clickButton(g1, s1, users[0].username);
                const acted2 = clickButton(g2, s2, users[1].username);
                await new Promise((resolve) => setTimeout(resolve, 350));
                if (!acted1 && !acted2 && step > 5 && phasesSeen.has('main')) {
                    break;
                }
            }

            expect(s1.errors, `p1 patch errors: ${s1.errors[0]}`).toHaveLength(0);
            expect(s2.errors, `p2 patch errors: ${s2.errors[0]}`).toHaveLength(0);
            expect(s1.patchCount).toBeGreaterThan(0);
            expect(phasesSeen.has('main') || phasesSeen.has('house')).toBe(true);

            // -- Chat over the game socket, seen by the other player --
            const chatText = `hello from mobile e2e ${suffix}`;
            g1.emit('game', 'chat', chatText);
            await waitUntil(
                () =>
                    JSON.stringify(s2.rootState?.messages ?? []).includes(chatText) &&
                    JSON.stringify(s1.rootState?.messages ?? []).includes(chatText),
                15000,
                'chat visible in both patched states'
            );

            // -- Concede ends the game with a winner --
            g2.emit('game', 'concede');
            await waitUntil(
                () => !!s1.rootState?.winner || !!s2.rootState?.winner,
                15000,
                'winner after concede'
            );
            expect(s1.rootState?.winner ?? s2.rootState?.winner).toBe(users[0].username);

            expect(s1.errors).toHaveLength(0);
            expect(s2.errors).toHaveLength(0);

            // -- Leave cleanly --
            g1.emit('game', 'leavegame');
            g2.emit('game', 'leavegame');
        }
    );
});
