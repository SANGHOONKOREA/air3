'use strict';
/*
 * Generates the PWA icons (no external deps — raw PNG via zlib).
 * Run: node tools/gen-icons.js
 * Produces public/icon-{192,512,maskable,apple}.png
 *
 * Design: dark rounded tile, subtle radial glow, a white camera lens ring
 * with a red "LIVE" dot — reads as a broadcast/recording glyph.
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

function makePNG(size, opts) {
  const { maskable } = opts || {};
  const W = size, H = size;
  const buf = Buffer.alloc(W * H * 4);

  const bg = [11, 15, 20];        // #0b0f14
  const glow = [37, 99, 235];     // #2563eb
  const ring = [230, 237, 243];   // near white
  const live = [239, 68, 68];     // red

  const cx = W / 2, cy = H / 2;
  const radiusOuter = W * 0.30;   // lens outer
  const ringW = W * 0.055;
  const dotR = W * 0.085;
  // Rounded-corner radius (skip rounding for maskable — needs full bleed).
  const corner = maskable ? 0 : W * 0.22;

  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      // radial glow from center
      const dc = Math.hypot(x - cx, y - cy);
      const g = Math.max(0, 1 - dc / (W * 0.75));
      let r = bg[0] + (glow[0] - bg[0]) * g * 0.35;
      let gg = bg[1] + (glow[1] - bg[1]) * g * 0.35;
      let b = bg[2] + (glow[2] - bg[2]) * g * 0.35;
      let a = 255;

      // rounded corners (transparent outside)
      if (corner > 0) {
        const rx = Math.min(x, W - 1 - x);
        const ry = Math.min(y, H - 1 - y);
        if (rx < corner && ry < corner) {
          const dcx = corner - rx, dcy = corner - ry;
          if (Math.hypot(dcx, dcy) > corner) a = 0;
        }
      }

      // lens ring
      const dr = Math.abs(dc - radiusOuter);
      if (dr < ringW) {
        const t = 1 - dr / ringW;
        r = r + (ring[0] - r) * t;
        gg = gg + (ring[1] - gg) * t;
        b = b + (ring[2] - b) * t;
      }

      // live dot at upper-right of lens
      const ddx = x - (cx + radiusOuter * 0.62);
      const ddy = y - (cy - radiusOuter * 0.62);
      const dd = Math.hypot(ddx, ddy);
      if (dd < dotR) {
        const t = Math.min(1, (dotR - dd) / (dotR * 0.4));
        r = r + (live[0] - r) * t;
        gg = gg + (live[1] - gg) * t;
        b = b + (live[2] - b) * t;
      }

      buf[i] = Math.round(r);
      buf[i + 1] = Math.round(gg);
      buf[i + 2] = Math.round(b);
      buf[i + 3] = a;
    }
  }
  return encodePNG(W, H, buf);
}

function encodePNG(W, H, rgba) {
  // Filtered raw: one filter byte (0) per row.
  const raw = Buffer.alloc((W * 4 + 1) * H);
  for (let y = 0; y < H; y++) {
    raw[y * (W * 4 + 1)] = 0;
    rgba.copy(raw, y * (W * 4 + 1) + 1, y * W * 4, (y + 1) * W * 4);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });

  const chunks = [];
  chunks.push(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0);
  ihdr.writeUInt32BE(H, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // color type RGBA
  ihdr[10] = 0;  // compression
  ihdr[11] = 0;  // filter
  ihdr[12] = 0;  // interlace
  chunks.push(chunk('IHDR', ihdr));
  chunks.push(chunk('IDAT', idat));
  chunks.push(chunk('IEND', Buffer.alloc(0)));
  return Buffer.concat(chunks);
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = crc32(Buffer.concat([typeBuf, data]));
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc >>> 0, 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const outDir = path.join(__dirname, '..', 'public');
const targets = [
  { file: 'icon-192.png', size: 192, maskable: false },
  { file: 'icon-512.png', size: 512, maskable: false },
  { file: 'icon-maskable.png', size: 512, maskable: true },
  { file: 'icon-apple.png', size: 180, maskable: true },
];
for (const t of targets) {
  const png = makePNG(t.size, { maskable: t.maskable });
  fs.writeFileSync(path.join(outDir, t.file), png);
  console.log('wrote', t.file, png.length, 'bytes');
}
