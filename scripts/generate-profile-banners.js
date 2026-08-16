/* eslint-disable no-console */
/**
 * ARCHON (N12): builds the profile banner strips in
 * client/assets/img/banners/ from the game board art in
 * client/assets/img/bgs/.
 *
 *     node scripts/generate-profile-banners.js
 *
 * Why a separate set of files rather than reusing the board backgrounds
 * directly: the board art is square-ish and, for the two set illustrations,
 * enormous - philophosaurus.png alone is 4.1MB and keyforge.png is 2MB. A
 * profile banner is a short, wide strip behind a name, and downloading four
 * megabytes to draw one is not a decoration anybody agreed to. Cropped to
 * 1200x300 and re-encoded as JPEG, the whole set of eighteen is under half a
 * megabyte, and every banner is between 13KB and 47KB.
 *
 * Rerun after adding art to bgs/ and a matching entry to the catalogue in
 * server/services/membership/cosmetics.js. The client picks banners up from a
 * glob over the output directory, so nothing else needs editing.
 */
const fs = require('fs');
const path = require('path');
const Jimp = require('jimp-compact');

const SOURCE = path.join(__dirname, '..', 'client', 'assets', 'img', 'bgs');
const OUT = path.join(__dirname, '..', 'client', 'assets', 'img', 'banners');

// Wide enough for a full-width header on a large screen without being worth
// retina-doubling for something that sits behind text.
const WIDTH = 1200;
const HEIGHT = 300;
const QUALITY = 78;

/** Board art that is NOT offered as a banner. */
const EXCLUDED = ['blank'];

async function main() {
    fs.mkdirSync(OUT, { recursive: true });

    const sources = fs
        .readdirSync(SOURCE)
        .filter((file) => file.endsWith('.png'))
        .filter((file) => !EXCLUDED.includes(path.basename(file, '.png')));

    for (const file of sources) {
        const name = path.basename(file, '.png');
        const image = await Jimp.read(path.join(SOURCE, file));

        // Fill the strip and centre-crop, rather than squashing the art.
        image.cover(WIDTH, HEIGHT, Jimp.HORIZONTAL_ALIGN_CENTER | Jimp.VERTICAL_ALIGN_MIDDLE);
        image.quality(QUALITY);

        const out = path.join(OUT, `${name}.jpg`);

        await image.writeAsync(out);
        console.log(`${name}: ${(fs.statSync(out).size / 1024).toFixed(0)}KB`);
    }
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
