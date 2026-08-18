const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const { FabricImage, StaticCanvas } = require('../../fabricNode');
const logger = require('../../log.js');

/**
 * ARCHON: the picture pipeline, shared by everything that has a picture.
 *
 * This was account.js's private machinery until the practice bots needed it
 * (F9): a bot is an ordinary account, so an admin setting a bot's picture
 * must land in exactly the same place, at the same size, with the same
 * path-traversal and file-type checks a person's upload gets. Two copies of
 * a routine that writes attacker-influenced filenames to disk is precisely
 * the kind of duplication that ends with only one copy being fixed.
 */

// ARCHON: avatars were stored at 24x24 - the exact size the web client draws
// them at, and a blurry mess on any high-DPI screen (the mobile app shows them
// considerably larger). Stored at 96 they stay crisp everywhere; the web is
// unaffected since it scales them down in CSS, and avatars already on disk keep
// working untouched.
const AVATAR_SIZE = 96;

const AVATAR_DIR = 'public/img/avatar';

/** PNG or JPEG magic bytes - anything else is not a picture. */
function isValidImage(base64Image) {
    let buffer = Buffer.from(base64Image, 'base64');

    return buffer.toString('hex', 0, 4) === '89504e47' || buffer.toString('hex', 0, 2) === 'ffd8';
}

function sanitizePathSegment(input) {
    return String(input || '').replace(/[^A-Za-z0-9_-]/g, '');
}

/**
 * Resolve `<baseDir>/<name>.png`, refusing anything that would escape the
 * directory. The name is user-influenced (it is built from a username), so
 * this is a boundary check rather than a formality.
 */
function buildPngPath(baseDir, name) {
    const safeName = sanitizePathSegment(name);
    if (!safeName) {
        throw new Error('Invalid file name');
    }

    const resolvedBase = path.resolve(baseDir);
    const resolvedFile = path.resolve(resolvedBase, `${safeName}.png`);

    if (!resolvedFile.startsWith(resolvedBase + path.sep)) {
        throw new Error('Invalid file path');
    }

    return resolvedFile;
}

function removePng(baseDir, name) {
    if (!name) {
        return;
    }

    try {
        const resolvedPath = buildPngPath(baseDir, name);
        if (fs.existsSync(resolvedPath)) {
            fs.unlinkSync(resolvedPath);
        }
    } catch (err) {
        logger.warn(`Failed to resolve file path for ${name}`, err);
    }
}

async function processImage(image, width, height) {
    const canvas = new StaticCanvas(null, { width, height });
    // Fabric rejects rather than yielding a null image when the data URL will
    // not decode, so an unusable avatar arrives here as a throw and is caught
    // by the caller exactly as the old null check was.
    const img = await FabricImage.fromURL('data:image/png;base64,' + image, {
        crossOrigin: 'anonymous'
    });

    if (!img || img.getElement() == null) {
        throw new Error('Error occurred in fabric');
    }

    // Not chained: from v6 these return nothing rather than the object.
    img.scaleToWidth(width);
    img.scaleToHeight(height);
    img.set({
        originX: 'center',
        originY: 'center',
        left: width / 2,
        top: height / 2
    });
    canvas.add(img);
    canvas.renderAll();

    return canvas;
}

/**
 * Write a new avatar for an account and return the name to store on it.
 *
 * The name carries a random suffix so a changed picture is a changed URL -
 * browsers and CDNs cache `/img/avatar/<name>.png` hard, and reusing the name
 * shows the old face for as long as the cache lives. The previous file is
 * deleted, so a busy account cannot accumulate them.
 *
 * @returns {Promise<string|null>} the stored avatar name, or null if the
 *          image could not be decoded (the caller keeps the old one).
 */
async function saveAvatarImage({ base64Image, username, previousAvatar }) {
    const hash = crypto.randomBytes(16).toString('hex');

    removePng(AVATAR_DIR, previousAvatar);

    let canvas;

    try {
        canvas = await processImage(base64Image, AVATAR_SIZE, AVATAR_SIZE);
    } catch (err) {
        logger.error(err);

        return null;
    }

    const fileName = `${sanitizePathSegment(username)}-${hash}`;

    if (!fs.existsSync(AVATAR_DIR)) {
        fs.mkdirSync(AVATAR_DIR, { recursive: true });
    }

    const stream = canvas.createPNGStream();
    const out = fs.createWriteStream(buildPngPath(AVATAR_DIR, fileName));

    stream.on('data', (chunk) => {
        out.write(chunk);
    });

    return fileName;
}

module.exports = {
    AVATAR_SIZE,
    AVATAR_DIR,
    isValidImage,
    sanitizePathSegment,
    buildPngPath,
    removePng,
    processImage,
    saveAvatarImage
};
