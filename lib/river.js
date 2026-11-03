// river.js — the channel, carved into one tile at a time.
//
// WHY PER TILE AND NOT ACROSS THE MAP. A river carved across the whole world
// and then sliced would have to hit inletZ and outletZ exactly at every cut,
// and it would not. Carving inside the tile instead makes the port heights an
// INPUT rather than something to be hit: the channel starts at the inlet
// height the contract declares and ends at the outlet height the contract
// declares, and the seam is correct by construction, not by luck. Two tiles
// never have to agree about anything except the contract.
//
// Everything here is millimetres on the plate, in tile-local coordinates with
// (0,0) at the south-west corner.

import { sizeFor, EDGES, portFloor } from './contract.js';
import { Heap } from './heap.js';
import { fbm } from './noise.js';

const smoothstep = (t) => { const u = Math.max(0, Math.min(1, t)); return u * u * (3 - 2 * u); };

/** Where a port sits on the tile's boundary, and which way the water goes. */
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

/**
 * A meandering path from one port to another.
 *
 * A straight line between two ports reads as a canal, and the printed pieces
 * it is replacing plainly do not have one. The path leaves each port along
 * the inward normal -- so the channel crosses the seam square and the two
 * halves line up in plan as well as in height -- and bows between them by an
 * amount drawn from the tile's own coordinates, so the same tile always
 * generates the same river.
 */
export function riverPath(c, fromEdge, toEdge, { seed = 1, col = 0, row = 0, meander = 0.22, samples = 96 } = {}) {
  const a = portPoint(c, fromEdge);
  const b = portPoint(c, toEdge);
  const T = c.tileMM;
  // Control points pushed in along each port's normal, then nudged sideways.
  const reach = T * 0.33;
  const jitter = (n) => fbm(col * 31.7 + n, row * 17.3 + n, { scale: 1, octaves: 2, seed });
  const c1 = {
    x: a.x + a.inward[0] * reach + jitter(1) * T * meander * Math.abs(a.inward[1]),
    y: a.y + a.inward[1] * reach + jitter(2) * T * meander * Math.abs(a.inward[0]),
  };
  const c2 = {
    x: b.x + b.inward[0] * reach + jitter(3) * T * meander * Math.abs(b.inward[1]),
    y: b.y + b.inward[1] * reach + jitter(4) * T * meander * Math.abs(b.inward[0]),
  };

  const pts = [];
  for (let i = 0; i <= samples; i++) {
    const t = i / samples;
    const u = 1 - t;
    pts.push({
      x: u * u * u * a.x + 3 * u * u * t * c1.x + 3 * u * t * t * c2.x + t * t * t * b.x,
      y: u * u * u * a.y + 3 * u * u * t * c1.y + 3 * u * t * t * c2.y + t * t * t * b.y,
    });
  }
  // Arc length, so the fall is spread evenly along the water rather than
  // along the parameter. A Bezier's parameter bunches at the ends and the
  // channel would come out flat in the middle and steep at the ports.
  let run = 0;
  pts[0].s = 0;
  for (let i = 1; i < pts.length; i++) {
    run += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
    pts[i].s = run;
  }
  for (const p of pts) p.t = run > 0 ? p.s / run : 0;
  return { pts, lengthMM: run };
}

/**
 * The path a river would actually take: least cost from one port to the
 * other, over the ground.
 *
 * WHY THIS REPLACED A CURVE. The first version drew a Bezier between the two
 * ports with a little noise on the control points. It never read the
 * terrain. So the glacier would spend thirty seconds carving a trough and
 * the river would then wander across it, over the shoulder and down the
 * other side, because nothing had told it the valley was there. A river that
 * ignores its own valley is the most visible thing that can be wrong with a
 * map like this.
 *
 * THE COST, and why it has three terms.
 *
 *   distance    so it does not take scenic detours for nothing.
 *   height      water prefers low ground. Normalised against the tile's own
 *               relief, so the same weight behaves the same on a mountain
 *               and on a plain.
 *   climbing    paid only going UP. Water does not climb, and without this
 *               term a path will happily cross a ridge if the far side is
 *               low enough to pay for it.
 *
 * And a fourth that is not physics but is needed: a WANDER term, small
 * deterministic noise added to the cost. On a floodplain every route costs
 * the same and the shortest is a straight line, which prints as a canal.
 * Real lowland rivers meander because of irregularities far too small to
 * model, so irregularities go in directly. On steep ground the height term
 * swamps it and the river sits in the valley floor; on flat ground it is all
 * there is and the river wanders. One cost function, both behaviours.
 */
export function valleyPath(local, c, fromEdge, toEdge, o = {}) {
  const {
    lowBias = 7.0,
    climbPenalty = 2.2,
    wander = 0.55,
    wanderScaleMM = 46,
    seed = 1,
    grid = 72,
    smoothPasses = 4,
  } = o;

  const T = c.tileMM;
  const n = Math.max(16, Math.min(grid, local.nx));
  const step = T / (n - 1);
  const a = portPoint(c, fromEdge);
  const b = portPoint(c, toEdge);

  // Sample the terrain onto the routing grid, and normalise it so lowBias
  // means the same thing whatever the relief.
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
  const cell = (p) => ({
    i: Math.min(n - 1, Math.max(0, Math.round(p.x / step))),
    j: Math.min(n - 1, Math.max(0, Math.round(p.y / step))),
  });
  // Start and end one cell in along the port normal, so the channel crosses
  // the seam square instead of arriving at an angle.
  const inset = (p) => {
    const q = cell(p);
    return { i: Math.min(n - 1, Math.max(0, q.i + p.inward[0])), j: Math.min(n - 1, Math.max(0, q.j + p.inward[1])) };
  };
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
      const cost = len * (1 + (lowBias * (z[nk] - lo)) / relief + wander * (0.5 + 0.5 * noiseAt(ni, nj)))
                 + climbPenalty * Math.max(0, dz);
      const nd = dist[k] + cost;
      if (nd < dist[nk]) { dist[nk] = nd; prev[nk] = k; heap.push(nd, nk); }
    }
  }

  if (prev[goal] < 0 && goal !== start) {
    // Should not happen on a connected grid, but a map is not worth losing
    // to a routing failure.
    return riverPath(c, fromEdge, toEdge, o);
  }

  const chain = [];
  for (let k = goal; k !== -1; k = prev[k]) {
    chain.push({ x: (k % n) * step, y: Math.floor(k / n) * step });
    if (k === start) break;
  }
  chain.reverse();
  // Anchor the real port positions on the boundary at each end.
  const pts = [{ x: a.x, y: a.y }, ...chain, { x: b.x, y: b.y }];

  // A grid path is a staircase. Smooth the interior, leaving the two ends
  // pinned so the ports stay exactly where the contract put them.
  for (let p = 0; p < smoothPasses; p++) {
    for (let i = 1; i < pts.length - 1; i++) {
      pts[i] = {
        x: 0.25 * pts[i - 1].x + 0.5 * pts[i].x + 0.25 * pts[i + 1].x,
        y: 0.25 * pts[i - 1].y + 0.5 * pts[i].y + 0.25 * pts[i + 1].y,
      };
    }
  }
  return measurePath(pts);
}

/**
 * Push a routed path sideways into meanders, as far as the valley allows.
 *
 * The least-cost route finds the valley floor, which is the important half,
 * but on flat ground every route costs about the same and it comes back
 * nearly straight -- sinuosity 1.002, which prints as a canal. Raising the
 * noise in the cost did not fix that: it saturates around 1.07, because a
 * detour has to pay for its own extra length and a cost field can only
 * discount so much.
 *
 * So meandering goes in as what it actually is. A river meanders where it
 * has room -- on a floodplain, by eroding one bank and building the other --
 * and it does not meander in a gorge, because the walls are in the way. The
 * offset is therefore scaled by how FREE each point is: probe the ground to
 * either side, and where it rises steeply, stop pushing. Both behaviours
 * fall out of one number.
 *
 * Both ends taper to zero, so the ports stay exactly where the contract put
 * them.
 */
export function meanderPath(path, local, o = {}) {
  const {
    amplitudeMM = 28,
    wavelengthMM = 45,
    probeMM = 12,
    confineMM = 7,
    keepInsideMM = 26, // the bend must not carry the channel into the rim
    seed = 1,
  } = o;
  const pts = path.pts;
  if (pts.length < 5 || amplitudeMM <= 0) return path;
  const extent = (local.nx - 1) * local.step;

  const sampleAt = (x, y) => {
    const i = Math.min(local.nx - 1, Math.max(0, Math.round(x / local.step)));
    const j = Math.min(local.ny - 1, Math.max(0, Math.round(y / local.step)));
    return local.values[j * local.nx + i];
  };

  const out = pts.map((p, i) => {
    if (i === 0 || i === pts.length - 1) return { x: p.x, y: p.y };
    const a = pts[i - 1];
    const b = pts[i + 1];
    const tx = b.x - a.x;
    const ty = b.y - a.y;
    const len = Math.hypot(tx, ty) || 1;
    const nx2 = -ty / len;
    const ny2 = tx / len;

    // How boxed in is this point? If the ground rises sharply either side,
    // the river is in a gorge and stays where the routing put it.
    const zc = sampleAt(p.x, p.y);
    const zl = sampleAt(p.x + nx2 * probeMM, p.y + ny2 * probeMM);
    const zr = sampleAt(p.x - nx2 * probeMM, p.y - ny2 * probeMM);
    const rise = Math.max(zl, zr) - zc;
    const freedom = Math.max(0, Math.min(1, 1 - rise / confineMM));

    const taper = Math.sin(Math.PI * p.t);
    // fbm rarely reaches its nominal range, so it is stretched and clipped.
    // Without that, amplitudeMM means "about 40% of this if you are lucky"
    // and the number in the spec file is not the number on the plate.
    const wave = Math.max(-1, Math.min(1, 2.2 * fbm(p.s / wavelengthMM, 0, { scale: 1, octaves: 3, seed })));
    const off = amplitudeMM * freedom * taper * wave;
    let x = p.x + nx2 * off;
    let y = p.y + ny2 * off;
    // A bend that wandered into the rim would fight the contract, which
    // always wins, and the channel would come out mangled at the edge.
    const lim = keepInsideMM;
    x = Math.max(lim, Math.min(extent - lim, x));
    y = Math.max(lim, Math.min(extent - lim, y));
    return { x, y };
  });
  return measurePath(out);
}

/** Arc length along a polyline, so the fall is spread evenly along the water. */
function measurePath(pts) {
  let run = 0;
  pts[0].s = 0;
  for (let i = 1; i < pts.length; i++) {
    run += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
    pts[i].s = run;
  }
  for (const p of pts) p.t = run > 0 ? p.s / run : 0;
  return { pts, lengthMM: run };
}

/** Nearest point on a sampled path: distance, and how far along it. */
function nearest(path, x, y) {
  let bd = Infinity;
  let bt = 0;
  const p = path.pts;
  for (let i = 1; i < p.length; i++) {
    const ax = p[i - 1].x, ay = p[i - 1].y;
    const dx = p[i].x - ax, dy = p[i].y - ay;
    const len2 = dx * dx + dy * dy;
    let u = len2 > 0 ? ((x - ax) * dx + (y - ay) * dy) / len2 : 0;
    u = u < 0 ? 0 : u > 1 ? 1 : u;
    const d = Math.hypot(x - (ax + u * dx), y - (ay + u * dy));
    if (d < bd) { bd = d; bt = p[i - 1].t + u * (p[i].t - p[i - 1].t); }
  }
  return { dist: bd, t: bt };
}

/**
 * Work out which paths this tile's ports imply.
 *
 * One in and one out is a through-run. Several inlets is a confluence: each
 * inlet runs to a junction placed a little upstream of the outlet, and the
 * junction carries the widest of them onward. An inlet with no outlet is a
 * sink -- a lake with no exit -- and is left to the caller to notice.
 */
export function planChannels(c, spec, o = {}) {
  const terrain = o.local || null;
  const route = (from, to, ro = {}) => {
    if (!terrain) return riverPath(c, from, to, { ...o, ...ro });
    const opts = { ...o, ...ro };
    return meanderPath(valleyPath(terrain, c, from, to, opts), terrain, opts);
  };
  const edges = spec.edges || {};
  const inZ = portFloor(c, spec, 'in');
  const outZ = portFloor(c, spec, 'out');
  const ins = EDGES.filter((e) => edges[e]?.type === 'in');
  const outs = EDGES.filter((e) => edges[e]?.type === 'out');
  const chans = [];
  if (!ins.length && !outs.length) return chans;

  if (outs.length === 1 && ins.length <= 1) {
    const from = ins[0] || outs[0];
    if (ins.length === 0) {
      // A spring: water rises in the tile and leaves. Carve from the middle.
      const b = portPoint(c, outs[0]);
      const path = { pts: [], lengthMM: 0 };
      const a = { x: c.tileMM / 2, y: c.tileMM / 2 };
      const n = 48;
      let run = 0;
      for (let i = 0; i <= n; i++) {
        const t = i / n;
        const p = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
        if (i > 0) run += Math.hypot(p.x - path.pts[i - 1].x, p.y - path.pts[i - 1].y);
        p.s = run;
        path.pts.push(p);
      }
      for (const p of path.pts) p.t = run > 0 ? p.s / run : 0;
      path.lengthMM = run;
      chans.push({ path, fromZ: inZ, toZ: outZ, size: edges[outs[0]].size, spring: true });
      return chans;
    }
    chans.push({
      path: route(from, outs[0]),
      fromZ: inZ,
      toZ: outZ,
      size: edges[outs[0]].size,
    });
    return chans;
  }

  // Confluence, or a split. Every inlet runs to the single outlet; where
  // there are several outlets each inlet feeds the first of them and the
  // rest are fed from the junction. Both carve the same way.
  const target = outs[0] || ins[0];
  for (const e of ins) {
    if (e === target) continue;
    chans.push({
      path: route(e, target, { meander: (o.meander ?? 0.22) * 0.6 }),
      fromZ: inZ,
      toZ: outZ,
      size: edges[e].size,
    });
  }
  for (const e of outs.slice(1)) {
    chans.push({
      path: route(ins[0] || outs[0], e),
      fromZ: inZ,
      toZ: outZ,
      size: edges[e].size,
    });
  }
  return chans;
}

/**
 * Cut the channels into a tile's height field, in place.
 *
 * The floor falls linearly in ARC LENGTH from fromZ to toZ, which is what
 * makes the gradient constant, and the banks rise back to whatever the
 * terrain was doing with the same smoothstep the edge profile uses -- so a
 * bank that starts at the boundary carries on inland without a crease.
 *
 * Terrain is never raised, only cut: a channel through a hill is a gorge, not
 * a viaduct.
 */
export function carveChannels(local, c, channels, { deepenFloorMM = 0 } = {}) {
  const { nx, ny, step } = local;
  // Which cells ended up as water. The preview used to guess this from a
  // height threshold, which stopped working the moment land heights varied
  // per corner; knowing it from the carve is both simpler and right.
  const wet = new Uint8Array(nx * ny);
  let cells = 0;
  for (const ch of channels) {
    const size = sizeFor(ch.size);
    const half = size.widthMM / 2;
    // A bay or a fjord mouth is an OPENING, not a channel. Its lip is short
    // and steep so the water body reads as cut into the tile rather than as
    // a very wide river with very long banks.
    const bank = size.kind === 'water-body' ? size.bankMM * 0.45 : size.bankMM;
    for (let j = 0; j < ny; j++) {
      const y = j * step;
      for (let i = 0; i < nx; i++) {
        const x = i * step;
        const { dist, t } = nearest(ch.path, x, y);
        if (dist > half + bank + Math.max(1e-6, c.leveeFalloffMM)) continue;
        const floor = ch.fromZ + (ch.toZ - ch.fromZ) * t - deepenFloorMM;
        const k = j * nx + i;
        const here = local.values[k];
        // The channel both CUTS and FILLS. With falls up to 50 mm the bed
        // enters a tile 52 mm above its base, which is usually above the
        // ground there, so a carve that only ever removed material left the
        // top of the river with no channel at all and no banks to hold it.
        // The bank rises to whichever is higher -- the ground, or a
        // freeboard over the water -- and eases back to the ground beyond,
        // which is the same levee the edge profile builds. See contract.js.
        const bankTop = Math.max(here, floor + c.bankAboveMM);
        let target;
        if (dist <= half) { target = floor; wet[k] = 1; }
        else if (dist <= half + bank) target = floor + (bankTop - floor) * smoothstep((dist - half) / bank);
        else if (bankTop <= here + 1e-9) continue;
        else {
          const fall = Math.max(1e-6, c.leveeFalloffMM);
          if (dist >= half + bank + fall) continue;
          target = bankTop + (here - bankTop) * smoothstep((dist - half - bank) / fall);
        }
        if (Math.abs(target - here) > 1e-9) { local.values[k] = target; cells++; }
      }
    }
  }
  return { cells, wet };
}
