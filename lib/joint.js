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
//   THE CAM    a short cylinder in a BLIND round bore in the underside of
//              module A, camHeightMM deep. Its hook end is hollowed into a
//              spiral: the key's head enters from the side, and a quarter
//              turn with a coin draws the head toward the cam's axis -- and
//              B against A.
//
// EVERY SIDE, THE SAME TWO PLACES. A module is built alone, so the features
// go at fixed distances along every side, measured the same way round: from
// the middle of the side, `offsetMM` along it counter-clockwise is the cam
// housing and `offsetMM` the other way is the key's recess. Walk round two
// modules' shared seam and the directions reverse, so A's cam meets B's key
// and A's key meets B's cam, whichever two modules they are, however they
// are turned. That is what makes the lock part of the contract.
//
// EVERYTHING FROM THE UNDERSIDE. The first cam was bored down from the top,
// and the ground round every bore had to be levelled into a terrace for the
// cam to sit flush: a round crater in every mountain that met a seam. So
// nothing goes in from the top any more. The bore, the key's pocket and the
// entry channel are all cut up into the underside, camHeightMM deep, and the
// top of the module is the ground and nothing else.
//
// HOW IT GOES TOGETHER. Lay the modules FACE DOWN on the table, butted
// together, underside up. Drop a key into each seam: its pad falls into B's
// pocket, its neck and head into A's entry channel and the bottom of A's
// bore. Drop a cam into each bore over the head, hook end first, coin slot
// up, its open mouth toward the seam. A quarter turn with a coin draws the
// head in by drawMM -- pulling the key's pad onto the shoulder of its
// pocket, and the faces together with preloadMM to spare. Then turn the
// map over and play on it. The key's pocket is a draw longer than the pad,
// so it can sit back while the cam goes in. To take one module out, turn
// the map over again and turn back its cams and the neighbours' cams on
// that side: they are loose.
//
// WHERE THINGS SIT IN DEPTH. Face down, everything falls to the DEEP end of
// its hole: the key lies against the roof of its pocket, from
// camHeightMM - keyThickMM - clearanceMM to camHeightMM above the base, and
// the cam is in hook end first, so its hook (its own bottom hookMM, see
// cam.js) is up at the roof of the bore round the head, and its coin slot
// is flush with the underside. The cam's solid is the same one cam.js has
// always made; it is just put in the other way up. lockDepths says where
// each of these is, and the head has to be inside the hook.
//
// The cam's own solid lives in cam.js. This file is the module's half: where
// the features go, how they are cut into the underside, and the key.

import { EDGES } from './contract.js';
import { boreBlock, blocksOverlap } from './mesh.js';

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
  keyThickMM: 4, // the key is this thick
  camHeightMM: 8.4, // the cam is this tall, and the bore, the pocket and the entry channel this deep
  drawMM: 1.5, // how far the quarter turn pulls the head toward the cam's axis
  seatMM: 3.5, // the head's centre this far from the axis when tight
  clearanceMM: 0.3, // a slip fit round the key, and round the cam in its bore
  preloadMM: 0.2, // how far past touching the turn tries to pull the faces: what makes it TIGHT
  slotWidthMM: 3, // the coin slot
  slotDepthMM: 2.5,
  turnDeg: 90,
  dwellDeg: 10, // the last part of the turn has no draw, so it holds
  entryMM: 9, // the underside channel the head drops through, from the face to the bore
  socketMM: 9, // a socket in each corner of the underside, for a spacer plate's stud
  socketDepthMM: 3,
  socketInsetMM: 20, // the sockets' centres this far in from both faces at a corner
  minFloorMM: 1.6, // plastic that must remain above a bore, a pocket or a channel
};

export function lockSettings(o = {}) {
  const l = { ...LOCK_DEFAULTS, ...o };
  // A head no wider than its neck is a bar the cam cannot hook. Held.
  l.headMM = Math.max(l.headMM, l.neckMM + 2);
  return l;
}

/** The cam's bore radius: the cam plus its slip fit. */
export const boreRadius = (l) => l.camMM / 2 + l.clearanceMM;
/** How deep the bore, the pocket and the entry channel go into the underside. */
export const recessDepth = (l) => l.camHeightMM;
/** The cam's hook region: the key's thickness and a clearance either side, as cam.js cuts it. */
export const hookMM = (l) => l.keyThickMM + 2 * l.clearanceMM;
/** The shortest cam that has room for its hook, its coin slot and a millimetre between. */
export const shortestCamMM = (l) => hookMM(l) + l.slotDepthMM + 1;

/**
 * Where the parts sit in depth, as [from, to] millimetres above the module's
 * base. The key is at the deep end of its pocket and the cam's hook at the
 * deep end of its bore (see WHERE THINGS SIT IN DEPTH); the coin slot is at
 * the open end.
 */
export function lockDepths(o = {}) {
  const l = lockSettings(o);
  const h = l.camHeightMM;
  return {
    bore: [0, h],
    key: [h - l.keyThickMM - l.clearanceMM, h],
    hook: [h - hookMM(l), h],
    slot: [0, l.slotDepthMM],
  };
}
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
  if (l.camHeightMM < shortestCamMM(l) - 1e-9) {
    out.push({
      severity: 'error',
      message: `A ${l.camHeightMM} mm cam has no room for its ${hookMM(l).toFixed(1)} mm hook and ${l.slotDepthMM} mm coin slot: it needs ${shortestCamMM(l).toFixed(1)} mm.`,
    });
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
 * Cut the lock features into a module's underside: the key pockets and the
 * cams' entry channels into its floor field, and say where the cams' blind
 * bores go so the mesher can bore them. The top is not touched.
 *
 *   local        the height field; its values are the top
 *   c            the contract
 *   locks        from edgeLocks
 *   o            lock settings
 *   bores        bores already in the module (springs), which a feature may
 *                not run into
 *   floor        a floor field to cut into, if there is one already
 *
 * Returns the floor field to mesh with (0 where the underside is flat, else
 * how far up it is cut), the bores to add, and what was placed and refused.
 *
 * A feature is left out WHOLE or not at all. Cutting a pocket short where
 * the ground runs low would leave a pocket a key cannot sit in, which is
 * worse than no pocket: the module would rock. Everything is camHeightMM
 * deep, so what decides it is the lowest ground over the feature: over a
 * cam that is its bore's whole block of cells (see mesh.js: the underside
 * there can be at the bore's roof anywhere in it) and its entry channel,
 * and over a key its pocket.
 */
export function cutLockFeatures(local, c, locks, o = {}, bores = [], { floor = null } = {}) {
  const l = lockSettings(o);
  const { nx, ny, step } = local;
  const z = local.values;
  const out = floor || new Float64Array(nx * ny);
  const placed = [];
  const refused = [];
  const newBores = [];
  const depth = recessDepth(l);
  const rb = boreRadius(l);

  for (const lk of locks) {
    const f = edgeFrame(c, lk.edge);
    const isCam = lk.kind === 'cam';
    const what = isCam ? 'cam housing' : 'key pocket';
    // The box of cells the pocket or the entry channel could touch.
    const halfW = isCam ? l.entryMM / 2 : l.padMM / 2 + l.clearanceMM;
    const reach = isCam ? l.camInsetMM : l.neckReachMM + l.padReachMM + l.clearanceMM + l.drawMM;
    const corners = [toXY(f, lk.uMM - halfW, 0), toXY(f, lk.uMM + halfW, 0), toXY(f, lk.uMM - halfW, reach), toXY(f, lk.uMM + halfW, reach)];
    const xs = corners.map((p) => p[0]);
    const ys = corners.map((p) => p[1]);
    const i0 = Math.max(0, Math.floor(Math.min(...xs) / step));
    const i1 = Math.min(nx - 1, Math.ceil(Math.max(...xs) / step));
    const j0 = Math.max(0, Math.floor(Math.min(...ys) / step));
    const j1 = Math.min(ny - 1, Math.ceil(Math.max(...ys) / step));

    const cells = []; // underside cells to cut
    let thinnest = Infinity;
    const [ax, ay] = toXY(f, lk.uMM, l.camInsetMM); // the cam's axis
    for (let jj = j0; jj <= j1; jj++) {
      for (let ii = i0; ii <= i1; ii++) {
        const { u, v } = toUV(f, ii * step, jj * step);
        const inside = isCam ? inEntry(l, u - lk.uMM, v) : inRecess(l, u - lk.uMM, v);
        if (!inside) continue;
        const k = jj * nx + ii;
        cells.push(k);
        thinnest = Math.min(thinnest, z[k]);
      }
    }
    const bore = isCam ? { x: ax, y: ay, rMM: rb, blindMM: depth, lock: lk.id } : null;
    const block = isCam ? boreBlock(bore, nx, ny, step) : null;
    if (!cells.length || (block && !block.ok)) { refused.push({ ...lk, why: 'off the module' }); continue; }
    if (block) for (let jj = block.j0; jj <= block.j1; jj++) for (let ii = block.i0; ii <= block.i1; ii++) thinnest = Math.min(thinnest, z[jj * nx + ii]);

    // A feature through a tube bore is a slot open to the hole, and a cam
    // whose block meets another bore's cannot be meshed. Refused whole.
    const others = [...bores, ...newBores];
    const clear = (b, x, y, extra) => Math.hypot(x - b.x, y - b.y) < b.rMM + extra + step;
    const hitsBore = others.some((b) => (isCam && (clear(b, ax, ay, rb) || blocksOverlap(block, boreBlock(b, nx, ny, step))))
      || cells.some((k) => clear(b, (k % nx) * step, Math.floor(k / nx) * step, l.clearanceMM)));
    if (hitsBore) { refused.push({ ...lk, why: 'it runs into a tube bore' }); continue; }

    // The tolerance is so a 10 mm plate, which leaves exactly minFloorMM
    // over an 8.4 mm cam, is not refused on a rounding error.
    if (thinnest - depth < l.minFloorMM - 1e-9) {
      refused.push({
        ...lk,
        why: `the ground is only ${thinnest.toFixed(1)} mm above the base there, and a ${depth.toFixed(1)} mm deep ${what} would leave ${(thinnest - depth).toFixed(1)} mm over it`,
      });
      continue;
    }
    if (isCam) newBores.push(bore);
    for (const k of cells) out[k] = Math.max(out[k], depth);
    placed.push({ ...lk, ...(isCam ? { axisMM: [ax, ay], heightMM: l.camHeightMM } : {}) });
  }
  return { floor: out, bores: newBores, placed, refused, any: placed.length > 0 };
}

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

/**
 * The distinct cam heights a module needs. Every cam is camHeightMM now --
 * it sits in a blind bore of that depth whatever the ground over it -- so
 * this is that one height, or nothing if no cam was placed. Kept as a list
 * so a reader of a tile need not know that.
 */
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
  return steppedKey(keyOutline(l), l.keyThickMM, padThickMM(l), keySpanMM(l), headSeatMM(l));
}

/**
 * How thick the key's PAD is: its pocket's depth, less the slip fit. The
 * neck and head are keyThickMM, to fit the cam's hook; the pad fills its
 * pocket, so once the map is the right way up it stands on its own and
 * cannot drop out of line -- a pad as thin as the neck hung 4 mm loose in
 * an 8.4 mm pocket and left the key lying at a slant.
 */
export const padThickMM = (l) => Math.max(l.keyThickMM, recessDepth(l) - l.clearanceMM);

/**
 * The key as a closed solid in the pose it prints in: the face that lies
 * against the pocket's roof flat on the bed at z = 0, the neck and head
 * `thin` thick, the pad `thick`. The pad is the part of the outline behind
 * x = headSeat - span (the pad's front); see keyOutline.
 */
function steppedKey(poly, thin, thick, span, seat) {
  const xFront = seat - span + 1e-9;
  const n = poly.length;
  // The outline's vertices on the pad's front line: where the step wall goes.
  const isPad = (p) => p[0] <= xFront;
  const out = [];
  const tri = (a, b, c) => out.push(a, b, c);
  const P = (p, z) => [p[0], p[1], z];
  // The flush face, on the bed, facing down.
  for (const [a, b, c] of earClip(poly)) tri(P(poly[a], 0), P(poly[c], 0), P(poly[b], 0));
  // The pad's top and the neck-and-head's top, facing up.
  const pad = poly.filter(isPad);
  const neck = poly.filter((p, i) => !isPad(p) || (isPad(p) && (!isPad(poly[(i + 1) % n]) || !isPad(poly[(i + n - 1) % n]))));
  for (const [a, b, c] of earClip(pad)) tri(P(pad[a], thick), P(pad[b], thick), P(pad[c], thick));
  for (const [a, b, c] of earClip(neck)) tri(P(neck[a], thin), P(neck[b], thin), P(neck[c], thin));
  // Walls: every edge up to `thin`; pad edges on up to `thick`.
  for (let k = 0; k < n; k++) {
    const a = poly[k];
    const b = poly[(k + 1) % n];
    tri(P(a, 0), P(b, 0), P(b, thin));
    tri(P(a, 0), P(b, thin), P(a, thin));
    if (isPad(a) && isPad(b)) {
      tri(P(a, thin), P(b, thin), P(b, thick));
      tri(P(a, thin), P(b, thick), P(a, thick));
    }
  }
  // The step from the neck up onto the pad, across the pad's front where
  // the neck leaves it: between the two outline vertices that are on the
  // front line and border the neck.
  const front = poly.filter((p, i) => isPad(p) && !isPad(poly[(i + 1) % n]));
  const back = poly.filter((p, i) => isPad(p) && !isPad(poly[(i + n - 1) % n]));
  if (front.length === 1 && back.length === 1) {
    const a = front[0];
    const b = back[0];
    // Outward is toward the head (+x).
    tri(P(a, thin), P(b, thick), P(a, thick));
    tri(P(a, thin), P(b, thin), P(b, thick));
  }
  const arr = new Float32Array(out.length * 3);
  for (let i = 0; i < out.length; i++) { arr[i * 3] = out[i][0]; arr[i * 3 + 1] = out[i][1]; arr[i * 3 + 2] = out[i][2]; }
  return arr;
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
