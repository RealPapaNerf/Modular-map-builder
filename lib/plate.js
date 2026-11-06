// plate.js — the spacer plate a module stands on.
//
// WHY A PLATE. A module hands its water over one class lower than it took
// it in, so each module downstream stands a step lower -- or, read the other
// way, the modules upstream stand on stacks of plates that make up the
// difference. A plate is the module's footprint by one of a short ladder of
// heights, and a stack of them is what lines two channel floors up. It
// locks to whatever stands beside it at the same level with the same cam
// locks a module has, and it registers to what stands on it and under it
// with sockets in both faces and a loose PIN in each, so a stack is one
// piece and not a pile.
//
// A MILK CARTON, NOT A BRICK. A 200 x 200 x 50 block is a day of printing
// and a kilo of plastic; what carries the load is a skin and some ribs. So
// the plate is an OPEN-BOTTOM shell: a 2 mm top skin, 2.4 mm outer walls,
// 1.6 mm ribs on a 40 mm grid, and solid blocks only where something has to
// hold -- the corners, for the sockets, and under each lock
// feature, for the key's T-slot and the cam's bore. Every surface is a
// height field seen from one side or the other, so printed upside down,
// top skin on the bed, the shell needs no support. The top is one field
// (flat, with a socket sunk in each corner) and the UNDERSIDE is meshTile's
// `floor` field: `heightMM - skinMM` over the hollow cells, 0 under anything
// solid, and the recesses and sockets cut up into the solid from below.
// The first version stood studs on the top, and printed upside down the
// plate stood on its studs with the skin 2.5 mm off the bed. So the
// registration is a pin instead: a socket in each face, the same four
// places a module's underside has them, and a short loose pin that goes in
// two of them. Nothing stands proud of either face.
//
// HOLES FOR THE TUBE. A fountain's tube comes up through every plate in a
// stack, and a plate does not know where the spring above it is. So the top
// skin is drilled on a 20 mm grid -- 16 mm holes, centres at 10, 30, 50 ...
// -- and a 12.7 mm tube anywhere on that grid goes straight down the stack.
// Over the hollow a hole is a 2 mm hole in the skin; over a block it is a
// bore the full height, which is what a drill would do too. A hole that
// would break into a lock feature, a cam's bore, or a socket is left
// out and reported.
//
// THE GRID. Half a millimetre by default, finer than a module's, for a
// reason that lives in mesh.js: a bore takes out a block of cells a cell
// and a half clear of its circle, the nodes inside that block are gone from
// the mesh, and two blocks that overlap cannot be stitched. So a hole has
// to go whenever its BLOCK, not just its circle, would swallow a socket or
// a recess or run into a cam's block. At 1 mm the blocks of the holes
// either side of a cam overlap the cam's by one column and six holes a
// side go instead of two; at 0.5 mm they just clear. A plate at 1 mm is
// still closed; it just has fewer holes.

import { makeField } from './field.js';
import { meshTile } from './mesh.js';
import { lockSettings, edgeLocks, edgeFrame, cutLockFeatures, cutSockets } from './joint.js';

export const PLATE_DEFAULTS = {
  heightMM: 20,
  skinMM: 2, // the top skin
  wallMM: 2.4, // the outer walls
  ribMM: 1.6, // the stiffening ribs,
  ribPitchMM: 40, // on this grid, both ways
  holePitchMM: 20, // the tube holes' grid: centres at half a pitch, then every pitch
  holeMM: 16, // their diameter: a 12.7 mm tube, and room to be off by a little
  blockMM: 30, // the solid block in each corner, for the sockets
  lockBlockMM: 34, // the solid block under each lock feature: this wide along the side and this far in
  pinGapMM: 0.4, // a pin is this much shorter than the two sockets it joins
  stepMM: 0.5, // the field's grid; see THE GRID above
};
export const PLATE_HEIGHTS = [10, 20, 30, 40, 50];

export function plateSettings(o = {}) {
  return { ...PLATE_DEFAULTS, ...o };
}

/** The corner spots the sockets are cut at, in both faces: the same four cutSockets uses. */
function studSpots(c, l) {
  const T = c.tileMM;
  const s = l.socketInsetMM;
  return [[s, s], [T - s, s], [T - s, T - s], [s, T - s]];
}

const toXY = (f, u, v) => [f.o[0] + f.u[0] * u + f.v[0] * v, f.o[1] + f.u[1] * u + f.v[1] * v];

/** The solid block under one lock feature, as [x0, y0, x1, y1]. */
function lockBlock(c, lk, size) {
  const f = edgeFrame(c, lk.edge);
  const a = toXY(f, lk.uMM - size / 2, 0);
  const b = toXY(f, lk.uMM + size / 2, size);
  return [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[0], b[0]), Math.max(a[1], b[1])];
}

/** Every node inside a rectangle, inclusive of its edges. */
function forNodes(n, step, [x0, y0, x1, y1], fn) {
  const i0 = Math.max(0, Math.ceil(x0 / step - 1e-9));
  const i1 = Math.min(n - 1, Math.floor(x1 / step + 1e-9));
  const j0 = Math.max(0, Math.ceil(y0 / step - 1e-9));
  const j1 = Math.min(n - 1, Math.floor(y1 / step + 1e-9));
  for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) fn(j * n + i, i * step, j * step, i, j);
}

/**
 * The plate as fields: the top (a field whose values are the top surface),
 * the floor (the underside, as meshTile takes it), the bores, and what was
 * placed, left out and refused along the way.
 */
export function plateFields(c, lock = {}, o = {}) {
  const p = plateSettings(o);
  const l = lockSettings(lock);
  const H = p.heightMM;
  const T = c.tileMM;
  if (!(H >= PLATE_HEIGHTS[0])) {
    throw new Error(`A spacer plate is at least ${PLATE_HEIGHTS[0]} mm tall; ${H} mm leaves no room for the skin, the lock recesses and the sockets.`);
  }
  const n = Math.round(T / p.stepMM) + 1;
  const step = T / (n - 1);
  const top = makeField(n, n, step);
  top.values.fill(H);
  const hollow = H - p.skinMM;
  const floor = new Float64Array(n * n).fill(hollow);

  // --- the shell: walls, ribs and the blocks, all solid to the base ---
  const w = p.wallMM;
  const rects = [[0, 0, w, T], [T - w, 0, T, T], [0, 0, T, w], [0, T - w, T, T]];
  for (let s = p.ribPitchMM; s < T - 1e-9; s += p.ribPitchMM) {
    rects.push([s - p.ribMM / 2, 0, s + p.ribMM / 2, T], [0, s - p.ribMM / 2, T, s + p.ribMM / 2]);
  }
  const b = p.blockMM;
  rects.push([0, 0, b, b], [T - b, 0, T, b], [T - b, T - b, T, T], [0, T - b, b, T]);
  const locks = edgeLocks(c, l);
  for (const lk of locks) rects.push(lockBlock(c, lk, p.lockBlockMM));
  for (const r of rects) forNodes(n, step, r, (k) => { floor[k] = 0; });

  // --- the lock features, cut up into the blocks from below ---
  // The holes are not handed in as bores to keep clear of: the plate keeps
  // them clear itself, below, and cutLockFeatures' margin round a cam also
  // allows for a terrace blend, which a flat top has no use for.
  const solid = Float64Array.from(floor);
  const cut = cutLockFeatures(top, c, locks, l, [], { topAt: () => H, floor });
  const camBores = cut.bores;

  // --- sockets in the corner blocks, in the underside and in the top ---
  const spots = l.enabled && l.socketMM > 0 ? studSpots(c, l) : [];
  const sockets = cutSockets(top, c, l, floor, camBores);
  const socketR = l.socketMM / 2 + l.clearanceMM;
  for (const [sx, sy] of spots) {
    forNodes(n, step, [sx - socketR, sy - socketR, sx + socketR, sy + socketR], (k, x, y) => {
      if (Math.hypot(x - sx, y - sy) <= socketR) top.values[k] = H - l.socketDepthMM;
    });
  }

  // Every node a recess, an entry channel or a socket has changed:
  // the things a tube hole may not break into.
  const feature = new Uint8Array(n * n);
  for (let k = 0; k < feature.length; k++) if (floor[k] !== solid[k] || top.values[k] !== H) feature[k] = 1;
  const named = [
    ...locks.map((lk) => ({ name: `the ${lk.id} recess`, at: toXY(edgeFrame(c, lk.edge), lk.uMM, l.camInsetMM / 2) })),
    ...spots.map((at, i) => ({ name: `socket ${i + 1}`, at })),
  ];
  const nearest = (x, y) => named.reduce((best, f) => (Math.hypot(f.at[0] - x, f.at[1] - y) < Math.hypot(best.at[0] - x, best.at[1] - y) ? f : best)).name;

  // --- the tube holes ---
  const holeR = p.holeMM / 2;
  const clearMM = 1; // plastic a hole keeps from anything it must not break into
  // The block of cells meshTile takes out for a bore, exactly as it works it out.
  const blockOf = (x, y, r) => {
    const R = r + step * 1.5;
    return {
      i0: Math.max(1, Math.floor((x - R) / step)), i1: Math.min(n - 2, Math.ceil((x + R) / step)),
      j0: Math.max(1, Math.floor((y - R) / step)), j1: Math.min(n - 2, Math.ceil((y + R) / step)),
    };
  };
  const overlap = (a, bb) => a.i0 < bb.i1 && bb.i0 < a.i1 && a.j0 < bb.j1 && bb.j0 < a.j1;
  const conflict = (x, y) => {
    const hb = blockOf(x, y, holeR);
    for (const cb of camBores) {
      if (Math.hypot(x - cb.x, y - cb.y) < holeR + cb.rMM + clearMM || overlap(hb, blockOf(cb.x, cb.y, cb.rMM))) {
        return `it would break into the ${cb.lock} bore`;
      }
    }
    const reach = holeR + clearMM;
    const i0 = Math.min(hb.i0, Math.max(0, Math.floor((x - reach) / step)));
    const i1 = Math.max(hb.i1, Math.min(n - 1, Math.ceil((x + reach) / step)));
    const j0 = Math.min(hb.j0, Math.max(0, Math.floor((y - reach) / step)));
    const j1 = Math.max(hb.j1, Math.min(n - 1, Math.ceil((y + reach) / step)));
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        if (!feature[j * n + i]) continue;
        const inBlock = i >= hb.i0 && i <= hb.i1 && j >= hb.j0 && j <= hb.j1;
        if (inBlock || Math.hypot(i * step - x, j * step - y) <= reach) return `it would break into ${nearest(i * step, j * step)}`;
      }
    }
    return null;
  };
  const holes = [];
  const holesSkipped = [];
  for (let y = p.holePitchMM / 2; y < T; y += p.holePitchMM) {
    for (let x = p.holePitchMM / 2; x < T; x += p.holePitchMM) {
      const why = conflict(x, y);
      if (why) holesSkipped.push({ x, y, why });
      else holes.push({ x, y });
    }
  }

  let hollowNodes = 0;
  for (const v of floor) if (v === hollow) hollowNodes++;

  return {
    top,
    floor,
    bores: [...camBores, ...holes.map((h) => ({ x: h.x, y: h.y, rMM: holeR, hole: true }))],
    holes,
    holesSkipped,
    locks: { placed: cut.placed, refused: cut.refused },
    pins: spots,
    pinMM: l.socketMM - 2 * l.clearanceMM,
    sockets,
    heightMM: H,
    tileMM: T,
    hollowFraction: hollowNodes / floor.length,
    settings: p,
  };
}

/** The plate as a closed solid, standing on z = 0, flat on both faces. */
export function plateSolid(c, lock = {}, o = {}) {
  const f = plateFields(c, lock, o);
  return meshTile(f.top, { floor: f.floor, bores: f.bores });
}

/** One line describing a plate, for the CLI and the report. */
export function describePlate(p) {
  const locks = p.locks.placed.length + p.locks.refused.length;
  const refused = p.locks.refused.length ? ` (${p.locks.refused.length} refused)` : '';
  const skipped = p.holesSkipped.length ? ` (${p.holesSkipped.length} left out round the locks and sockets)` : '';
  return `spacer plate ${p.heightMM} mm: ${p.tileMM} x ${p.tileMM} mm, ${Math.round(p.hollowFraction * 100)}% hollow, `
    + `${p.holes.length} tube holes${skipped}, ${p.locks.placed.length}/${locks} lock features${refused}, `
    + `${p.sockets.placed.length + p.pins.length} sockets for ${p.pins.length} pins`;
}

/**
 * The pin that registers one plate to the next, or a module to the plate
 * under it: a cylinder a slip fit in two sockets, a little shorter than
 * both, so the faces meet before the pin bottoms. Printed standing up.
 */
export function pinSolid(lock = {}, o = {}, segments = 40) {
  const l = lockSettings(lock);
  const p = plateSettings(o);
  const r = l.socketMM / 2 - l.clearanceMM;
  const h = 2 * l.socketDepthMM - p.pinGapMM;
  const out = [];
  const ring = (z) => Array.from({ length: segments }, (_, k) => [r * Math.cos((2 * Math.PI * k) / segments), r * Math.sin((2 * Math.PI * k) / segments), z]);
  const lo = ring(0);
  const hi = ring(h);
  for (let k = 0; k < segments; k++) {
    const k2 = (k + 1) % segments;
    out.push([0, 0, h], hi[k], hi[k2]);
    out.push([0, 0, 0], lo[k2], lo[k]);
    out.push(lo[k], lo[k2], hi[k2]);
    out.push(lo[k], hi[k2], hi[k]);
  }
  const arr = new Float32Array(out.length * 3);
  out.forEach((v, i) => { arr[i * 3] = v[0]; arr[i * 3 + 1] = v[1]; arr[i * 3 + 2] = v[2]; });
  return arr;
}

/** Several pins in a row. */
export function pinSheet(count, lock = {}, o = {}) {
  const one = pinSolid(lock, o);
  const pitch = lockSettings(lock).socketMM + 4;
  const out = new Float32Array(one.length * count);
  for (let k = 0; k < count; k++) for (let i = 0; i < one.length; i += 3) {
    out[k * one.length + i] = one[i] + (k % 6) * pitch;
    out[k * one.length + i + 1] = one[i + 1] + Math.floor(k / 6) * pitch;
    out[k * one.length + i + 2] = one[i + 2];
  }
  return out;
}
