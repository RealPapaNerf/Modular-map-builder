// shade.js — the hillshade itself, as RGB. No Node, no PNG: this is the part
// a browser can run, and preview.js is the thin wrapper that turns it into a
// file. Kept apart so the app and the CLI shade the map identically rather
// than drifting into two pictures of the same ground.

/** Light from the north-west, the cartographic convention. */
export const LIGHT = { x: -0.6, y: -0.6, z: 0.53 };

/**
 * Lay the tiles out as they assemble and hillshade them.
 *
 * Heights are WORLD heights -- the tile's own surface plus its plate stack --
 * so the staircase shows. That is the point of looking: a map whose plate
 * levels are wrong looks wrong here, in a second, rather than after nine
 * prints.
 *
 * Returns { rgb, width, height }: rgb is a Uint8Array of width*height*3, top
 * row first, which is both what a PNG wants and what putImageData wants.
 */
export function shadeMap(result, { pxPerTile = 170, seams = true } = {}) {
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
        if (t.wet && t.wet[j * n + i]) wet[Y * W + X] = 1;
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
  const mmPerPx = c.tileMM / pxPerTile;

  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const k = y * W + x;
      if (Number.isNaN(z[k])) { rgb[k * 3] = 24; rgb[k * 3 + 1] = 26; rgb[k * 3 + 2] = 30; continue; }
      const dzdx = (at(x + 1, y) - at(x - 1, y)) / (2 * mmPerPx);
      const dzdy = (at(x, y + 1) - at(x, y - 1)) / (2 * mmPerPx);
      const len = Math.hypot(-dzdx, -dzdy, 1);
      const shade = Math.max(0.12, (-dzdx * LIGHT.x + -dzdy * LIGHT.y + LIGHT.z) / len);
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
  if (seams) {
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
  return { rgb, width: W, height: H };
}

/** RGB to RGBA, for canvas putImageData. */
export function toRGBA(rgb, w, h) {
  const out = new Uint8ClampedArray(w * h * 4);
  for (let i = 0, n = w * h; i < n; i++) {
    out[i * 4] = rgb[i * 3];
    out[i * 4 + 1] = rgb[i * 3 + 1];
    out[i * 4 + 2] = rgb[i * 3 + 2];
    out[i * 4 + 3] = 255;
  }
  return out;
}
