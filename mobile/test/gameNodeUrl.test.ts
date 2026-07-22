import { describe, expect, it } from 'vitest';
import { buildGameNodeUrl } from '../src/net/gameNodeUrl';
import type { HandoffMessage } from '../src/api/types';

function handoff(partial: Partial<HandoffMessage>): HandoffMessage {
    return {
        authToken: 't',
        gameId: 'g',
        name: 'node-0',
        user: { id: '1', username: 'u' },
        ...partial
    };
}

describe('buildGameNodeUrl', () => {
    it('production Docker/Caddy: node advertises http:80 behind the proxy → use the lobby https origin', () => {
        // This is the exact TestFlight failure: the node reports protocol "http"
        // and port 80 because TLS terminates at Caddy. The app must still connect
        // over https to the lobby origin (same-origin, path-routed), NOT cleartext.
        const url = buildGameNodeUrl(
            handoff({ protocol: 'http', port: 80, address: undefined }),
            'https://archonarena.com'
        );
        expect(url).toBe('https://archonarena.com');
    });

    it('ignores an internal/loopback advertised address and uses the lobby host', () => {
        expect(
            buildGameNodeUrl(
                handoff({ protocol: 'http', port: 80, address: 'localhost' }),
                'https://archonarena.com'
            )
        ).toBe('https://archonarena.com');
        expect(
            buildGameNodeUrl(
                handoff({ protocol: 'http', port: 80, address: '127.0.0.1' }),
                'https://play.example.org'
            )
        ).toBe('https://play.example.org');
    });

    it('never emits a cleartext URL when the lobby is https, regardless of handoff.protocol', () => {
        const url = buildGameNodeUrl(
            handoff({ protocol: 'http', port: 80 }),
            'https://archonarena.com'
        );
        expect(url.startsWith('https://')).toBe(true);
        expect(url.startsWith('http://')).toBe(false);
    });

    it('local dev: honors a non-standard directly-exposed port on the lobby host', () => {
        const url = buildGameNodeUrl(
            handoff({ protocol: 'http', port: 9500, address: 'localhost', name: 'test1' }),
            'http://127.0.0.1:4000'
        );
        expect(url).toBe('http://127.0.0.1:9500');
    });

    it('honors a genuine external game-node host (multi-host, non-proxied)', () => {
        const url = buildGameNodeUrl(
            handoff({ protocol: 'https', port: 8443, address: 'node1.example.com' }),
            'https://lobby.example.com'
        );
        expect(url).toBe('https://node1.example.com:8443');
    });

    it('does not append standard ports', () => {
        expect(
            buildGameNodeUrl(handoff({ port: 443, address: 'n.example.com' }), 'https://x.com')
        ).toBe('https://n.example.com');
        expect(buildGameNodeUrl(handoff({ port: 80 }), 'https://x.com')).toBe('https://x.com');
    });
});
