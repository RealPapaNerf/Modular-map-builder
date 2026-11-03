// preview.js — a hillshaded PNG of the assembled map, so the thing can be
// looked at before four hours of printing. No dependencies: zlib is in Node
// and a PNG is four chunks.

import { deflateSync } from 'node:zlib';

function crc32(buf) {
  let c;
  const table = crc32.table || (crc32.table = (() => {
    const t = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c;
    }
    return t;
  })());
  let crc = -1;
  for (let i = 0; i < buf.length; i++) crc = (crc >>> 8) ^ table[(crc ^ buf[i]) & 0xff];
  return (crc ^ -1) >>> 0;
}

function chunk(type, data) {
  const out = Buffer.alloc(data.length + 12);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

/** rgb is a Uint8Array of w*h*3. */
export function encodePNG(rgb, w, h) {
  const raw = Buffer.alloc(h * (w * 3 + 1));
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0; // filter: none
    for (let x = 0; x < w * 3; x++) raw[y * (w * 3 + 1) + 1 + x] = rgb[y * w * 3 + x];
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 6 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/**
 * Lay the tiles out as they assemble and hillshade them.
 *
 * Heights are WORLD heights -- the tile's own surface plus its plate stack --
 * so the staircase shows. That is the point of looking: a map whose plate
 * levels are wrong looks wrong here, in a second, rather than after nine
 * prints.
 */
export function renderMap(result, { pxPerTile = 170, seaBand = true } = {}) {
  const c = result.contract;
  let maxCol = 0;
  let maxRow = 0;
  for (const t of result.tiles) {
    maxCol = Math.max(maxCol, t.spec.col);
    maxRow = Math.max(maxRow, t.spec.row);
  }
  const cols = maxCol + 1;
  const rows = maxRow + 1;
  const W = cols * pxPerTile;
  const H = rows * pxPerTile;
  const z = new Float64Array(W * H).fill(NaN);
  const wet = new Uint8Array(W * H);

  for (const t of result.tiles) {
    const n = t.local.nx;
    const base = t.level * c.plateMM;
    for (let py = 0; py < pxPerTile; py++) {
      for (let px = 0; px < pxPerTile; px++) {
        const u = (px / (pxPerTile - 1)) * (n - 1);
        const v = (py / (pxPerTile - 1)) * (n - 1);
        const i = Math.min(n - 1, Math.round(u));
        const j = Math.min(n - 1, Math.round(v));
        const local = t.local.values[j * n + i];
        // row 0 is the bottom of the map, so flip for image coordinates
        const X = t.spec.col * pxPerTile + px;
        const Y = (rows - 1 - t.spec.row) * pxPerTile + (pxPerTile - 1 - py);
        z[Y * W + X] = base + local;
        if (local < c.edgeLandMM - 0.6) wet[Y * W + X] = 1;
      }
    }
  }

  let lo = Infinity;
  let hi = -Infinity;
  for (const v of z) { if (!Number.isNaN(v)) { if (v < lo) lo = v; if (v > hi) hi = v; } }
  const span = Math.max(1e-6, hi - lo);

  const rgb = new Uint8Array(W * H * 3);
  const at = (x, y) => {
    const v = z[Math.min(H - 1, Math.max(0, y)) * W + Math.min(W - 1, Math.max(0, x))];
    return Number.isNaN(v) ? lo : v;
  };
  // Light from the north-west, the cartographic convention.
  const LX = -0.6, LY = -0.6, LZ = 0.53;
  const mmPerPx = c.tileMM / pxPerTile;

  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const k = y * W + x;
      if (Number.isNaN(z[k])) { rgb[k * 3] = 24; rgb[k * 3 + 1] = 26; rgb[k * 3 + 2] = 30; continue; }
      const dzdx = (at(x + 1, y) - at(x - 1, y)) / (2 * mmPerPx);
      const dzdy = (at(x, y + 1) - at(x, y - 1)) / (2 * mmPerPx);
      const len = Math.hypot(-dzdx, -dzdy, 1);
      const shade = Math.max(0.12, (-dzdx * LX + -dzdy * LY + LZ) / len);
      const h = (z[k] - lo) / span;
      let r, g, b;
      if (wet[k]) { r = 38; g = 104; b = 196; }
      else if (h < 0.3) { r = 86 + h * 90; g = 132 + h * 110; b = 62 + h * 40; }
      else if (h < 0.62) { r = 126 + h * 80; g = 138 + h * 40; b = 86 + h * 20; }
      else { const t = (h - 0.62) / 0.38; r = 150 + t * 95; g = 146 + t * 100; b = 134 + t * 110; }
      rgb[k * 3] = Math.min(255, r * shade * 1.5);
      rgb[k * 3 + 1] = Math.min(255, g * shade * 1.5);
      rgb[k * 3 + 2] = Math.min(255, b * shade * 1.5);
    }
  }

  // Seam lines, so the modularity is visible rather than inferred.
  if (seaBand) {
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        if ((x % pxPerTile === 0 || y % pxPerTile === 0) && (x > 0 || y > 0)) {
          const k = (y * W + x) * 3;
          rgb[k] = (rgb[k] + 255) >> 1;
          rgb[k + 1] = (rgb[k + 1] + 255) >> 1;
          rgb[k + 2] = (rgb[k + 2] + 255) >> 1;
        }
      }
    }
  }
  return { png: encodePNG(rgb, W, H), width: W, height: H };
}
