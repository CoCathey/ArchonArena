/**
 * Generates the Archon Arena brand mark and all favicon assets in public/.
 *
 * The mark: an amber keyhole inside a hexagonal arena, on deep slate.
 * Rerun after tweaking colors/geometry:  node scripts/generate-brand-assets.js
 */
const fs = require('fs');
const path = require('path');
const { createCanvas } = require('canvas');

const SLATE = '#151a2b';
const AMBER = '#f5b83d';

const OUT = path.join(__dirname, '..', 'public');

function hexagonPath(ctx, cx, cy, radius) {
    // Pointy-top hexagon
    ctx.beginPath();
    for (let i = 0; i < 6; i++) {
        const angle = Math.PI / 6 + (i * Math.PI) / 3;
        const x = cx + radius * Math.cos(angle);
        const y = cy + radius * Math.sin(angle);
        if (i === 0) {
            ctx.moveTo(x, y);
        } else {
            ctx.lineTo(x, y);
        }
    }
    ctx.closePath();
}

function keyholePath(ctx, s) {
    // Circle bow + flared wedge below it
    const cx = s / 2;
    const r = s * 0.145;
    const circleCy = s * 0.42;
    const wedgeTopHalf = s * 0.055;
    const wedgeBottomHalf = s * 0.115;
    const wedgeBottomY = s * 0.71;

    ctx.beginPath();
    ctx.arc(cx, circleCy, r, 0, Math.PI * 2);
    ctx.moveTo(cx - wedgeTopHalf, circleCy + r * 0.55);
    ctx.lineTo(cx + wedgeTopHalf, circleCy + r * 0.55);
    ctx.lineTo(cx + wedgeBottomHalf, wedgeBottomY);
    ctx.lineTo(cx - wedgeBottomHalf, wedgeBottomY);
    ctx.closePath();
}

/**
 * @param {number} s canvas size
 * @param {object} opts { fullBleed: fill the square background (touch icons),
 *                        mono: single-color silhouette (pinned tab) }
 */
function drawMark(s, opts = {}) {
    const canvas = createCanvas(s, s);
    const ctx = canvas.getContext('2d');

    if (opts.fullBleed) {
        ctx.fillStyle = SLATE;
        ctx.fillRect(0, 0, s, s);
    }

    const hexRadius = s * (opts.fullBleed ? 0.38 : 0.46);
    const strokeW = Math.max(1, s * 0.055);

    if (opts.mono) {
        ctx.fillStyle = '#000';
        ctx.strokeStyle = '#000';
    } else {
        ctx.fillStyle = SLATE;
        ctx.strokeStyle = AMBER;
    }

    hexagonPath(ctx, s / 2, s / 2, hexRadius);
    if (!opts.mono) {
        ctx.fill();
    }
    ctx.lineWidth = strokeW;
    ctx.lineJoin = 'round';
    ctx.stroke();

    ctx.fillStyle = opts.mono ? '#000' : AMBER;
    // Scale keyhole to the hexagon, not the canvas, so fullBleed keeps proportions
    const scale = hexRadius / (0.46 * s);
    ctx.save();
    ctx.translate(s / 2, s / 2);
    ctx.scale(scale, scale);
    ctx.translate(-s / 2, -s / 2);
    keyholePath(ctx, s);
    ctx.fill();
    ctx.restore();

    return canvas;
}

function writePng(name, size, opts) {
    const buffer = drawMark(size, opts).toBuffer('image/png');
    fs.writeFileSync(path.join(OUT, name), buffer);
    console.log(`wrote public/${name} (${buffer.length} bytes)`);
    return buffer;
}

/** Minimal ICO container wrapping PNG images (valid for all modern browsers). */
function writeIco(name, pngs) {
    const count = pngs.length;
    const header = Buffer.alloc(6);
    header.writeUInt16LE(0, 0); // reserved
    header.writeUInt16LE(1, 2); // type: icon
    header.writeUInt16LE(count, 4);

    const entries = [];
    let offset = 6 + 16 * count;
    for (const { size, buffer } of pngs) {
        const entry = Buffer.alloc(16);
        entry.writeUInt8(size >= 256 ? 0 : size, 0); // width
        entry.writeUInt8(size >= 256 ? 0 : size, 1); // height
        entry.writeUInt8(0, 2); // palette
        entry.writeUInt8(0, 3); // reserved
        entry.writeUInt16LE(1, 4); // color planes
        entry.writeUInt16LE(32, 6); // bits per pixel
        entry.writeUInt32LE(buffer.length, 8);
        entry.writeUInt32LE(offset, 12);
        offset += buffer.length;
        entries.push(entry);
    }

    const ico = Buffer.concat([header, ...entries, ...pngs.map((p) => p.buffer)]);
    fs.writeFileSync(path.join(OUT, name), ico);
    console.log(`wrote public/${name} (${ico.length} bytes)`);
}

function writePinnedTabSvg(name) {
    // Safari pinned tabs require a single-color SVG; Safari recolors it.
    const s = 100;
    const hexPoints = [];
    for (let i = 0; i < 6; i++) {
        const angle = Math.PI / 6 + (i * Math.PI) / 3;
        hexPoints.push(
            `${(s / 2 + s * 0.44 * Math.cos(angle)).toFixed(2)},${(
                s / 2 +
                s * 0.44 * Math.sin(angle)
            ).toFixed(2)}`
        );
    }

    const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg width="100" height="100" viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg">
  <polygon points="${hexPoints.join(
      ' '
  )}" fill="none" stroke="#000" stroke-width="6" stroke-linejoin="round"/>
  <circle cx="50" cy="42" r="14.5" fill="#000"/>
  <polygon points="44.5,49 55.5,49 61.5,71 38.5,71" fill="#000"/>
</svg>
`;
    fs.writeFileSync(path.join(OUT, name), svg);
    console.log(`wrote public/${name}`);
}

const png16 = writePng('favicon-16x16.png', 16);
const png32 = writePng('favicon-32x32.png', 32);
writePng('android-chrome-96x96.png', 96);
writePng('apple-touch-icon.png', 180, { fullBleed: true });
writePng('mstile-150x150.png', 150);
writeIco('favicon.ico', [
    { size: 16, buffer: png16 },
    { size: 32, buffer: png32 }
]);
writePinnedTabSvg('safari-pinned-tab.svg');

console.log('done');
