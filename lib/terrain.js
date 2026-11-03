// terrain.js — the starting rock, before anything has eroded it.
//
// This is deliberately NOT where the landforms come from. What is built here
// is a plausible uplifted block: a mountain spine where one was asked for,
// roughness everywhere, and flats where the map says flat. Everything that
// makes terrain read as REAL -- U-shaped valleys, cirques, hanging valleys,
// arêtes, mesa scarps, talus -- is cut out of this afterwards by glacier.js
// and fluvial.js, because those shapes are the signature of a process and
// there is no noise function that fakes them.
//
// Everything in here is real metres. The plate conversion happens in tile.js.

import { makeField, fill, sample, normalize, blur, minMax } from './field.js';
import { fbm, ridged } from './noise.js';

/** Shortest distance from (x, y) to a polyline, and how far along it that is. */
export function distToPolyline(pts, x, y) {
  let best = Infinity;
  let bestT = 0;
  let run = 0;
  let total = 0;
  for (let i = 1; i < pts.length; i++) {
    total += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
  }
  for (let i = 1; i < pts.length; i++) {
    const ax = pts[i - 1].x;
    const ay = pts[i - 1].y;
    const bx = pts[i].x;
    const by = pts[i].y;
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    let t = len2 > 0 ? ((x - ax) * dx + (y - ay) * dy) / len2 : 0;
    t = Math.max(0, Math.min(1, t));
    const px = ax + t * dx;
    const py = ay + t * dy;
    const d = Math.hypot(x - px, y - py);
    if (d < best) {
      best = d;
      bestT = total > 0 ? (run + t * Math.sqrt(len2)) / total : 0;
    }
    run += Math.sqrt(len2);
  }
  return { dist: best, t: bestT };
}

const smoothstep = (t) => {
  const u = Math.max(0, Math.min(1, t));
  return u * u * (3 - 2 * u);
};

/**
 * The uplifted block.
 *
 * spine: [{x, y}] in metres, the crest line of the range, with `heightM` the
 *        peak elevation on it and `widthM` the half-width of the range.
 * flats: [{x, y, radiusM, elevM?}] places the map wants level.
 */
export function baseTerrain(o = {}) {
  const {
    nx = 256,
    ny = 256,
    stepM = 80,
    spine = null,
    spineHeightM = 1400,
    spineWidthM = 4000,
    baseElevM = 200,
    roughness = 0.22,
    roughScaleM = 2600,
    seed = 1,
    flats = [],
  } = o;

  const f = makeField(nx, ny, stepM, 0, 0);
  const spanX = (nx - 1) * stepM;
  const spanY = (ny - 1) * stepM;

  fill(f, (x, y) => {
    let z = baseElevM;

    if (spine && spine.length >= 2) {
      const { dist, t } = distToPolyline(spine, x, y);
      // Across the range: a raised-cosine flank, so the foot eases into the
      // plain instead of meeting it at a crease.
      const across = Math.max(0, 1 - dist / spineWidthM);
      const flank = across * across * (3 - 2 * across);
      // Along the range: the crest rises and falls rather than running level,
      // which is what stops a spine reading as an extruded wall.
      const along = 0.72 + 0.28 * (0.5 + 0.5 * fbm(t * 7, 0, { scale: 1, octaves: 3, seed: seed + 11 }));
      // Ridged noise is what makes an arête. Weighted toward the crest so the
      // flanks stay smooth enough for ice to sit on.
      const crestiness = ridged(x, y, { scale: spineWidthM * 0.55, octaves: 5, seed: seed + 3 });
      z += spineHeightM * flank * along * (0.74 + 0.26 * crestiness);
    }

    // General roughness everywhere, so the plain is not a sheet of glass.
    z += spineHeightM * roughness * fbm(x, y, { scale: roughScaleM, octaves: 6, seed });
    // One long wavelength, to stop the map reading as uniformly busy.
    z += spineHeightM * 0.12 * fbm(x, y, { scale: Math.max(spanX, spanY) * 0.8, octaves: 2, seed: seed + 77 });
    return z;
  });

  for (const flat of flats || []) {
    const elev = Number.isFinite(flat.elevM) ? flat.elevM : sample(f, flat.x, flat.y);
    for (let j = 0; j < ny; j++) {
      const y = j * stepM;
      for (let i = 0; i < nx; i++) {
        const x = i * stepM;
        const d = Math.hypot(x - flat.x, y - flat.y);
        const w = 1 - smoothstep((d - flat.radiusM * 0.6) / (flat.radiusM * 0.4));
        if (w <= 0) continue;
        const k = j * nx + i;
        f.values[k] = f.values[k] * (1 - w) + elev * w;
      }
    }
  }

  blur(f, 1, 1);
  return f;
}

/**
 * A volcano, built rather than simulated.
 *
 * There is nothing to gain from modelling magma: the shape of a stratovolcano
 * is a handful of numbers. A cone at close to the angle of repose, steepening
 * toward the summit because the near-vent deposits are coarser; a crater
 * punched into the top; optionally one wall of it breached, which is what
 * most real cones have and what keeps the thing from reading as a party hat.
 * Then the erosion passes gully it, which is what sells it.
 */
export function addVolcano(f, o = {}) {
  const {
    x, y,
    heightM = 900,
    baseRadiusM = 3500,
    craterRadiusM = 420,
    craterDepthM = 180,
    breachAzimuthDeg = null,
    breachWidthDeg = 55,
    seed = 5,
  } = o;

  for (let j = 0; j < f.ny; j++) {
    const py = f.originY + j * f.step;
    for (let i = 0; i < f.nx; i++) {
      const px = f.originX + i * f.step;
      const dx = px - x;
      const dy = py - y;
      let r = Math.hypot(dx, dy);
      if (r > baseRadiusM * 1.25) continue;

      // Lobed outline: real cones are not surfaces of revolution.
      const az = Math.atan2(dy, dx);
      const lobe = 1 + 0.09 * fbm(Math.cos(az) * 3, Math.sin(az) * 3, { scale: 1, octaves: 3, seed: seed + 2 });
      const R = baseRadiusM * lobe;
      if (r > R) continue;

      const u = r / R;
      // Concave-up flank: steepest near the vent, easing to the apron.
      let h = heightM * Math.pow(1 - u, 1.55);
      // Radial gullies, deepening down the flank where runoff collects.
      h -= heightM * 0.045 * u * (0.5 + 0.5 * ridged(Math.cos(az) * 9, Math.sin(az) * 9, { scale: 1, octaves: 4, seed: seed + 9 }));

      // The crater, with a rim standing slightly proud.
      if (r < craterRadiusM * 1.9) {
        const rim = Math.exp(-Math.pow((r - craterRadiusM * 1.15) / (craterRadiusM * 0.55), 2));
        h += heightM * 0.035 * rim;
        if (r < craterRadiusM) {
          const cu = r / craterRadiusM;
          h -= craterDepthM * (1 - cu * cu);
        }
      }

      // A breached wall: one sector of the rim and upper cone cut away, which
      // is where the flows and the lahars went.
      if (breachAzimuthDeg !== null && r < craterRadiusM * 3.2) {
        const want = (breachAzimuthDeg * Math.PI) / 180;
        let da = Math.abs(((az - want + Math.PI * 3) % (Math.PI * 2)) - Math.PI);
        const halfW = (breachWidthDeg * Math.PI) / 360;
        if (da < halfW) {
          const w = 1 - smoothstep(da / halfW);
          h -= (craterDepthM * 1.3 + heightM * 0.06) * w * smoothstep((craterRadiusM * 3.2 - r) / (craterRadiusM * 1.6));
        }
      }

      const k = j * f.nx + i;
      f.values[k] += Math.max(0, h);
    }
  }
  return f;
}

/**
 * Rock that is not all the same.
 *
 * A mesa is not a shape you draw, it is a CONSEQUENCE: a resistant layer over
 * a weak one. Give the fluvial pass a stack of horizontal beds with different
 * erodibilities and the flat tops, the vertical cliff bands, the talus apron
 * and the detached buttes fall out of it. This returns erodibility as a
 * function of elevation, with a small noise term on the contacts so the
 * benches do not all break at exactly one contour.
 *
 * beds: [{topM, k}] listed top down. `topM` is the elevation of the bed's TOP
 * surface and the bed reaches down to the next one's top, so
 * [{topM:900,k:0.3},{topM:600,k:1.6}] is a resistant cap from 600 to 900 over
 * weak rock below 600. Rock above the highest bed continues as that bed.
 * `k` is relative erodibility: 1 is normal, below 1 resists, above 1 gives way.
 */
export function makeStrata(beds, { seed = 13, wobbleM = 18, wobbleScaleM = 2200 } = {}) {
  if (!beds || !beds.length) return () => 1;
  const sorted = [...beds].sort((a, b) => b.topM - a.topM);
  return (x, y, z) => {
    // A little wander on the contacts, so the benches do not all break along
    // exactly one contour line and read as a machined step.
    const zz = z + wobbleM * fbm(x, y, { scale: wobbleScaleM, octaves: 3, seed });
    for (let i = 0; i < sorted.length; i++) {
      const floor = i + 1 < sorted.length ? sorted[i + 1].topM : -Infinity;
      if (zz > floor) return sorted[i].k;
    }
    return sorted[sorted.length - 1].k;
  };
}
