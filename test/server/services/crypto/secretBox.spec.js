const SecretBox = require('../../../../server/services/crypto/secretBox');

describe('SecretBox', function () {
    const box = () => new SecretBox('a-site-secret');

    it('round-trips a value', function () {
        const sealed = box().encrypt('dok-api-key-12345');

        expect(sealed).not.toContain('dok-api-key-12345');
        expect(box().decrypt(sealed)).toBe('dok-api-key-12345');
    });

    // Same plaintext twice must not produce the same ciphertext, or the store
    // leaks which players share a key.
    it('never produces the same ciphertext twice', function () {
        const a = box().encrypt('same');
        const b = box().encrypt('same');

        expect(a).not.toBe(b);
        expect(box().decrypt(a)).toBe('same');
        expect(box().decrypt(b)).toBe('same');
    });

    it('is self-describing and versioned', function () {
        const sealed = box().encrypt('x');

        expect(sealed.startsWith('v1.')).toBe(true);
        expect(sealed.split('.')).toHaveLength(4);
        expect(box().isSealed(sealed)).toBe(true);
        expect(box().isSealed('plain-old-value')).toBe(false);
    });

    // GCM's whole point: a changed byte must fail, not decrypt to garbage.
    it('refuses a tampered ciphertext rather than returning rubbish', function () {
        const parts = box().encrypt('secret-value').split('.');
        const body = Buffer.from(parts[3], 'base64url');
        body[0] ^= 0xff;
        parts[3] = body.toString('base64url');

        expect(box().decrypt(parts.join('.'))).toBeNull();
    });

    it('refuses a tampered auth tag', function () {
        const parts = box().encrypt('secret-value').split('.');
        const tag = Buffer.from(parts[2], 'base64url');
        tag[0] ^= 0xff;
        parts[2] = tag.toString('base64url');

        expect(box().decrypt(parts.join('.'))).toBeNull();
    });

    // Rotating the site secret must degrade to "we do not have this key", so
    // the player is asked again rather than shown a broken page.
    it('returns null when the site secret has changed', function () {
        const sealed = box().encrypt('dok-key');

        expect(new SecretBox('a-different-secret').decrypt(sealed)).toBeNull();
    });

    // The migration path: a column that still holds plaintext keeps working
    // while it is re-encrypted one write at a time.
    it('passes a legacy plaintext value straight through', function () {
        expect(box().decrypt('{"access_token":"legacy"}')).toBe('{"access_token":"legacy"}');
    });

    // Fail closed. Returning the plaintext when there is no key would store a
    // credential in the clear at exactly the moment nobody meant to.
    it('refuses to encrypt at all without a site secret', function () {
        const unconfigured = new SecretBox('');

        expect(unconfigured.isConfigured()).toBe(false);
        expect(unconfigured.encrypt('dok-key')).toBeNull();
    });

    it('cannot read a sealed value without a site secret', function () {
        const sealed = box().encrypt('dok-key');

        expect(new SecretBox('').decrypt(sealed)).toBeNull();
    });

    it('handles empty and non-string input without throwing', function () {
        expect(box().encrypt('')).toBeNull();
        expect(box().encrypt(undefined)).toBeNull();
        expect(box().decrypt('')).toBeNull();
        expect(box().decrypt(undefined)).toBeNull();
        expect(box().decrypt('v1.only.three')).toBe('v1.only.three');
        expect(box().decrypt('v1.!!.!!.!!')).toBeNull();
    });
});

// The Patreon token moved onto the same seal. These pin the two properties
// that make that safe to do without a rewrite migration.
describe('UserService Patreon token handling', function () {
    const UserService = require('../../../../server/services/UserService');

    const svc = (secret) => new UserService({ getValue: () => secret });

    it('reads a token written before encryption existed', function () {
        expect(svc('s').readPatreonToken('{"access_token":"legacy"}')).toEqual({
            access_token: 'legacy'
        });
    });

    it('round-trips a sealed token', function () {
        const service = svc('s');
        const sealed = service.secretBox.encrypt(JSON.stringify({ access_token: 'new' }));

        expect(service.readPatreonToken(sealed)).toEqual({ access_token: 'new' });
    });

    // A rotated site secret must cost a supporter their badge, not their login.
    it('gives up quietly when the token cannot be read', function () {
        const sealed = svc('one').secretBox.encrypt(JSON.stringify({ access_token: 'x' }));

        expect(svc('two').readPatreonToken(sealed)).toBeUndefined();
        expect(svc('s').readPatreonToken('not json at all')).toBeUndefined();
        expect(svc('s').readPatreonToken(null)).toBeUndefined();
    });
});
