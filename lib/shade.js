// shade.js — the hillshade itself, as RGB. No Node, no PNG: this is the part
// a browser can run, and preview.js is the thin wrapper that turns it into a
// file. Kept apart so the app and the CLI shade the module identically.

/** Light from the north-west, the cartographic convention. */
export const LIGHT = { x: -0.6, y: -0.6, z: 0.53 };

/**
 * The ground's colour by height, `t` in 0..1 over the module's own span:
 * low green, mid olive, high ROCK. Not snow. The summits used to go to
 * white, and white on a surface the ice had smoothed read as the ice still
 * being there. The ice is gone by the time anything is printed -- see
 * glacier.js -- so the top of the map is bare rock, grey-brown and dry.
 * Returns [r, g, b] in 0..255.
 */
export function heightColour(t) {
  if (t < 0.3) return [86 + t * 90, 132 + t * 110, 62 + t * 40];
  if (t < 0.62) return [126 + t * 80, 138 + t * 40, 86 + t * 20];
  const u = (t - 0.62) / 0.38;
  return [150 + u * 38, 146 + u * 30, 134 + u * 24];
}

export const WATER_RGB = [38, 104, 196];

/**
 * Hillshade one built module. Returns { rgb, width, height }: rgb is a
 * Uint8Array of width*height*3, top row first, which is both what a PNG
 * wants and what putImageData wants.
 */
export function shadeTile(tile, { px = 512 } = {}) {
  const local = tile.local;
  const n = local.nx;
  const W = px;
  const H = px;
  const z = new Float64Array(W * H);
  const wet = new Uint8Array(W * H);
  // Bilinear, not nearest: a draft mesh drawn at more pixels than it has
  // cells shades every cell as a flat step with a line round it otherwise.
  const v = local.values;
  for (let py = 0; py < H; py++) {
    const fy = (py / (H - 1)) * (n - 1);
    const j = Math.min(n - 2, Math.floor(fy));
    const ty = fy - j;
    for (let pxx = 0; pxx < W; pxx++) {
      const fx = (pxx / (W - 1)) * (n - 1);
      const i = Math.min(n - 2, Math.floor(fx));
      const tx = fx - i;
      const Y = H - 1 - py; // row 0 of the field is the south, image rows run down
      z[Y * W + pxx] = (v[j * n + i] * (1 - tx) + v[j * n + i + 1] * tx) * (1 - ty)
        + (v[(j + 1) * n + i] * (1 - tx) + v[(j + 1) * n + i + 1] * tx) * ty;
      if (tile.wet && tile.wet[Math.round(fy) * n + Math.round(fx)]) wet[Y * W + pxx] = 1;
    }
  }
  let lo = Infinity;
  let hi = -Infinity;
  for (const v of z) { if (v < lo) lo = v; if (v > hi) hi = v; }
  const span = Math.max(1e-6, hi - lo);
  const rgb = new Uint8Array(W * H * 3);
  const at = (x, y) => z[Math.min(H - 1, Math.max(0, y)) * W + Math.min(W - 1, Math.max(0, x))];
  const mmPerPx = ((n - 1) * local.step) / (W - 1);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const k = y * W + x;
      const dzdx = (at(x + 1, y) - at(x - 1, y)) / (2 * mmPerPx);
      const dzdy = (at(x, y - 1) - at(x, y + 1)) / (2 * mmPerPx); // image y runs south
      const len = Math.hypot(-dzdx, -dzdy, 1);
      const shade = Math.max(0.12, (-dzdx * LIGHT.x + -dzdy * LIGHT.y + LIGHT.z) / len);
      const [r, g, b] = wet[k] ? WATER_RGB : heightColour((z[k] - lo) / span);
      rgb[k * 3] = Math.min(255, r * shade * 1.5);
      rgb[k * 3 + 1] = Math.min(255, g * shade * 1.5);
      rgb[k * 3 + 2] = Math.min(255, b * shade * 1.5);
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
