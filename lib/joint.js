// joint.js — the dog-bone keys that hold neighbouring tiles together.
//
// A seam butts on nothing. Two tiles sitting side by side on a table slide
// apart the moment a child leans on them, and a river that was lined up to
// a hundredth of a millimetre is then a river with a step in it. So every
// seam gets a key: a flat dog-bone -- a wide pad in each tile joined by a
// narrow neck across the seam -- dropped into a recess cut in the UNDERSIDE
// of the two plates. The map face above it is untouched.
//
// Pulling the tiles apart would mean dragging a pad through the neck, so the
// seam cannot open, and the pads register the two tiles in every direction
// at once.
//
// SQUARE SHOULDERS, NOT A DOVETAIL. They hold the same -- it is the neck
// being narrower than the pad that locks, not the angle -- and they print
// without feather edges. A dovetail would in any case only work along one
// axis, and a tile in the middle of a grid has seams on four sides; you
// cannot slide it in from four directions at once.
//
// NOT GLUED, which is where this parts company with relief. relief keys a
// seam at 0.15 mm and glues it, because a wall map is assembled once. This
// one comes apart on the table every time it is played with, so the fit is a
// slip fit and the key is a loose part you drop in. The clearance is the
// whole difference between a map you can put away and a map you have built.
//
// ONLY BETWEEN TILES AT THE SAME PLATE LEVEL. Two tiles one plate apart have
// undersides 10 mm apart and cannot share anything cut into them. Every level
// change on a map is along the river -- that is what the plate stack IS -- so
// those seams are registered by the stack underneath instead, and the keys
// hold the flat ground either side of it.

import { EDGES, OPPOSITE, STEP, columnLabel } from './contract.js';

export const JOINT_DEFAULTS = {
  enabled: true,
  padMM: 20, // the wide pad, measured along the seam
  neckMM: 9, // the narrow neck at the seam, along the seam
  reachMM: 14, // how far the pad reaches into each tile past the neck
  neckReachMM: 5, // how far the neck runs either side of the seam
  depthMM: 3, // how deep into the underside the recess goes
  clearanceMM: 0.35, // a slip fit: this is a joint that comes apart
  spacingMM: 120, // roughly one key per this much seam
  minFloorMM: 1.6, // plate that must remain above a recess
};

export function jointSettings(o = {}) {
  const j = { ...JOINT_DEFAULTS, ...o };
  // A neck as wide as its pad is a plain spline and locks nothing, so it is
  // held below the pad whatever was asked for.
  j.neckMM = Math.min(j.neckMM, j.padMM * 0.75);
  return j;
}

/**
 * Where a point on a tile edge is, in tile-local millimetres.
 *
 * `u` runs along the seam and `v` in from it. The directions match the ones
 * edgeProfile uses, which is what makes a key at `u` on A's east edge land
 * at `tileMM - u` on B's west edge -- the two halves of one dog-bone.
 */
export function edgeFrame(c, edge) {
  const T = c.tileMM;
  switch (edge) {
    case 'S': return { o: [0, 0], u: [1, 0], v: [0, 1] };
    case 'N': return { o: [T, T], u: [-1, 0], v: [0, -1] };
    case 'W': return { o: [0, T], u: [0, -1], v: [1, 0] };
    case 'E': return { o: [T, 0], u: [0, 1], v: [-1, 0] };
    default: throw new Error(`unknown edge ${edge}`);
  }
}
const toXY = (f, u, v) => [f.o[0] + f.u[0] * u + f.v[0] * v, f.o[1] + f.u[1] * u + f.v[1] * v];

/**
 * Which seams get keys, and where along them.
 *
 * Each seam is visited once, from the tile on its north or east side, so a
 * key is planned once and both halves come from the same numbers.
 */
export function planKeys(tiles, levels, c, o = {}) {
  const j = jointSettings(o);
  if (!j.enabled) return [];
  const keys = [];
  for (const t of tiles.values()) {
    for (const e of ['N', 'E']) {
      const [dc, dr] = STEP[e];
      const nb = tiles.get(`${t.col + dc},${t.row + dr}`);
      if (!nb) continue;
      const la = levels.get(`${t.col},${t.row}`) ?? 0;
      const lb = levels.get(`${nb.col},${nb.row}`) ?? 0;
      if (la !== lb) continue; // undersides are a plate apart; nothing to key

      const n = Math.max(1, Math.round(c.tileMM / j.spacingMM));
      for (let k = 0; k < n; k++) {
        const u = (c.tileMM * (k + 1)) / (n + 1);
        keys.push({
          id: `${columnLabel(t.col)}${t.row + 1}-${e}-${k + 1}`,
          a: { col: t.col, row: t.row, edge: e, uMM: u },
          b: { col: nb.col, row: nb.row, edge: OPPOSITE[e], uMM: c.tileMM - u },
          level: la,
        });
      }
    }
  }
  return keys;
}

/** Is (u, v) inside one tile's half of a dog-bone centred on uCentre? */
function inHalfKey(j, du, v, grow) {
  const hp = j.padMM / 2 + grow;
  const hn = j.neckMM / 2 + grow;
  const nr = j.neckReachMM + grow;
  const far = j.neckReachMM + j.reachMM + grow;
  if (v < -grow || v > far) return false;
  if (v <= nr) return Math.abs(du) <= hn;
  return Math.abs(du) <= hp;
}

/**
 * Cut the recesses for a tile's keys into its underside.
 *
 * Returns the floor field to mesh with, and which keys were refused.
 *
 * A key is left out WHOLE or not at all. Cutting it short where the plate
 * runs thin -- under a river channel, under a lake bed, beside a bore --
 * would leave a recess a key cannot sit in, which is worse than no recess:
 * the tile would rock. relief makes the same call for the same reason.
 */
export function cutRecesses(local, c, tileKeys, o = {}, bores = []) {
  const j = jointSettings(o);
  const { nx, ny, step } = local;
  const z = local.values;
  const floor = new Float64Array(nx * ny);
  const placed = [];
  const refused = [];

  for (const tk of tileKeys) {
    const f = edgeFrame(c, tk.edge);
    const grow = j.clearanceMM;
    const reach = j.neckReachMM + j.reachMM + grow;
    const halfW = j.padMM / 2 + grow;

    // Walk only the cells the key could possibly touch.
    const corners = [
      toXY(f, tk.uMM - halfW, 0), toXY(f, tk.uMM + halfW, 0),
      toXY(f, tk.uMM - halfW, reach), toXY(f, tk.uMM + halfW, reach),
    ];
    const xs = corners.map((p) => p[0]);
    const ys = corners.map((p) => p[1]);
    const i0 = Math.max(0, Math.floor(Math.min(...xs) / step));
    const i1 = Math.min(nx - 1, Math.ceil(Math.max(...xs) / step));
    const j0 = Math.max(0, Math.floor(Math.min(...ys) / step));
    const j1 = Math.min(ny - 1, Math.ceil(Math.max(...ys) / step));

    const cells = [];
    let thinnest = Infinity;
    for (let jj = j0; jj <= j1; jj++) {
      for (let ii = i0; ii <= i1; ii++) {
        const x = ii * step;
        const y = jj * step;
        // Back into the edge frame.
        const dx = x - f.o[0];
        const dy = y - f.o[1];
        const u = dx * f.u[0] + dy * f.u[1];
        const v = dx * f.v[0] + dy * f.v[1];
        if (!inHalfKey(j, u - tk.uMM, v, grow)) continue;
        const k = jj * nx + ii;
        cells.push(k);
        thinnest = Math.min(thinnest, z[k]);
      }
    }
    if (!cells.length) { refused.push({ ...tk, why: 'off the tile' }); continue; }
    // A recess through a tube bore is not a recess, it is a slot open to
    // the hole. Refused whole, like a thin one.
    const hitsBore = bores.some((b) => {
      const clear = b.rMM + j.clearanceMM + step;
      return cells.some((k) => {
        const ii = k % nx;
        const jj = (k - ii) / nx;
        return Math.hypot(ii * step - b.x, jj * step - b.y) < clear;
      });
    });
    if (hitsBore) { refused.push({ ...tk, why: 'it runs into a tube bore' }); continue; }
    if (thinnest - j.depthMM < j.minFloorMM) {
      refused.push({
        ...tk,
        why: `the plate is only ${thinnest.toFixed(1)} mm there, and a ${j.depthMM} mm recess ` +
             `would leave ${(thinnest - j.depthMM).toFixed(1)} mm`,
      });
      continue;
    }
    for (const k of cells) floor[k] = j.depthMM;
    placed.push(tk);
  }
  return { floor, placed, refused, any: placed.length > 0 };
}

// ---------------------------------------------------------------------------
// The key itself

/** The dog-bone outline, counter-clockwise, centred on the seam. */
export function keyOutline(o = {}) {
  const j = jointSettings(o);
  const g = j.clearanceMM / 2; // the part is this much under the recess
  const hp = j.padMM / 2 - g;
  const hn = j.neckMM / 2 - g;
  const nr = j.neckReachMM;
  const pr = j.reachMM - g;
  return [
    [-hp, -nr - pr], [hp, -nr - pr], [hp, -nr], [hn, -nr],
    [hn, nr], [hp, nr], [hp, nr + pr], [-hp, nr + pr],
    [-hp, nr], [-hn, nr], [-hn, -nr], [-hp, -nr],
  ];
}

/**
 * Ear clipping for a simple polygon.
 *
 * The dog-bone is not convex -- the two shoulders are reflex corners -- so a
 * fan from one vertex would put triangles outside it. Written out because it
 * is thirty lines and the alternative is decomposing the shape into
 * rectangles by hand, which leaves T-junctions where a narrow edge meets a
 * wide one and makes the solid leak.
 */
export function earClip(poly) {
  const n = poly.length;
  const idx = [...Array(n).keys()];
  const area2 = (a, b, c) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  let total = 0;
  for (let i = 0; i < n; i++) total += poly[i][0] * poly[(i + 1) % n][1] - poly[(i + 1) % n][0] * poly[i][1];
  if (total < 0) idx.reverse(); // work counter-clockwise
  const inside = (p, a, b, c) =>
    area2(a, b, p) >= -1e-9 && area2(b, c, p) >= -1e-9 && area2(c, a, p) >= -1e-9;

  const out = [];
  let guard = 0;
  while (idx.length > 3 && guard++ < 10000) {
    let clipped = false;
    for (let k = 0; k < idx.length; k++) {
      const ia = idx[(k + idx.length - 1) % idx.length];
      const ib = idx[k];
      const ic = idx[(k + 1) % idx.length];
      const a = poly[ia];
      const b = poly[ib];
      const cc = poly[ic];
      if (area2(a, b, cc) <= 1e-9) continue; // reflex or degenerate
      let clear = true;
      for (const io of idx) {
        if (io === ia || io === ib || io === ic) continue;
        if (inside(poly[io], a, b, cc)) { clear = false; break; }
      }
      if (!clear) continue;
      out.push([ia, ib, ic]);
      idx.splice(k, 1);
      clipped = true;
      break;
    }
    if (!clipped) break;
  }
  if (idx.length === 3) out.push([idx[0], idx[1], idx[2]]);
  return out;
}

/** The key as a closed solid, lying flat, ready to print a stack of. */
export function keySolid(o = {}) {
  const j = jointSettings(o);
  const poly = keyOutline(j);
  const tris = earClip(poly);
  const h = j.depthMM - j.clearanceMM;
  const out = [];
  const push = (a, b, c) => out.push(a, b, c);
  const T = (p) => [p[0], p[1], h];
  const B = (p) => [p[0], p[1], 0];
  for (const [a, b, c] of tris) {
    push(T(poly[a]), T(poly[b]), T(poly[c]));
    push(B(poly[a]), B(poly[c]), B(poly[b]));
  }
  for (let k = 0; k < poly.length; k++) {
    const a = poly[k];
    const b = poly[(k + 1) % poly.length];
    push(B(a), B(b), T(b));
    push(B(a), T(b), T(a));
  }
  const arr = new Float32Array(out.length * 3);
  for (let i = 0; i < out.length; i++) {
    arr[i * 3] = out[i][0]; arr[i * 3 + 1] = out[i][1]; arr[i * 3 + 2] = out[i][2];
  }
  return arr;
}

/** Several keys laid out side by side on one plate. */
export function keySheet(count, o = {}) {
  const j = jointSettings(o);
  const one = keySolid(j);
  const pitch = j.padMM + j.clearanceMM + 4;
  const cols = Math.max(1, Math.floor(Math.sqrt(count)));
  const out = new Float32Array(one.length * count);
  for (let k = 0; k < count; k++) {
    const dx = (k % cols) * pitch;
    const dy = Math.floor(k / cols) * (2 * (j.neckReachMM + j.reachMM) + 6);
    for (let i = 0; i < one.length; i += 3) {
      out[k * one.length + i] = one[i] + dx;
      out[k * one.length + i + 1] = one[i + 1] + dy;
      out[k * one.length + i + 2] = one[i + 2];
    }
  }
  return out;
}

/**
 * The keys that will actually hold: both halves of the pair got a recess.
 *
 * A key needs a recess on each side of the seam. Where one side refused --
 * too little plate under it, a bore in the way -- the other half is a slot
 * with nothing to grip, so the pair is not printable. This is the number to
 * print, and it is not the number planned.
 */
export function usableKeys(result) {
  const tileAt = new Map();
  for (const t of result.tiles) tileAt.set(`${t.spec.col},${t.spec.row}`, t);
  const cut = (end, id) => {
    const t = tileAt.get(`${end.col},${end.row}`);
    return !!t && (t.keys || []).some((x) => x.id === id);
  };
  return (result.keys || []).filter((k) => cut(k.a, k.id) && cut(k.b, k.id));
}
