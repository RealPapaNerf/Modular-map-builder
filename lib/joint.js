// joint.js — the cam lock that holds neighbouring modules together.
//
// A seam butts on nothing. Two modules sitting side by side on a table slide
// apart the moment a child leans on them, and a channel that was lined up to
// a hundredth of a millimetre is then a channel with a step in it. The first
// version dropped a loose dog-bone into the underside; it registered the two
// pieces and locked nothing, because a slip fit cannot pull. This one is a
// CAM LOCK, the kind flat-pack furniture is held together with:
//
//   THE KEY    a flat bar: a wide PAD that sits in a T-slot cut into the
//              underside of module B, a NECK out through B's face, and a
//              round HEAD that sticks out past the face.
//   THE CAM    a cylinder dropped into a round bore in module A, bored from
//              the top of the rim right through to the base. Its bottom few
//              millimetres are hollowed into a spiral: the key's head enters
//              from the side, and a quarter turn with a coin draws the head
//              toward the cam's axis -- and B against A.
//
// EVERY SIDE, THE SAME TWO PLACES. A module is built alone, so the features
// go at fixed distances along every side, measured the same way round: from
// the middle of the side, `offsetMM` along it counter-clockwise is the cam
// housing and `offsetMM` the other way is the key's recess. Walk round two
// modules' shared seam and the directions reverse, so A's cam meets B's key
// and A's key meets B's cam, whichever two modules they are, however they
// are turned. That is what makes the lock part of the contract.
//
// HOW IT GOES TOGETHER. Every key pocket and every cam's entry channel is
// open at the BOTTOM, so modules are LOWERED onto keys lying on the table:
// lay a key with its head in one module's entry channel and lower the next
// module over its pad, or set a key in a module's pocket and lower that
// module beside the other. A module can come down between neighbours on
// two or three sides at once. Then a cam drops into each bore from the top,
// slot pointing at the seam, its open mouth round the head, and a quarter
// turn draws the head in by drawMM -- pulling the key's pad onto the
// shoulder of its pocket, and the faces together with preloadMM to spare.
// The key's pocket is a draw longer than the pad, so it can sit back while
// the cam goes in. The ground over a housing is a small terrace at the
// rim's height, so the cam's top sits flush with it. To take one module out,
// lift its cams and the neighbours' cams on that side: they are loose.
//
// The cam's own solid lives in cam.js. This file is the module's half: where
// the features go, how they are cut into the top and the underside, and the
// key.

import { EDGES, edgeLand } from './contract.js';

export const LOCK_DEFAULTS = {
  enabled: true,
  offsetMM: 50, // the cam at T/2 + this along every side, the key recess at T/2 - this
  camMM: 18, // the cam cylinder's diameter
  camInsetMM: 14, // its axis this far in from the face
  headMM: 7, // the key's head, a disc in plan
  neckMM: 4.5, // the neck, a bar in plan
  padMM: 16, // the pad along the seam
  padReachMM: 10, // and in from the neck
  neckReachMM: 5, // the neck from the face to the pad, inside the key module
  keyThickMM: 4, // the key is this thick; the recesses are this plus a clearance deep
  drawMM: 1.5, // how far the quarter turn pulls the head toward the cam's axis
  seatMM: 3.5, // the head's centre this far from the axis when tight
  clearanceMM: 0.3, // a slip fit round the key, and round the cam in its bore
  preloadMM: 0.2, // how far past touching the turn tries to pull the faces: what makes it TIGHT
  slotWidthMM: 3, // the coin slot
  slotDepthMM: 2.5,
  turnDeg: 90,
  dwellDeg: 10, // the last part of the turn has no draw, so it holds
  entryMM: 9, // the underside channel the head slides along, from the face to the bore
  terraceMM: 3, // flat ground round the bore, beyond its radius
  terraceBlendMM: 8, // and how far past that the ground eases back to itself
  socketMM: 9, // a socket in each corner of the underside, for a spacer plate's stud
  socketDepthMM: 3,
  socketInsetMM: 20, // the sockets' centres this far in from both faces at a corner
  minFloorMM: 1.6, // plate that must remain above a recess
};

export function lockSettings(o = {}) {
  const l = { ...LOCK_DEFAULTS, ...o };
  // A head no wider than its neck is a bar the cam cannot hook. Held.
  l.headMM = Math.max(l.headMM, l.neckMM + 2);
  return l;
}

/** The cam's bore radius: the cam plus its slip fit. */
export const boreRadius = (l) => l.camMM / 2 + l.clearanceMM;
/** The recesses' depth into the underside. */
export const recessDepth = (l) => l.keyThickMM + l.clearanceMM;
/** The head's centre past the faces when the cam is tight and the modules touch. */
export const headSeatMM = (l) => l.camInsetMM - l.seatMM;
/** And where it has to be pushed back to for the cam to go in, open. */
export const headEntryMM = (l) => l.camInsetMM - (l.seatMM + l.drawMM);
/**
 * Head centre to the front of the pad, along the key. The pad's front bears
 * on the shoulder of its pocket (neckReach - clearance into the key module)
 * when the head is seated with the faces touching, less the preload: so the
 * last of the turn pulls the faces together rather than stopping short.
 */
export const keySpanMM = (l) => headSeatMM(l) + (l.neckReachMM - l.clearanceMM) - l.preloadMM;

/**
 * Where a point on a tile edge is, in tile-local millimetres.
 *
 * `u` runs along the seam COUNTER-CLOCKWISE round the module and `v` in from
 * it. Two modules' shared seam is walked in opposite directions by the two,
 * so `u` on A's east edge lands at `tileMM - u` on B's west edge: the cam
 * at T/2 + offset on one meets the key at T/2 - offset on the other.
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
 * The lock features of one module: on every side a cam housing and a key
 * recess, mirrored about the middle, the port between them.
 */
export function edgeLocks(c, o = {}) {
  const l = lockSettings(o);
  if (!l.enabled) return [];
  const out = [];
  const T = c.tileMM;
  for (const e of EDGES) {
    out.push({ id: `${e}-cam`, edge: e, kind: 'cam', uMM: T / 2 + l.offsetMM });
    out.push({ id: `${e}-key`, edge: e, kind: 'key', uMM: T / 2 - l.offsetMM });
  }
  return out;
}

/** Everything wrong with the lock's numbers against a contract. */
export function checkLock(c, o = {}) {
  const l = lockSettings(o);
  const out = [];
  if (!l.enabled) return out;
  const half = c.portWidthMM / 2;
  const widest = Math.max(boreRadius(l), l.padMM / 2 + l.clearanceMM);
  if (l.offsetMM - widest < half + 4) {
    out.push({ severity: 'error', message: `The locks at ${l.offsetMM} mm from the middle of a side run into the ${c.portWidthMM} mm port. Move them out.` });
  }
  if (l.offsetMM + widest > c.tileMM / 2 - l.camInsetMM - boreRadius(l) - 2) {
    out.push({ severity: 'error', message: `The locks at ${l.offsetMM} mm from the middle of a side run into the next side's. Move them in.` });
  }
  if (boreRadius(l) - (l.seatMM + l.headMM / 2 + l.clearanceMM) - l.clearanceMM < 1.2) {
    out.push({ severity: 'warning', message: 'The cam\'s wall outside the seated head is under 1.2 mm: it will not hold. A bigger cam, or a smaller head.' });
  }
  if (l.camInsetMM - boreRadius(l) < 2) {
    out.push({ severity: 'error', message: 'The cam bore breaks through the face of the module. Set it further in.' });
  }
  return out;
}

/* ------------------------------------------------------------- cutting */

/** A tile-local point, back in the edge frame. */
function toUV(f, x, y) {
  const dx = x - f.o[0];
  const dy = y - f.o[1];
  return { u: dx * f.u[0] + dy * f.u[1], v: dx * f.v[0] + dy * f.v[1] };
}

/** Is (u, v) inside the key's recess (the T-slot) centred on u = 0? */
function inRecess(l, du, v) {
  const g = l.clearanceMM;
  const hp = l.padMM / 2 + g;
  const hn = l.neckMM / 2 + g;
  const padFrom = l.neckReachMM - g;
  // Longer than the pad by the draw: the key sits back that far while the
  // cam goes in open, and is drawn forward onto the shoulder as it turns.
  const padTo = l.neckReachMM + l.padReachMM + g + l.drawMM;
  if (v < -1e-9 || v > padTo) return false;
  if (v >= padFrom) return Math.abs(du) <= hp;
  return Math.abs(du) <= hn;
}

/** Is (u, v) inside the cam's entry channel: from the face to the bore's axis? */
function inEntry(l, du, v) {
  return v >= -1e-9 && v <= l.camInsetMM && Math.abs(du) <= l.entryMM / 2;
}

/**
 * Cut the lock features into a module: the recesses and the entry channels
 * into its underside, the terraces into its top, and say where the cam
 * bores go so the mesher can bore them.
 *
 *   local        the height field; its values are the top, and are changed
 *                only under the terraces
 *   c            the contract
 *   locks        from edgeLocks
 *   o            lock settings
 *   bores        bores already in the module (springs), which a feature may
 *                not run into
 *   topAt(edge)  the height the terrace round a cam on this side is held at;
 *                the side's rim by default
 *
 * Returns the floor field to mesh with (0 where the underside is flat, else
 * how far up it is cut), the bores to add, and what was placed and refused.
 *
 * A feature is left out WHOLE or not at all. Cutting a recess short where
 * the plate runs thin would leave a pocket a key cannot sit in, which is
 * worse than no pocket: the module would rock.
 */
export function cutLockFeatures(local, c, locks, o = {}, bores = [], { topAt = null, floor = null } = {}) {
  const l = lockSettings(o);
  const { nx, ny, step } = local;
  const z = local.values;
  const out = floor || new Float64Array(nx * ny);
  const keepClear = new Uint8Array(nx * ny); // the terraces: no tree stands on a cam
  const placed = [];
  const refused = [];
  const newBores = [];
  const depth = recessDepth(l);
  const rimOf = topAt || ((e) => edgeLand(c, e));

  for (const lk of locks) {
    const f = edgeFrame(c, lk.edge);
    const isCam = lk.kind === 'cam';
    // The box of cells the feature could touch.
    const halfW = isCam ? Math.max(boreRadius(l) + l.terraceMM + l.terraceBlendMM, l.entryMM / 2) : l.padMM / 2 + l.clearanceMM;
    const reach = isCam ? l.camInsetMM + boreRadius(l) + l.terraceMM + l.terraceBlendMM : l.neckReachMM + l.padReachMM + l.clearanceMM + l.drawMM;
    const corners = [toXY(f, lk.uMM - halfW, 0), toXY(f, lk.uMM + halfW, 0), toXY(f, lk.uMM - halfW, reach), toXY(f, lk.uMM + halfW, reach)];
    const xs = corners.map((p) => p[0]);
    const ys = corners.map((p) => p[1]);
    const i0 = Math.max(0, Math.floor(Math.min(...xs) / step));
    const i1 = Math.min(nx - 1, Math.ceil(Math.max(...xs) / step));
    const j0 = Math.max(0, Math.floor(Math.min(...ys) / step));
    const j1 = Math.min(ny - 1, Math.ceil(Math.max(...ys) / step));

    const cells = []; // underside cells to cut
    const terrace = []; // [k, weight] top cells to level
    let thinnest = Infinity;
    const [ax, ay] = toXY(f, lk.uMM, l.camInsetMM); // the cam's axis
    const rb = boreRadius(l);
    for (let jj = j0; jj <= j1; jj++) {
      for (let ii = i0; ii <= i1; ii++) {
        const x = ii * step;
        const y = jj * step;
        const { u, v } = toUV(f, x, y);
        const k = jj * nx + ii;
        if (isCam) {
          const d = Math.hypot(x - ax, y - ay);
          if (d <= rb + l.terraceMM + l.terraceBlendMM) {
            const w = d <= rb + l.terraceMM ? 1 : 1 - smoothstep((d - rb - l.terraceMM) / l.terraceBlendMM);
            if (w > 0) terrace.push([k, w]);
          }
          if (inEntry(l, u - lk.uMM, v)) { cells.push(k); if (d > rb) thinnest = Math.min(thinnest, z[k]); }
        } else if (inRecess(l, u - lk.uMM, v)) {
          cells.push(k);
          thinnest = Math.min(thinnest, z[k]);
        }
      }
    }
    if (!cells.length) { refused.push({ ...lk, why: 'off the module' }); continue; }

    // A feature through a tube bore is a slot open to the hole. Refused whole.
    const others = [...bores, ...newBores];
    const clear = (b, x, y, extra) => Math.hypot(x - b.x, y - b.y) < b.rMM + extra + step;
    const hitsBore = others.some((b) => (isCam && clear(b, ax, ay, rb + l.terraceMM))
      || cells.some((k) => clear(b, (k % nx) * step, Math.floor(k / nx) * step, l.clearanceMM)));
    if (hitsBore) { refused.push({ ...lk, why: 'it runs into a tube bore' }); continue; }

    const top = isCam ? rimOf(lk.edge) : thinnest;
    if (top - depth < l.minFloorMM) {
      refused.push({
        ...lk,
        why: `the plate is only ${top.toFixed(1)} mm there, and a ${depth.toFixed(1)} mm recess would leave ${(top - depth).toFixed(1)} mm`,
      });
      continue;
    }
    if (isCam) {
      const want = rimOf(lk.edge);
      for (const [k, w] of terrace) { z[k] += (want - z[k]) * w; keepClear[k] = 1; }
      newBores.push({ x: ax, y: ay, rMM: rb, lock: lk.id });
    }
    for (const k of cells) out[k] = Math.max(out[k], depth);
    placed.push({ ...lk, ...(isCam ? { axisMM: [ax, ay], heightMM: rimOf(lk.edge) } : {}) });
  }
  return { floor: out, bores: newBores, placed, refused, keepClear, any: placed.length > 0 };
}

const smoothstep = (t) => { const u = Math.max(0, Math.min(1, t)); return u * u * (3 - 2 * u); };

/**
 * Sockets in the four corners of the underside, for the studs on top of a
 * spacer plate. Cut into `floor` in place; a corner where the plate is too
 * thin is skipped and reported.
 */
export function cutSockets(local, c, o = {}, floor, bores = []) {
  const l = lockSettings(o);
  const { nx, ny, step } = local;
  const T = c.tileMM;
  const placed = [];
  const refused = [];
  if (!l.enabled || !(l.socketMM > 0)) return { placed, refused };
  const r = l.socketMM / 2 + l.clearanceMM;
  const spots = [[l.socketInsetMM, l.socketInsetMM], [T - l.socketInsetMM, l.socketInsetMM], [T - l.socketInsetMM, T - l.socketInsetMM], [l.socketInsetMM, T - l.socketInsetMM]];
  spots.forEach(([cx, cy], n) => {
    const cells = [];
    let thinnest = Infinity;
    for (let j = Math.max(0, Math.floor((cy - r) / step)); j <= Math.min(ny - 1, Math.ceil((cy + r) / step)); j++) {
      for (let i = Math.max(0, Math.floor((cx - r) / step)); i <= Math.min(nx - 1, Math.ceil((cx + r) / step)); i++) {
        if (Math.hypot(i * step - cx, j * step - cy) > r) continue;
        const k = j * nx + i;
        cells.push(k);
        thinnest = Math.min(thinnest, local.values[k]);
      }
    }
    const id = `socket-${n + 1}`;
    if (!cells.length) return;
    if (bores.some((b) => Math.hypot(b.x - cx, b.y - cy) < b.rMM + r + step)) { refused.push({ id, why: 'it runs into a bore' }); return; }
    if (thinnest - l.socketDepthMM < l.minFloorMM) { refused.push({ id, why: `the plate is only ${thinnest.toFixed(1)} mm there` }); return; }
    for (const k of cells) floor[k] = Math.max(floor[k], l.socketDepthMM);
    placed.push({ id, atMM: [cx, cy] });
  });
  return { placed, refused };
}

/** The distinct cam heights a module needs, one per rim height its cams stand in. */
export function camHeights(placed) {
  const set = new Set();
  for (const p of placed) if (p.kind === 'cam' && Number.isFinite(p.heightMM)) set.add(Math.round(p.heightMM * 10) / 10);
  return [...set].sort((a, b) => a - b);
}

// ---------------------------------------------------------------------------
// The key itself

/**
 * The key's outline, counter-clockwise, in the seam frame as it is when the
 * lock is TIGHT: x across the seam with 0 at the faces and positive into the
 * cam module, y along the seam. The pad is at negative x, in the key
 * module; the head at positive x, seated in the cam.
 */
export function keyOutline(o = {}) {
  const l = lockSettings(o);
  const g = l.clearanceMM; // the part is this much under its pocket across its width
  const hp = l.padMM / 2 - g;
  const hn = l.neckMM / 2 - g;
  const xc = headSeatMM(l); // the head's centre
  const x1 = xc - keySpanMM(l); // the pad's front
  const x0 = x1 - (l.padReachMM - g); // its back
  const rh = l.headMM / 2 - g;
  const alpha = Math.asin(Math.min(0.999, hn / rh)); // where the neck meets the head circle
  const pts = [[x0, -hp], [x1, -hp], [x1, -hn]];
  const SEG = 28;
  for (let k = 0; k <= SEG; k++) {
    const phi = (alpha - Math.PI) + ((2 * (Math.PI - alpha)) * k) / SEG; // from the lower junction round the far side to the upper
    pts.push([xc + rh * Math.cos(phi), rh * Math.sin(phi)]);
  }
  pts.push([x1, hn], [x1, hp], [x0, hp]);
  return pts;
}

/**
 * Ear clipping for a simple polygon.
 *
 * The key is not convex -- the pad's shoulders and the head's junctions are
 * reflex corners -- so a fan from one vertex would put triangles outside it.
 * Written out because it is thirty lines and the alternative is decomposing
 * the shape into rectangles by hand, which leaves T-junctions where a narrow
 * edge meets a wide one and makes the solid leak.
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

/** A simple polygon extruded from z = 0 to z = h, as a closed solid. */
export function extrudePolygon(poly, h) {
  const tris = earClip(poly);
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

/** The key as a closed solid, lying flat, ready to print a stack of. */
export function keySolid(o = {}) {
  const l = lockSettings(o);
  return extrudePolygon(keyOutline(l), l.keyThickMM);
}

/** Several keys laid out side by side on one plate. */
export function keySheet(count, o = {}) {
  const l = lockSettings(o);
  const one = keySolid(l);
  const poly = keyOutline(l);
  let x0 = Infinity; let x1 = -Infinity;
  for (const [x] of poly) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); }
  const pitch = l.padMM + 4;
  const rowPitch = x1 - x0 + 6;
  const cols = Math.max(1, Math.floor(Math.sqrt(count)));
  const out = new Float32Array(one.length * count);
  for (let k = 0; k < count; k++) {
    const dy = (k % cols) * pitch;
    const dx = Math.floor(k / cols) * rowPitch;
    for (let i = 0; i < one.length; i += 3) {
      out[k * one.length + i] = one[i] + dx;
      out[k * one.length + i + 1] = one[i + 1] + dy;
      out[k * one.length + i + 2] = one[i + 2];
    }
  }
  return out;
}

/**
 * How many keys to print for one module: one per key recess that was cut.
 * Its head goes into whatever module sits against that side.
 */
export function usableKeys(result) {
  return (result.keys || []).filter((k) => k.kind === 'key');
}
