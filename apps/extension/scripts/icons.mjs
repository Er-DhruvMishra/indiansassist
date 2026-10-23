// Generates the action / extension icons (plain RGBA PNGs, no third-party assets): a rounded square with an
// "eye" ring; `live-*` icons add a green dot. Run with `pnpm --filter @indiansassist/extension icons`.
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { deflateSync } from 'node:zlib';
import { ROOT } from './env.mjs';

const CRC = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
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
function png(size, pixel) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = pixel((x + 0.5) / size, (y + 0.5) / size);
      const o = y * (size * 4 + 1) + 1 + x * 4;
      raw[o] = r;
      raw[o + 1] = g;
      raw[o + 2] = b;
      raw[o + 3] = a;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
function icon(live) {
  return (u, v) => {
    const r = 0.22;
    const dx = Math.max(Math.abs(u - 0.5) - (0.5 - r), 0);
    const dy = Math.max(Math.abs(v - 0.5) - (0.5 - r), 0);
    if (dx * dx + dy * dy > r * r) return [0, 0, 0, 0];
    if (live && (u - 0.78) ** 2 + (v - 0.78) ** 2 < 0.03) return [22, 163, 74, 255];
    const d = Math.hypot(u - 0.5, v - 0.5);
    if (d > 0.18 && d < 0.3) return [255, 255, 255, 255];
    if (d <= 0.1) return [255, 255, 255, 255];
    return [15, 76, 129, 255];
  };
}
const dir = resolve(ROOT, 'icons');
mkdirSync(dir, { recursive: true });
for (const s of [16, 32, 48, 128]) writeFileSync(resolve(dir, `${s}.png`), png(s, icon(false)));
for (const s of [16, 32]) writeFileSync(resolve(dir, `live-${s}.png`), png(s, icon(true)));
console.log('icons written to', dir);
