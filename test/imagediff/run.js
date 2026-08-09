#!/usr/bin/env node
/**
 * ARCHON: capture and compare the archon maker's output.
 *
 *   node test/imagediff/run.js --update    write the baselines
 *   node test/imagediff/run.js             compare against them (exit 1 on drift)
 *
 * Why this exists: the deck list, the card back and every card image are drawn
 * by Fabric in `client/archonMaker.js`, and nothing in the suite looks at the
 * result. A Fabric major upgrade, a font change or a token change can move text
 * a pixel or drop a shadow with every test still green. This renders a fixed
 * set of those images in a real browser and diffs them byte for byte.
 *
 * It drives Vite's dev server rather than the production bundle so the harness
 * imports the same source the app does - a baseline taken against a stale
 * `dist/` would be a baseline of the previous release.
 */
const { createServer } = require('vite');
const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const { PNG } = require('pngjs');

const BASELINE_DIR = path.join(__dirname, 'baseline');
const OUTPUT_DIR = path.join(__dirname, 'current');
const DIFF_DIR = path.join(__dirname, 'diff');

// Anti-aliasing of the same glyph can legitimately differ by a hair between
// runs of the same browser build. This tolerance forgives that and nothing
// bigger: a moved element, a dropped shadow or a missing icon shifts whole
// blocks of pixels far past it.
const CHANNEL_TOLERANCE = 8;
const MAX_DIFFERING_RATIO = 0.0002; // 0.02% of pixels

const updating = process.argv.includes('--update');

const decodePng = (dataUrl) => PNG.sync.read(Buffer.from(dataUrl.split(',')[1], 'base64'));

/**
 * Compare two decoded PNGs.
 *
 * Differing dimensions are a hard failure rather than a large diff: nothing
 * about a legitimate rendering change should resize the canvas, and comparing
 * pixel n of two different-sized images compares unrelated pixels.
 */
function comparePngs(baseline, current) {
    if (baseline.width !== current.width || baseline.height !== current.height) {
        return {
            ok: false,
            reason: `size changed: ${baseline.width}x${baseline.height} -> ${current.width}x${current.height}`
        };
    }

    const diff = new PNG({ width: baseline.width, height: baseline.height });
    let differing = 0;
    let worst = 0;

    for (let i = 0; i < baseline.data.length; i += 4) {
        const delta = Math.max(
            Math.abs(baseline.data[i] - current.data[i]),
            Math.abs(baseline.data[i + 1] - current.data[i + 1]),
            Math.abs(baseline.data[i + 2] - current.data[i + 2]),
            Math.abs(baseline.data[i + 3] - current.data[i + 3])
        );

        worst = Math.max(worst, delta);

        if (delta > CHANNEL_TOLERANCE) {
            differing++;
            // Differences in red over a dimmed copy of the original, so a
            // failure is legible at a glance instead of a wall of noise.
            diff.data[i] = 255;
            diff.data[i + 1] = 0;
            diff.data[i + 2] = 0;
            diff.data[i + 3] = 255;
        } else {
            diff.data[i] = baseline.data[i];
            diff.data[i + 1] = baseline.data[i + 1];
            diff.data[i + 2] = baseline.data[i + 2];
            diff.data[i + 3] = Math.round(baseline.data[i + 3] * 0.25);
        }
    }

    const total = baseline.width * baseline.height;
    const ratio = differing / total;

    return {
        ok: ratio <= MAX_DIFFERING_RATIO,
        differing,
        total,
        ratio,
        worst,
        diff,
        reason: `${differing}/${total} pixels differ (${(ratio * 100).toFixed(
            4
        )}%), worst channel delta ${worst}`
    };
}

(async () => {
    for (const dir of [BASELINE_DIR, OUTPUT_DIR, DIFF_DIR]) {
        fs.mkdirSync(dir, { recursive: true });
    }

    const server = await createServer({
        configFile: path.join(__dirname, '../../vite.config.mjs'),
        server: { port: 5199, strictPort: true },
        logLevel: 'error'
    });

    await server.listen();

    const browser = await chromium.launch({
        executablePath: process.env.CHROMIUM_PATH || undefined
    });
    // Pinned so a different device pixel ratio cannot silently rescale
    // everything and read as a diff.
    const page = await browser.newPage({
        viewport: { width: 1280, height: 900 },
        deviceScaleFactor: 1
    });

    const failures = [];

    try {
        await page.goto('http://localhost:5199/test/imagediff/harness.html', {
            waitUntil: 'networkidle'
        });

        const fontsReady = await page.evaluate(() => window.__fontsReady);

        if (!fontsReady) {
            // Not fatal on its own, but it is the single most likely cause of a
            // diff nobody can explain, so it is said out loud rather than left
            // for someone to discover.
            console.warn('WARNING: PoppinsMedium did not report as loaded; text metrics may drift');
        }

        const names = await page.evaluate(() => window.__subjectNames);

        console.log(`${updating ? 'Capturing' : 'Comparing'} ${names.length} images\n`);

        for (const name of names) {
            const dataUrl = await page.evaluate((subject) => window.__renderSubject(subject), name);
            const current = decodePng(dataUrl);
            const buffer = PNG.sync.write(current);

            fs.writeFileSync(path.join(OUTPUT_DIR, `${name}.png`), buffer);

            const baselinePath = path.join(BASELINE_DIR, `${name}.png`);

            if (updating) {
                fs.writeFileSync(baselinePath, buffer);
                console.log(`  saved    ${name}  ${current.width}x${current.height}`);
                continue;
            }

            if (!fs.existsSync(baselinePath)) {
                failures.push(`${name}: no baseline (run with --update)`);
                console.log(`  MISSING  ${name}`);
                continue;
            }

            const result = comparePngs(PNG.sync.read(fs.readFileSync(baselinePath)), current);

            if (result.ok) {
                console.log(`  ok       ${name}  ${result.reason ?? ''}`);
            } else {
                failures.push(`${name}: ${result.reason}`);
                console.log(`  DIFF     ${name}  ${result.reason}`);

                if (result.diff) {
                    fs.writeFileSync(
                        path.join(DIFF_DIR, `${name}.png`),
                        PNG.sync.write(result.diff)
                    );
                }
            }
        }
    } finally {
        await browser.close();
        await server.close();
    }

    if (updating) {
        console.log('\nBaselines written.');

        return;
    }

    if (failures.length > 0) {
        console.error(`\n${failures.length} image(s) drifted:`);
        for (const failure of failures) {
            console.error(`  - ${failure}`);
        }
        console.error(`\nDiffs written to ${path.relative(process.cwd(), DIFF_DIR)}/`);
        process.exit(1);
    }

    console.log('\nEvery image matches its baseline.');
})().catch((err) => {
    console.error(err);
    process.exit(1);
});
