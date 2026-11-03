// lake.js — standing water: tarns, lakes, and the mouths of bays.
//
// ONE OPERATION, THREE JOBS. A tarn in a cirque, a lake somebody placed, and
// the water behind a bay mouth are not three features. They are all the same
// thing: a FLAT SURFACE at some level, everything below it that is connected
// to a seed, and a bed scooped under it. What differs is only where the seed
// comes from and what sets the level -- the glacier's own hollow, a point on
// the map, or the port in the rim. So there is one carve and three ways in.
//
// WHY THE SURFACE HAS TO BE FLAT, and why that is awkward here. Water is
// level, and a sloping lake reads as a dent. But the tile is fitted to its
// contract by adding a smooth correction across the whole of it, and that
// correction would TILT a flat surface. So lakes are carved AFTER the tile
// has been conformed, and are kept off the boundary ring, which the contract
// owns. Nothing is ever clipped at a seam: a lake that cannot fit clear of
// the rim is reported rather than cut in half.
//
// THE BED IS A HOLE, not a painted-on surface -- the same choice relief made,
// for the same reason: you can pour clear epoxy into a hole. Depth and shore
// are millimetres on the print, and the volume comes back in millilitres so
// you can mix the right amount.

import { depressionStats } from './basins.js';
import { fbm } from './noise.js';

export const LAKE_DEFAULTS = {
  depthMM: 4, // how far the bed sits below the water surface
  shoreMM: 9, // how far in from the shoreline the bed reaches full depth
  profile: 'dish', // dish | flat | cone
  minBedMM: 1.6, // never leave less plate than this under the deepest point
  keepClearMM: 2, // how far the water stays off the rim
  minAreaMM2: 40, // anything smaller is a dimple, not a lake
};

export const PROFILES = ['dish', 'flat', 'cone'];

/** How deep, as a fraction of full depth, at distance d from the shore. */
function bedShape(profile, d, shoreMM, dMax) {
  if (profile === 'cone') {
    // Deepest at the middle and straight-sided: a V, which holds least but
    // reads as a mountain tarn.
    return Math.max(0, Math.min(1, d / Math.max(1e-6, dMax)));
  }
  // Both of these reach full depth `shoreMM` in from the shoreline and are
  // flat beyond it; they differ only in the shape of the ramp. The rounded
  // one gets there sooner, so a dish actually holds MORE than a flat bed,
  // which is the opposite of what the names suggest and worth saying here:
  // "flat" describes the straight shore, not a bigger reservoir.
  const u = Math.max(0, Math.min(1, d / Math.max(1e-6, shoreMM)));
  if (profile === 'flat') return u; // a straight shelf down to a flat bed
  return Math.sin((Math.PI / 2) * u); // dish: rounded, no crease at the waterline
}

/**
 * Everything below `surfaceZ` reachable from a seed cell without leaving the
 * tile or touching the rim.
 *
 * Four-connected on purpose: an eight-connected fill leaks diagonally
 * through a one-cell gap in a rim, and a lake that escapes its basin is the
 * one failure that is invisible until it is printed.
 */
export function lakeExtent(local, seedIdx, surfaceZ, { keepClearMM = 2 } = {}) {
  const { nx, ny, step } = local;
  const z = local.values;
  const margin = Math.max(1, Math.ceil(keepClearMM / step));
  const mask = new Uint8Array(nx * ny);
  if (z[seedIdx] >= surfaceZ) return { mask, cells: 0, touchedRim: false };

  const stack = [seedIdx];
  mask[seedIdx] = 1;
  let cells = 1;
  let touchedRim = false;
  while (stack.length) {
    const k = stack.pop();
    const i = k % nx;
    const j = (k - i) / nx;
    for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const ni = i + di;
      const nj = j + dj;
      if (ni < 0 || nj < 0 || ni >= nx || nj >= ny) continue;
      const nk = nj * nx + ni;
      if (mask[nk] || z[nk] >= surfaceZ) continue;
      if (ni < margin || nj < margin || ni >= nx - margin || nj >= ny - margin) {
        // The water reached the rim. Stop there and say so; the caller
        // decides whether that is a bay mouth or a lake that will not fit.
        touchedRim = true;
        continue;
      }
      mask[nk] = 1;
      cells++;
      stack.push(nk);
    }
  }
  return { mask, cells, touchedRim };
}

/**
 * Distance from each wet cell to the nearest dry one, in mm.
 *
 * Two-pass chamfer rather than exact Euclidean: the error is a few percent
 * on the diagonal and it is only ever used to shape a shore ramp.
 */
export function distanceToShore(mask, nx, ny, step) {
  const INF = 1e9;
  const d = new Float64Array(nx * ny);
  for (let k = 0; k < d.length; k++) d[k] = mask[k] ? INF : 0;
  const A = step;
  const B = step * Math.SQRT2;
  const relax = (k, nk, w) => { if (d[nk] + w < d[k]) d[k] = d[nk] + w; };
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const k = j * nx + i;
      if (!mask[k]) continue;
      if (i > 0) relax(k, k - 1, A);
      if (j > 0) relax(k, k - nx, A);
      if (i > 0 && j > 0) relax(k, k - nx - 1, B);
      if (i < nx - 1 && j > 0) relax(k, k - nx + 1, B);
    }
  }
  for (let j = ny - 1; j >= 0; j--) {
    for (let i = nx - 1; i >= 0; i--) {
      const k = j * nx + i;
      if (!mask[k]) continue;
      if (i < nx - 1) relax(k, k + 1, A);
      if (j < ny - 1) relax(k, k + nx, A);
      if (i < nx - 1 && j < ny - 1) relax(k, k + nx + 1, B);
      if (i > 0 && j < ny - 1) relax(k, k + nx - 1, B);
    }
  }
  return d;
}

/**
 * Scoop a bed under a water surface, in place. Returns the volume it holds.
 *
 * The bed is only ever cut DOWN. A lake laid over ground that is already
 * below the bed would otherwise fill its own basin back in, which is how a
 * tarn sitting in a deep cirque would come out shallower than the hollow it
 * is in.
 */
export function carveLake(local, mask, o = {}) {
  const { surfaceZ, depthMM, shoreMM, profile, minBedMM } = { ...LAKE_DEFAULTS, ...o };
  const { nx, ny, step } = local;
  const z = local.values;
  const d = distanceToShore(mask, nx, ny, step);
  let dMax = 0;
  for (let k = 0; k < d.length; k++) if (mask[k] && d[k] > dMax) dMax = d[k];

  let volumeMM3 = 0;
  let cells = 0;
  let clamped = 0;
  let deepest = 0;
  for (let k = 0; k < mask.length; k++) {
    if (!mask[k]) continue;
    const want = surfaceZ - depthMM * bedShape(profile, d[k], shoreMM, dMax);
    const floor = minBedMM;
    const bed = Math.max(floor, Math.min(z[k], want));
    if (want < floor - 1e-9) clamped++;
    z[k] = bed;
    const h = surfaceZ - bed;
    if (h > 0) { volumeMM3 += h * step * step; cells++; if (h > deepest) deepest = h; }
  }
  return {
    cells,
    areaMM2: cells * step * step,
    volumeMM3,
    millilitres: volumeMM3 / 1000,
    deepestMM: deepest,
    clamped,
    surfaceZ,
  };
}

/**
 * Fill the closed hollows a glacier left.
 *
 * This is the payoff for all of basins.js. A river cannot leave a closed
 * hollow -- water running downhill fills them as it goes -- so every one of
 * these is somewhere the ice overdeepened its bed, and putting water in them
 * is what turns a cirque floor into a tarn.
 *
 * The surface sits at the sill, which is exactly what the priority flood
 * already computed: the lowest point water would have to cross to get out.
 */
export function fillHollows(local, o = {}) {
  const opts = { ...LAKE_DEFAULTS, ...o };
  const { nx, ny, step } = local;
  const z = local.values;
  const margin = Math.max(1, Math.ceil(opts.keepClearMM / step));
  const stats = depressionStats(local, { minDepthM: opts.minDepthMM ?? 0.8 });
  const wet = new Uint8Array(nx * ny);
  const lakes = [];

  // Label the flooded cells into separate hollows, then carve each one that
  // is worth carving.
  const seen = new Uint8Array(nx * ny);
  for (let k0 = 0; k0 < nx * ny; k0++) {
    if (!stats.wet[k0] || seen[k0]) continue;
    const group = [];
    const stack = [k0];
    seen[k0] = 1;
    let sill = -Infinity;
    let onRim = false;
    while (stack.length) {
      const k = stack.pop();
      group.push(k);
      if (stats.filled[k] > sill) sill = stats.filled[k];
      const i = k % nx;
      const j = (k - i) / nx;
      if (i < margin || j < margin || i >= nx - margin || j >= ny - margin) onRim = true;
      for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const ni = i + di;
        const nj = j + dj;
        if (ni < 0 || nj < 0 || ni >= nx || nj >= ny) continue;
        const nk = nj * nx + ni;
        if (stats.wet[nk] && !seen[nk]) { seen[nk] = 1; stack.push(nk); }
      }
    }
    const areaMM2 = group.length * step * step;
    if (areaMM2 < opts.minAreaMM2) continue;
    if (onRim) {
      // A hollow against the rim would have to be cut at the seam, and
      // nothing here is ever clipped at a seam.
      lakes.push({ skipped: 'reaches the rim', areaMM2 });
      continue;
    }
    let deepest = 0;
    for (const k of group) deepest = Math.max(deepest, sill - z[k]);
    const mask = new Uint8Array(nx * ny);
    for (const k of group) { mask[k] = 1; wet[k] = 1; }
    const r = carveLake(local, mask, {
      ...opts,
      surfaceZ: sill,
      // A shallow hollow gets a shallow lake: scooping a fixed 4 mm out of a
      // 1 mm dip would turn a damp patch into a quarry.
      depthMM: Math.min(opts.depthMM, Math.max(0.8, deepest + opts.depthMM * 0.5)),
    });
    lakes.push({ ...r, naturalDepthMM: deepest });
  }
  return { lakes: lakes.filter((l) => !l.skipped), skipped: lakes.filter((l) => l.skipped), wet };
}

/**
 * A lake somebody placed.
 *
 * Two ways to decide how far it reaches, and they are not interchangeable.
 *
 *   FLOOD (no radiusMM): everything below the surface connected to the
 *     seed. Right for a lake filling ground that is already low.
 *   EXCAVATE (radiusMM): a disc, dug out whatever the ground was doing.
 *     Right for a bay or a fjord mouth, where the water body is a given and
 *     the land has to get out of its way. Flooding those silently produced
 *     nothing at all -- the mouth's surface sits at the port floor, near the
 *     very bottom of the tile, and no ground inland is below it, so the fill
 *     found zero cells and reported "too small".
 */
export function placeLake(local, o = {}) {
  const opts = { ...LAKE_DEFAULTS, ...o };
  const { nx, ny, step } = local;
  const i = Math.round(opts.atMM[0] / step);
  const j = Math.round(opts.atMM[1] / step);
  if (i < 0 || j < 0 || i >= nx || j >= ny) return { skipped: 'off the tile' };
  const k0 = j * nx + i;
  const surfaceZ = Number.isFinite(opts.surfaceZMM)
    ? opts.surfaceZMM
    : local.values[k0] + (opts.riseMM ?? opts.depthMM * 0.6);

  let mask;
  let cells = 0;
  if (opts.radiusMM > 0) {
    mask = new Uint8Array(nx * ny);
    const margin = opts.allowRim ? 1 : Math.max(1, Math.ceil(opts.keepClearMM / step));
    // Lobed, not round. A perfect disc reads as a drain cover; a real bay
    // has headlands and inlets. The outline is a function of bearing alone
    // so it stays smooth, and of the seed so two bays differ.
    const lobe = opts.lobe ?? 0.3;
    const seed = opts.seed ?? 1;
    for (let jj = margin; jj < ny - margin; jj++) {
      for (let ii = margin; ii < nx - margin; ii++) {
        const dx = ii * step - opts.atMM[0];
        const dy = jj * step - opts.atMM[1];
        const d = Math.hypot(dx, dy);
        if (d > opts.radiusMM * (1 + lobe)) continue;
        const az = Math.atan2(dy, dx);
        const wob = fbm(Math.cos(az) * 2.1, Math.sin(az) * 2.1, { scale: 1, octaves: 3, seed });
        if (d <= opts.radiusMM * (1 + lobe * wob)) { mask[jj * nx + ii] = 1; cells++; }
      }
    }
  } else {
    const ex = lakeExtent(local, k0, surfaceZ, opts);
    if (ex.touchedRim && !opts.allowRim) return { skipped: 'the water reached the rim', cells: ex.cells };
    mask = ex.mask;
    cells = ex.cells;
  }
  if (cells * step * step < opts.minAreaMM2) return { skipped: 'too small', cells };

  const headroom = surfaceZ - opts.minBedMM;
  if (headroom < 0.5) {
    return {
      skipped: `its surface is only ${surfaceZ.toFixed(1)} mm up, which leaves no room for a bed ` +
               `above the ${opts.minBedMM} mm floor. Raise outletZMM.`,
      cells,
    };
  }
  const wet = new Uint8Array(nx * ny);
  for (let k = 0; k < mask.length; k++) if (mask[k]) wet[k] = 1;
  return { ...carveLake(local, mask, { ...opts, surfaceZ, depthMM: Math.min(opts.depthMM, headroom) }), wet };
}
