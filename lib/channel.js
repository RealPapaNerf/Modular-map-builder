// channel.js — the channels, drawn by hand and cut into one module.
//
// A channel is a LINE YOU DREW, a width and a depth. It is cut that deep
// below the ground along its line, in the cross-section contract.js
// describes -- a parenthesis on its side -- and where its end comes to the
// rim it is snapped to that side's port, so the module hands it over in the
// one shape every module agrees on.
//
// A GORGE, OR A CREEK DOWN THE FACE. A channel whose line crosses a ridge
// -- rises over ground well above both of its ends -- is a GORGE: water does
// not run uphill, so its floor is held to the lowest it has been so far and
// it cuts through the high ground as deep as the ridge is high, the
// cross-section going to walls. Any other channel is a CREEK on the
// surface: it follows the ground down the face, 10 mm below it, cutting
// through a small bump (up to twice its depth) but riding over anything
// bigger rather than slicing the mountain open. `mode` on a channel says
// which outright: 'gorge', 'surface', or 'auto' (the default). The last stretch before a port is eased onto that port's floor,
// which is the one height two modules have to agree on; where the ground
// along the line has already taken the floor below the port's, the water
// ponds behind the port and the report says so.
//
// Everything here is millimetres on the plate, in the module's own frame:
// x east, y north, (0, 0) at the south-west corner.

import { EDGES, STEP, portFloorAt, edgeLand, channelShape, hasPort } from './contract.js';
import { Heap } from './heap.js';
import { fbm } from './noise.js';

const smoothstep = (t) => { const u = Math.max(0, Math.min(1, t)); return u * u * (3 - 2 * u); };

export const CHANNEL_DEFAULTS = {
  mode: 'auto', // 'auto' | 'gorge' | 'surface'; see above
  ridgeMM: 8, // how far the ground along a line must rise above both its ends to count as crossing a ridge
  widthMM: 30, // bank to bank
  depthMM: null, // null: the contract's channelDepthMM
  // How much water is drawn in the channel, above its floor. Drawing only:
  // the print is the channel.
  waterDepthMM: 3,
};

/** Where a port sits on the module's boundary, and which way is inward. */
export function portPoint(c, edge) {
  const h = c.tileMM / 2;
  switch (edge) {
    case 'N': return { x: h, y: c.tileMM, inward: [0, -1] };
    case 'S': return { x: h, y: 0, inward: [0, 1] };
    case 'E': return { x: c.tileMM, y: h, inward: [-1, 0] };
    case 'W': return { x: 0, y: h, inward: [1, 0] };
    default: throw new Error(`unknown edge ${edge}`);
  }
}

/** An end of a routed channel: an edge letter is its port, [x, y] is that point on the module. */
export function endPoint(c, end) {
  if (typeof end === 'string') return portPoint(c, end);
  const T = c.tileMM;
  const x = Math.max(0, Math.min(T, Number(end[0]) || 0));
  const y = Math.max(0, Math.min(T, Number(end[1]) || 0));
  return { x, y, inward: [0, 0] };
}

/** True for an edge letter, as opposed to a point. */
export const isEdge = (end) => typeof end === 'string' && EDGES.includes(end);

/** The edge a point is nearest, and how far it is from it. */
export function nearestEdge(c, x, y) {
  const d = { W: x, E: c.tileMM - x, S: y, N: c.tileMM - y };
  let best = null;
  for (const e of EDGES) if (!best || d[e] < d[best]) best = e;
  return { edge: best, distMM: d[best] };
}

/* ---------------------------------------------------------------- routing */

/**
 * The path a river would take if nobody drew one: least cost from one port
 * to the other over the ground. Kept for a channel given as `from` and `to`
 * without a line -- the generator finds the valley the ice left.
 *
 *   distance    so it does not take scenic detours for nothing.
 *   height      water prefers low ground, normalised against the module's
 *               own relief.
 *   climbing    paid only going UP, or a path will cross a ridge if the far
 *               side is low enough to pay for it.
 *   wander      small deterministic noise, so a floodplain route is not a
 *               ruler line.
 */
export function valleyPath(local, c, from, to, o = {}) {
  const { lowBias = 7.0, climbPenalty = 2.2, wander = 0.55, wanderScaleMM = 46, seed = 1, grid = 72, smoothPasses = 4 } = o;
  const T = c.tileMM;
  const n = Math.max(16, Math.min(grid, local.nx));
  const step = T / (n - 1);
  const a = endPoint(c, from);
  const b = endPoint(c, to);

  const z = new Float64Array(n * n);
  let lo = Infinity;
  let hi = -Infinity;
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const gi = Math.min(local.nx - 1, Math.round((i * step) / local.step));
      const gj = Math.min(local.ny - 1, Math.round((j * step) / local.step));
      const v = local.values[gj * local.nx + gi];
      z[j * n + i] = v;
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
  }
  const relief = Math.max(1e-6, hi - lo);
  const noiseAt = (i, j) => fbm(i * step, j * step, { scale: wanderScaleMM, octaves: 3, seed });
  const idx = (i, j) => j * n + i;
  const cell = (p) => ({ i: Math.min(n - 1, Math.max(0, Math.round(p.x / step))), j: Math.min(n - 1, Math.max(0, Math.round(p.y / step))) });
  const inset = (p) => { const q = cell(p); return { i: Math.min(n - 1, Math.max(0, q.i + p.inward[0])), j: Math.min(n - 1, Math.max(0, q.j + p.inward[1])) }; };
  const s0 = inset(a);
  const s1 = inset(b);
  const start = idx(s0.i, s0.j);
  const goal = idx(s1.i, s1.j);

  const dist = new Float64Array(n * n).fill(Infinity);
  const prev = new Int32Array(n * n).fill(-1);
  const done = new Uint8Array(n * n);
  const heap = new Heap(n * n);
  dist[start] = 0;
  heap.push(0, start);
  const NB = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];
  while (heap.n > 0) {
    const k = heap.pop();
    if (done[k]) continue;
    done[k] = 1;
    if (k === goal) break;
    const i = k % n;
    const j = (k - i) / n;
    for (const [di, dj] of NB) {
      const ni = i + di;
      const nj = j + dj;
      if (ni < 0 || nj < 0 || ni >= n || nj >= n) continue;
      const nk = idx(ni, nj);
      if (done[nk]) continue;
      const len = Math.hypot(di, dj) * step;
      const dz = z[nk] - z[k];
      const cost = len * (1 + (lowBias * (z[nk] - lo)) / relief + wander * (0.5 + 0.5 * noiseAt(ni, nj))) + climbPenalty * Math.max(0, dz);
      const nd = dist[k] + cost;
      if (nd < dist[nk]) { dist[nk] = nd; prev[nk] = k; heap.push(nd, nk); }
    }
  }
  const chain = [];
  if (prev[goal] >= 0 || goal === start) {
    for (let k = goal; k !== -1; k = prev[k]) {
      chain.push([(k % n) * step, Math.floor(k / n) * step]);
      if (k === start) break;
    }
    chain.reverse();
  }
  const pts = [[a.x, a.y], ...chain, [b.x, b.y]];
  for (let p = 0; p < smoothPasses; p++) {
    for (let i = 1; i < pts.length - 1; i++) {
      pts[i] = [0.25 * pts[i - 1][0] + 0.5 * pts[i][0] + 0.25 * pts[i + 1][0], 0.25 * pts[i - 1][1] + 0.5 * pts[i][1] + 0.25 * pts[i + 1][1]];
    }
  }
  return pts;
}

/**
 * Push a routed path sideways into meanders where the valley has room, and
 * leave it alone in a gorge: the ground is probed either side, and where it
 * rises steeply the river stays where the routing put it. Both ends taper
 * to zero so the ports stay put.
 */
export function meanderPath(pts, local, o = {}) {
  const { amplitudeMM = 28, wavelengthMM = 45, probeMM = 12, confineMM = 7, keepInsideMM = 26, seed = 1 } = o;
  if (pts.length < 5 || amplitudeMM <= 0) return pts;
  const extent = (local.nx - 1) * local.step;
  const sampleAt = (x, y) => {
    const i = Math.min(local.nx - 1, Math.max(0, Math.round(x / local.step)));
    const j = Math.min(local.ny - 1, Math.max(0, Math.round(y / local.step)));
    return local.values[j * local.nx + i];
  };
  const m = measure(pts);
  return pts.map((p, i) => {
    if (i === 0 || i === pts.length - 1) return [p[0], p[1]];
    const a = pts[i - 1];
    const b = pts[i + 1];
    const tx = b[0] - a[0];
    const ty = b[1] - a[1];
    const len = Math.hypot(tx, ty) || 1;
    const nx2 = -ty / len;
    const ny2 = tx / len;
    const zc = sampleAt(p[0], p[1]);
    const rise = Math.max(sampleAt(p[0] + nx2 * probeMM, p[1] + ny2 * probeMM), sampleAt(p[0] - nx2 * probeMM, p[1] - ny2 * probeMM)) - zc;
    const freedom = Math.max(0, Math.min(1, 1 - rise / confineMM));
    const taper = Math.sin(Math.PI * m.t[i]);
    const wave = Math.max(-1, Math.min(1, 2.2 * fbm(m.s[i] / wavelengthMM, 0, { scale: 1, octaves: 3, seed })));
    const off = amplitudeMM * freedom * taper * wave;
    const lim = keepInsideMM;
    return [Math.max(lim, Math.min(extent - lim, p[0] + nx2 * off)), Math.max(lim, Math.min(extent - lim, p[1] + ny2 * off))];
  });
}

/* ------------------------------------------------------------------ paths */

/** Arc length along [x, y] points: s per point, t in 0..1, and the total. */
export function measure(pts) {
  const s = new Float64Array(pts.length);
  for (let i = 1; i < pts.length; i++) s[i] = s[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
  const L = s[pts.length - 1] || 0;
  const t = Float64Array.from(s, (v) => (L > 0 ? v / L : 0));
  return { s, t, lengthMM: L };
}

/** The same line, sampled every `stepMM` or so, ends kept exactly. */
export function resample(pts, stepMM) {
  if (pts.length < 2) return pts.map((p) => [p[0], p[1]]);
  const m = measure(pts);
  const n = Math.max(2, Math.ceil(m.lengthMM / stepMM) + 1);
  const out = [];
  let seg = 1;
  for (let k = 0; k < n; k++) {
    const want = (m.lengthMM * k) / (n - 1);
    while (seg < pts.length - 1 && m.s[seg] < want) seg++;
    const a = pts[seg - 1];
    const b = pts[seg];
    const span = m.s[seg] - m.s[seg - 1];
    const f = span > 0 ? (want - m.s[seg - 1]) / span : 0;
    out.push([a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f]);
  }
  out[0] = [pts[0][0], pts[0][1]];
  out[n - 1] = [pts[pts.length - 1][0], pts[pts.length - 1][1]];
  return out;
}

/**
 * A drawn line, made into one a module can hand over: each end within
 * portSnapMM of the rim goes to that side's port and leaves it square;
 * everything else is kept at least half a width in from the rim, so the
 * banks never run under the contract. Returns the points and which edges
 * the two ends cross, or null for an end inside the module.
 */
export function snapToPorts(c, path, widthMM) {
  const T = c.tileMM;
  const pts = path.map((p) => [Number(p[0]), Number(p[1])]).filter((p) => Number.isFinite(p[0]) && Number.isFinite(p[1]));
  if (pts.length < 2) return null;
  const margin = Math.min(T / 4, Math.max(2, widthMM / 2));
  const clampIn = (p) => [Math.max(margin, Math.min(T - margin, p[0])), Math.max(margin, Math.min(T - margin, p[1]))];
  const endEdge = (p) => {
    const { edge, distMM } = nearestEdge(c, p[0], p[1]);
    return distMM <= c.portSnapMM ? edge : null;
  };
  const from = endEdge(pts[0]);
  const to = endEdge(pts[pts.length - 1]);
  const inner = pts.slice(from ? 1 : 0, to ? pts.length - 1 : pts.length).map(clampIn);
  // The run-in at a port: the port on the rim, then a point one half-width
  // inside along the normal, so the channel crosses the seam square.
  const lead = (edge) => {
    const pp = portPoint(c, edge);
    const inset = Math.max(6, widthMM / 2);
    return [[pp.x, pp.y], [pp.x + pp.inward[0] * inset, pp.y + pp.inward[1] * inset]];
  };
  let out = [];
  if (from) out.push(...lead(from));
  out.push(...inner);
  if (to) out.push(...lead(to).reverse());
  // Two points on top of each other make a zero-length segment, which the
  // nearest-point search is happy with but the smoothing is not.
  out = out.filter((p, i) => i === 0 || Math.hypot(p[0] - out[i - 1][0], p[1] - out[i - 1][1]) > 1e-6);
  if (out.length < 2) return null;
  // The same ends cannot both snap to one port: that is a line that went out
  // and came straight back, and it is not a channel.
  if (from && to && from === to) return null;
  return { pts: out, from, to };
}

/* ------------------------------------------------------------------- plan */

/**
 * Every channel the module has, ready to carve: the line sampled every
 * couple of millimetres, and at each sample its floor, its width and its
 * depth. Reads `spec.channels`; a channel with `from`/`to` and no `path` is
 * routed down the valley on `local`, the ground as grown.
 *
 * Returns the channels and the ports they cross, which the contract needs
 * to know before the rim can be conformed.
 */
export function planChannels(c, spec, local, { seed = 1, sampleMM = 2 } = {}) {
  const chans = [];
  const ports = {};
  const notes = [];
  const defaults = { ...CHANNEL_DEFAULTS, ...(spec.channelDefaults || {}) };
  (spec.channels || []).forEach((ch, index) => {
    if (!ch || typeof ch !== 'object') return;
    const name = ch.name || `channel ${index + 1}`;
    const widthMM = Math.max(4, Number(ch.widthMM) || defaults.widthMM);
    const depthMM = Math.max(0.5, Number.isFinite(ch.depthMM) ? ch.depthMM : (defaults.depthMM ?? c.channelDepthMM));
    let raw = Array.isArray(ch.path) && ch.path.length >= 2 ? ch.path : null;
    let routed = false;
    const endOK = (e) => isEdge(e) || (Array.isArray(e) && e.length === 2 && e.every(Number.isFinite));
    if (!raw && endOK(ch.from) && endOK(ch.to) && !(isEdge(ch.from) && ch.from === ch.to)) {
      const o = { seed: seed * 7 + index, ...(ch.route || {}) };
      raw = meanderPath(valleyPath(local, c, ch.from, ch.to, o), local, o);
      routed = true;
    }
    if (!raw) { notes.push({ severity: 'warning', message: `${name} has no line and no ports, so there is nothing to cut.` }); return; }
    const snapped = snapToPorts(c, raw, widthMM);
    if (!snapped) { notes.push({ severity: 'warning', message: `${name} is too short to be a channel, or leaves by the side it came in.` }); return; }
    for (const e of [snapped.from, snapped.to]) {
      if (!e) continue;
      if (ports[e]) notes.push({ severity: 'warning', message: `${name} and ${ports[e]} both cross the ${e} side. There is one port a side; they share it.` });
      else ports[e] = name;
    }
    // Water comes in high and goes out low: the side it enters by has to be
    // a higher class than the side it leaves by, or there is no fall.
    if (snapped.from && snapped.to) {
      const fin = portFloorAt(c, snapped.from);
      const fout = portFloorAt(c, snapped.to);
      if (fin <= fout) {
        notes.push({
          severity: 'warning',
          message: `${name} comes in by the ${snapped.from} side (floor ${fin.toFixed(0)} mm) and goes out by the ${snapped.to} side (floor ${fout.toFixed(0)} mm): ` +
                   `${fin === fout ? 'no fall across the module' : 'it would have to climb'}. Give the ${snapped.from} side a higher class, or the ${snapped.to} side a lower one.`,
        });
      }
    }
    const pts = resample(snapped.pts, sampleMM);
    chans.push({ index, name, pts, widthMM, depthMM, from: snapped.from, to: snapped.to, routed, mode: ['gorge', 'surface'].includes(ch.mode) ? ch.mode : 'auto', ridgeMM: Number.isFinite(ch.ridgeMM) ? ch.ridgeMM : defaults.ridgeMM, waterDepthMM: Number.isFinite(ch.waterDepthMM) ? ch.waterDepthMM : defaults.waterDepthMM });
  });
  return { channels: chans, ports: Object.fromEntries(EDGES.map((e) => [e, !!ports[e]])), portOwners: ports, notes };
}

/**
 * Give each channel its floor, width and depth along its line, read off the
 * ground as it stands NOW. That ground should be leaned onto a LAND rim on
 * every side (cutTile leaves it so): leaned onto the ports as well, the
 * port's own dip would be in the ground the line is read from, and the bed
 * would dive below the port floor just inland of every port.
 */
export function profileChannels(local, c, channels) {
  const { nx, ny, step } = local;
  const ground = (x, y) => {
    const u = Math.max(0, Math.min(nx - 1, x / step));
    const v = Math.max(0, Math.min(ny - 1, y / step));
    const i = Math.min(nx - 2, Math.floor(u));
    const j = Math.min(ny - 2, Math.floor(v));
    const fu = u - i;
    const fv = v - j;
    const z = (a, b) => local.values[b * nx + a];
    return (z(i, j) * (1 - fu) + z(i + 1, j) * fu) * (1 - fv) + (z(i, j + 1) * (1 - fu) + z(i + 1, j + 1) * fu) * fv;
  };
  for (const ch of channels) {
    const n = ch.pts.length;
    const m = measure(ch.pts);
    const g = new Float64Array(n);
    for (let i = 0; i < n; i++) g[i] = ground(ch.pts[i][0], ch.pts[i][1]);
    // Smoothed along the line over about a width either way, so the bed is
    // smoother than the ground it is cut in. Read from a frozen copy.
    const spacing = n > 1 ? m.lengthMM / (n - 1) : 1;
    const half = Math.max(1, Math.round(ch.widthMM / Math.max(1e-6, spacing)));
    const sm = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      let sum = 0;
      let cnt = 0;
      for (let k = Math.max(0, i - half); k <= Math.min(n - 1, i + half); k++) { sum += g[k]; cnt++; }
      sm[i] = sum / cnt;
    }
    const blend = Math.max(ch.widthMM, c.portWidthMM); // how far in a port's shape reaches
    const pfIn = ch.from ? portFloorAt(c, ch.from) : null;
    const pfOut = ch.to ? portFloorAt(c, ch.to) : null;
    const portDepth = (e) => edgeLand(c, e) - portFloorAt(c, e);

    // THE BED, before the end treatments: the smoothed ground one depth
    // down, eased onto the entry port's floor at the start, and then held
    // to the lowest it has been so far -- the gorge rule. From here on the
    // floor only ever falls.
    // The exit port is eased in here as well, so ground that falls toward
    // the exit hands the bed to the port floor from above; only a line that
    // has already gone BELOW that floor somewhere ponds.
    // GORGE OR CREEK: does the line cross a ridge -- rise over ground well
    // above both of its ends?
    // Read off the ground itself, not the smoothed bed: smoothing shaves a
    // narrow ridge down below the threshold.
    let top = -Infinity;
    for (let i = 0; i < n; i++) if (g[i] > top) top = g[i];
    const rise = top - Math.max(g[0], g[n - 1]);
    const gorge = ch.mode === 'gorge' || (ch.mode !== 'surface' && rise > (ch.ridgeMM ?? 8));
    ch.isGorge = gorge;
    ch.ridgeRiseMM = Math.max(0, rise);
    const bed = new Float64Array(n);
    let run = Infinity;
    for (let i = 0; i < n; i++) {
      let f = sm[i] - ch.depthMM;
      if (ch.from) { const k = smoothstep(m.s[i] / blend); f = pfIn + (f - pfIn) * k; }
      if (ch.to) { const k = smoothstep((m.lengthMM - m.s[i]) / blend); f = pfOut + (f - pfOut) * k; }
      run = Math.min(run, f);
      // A gorge never rises. A creek may, where the ground does by more than
      // its depth: it rides over the bump rather than slicing through it.
      bed[i] = gorge ? run : Math.max(run, f - ch.depthMM);
      if (!gorge) run = bed[i];
    }

    const floor = new Float64Array(n);
    const width = new Float64Array(n);
    const depth = new Float64Array(n);
    let pond = 0;
    for (let i = 0; i < n; i++) {
      let f = bed[i];
      let w = ch.widthMM;
      // The bank top is the ground: through a rise the channel is as deep
      // as the rise is high, and the cross-section goes to walls.
      let d = Math.max(ch.depthMM, sm[i] - f);
      const kIn = smoothstep(m.s[i] / blend);
      const kOut = smoothstep((m.lengthMM - m.s[i]) / blend);
      if (ch.from) {
        // The entry port: the contract's width and depth take over.
        w = c.portWidthMM + (w - c.portWidthMM) * kIn;
        d = portDepth(ch.from) + (d - portDepth(ch.from)) * kIn;
      } else {
        // A free start: the channel deepens from nothing.
        d *= kIn;
        f = sm[i] - d;
      }
      if (ch.to) {
        // The exit port: eased onto its floor. If the bed is already below
        // that floor the water cannot get out at the bottom: it ponds.
        const lifted = Math.max(f, pfOut + (f - pfOut) * kOut);
        if (lifted > f + 1e-9) pond = Math.max(pond, lifted - f);
        f = lifted;
        w = c.portWidthMM + (w - c.portWidthMM) * kOut;
        d = portDepth(ch.to) + (d - portDepth(ch.to)) * kOut;
      } else {
        // A free end: the channel shallows out to nothing, so it does not
        // stop at a cliff.
        d = (sm[i] - f) * kOut;
        f = sm[i] - d;
      }
      floor[i] = Math.max(c.minChannelFloorMM, f);
      width[i] = w;
      depth[i] = Math.max(0, d);
    }
    ch.floor = floor;
    ch.width = width;
    ch.depth = depth;
    ch.s = m.s;
    ch.t = m.t;
    ch.lengthMM = m.lengthMM;
    let lowest = Infinity;
    let deeper = 0;
    for (let i = 0; i < n; i++) {
      if (floor[i] < lowest) lowest = floor[i];
      if (depth[i] - ch.depthMM > deeper) deeper = depth[i] - ch.depthMM;
    }
    // A creek that rides over a rise ponds behind it: how much, the most.
    let climb = 0;
    let lo = Infinity;
    for (let i = 0; i < n; i++) { lo = Math.min(lo, floor[i]); if (floor[i] - lo > climb && (!ch.to || m.lengthMM - m.s[i] > blend)) climb = floor[i] - lo; }
    ch.startFloorMM = floor[0];
    ch.endFloorMM = floor[n - 1];
    ch.lowestFloorMM = lowest;
    // How far the bed has to come back UP to reach the exit port, which is
    // the only place it ever rises: water that deep stands behind the port.
    ch.climbMM = gorge ? pond : Math.max(pond, climb);
    ch.pondMM = pond;
    // How much deeper than drawn the channel had to go through high ground.
    ch.gorgeMM = gorge ? deeper : 0;
    ch.cutDeeperMM = deeper;
  }
  return channels;
}

/** Nearest sample of a channel's line to (x, y): distance and index, with the fraction between samples. */
function nearest(ch, x, y) {
  const p = ch.pts;
  let bd = Infinity;
  let bi = 0;
  let bf = 0;
  for (let i = 1; i < p.length; i++) {
    const ax = p[i - 1][0];
    const ay = p[i - 1][1];
    const dx = p[i][0] - ax;
    const dy = p[i][1] - ay;
    const len2 = dx * dx + dy * dy;
    let u = len2 > 0 ? ((x - ax) * dx + (y - ay) * dy) / len2 : 0;
    u = u < 0 ? 0 : u > 1 ? 1 : u;
    const d = Math.hypot(x - (ax + u * dx), y - (ay + u * dy));
    if (d < bd) { bd = d; bi = i - 1; bf = u; }
  }
  return { dist: bd, i: bi, f: bf };
}

/**
 * Cut the channels into the module's height field, in place.
 *
 * Only ever CUTS. At each cell the channel's cross-section is worked out
 * from the nearest point of the line -- its floor, its width, its depth
 * there -- and the ground is lowered to it where the ground is higher. A
 * bank that is already below the curve is left as it is, which is what
 * happens when a channel is cut across a hillside: the uphill bank is the
 * cut, the downhill bank is the hill.
 *
 * Returns the cells that are water (`wet`), the water's surface over them
 * (`water`, NaN elsewhere), and how many cells changed.
 */
export function carveChannels(local, c, channels) {
  const { nx, ny, step } = local;
  const wet = new Uint8Array(nx * ny);
  const water = new Float32Array(nx * ny).fill(NaN);
  let cells = 0;
  for (const ch of channels) {
    if (!ch.floor) throw new Error('profileChannels has to run before carveChannels');
    let maxW = 0;
    for (let i = 0; i < ch.width.length; i++) if (ch.width[i] > maxW) maxW = ch.width[i];
    // Only the cells within reach of the line, not the whole module.
    let x0 = Infinity; let y0 = Infinity; let x1 = -Infinity; let y1 = -Infinity;
    for (const [x, y] of ch.pts) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
    const R = maxW / 2 + step;
    const i0 = Math.max(0, Math.floor((x0 - R) / step));
    const i1 = Math.min(nx - 1, Math.ceil((x1 + R) / step));
    const j0 = Math.max(0, Math.floor((y0 - R) / step));
    const j1 = Math.min(ny - 1, Math.ceil((y1 + R) / step));
    for (let j = j0; j <= j1; j++) {
      const y = j * step;
      for (let i = i0; i <= i1; i++) {
        const x = i * step;
        const { dist, i: si, f } = nearest(ch, x, y);
        const at = (arr) => arr[si] + (arr[Math.min(arr.length - 1, si + 1)] - arr[si]) * f;
        const half = at(ch.width) / 2;
        if (dist >= half) continue;
        const depth = at(ch.depth);
        if (depth <= 1e-6) continue;
        const floor = at(ch.floor);
        const target = floor + depth * (1 - channelShape(dist / half, depth / half));
        const k = j * nx + i;
        const here = local.values[k];
        const level = floor + Math.min(ch.waterDepthMM, depth * 0.6);
        if (target < here - 1e-9) { local.values[k] = target; cells++; }
        if (Math.min(here, target) < level - 1e-6) {
          wet[k] = 1;
          water[k] = Number.isNaN(water[k]) ? level : Math.max(water[k], level);
        }
      }
    }
  }
  return { cells, wet, water };
}

/**
 * Where a spring would go on a channel: on its line, as near its START as
 * the pool can sit clear of the rim, facing down the channel.
 */
export function springOnChannel(c, ch, clearMM) {
  const pts = ch.pts;
  let pick = 0;
  for (let i = 0; i < pts.length; i++) {
    const [x, y] = pts[i];
    if (Math.min(x, y, c.tileMM - x, c.tileMM - y) >= clearMM) { pick = i; break; }
  }
  const nxt = pts[Math.min(pts.length - 1, pick + 6)];
  const p = pts[pick];
  return { atMM: [p[0], p[1]], spillToward: Math.atan2(nxt[1] - p[1], nxt[0] - p[0]) };
}

export { hasPort, STEP };
