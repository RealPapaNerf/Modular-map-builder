// fluvial.js — rivers cut the range before the ice comes.
//
// WHY THIS EXISTS. A glacier does not invent its valleys. It takes over the
// ones rivers cut first -- a branching net of V-shaped valleys with sharp
// ridges between them -- and widens and deepens them into U troughs, while
// cirques at their heads eat the ridges back into arêtes and horns. Started
// on a smooth bump instead, the ice can only comb parallel grooves straight
// down the flanks: which is what this builder did, and why its mountains
// came out as rounded loaves. So the uplift is dissected by running water
// first, and the ice works on what that leaves.
//
// THE MODEL is the stream-power law, the standard one for bedrock rivers:
//
//     dz/dt = -K A^m S^n          (n = 1 here)
//
// erosion grows with the water a cell collects (drainage area A) and with
// its slope S, so trunk valleys cut fastest and the divides between them are
// left standing as sharp ridges. Solved implicitly, after Braun & Willett
// (2013): order the cells from the outlets up along their receivers, then
// each new height follows from its already-updated receiver, which is stable
// at any time step. Every cell drains to the world's edge, which is base
// level; hollows are routed across by filling them first (priority flood),
// so a pit never traps the drainage.
//
// Between steps the slopes are relaxed to their critical angle (hillslope.js)
// -- per cell when a rock-strength field is given, so strong rock stands in
// walls and weak rock sheds into gullies.

import { Heap } from './heap.js';
import { massWaste } from './hillslope.js';

export const FLUVIAL_DEFAULTS = {
  steps: 100, // implicit steps
  years: 2000, // per step
  K: 1e-5, // erodibility, per year, for m = 0.5: valleys some hundreds of metres deep, the range kept
  m: 0.5, // drainage-area exponent
  critDeg: 55, // slope limit between steps, where no rock field is given
  wastePasses: 2,
};

const NB = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];

/**
 * Where every cell drains, and the order to visit them in: receivers from a
 * priority flood off the field's edge, so every cell has a path out even
 * across a closed hollow, and the stack is outlets first.
 */
/** A small, fixed, per-cell number: how much a fill may rise crossing that cell. */
function jitter(k) {
  let h = Math.imul(k ^ 0x9e3779b9, 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return (((h ^ (h >>> 16)) >>> 0) / 4294967296) * 0.05;
}

/** A fixed number in [0, 1) for a pair of cells. */
function pairNoise(a, b) {
  let h = Math.imul(a ^ 0x27d4eb2d, 0x165667b1) ^ Math.imul(b + 0x61c88647, 0x9e3779b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  return ((h ^ (h >>> 13)) >>> 0) / 4294967296;
}

export function routeFlow(f, rec = null, stack = null) {
  const { nx, ny } = f;
  const z = f.values;
  const N = nx * ny;
  rec = rec || new Int32Array(N);
  stack = stack || new Int32Array(N);
  const level = new Float64Array(N);
  const done = new Uint8Array(N);
  const done2 = new Uint8Array(N); // popped: on the stack already
  const heap = new Heap(N);
  for (let k = 0; k < N; k++) {
    const i = k % nx;
    const j = (k - i) / nx;
    if (i === 0 || j === 0 || i === nx - 1 || j === ny - 1) { level[k] = z[k]; done[k] = 1; rec[k] = k; heap.push(z[k], k); }
  }
  let n = 0;
  while (heap.n > 0) {
    const k = heap.pop();
    stack[n++] = k;
    // The receiver: the steepest way down on the filled surface, weighted
    // by a fixed random factor per pair of cells. The cell that flooded
    // this one is ALWAYS lower, so it is the fallback; but left at that,
    // every river follows the grid, straight along an axis or a diagonal,
    // and a range comes out ruled with parallel valleys. Weighted, they
    // wander and branch the way real ones do. A lower cell is already on
    // the stack, so the outlets-first order still holds.
    if (rec[k] !== k) {
      const i = k % nx;
      const j = (k - i) / nx;
      let best = rec[k];
      let bestScore = -Infinity;
      for (const [di, dj] of NB) {
        const ii = i + di;
        const jj = j + dj;
        if (ii < 0 || jj < 0 || ii >= nx || jj >= ny) continue;
        const q = jj * nx + ii;
        if (!(level[q] < level[k]) || !done2[q]) continue;
        const score = ((level[k] - level[q]) / Math.hypot(di, dj)) * (0.55 + 0.9 * pairNoise(k, q));
        if (score > bestScore) { bestScore = score; best = q; }
      }
      rec[k] = best;
    }
    done2[k] = 1;
    const i = k % nx;
    const j = (k - i) / nx;
    for (const [di, dj] of NB) {
      const ii = i + di;
      const jj = j + dj;
      if (ii < 0 || jj < 0 || ii >= nx || jj >= ny) continue;
      const q = jj * nx + ii;
      if (done[q]) continue;
      done[q] = 1;
      // A hollow is filled to just above its spill point, so the order is
      // strict and the water crosses it. The rise is jittered, a little and
      // the same way every time: filled by a strict increment, a flat drains
      // in dead straight lines along the grid, and every plain is ruled.
      level[q] = Math.max(z[q], level[k] + 1e-6 + jitter(q));
      rec[q] = k;
      heap.push(level[q], q);
    }
  }
  return { rec, stack, n };
}

/** Drainage area of every cell, in m^2, given its receivers and the outlets-first stack. */
export function drainageArea(f, rec, stack, n, area = null) {
  const cell = f.step * f.step;
  area = area || new Float64Array(f.nx * f.ny);
  area.fill(cell);
  for (let s = n - 1; s > 0; s--) {
    const k = stack[s];
    if (rec[k] !== k) area[rec[k]] += area[k];
  }
  return area;
}

/**
 * Cut the field with running water, in place.
 *
 *   o.erodibility  per-cell multiplier on K (weak rock cuts faster); null for 1
 *   o.critTan      per-cell tangent of the critical slope; null for o.critDeg
 *   o.keepRelief   when true, the heights above the field's own minimum are
 *                  rescaled at the end so the highest point stands where it
 *                  stood: the rivers carve the range, they do not lower it,
 *                  and the mountain the author typed is the mountain printed
 *
 * Returns how deep it cut, at most, in metres.
 */
export function fluvialErode(f, opts = {}) {
  const o = { ...FLUVIAL_DEFAULTS, ...opts };
  const { nx, ny, step } = f;
  const N = nx * ny;
  const z = f.values;
  const z0 = Float64Array.from(z);
  let lo0 = Infinity;
  let hi0 = -Infinity;
  for (const v of z) { if (v < lo0) lo0 = v; if (v > hi0) hi0 = v; }
  const rec = new Int32Array(N);
  const stack = new Int32Array(N);
  const area = new Float64Array(N);
  for (let it = 0; it < o.steps; it++) {
    const { n } = routeFlow(f, rec, stack);
    drainageArea(f, rec, stack, n, area);
    for (let s = 0; s < n; s++) {
      const k = stack[s];
      const r = rec[k];
      if (r === k) continue;
      const ki = k % nx;
      const ri = r % nx;
      const d = step * Math.hypot(ki - ri, (k - ki) / nx - (r - ri) / nx);
      const Kk = o.K * (o.erodibility ? o.erodibility[k] : 1);
      const F = (Kk * Math.pow(area[k], o.m) * o.years) / d;
      const zr = z[r];
      if (z[k] > zr) z[k] = (z[k] + F * zr) / (1 + F);
    }
    massWaste(f, { critDeg: o.critDeg, critTan: o.critTan, passes: o.wastePasses });
  }
  let cut = 0;
  for (let k = 0; k < N; k++) if (z0[k] - z[k] > cut) cut = z0[k] - z[k];
  if (o.keepRelief) {
    let lo = Infinity;
    let hi = -Infinity;
    for (const v of z) { if (v < lo) lo = v; if (v > hi) hi = v; }
    const scale = hi > lo ? (hi0 - lo) / (hi - lo) : 1;
    for (let k = 0; k < N; k++) z[k] = lo + (z[k] - lo) * scale;
  }
  return { maxCutM: cut };
}
