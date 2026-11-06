// edits.js — what was done to the ground by hand, kept as operations.
//
// A brushstroke is not stored as the cells it changed. It is stored as what
// was done -- raise along this line by 4 mm, flatten here to 30 -- and it is
// REPLAYED every time the tile is built, after the river is carved and
// before the lakes. So a change of seed, or of the glacier's climate, keeps
// every stroke: they are laid onto the new ground. And the same spec still
// builds the same bytes, because a replay is arithmetic in a fixed order.
//
//   spec.edits = [ op, op, ... ]
//
// in the module's own millimetres, north up.
//
//   { op: 'raise',   path: [[x, y], ...], radiusMM, mm }  a ridge along the line, mm high on it
//   { op: 'lower',   path, radiusMM, mm }                 the same, down
//   { op: 'smooth',  path, radiusMM, strength }           towards the ground's own average
//   { op: 'flatten', path | at, radiusMM, toMM, strength }  towards one height
//   { op: 'clear',   path, radiusMM }                     no tree stands here
//   { op: 'plant',   path, radiusMM, kind, density }      a wood here
//
// A stroke is its line and a radius; its weight is 1 on the line and eases
// to nothing at the radius, so a stroke is a ridge with a constant crest,
// not a row of bumps. `at` is a stroke of one point.
//
// THE RIM IS LOCKED. Every change to the ground is multiplied by a weight
// that is 0 on the rim and 1 from `rimLockMM` in, smoothstepped between: the
// brush fades to nothing over the last 12 mm. So an edited tile meets its
// contract exactly, and conformToContract runs after anyway, as it does
// after the carve. Nothing is pushed below `floorMM` that was above it, which
// is the 2 mm of floor everything cut into a tile keeps.
//
// The trees are the same list, replayed later, where the woods are planted:
// see clearFilter and plantings.

export const EDIT_DEFAULTS = { rimLockMM: 12, floorMM: 2 };

/** The ops that move the ground, replayed after the carve. */
export const GROUND_OPS = ['raise', 'lower', 'smooth', 'flatten'];
/** The ops on the woods, replayed where the woods are planted. */
export const TREE_OPS = ['clear', 'plant'];

/** How a planted wood grows, by kind: the same two the editor's Wood tool offers. */
export const PLANT_KINDS = {
  conifer: { kind: 'conifer', crownMM: 7, heightMM: 9, density: 0.6, maxSlopeDeg: 36 },
  deciduous: { kind: 'deciduous', crownMM: 12, heightMM: 7, density: 0.5, maxSlopeDeg: 24 },
};

/** The module's ops, in the order they were made. */
export function editsFor(spec) {
  const list = spec?.edits;
  return Array.isArray(list) ? list.filter((o) => o && typeof o === 'object') : [];
}

/** A stroke's points: `path`, or `at` as a stroke of one point. */
export function strokeOf(op) {
  const pts = Array.isArray(op?.path) ? op.path : Array.isArray(op?.at) ? [op.at] : [];
  return pts.filter((p) => Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1]));
}

/** Distance from (x, y) to a stroke's line. */
export function distToStroke(pts, x, y) {
  if (!pts.length) return Infinity;
  let best = Math.hypot(x - pts[0][0], y - pts[0][1]);
  for (let s = 1; s < pts.length; s++) {
    const [ax, ay] = pts[s - 1];
    const [bx, by] = pts[s];
    const dx = bx - ax;
    const dy = by - ay;
    const L2 = dx * dx + dy * dy;
    const t = L2 > 0 ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / L2)) : 0;
    best = Math.min(best, Math.hypot(x - ax - t * dx, y - ay - t * dy));
  }
  return best;
}

/** The brush's weight a fraction `t` of its radius from the line: 1 on it, 0 at the radius, level at both. */
export const falloff = (t) => (t >= 1 ? 0 : t <= 0 ? 1 : 0.5 * (1 + Math.cos(Math.PI * t)));

/** How much an edit may move the ground at (x, y) on a tile `extentMM` across: 0 on the rim, 1 from `rimLockMM` in. */
export function rimWeight(x, y, extentMM, rimLockMM = EDIT_DEFAULTS.rimLockMM) {
  const d = Math.min(x, y, extentMM - x, extentMM - y);
  if (d <= 0) return 0;
  if (!(rimLockMM > 0)) return 1;
  const t = Math.min(1, d / rimLockMM);
  return t * t * (3 - 2 * t);
}

/** A stroke's whole weight at a point: the brush, times the rim lock. */
export function strokeWeight(op, pts, x, y, extentMM, rimLockMM) {
  const R = Number(op.radiusMM);
  return falloff(distToStroke(pts, x, y) / R) * rimWeight(x, y, extentMM, rimLockMM);
}

/** The cells a stroke can reach: its line's bounding box, grown by the radius, clipped to the field. */
function footprint(local, pts, R) {
  const { nx, ny, step } = local;
  let x0 = Infinity; let y0 = Infinity; let x1 = -Infinity; let y1 = -Infinity;
  for (const [x, y] of pts) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
  return {
    i0: Math.max(0, Math.floor((x0 - R) / step)), i1: Math.min(nx - 1, Math.ceil((x1 + R) / step)),
    j0: Math.max(0, Math.floor((y0 - R) / step)), j1: Math.min(ny - 1, Math.ceil((y1 + R) / step)),
  };
}

/** The ground's height at a point, bilinear, from the values as they are. */
function heightAt(local, x, y) {
  const { nx, ny, step, values } = local;
  const u = Math.max(0, Math.min(nx - 1, x / step));
  const v = Math.max(0, Math.min(ny - 1, y / step));
  const i = Math.min(nx - 2, Math.floor(u));
  const j = Math.min(ny - 2, Math.floor(v));
  const fu = u - i;
  const fv = v - j;
  const z = (a, b) => values[b * nx + a];
  return (z(i, j) * (1 - fu) + z(i + 1, j) * fu) * (1 - fv) + (z(i, j + 1) * (1 - fu) + z(i + 1, j + 1) * fu) * fv;
}

/** A box average of the field over a rectangle, read from a frozen copy so the order cells are visited in does not matter. */
function boxAverage(local, f, r) {
  const { nx, values } = local;
  const w = f.i1 - f.i0 + 1;
  const h = f.j1 - f.j0 + 1;
  const out = new Float64Array(w * h);
  const ny = local.ny;
  for (let j = f.j0; j <= f.j1; j++) {
    for (let i = f.i0; i <= f.i1; i++) {
      let sum = 0;
      let n = 0;
      for (let jj = Math.max(0, j - r); jj <= Math.min(ny - 1, j + r); jj++) {
        for (let ii = Math.max(0, i - r); ii <= Math.min(nx - 1, i + r); ii++) { sum += values[jj * nx + ii]; n++; }
      }
      out[(j - f.j0) * w + (i - f.i0)] = sum / n;
    }
  }
  return out;
}

/**
 * Replay the ground ops onto a tile's height field, in order, in place.
 * Tree ops are left for clearFilter and plantings; anything else is
 * reported, not guessed at. Returns { applied, skipped: [{ index, why }] }.
 */
export function applyGroundEdits(local, ops, o = {}) {
  const { rimLockMM, floorMM } = { ...EDIT_DEFAULTS, ...o };
  const { nx, step, values } = local;
  const extent = (local.nx - 1) * step;
  const report = { applied: 0, skipped: [] };
  ops.forEach((op, index) => {
    if (TREE_OPS.includes(op.op)) return;
    if (!GROUND_OPS.includes(op.op)) { report.skipped.push({ index, why: `there is no "${op.op}" edit` }); return; }
    const pts = strokeOf(op);
    const R = Number(op.radiusMM);
    if (!pts.length || !(R > 0)) { report.skipped.push({ index, why: 'it has no line, or no radius' }); return; }
    const f = footprint(local, pts, R);
    if (f.i1 < f.i0 || f.j1 < f.j0) return;
    const keepFloor = (was, now) => Math.max(Math.min(was, floorMM), now);

    if (op.op === 'raise' || op.op === 'lower') {
      const mm = (Number(op.mm) || 0) * (op.op === 'lower' ? -1 : 1);
      if (!mm) { report.skipped.push({ index, why: 'it moves the ground by 0 mm' }); return; }
      for (let j = f.j0; j <= f.j1; j++) {
        for (let i = f.i0; i <= f.i1; i++) {
          const w = strokeWeight(op, pts, i * step, j * step, extent, rimLockMM);
          if (w <= 0) continue;
          const k = j * nx + i;
          values[k] = keepFloor(values[k], values[k] + mm * w);
        }
      }
    } else if (op.op === 'smooth') {
      const strength = Math.max(0, Math.min(1, Number.isFinite(op.strength) ? op.strength : 0.7));
      const avg = boxAverage(local, f, Math.max(1, Math.round(R / (3 * step))));
      const w0 = f.i1 - f.i0 + 1;
      for (let j = f.j0; j <= f.j1; j++) {
        for (let i = f.i0; i <= f.i1; i++) {
          const w = strokeWeight(op, pts, i * step, j * step, extent, rimLockMM) * strength;
          if (w <= 0) continue;
          const k = j * nx + i;
          values[k] = keepFloor(values[k], values[k] + (avg[(j - f.j0) * w0 + (i - f.i0)] - values[k]) * w);
        }
      }
    } else {
      // Flatten: to the height asked for, or to the ground where the stroke began.
      const to = Number.isFinite(op.toMM) ? op.toMM : heightAt(local, pts[0][0], pts[0][1]);
      const strength = Math.max(0, Math.min(1, Number.isFinite(op.strength) ? op.strength : 1));
      for (let j = f.j0; j <= f.j1; j++) {
        for (let i = f.i0; i <= f.i1; i++) {
          const w = strokeWeight(op, pts, i * step, j * step, extent, rimLockMM) * strength;
          if (w <= 0) continue;
          const k = j * nx + i;
          values[k] = keepFloor(values[k], values[k] + (to - values[k]) * w);
        }
      }
    }
    report.applied++;
  });
  return report;
}

/** Whether a point is inside a stroke's reach. */
const inside = (op) => {
  const pts = strokeOf(op);
  const R = Number(op.radiusMM);
  return (x, y) => pts.length > 0 && R > 0 && distToStroke(pts, x, y) < R;
};

/**
 * Where a tree may stand, given the `clear` strokes: a function for
 * scatterCanopy's `where`, or null when nothing was cleared. Order counts,
 * as it does for the ground: only the clears made AFTER op `after` apply,
 * so a wood planted where the ground was cleared earlier grows, and one
 * cleared after it was planted does not. The map's own woods come before
 * every edit, so every clear applies to them.
 */
export function clearFilter(ops, after = -1) {
  const cleared = ops.map((op, i) => (op.op === 'clear' && i > after ? inside(op) : null)).filter(Boolean);
  if (!cleared.length) return null;
  return (x, y) => !cleared.some((f) => f(x, y));
}

/**
 * A small, stable number from a stroke -- its line, its width and its kind,
 * not its place in the list -- so a planted wood keeps its trees whatever
 * the map's seed, and whatever is taken off the list before it.
 */
function strokeSeed(op) {
  let h = Math.imul(2166136261 ^ Math.round((Number(op.radiusMM) || 0) * 10), 16777619);
  for (const ch of String(op.kind || '')) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  for (const [x, y] of strokeOf(op)) {
    h = Math.imul(h ^ Math.round(x * 10), 16777619);
    h = Math.imul(h ^ Math.round(y * 10), 16777619);
  }
  return (h >>> 0) % 100000 + 1;
}

/**
 * The woods the `plant` strokes ask for, each as the options scatterCanopy
 * takes: a kind, a density, its own seed, the stroke as `inside`, and its
 * `index` in the list, for clearFilter. The caller adds the ground's wet
 * mask and keeps trees off canopy already there.
 */
export function plantings(ops) {
  const out = [];
  ops.forEach((op, index) => {
    if (op.op !== 'plant' || !strokeOf(op).length || !(Number(op.radiusMM) > 0)) return;
    const base = PLANT_KINDS[op.kind] || PLANT_KINDS.deciduous;
    out.push({
      ...base,
      ...(Number.isFinite(op.density) ? { density: Math.max(0, Math.min(1, op.density)) } : {}),
      seed: strokeSeed(op),
      index,
      inside: inside(op),
    });
  });
  return out;
}
