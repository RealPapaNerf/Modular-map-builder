// tile.js — the one place metres become millimetres.
//
// Everything upstream of here (terrain, glacier, fluvial, hillslope) is real
// metres, because that is the frame the physics is written in. Everything
// downstream (river channels, meshing, STL) is millimetres on the plate.
// Keeping the conversion to a single function is what stops the two frames
// leaking into each other, which is the bug relief's README warns about from
// experience.
//
// WHY EVERY TILE'S EDGE IS FORCED TO THE CONTRACT. The brief for alcoves was
// "modular so the terrain can't go past a tile", and that generalises: a
// piece is only interchangeable if its boundary is a declared profile rather
// than whatever the generator happened to produce there. So the generator is
// free in the middle of a tile and overruled at its rim, with a blend
// between. The map's large-scale shape then comes from the PLATE LEVELS --
// the staircase of 10 mm plates -- and not from terrain running continuously
// across seams. Which is exactly how the printed pieces already work: the
// mountains are tiles standing higher, not a mountain sliced up.

import { makeField, sample, minMax } from './field.js';
import { tileEdgeProfile, EDGES, columnLabel } from './contract.js';

const smoothstep = (t) => { const u = Math.max(0, Math.min(1, t)); return u * u * (3 - 2 * u); };

/**
 * Cut one tile out of the world field and return it as a local height field
 * in millimetres, measured from the tile's own base.
 *
 * world      — the eroded bed, in metres
 * c          — the contract
 * spec       — {col, row, edges}
 * opts.reliefMM     — the vertical range the whole world maps onto
 * opts.meshMM       — grid spacing of the output, in mm on the plate
 */
export function cutTile(world, c, spec, opts = {}) {
  const {
    reliefMM = 40,
    meshMM = 0.8,
    worldMinM = null,
    worldMaxM = null,
    cols = 1,
    rows = 1,
  } = opts;

  const n = Math.max(8, Math.round(c.tileMM / meshMM) + 1);
  const step = c.tileMM / (n - 1);
  const local = makeField(n, n, step, 0, 0);

  const mm = worldMinM !== null && worldMaxM !== null
    ? { min: worldMinM, max: worldMaxM }
    : minMax(world);
  const spanM = Math.max(1e-6, mm.max - mm.min);

  // Where this tile sits in the world, as a fraction of the whole map.
  const wx0 = world.originX + ((spec.col) / cols) * (world.nx - 1) * world.step;
  const wy0 = world.originY + ((spec.row) / rows) * (world.ny - 1) * world.step;
  const wspanX = ((world.nx - 1) * world.step) / cols;
  const wspanY = ((world.ny - 1) * world.step) / rows;

  for (let j = 0; j < n; j++) {
    const y = j * step;
    for (let i = 0; i < n; i++) {
      const x = i * step;
      // Generated terrain, as mm of relief above the land datum. It is NOT
      // yet in agreement with the rim -- conformToContract does that.
      const wx = wx0 + (x / c.tileMM) * wspanX;
      const wy = wy0 + (y / c.tileMM) * wspanY;
      local.values[j * n + i] = c.edgeLandMM + ((sample(world, wx, wy) - mm.min) / spanM) * reliefMM;
    }
  }
  return local;
}

/**
 * Make a tile agree with its contract at the rim, WITHOUT flattening it.
 * Always the last thing done to a tile.
 *
 * THREE WAYS THIS HAS BEEN WRONG, because the third is subtle and the first
 * two look like they work:
 *
 *   1. Blend toward a flat datum near the rim. Every tile came out a plateau
 *      in a picture frame -- the generator rose 40 mm above a rim pinned at
 *      18 and the clamp dug a moat round each piece.
 *   2. Blend toward a Coons patch of the declared edges. Better, and exact at
 *      the rim, but it still OVERWRITES the terrain near the boundary with
 *      the rim surface. When a corner is shared with a tile five plates
 *      higher, that corner sits 50 mm above where this tile's generator put
 *      the ground, and the moat comes straight back -- inverted, as a wall.
 *   3. What it does now: interpolate the DISCREPANCY, not the target.
 *
 * For each edge, take the residual between what the contract declares and
 * what the generator produced along that edge. Build a Coons patch of those
 * four residual curves and ADD it to the whole tile. At the rim the residual
 * is exactly the gap, so the boundary lands exactly on the contract. Inland
 * the correction is a smooth, low-order surface -- a tilt, or a gentle
 * dome -- so the terrain keeps every bit of its own shape and simply leans
 * to meet its neighbours. There is no blend distance to tune and nothing to
 * flatten, because nothing is ever replaced.
 */
export function conformToContract(local, c, spec) {
  const n = local.nx;
  const step = local.step;
  const T = c.tileMM;
  const g = (i, j) => local.values[j * n + i];

  // Residual along each edge, indexed by the node along it.
  const rS = new Float64Array(n);
  const rN = new Float64Array(n);
  const rW = new Float64Array(n);
  const rE = new Float64Array(n);
  for (let k = 0; k < n; k++) {
    const d = k * step;
    rS[k] = tileEdgeProfile(c, spec, 'S', d) - g(k, 0);
    rN[k] = tileEdgeProfile(c, spec, 'N', T - d) - g(k, n - 1);
    rW[k] = tileEdgeProfile(c, spec, 'W', T - d) - g(0, k);
    rE[k] = tileEdgeProfile(c, spec, 'E', d) - g(n - 1, k);
  }
  // Corner residuals, which the bilinear term removes so they are not
  // counted twice.
  // rN is indexed by COLUMN, like rS: rN[0] is the north-west end and
  // rN[n-1] the north-east. Having these two the wrong way round put every
  // tile 0.86 mm off its own contract, which is exactly the size of the
  // difference between its two north corners -- a good reminder that an
  // exactness bug shows up as a small number, not an obvious one.
  const sw = rS[0];
  const se = rS[n - 1];
  const nw = rN[0];
  const ne = rN[n - 1];

  for (let j = 0; j < n; j++) {
    const v = j / (n - 1);
    for (let i = 0; i < n; i++) {
      const u = i / (n - 1);
      const ruled = (1 - u) * rW[j] + u * rE[j] + (1 - v) * rS[i] + v * rN[i];
      const bilinear = (1 - u) * (1 - v) * sw + u * (1 - v) * se + (1 - u) * v * nw + u * v * ne;
      local.values[j * n + i] += ruled - bilinear;
    }
  }
  return local;
}

export function tileLabel(spec) {
  return `${columnLabel(spec.col)}${spec.row + 1}`;
}

/**
 * The stack of plates under a tile, and what is left to print.
 *
 * These are not an optimisation the way relief's riser blocks are. The plates
 * ARE the river's gradient made physical: a tile at level 3 MUST stand on
 * three of them or its inlet does not meet its neighbour's outlet.
 */
export function plateStack(c, level, local) {
  const { min, max } = minMax(local);
  return {
    level,
    plates: level,
    plateMM: c.plateMM,
    standMM: level * c.plateMM,
    printedHeightMM: max,
    lowestMM: min,
    totalHeightMM: level * c.plateMM + max,
  };
}

/**
 * Prove a finished tile honours its contract by measuring the boundary of the
 * thing that will actually be printed, rather than trusting it was built
 * right. Returns the worst disagreement on each edge, in mm.
 *
 * This is the check the whole repo exists to pass. A tile that comes through
 * here at zero mates with every other tile that does.
 */
export function verifyEdges(local, c, spec) {
  const n = local.nx;
  const step = local.step;
  const out = {};
  for (const e of EDGES) {
    let worst = 0;
    for (let k = 0; k < n; k++) {
      const d = k * step;
      let got;
      let want;
      if (e === 'S') { got = local.values[k]; want = tileEdgeProfile(c, spec, 'S', d); }
      else if (e === 'N') { got = local.values[(n - 1) * n + k]; want = tileEdgeProfile(c, spec, 'N', c.tileMM - d); }
      else if (e === 'W') { got = local.values[k * n]; want = tileEdgeProfile(c, spec, 'W', c.tileMM - d); }
      else { got = local.values[k * n + (n - 1)]; want = tileEdgeProfile(c, spec, 'E', d); }
      worst = Math.max(worst, Math.abs(got - want));
    }
    out[e] = worst;
  }
  out.worst = Math.max(...EDGES.map((e) => out[e]));
  return out;
}
