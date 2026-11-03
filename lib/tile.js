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
import { tileEdgeProfile, cornersFor, EDGES, columnLabel } from './contract.js';

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
 * opts.blendMM      — how far in from the rim the contract gives way to the generator
 */
export function cutTile(world, c, spec, opts = {}) {
  const {
    reliefMM = 40,
    meshMM = 0.8,
    blendMM = 26,
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
      // Generated terrain, in mm above the tile's land datum.
      const wx = wx0 + (x / c.tileMM) * wspanX;
      const wy = wy0 + (y / c.tileMM) * wspanY;
      local.values[j * n + i] = c.edgeLandMM + ((sample(world, wx, wy) - mm.min) / spanM) * reliefMM;
    }
  }
  return local;
}

/**
 * Force the rim to the declared profile. ALWAYS THE LAST THING DONE to a
 * tile.
 *
 * The first version of this clamped during cutTile and then carved the river
 * afterwards, and every tile with a river came out 4.1 to 4.7 mm off its
 * contract at the boundary -- the carve re-cut a channel that the clamp had
 * already cut, so the banks were taken down twice. Whoever owns the boundary
 * has to own it last, or something later will quietly take it back.
 */
export function clampEdges(local, c, spec, { blendMM = 26 } = {}) {
  const n = local.nx;
  const step = local.step;
  const contractAt = makeContractAt(c, spec, blendMM);
  for (let j = 0; j < n; j++) {
    const y = j * step;
    for (let i = 0; i < n; i++) {
      const x = i * step;
      const con = contractAt(x, y);
      if (!con) continue;
      const k = j * n + i;
      local.values[k] = con.z * con.w + local.values[k] * (1 - con.w);
    }
  }
  return local;
}

/**
 * The declared rim, as a surface.
 *
 * A COONS PATCH over the four edge profiles. The obvious thing -- weight each
 * edge by how near it is and average -- was what the first version did, and
 * it put every tile 0.33 mm off its own contract near the corners: on the
 * south edge, the west edge still had a say, and the average of the two is
 * neither. A Coons patch reproduces all four edge curves EXACTLY and
 * interpolates smoothly between them, so there is nothing to tune and no
 * corner case to get wrong.
 *
 *   F = (1-u)W(y) + uE(y) + (1-v)S(x) + vN(x)
 *       - [ (1-u)(1-v)sw + u(1-v)se + (1-u)v·nw + uv·ne ]
 *
 * The bracketed term is the bilinear surface through the four corners, and
 * subtracting it is what stops each corner being counted twice.
 */
function makeContractAt(c, spec, blendMM) {
  const T = c.tileMM;
  const k = cornersFor(c, spec);
  const S = (x) => tileEdgeProfile(c, spec, 'S', x);
  const N = (x) => tileEdgeProfile(c, spec, 'N', T - x);
  const W = (y) => tileEdgeProfile(c, spec, 'W', T - y);
  const E = (y) => tileEdgeProfile(c, spec, 'E', y);
  return function contractAt(x, y) {
    // How strongly the rim still has a say. The obvious
    //     w = 1 - smoothstep(min(x, T-x, y, T-y) / blend)
    // creases along the tile's diagonals, where which edge is nearest
    // changes, and the first hillshade showed those creases plainly across
    // every corner. This is the same thing written as a smooth union --
    // one minus the chance that NO edge claims the point -- which has no
    // such switch in it.
    const e = (d) => 1 - smoothstep(d / blendMM);
    const w = 1 - (1 - e(x)) * (1 - e(T - x)) * (1 - e(y)) * (1 - e(T - y));
    if (w <= 1e-9) return null;
    const u = x / T;
    const v = y / T;
    const ruled = (1 - u) * W(y) + u * E(y) + (1 - v) * S(x) + v * N(x);
    const bilinear =
      (1 - u) * (1 - v) * k.sw + u * (1 - v) * k.se + (1 - u) * v * k.nw + u * v * k.ne;
    return { z: ruled - bilinear, w };
  };
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
