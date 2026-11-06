// detail.js — the fine pass: towers, gullies and walls, after the ice.
//
// WHY A SECOND GRID. The ice has to run on a coarse grid: its cost grows
// about seven-fold every time the grid is halved, and a grid fine enough to
// hold a spire would take the better part of an hour. But the ice does not
// make spires anyway. It makes the troughs, the cirques and the arêtes --
// shapes hundreds of metres to kilometres across, which a coarse grid holds
// well. What turns an arête into a row of towers is slower and smaller:
// frost wedging the joints open, the blocks between them left standing in
// walls, gullies down the weak lines. That work is local and cheap, so it is
// done on a fine grid over the module alone, after the ice has gone.
//
// THE PASS, per step:
//
//   frost    rock is lowered where it is steep, in proportion to how weak it
//            is: the joints on a face are attacked, the blocks between them
//            barely. Flat ground -- a trough floor, a cirque floor -- is not
//            touched, so the U the ice cut stays a U.
//   water    a little stream-power incision (fluvial.js), faster in weak
//            rock, which opens the joints into gullies and couloirs. Only
//            up on the range, as frost is: see frostFrom.
//   gravity  every cell relaxed to its own critical slope (rock.js): sound
//            rock stands at 80-odd degrees, a joint at 40, and what falls
//            off a wall lands at its foot as talus.
//
// The fine grid is the coarse bed resampled smoothly (Catmull-Rom), so the
// ice's shapes are kept exactly and only refined.

import { makeField } from './field.js';
import { massWaste } from './hillslope.js';
import { routeFlow, drainageArea } from './fluvial.js';
import { weaknessField, critTanField, ROCK_DEFAULTS } from './rock.js';

export const DETAIL_DEFAULTS = {
  enabled: true,
  stepMM: 1.0, // the fine grid, on the print
  padMM: 12, // how far past the rim the fine grid runs, so nothing at the rim is an edge effect
  steps: 90,
  years: 1500, // per step
  // FACES. Steep rock retreats: metres a year per unit of slope above
  // frostMinSlope, in fully jointed rock, and faceFloor of that in sound
  // rock. A summit whose faces all retreat shrinks from its edges until they
  // meet, which is how a horn gets its point.
  frostK: 1.5e-3,
  frostMinSlope: 0.4, // about 22 degrees, in true metres
  faceFloor: 0.3,
  // SUMMITS. Exposed tops shatter fastest: rock that sticks out loses heat
  // and takes frost on every side. Convex ground is lowered in proportion to
  // how far it stands above its neighbours and how jointed it is, so the
  // jointed parts of a crest drop away and the sound blocks between them are
  // left as towers. Metres a year per metre of standing proud.
  summitK: 4e-2,
  // ONLY HIGH UP. Frost-wedging is a summit process; the valley floors and
  // lower flanks are under soil and scree. Below frostFrom of the module's
  // relief, from the bottom, frost does nothing; it comes in over frostBand.
  frostFrom: 0.6,
  frostBand: 0.2,
  fluvialK: 1.2e-5, // stream power, as fluvial.js, scaled by the rock's weakness; also only high up
  m: 0.5,
  wastePasses: 3,
};

/** Catmull-Rom sample of a field at world (x, y), clamped at its edges. */
export function sampleCubic(f, x, y) {
  const u = (x - (f.originX || 0)) / f.step;
  const v = (y - (f.originY || 0)) / f.step;
  const i = Math.floor(u);
  const j = Math.floor(v);
  const tu = u - i;
  const tv = v - j;
  const at = (a, b) => f.values[Math.min(f.ny - 1, Math.max(0, b)) * f.nx + Math.min(f.nx - 1, Math.max(0, a))];
  const cr = (p0, p1, p2, p3, t) => p1 + 0.5 * t * (p2 - p0 + t * (2 * p0 - 5 * p1 + 4 * p2 - p3 + t * (3 * (p1 - p2) + p3 - p0)));
  const row = (b) => cr(at(i - 1, b), at(i, b), at(i + 1, b), at(i + 2, b), tu);
  return cr(row(j - 1), row(j), row(j + 1), row(j + 2), tv);
}

/**
 * The fine pass over a module. `bed` is the world bed in metres (the ice's
 * grid); the result is a field in the same metres and frame, covering the
 * module and `padMM` round it at `stepMM` on the print, which cutTile
 * samples in place of the bed.
 *
 *   tileMM, marginMM, metresPerMM   where the module is in the world
 *   rock                            rock.js settings
 */
export function detailPass(bed, { tileMM, marginMM, metresPerMM, rock = {}, ...opts } = {}) {
  const o = { ...DETAIL_DEFAULTS, ...opts };
  const pad = Math.min(o.padMM, marginMM);
  const stepM = o.stepMM * metresPerMM;
  const n = Math.round((tileMM + 2 * pad) / o.stepMM) + 1;
  const ox = (marginMM - pad) * metresPerMM;
  const f = makeField(n, n, stepM, ox, ox);
  const z = f.values;
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) z[j * n + i] = sampleCubic(bed, ox + i * stepM, ox + j * stepM);
  const before = Float64Array.from(z);
  const weak = weaknessField(f, { ...ROCK_DEFAULTS, ...rock });
  const critTan = critTanField(weak, { ...ROCK_DEFAULTS, ...rock }, z);
  const erod = Float64Array.from(weak, (w) => 0.6 + 0.8 * w);
  // Frost's reach, by height over the module itself (not the pad).
  let lo = Infinity;
  let hi = -Infinity;
  const p0 = Math.round(pad / o.stepMM);
  for (let j = p0; j < n - p0; j++) for (let i = p0; i < n - p0; i++) { const v = z[j * n + i]; if (v < lo) lo = v; if (v > hi) hi = v; }
  const frostAt = (v) => { const t = (v - lo) / Math.max(1e-9, hi - lo); return Math.max(0, Math.min(1, (t - o.frostFrom) / o.frostBand)); };

  const N = n * n;
  const alpine = Float64Array.from(z, (v) => frostAt(v));
  const rec = new Int32Array(N);
  const stack = new Int32Array(N);
  const area = new Float64Array(N);
  const loss = new Float64Array(N);
  for (let it = 0; it < o.steps; it++) {
    // Frost: steep, weak rock is wedged apart and falls away.
    for (let j = 1; j < n - 1; j++) {
      for (let i = 1; i < n - 1; i++) {
        const k = j * n + i;
        const gx = (z[k + 1] - z[k - 1]) / (2 * stepM);
        const gy = (z[k + n] - z[k - n]) / (2 * stepM);
        const S = Math.hypot(gx, gy);
        const high = frostAt(z[k]);
        // How far this cell stands above the mean of its four neighbours.
        const proud = z[k] - 0.25 * (z[k + 1] + z[k - 1] + z[k + n] + z[k - n]);
        // Faces retreat in sound rock too, more slowly than along a joint:
        // a summit whose faces all retreat shrinks from its edges until they
        // meet, which is how a horn gets its point. Summits wear only where
        // jointed, which is what notches a crest into towers.
        loss[k] = high * o.years * (
          (S > o.frostMinSlope ? o.frostK * (o.faceFloor + (1 - o.faceFloor) * weak[k]) * (S - o.frostMinSlope) : 0)
          + (proud > 0 ? o.summitK * weak[k] * proud : 0));
        // Never more than it stands proud by in one step: a cell lowered past
        // its neighbours' mean makes them the proud ones, and the next step
        // overshoots back -- the first try of this diverged.
        if (proud > 0 && loss[k] > proud + (S > o.frostMinSlope ? 0.5 * S * stepM : 0)) loss[k] = proud + (S > o.frostMinSlope ? 0.5 * S * stepM : 0);
      }
    }
    for (let k = 0; k < N; k++) z[k] -= loss[k];
    // Water, faster in the joints.
    if (o.fluvialK > 0) {
      const { n: m } = routeFlow(f, rec, stack);
      drainageArea(f, rec, stack, m, area);
      for (let s = 0; s < m; s++) {
        const k = stack[s];
        const r = rec[k];
        if (r === k) continue;
        const ki = k % n;
        const ri = r % n;
        const d = stepM * Math.hypot(ki - ri, (k - ki) / n - (r - ri) / n);
        // Only up on the range: the low ground is under soil and till, and
        // fine-grid water on it rules the plain with parallel rills.
        const F = (o.fluvialK * erod[k] * alpine[k] * Math.pow(area[k], o.m) * o.years) / d;
        if (z[k] > z[r]) z[k] = (z[k] + F * z[r]) / (1 + F);
      }
    }
    // Gravity, to each cell's own angle.
    massWaste(f, { critTan, passes: o.wastePasses });
  }
  let cut = 0;
  for (let k = 0; k < N; k++) if (before[k] - z[k] > cut) cut = before[k] - z[k];
  f.detail = { maxCutM: cut, weak, stepMM: o.stepMM };
  return f;
}
