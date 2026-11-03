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
export function meshTile(local, { floorZ = 0 } = {}) {
  const { nx, ny, step } = local;
  const z = local.values;
  const tb = new TriBuilder();
  const P = (i, j) => [i * step, j * step, z[j * nx + i]];
  const B = (i, j) => [i * step, j * step, floorZ];

  // --- top surface ---
  for (let j = 0; j < ny - 1; j++) {
    for (let i = 0; i < nx - 1; i++) {
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

  // --- underside, fanned to every boundary node so nothing is a T-junction ---
  const cx = ((nx - 1) * step) / 2;
  const cy = ((ny - 1) * step) / 2;
  const centre = [cx, cy, floorZ];
  for (let k = 0; k < ring.length; k++) {
    const [ai, aj] = ring[k];
    const [bi, bj] = ring[(k + 1) % ring.length];
    tb.tri(centre, B(bi, bj), B(ai, aj));
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
