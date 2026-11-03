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

import { SIZES, EDGES, edgeProfile } from './contract.js';
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
export function planChannels(c, edges, o = {}) {
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
      chans.push({ path, fromZ: c.inletZMM, toZ: c.outletZMM, size: edges[outs[0]].size || 'river', spring: true });
      return chans;
    }
    chans.push({
      path: riverPath(c, from, outs[0], o),
      fromZ: c.inletZMM,
      toZ: c.outletZMM,
      size: edges[outs[0]].size || 'river',
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
      path: riverPath(c, e, target, { ...o, meander: (o.meander ?? 0.22) * 0.6 }),
      fromZ: c.inletZMM,
      toZ: c.outletZMM,
      size: edges[e].size || 'river',
    });
  }
  for (const e of outs.slice(1)) {
    chans.push({
      path: riverPath(c, ins[0] || outs[0], e, o),
      fromZ: c.inletZMM,
      toZ: c.outletZMM,
      size: edges[e].size || 'river',
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
  let cells = 0;
  for (const ch of channels) {
    const size = SIZES[ch.size] || SIZES.river;
    const half = size.widthMM / 2;
    const bank = size.bankMM;
    for (let j = 0; j < ny; j++) {
      const y = j * step;
      for (let i = 0; i < nx; i++) {
        const x = i * step;
        const { dist, t } = nearest(ch.path, x, y);
        if (dist > half + bank) continue;
        const floor = ch.fromZ + (ch.toZ - ch.fromZ) * t - deepenFloorMM;
        const k = j * nx + i;
        const here = local.values[k];
        let target;
        if (dist <= half) target = floor;
        else {
          const w = smoothstep((dist - half) / bank);
          target = floor + (Math.max(here, floor) - floor) * w;
        }
        if (target < here) { local.values[k] = target; cells++; }
      }
    }
  }
  return { cells };
}
