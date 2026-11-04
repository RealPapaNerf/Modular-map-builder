// heights.js — the grown map as plain arrays, for the 3D view.
//
// Pure: no DOM and no three.js, so the worker can make these, the viewer can
// draw them, and node can test them. Two halves:
//
//   tileHeights   a built tile (one entry of buildMap's `tiles`) as arrays the
//                 worker can TRANSFER: the ground, the standing water, and
//                 what each cell is. Everything in tile-local mm, the frame
//                 the tile was cut in: x east, y north, z up from its bottom.
//
//   waterSurface  where the water stands on that tile once the board has had
//   ground...     its say -- whether the river runs, how high a pond comes --
//                 and the vertex, normal, colour and index arrays a
//                 BufferGeometry is made from.
//
// Running water is the board's to decide, standing water is the tile's. A
// lake, a tarn, a bay or a spring pool is a surface the print holds whatever
// is next to it, so it is always drawn. A river channel only has water in it
// if the board says water reaches the tile; a dry bed is a bed.

/** What a cell is. A river cell is the channel floor; a still one is under a lake or pool. */
export const GROUND = 0;
export const RIVER = 1;
export const STILL = 2;
export const WOOD = 3;

/** How deep running water is drawn over its bed: half the bank's freeboard, so it sits in its channel. */
export const RIVER_DEPTH_MM = 3;

/** The higher of two water levels, where NaN is no water: either side may be dry. */
const max = (a, b) => (Number.isNaN(a) ? b : Number.isNaN(b) ? a : a > b ? a : b);

/**
 * One built tile as transferable arrays.
 *
 * `water` is the surface of the standing water over each cell, NaN where
 * there is none; `kind` is GROUND / RIVER / STILL / WOOD per cell. The
 * heights are Float32, which is the precision the GPU draws in: a tenth of
 * a micron at 200 mm.
 */
export function tileHeights(t) {
  const { nx, ny, step } = t.local;
  const N = nx * ny;
  const heights = Float32Array.from(t.local.values);
  const water = new Float32Array(N).fill(NaN);
  const kind = new Uint8Array(N);

  if (t.wet) for (let k = 0; k < N; k++) if (t.wet[k]) kind[k] = RIVER;

  // Every lake carries its own cells and its own flat surface.
  for (const l of t.lakes || []) {
    if (!l.wet || !Number.isFinite(l.surfaceZ)) continue;
    for (let k = 0; k < N; k++) {
      if (!l.wet[k]) continue;
      kind[k] = STILL;
      water[k] = max(water[k], l.surfaceZ);
    }
  }

  // A spring pool fills to the notch in its lip and no higher. The build
  // marks it wet as a disc of whole cells round the nearest one, a little
  // wider than the pool, so every cell of THAT disc is decided here: under
  // the spill it is the pool, over it the lip -- and never running water,
  // which would stand a ring of river above the pool's own surface.
  for (const sp of t.springs || []) {
    if (!sp.atMM || !Number.isFinite(sp.spillMM) || !(sp.poolRadiusMM > 0)) continue;
    const ri = Math.round(sp.atMM[0] / step);
    const rj = Math.round(sp.atMM[1] / step);
    const rad = Math.ceil(sp.poolRadiusMM / step);
    for (let j = rj - rad; j <= rj + rad; j++) {
      for (let i = ri - rad; i <= ri + rad; i++) {
        if (i < 0 || j < 0 || i >= nx || j >= ny || Math.hypot(i - ri, j - rj) > rad) continue;
        const k = j * nx + i;
        if (heights[k] < sp.spillMM) {
          kind[k] = STILL;
          water[k] = max(water[k], sp.spillMM);
        } else if (kind[k] === RIVER) {
          kind[k] = GROUND;
        }
      }
    }
  }

  for (const w of t.woods || []) {
    if (!w.mask) continue;
    for (let k = 0; k < N; k++) if (w.mask[k] && kind[k] === GROUND) kind[k] = WOOD;
  }

  return {
    id: `${t.spec.col},${t.spec.row}`,
    label: t.label,
    col: t.spec.col,
    row: t.spec.row,
    level: t.level,
    standMM: t.stack.standMM,
    nx, ny, step,
    heights, water, kind,
  };
}

/** The buffers in a tileHeights result, for postMessage's transfer list. */
export const transferables = (h) => [h.heights.buffer, h.water.buffer, h.kind.buffer];

/**
 * Where the water stands on a tile, per vertex, NaN where it is dry.
 *
 *   running   the board says water reaches this tile, so the channel runs
 *   pondMM    the board says the tile ponds to this height (tile-local mm):
 *             everything under it is under water
 *
 * Then grown by one vertex all round, so the surface reaches the bank it
 * laps against instead of stopping a cell short of it. Whatever of that ring
 * is below the ground is hidden by the ground, which is the point: the
 * shoreline is where the water meets the land, and the land draws it.
 */
export function waterSurface(h, { running = false, pondMM = null, depthMM = RIVER_DEPTH_MM } = {}) {
  const { nx, ny, heights, water, kind } = h;
  const N = nx * ny;
  const s = new Float32Array(N);
  const pond = Number.isFinite(pondMM) ? pondMM : null;
  let any = false;
  for (let k = 0; k < N; k++) {
    let v = water[k];
    if (running && kind[k] === RIVER) v = max(v, heights[k] + depthMM);
    if (pond !== null && heights[k] < pond) v = max(v, pond);
    s[k] = v;
    if (!Number.isNaN(v)) any = true;
  }
  if (!any) return s;
  const out = Float32Array.from(s);
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const k = j * nx + i;
      if (!Number.isNaN(s[k])) continue;
      let v = NaN;
      for (let dj = -1; dj <= 1; dj++) {
        const jj = j + dj;
        if (jj < 0 || jj >= ny) continue;
        for (let di = -1; di <= 1; di++) {
          const ii = i + di;
          if ((di || dj) && ii >= 0 && ii < nx) v = max(v, s[jj * nx + ii]);
        }
      }
      out[k] = v;
    }
  }
  return out;
}

/* --------------------------------------------------------------- geometry */

/** A triangle index array big enough for `vertices`. */
const indexArray = (vertices, length) => (vertices > 65535 ? new Uint32Array(length) : new Uint16Array(length));

/** Every `stride`-th sample along a side of `n`, always ending on the last one, so a coarse grid still reaches the rim. */
function lattice(n, stride) {
  const out = [];
  for (let i = 0; i < n - 1; i += stride) out.push(i);
  out.push(n - 1);
  return out;
}

/**
 * Triangles over every `stride`-th vertex of an nx x ny grid, counter-
 * clockwise seen from above. Stride 1 is the whole grid; stride 2 is the
 * same surface with a quarter of the triangles, drawn while the camera is
 * moving on a machine that cannot keep up -- the vertices are the same ones,
 * so swapping the index is all it costs.
 */
export function gridIndex(nx, ny, stride = 1) {
  const is = lattice(nx, stride);
  const js = lattice(ny, stride);
  const index = indexArray(nx * ny, (is.length - 1) * (js.length - 1) * 6);
  let p = 0;
  for (let b = 0; b < js.length - 1; b++) {
    for (let a = 0; a < is.length - 1; a++) {
      const v00 = js[b] * nx + is[a];
      const v10 = js[b] * nx + is[a + 1];
      const v01 = js[b + 1] * nx + is[a];
      const v11 = js[b + 1] * nx + is[a + 1];
      index[p++] = v00; index[p++] = v10; index[p++] = v11;
      index[p++] = v00; index[p++] = v11; index[p++] = v01;
    }
  }
  return index;
}

/**
 * The tile's top surface: one vertex per height sample, normals from the
 * height field itself (so neighbouring cells agree and there is no faceting),
 * and two triangles per cell, counter-clockwise seen from above.
 */
export function groundArrays(h, colour) {
  const { nx, ny, step, heights, kind } = h;
  const N = nx * ny;
  const position = new Float32Array(N * 3);
  const normal = new Float32Array(N * 3);
  const color = new Float32Array(N * 3);
  const at = (i, j) => heights[Math.min(ny - 1, Math.max(0, j)) * nx + Math.min(nx - 1, Math.max(0, i))];
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const k = j * nx + i;
      position[k * 3] = i * step;
      position[k * 3 + 1] = j * step;
      position[k * 3 + 2] = heights[k];
      const dx = (at(i + 1, j) - at(i - 1, j)) / ((Math.min(nx - 1, i + 1) - Math.max(0, i - 1)) * step || 1);
      const dy = (at(i, j + 1) - at(i, j - 1)) / ((Math.min(ny - 1, j + 1) - Math.max(0, j - 1)) * step || 1);
      const len = Math.hypot(dx, dy, 1);
      normal[k * 3] = -dx / len;
      normal[k * 3 + 1] = -dy / len;
      normal[k * 3 + 2] = 1 / len;
      const c = colour(kind[k], heights[k]);
      color[k * 3] = c[0];
      color[k * 3 + 1] = c[1];
      color[k * 3 + 2] = c[2];
    }
  }
  return { position, normal, color, index: gridIndex(nx, ny, 1) };
}

/** The rim, walked counter-clockwise from the south-west corner: [i, j] per step. */
function rimWalk(nx, ny) {
  const out = [];
  for (let i = 0; i < nx - 1; i++) out.push([i, 0]);
  for (let j = 0; j < ny - 1; j++) out.push([nx - 1, j]);
  for (let i = nx - 1; i > 0; i--) out.push([i, ny - 1]);
  for (let j = ny - 1; j > 0; j--) out.push([0, j]);
  return out;
}

/**
 * The four sides of the printed piece, from the rim down to its bottom, as
 * plain triangles with one flat normal per side. The bottom is not drawn:
 * the piece stands on its risers or on the table, and nothing sees under it.
 */
export function wallArrays(h) {
  const { nx, ny, step, heights } = h;
  const walk = rimWalk(nx, ny);
  const position = new Float32Array(walk.length * 18);
  const normal = new Float32Array(walk.length * 18);
  let p = 0;
  const put = (x, y, z, n) => {
    position[p] = x; position[p + 1] = y; position[p + 2] = z;
    normal[p] = n[0]; normal[p + 1] = n[1]; normal[p + 2] = n[2];
    p += 3;
  };
  for (let s = 0; s < walk.length; s++) {
    const [i0, j0] = walk[s];
    const [i1, j1] = walk[(s + 1) % walk.length];
    // Outward is to the right of the counter-clockwise walk.
    const n = [j1 - j0, -(i1 - i0), 0];
    const x0 = i0 * step; const y0 = j0 * step; const z0 = heights[j0 * nx + i0];
    const x1 = i1 * step; const y1 = j1 * step; const z1 = heights[j1 * nx + i1];
    put(x0, y0, 0, n); put(x1, y1, 0, n); put(x1, y1, z1, n);
    put(x0, y0, 0, n); put(x1, y1, z1, n); put(x0, y0, z0, n);
  }
  return { position, normal };
}

/** The top edge of the piece, as a closed loop a hair above it: the seam, drawn. */
export function rimLine(h, liftMM = 0.15) {
  const { nx, ny, step, heights } = h;
  const walk = rimWalk(nx, ny);
  const position = new Float32Array(walk.length * 3);
  walk.forEach(([i, j], s) => {
    position[s * 3] = i * step;
    position[s * 3 + 1] = j * step;
    position[s * 3 + 2] = heights[j * nx + i] + liftMM;
  });
  return { position };
}

/**
 * A water surface as vertices over the whole grid and triangles only where
 * all four corners of a cell are wet. Flat-lit: the normals all point up, so
 * a lake reads as one sheet rather than as the ground under it.
 */
export function waterArrays(h, surface) {
  const { nx, ny, step } = h;
  const N = nx * ny;
  let cells = 0;
  for (let j = 0; j < ny - 1; j++) {
    for (let i = 0; i < nx - 1; i++) {
      const a = j * nx + i;
      if (!Number.isNaN(surface[a]) && !Number.isNaN(surface[a + 1]) && !Number.isNaN(surface[a + nx]) && !Number.isNaN(surface[a + nx + 1])) cells++;
    }
  }
  const position = new Float32Array(N * 3);
  const normal = new Float32Array(N * 3);
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const k = j * nx + i;
      position[k * 3] = i * step;
      position[k * 3 + 1] = j * step;
      position[k * 3 + 2] = Number.isNaN(surface[k]) ? 0 : surface[k];
      normal[k * 3 + 2] = 1;
    }
  }
  const index = indexArray(N, cells * 6);
  let p = 0;
  for (let j = 0; j < ny - 1; j++) {
    for (let i = 0; i < nx - 1; i++) {
      const a = j * nx + i;
      const b = a + 1;
      const c = a + nx;
      const d = c + 1;
      if (Number.isNaN(surface[a]) || Number.isNaN(surface[b]) || Number.isNaN(surface[c]) || Number.isNaN(surface[d])) continue;
      index[p++] = a; index[p++] = b; index[p++] = d;
      index[p++] = a; index[p++] = d; index[p++] = c;
    }
  }
  return { position, normal, index, triangles: cells * 2 };
}

/**
 * A coarse copy of the top surface, for the pointer to be tested against.
 * At most `side` samples a side: a ray against nine full-resolution tiles
 * is a million triangles, and the pointer moves sixty times a second.
 */
export function proxyArrays(h, side = 41) {
  const { nx, ny, step, heights } = h;
  const stride = Math.max(1, Math.ceil((Math.max(nx, ny) - 1) / (side - 1)));
  const is = lattice(nx, stride);
  const js = lattice(ny, stride);
  const position = new Float32Array(is.length * js.length * 3);
  js.forEach((j, b) => is.forEach((i, a) => {
    const k = (b * is.length + a) * 3;
    position[k] = i * step;
    position[k + 1] = j * step;
    position[k + 2] = heights[j * nx + i];
  }));
  const index = new Uint32Array((is.length - 1) * (js.length - 1) * 6);
  let p = 0;
  for (let b = 0; b < js.length - 1; b++) {
    for (let a = 0; a < is.length - 1; a++) {
      const v = b * is.length + a;
      index[p++] = v; index[p++] = v + 1; index[p++] = v + is.length + 1;
      index[p++] = v; index[p++] = v + is.length + 1; index[p++] = v + is.length;
    }
  }
  return { position, index };
}

/**
 * The band round a tile's rim where a hand edit fades out: the cells within
 * `lockMM` of the rim, a hair above the ground, opaque at the rim and clear
 * at `lockMM` in. `rgb` is the colour, linear, 0..1. Colours are RGBA, so the
 * band shows exactly how much of a stroke each point would keep -- the less
 * of the band, the more of the stroke.
 */
export function lockBandArrays(h, lockMM, rgb, { liftMM = 0.3, alpha = 0.5 } = {}) {
  const { nx, ny, step, heights } = h;
  const rimDist = (i, j) => Math.min(i, j, nx - 1 - i, ny - 1 - j) * step;
  const position = new Float32Array(nx * ny * 3);
  const color = new Float32Array(nx * ny * 4);
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const k = j * nx + i;
      position[k * 3] = i * step;
      position[k * 3 + 1] = j * step;
      position[k * 3 + 2] = heights[k] + liftMM;
      const t = Math.min(1, rimDist(i, j) / Math.max(1e-6, lockMM));
      color[k * 4] = rgb[0];
      color[k * 4 + 1] = rgb[1];
      color[k * 4 + 2] = rgb[2];
      color[k * 4 + 3] = alpha * (1 - t * t * (3 - 2 * t));
    }
  }
  const cells = [];
  for (let j = 0; j < ny - 1; j++) {
    for (let i = 0; i < nx - 1; i++) {
      if (Math.min(rimDist(i, j), rimDist(i + 1, j + 1), rimDist(i + 1, j), rimDist(i, j + 1)) < lockMM) cells.push(j * nx + i);
    }
  }
  const index = indexArray(nx * ny, cells.length * 6);
  let p = 0;
  for (const a of cells) {
    index[p++] = a; index[p++] = a + 1; index[p++] = a + nx + 1;
    index[p++] = a; index[p++] = a + nx + 1; index[p++] = a + nx;
  }
  return { position, color, index };
}

/** The ground's height at a tile-local point, bilinear, clamped to the tile. */
export function sampleHeight(h, x, y) {
  const { nx, ny, step, heights } = h;
  const u = Math.max(0, Math.min(nx - 1, x / step));
  const v = Math.max(0, Math.min(ny - 1, y / step));
  const i = Math.min(nx - 2, Math.floor(u));
  const j = Math.min(ny - 2, Math.floor(v));
  const fu = u - i;
  const fv = v - j;
  const z = (ii, jj) => heights[jj * nx + ii];
  return (z(i, j) * (1 - fu) + z(i + 1, j) * fu) * (1 - fv) + (z(i, j + 1) * (1 - fu) + z(i + 1, j + 1) * fu) * fv;
}

/** The highest the ground comes along one of a tile's edges, near its middle (the port, if there is one). */
export function edgeTop(h, edge, spanMM = 24) {
  const T = (h.nx - 1) * h.step;
  let top = -Infinity;
  for (let d = -spanMM / 2; d <= spanMM / 2 + 1e-9; d += Math.max(0.5, h.step)) {
    const s = T / 2 + d;
    const [x, y] = edge === 'N' ? [s, T] : edge === 'S' ? [s, 0] : edge === 'E' ? [T, s] : [0, s];
    top = Math.max(top, sampleHeight(h, x, y));
  }
  return top;
}

/* ----------------------------------------------------------------- colour */

/**
 * The ground's colour, from the same bands the hillshade uses so the board
 * and the 3D view are one map: low green, mid olive, high stone to snow. No
 * shading here; the lights do that. `t` is the height as a fraction of the
 * board's span, in world mm.
 */
export function groundColour(kind, t) {
  if (kind === WOOD) return [0.19 + t * 0.08, 0.36 + t * 0.06, 0.2];
  if (kind === RIVER || kind === STILL) return [0.42, 0.4, 0.33];
  let r, g, b;
  if (t < 0.3) { r = 86 + t * 90; g = 132 + t * 110; b = 62 + t * 40; }
  else if (t < 0.62) { r = 126 + t * 80; g = 138 + t * 40; b = 86 + t * 20; }
  else { const u = (t - 0.62) / 0.38; r = 150 + u * 95; g = 146 + u * 100; b = 134 + u * 110; }
  return [Math.min(1, r / 255 * 1.08), Math.min(1, g / 255 * 1.08), Math.min(1, b / 255 * 1.08)];
}

/** The lowest and highest world height over a grown board, which the colour bands are fractions of. */
export function worldSpan(tiles) {
  let lo = Infinity;
  let hi = -Infinity;
  for (const h of tiles) {
    for (let k = 0; k < h.heights.length; k++) {
      const z = h.standMM + h.heights[k];
      if (z < lo) lo = z;
      if (z > hi) hi = z;
    }
  }
  if (!Number.isFinite(lo)) return { lo: 0, hi: 1 };
  return { lo, hi: Math.max(hi, lo + 1e-6) };
}
