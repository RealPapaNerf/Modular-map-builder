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
  // Tarns -- the hollows the ice left -- have their own bar, and it is
  // higher. Till is lumpy and a glaciated bed has dimples everywhere; at 40
  // mm^2 and 0.8 mm one module came out with twenty ponds, and ground
  // pocked with that many small lakes reads as a crevassed ice field, not
  // as a valley with a tarn in it. A tarn has to be a tarn.
  tarnMinAreaMM2: 150,
  tarnMinDepthMM: 1.5,
};

export const PROFILES = ['dish', 'flat', 'cone'];

/**
 * The size of a body of water: its centroid, the bearing of its long axis,
 * and its length and width along and across that axis, from the second
 * moments of its cells. This is what the inspector shows when a lake is
 * clicked, and what a resize is written against.
 */
export function lakeShape(mask, nx, ny, step) {
  let n = 0; let sx = 0; let sy = 0;
  for (let k = 0; k < mask.length; k++) {
    if (!mask[k]) continue;
    const i = k % nx;
    const j = (k - i) / nx;
    sx += i; sy += j; n++;
  }
  if (!n) return null;
  const ci = sx / n;
  const cj = sy / n;
  let a = 0; let b = 0; let c = 0;
  for (let k = 0; k < mask.length; k++) {
    if (!mask[k]) continue;
    const i = k % nx;
    const di = i - ci;
    const dj = (k - i) / nx - cj;
    a += di * di; b += di * dj; c += dj * dj;
  }
  const angle = 0.5 * Math.atan2(2 * b, a - c); // the long axis, radians from east
  const ux = Math.cos(angle);
  const uy = Math.sin(angle);
  let lo = Infinity; let hi = -Infinity; let wlo = Infinity; let whi = -Infinity;
  for (let k = 0; k < mask.length; k++) {
    if (!mask[k]) continue;
    const i = k % nx;
    const di = i - ci;
    const dj = (k - i) / nx - cj;
    const p = di * ux + dj * uy;
    const q = -di * uy + dj * ux;
    if (p < lo) lo = p; if (p > hi) hi = p;
    if (q < wlo) wlo = q; if (q > whi) whi = q;
  }
  return {
    atMM: [ci * step, cj * step],
    angleDeg: ((angle * 180) / Math.PI + 180) % 180,
    lengthMM: (hi - lo + 1) * step,
    widthMM: (whi - wlo + 1) * step,
    // Where along each axis the extent sits, so a resize scales about the
    // middle of the water rather than its centre of mass.
    midAlongMM: ((hi + lo) / 2) * step,
    midAcrossMM: ((whi + wlo) / 2) * step,
    areaMM2: n * step * step,
  };
}

/**
 * Which resize entry, if any, is about this hollow: the one whose point is
 * on its water, or failing that the nearest whose point is within reach of
 * its centre. A tarn is found again by where it is, so a resize survives a
 * regrow that leaves the hollow roughly where it was.
 */
function resizeFor(list, mask, shape, nx, step, reachMM = 30) {
  let best = -1;
  let bestD = Infinity;
  list.forEach((r, idx) => {
    if (!r || !Array.isArray(r.atMM) || r.taken) return;
    const [x, y] = r.atMM;
    const i = Math.round(x / step);
    const j = Math.round(y / step);
    const on = i >= 0 && j >= 0 && i < nx && mask[j * nx + i];
    const d = on ? -1 : Math.hypot(x - shape.atMM[0], y - shape.atMM[1]);
    if (d < bestD && d <= reachMM) { bestD = d; best = idx; }
  });
  return best;
}

/**
 * A hollow's water made a different size, in place: the hollow's own
 * outline, scaled about its middle along its long axis to `lengthMM` and
 * across it to `widthMM`. Where the new outline is smaller, the hollow is
 * filled in to a flat a little above the water -- a lake that silted up --
 * and where it is bigger, the bank is dug out under it. Any ground just
 * outside the new outline that is below the water is raised to hold it: a
 * lake made longer than its hollow would otherwise spill over its sill.
 *
 * Returns the new mask and what was done.
 */
export function resizeHollow(local, mask, surfaceZ, shape, want, o = {}) {
  const { nx, ny, step } = local;
  const z = local.values;
  const margin = Math.max(1, Math.ceil((o.keepClearMM ?? LAKE_DEFAULTS.keepClearMM) / step));
  const lip = o.shoreRiseMM ?? 0.6;
  if (want.fill) {
    let cells = 0;
    for (let k = 0; k < mask.length; k++) if (mask[k] && z[k] < surfaceZ + lip) { z[k] = surfaceZ + lip; cells++; }
    return { mask: new Uint8Array(nx * ny), filled: cells };
  }
  const L = Number.isFinite(want.lengthMM) && want.lengthMM > 0 ? want.lengthMM : shape.lengthMM;
  const W = Number.isFinite(want.widthMM) && want.widthMM > 0 ? want.widthMM : shape.widthMM;
  const fL = L / shape.lengthMM;
  const fW = W / shape.widthMM;
  const a = (shape.angleDeg * Math.PI) / 180;
  const ux = Math.cos(a);
  const uy = Math.sin(a);
  // The middle of the extent, in mm.
  const mx = shape.atMM[0] + ux * shape.midAlongMM - uy * shape.midAcrossMM;
  const my = shape.atMM[1] + uy * shape.midAlongMM + ux * shape.midAcrossMM;
  const reachL = (L / 2) + step;
  const reachW = (W / 2) + step;
  const R = Math.hypot(reachL, reachW) + step;
  const next = new Uint8Array(nx * ny);
  let clipped = 0;
  const i0 = Math.max(0, Math.floor((mx - R) / step));
  const i1 = Math.min(nx - 1, Math.ceil((mx + R) / step));
  const j0 = Math.max(0, Math.floor((my - R) / step));
  const j1 = Math.min(ny - 1, Math.ceil((my + R) / step));
  for (let j = j0; j <= j1; j++) {
    for (let i = i0; i <= i1; i++) {
      const dx = i * step - mx;
      const dy = j * step - my;
      const p = dx * ux + dy * uy;
      const q = -dx * uy + dy * ux;
      // Back into the old outline, and is that point water?
      const sx = mx + (p / fL) * ux - (q / fW) * uy;
      const sy = my + (p / fL) * uy + (q / fW) * ux;
      const si = Math.round(sx / step);
      const sj = Math.round(sy / step);
      if (si < 0 || sj < 0 || si >= nx || sj >= ny || !mask[sj * nx + si]) continue;
      if (i < margin || j < margin || i >= nx - margin || j >= ny - margin) { clipped++; continue; }
      next[j * nx + i] = 1;
    }
  }
  // Fill what the water gave up, rising gently away from the new shore.
  const dist = distanceToShore(Uint8Array.from(next, (v) => 1 - v), nx, ny, step);
  let filled = 0;
  for (let k = 0; k < mask.length; k++) {
    if (!mask[k] || next[k]) continue;
    const t = surfaceZ + lip + Math.min(1.5, dist[k] * 0.12);
    if (z[k] < t) { z[k] = t; filled++; }
  }
  // Hold the water in where the new outline reaches past the old sill.
  let dammed = 0;
  for (let k = 0; k < next.length; k++) {
    if (next[k]) continue;
    const i = k % nx;
    const j = (k - i) / nx;
    let touches = false;
    for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]) {
      const ii = i + di;
      const jj = j + dj;
      if (ii >= 0 && jj >= 0 && ii < nx && jj < ny && next[jj * nx + ii]) { touches = true; break; }
    }
    if (touches && z[k] < surfaceZ + lip) { z[k] = surfaceZ + lip; dammed++; }
  }
  return { mask: next, filled, dammed, clipped, lengthMM: L, widthMM: W };
}

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
 *
 * `o.resize` is the list of tarns somebody has resized by hand,
 * `[{ atMM, lengthMM, widthMM }]` or `[{ atMM, fill: true }]`; each is
 * matched to the hollow its point is on. One that matches nothing any more
 * is listed in `unusedResizes`, so the report can say so.
 */
export function fillHollows(local, o = {}) {
  const opts = { ...LAKE_DEFAULTS, ...o };
  const { nx, ny, step } = local;
  const z = local.values;
  const margin = Math.max(1, Math.ceil(opts.keepClearMM / step));
  const stats = depressionStats(local, { minDepthM: opts.minDepthMM ?? opts.tarnMinDepthMM });
  const wet = new Uint8Array(nx * ny);
  const lakes = [];
  // Copies, so marking an entry taken does not write to the spec.
  const resize = (Array.isArray(opts.resize) ? opts.resize : []).map((r) => (r && typeof r === 'object' ? { ...r } : null));

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
    if (areaMM2 < Math.max(opts.minAreaMM2, opts.tarnMinAreaMM2)) continue;
    if (onRim) {
      // A hollow against the rim would have to be cut at the seam, and
      // nothing here is ever clipped at a seam.
      lakes.push({ skipped: 'reaches the rim', areaMM2 });
      continue;
    }
    let deepest = 0;
    for (const k of group) deepest = Math.max(deepest, sill - z[k]);
    let mask = new Uint8Array(nx * ny);
    for (const k of group) mask[k] = 1;
    const asDug = lakeShape(mask, nx, ny, step);
    // RESIZED BY HAND: the tarn the ice dug, made the size somebody asked
    // for (see resizeHollow), or filled in.
    const ri = resizeFor(resize, mask, asDug, nx, step);
    let resized = null;
    if (ri >= 0) {
      resize[ri].taken = true;
      const r = resizeHollow(local, mask, sill, asDug, resize[ri], opts);
      resized = { index: ri, ...r, mask: undefined };
      if (resize[ri].fill) { lakes.push({ filledIn: true, resizeIndex: ri, asDug, areaMM2 }); continue; }
      mask = r.mask;
      let any = false;
      for (let k = 0; k < mask.length; k++) if (mask[k]) { any = true; break; }
      if (!any) { lakes.push({ skipped: 'resized to nothing', areaMM2 }); continue; }
    }
    for (let k = 0; k < mask.length; k++) if (mask[k]) wet[k] = 1;
    const r = carveLake(local, mask, {
      ...opts,
      surfaceZ: sill,
      // A shallow hollow gets a shallow lake: scooping a fixed 4 mm out of a
      // 1 mm dip would turn a damp patch into a quarry.
      depthMM: Math.min(opts.depthMM, Math.max(0.8, deepest + opts.depthMM * 0.5)),
    });
    // Its own cells, as placeLake gives a placed lake its own: the union in
    // `wet` cannot say which surface a cell is under, and the 3D view needs to.
    lakes.push({ ...r, naturalDepthMM: deepest, wet: mask, shape: lakeShape(mask, nx, ny, step), asDug, resized });
  }
  const unused = resize.map((r, index) => ({ r, index })).filter(({ r }) => r && !r.taken).map(({ index }) => index);
  return {
    lakes: lakes.filter((l) => !l.skipped && !l.filledIn),
    filledIn: lakes.filter((l) => l.filledIn),
    skipped: lakes.filter((l) => l.skipped),
    unusedResizes: unused,
    wet,
  };
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
/**
 * Distance from a point to a polyline, and how far along it that was.
 *
 * Written out here rather than shared with river.js because the two want
 * different things from it: a channel needs the fraction along to set its
 * fall, a lake only needs the distance. Fifteen lines, no dependency.
 */
function distToPath(path, x, y) {
  if (path.length === 1) return Math.hypot(x - path[0][0], y - path[0][1]);
  let best = Infinity;
  for (let i = 0; i < path.length - 1; i++) {
    const [ax, ay] = path[i];
    const [bx, by] = path[i + 1];
    const vx = bx - ax;
    const vy = by - ay;
    const len2 = vx * vx + vy * vy;
    let t = len2 > 0 ? ((x - ax) * vx + (y - ay) * vy) / len2 : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const d = Math.hypot(x - (ax + t * vx), y - (ay + t * vy));
    if (d < best) best = d;
  }
  return best;
}

export function placeLake(local, o = {}) {
  const opts = { ...LAKE_DEFAULTS, ...o };
  const { nx, ny, step } = local;
  // A PAINTED lake is given as the stroke that drew it rather than a centre.
  // Water finds its own level, so the surface is set by the LOWEST ground
  // anywhere under the stroke -- paint uphill and the water stays where it
  // can actually stand, instead of being perched at wherever the pointer
  // happened to go down.
  const path = Array.isArray(opts.pathMM) && opts.pathMM.length ? opts.pathMM : null;
  let atMM = opts.atMM;
  if (path) {
    let lo = Infinity;
    for (const [px, py] of path) {
      const pi = Math.round(px / step);
      const pj = Math.round(py / step);
      if (pi < 0 || pj < 0 || pi >= nx || pj >= ny) continue;
      const z = local.values[pj * nx + pi];
      if (z < lo) { lo = z; atMM = [px, py]; }
    }
  }
  if (!atMM) return { skipped: 'no place given' };
  const i = Math.round(atMM[0] / step);
  const j = Math.round(atMM[1] / step);
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
        const dx = ii * step - atMM[0];
        const dy = jj * step - atMM[1];
        // Painted: distance to the STROKE, so the shore follows what was
        // drawn. Placed: distance to the one point, as before.
        const d = path ? distToPath(path, ii * step, jj * step) : Math.hypot(dx, dy);
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
  return { ...carveLake(local, mask, { ...opts, surfaceZ, depthMM: Math.min(opts.depthMM, headroom) }), wet, shape: lakeShape(mask, nx, ny, step) };
}
