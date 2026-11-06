// cam.js — the cam of a Minifix-style lock between two modules.
//
// A dog-bone key holds a seam shut but it does not PULL it shut: the two
// modules sit as close as the hand that put them down left them. A cam lock
// does the pulling. A flat key lies in a pocket in one module's underside
// and its round head sticks out of that module's face into a blind bore in
// the underside of the next; a round cam goes into that bore after it, over
// the head. A quarter turn with a coin and the head is drawn toward the
// cam's axis, which drags the two faces together and holds them there.
//
// THIS WAY UP, THAT WAY IN. The solid is made standing on its hook: the
// hollow is open at z = 0 and the coin slot is at the top. In a module it
// goes in the other way up -- the map is face down when it is assembled,
// so the cam drops into its bore hook end first, the hook ends up at the
// roof of the bore round the key's head, and the coin slot is flush with
// the underside (see joint.js, WHERE THINGS SIT IN DEPTH). Turning a part
// over is a rotation, not a mirror, so the spiral still draws.
//
// THE CAVITY IS THE SWEPT SHAPE. The head and neck of the key are at a
// different place in the cam's own frame at every angle of the turn, and
// the cam must clear them at ALL of those places -- so the hollow is the
// union of the key over the whole turn, inflated by a clearance. Because
// the head's distance from the axis falls as the turn goes on, the outer
// wall of that union is a spiral, and it is the spiral that does the
// pulling: at every angle the head just fits, and the only way on is in.
// The last few degrees have no draw at all, so the lock sits in a flat and
// does not back itself off.
//
// Everything is derived from one outline. The bottom of the cam, the ceiling
// of the hollow and the cylinder above all share the very same vertex lists
// -- the crossing points where the hollow meets the rim and where the coin
// slot's chords meet it are INSERTED into the circle -- because a mesh whose
// pieces agree to the millimetre but not to the vertex is a mesh with
// T-junctions, and that leaks in a slicer.
//
// THE WALL IS REPORTED. The thinnest wall left between the hollow and the
// rim at the tight position is what the lock's strength comes down to, so
// it is worked out and returned for a design to be refused on, rather than
// found out from a cam that splits on its first turn.

import { TriBuilder } from './mesh.js';

export const CAM_DEFAULTS = {
  camMM: 18, // cam cylinder diameter
  headMM: 7, // key head diameter (a disc in plan)
  neckMM: 4.5, // key neck width (a bar in plan, joins the head to the key's pad)
  keyThickMM: 4, // the key is this thick; the cam's hook region is keyThickMM + 2*clearanceMM tall
  drawMM: 1.5, // how far the quarter turn pulls the head toward the axis
  seatMM: 3.5, // head centre distance from the cam axis when tight (after the turn)
  clearanceMM: 0.3, // radial/planar clearance added round the key's swept shape
  slotWidthMM: 3, // coin slot across the top
  slotDepthMM: 2.5,
  turnDeg: 90, // the lock turns this far
  dwellDeg: 10, // the last part of the turn has no draw (self-holding)
};

export function camSettings(o = {}) {
  return { ...CAM_DEFAULTS, ...o };
}

const SEGMENTS = 72; // the circle, as the slicer will see it
const GRID_MM = 0.1; // the distance field is sampled this finely
const SWEEP_STEP_DEG = 1; // and the turn this finely
const SIMPLIFY_MM = 0.015; // a contour vertex this close to the line through its neighbours is dropped
const TAU = Math.PI * 2;

const smoothstep = (t) => { const u = Math.max(0, Math.min(1, t)); return u * u * (3 - 2 * u); };

/**
 * Where the head's centre is in the cam's own frame at `thetaDeg` of turn,
 * and how far it is from the axis. The draw is a smoothstep over the turn
 * less the dwell, then flat.
 */
export function headCentre(lock, thetaDeg) {
  const span = Math.max(1e-9, lock.turnDeg - lock.dwellDeg);
  const L = lock.seatMM + lock.drawMM * (1 - smoothstep(thetaDeg / span));
  const th = (thetaDeg * Math.PI) / 180;
  return { x: -L * Math.cos(th), y: L * Math.sin(th), L };
}

// --- the swept key as a list of shapes with signed distances ---

/** Disc: centre and radius. Bar: from (cx,cy) along the unit (ux,uy) for len, half-width hw. */
function sweptShapes(lock, extra = []) {
  const R = lock.camMM / 2;
  const shapes = [];
  const n = Math.ceil(lock.turnDeg / SWEEP_STEP_DEG);
  for (let k = 0; k <= n; k++) {
    const th = Math.min(lock.turnDeg, k * SWEEP_STEP_DEG);
    const { x, y, L } = headCentre(lock, th);
    const rad = (th * Math.PI) / 180;
    shapes.push({ kind: 'disc', cx: x, cy: y, r: lock.headMM / 2 });
    // The neck runs radially out from the head, through the rim and beyond.
    shapes.push({ kind: 'bar', cx: x, cy: y, ux: -Math.cos(rad), uy: Math.sin(rad), len: R + 3 - L, hw: lock.neckMM / 2 });
  }
  // The entry mouth: at the open position the head slides in from the face.
  const L0 = headCentre(lock, 0).L;
  shapes.push({ kind: 'bar', cx: -L0, cy: 0, ux: -1, uy: 0, len: R + 1 - L0, hw: lock.headMM / 2 });
  return shapes.concat(extra);
}

function shapeSDF(s, x, y) {
  if (s.kind === 'disc') return Math.hypot(x - s.cx, y - s.cy) - s.r;
  if (s.kind === 'bar') {
    const dx = x - s.cx;
    const dy = y - s.cy;
    const t = dx * s.ux + dy * s.uy;
    const ax = Math.abs(t - s.len / 2) - s.len / 2;
    const ay = Math.abs(dx * s.uy - dy * s.ux) - s.hw;
    return Math.hypot(Math.max(ax, 0), Math.max(ay, 0)) + Math.min(Math.max(ax, ay), 0);
  }
  // 'sector': an annular wedge about the origin, used only to merge a split
  // opening in the rim into one. Approximate but inside/outside is exact.
  const r = Math.hypot(x, y);
  let da = Math.atan2(y, x) - s.mid;
  da = Math.atan2(Math.sin(da), Math.cos(da));
  const ring = Math.max(r - s.rOut, s.rIn - r);
  const wedge = (Math.abs(da) - s.half) * Math.max(r, 1e-9);
  return Math.max(ring, wedge);
}

/** The inflated swept region's signed distance: negative inside the cavity. */
function cavitySDF(shapes, clearance, x, y) {
  let d = Infinity;
  for (let i = 0; i < shapes.length; i++) {
    const v = shapeSDF(shapes[i], x, y);
    if (v < d) d = v;
  }
  return d - clearance;
}

/** Is (x, y), in the cam's frame, inside the hollow? Analytic, no raster. */
export function cavityContains(lock, x, y) {
  return cavitySDF(sweptShapes(lock), lock.clearanceMM, x, y) <= 0;
}

// --- marching squares: the zero contour of a sampled field as closed loops ---

// Which cell edges the contour joins, by the 4-bit corner code (a=1 lower
// left, b=2 lower right, c=4 upper right, d=8 upper left; edge 0 bottom,
// 1 right, 2 top, 3 left). The two saddles are settled by the cell centre.
const MS_TABLE = {
  1: [[3, 0]], 2: [[0, 1]], 3: [[3, 1]], 4: [[1, 2]], 6: [[0, 2]], 7: [[3, 2]],
  8: [[2, 3]], 9: [[0, 2]], 11: [[1, 2]], 12: [[1, 3]], 13: [[0, 1]], 14: [[3, 0]],
};

function marchingSquares(f, nx, ny, x0, y0, h) {
  const pts = new Map();
  const adj = new Map();
  const val = (i, j) => f[j * nx + i];
  const edge = (key, p) => {
    if (!pts.has(key)) { pts.set(key, p); adj.set(key, []); }
    return key;
  };
  const link = (k1, k2) => { adj.get(k1).push(k2); adj.get(k2).push(k1); };
  for (let j = 0; j < ny - 1; j++) {
    for (let i = 0; i < nx - 1; i++) {
      const fa = val(i, j), fb = val(i + 1, j), fc = val(i + 1, j + 1), fd = val(i, j + 1);
      const code = (fa < 0 ? 1 : 0) | (fb < 0 ? 2 : 0) | (fc < 0 ? 4 : 0) | (fd < 0 ? 8 : 0);
      if (code === 0 || code === 15) continue;
      let pairs = MS_TABLE[code];
      if (!pairs) {
        const centreIn = fa + fb + fc + fd < 0;
        if (code === 5) pairs = centreIn ? [[0, 1], [2, 3]] : [[3, 0], [1, 2]];
        else pairs = centreIn ? [[3, 0], [1, 2]] : [[0, 1], [2, 3]];
      }
      const keys = [];
      for (const [p, q] of pairs) for (const e of [p, q]) {
        if (keys[e]) continue;
        if (e === 0) keys[e] = edge(`h${i},${j}`, [x0 + (i + fa / (fa - fb)) * h, y0 + j * h]);
        else if (e === 1) keys[e] = edge(`v${i + 1},${j}`, [x0 + (i + 1) * h, y0 + (j + fb / (fb - fc)) * h]);
        else if (e === 2) keys[e] = edge(`h${i},${j + 1}`, [x0 + (i + fd / (fd - fc)) * h, y0 + (j + 1) * h]);
        else keys[e] = edge(`v${i},${j}`, [x0 + i * h, y0 + (j + fa / (fa - fd)) * h]);
      }
      for (const [p, q] of pairs) link(keys[p], keys[q]);
    }
  }
  const seen = new Set();
  const loops = [];
  for (const start of adj.keys()) {
    if (seen.has(start) || adj.get(start).length !== 2) continue;
    const loop = [];
    let prev = null;
    let cur = start;
    let closed = false;
    for (;;) {
      seen.add(cur);
      loop.push(pts.get(cur));
      const nb = adj.get(cur);
      const next = nb[0] === prev ? nb[1] : nb[0];
      if (next === start) { closed = true; break; }
      if (next === undefined || seen.has(next)) break;
      prev = cur;
      cur = next;
    }
    // A chain that runs off the grid is not an outline; only loops count.
    if (closed && loop.length >= 3) loops.push(loop);
  }
  return loops;
}

function signedArea(poly) {
  let a = 0;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i];
    const q = poly[(i + 1) % poly.length];
    a += p[0] * q[1] - q[0] * p[1];
  }
  return a / 2;
}

/** Douglas-Peucker on a closed loop, keeping the first vertex. */
function simplifyLoop(loop, tol) {
  const pts = loop.concat([loop[0]]);
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [s, e] = stack.pop();
    if (e - s < 2) continue;
    const a = pts[s];
    const b = pts[e];
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const len = Math.hypot(dx, dy); // zero for the closing span: distance from the point itself then
    let worst = -1;
    let at = -1;
    for (let i = s + 1; i < e; i++) {
      const p = pts[i];
      const d = len > 1e-12
        ? Math.abs((p[0] - a[0]) * dy - (p[1] - a[1]) * dx) / len
        : Math.hypot(p[0] - a[0], p[1] - a[1]);
      if (d > worst) { worst = d; at = i; }
    }
    if (worst > tol) { keep[at] = 1; stack.push([s, at], [at, e]); }
  }
  const out = [];
  for (let i = 0; i < pts.length - 1; i++) {
    if (!keep[i]) continue;
    const last = out[out.length - 1];
    if (last && Math.hypot(last[0] - pts[i][0], last[1] - pts[i][1]) < 1e-6) continue;
    out.push(pts[i]);
  }
  return out;
}

/** The hollow's outline in the cam's frame, counter-clockwise, simplified. */
function cavityOutline(lock, extra = []) {
  const R = lock.camMM / 2;
  const shapes = sweptShapes(lock, extra);
  const span = R + 4;
  const n = Math.round((2 * span) / GRID_MM) + 1;
  const x0 = -span;
  const f = new Float64Array(n * n);
  for (let j = 0; j < n; j++) {
    const y = x0 + j * GRID_MM;
    for (let i = 0; i < n; i++) f[j * n + i] = cavitySDF(shapes, lock.clearanceMM, x0 + i * GRID_MM, y);
  }
  const loops = marchingSquares(f, n, n, x0, x0, GRID_MM);
  if (!loops.length) throw new Error('the cam cavity has no outline');
  // The swept key is one connected region; anything else is raster noise.
  let loop = loops[0];
  for (const l of loops) if (Math.abs(signedArea(l)) > Math.abs(signedArea(loop))) loop = l;
  if (signedArea(loop) < 0) loop.reverse();
  return simplifyLoop(loop, SIMPLIFY_MM);
}

/** Where the directed segment p->q crosses the circle of radius R, as [t, point] pairs in order. */
function circleCrossings(p, q, R) {
  const dx = q[0] - p[0];
  const dy = q[1] - p[1];
  const a = dx * dx + dy * dy;
  if (a < 1e-18) return [];
  const b = 2 * (p[0] * dx + p[1] * dy);
  const c = p[0] * p[0] + p[1] * p[1] - R * R;
  const disc = b * b - 4 * a * c;
  if (disc < 0) return [];
  const s = Math.sqrt(disc);
  const out = [];
  for (const t of [(-b - s) / (2 * a), (-b + s) / (2 * a)]) {
    if (t >= 0 && t < 1) out.push([t, [p[0] + t * dx, p[1] + t * dy]]);
  }
  return out;
}

const angleOf = (p) => { const a = Math.atan2(p[1], p[0]); return a < 0 ? a + TAU : a; };

/**
 * The cam in plan: the circle with every shared point inserted, the hook
 * (what is left of the bottom), the ceiling of the hollow, and the thinnest
 * wall at the seat.
 */
export function camProfile(lock) {
  // The distance field is a few hundred milliseconds of arithmetic and a
  // sheet asks for the same profile once per cam, so the last few are kept.
  const key = JSON.stringify(Object.keys(CAM_DEFAULTS).map((k) => lock[k]));
  if (!PROFILES.has(key)) {
    if (PROFILES.size >= 16) PROFILES.delete(PROFILES.keys().next().value);
    PROFILES.set(key, buildProfile(lock));
  }
  return PROFILES.get(key);
}

const PROFILES = new Map();

function buildProfile(lock) {
  const R = lock.camMM / 2;
  const hookMM = lock.keyThickMM + 2 * lock.clearanceMM;
  const wallMM = R - (lock.seatMM + lock.headMM / 2 + lock.clearanceMM);

  // The hollow must open through the rim in exactly one place. If the mouth
  // and the swept neck arrive at the rim as separate lobes, the arc between
  // them is added to the hollow and the outline taken again.
  let loop;
  let crossings;
  for (let attempt = 0, extra = []; ; attempt++) {
    loop = cavityOutline(lock, extra);
    crossings = [];
    for (let i = 0; i < loop.length; i++) {
      for (const [t, pt] of circleCrossings(loop[i], loop[(i + 1) % loop.length], R)) {
        crossings.push({ seg: i, t, pt, angle: angleOf(pt) });
      }
    }
    if (crossings.length === 2) break;
    if (crossings.length < 2) throw new Error(`the cam cavity does not open through the rim (${crossings.length} crossings)`);
    if (attempt > 0) throw new Error(`the cam cavity opens through the rim in more than one place (${crossings.length} crossings)`);
    // The narrowest arc that holds every crossing, as a wedge through the rim.
    const angles = crossings.map((c) => c.angle).sort((p, q) => p - q);
    let gapAt = 0;
    let gap = -1;
    for (let i = 0; i < angles.length; i++) {
      const g = ((angles[(i + 1) % angles.length] - angles[i]) + TAU) % TAU;
      if (g > gap) { gap = g; gapAt = i; }
    }
    const from = angles[(gapAt + 1) % angles.length];
    const half = (TAU - gap) / 2;
    extra = [{ kind: 'sector', mid: from + half, half, rIn: R - 1, rOut: R + 2.5 }]; // short of the grid's edge
  }

  // The run of the outline that lies inside the circle, from the crossing
  // where it enters (P) to the one where it leaves (Q), hollow on its left.
  const n = loop.length;
  const [c0, c1] = crossings;
  const runAfter = (c, d) => {
    const run = [];
    if (c.seg === d.seg && c.t < d.t) return run;
    for (let i = (c.seg + 1) % n; ; i = (i + 1) % n) {
      run.push(loop[i]);
      if (i === d.seg) break;
    }
    return run;
  };
  const probe = loop[(c0.seg + 1) % n];
  const firstInside = c0.seg === c1.seg && c0.t < c1.t
    ? false
    : Math.hypot(probe[0], probe[1]) < R;
  const P = firstInside ? c0 : c1;
  const Q = firstInside ? c1 : c0;
  const run = runAfter(P, Q);

  // The circle: the regular vertices, the two crossings and the four slot
  // chord points, in one list sorted by angle, each inserted once.
  const circle = [];
  for (let k = 0; k < SEGMENTS; k++) {
    const a = (TAU * k) / SEGMENTS;
    circle.push({ a, p: [R * Math.cos(a), R * Math.sin(a)] });
  }
  const insert = (a, p) => {
    for (const v of circle) {
      const d = Math.abs(((v.a - a + Math.PI) % TAU + TAU) % TAU - Math.PI);
      if (d < 2e-4) return v.p; // a hair from a vertex already there: use it
    }
    const v = { a, p };
    circle.push(v);
    return v.p;
  };
  const pP = insert(P.angle, P.pt);
  const pQ = insert(Q.angle, Q.pt);
  const alpha = Math.asin(Math.min(1, lock.slotWidthMM / 2 / R));
  const chord = {};
  for (const [name, a] of [['ne', alpha], ['nw', Math.PI - alpha], ['sw', Math.PI + alpha], ['se', TAU - alpha]]) {
    chord[name] = insert(a, [R * Math.cos(a), R * Math.sin(a)]);
  }
  circle.sort((u, v) => u.a - v.a);
  const ring = circle.map((v) => v.p);
  const indexOf = (p) => ring.indexOf(p);
  const arc = (from, to) => {
    const out = [];
    for (let i = indexOf(from); ; i = (i + 1) % ring.length) {
      out.push(ring[i]);
      if (ring[i] === to) break;
    }
    return out;
  };

  const hook = arc(pP, pQ).concat(run.slice().reverse());
  const ceiling = arc(pQ, pP).concat(run);
  return { circle: ring, hook, ceiling, hookMM, wallMM, chord, arc };
}

/** A copy of joint.js's ear clipping: a simple polygon, counter-clockwise triples. */
function earClip(poly) {
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

/**
 * The cam as a closed solid standing on z = 0, `heightMM` tall: the hook at
 * the bottom, the coin slot at the top. Printed this way up; installed the
 * other way up, hook end first into its bore.
 */
export function camSolid(lock, heightMM) {
  const prof = camProfile(lock);
  const { circle, hook, ceiling, hookMM: hK, chord, arc } = prof;
  const H = heightMM;
  const d = lock.slotDepthMM;
  const w = lock.slotWidthMM;
  if (H < hK + d + 1) {
    throw new Error(`the cam is too short: ${H} mm, with a ${hK.toFixed(1)} mm hook and a ${d} mm slot it needs at least ${(hK + d + 1).toFixed(1)} mm`);
  }

  const tb = new TriBuilder();
  const at = (p, z) => [p[0], p[1], z];
  // A wall under the directed edge a->b, solid on its left, outward to its right.
  const wall = (a, b, z0, z1) => {
    tb.tri(at(a, z0), at(b, z0), at(b, z1));
    tb.tri(at(a, z0), at(b, z1), at(a, z1));
  };
  const capUp = (poly, z) => {
    for (const [a, b, c] of earClip(poly)) tb.tri(at(poly[a], z), at(poly[b], z), at(poly[c], z));
  };
  const capDown = (poly, z) => {
    for (const [a, b, c] of earClip(poly)) tb.tri(at(poly[a], z), at(poly[c], z), at(poly[b], z));
  };

  // The hook: its underside, its walls (rim and hollow alike), the ceiling.
  capDown(hook, 0);
  for (let k = 0; k < hook.length; k++) wall(hook[k], hook[(k + 1) % hook.length], 0, hK);
  capDown(ceiling, hK);

  // The cylinder above, in two bands so the slot's floor level is a vertex
  // row all the way round; the upper band is left out under the slot.
  for (let k = 0; k < circle.length; k++) {
    const a = circle[k];
    const b = circle[(k + 1) % circle.length];
    wall(a, b, hK, H - d);
    if (Math.abs((a[1] + b[1]) / 2) > w / 2) wall(a, b, H - d, H);
  }

  // The top: two D caps, the slot floor between them, and the slot's walls.
  const north = arc(chord.ne, chord.nw);
  const south = arc(chord.sw, chord.se);
  const floor = arc(chord.se, chord.ne).concat(arc(chord.nw, chord.sw));
  capUp(north, H);
  capUp(south, H);
  capUp(floor, H - d);
  wall(chord.nw, chord.ne, H - d, H);
  wall(chord.se, chord.sw, H - d, H);

  return tb.toArray();
}

/** Several cams on one plate, one per entry in `heights`, side by side along x. */
export function camSheet(lock, heights) {
  const pitch = lock.camMM + 4;
  const parts = heights.map((h) => camSolid(lock, h));
  const total = parts.reduce((s, p) => s + p.length, 0);
  const out = new Float32Array(total);
  let o = 0;
  parts.forEach((p, i) => {
    const dx = i * pitch;
    for (let k = 0; k < p.length; k += 3) {
      out[o + k] = p[k] + dx;
      out[o + k + 1] = p[k + 1];
      out[o + k + 2] = p[k + 2];
    }
    o += p.length;
  });
  return out;
}
