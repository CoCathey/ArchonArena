import type { HandoffMessage } from '../api/types';

const STANDARD_PORTS = [80, 443];

// Addresses a game node may advertise for itself that are meaningless to a
// remote phone (they describe the node from *inside* the server/proxy network).
const INTERNAL_HOSTS = ['', 'undefined', 'localhost', '127.0.0.1', '0.0.0.0'];

/**
 * Build the origin the game-node socket should connect to, from a lobby
 * handoff and the lobby's own URL.
 *
 * The game node sits behind the same reverse proxy as the lobby and is reached
 * on the lobby's origin via a path route (`/<handoff.name>/socket.io`) — this
 * mirrors the web client (client/redux/middleware/socket-middleware.js), which
 * connects with a protocol-relative `//host` (the page's protocol) and ignores
 * `handoff.protocol`.
 *
 * We deliberately do NOT trust `handoff.protocol` or an internal
 * `handoff.address`: in the standard Docker/Caddy deploy TLS terminates at the
 * proxy, so the node advertises `protocol: "http"`, `port: 80`, and a
 * loopback/internal address. Using those would make iOS attempt a cleartext
 * `http://…` connection (blocked by App Transport Security) to the wrong host.
 * Instead we use the lobby's protocol and host — the same origin the app
 * already reaches for auth and the lobby socket.
 *
 * A non-standard advertised port is still honored, so a directly-exposed game
 * node (e.g. local dev on :9500) keeps working.
 */
export function buildGameNodeUrl(handoff: HandoffMessage, serverUrl: string): string {
    const lobbyHost = serverUrl.replace(/^https?:\/\//, '').replace(/[:/].*$/, '');
    const protocol = serverUrl.startsWith('http://') ? 'http' : 'https';

    const address = (handoff.address ?? '').trim();
    const host =
        address && !INTERNAL_HOSTS.includes(address.toLowerCase()) ? address : lobbyHost;

    let url = `${protocol}://${host}`;
    if (handoff.port && !STANDARD_PORTS.includes(handoff.port)) {
        url += `:${handoff.port}`;
    }
    return url;
}
