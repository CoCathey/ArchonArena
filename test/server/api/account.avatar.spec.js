const fs = require('fs');
const path = require('path');
const { createCanvas } = require('canvas');
const { PNG } = require('pngjs');

const { processAvatar } = require('../../../server/api/account');

const AVATAR_DIR = path.resolve('public/img/avatar');

/**
 * A real PNG, at a deliberately wrong size, as base64 - the same shape the
 * client posts an uploaded avatar in.
 */
const samplePng = (width, height) => {
    const canvas = createCanvas(width, height);
    const context = canvas.getContext('2d');

    context.fillStyle = '#204080';
    context.fillRect(0, 0, width, height);
    context.fillStyle = '#f0c000';
    context.fillRect(0, 0, width / 2, height / 2);

    return canvas.toBuffer('image/png').toString('base64');
};

/** processAvatar writes through a stream it does not hand back, so wait for it. */
const readWhenWritten = async (fileName) => {
    const file = path.join(AVATAR_DIR, `${fileName}.png`);

    for (let attempt = 0; attempt < 100; attempt++) {
        if (fs.existsSync(file) && fs.statSync(file).size > 0) {
            const buffer = fs.readFileSync(file);

            try {
                return PNG.sync.read(buffer);
            } catch {
                // Still mid-write; the next poll gets the whole file.
            }
        }

        await new Promise((resolve) => setTimeout(resolve, 20));
    }

    throw new Error(`avatar ${file} was never written`);
};

/**
 * ARCHON: avatar upload is the only place the server draws with Fabric on a
 * request path, and nothing covered it. Fabric 6 turned `Image.fromURL` from a
 * callback into a promise, which is exactly the kind of change that leaves a
 * function silently returning before it has done anything.
 */
describe('processAvatar', function () {
    const written = [];

    // In a deployment the directory already exists - registration creates it
    // when it fetches the gravatar fallback - and processAvatar does not make
    // it itself. A fresh checkout has no `public/img`.
    beforeEach(() => fs.mkdirSync(AVATAR_DIR, { recursive: true }));

    afterEach(() => {
        for (const fileName of written.splice(0)) {
            const file = path.join(AVATAR_DIR, `${fileName}.png`);

            if (fs.existsSync(file)) {
                fs.unlinkSync(file);
            }
        }
    });

    it('writes a square 96px png whatever the upload was sized', async function () {
        // Deliberately smaller than the avatar in both directions, so an
        // upload that was written out without being scaled up would leave
        // transparent margin and fail the coverage check below.
        const fileName = await processAvatar(
            { avatar: samplePng(40, 24) },
            { username: 'avatartester', settings: {} }
        );

        expect(fileName).toBeTruthy();
        written.push(fileName);

        const png = await readWhenWritten(fileName);

        expect(png.width).toBe(96);
        expect(png.height).toBe(96);

        const transparent = [...Array(png.width * png.height).keys()].filter(
            (i) => png.data[i * 4 + 3] === 0
        );

        expect(transparent.length).toBe(0);
    });

    it('returns null rather than throwing when the upload will not decode', async function () {
        const fileName = await processAvatar(
            { avatar: Buffer.from('not an image at all').toString('base64') },
            { username: 'avatartester', settings: {} }
        );

        expect(fileName).toBe(null);
    });
});
