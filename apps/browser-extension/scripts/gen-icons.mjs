// Generates the PassVault toolbar icons (teal rounded square, white ring, keyhole)
// as PNGs using only node:zlib. Run: pnpm icons
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const out = resolve(dirname(fileURLToPath(import.meta.url)), '../public/icons');
const TEAL = [0x0f, 0x7f, 0x74];
const WHITE = [0xff, 0xff, 0xff];

// Shape in a 32x32 design space (matches the Logo component).
function sample(x, y) {
  // rounded square x,y in [2,30], radius 8
  const rx = Math.max(10 - x, 0, x - 22);
  const ry = Math.max(10 - y, 0, y - 22);
  if (x < 2 || x > 30 || y < 2 || y > 30 || rx * rx + ry * ry > 64) return null;
  const d = Math.hypot(x - 16, y - 16);
  if (Math.abs(d - 8.5) <= 1.2) return WHITE; // ring
  if (Math.hypot(x - 16, y - 14.2) <= 2.4) return WHITE; // keyhole head
  if (x >= 14.9 && x <= 17.1 && y >= 15 && y <= 20.4) return WHITE; // keyhole slot
  return TEAL;
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

function png(size) {
  const ss = 4; // 4x4 supersampling for anti-aliasing
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let py = 0; py < size; py++) {
    raw[py * (size * 4 + 1)] = 0; // filter: none
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
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0; // 8-bit RGBA
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

mkdirSync(out, { recursive: true });
for (const s of [16, 32, 48, 128]) {
  writeFileSync(resolve(out, `icon-${s}.png`), png(s));
  console.log(`icons/icon-${s}.png`);
}
