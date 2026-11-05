// board.js — what the water does, for whatever arrangement is on the table.
//
// A set of tiles is played with, not assembled once. A child stands one on a
// riser, turns another round, pulls a third out, and the question that
// matters is the one the brief asks: does the river run, fall, or dam? This
// answers it for any arrangement, in microseconds, without growing a single
// tile -- which is what lets the editor ask on every mouse move.
//
// THE MODEL. Each placed tile is one pool. Its water leaves by the lowest of
// its exits: every outlet faces a SILL, and the rim is one more exit, into
// the tray. A tile's water level is the lowest sill it has, and the seam that
// sill belongs to is where the water goes next.
//
//     what is across an outlet      the sill
//     an inlet                      that inlet's floor, or the outlet's own
//                                   floor if the inlet is lower (it falls)
//     land                          the land, where the pond has to get over it
//     another outlet, lower         nothing: it falls into that channel
//     nothing                       the outlet's own floor: it drains
//
// An inlet is a notch in the rim too. One facing off the board, onto land
// or into another inlet is a way out at its floor (or over what is across
// it), so a pond spills back out there rather than rising past it. One
// facing the outlet its river comes from is the river itself; see below.
//
// Everything is in WORLD mm -- the riser under a tile plus its own height --
// because that is the only frame in which two tiles can be compared. A tile
// knows nothing of its neighbours; the board is the only thing that does.
//
// WHAT THIS FIRST VERSION DOES NOT DO. A pond that rises past its own inlet
// backs up into the tile behind it, and the two become one pond at one level.
// That is a fixed point over the whole board and it is phase 4. Here a pond
// that reaches an inlet is FLAGGED (`backsUp`) and the sentence says so; its
// level is still worked out from the tile's own exits.
//
// THE BOARD PREDICTS AND NEVER REFUSES. Putting the pieces together wrong is
// a way to play. Nothing here is an error: a river into a bank is a dam, an
// outlet into nothing drains into the tray, an inlet with nothing upstream is
// a dry bed. The design checker (assignLevels and friends) still says what a
// map needs in order to be BUILT; that is a different question, and the
// adapter below passes its answers through untouched.

import { makeContract, EDGES, OPPOSITE, STEP, sizeFor, portFloor, fallOf, cornersFor, edgeCorners,
         tileEdgeProfile, edgeSignature, assignLevels, columnLabel, check } from './contract.js';
import { portsFromRivers, completeGrid, autoSizeRivers, cornerLattice, tileCorners } from './build.js';
import { scaleOf } from './scale.js';

const EPS = 1e-6;
const CORNERS = ['sw', 'se', 'nw', 'ne'];

/* ---------------------------------------------------------------- rotation */

/** Quarter turns, clockwise seen from above, folded into 0..3. */
export function normRot(r) {
  const n = Math.round(Number(r) || 0);
  return ((n % 4) + 4) % 4;
}

/** Where a design's edge ends up once the tile is turned `rot` times. */
export function turnEdge(e, rot) {
  return EDGES[(EDGES.indexOf(e) + normRot(rot)) % 4];
}

/** Which of the design's edges faces `e` once it has been turned `rot` times. */
export function facingEdge(e, rot) {
  return EDGES[(EDGES.indexOf(e) - normRot(rot) + 4) % 4];
}

// One clockwise quarter turn: north-west goes to north-east, and so round.
const TURN_CORNER = { nw: 'ne', ne: 'se', se: 'sw', sw: 'nw' };

/**
 * A tile as it sits on the board after `rot` quarter turns.
 *
 * Rotation is free, and this is why: every port is at the middle of its
 * edge, every edge profile is symmetric about that middle, and the corners
 * are walked counter-clockwise by `edgeCorners`, which a rotation preserves.
 * So turning a tile is a relabelling of its edges and corners and nothing
 * else -- the distance along an edge means the same thing before and after.
 */
export function turnTile(tile, rot) {
  const r = normRot(rot);
  if (!r) return tile;
  const edges = {};
  for (const e of EDGES) if (tile.edges?.[e]) edges[turnEdge(e, r)] = tile.edges[e];
  const out = { ...tile, edges };
  if (tile.corners) {
    out.corners = {};
    for (const k of CORNERS) {
      let to = k;
      for (let i = 0; i < r; i++) to = TURN_CORNER[to];
      out.corners[to] = tile.corners[k];
    }
  }
  return out;
}

/** The four edge signatures of a placed tile, in world mm. */
export function placedSignatures(c, tile, rot = 0, riserMM = 0) {
  const t = turnTile(tile, rot);
  const level = riserMM / c.plateMM;
  return Object.fromEntries(EDGES.map((e) => [e, edgeSignature(c, t, e, level)]));
}

/* ------------------------------------------------------------------- solve */

const portOn = (t, e) => {
  const ed = t.placed.edges?.[e];
  return ed && ed.type && ed.type !== 'land' ? ed : null;
};
const widthOf = (port) => sizeFor(port.size).widthMM;
const round1 = (v) => Math.round(v * 10) / 10;

/** The side a full pond runs over: the lowest edge, and of two, the lower on average. */
function lowestSide(k) {
  let best = null;
  for (const e of EDGES) {
    const [a, b] = edgeCorners(k, e);
    const lo = Math.min(a, b);
    const mean = (a + b) / 2;
    if (!best || lo < best.lo - EPS || (Math.abs(lo - best.lo) <= EPS && mean < best.mean)) best = { e, lo, mean };
  }
  return best.e;
}

/** Board mm of the middle of a tile's edge. */
function edgePoint(c, col, row, e) {
  const T = c.tileMM;
  switch (e) {
    case 'N': return { x: (col + 0.5) * T, y: (row + 1) * T };
    case 'S': return { x: (col + 0.5) * T, y: row * T };
    case 'E': return { x: (col + 1) * T, y: (row + 0.5) * T };
    default: return { x: col * T, y: (row + 0.5) * T };
  }
}

/**
 * Follow the water through an arrangement.
 *
 *   contract    makeContract() output, or the options for one
 *   placements  [{ id?, label?, col, row, rot?, riserMM?, tile: { edges, corners?, fallMM? } }]
 *               `tile` is the DESIGN, as it was drawn; `rot` and `riserMM`
 *               say how it sits on the table
 *   springs     [{ id, edge? }]: which tiles have water put into them, and
 *               at which of the design's inlets if the spring sits on one
 *
 * Returns { tiles, seams, order } where `order` is the ids in the order the
 * water reached them. Nothing here throws on a strange arrangement.
 */
export function solveBoard({ contract = {}, placements = [], springs = [] } = {}) {
  const c = Number.isFinite(contract.inletZMM) ? contract : makeContract(contract);
  const T = c.tileMM;

  const byCell = new Map();
  const tiles = [];
  for (const p of placements) {
    const rot = normRot(p.rot);
    const placed = turnTile(p.tile || {}, rot);
    const riser = Number(p.riserMM) || 0;
    const k = cornersFor(c, placed);
    const id = p.id ?? `${p.col},${p.row}`;
    const t = {
      id,
      label: p.label ?? `${columnLabel(p.col)}${p.row + 1}`,
      col: p.col, row: p.row, rot, riserMM: riser,
      placed, corners: k,
      fallMM: fallOf(c, placed),
      outMM: riser + portFloor(c, placed, 'out'),
      inMM: riser + portFloor(c, placed, 'in'),
      rimMM: riser + Math.min(k.sw, k.se, k.nw, k.ne),
      overSide: lowestSide(k),
      springs: [],
      exits: [],
      wet: false, levelMM: null, ponds: false, overtops: false, backsUp: [],
    };
    tiles.push(t);
    byCell.set(`${p.col},${p.row}`, t);
  }
  const byId = new Map(tiles.map((t) => [t.id, t]));
  for (const s of springs) {
    const t = byId.get(s.id);
    if (!t) continue;
    t.springs.push({ edge: s.edge ? turnEdge(s.edge, t.rot) : null });
  }

  const seams = [];
  const seamOf = new Map();
  const add = (s) => {
    seams.push(s);
    seamOf.set(`${s.a}|${s.edge}`, s);
    if (s.b) seamOf.set(`${s.b}|${OPPOSITE[s.edge]}`, s);
    return s;
  };
  // A seam is named from its south-west side, whichever way the water runs,
  // so the editor can hold on to one while a tile is turned or lifted.
  const seamId = (A, e, B) => {
    if (!B || e === 'N' || e === 'E') return `${A.label}|${e}`;
    return `${B.label}|${OPPOSITE[e]}`;
  };
  const base = (A, e, B, kind) => ({
    id: seamId(A, e, B),
    kind,
    a: A.id, b: B ? B.id : null,
    tiles: B ? [A.label, B.label] : [A.label],
    edge: e,
    at: edgePoint(c, A.col, A.row, e),
    wet: false,
  });

  // U's outlet on edge e meets D's inlet.
  const water = (U, e, D) => {
    const pu = portOn(U, e);
    const pd = portOn(D, OPPOSITE[e]);
    const drop = U.outMM - D.inMM;
    const kind = drop > EPS ? 'waterfall' : drop < -EPS ? 'dam' : 'flow';
    const s = add({
      ...base(U, e, D, kind),
      from: U.label, to: D.label,
      dropMM: kind === 'waterfall' ? drop : 0,
      sillMM: Math.max(U.outMM, D.inMM),
      widths: [widthOf(pu), widthOf(pd)],
      spreads: widthOf(pu) > widthOf(pd),
    });
    U.exits.push({ edge: e, sillMM: s.sillMM, floorMM: U.outMM, to: D, seam: s });
  };

  // U's outlet on edge e faces D's land.
  const onLand = (U, e, D) => {
    const land = D.riserMM + tileEdgeProfile(c, D.placed, OPPOSITE[e], T / 2);
    const drop = U.outMM - land;
    const s = add({
      ...base(U, e, D, drop >= -EPS ? 'spills' : 'blocked'),
      from: U.label, to: D.label,
      dropMM: Math.max(0, drop),
      landMM: land,
      sillMM: Math.max(U.outMM, land),
      widths: [widthOf(portOn(U, e))],
    });
    U.exits.push({ edge: e, sillMM: s.sillMM, floorMM: U.outMM, to: D, seam: s });
  };

  // Two outlets facing. The higher pours into the lower one's channel, which
  // runs back up into its own tile: that tile takes both rivers. Level, they
  // meet and neither has anywhere to go.
  const headOn = (A, e, B) => {
    const diff = A.outMM - B.outMM;
    const [hi, lo, he] = diff > EPS ? [A, B, e] : diff < -EPS ? [B, A, OPPOSITE[e]] : [null, null, null];
    const s = add({
      ...base(A, e, B, 'head-on'),
      from: hi ? hi.label : null, to: lo ? lo.label : null,
      dropMM: Math.abs(diff),
      widths: [widthOf(portOn(A, e)), widthOf(portOn(B, OPPOSITE[e]))],
    });
    if (hi) hi.exits.push({ edge: he, sillMM: hi.outMM, floorMM: hi.outMM, to: lo, seam: s });
  };

  for (const A of tiles) {
    for (const e of EDGES) {
      const [dc, dr] = STEP[e];
      const B = byCell.get(`${A.col + dc},${A.row + dr}`);
      if (B && (e === 'S' || e === 'W')) continue; // each shared seam once, from the south-west side
      const pa = portOn(A, e);
      if (!B) {
        if (!pa) continue;
        if (pa.type === 'out') {
          const s = add({ ...base(A, e, null, 'drains'), from: A.label, widths: [widthOf(pa)], declared: !!pa.drain });
          A.exits.push({ edge: e, sillMM: A.outMM, floorMM: A.outMM, to: null, seam: s });
        } else {
          const fed = A.springs.some((sp) => sp.edge === e);
          const s = add({ ...base(A, e, null, fed ? 'spring' : 'dry'), to: A.label, wet: fed, widths: [widthOf(pa)] });
          // An inlet on the edge of the board is still a notch in the rim:
          // a pond that rises to its floor goes out through it, into the tray.
          A.exits.push({ edge: e, sillMM: A.inMM, floorMM: A.inMM, to: null, seam: s, back: true });
        }
        continue;
      }
      const pb = portOn(B, OPPOSITE[e]);
      const ta = pa ? pa.type : 'land';
      const tb = pb ? pb.type : 'land';
      if (ta === 'out' && tb === 'in') water(A, e, B);
      else if (ta === 'in' && tb === 'out') water(B, OPPOSITE[e], A);
      else if (ta === 'out' && tb === 'out') headOn(A, e, B);
      else if (ta === 'out') onLand(A, e, B);
      else if (tb === 'out') onLand(B, OPPOSITE[e], A);
      else if (ta === 'land' && tb === 'land') {
        // Edges ramp straight between their corners, so the ends are the
        // worst of it. B's edge runs the other way along the same line.
        const [a0, a1] = edgeCorners(A.corners, e);
        const [b0, b1] = edgeCorners(B.corners, OPPOSITE[e]);
        const d0 = (A.riserMM + a0) - (B.riserMM + b1);
        const d1 = (A.riserMM + a1) - (B.riserMM + b0);
        const step = Math.abs(d0) >= Math.abs(d1) ? d0 : d1;
        add({ ...base(A, e, B, Math.abs(step) > 0.5 ? 'cliff' : 'plane'), landStepMM: step });
      } else {
        // An inlet facing an inlet, or land: nothing comes in. The notch is
        // still a way out, though: a pond that rises over its floor, and over
        // whatever is across it, spills through onto the next tile.
        const s = add({ ...base(A, e, B, 'dry'), to: ta === 'in' ? A.label : B.label, also: ta === 'in' && tb === 'in' ? B.label : null });
        const across = (T, side) => (portOn(T, side)?.type === 'in' ? T.inMM : T.riserMM + tileEdgeProfile(c, T.placed, side, c.tileMM / 2));
        if (ta === 'in') A.exits.push({ edge: e, sillMM: Math.max(A.inMM, across(B, OPPOSITE[e])), floorMM: A.inMM, to: B, seam: s, back: true });
        if (tb === 'in') B.exits.push({ edge: OPPOSITE[e], sillMM: Math.max(B.inMM, across(A, e)), floorMM: B.inMM, to: A, seam: s, back: true });
      }
    }
  }

  // Follow the water from wherever it is put in.
  const order = [];
  const queue = tiles.filter((t) => t.springs.length);
  for (const t of queue) t.wet = true;
  const done = new Set();
  while (queue.length) {
    const t = queue.shift();
    if (done.has(t.id)) continue;
    done.add(t.id);
    order.push(t.id);

    // Water cannot leave by the notch it came in through: two tiles joined
    // that way are one pond, and a pond spanning tiles is phase 4.
    const exits = t.exits.filter((x) => !t.arrivedBy?.has(x.seam));
    const sill = exits.length ? Math.min(...exits.map((x) => x.sillMM)) : Infinity;
    const level = Math.min(t.rimMM, sill);
    t.levelMM = level;
    t.overtops = t.rimMM < sill - EPS;
    // Ponding is measured from the floor the river leaves by. A tile with no
    // outlet has to fill before it goes anywhere, notch or rim.
    const outFloors = exits.filter((x) => !x.back).map((x) => x.floorMM);
    t.ponds = !outFloors.length || level > Math.min(...outFloors) + EPS;
    t.pondToMM = t.ponds ? level : null;

    for (const x of exits) {
      const s = x.seam;
      const dam = s.kind === 'dam' || s.kind === 'blocked';
      if (x.sillMM <= level + EPS) {
        s.wet = true;
        if (x.back) { s.backFrom = t.label; s.backTo = x.to ? x.to.label : null; s.backEdge = x.edge; }
        if (dam) { s.pondToMM = level; s.holds = true; }
        if (x.to) {
          x.to.wet = true;
          (x.to.arrivedBy = x.to.arrivedBy || new Set()).add(s);
          if (!done.has(x.to.id)) queue.push(x.to);
        }
      } else if (dam && t.overtops) {
        // The pond would have to climb higher than the rim to get over this
        // one, so it runs over the rim instead.
        s.holds = false;
        s.overtops = true;
        s.pondToMM = level;
        s.wouldPondToMM = x.sillMM;
      } else if (dam) {
        // Never climbed at all: the water leaves by a lower way out first.
        s.wouldPondToMM = x.sillMM;
      }
    }

    // A pond above the floor of an inlet the river comes in by reaches back
    // up that river. How far is phase 4; here it is said.
    if (t.ponds) {
      for (const e of EDGES) {
        if (portOn(t, e)?.type !== 'in' || level <= t.inMM + EPS) continue;
        const s = seamOf.get(`${t.id}|${e}`);
        if (s && s.to === t.label && (s.kind === 'flow' || s.kind === 'waterfall' || s.kind === 'dam')) t.backsUp.push(e);
      }
    }
  }

  return { contract: c, tiles, seams, order };
}

/* --------------------------------------------------------------- sentences */

const SIDE = { N: 'north', E: 'east', S: 'south', W: 'west' };
const mm = (v) => `${round1(v)} mm`;
const list = (xs) => (xs.length < 2 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);

/**
 * The board, in the sentences of the blueprint's table: what the child will
 * see happen. Ordered the way the water goes -- springs, then each tile in
 * the order the water reaches it -- and then what stays dry.
 */
export function describeBoard(board) {
  const { tiles, seams, order } = board;
  const byId = new Map(tiles.map((t) => [t.id, t]));
  const out = [];
  const say = (kind, text, extra = {}) => out.push({ kind, text, ...extra });

  const fed = tiles.filter((t) => t.springs.length).sort((a, b) => a.label.localeCompare(b.label));
  if (fed.length) {
    const names = fed.map((t) => {
      const at = t.springs.filter((s) => s.edge).map((s) => s.edge);
      return at.length ? `${t.label} (${at.join(', ')})` : t.label;
    });
    say('spring', `${fed.length > 1 ? 'Springs feed' : 'A spring feeds'} ${list(names)}.`, { tiles: fed.map((t) => t.id) });
  } else if (tiles.length) {
    say('dry', 'Nothing on the board is fed: no spring and no hose, so every river bed is dry.');
  }

  for (const id of order) {
    const t = byId.get(id);
    for (const x of t.exits) {
      const s = x.seam;
      if (!s.wet) continue; // a dam that never fills is said with the overtopping, below
      const to = x.to ? x.to.label : null;
      let text;
      if (x.back) {
        if (s.backFrom !== t.label) continue;
        say('back', `${t.label} fills to ${mm(t.levelMM)} and spills back out of its ${SIDE[x.edge]} inlet ${to ? `onto ${to}` : 'into the tray'}.`, { seam: s.id });
        continue;
      }
      switch (s.kind) {
        case 'flow': text = `${t.label} runs into ${to}.`; break;
        case 'waterfall': text = `${t.label} falls ${mm(s.dropMM)} into ${to}.`; break;
        case 'dam':
          text = `${t.label} meets ${to} ${mm(s.sillMM - t.outMM)} higher, so ${t.label} ponds to ${mm(s.pondToMM)} `
               + `and runs on into ${to}; its rim holds at ${mm(t.rimMM)}.`;
          break;
        case 'blocked':
          text = `${t.label}'s river runs into ${to}'s bank: ${t.label} ponds to ${mm(s.pondToMM)} and spills over into ${to}.`;
          break;
        case 'spills': text = `${t.label}'s river pours ${mm(s.dropMM)} down onto ${to}'s ground.`; break;
        case 'head-on': text = `${t.label}'s river falls ${mm(s.dropMM)} into ${to}'s channel, where the two meet head on.`; break;
        case 'drains': text = `${t.label} drains off its ${SIDE[s.edge]} side into the tray.`; break;
        default: text = null;
      }
      if (text && s.spreads) {
        text = text.replace(/\.$/, `; ${to}'s ${s.widths[1]} mm channel takes what it can of ${s.widths[0]} mm and the rest spreads over the banks.`);
      }
      if (text) say(s.kind, text, { seam: s.id });
    }
    if (t.overtops) {
      const dam = t.exits
        .filter((x) => (x.seam.kind === 'dam' || x.seam.kind === 'blocked') && x.seam.holds === false)
        .sort((a, b) => a.sillMM - b.sillMM)[0];
      const how = !t.exits.length
        ? `${t.label} has no way out: it fills to its rim at ${mm(t.rimMM)}`
        : dam
          ? `${t.label} would have to pond to ${mm(dam.sillMM)} to get into ${dam.to ? dam.to.label : 'the next tile'}, but its rim is ${mm(t.rimMM)}: it fills`
          : `${t.label} fills to its rim at ${mm(t.rimMM)}`;
      say('overtops', `${how} and runs over its ${SIDE[t.overSide]} side into the tray.`, { tile: t.id });
    }
    if (t.backsUp.length) {
      const behind = t.backsUp.map((e) => {
        const [dc, dr] = STEP[e];
        const u = tiles.find((q) => q.col === t.col + dc && q.row === t.row + dr);
        return u ? u.label : `off the ${SIDE[e]} edge`;
      });
      say('backs-up', `${t.label}'s pond is above its ${t.backsUp.join(' and ')} inlet, so it backs up into ${list(behind)}.`, { tile: t.id });
    }
  }

  for (const s of seams) {
    if (s.wet) continue;
    if (s.kind === 'dry') {
      const t = tiles.find((q) => q.label === s.to);
      const across = s.b ? byId.get(s.a === t?.id ? s.b : s.a) : null;
      const text = !s.b
        ? `${s.to}'s ${s.edge} inlet has nothing feeding it: a dry bed.`
        : s.also
          ? `${s.tiles[0]} and ${s.tiles[1]} both take a river in at their seam, and neither sends one: dry.`
          : `${s.to}'s inlet faces ${across ? across.label : 'its neighbour'}'s land: dry.`;
      say('dry', text, { seam: s.id });
    } else if (['flow', 'waterfall', 'dam', 'spills', 'blocked', 'drains'].includes(s.kind)) {
      const t = byId.get(s.kind === 'drains' ? s.a : tiles.find((q) => q.label === s.from)?.id);
      if (t && t.wet) continue; // said above, with the tile that never filled
      say('dry', s.kind === 'drains'
        ? `${s.from}'s outlet on its ${SIDE[s.edge]} side would drain, but no water reaches it.`
        : `The channel from ${s.from} to ${s.to} is a dry bed: nothing upstream feeds it.`, { seam: s.id });
    } else if (s.kind === 'head-on' && !s.from) {
      say('head-on', `${s.tiles[0]} and ${s.tiles[1]} send their rivers into each other at one height; neither has anywhere to go.`, { seam: s.id });
    }
  }
  return out;
}

/** Counts by badge, for the status strip: only seams that show something. */
export function countBoard(board) {
  const n = {};
  const bump = (k) => { n[k] = (n[k] || 0) + 1; };
  for (const s of board.seams) {
    if (s.kind === 'plane') continue;
    if (s.backFrom) bump('back');
    if (s.backFrom && s.kind !== 'spring') continue;
    // A dam the pond cannot climb is the tile overtopping, counted below.
    if ((s.kind === 'dam' || s.kind === 'blocked') && s.holds === false) continue;
    if (!s.wet && s.kind !== 'cliff' && s.kind !== 'head-on' && s.kind !== 'dry') bump('dry');
    else bump(s.kind);
    if (s.spreads && s.wet) bump('spreads');
  }
  n.overtops = board.tiles.filter((t) => t.overtops).length;
  n.ponds = board.tiles.filter((t) => t.ponds).length;
  return n;
}

/* ------------------------------------------------------- map-style adapter */

/**
 * The spec fields the ground depends on, which is what a cached world is
 * keyed on. The ice is left out on request: the editor's rims are estimated
 * from the ground WITHOUT it, because that takes a tenth of a second where
 * the glacier takes ten, and the corner lattice is quantised to the plate so
 * the ice rarely moves a corner at all.
 */
export const WORLD_FIELDS = ['seed', 'worldGrid', 'worldSizeM', 'spine', 'spineHeightM', 'spineWidthM',
  'baseElevM', 'roughness', 'flats', 'volcanoes', 'reposeDeg', 'reposePasses'];

export function worldKey(spec, { ice = false } = {}) {
  const pick = {};
  for (const k of WORLD_FIELDS) if (spec[k] !== undefined) pick[k] = spec[k];
  if (ice) pick.glacier = spec.glacier ?? null;
  return JSON.stringify(pick);
}

/**
 * Read a map-style spec -- rivers, falls, waterfalls, levels -- as a board.
 *
 * A map-style spec has no designs to shuffle: every cell is its own design,
 * generated in place, which is how it has always been built. So each cell
 * becomes one placement, standing on the riser its design level asks for,
 * turned by `spec.rot['col,row']` quarter turns. The turn is the one thing
 * here that does not change what gets printed -- it is how the printed piece
 * sits on the table -- so the build ignores it and the board does not.
 *
 * Corners come from the same lattice the build uses. Given `world`, a height
 * field of the ground, they are what the build would cut; without one they
 * sit at their floor, as flat ground would put them.
 */
export function boardFromSpec(spec = {}, { world = null } = {}) {
  const c = makeContract(spec.contract || {});
  const cols = spec.cols || 3;
  const rows = spec.rows || 3;
  const design = [];

  let tiles;
  try {
    tiles = portsFromRivers(spec.rivers || []);
  } catch (err) {
    design.push({ kind: 'river', severity: 'error', message: err.message });
    tiles = new Map();
  }
  completeGrid(tiles, cols, rows, spec.levels || {}, spec.falls || {}, spec.waterfalls || {});
  design.push(...autoSizeRivers(c, tiles));
  const { levels: declared, problems } = assignLevels(tiles, c);
  // SPACERS CARRY NOTHING NOW. assignLevels still walks the river and still
  // reports what it finds -- a port facing land, a cycle -- because those
  // are real design faults. But its levels no longer become height: every
  // tile sits at 0 and the drop lives in the tile's own rock (see
  // portFloor). The plates underneath are an optional spacer for standing a
  // set of tiles up, not the vertical design of the map.
  const levels = new Map([...declared.keys()].map((k) => [k, 0]));

  design.push(...problems);

  const grid = cornerLattice(world, c, levels, {
    cols, rows,
    metresPerMM: scaleOf(spec),
    terraceMM: spec.terraceMM ?? null,
    raise: spec.cornerRaise || null,
  });
  for (const t of tiles.values()) t.corners = tileCorners(grid, c, t, levels.get(`${t.col},${t.row}`) ?? 0);

  // Springs where the build would put them: every inlet with nothing
  // upstream, if the fountains are on, plus any placed by hand.
  const springs = [];
  const label = (t) => `${columnLabel(t.col)}${t.row + 1}`;
  if (spec.fountains && spec.fountains.auto !== false) {
    for (const t of tiles.values()) {
      for (const e of EDGES) {
        if (t.edges?.[e]?.type !== 'in') continue;
        const [dc, dr] = STEP[e];
        const up = tiles.get(`${t.col + dc},${t.row + dr}`);
        if (up && up.edges?.[OPPOSITE[e]]?.type === 'out') continue;
        springs.push({ id: `${t.col},${t.row}`, edge: e, auto: true });
      }
    }
  }
  for (const spot of spec.fountains?.place || []) {
    for (const t of tiles.values()) {
      if (spot.tile && spot.tile !== label(t)) continue;
      springs.push({ id: `${t.col},${t.row}`, edge: !spot.atMM && spot.edge ? spot.edge : null, placed: true });
    }
  }

  const placements = [...tiles.values()].map((t) => {
    const id = `${t.col},${t.row}`;
    return {
      id, label: label(t), col: t.col, row: t.row,
      rot: normRot(spec.rot?.[id]),
      riserMM: (levels.get(id) ?? 0) * c.plateMM,
      level: levels.get(id) ?? 0,
      tile: t,
      outside: t.col >= cols || t.row >= rows || t.col < 0 || t.row < 0,
    };
  });

  for (const n of check(c)) if (n.severity !== 'note') design.push({ kind: 'contract', ...n });
  return { contract: c, cols, rows, placements, springs, levels, corners: grid, design, rims: world ? 'ground' : 'datum' };
}

/**
 * Everything the editor shows on a mouse-up: the board read from the spec,
 * the water followed through it, and what to say about it. Never throws.
 */
export function plan(spec = {}, opts = {}) {
  const read = boardFromSpec(spec, opts);
  const board = solveBoard({ contract: read.contract, placements: read.placements, springs: read.springs });
  const sentences = describeBoard(board);
  // A level conflict refuses nothing on the board: the arrangement is what
  // it is, and the water does what it does. It is still worth saying.
  for (const p of read.design) {
    if (p.kind === 'level-conflict' || p.kind === 'cycle') sentences.push({ kind: 'note', text: p.message });
  }
  return { ...read, ...board, sentences, counts: countBoard(board), rims: opts.rimsFrom || read.rims };
}
