// Generates the PassVault desktop icons with node:zlib only (no image tools):
//   assets/icon-1024.png          source for the .icns (sips + iconutil in build.sh)
//   resources/icons/appIcon.png   window icon (512 px)
//   resources/icons/trayIcon.png  menu-bar template icon (36 px @ 144 dpi = 18 pt)
// Design matches the Logo component: teal rounded square, white ring, keyhole.
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TEAL_TOP = [0x14, 0x95, 0x88];
const TEAL_BOTTOM = [0x0b, 0x6b, 0x61];
const WHITE = [0xff, 0xff, 0xff];
const BLACK = [0, 0, 0];

// App icon in a 32x32 design space with macOS-style margins (rounded square 3..29).
function appSample(x, y) {
  const lo = 3.2, hi = 28.8, r = 5.8;
  const rx = Math.max(lo + r - x, 0, x - (hi - r));
  const ry = Math.max(lo + r - y, 0, y - (hi - r));
  if (x < lo || x > hi || y < lo || y > hi || rx * rx + ry * ry > r * r) return null;
  const d = Math.hypot(x - 16, y - 16);
  if (Math.abs(d - 7.6) <= 1.15) return WHITE;
  if (Math.hypot(x - 16, y - 14.4) <= 2.2) return WHITE;
  if (x >= 15 && x <= 17 && y >= 15 && y <= 20) return WHITE;
  const t = (y - lo) / (hi - lo);
  return TEAL_TOP.map((c, i) => Math.round(c + (TEAL_BOTTOM[i] - c) * t));
}

// Tray template icon: black ring + keyhole on transparent (macOS tints it).
function traySample(x, y) {
  const d = Math.hypot(x - 16, y - 16);
  if (Math.abs(d - 11) <= 2.3) return BLACK;
  if (Math.hypot(x - 16, y - 13.6) <= 3.4) return BLACK;
  if (x >= 14.4 && x <= 17.6 && y >= 14 && y <= 22.5) return BLACK;
  return null;
}

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

function png(size, sample, dpi = 72, ss = 4) {
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let py = 0; py < size; py++) {
    raw[py * (size * 4 + 1)] = 0;
    for (let px = 0; px < size; px++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < ss; sy++)
        for (let sx = 0; sx < ss; sx++) {
          const c = sample(((px + (sx + 0.5) / ss) / size) * 32, ((py + (sy + 0.5) / ss) / size) * 32);
          if (c) { r += c[0]; g += c[1]; b += c[2]; a++; }
        }
      const o = py * (size * 4 + 1) + 1 + px * 4;
      raw[o] = a ? Math.round(r / a) : 0;
      raw[o + 1] = a ? Math.round(g / a) : 0;
      raw[o + 2] = a ? Math.round(b / a) : 0;
      raw[o + 3] = Math.round((a / (ss * ss)) * 255);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6;
  const phys = Buffer.alloc(9);
  const ppm = Math.round(dpi / 0.0254);
  phys.writeUInt32BE(ppm, 0);
  phys.writeUInt32BE(ppm, 4);
  phys[8] = 1;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('pHYs', phys),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const out = (p, buf) => {
  const f = resolve(root, p);
  mkdirSync(dirname(f), { recursive: true });
  writeFileSync(f, buf);
  console.log(p);
};
out('assets/icon-1024.png', png(1024, appSample, 72, 3));
out('resources/icons/appIcon.png', png(512, appSample));
out('resources/icons/trayIcon.png', png(36, traySample, 144, 6));
