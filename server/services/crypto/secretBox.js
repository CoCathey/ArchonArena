const crypto = require('node:crypto');

const logger = require('../../log');

/**
 * ARCHON: authenticated encryption for third-party credentials we have to keep.
 *
 * The site holds two secrets that belong to somebody else - a player's Decks of
 * KeyForge API key, and their Patreon token. Neither is ours, neither is a
 * password we could hash instead, and both have to come back out in plaintext
 * to be used. So they are encrypted at rest and the database alone is not
 * enough to read them.
 *
 * AES-256-GCM rather than CBC or raw AES: these values are attacker-visible if
 * the database leaks, and a mode without authentication would let ciphertext be
 * altered without detection. GCM's tag makes tampering a decryption failure.
 *
 * The stored form is self-describing - `v1.<iv>.<tag>.<ciphertext>`, all
 * base64url - so a later scheme can be added beside this one and old values
 * still read. Anything that is not recognisably v1 is treated as legacy
 * plaintext by `decrypt`, which is what lets a column be encrypted going
 * forward without a rewrite migration over rows nobody may be able to decrypt.
 */
const VERSION = 'v1';
const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;
const TAG_BYTES = 16;

/**
 * The 32-byte key, derived once from the site secret.
 *
 * Deriving rather than using `secret` raw: it is a human-chosen string of
 * arbitrary length, and scrypt turns it into exactly 32 bytes of key material
 * without the caller having to think about it. The salt is fixed and public on
 * purpose - it exists to domain-separate this key from anything else derived
 * from the same secret, not to defend a password against a dictionary.
 *
 * Consequence worth knowing: rotating the site secret makes every stored value
 * unreadable. That is why decrypt failure is a soft "no value" rather than an
 * error - a player whose key cannot be decrypted is asked for it again, which
 * is the correct outcome and not a broken page.
 */
function deriveKey(secret) {
    return crypto.scryptSync(String(secret), 'archon-secret-box-v1', 32);
}

class SecretBox {
    /**
     * @param {string} secret the site secret; anything falsy disables the box,
     *   which makes storing a credential fail closed rather than storing it in
     *   the clear.
     */
    constructor(secret) {
        this.key = secret ? deriveKey(secret) : null;
    }

    isConfigured() {
        return !!this.key;
    }

    /**
     * Returns the sealed string, or null if it could not be sealed. Null is a
     * refusal to store, never a signal to store the plaintext instead.
     */
    encrypt(plaintext) {
        if (!this.key || typeof plaintext !== 'string' || plaintext === '') {
            return null;
        }

        try {
            const iv = crypto.randomBytes(IV_BYTES);
            const cipher = crypto.createCipheriv(ALGORITHM, this.key, iv);
            const sealed = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);

            return [
                VERSION,
                iv.toString('base64url'),
                cipher.getAuthTag().toString('base64url'),
                sealed.toString('base64url')
            ].join('.');
        } catch (err) {
            logger.error(`Failed to encrypt a stored secret: ${err.message}`);

            return null;
        }
    }

    /**
     * Returns the plaintext, or null when it cannot be recovered - a rotated
     * site secret, a corrupted row, a tampered ciphertext. Callers treat null
     * as "we do not have this" and ask the player again.
     *
     * A value that is not in the v1 form is returned unchanged, so a column
     * that used to hold plaintext keeps working while it is being migrated one
     * write at a time.
     */
    decrypt(payload) {
        if (typeof payload !== 'string' || payload === '') {
            return null;
        }

        const parts = payload.split('.');

        if (parts.length !== 4 || parts[0] !== VERSION) {
            return payload;
        }

        if (!this.key) {
            return null;
        }

        try {
            const iv = Buffer.from(parts[1], 'base64url');
            const tag = Buffer.from(parts[2], 'base64url');

            if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) {
                return null;
            }

            const decipher = crypto.createDecipheriv(ALGORITHM, this.key, iv);
            decipher.setAuthTag(tag);

            return Buffer.concat([
                decipher.update(Buffer.from(parts[3], 'base64url')),
                decipher.final()
            ]).toString('utf8');
        } catch {
            // Deliberately not logged at error: a rotated secret would fill the
            // log with one line per stored credential per read, and the outcome
            // is already visible to the player as "please re-enter your key".
            return null;
        }
    }

    /** Whether a stored value is still in the pre-encryption plaintext form. */
    isSealed(payload) {
        return typeof payload === 'string' && payload.startsWith(`${VERSION}.`);
    }
}

module.exports = SecretBox;
