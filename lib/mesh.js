// mesh.js — a height field closed into a solid.
//
// The whole surface, the four walls and the underside, built so that every
// edge is used by exactly two triangles. That is not a nicety: a slicer given
// a mesh with an unpaired edge will either refuse it or silently fill
// something that was meant to be a channel, and a channel that fills is the
// one defect this project cannot ship.
//
// The underside is a fan from the centre out to EVERY boundary node, not a
// pair of corner-to-corner triangles. Two triangles would leave the wall
// bottoms meeting the underside at T-junctions -- geometrically coincident,
// topologically unpaired -- which is exactly the kind of mesh that looks
// right in a viewer and fails in a slicer.

/** A growable triangle buffer, flat Float32 xyz per vertex. */
export class TriBuilder {
  constructor() { this.tris = []; }
  tri(a, b, c) { this.tris.push(a, b, c); }
  get count() { return this.tris.length / 3; }
  toArray() {
    const out = new Float32Array(this.tris.length * 3);
    for (let i = 0; i < this.tris.length; i++) {
      out[i * 3] = this.tris[i][0];
      out[i * 3 + 1] = this.tris[i][1];
      out[i * 3 + 2] = this.tris[i][2];
    }
    return out;
  }
}

/**
 * Close a local height field (mm, z measured from the tile base) into a
 * solid standing on z = 0.
 */
/**
 * Where a bore goes through a tile, as grid indices and a circle.
 *
 * A round hole through a height-field mesh is the one piece of geometry
 * here that cannot be done by moving vertices up and down, so it gets a
 * construction of its own. A whole block of grid cells is REMOVED, leaving
 * a rectangular hole whose corners are exact grid vertices, and the gap
 * between that rectangle and the circle is stitched as an annulus. Both
 * loops are closed and both are walked by bearing about the bore's axis, so
 * the stitch cannot tangle however the counts differ.
 *
 * The alternative -- clipping each straddling cell against the circle --
 * means marching squares, a different case per cell, and three chances per
 * cell to leave an unpaired edge. This way the only new vertices are on the
 * circle, and they are shared by the top, the wall and the underside
 * because all three are built from the same list.
 */
function boreBlock(bore, nx, ny, step) {
  const R = bore.rMM + step * 1.5; // clear of the circle by a cell and a half
  const i0 = Math.max(1, Math.floor((bore.x - R) / step));
  const i1 = Math.min(nx - 2, Math.ceil((bore.x + R) / step));
  const j0 = Math.max(1, Math.floor((bore.y - R) / step));
  const j1 = Math.min(ny - 2, Math.ceil((bore.y + R) / step));
  return { i0, i1, j0, j1, ok: i1 > i0 + 1 && j1 > j0 + 1 };
}

/** The ring of grid vertices around a removed block, counter-clockwise. */
function blockRing(b) {
  const ring = [];
  for (let i = b.i0; i < b.i1; i++) ring.push([i, b.j0]);
  for (let j = b.j0; j < b.j1; j++) ring.push([b.i1, j]);
  for (let i = b.i1; i > b.i0; i--) ring.push([i, b.j1]);
  for (let j = b.j1; j > b.j0; j--) ring.push([b.i0, j]);
  return ring;
}

/**
 * Join two closed loops of different lengths into a band of triangles.
 *
 * Both are walked by bearing about a shared centre, advancing whichever is
 * behind. Every vertex of both loops is used exactly once and every edge
 * ends up in exactly two triangles, which is the property the whole mesh
 * depends on.
 */
function stitchLoops(tb, outer, inner, cx, cy, flip) {
  const ang = (p) => {
    const a = Math.atan2(p[1] - cy, p[0] - cx);
    return a < 0 ? a + Math.PI * 2 : a;
  };
  const no = outer.length;
  const ni = inner.length;
  // Start both loops at the same bearing so the band does not begin twisted.
  const startOf = (loop) => {
    let best = 0;
    let bestA = Infinity;
    for (let k = 0; k < loop.length; k++) {
      const a = ang(loop[k]);
      if (a < bestA) { bestA = a; best = k; }
    }
    return best;
  };
  const so = startOf(outer);
  const si = startOf(inner);
  let io = 0;
  let ii = 0;
  const tri = (a, b, c) => (flip ? tb.tri(a, c, b) : tb.tri(a, b, c));
  while (io < no || ii < ni) {
    const o0 = outer[(so + io) % no];
    const i0 = inner[(si + ii) % ni];
    const takeOuter = ii >= ni || (io < no && (io + 1) / no <= (ii + 1) / ni);
    if (takeOuter) {
      const o1 = outer[(so + io + 1) % no];
      tri(o0, o1, i0);
      io++;
    } else {
      const i1 = inner[(si + ii + 1) % ni];
      tri(o0, i1, i0);
      ii++;
    }
  }
}

/**
 * Close a local height field (mm, z measured from the tile base) into a
 * solid standing on z = 0, optionally with vertical bores through it.
 */
export function meshTile(local, { floorZ = 0, floor = null, bores = [], boreSegments = 48 } = {}) {
  const { nx, ny, step } = local;
  const z = local.values;
  const tb = new TriBuilder();
  // The underside is not always flat. A key recess is material taken out
  // from below, which raises the bottom surface over the recess -- so the
  // floor is a height field in its own right whenever one is given.
  const flatFloor = !floor;
  const floorAt = flatFloor ? () => floorZ : (i, j) => floor[j * nx + i];
  const P = (i, j) => [i * step, j * step, z[j * nx + i]];
  const B = (i, j) => [i * step, j * step, floorAt(i, j)];

  // Which cells the bores take out. A cell is indexed by its lower-left
  // vertex, so cell (i, j) is removed when i0 <= i < i1 and likewise in j.
  const blocks = [];
  for (const bore of bores) {
    const b = boreBlock(bore, nx, ny, step);
    if (b.ok) blocks.push({ ...b, bore });
  }
  const removed = blocks.length
    ? (i, j) => blocks.some((b) => i >= b.i0 && i < b.i1 && j >= b.j0 && j < b.j1)
    : () => false;

  // --- top surface ---
  for (let j = 0; j < ny - 1; j++) {
    for (let i = 0; i < nx - 1; i++) {
      if (removed(i, j)) continue;
      const p00 = P(i, j), p10 = P(i + 1, j), p11 = P(i + 1, j + 1), p01 = P(i, j + 1);
      tb.tri(p00, p10, p11);
      tb.tri(p00, p11, p01);
    }
  }

  // --- the boundary ring, counter-clockwise seen from above ---
  const ring = [];
  for (let i = 0; i < nx - 1; i++) ring.push([i, 0]);
  for (let j = 0; j < ny - 1; j++) ring.push([nx - 1, j]);
  for (let i = nx - 1; i > 0; i--) ring.push([i, ny - 1]);
  for (let j = ny - 1; j > 0; j--) ring.push([0, j]);

  // --- walls ---
  for (let k = 0; k < ring.length; k++) {
    const [ai, aj] = ring[k];
    const [bi, bj] = ring[(k + 1) % ring.length];
    const aT = P(ai, aj), bT = P(bi, bj), aB = B(ai, aj), bB = B(bi, bj);
    tb.tri(aB, bB, bT);
    tb.tri(aB, bT, aT);
  }

  // --- underside ---
  if (!blocks.length && flatFloor) {
    // Fanned to every boundary node so nothing is a T-junction.
    const centre = [((nx - 1) * step) / 2, ((ny - 1) * step) / 2, floorZ];
    for (let k = 0; k < ring.length; k++) {
      const [ai, aj] = ring[k];
      const [bi, bj] = ring[(k + 1) % ring.length];
      tb.tri(centre, B(bi, bj), B(ai, aj));
    }
  } else {
    // A fan from the middle is only good for a flat floor with nothing
    // through it: it would cross a bore, and it cannot follow a recess. So
    // the underside is meshed as a grid instead, skipping the same cells
    // the top skipped.
    for (let j = 0; j < ny - 1; j++) {
      for (let i = 0; i < nx - 1; i++) {
        if (removed(i, j)) continue;
        const p00 = B(i, j), p10 = B(i + 1, j), p11 = B(i + 1, j + 1), p01 = B(i, j + 1);
        tb.tri(p00, p11, p10);
        tb.tri(p00, p01, p11);
      }
    }
  }

  // --- the bores themselves ---
  for (const b of blocks) {
    const { x, y, rMM } = b.bore;
    const outerIdx = blockRing(b);
    const outerTop = outerIdx.map(([i, j]) => P(i, j));
    const outerBot = outerIdx.map(([i, j]) => B(i, j));
    const innerTop = [];
    const innerBot = [];
    for (let k = 0; k < boreSegments; k++) {
      const a = (2 * Math.PI * k) / boreSegments;
      const px = x + rMM * Math.cos(a);
      const py = y + rMM * Math.sin(a);
      // The lip of the bore follows the ground, sampled at the circle.
      const gi = Math.min(nx - 1, Math.max(0, Math.round(px / step)));
      const gj = Math.min(ny - 1, Math.max(0, Math.round(py / step)));
      innerTop.push([px, py, z[gj * nx + gi]]);
      innerBot.push([px, py, flatFloor ? floorZ : floorAt(gi, gj)]);
    }
    // Top annulus faces up; the underside one faces down.
    stitchLoops(tb, outerTop, innerTop, x, y, false);
    stitchLoops(tb, outerBot, innerBot, x, y, true);
    // And the shaft. Its outward normal points INTO the hole, because the
    // solid is on the outside of it.
    for (let k = 0; k < boreSegments; k++) {
      const a = innerTop[k];
      const bb = innerTop[(k + 1) % boreSegments];
      const aB = innerBot[k];
      const bB = innerBot[(k + 1) % boreSegments];
      tb.tri(aB, a, bb);
      tb.tri(aB, bb, bB);
    }
  }

  return tb.toArray();
}

/**
 * Is this mesh closed? Counts how many triangles use each undirected edge;
 * a closed surface uses every one exactly twice.
 *
 * Vertices are keyed on their coordinates rounded to a micron, because two
 * triangles that share an edge arrive at its endpoints by different
 * arithmetic and will not agree to the last bit.
 */
export function checkWatertight(tris) {
  const edges = new Map();
  const key = (x, y, z) => `${Math.round(x * 1000)},${Math.round(y * 1000)},${Math.round(z * 1000)}`;
  const n = tris.length / 9;
  for (let t = 0; t < n; t++) {
    const o = t * 9;
    const v = [
      key(tris[o], tris[o + 1], tris[o + 2]),
      key(tris[o + 3], tris[o + 4], tris[o + 5]),
      key(tris[o + 6], tris[o + 7], tris[o + 8]),
    ];
    for (let e = 0; e < 3; e++) {
      const a = v[e];
      const b = v[(e + 1) % 3];
      const k = a < b ? `${a}|${b}` : `${b}|${a}`;
      edges.set(k, (edges.get(k) || 0) + 1);
    }
  }
  let unpaired = 0;
  let overused = 0;
  for (const count of edges.values()) {
    if (count === 1) unpaired++;
    else if (count > 2) overused++;
  }
  return { triangles: n, edges: edges.size, unpaired, overused, watertight: unpaired === 0 && overused === 0 };
}

export function boundingBox(tris) {
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < tris.length; i += 3) {
    for (let a = 0; a < 3; a++) {
      if (tris[i + a] < lo[a]) lo[a] = tris[i + a];
      if (tris[i + a] > hi[a]) hi[a] = tris[i + a];
    }
  }
  return { lo, hi, size: [hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]] };
}
