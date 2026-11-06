// rock.js — how strong the rock is, cell by cell.
//
// WHY. A spire is not a shape anything carves on purpose. Fitz Roy, the
// Grand Teton, the Aiguilles above Chamonix are GRANITE CUT BY JOINTS: two
// families of near-vertical cracks, roughly at right angles, a few hundred
// metres apart. Frost wedges the cracks open, the rock along them falls
// away, and what stands between them stands in walls, because sound granite
// will hold a vertical face hundreds of metres high. Erode a landscape of
// one uniform rock and every slope relaxes to one angle and every summit to
// one rounded shape, which is what this builder did. Give it joints and the
// same erosion leaves towers.
//
// So the rock has a WEAKNESS, 0 for sound rock and 1 for a joint, made of:
//
//   two joint sets   families of straight lines at `jointDeg` and roughly a
//                    right angle to it, spaced `blockM` apart with some
//                    jitter, each a band `jointFrac` of the spacing wide
//   a broad field    some ground is weaker throughout, so not every ridge
//                    turns into a comb
//
// Everything is a pure function of world position (noise.js), so the coarse
// grid the ice runs on and the fine grid of the detail pass see the same
// rock in the same place.
//
// The weakness feeds three things: how steep the rock may stand (strong
// rock to `strongDeg`, a joint to `weakDeg`), how fast running water cuts
// it, and how fast frost takes it apart (detail.js).

import { valueNoise, fbm } from './noise.js';

export const ROCK_DEFAULTS = {
  blockM: 420, // joint spacing: about the size of a tower
  jointFrac: 0.2, // a joint's width as a fraction of the spacing: wide enough to be a few fine cells
  jointDeg: 28, // the first set's bearing, from east; the second is near-perpendicular
  jitter: 0.35, // how far a joint wanders from even spacing, as a fraction of it
  wanderM: 90, // how far a joint line bends along its length
  broad: 0.25, // weight of the broad weak zones
  // Joints are not endless straight lines: each runs for a few blocks and
  // dies out. This is the scale over which a joint comes and goes.
  segmentM: 700,
  broadScaleM: 2400,
  strongDeg: 82, // the steepest sound rock stands
  weakDeg: 40, // and rock along a joint
  // LOW GROUND IS MANTLED. Valley floors and plains are under till, scree
  // and soil, which stands at its own angle whatever the rock beneath it is
  // doing; bare rock walls belong to the range. Without this every strong
  // block on the plain survives as a little cone. Below the `mantleFrom`
  // share of the ground's heights it is soil at `mantleDeg`, above
  // `mantleTo` it is the rock's own angle, blended between.
  mantleDeg: 34,
  mantleFrom: 0.45,
  mantleTo: 0.75,
  seed: 1,
};

const smoothstep = (t) => { const u = Math.max(0, Math.min(1, t)); return u * u * (3 - 2 * u); };

/** Distance from u to the nearest line of one joint set, as a fraction of its spacing. */
function jointDistance(u, spacing, jitter, seed) {
  const k = Math.floor(u / spacing);
  let best = Infinity;
  for (let q = k - 1; q <= k + 2; q++) {
    const at = (q + (valueNoise(q, 0.5, 0, seed) - 0.5) * 2 * jitter) * spacing;
    const d = Math.abs(u - at) / spacing;
    if (d < best) best = d;
  }
  return best;
}

/** The rock's weakness at a world point (metres), 0 sound to 1 a joint. */
export function weaknessAt(x, y, opts = {}) {
  const o = { ...ROCK_DEFAULTS, ...opts };
  let w = 0;
  const sets = [o.jointDeg, o.jointDeg + 90 + 12 * (valueNoise(3, 7, 0, o.seed) - 0.5)];
  sets.forEach((deg, si) => {
    const a = (deg * Math.PI) / 180;
    // Along and across the set; the line wanders a little along its length.
    const along = -x * Math.sin(a) + y * Math.cos(a);
    // fbm is centred on 0, roughly -1..1.
    const across = x * Math.cos(a) + y * Math.sin(a) + o.wanderM * fbm(along, si * 977, { scale: o.blockM * 3, octaves: 3, seed: o.seed + 41 + si });
    const d = jointDistance(across, o.blockM * (si ? 1.15 : 1), o.jitter, o.seed + 17 * (si + 1));
    const present = smoothstep((fbm(x, y, { scale: o.segmentM, octaves: 2, seed: o.seed + 61 + si }) + 0.3) / 0.35);
    w = Math.max(w, (1 - smoothstep(d / o.jointFrac)) * present);
  });
  const broad = fbm(x, y, { scale: o.broadScaleM, octaves: 3, seed: o.seed + 5 });
  return Math.max(0, Math.min(1, w * (1 - o.broad) + o.broad * smoothstep((broad + 0.1) / 0.5)));
}

/** The weakness of every cell of a field, by its world position. */
export function weaknessField(f, opts = {}) {
  const { nx, ny, step, originX = 0, originY = 0 } = f;
  const out = new Float64Array(nx * ny);
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) out[j * nx + i] = weaknessAt(originX + i * step, originY + j * step, opts);
  }
  return out;
}

/**
 * The tangent of the steepest each cell may stand, from its weakness, and
 * -- when the heights are given -- from whether it is low enough to be
 * mantled in soil (see mantleDeg).
 */
export function critTanField(weak, opts = {}, heights = null) {
  const o = { ...ROCK_DEFAULTS, ...opts };
  const out = new Float64Array(weak.length);
  let zFrom = 0;
  let zTo = 0;
  if (heights) {
    const sorted = Float64Array.from(heights).sort();
    const q = (t) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(t * sorted.length)))];
    zFrom = q(o.mantleFrom);
    zTo = Math.max(zFrom + 1e-6, q(o.mantleTo));
  }
  for (let k = 0; k < weak.length; k++) {
    let deg = o.strongDeg + (o.weakDeg - o.strongDeg) * weak[k];
    if (heights) {
      const t = smoothstep((heights[k] - zFrom) / (zTo - zFrom));
      deg = o.mantleDeg + (deg - o.mantleDeg) * t;
    }
    out[k] = Math.tan((deg * Math.PI) / 180);
  }
  return out;
}
