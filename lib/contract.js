// contract.js — the edge contract. Design this first; everything else is
// downstream of it.
//
// WHAT PROBLEM THIS SOLVES. Relief guarantees that two tiles meet because they
// are cut from one global grid of one map. That is not the guarantee wanted
// here. Here any piece's north edge has to mate with any piece's south edge,
// across different maps, printed months apart. So the boundary of a tile is
// not whatever the generator produced -- it is a DECLARED PROFILE that every
// tile is held to, and the generator is only free in the middle.
//
// THE FLOW RULE AND WHAT IT FIXES.
//
// Water leaves tile A at `outletZ` above A's base and arrives at B's inlet,
// `inletZ` above B's base. For the surface to be continuous:
//
//     baseZ(A) + outletZ  =  baseZ(B) + inletZ
//     =>  baseZ(A) - baseZ(B) = inletZ - outletZ = the tile's FALL
//
// So the downstream tile sits lower by exactly the fall, and since the tiles
// stand on 10 mm plates the fall has to be a whole number of them. The plate
// stack is not scenery under the map -- IT IS THE RIVER'S GRADIENT, quantised.
//
// THE FALL IS PER TILE, from 10 mm to 50 mm. A gentle tile spends one plate;
// a mountain torrent spends five. That is the only thing that changes when a
// tile is steeper: `inletZ = outletZ + fallMM`, and the tile stands that many
// plates below its upstream neighbour. What it buys is gradient --
//
//     10 mm over 200 mm =  5%   a river
//     50 mm over 200 mm = 25%   a cascade
//
// -- and gradient is what lets a narrow channel carry the same water, which
// is what `widthForFall` is about.
//
// WHAT HAPPENS WHEN TWO EDGES DISAGREE. In the first version this was an
// error: both sides had to declare the same height or the map was refused.
// That throws away the most useful thing the system can do. A 50 mm edge
// against a 10 mm edge is not a defect, it is a 40 mm CLIFF -- and if a river
// crosses there, a WATERFALL. The same step the other way round, with the
// downstream side higher, is a DAM, and the water behind it ponds. So a seam
// is now CLASSIFIED rather than judged:
//
//     plane      both sides at one height, the ground runs straight across
//     cliff      a step in the land, no water crossing it
//     waterfall  a step the river falls down
//     dam        a step the river would have to climb; it ponds instead
//
// Only two things are still errors: a port facing something that is not a
// port, and a plate level that two different rivers disagree about.
//
// A waterfall at a seam is also the best answer to leaking, which is worth
// saying here because it is the reason to reach for one. Water that is
// AIRBORNE across the seam cannot find the gap at all. See the README.

export const DEFAULTS = {
  tileMM: 200, // footprint of one modular piece, square
  plateMM: 10, // the stacking plate, and the quantum of every vertical step
  outletZMM: 2, // channel floor where the river leaves, above the tile base
  fallMM: 10, // default fall across a tile; per-tile, see FALLS
  edgeLandMM: 18, // the land datum at a tile edge, above the tile base
  bankAboveMM: 6, // the bank must stand at least this far above a port floor
  leveeFalloffMM: 34, // how far the raised bank takes to ease back to the land
  // THE CHANNEL'S CROSS-SECTION, looked at end-on.
  //
  // 'arc' is a single continuous curve from the thalweg up to the bank top
  // -- a sideways ) -- with no flat floor and no break in slope where the
  // bank starts. 'box' is what this used to do and only do: a flat bottom
  // the full width of the water, then a separate S-curve up the bank. A box
  // reads as a slot milled into the tile, which is what a canal looks like
  // and is not what a river looks like. A real channel is shallowest at its
  // edges and deepest along one line, and the bank is the same curve
  // continuing, not a different piece bolted on.
  //
  // Water BODIES keep the box. A bay or a fjord mouth is an opening in the
  // land, and its lip wants to be short and steep so it reads as cut into
  // the tile rather than as a very wide river.
  channelProfile: 'arc',
  // How fast the arc climbs. 2 is a parabola. Lower is flatter in the
  // middle and turns up harder at the bank; higher is a deeper, narrower
  // trough. Below about 1.4 the channel stops holding a line of water.
  channelArcPower: 2.0,
  cornerRadiusMM: 4, // rounded corners, as on the printed pieces
  seam: 'butt', // 'butt' | 'overlap' -- see seamGeometry()
  tongueMM: 6, // overlap only: how far the outlet shelf reaches past the edge
  tongueThickMM: 2.5, // overlap only: how thick that shelf is
  clearanceMM: 0.3, // slip fit, everywhere two printed parts meet
  minChannelFloorMM: 3, // plastic under the channel floor before it is called thin
  // HOW DEEP THE CHANNEL SITS IN THE LAND at a port.
  //
  // This is the number that replaced the plate stack as the thing which
  // decides a river's height. A port's floor used to be a FIXED height above
  // the tile's base -- outletZMM, or that plus a fall snapped to whole
  // plates -- which meant a tile's river height was a function of how many
  // spacers were under it, and so the spacers became the vertical design of
  // the whole map. Now a port's floor is simply the LAND at the middle of
  // that side, this far down. The river sits in the ground, the way a river
  // does.
  //
  // Two tiles across a seam read the same two shared corners, so they
  // compute the same land and the same floor, and they still mate exactly.
  // And the fall across a tile is no longer declared at all: it is the
  // difference between the land at the side the water comes in and the land
  // at the side it leaves, which is to say the river falls because the
  // ground falls.
  channelDepthMM: 10,
  maxStackPlates: 20, // a map taller than this is past what a child can reach over
};

/** The falls a tile may have, in mm. Whole plates, 10 to 50. */
export const FALLS = [10, 20, 30, 40, 50];

/**
 * The width ladder. Widths are whole centimetres so that a confluence lands
 * back on the ladder, and the two widest are openings rather than channels:
 * a 40 or 50 mm mouth is a bay, a fjord or the neck of a lake, not a river,
 * and it is cut as an opening with a shallow lip instead of banks.
 */
export const SIZES = {
  creek: { id: 'creek', widthMM: 10, bankMM: 10, kind: 'channel' },
  stream: { id: 'stream', widthMM: 20, bankMM: 14, kind: 'channel' },
  river: { id: 'river', widthMM: 30, bankMM: 18, kind: 'channel' },
  bay: { id: 'bay', widthMM: 40, bankMM: 22, kind: 'water-body' },
  fjord: { id: 'fjord', widthMM: 50, bankMM: 26, kind: 'water-body' },
};

export const SIZE_LADDER = Object.values(SIZES).sort((a, b) => a.widthMM - b.widthMM);

/** A size by name, or by width in mm — "30" and "river" are the same thing. */
export function sizeFor(x) {
  if (x == null) return SIZES.river;
  if (typeof x === 'object' && x.widthMM) return x;
  if (typeof x === 'number' || /^\d+$/.test(String(x))) {
    const w = Number(x);
    return SIZE_LADDER.find((s) => s.widthMM === w)
        || SIZE_LADDER.find((s) => s.widthMM >= w)
        || SIZE_LADDER[SIZE_LADDER.length - 1];
  }
  return SIZES[x] || SIZES.river;
}

/**
 * What comes out when several rivers come in.
 *
 * Channel width goes as the SQUARE ROOT of discharge -- that is hydraulic
 * geometry, and it holds across four orders of magnitude of real river --
 * and discharge simply adds at a confluence. So widths add in quadrature:
 *
 *     w_out = sqrt( sum of w_in^2 )
 *
 * rounded UP to the next rung, because a channel that is narrower than its
 * flow needs is the failure that floods the tile. Two 10 mm creeks give
 * 14.1 mm and round to 20; three give 17.3 mm and also round to 20. Both are
 * what was asked for, which is a good sign the brief was hydraulics all
 * along rather than a guess.
 */
export function confluenceSize(inSizes) {
  const list = (inSizes || []).map(sizeFor);
  if (!list.length) return SIZES.creek;
  if (list.length === 1) return list[0];
  const q = Math.sqrt(list.reduce((a, s) => a + s.widthMM * s.widthMM, 0));
  return SIZE_LADDER.find((s) => s.widthMM >= q - 1e-9) || SIZE_LADDER[SIZE_LADDER.length - 1];
}

/**
 * How wide a channel has to be on a tile of a given fall.
 *
 * Manning for a wide channel gives Q proportional to w * d^(5/3) * S^(1/2),
 * so for a fixed flow and depth the width needed falls as the square root of
 * the gradient. A steep tile carries the same water in a narrower, faster
 * channel, which is why a mountain torrent is a slot and the same river on
 * the flat is a sheet.
 *
 * Returned as the rung at or above the requirement, never below the
 * incoming water's own width on the gentlest tile.
 */
export function widthForFall(inflow, fallMM, c = DEFAULTS) {
  const base = sizeFor(inflow);
  const ref = c.plateMM; // the gentlest fall is the reference
  const need = base.widthMM * Math.sqrt(ref / Math.max(ref, fallMM || ref));
  return SIZE_LADDER.find((s) => s.widthMM >= need - 1e-9) || SIZE_LADDER[0];
}

export const EDGES = ['N', 'E', 'S', 'W'];
export const OPPOSITE = { N: 'S', S: 'N', E: 'W', W: 'E' };
/** Unit step in tile coordinates (col, row); row increases northward. */
export const STEP = { N: [0, 1], S: [0, -1], E: [1, 0], W: [-1, 0] };

export function makeContract(o = {}) {
  const c = { ...DEFAULTS, ...o };
  // The default fall, for a tile that does not declare its own. inletZ is a
  // convenience for that case only -- a tile with its own fall has its own
  // inlet height, and `portFloor` is the thing to ask.
  c.inletZMM = c.outletZMM + c.fallMM;
  return c;
}

/** A tile's fall, snapped to the ladder of whole plates. */
export function fallOf(c, spec) {
  const want = Number.isFinite(spec?.fallMM) ? spec.fallMM : c.fallMM;
  const snapped = Math.round(want / c.plateMM) * c.plateMM;
  return Math.min(FALLS[FALLS.length - 1], Math.max(FALLS[0], snapped));
}

/**
 * The channel floor at one of a tile's ports, above that tile's own base.
 *
 * `e` is the edge letter. It is optional: with one port in and one out --
 * which is nearly every tile -- the edge can be found from the type, so the
 * nine existing callers did not have to learn a new argument.
 *
 * Falls back to the old fixed heights only for a tile with no corners
 * resolved yet, which is the editor asking before anything has been grown.
 */
export function portFloor(c, spec, type, e = null) {
  if (spec?.corners) {
    const edge = e || EDGES.find((x) => spec.edges?.[x]?.type === type);
    if (edge) {
      const [a, b] = edgeCorners(cornersFor(c, spec), edge);
      const land = (a + b) / 2; // the land at the middle of that side
      return Math.max(c.minChannelFloorMM, land - c.channelDepthMM);
    }
  }
  return type === 'in' ? c.outletZMM + fallOf(c, spec) : c.outletZMM;
}

/**
 * The declared height profile along one edge, measured from the TILE'S OWN
 * BASE, as a function of distance `s` in mm from the edge's start corner.
 *
 * `edge` is {type: 'land'} or {type: 'in'|'out', size: 'river'}.
 * `landA`/`landB` are the land heights at the edge's two ends. They default
 * to the flat datum.
 *
 * WHY THE LAND IS NOT ONE FLAT NUMBER. It was, in the first version, and the
 * first hillshade of an assembled map showed what that does: every tile came
 * out as a plateau sitting inside a picture frame, because the generated
 * terrain rose 40 mm above a rim pinned at 18, and the clamp dug a moat round
 * every piece. A modular edge has to be DECLARED, but it does not have to be
 * LEVEL.
 *
 * So the land height lives on a lattice of tile CORNERS, shared between the
 * four tiles that meet there and quantised to the plate. An edge reads the
 * two corners at its ends and ramps between them. Two tiles then agree along
 * a seam because they read the same two corners, and all four agree at a
 * corner because there is only one of it. Terrain runs across the map in 10
 * mm steps instead of being flattened at every rim, and a piece still mates
 * with any other piece that declares the same corners -- which is what the
 * brief meant by "all pieces of a certain size should match".
 */
export function edgeProfile(c, edge, s, landA = c.edgeLandMM, landB = c.edgeLandMM, floorMM = null) {
  const u = Math.max(0, Math.min(1, s / c.tileMM));
  const land = landA + (landB - landA) * u;
  if (!edge || edge.type === 'land') return land;
  const size = sizeFor(edge.size);
  const floor = floorMM !== null ? floorMM : (edge.type === 'in' ? c.inletZMM : c.outletZMM);
  const half = size.widthMM / 2;
  const bank = size.bankMM;
  const d = Math.abs(s - c.tileMM / 2); // distance from the middle of the side
  if (d <= half) return floor;

  // THE BANK IS A LEVEE WHERE IT HAS TO BE. With falls up to 50 mm an inlet
  // sits 52 mm above the tile's base, which is well above any land datum, so
  // the ground beside it is not a bank at all -- the water would run out
  // sideways. The first fix for this raised the whole corner lattice to clear
  // the deepest port, and that pinned every rim above the terrain and brought
  // the picture-frame moat straight back, this time inverted.
  //
  // The land only has to clear the channel NEAR the channel. So the bank
  // climbs to whichever is higher, the surrounding land or a freeboard above
  // the water, and then eases back down to the land over leveeFalloffMM. Away
  // from the port the profile is exactly what it always was. relief does the
  // same thing for a pool that has to hold its level: "wherever its rim is
  // lower than that a lip is built up".
  const bankTop = Math.max(land, floor + c.bankAboveMM);
  const sm = (t) => { const u = Math.max(0, Math.min(1, t)); return u * u * (3 - 2 * u); };
  if (d <= half + bank) return floor + (bankTop - floor) * sm((d - half) / bank);
  if (bankTop <= land + 1e-9) return land;
  const fall = Math.max(1e-6, c.leveeFalloffMM);
  if (d >= half + bank + fall) return land;
  return bankTop + (land - bankTop) * sm((d - half - bank) / fall);
}

/** The four corner land heights a tile's edges read, in tile-local mm. */
export function cornersFor(c, spec) {
  const k = spec.corners || {};
  const d = c.edgeLandMM;
  return { sw: k.sw ?? d, se: k.se ?? d, nw: k.nw ?? d, ne: k.ne ?? d };
}

/**
 * Which corners each edge runs between, in the direction `s` increases.
 * S runs west to east, E runs south to north, N runs east to west (so that
 * it mirrors the neighbour's S), W runs north to south.
 */
export function edgeCorners(k, e) {
  switch (e) {
    case 'S': return [k.sw, k.se];
    case 'E': return [k.se, k.ne];
    case 'N': return [k.ne, k.nw];
    case 'W': return [k.nw, k.sw];
    default: throw new Error(`unknown edge ${e}`);
  }
}

/** The profile of one named edge of a tile, with its corners resolved. */
export function tileEdgeProfile(c, spec, e, s) {
  const k = cornersFor(c, spec);
  const [a, b] = edgeCorners(k, e);
  const edge = spec.edges?.[e];
  const floor = edge && edge.type !== 'land' ? portFloor(c, spec, edge.type) : null;
  return edgeProfile(c, edge, s, a, b, floor);
}

/**
 * What this edge will mate with, as a short string.
 *
 * Two edges mate flush when their signatures are mirror images at the same
 * world height. Printing it is what turns a pile of tiles into a catalogue
 * you can actually sort through: `land 30/30` goes against `land 30/30`, and
 * `in river@32 30/40` goes against `out river@2 40/30`.
 */
export function edgeSignature(c, spec, e, level = 0) {
  const k = cornersFor(c, spec);
  const [a, b] = edgeCorners(k, e);
  const base = level * c.plateMM;
  const edge = spec.edges?.[e];
  const corners = `${(base + a).toFixed(0)}/${(base + b).toFixed(0)}`;
  if (!edge || edge.type === 'land') return `land ${corners}`;
  const f = base + portFloor(c, spec, edge.type);
  return `${edge.type} ${sizeFor(edge.size).id}@${f.toFixed(0)} ${corners}`;
}

/**
 * What kind of join is this, in WORLD height?
 *
 * Returns the step on each side of the seam and a name for it. A step is no
 * longer a failure to be rejected -- it is the thing that makes a cliff, a
 * waterfall or a dam, and the only way to know which is to measure the land
 * and the water separately.
 *
 *   landStepMM   upstream land minus downstream land, worst along the seam
 *   waterStepMM  the same for the water, where both sides are wet
 *   kind         plane | cliff | waterfall | dam | ledge
 *
 * Sign convention: the step is read FROM WHERE THE WATER COMES FROM, so a
 * positive step means the upstream side is higher — a waterfall — and a
 * negative one means the downstream side is higher, which is a dam. Which
 * side is upstream comes from the ports, not from the order the caller
 * happens to pass the tiles in: the first version keyed the sign to the
 * iteration order and duly reported every waterfall on a north-flowing
 * river as a dam. Where no water crosses, the step is read from A.
 */
export function classifySeam(c, specA, levelA, specB, levelB, e, samples = 401) {
  const eb = OPPOSITE[e];
  const edgeA = specA?.edges?.[e];
  const edgeB = specB?.edges?.[eb];
  const wet = (ed, s) => {
    if (!ed || ed.type === 'land') return false;
    return Math.abs(s - c.tileMM / 2) <= sizeFor(ed.size).widthMM / 2;
  };

  // Which way does the water actually run? A's edge being the outlet means A
  // is upstream; A's edge being the inlet means B is.
  let flip = 1;
  if (edgeA && edgeB && edgeA.type !== 'land' && edgeB.type !== 'land') {
    if (edgeA.type === 'in' && edgeB.type === 'out') flip = -1;
  }

  let landStep = 0;
  let waterStep = 0;
  let landWorst = 0;
  let waterSeen = false;
  for (let k = 0; k < samples; k++) {
    const s = (k / (samples - 1)) * c.tileMM;
    // The two tiles meet along one physical line, so B's edge runs the other
    // way round: B's start corner is A's end corner.
    const sb = c.tileMM - s;
    const za = levelA * c.plateMM + tileEdgeProfile(c, specA, e, s);
    const zb = levelB * c.plateMM + tileEdgeProfile(c, specB, eb, sb);
    const d = (za - zb) * flip;
    if (wet(edgeA, s) && wet(edgeB, sb)) {
      waterSeen = true;
      if (Math.abs(d) > Math.abs(waterStep)) waterStep = d;
    } else if (Math.abs(d) > landWorst) {
      landWorst = Math.abs(d);
      landStep = d;
    }
  }

  const flat = (v) => Math.abs(v) < 1e-6;
  let kind;
  if (waterSeen && !flat(waterStep)) kind = waterStep > 0 ? 'waterfall' : 'dam';
  else if (!flat(landStep)) kind = 'cliff';
  else kind = 'plane';
  // A step in the land with the water running level through it is a ledge:
  // the river keeps going and the ground either side of it steps.
  if (kind === 'cliff' && waterSeen) kind = 'ledge';

  return {
    kind,
    landStepMM: landStep,
    waterStepMM: waterSeen ? waterStep : null,
    wet: waterSeen,
    // Kept so callers can still ask the old question: is this join flush?
    flush: flat(landStep) && (!waterSeen || flat(waterStep)),
  };
}

/**
 * The old question, kept because it is still the one the tests ask of a pair
 * that is MEANT to be flush: how far out is it, in mm, on each side.
 */
export function seamMismatch(c, specA, levelA, specB, levelB, e, samples = 401) {
  const r = classifySeam(c, specA, levelA, specB, levelB, e, samples);
  return {
    channel: Math.abs(r.waterStepMM ?? 0),
    land: Math.abs(r.landStepMM),
    ok: r.flush,
    kind: r.kind,
  };
}

/**
 * Assign a plate level to every tile.
 *
 * Downstream is one plate lower, so level counts plates up from the lowest
 * tile. Over the river network this is a longest-path problem on a DAG, with
 * one extra condition a plain topological sort would let through: EVERY path
 * into a tile must give the SAME level. Two rivers that meet after running
 * different numbers of tiles cannot both arrive at inletZ, and the map is
 * unbuildable as drawn. Better to say which two than to quietly pick one.
 *
 * Tiles the river never touches are a separate question. Left out of the
 * graph they would default to zero and leave an unexplained cliff against
 * their neighbours, so they are flooded outward from the tiles that ARE
 * constrained and take the nearest one's level. An explicit `level` on a tile
 * overrides both, which is how a mountain block gets to stand three plates
 * above the plain it borders.
 *
 * `tiles` is a Map keyed 'col,row' of {col, row, level?, edges: {N,E,S,W}}.
 */
export function assignLevels(tiles, c0 = DEFAULTS) {
  const problems = [];
  const key = (col, row) => `${col},${row}`;
  const hasRiver = (t) => EDGES.some((e) => t.edges?.[e] && t.edges[e].type !== 'land');

  const out = new Map();
  const indeg = new Map();
  for (const t of tiles.values()) if (hasRiver(t)) indeg.set(key(t.col, t.row), 0);

  for (const t of tiles.values()) {
    for (const e of EDGES) {
      const edge = t.edges?.[e];
      if (!edge || edge.type !== 'out') continue;
      const [dc, dr] = STEP[e];
      const nk = key(t.col + dc, t.row + dr);
      const n = tiles.get(nk);
      if (!n) {
        problems.push(edge.drain
          ? {
              kind: 'drain', severity: 'note', tile: key(t.col, t.row), edge: e,
              message: `${label(t)} drains off the ${e} side of the map. Put the reservoir under that edge.`,
            }
          : {
              kind: 'dangling-outlet', severity: 'error', tile: key(t.col, t.row), edge: e,
              message: `${label(t)} sends a river out of its ${e} side but there is no tile there. Water leaves the map; give it a tile, or mark it as the drain with sinkEdge.`,
            });
        continue;
      }
      const back = n.edges?.[OPPOSITE[e]];
      if (!back || back.type !== 'in') {
        problems.push({
          kind: 'unmatched-port', severity: 'error', tile: key(t.col, t.row), edge: e,
          message: `${label(t)} sends a river out of its ${e} side into ${label(n)}, whose ${OPPOSITE[e]} side is ${back ? back.type : 'land'}. One of the two has to change.`,
        });
        continue;
      }
      if (sizeFor(back.size).widthMM !== sizeFor(edge.size).widthMM) {
        problems.push({
          kind: 'size-mismatch', severity: 'error', tile: key(t.col, t.row), edge: e,
          message: `${label(t)} ${e} is ${sizeFor(edge.size).widthMM} mm wide but ${label(n)} ${OPPOSITE[e]} is ` +
                   `${sizeFor(back.size).widthMM} mm. A channel does not change width in mid-air; widen it at a confluence instead.`,
        });
      }
      // How many plates the downstream tile sits below this one: its own
      // fall, plus any waterfall declared at the seam. This is the edge
      // WEIGHT, and it is why the level pass is a longest path over a
      // weighted graph rather than a hop count.
      const drop = fallOf(c0, n) + (Number.isFinite(back.waterfallMM) ? back.waterfallMM : 0);
      const plates = Math.round(drop / c0.plateMM);
      if (!out.has(key(t.col, t.row))) out.set(key(t.col, t.row), []);
      out.get(key(t.col, t.row)).push({ to: nk, plates });
      indeg.set(nk, (indeg.get(nk) || 0) + 1);
    }
  }

  // An inlet nobody feeds: water appears from nowhere. Legal at the map edge
  // -- that is a fountain or a hose -- and an error anywhere else.
  for (const t of tiles.values()) {
    for (const e of EDGES) {
      const edge = t.edges?.[e];
      if (!edge || edge.type !== 'in') continue;
      const [dc, dr] = STEP[e];
      const n = tiles.get(key(t.col + dc, t.row + dr));
      if (n && n.edges?.[OPPOSITE[e]]?.type === 'out') continue;
      problems.push({
        kind: n ? 'unmatched-port' : 'open-inlet', severity: n ? 'error' : 'note',
        tile: key(t.col, t.row), edge: e,
        message: n
          ? `${label(t)} ${e} expects a river in, but ${label(n)} ${OPPOSITE[e]} does not send one.`
          : `${label(t)} takes a river in at its ${e} side from off the map. That needs a fountain or a hose.`,
      });
    }
  }

  // LEVELS ARE A DIFFERENCE-CONSTRAINT SYSTEM, not a longest path.
  //
  // Each arc says level(upstream) - level(downstream) = plates, and that is
  // all it says. The first version solved it as a longest path with every
  // source pinned at zero, and that produced a FALSE ERROR on the most
  // ordinary thing a river does: two tributaries of different lengths
  // meeting. They do not conflict. Their sources simply end up at different
  // heights, which is what tributaries look like.
  //
  // A real conflict needs a LOOP -- a channel that splits and rejoins -- so
  // that going round it has to sum to zero and does not. So the graph is
  // walked undirected, each arc read in whichever direction it is crossed,
  // and only an arc that closes a loop inconsistently is an error.
  const adj = new Map();
  const link = (a, b, w) => { // level(a) - level(b) = w
    if (!adj.has(a)) adj.set(a, []);
    adj.get(a).push({ to: b, w });
  };
  for (const [from, arcs] of out) for (const { to, plates } of arcs) {
    link(from, to, plates);
    link(to, from, -plates);
  }

  const level = new Map();
  const components = [];
  for (const start of indeg.keys()) {
    if (level.has(start)) continue;
    level.set(start, 0);
    const comp = [start];
    const queue = [start];
    while (queue.length) {
      const u = queue.shift();
      for (const { to: v, w } of adj.get(u) || []) {
        const want = level.get(u) - w;
        if (level.has(v)) {
          if (level.get(v) !== want) {
            problems.push({
              kind: 'level-conflict', severity: 'error', tile: v,
              message:
                `Tile ${v} is reached by two rivers that have fallen different amounts, so it would have to sit ` +
                `${level.get(v)} and ${want} plates up at once. The river splits and rejoins somewhere, and the two ` +
                `ways round do not drop the same. Change a fall on one of them, or add a waterfall to the shallower.`,
            });
          }
        } else {
          level.set(v, want);
          comp.push(v);
          queue.push(v);
        }
      }
    }
    components.push(comp);
  }

  // Each river system reaches the tray at plate zero, so every component is
  // normalised against its own lowest tile rather than against the map.
  for (const comp of components) {
    let min = Infinity;
    for (const k of comp) min = Math.min(min, level.get(k));
    for (const k of comp) level.set(k, level.get(k) - min);
  }

  // Water running in a circle is a different fault from an inconsistent
  // loop, and still worth catching: a directed cycle means the river flows
  // back into itself.
  {
    const state = new Map();
    const cycle = [];
    const walk = (k) => {
      state.set(k, 1);
      for (const { to } of out.get(k) || []) {
        if (state.get(to) === 1) cycle.push(to);
        else if (!state.has(to)) walk(to);
      }
      state.set(k, 2);
    };
    for (const k of indeg.keys()) if (!state.has(k)) walk(k);
    if (cycle.length) {
      problems.push({
        kind: 'cycle', severity: 'error',
        message: `The river flows in a circle through ${[...new Set(cycle)].join(' ')}. Water cannot run downhill back to where it started.`,
      });
    }
  }

  const levels = new Map();
  const fixed = new Set();
  for (const t of tiles.values()) {
    const k = key(t.col, t.row);
    if (Number.isFinite(t.level)) { levels.set(k, t.level); fixed.add(k); }
    else if (level.has(k)) { levels.set(k, level.get(k)); fixed.add(k); }
  }

  // Flood the rest outward from the constrained tiles so a dry tile sits with
  // its neighbours instead of dropping to zero and opening a cliff.
  const frontier = [...fixed];
  const seenFlood = new Set(fixed);
  while (frontier.length) {
    const k = frontier.shift();
    const [col, row] = k.split(',').map(Number);
    for (const [dc, dr] of Object.values(STEP)) {
      const nk = key(col + dc, row + dr);
      if (!tiles.has(nk) || seenFlood.has(nk)) continue;
      seenFlood.add(nk);
      levels.set(nk, levels.get(k));
      frontier.push(nk);
    }
  }
  for (const t of tiles.values()) {
    const k = key(t.col, t.row);
    if (!levels.has(k)) levels.set(k, 0);
  }
  return { levels, problems };
}

function label(t) {
  return `${columnLabel(t.col)}${t.row + 1}`;
}

export function columnLabel(i) {
  let s = '';
  let n = i;
  do {
    s = String.fromCharCode(65 + (n % 26)) + s;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return s;
}

/**
 * Geometry of the seam itself -- how the two pieces meet where the water
 * crosses, which is the part that actually leaks.
 *
 * 'butt': the two channel floors are coplanar and meet at a vertical line. The
 * seam gap is IN the water's path. Simple, prints anywhere, and it will weep.
 *
 * 'overlap': the outlet carries a shelf that reaches `tongueMM` past the
 * footprint, and the inlet carries a matching rebate so the shelf lands flush
 * with the downstream floor. The seam gap is then UNDERNEATH the water rather
 * than in it, and anything that does creep past drips into the rebate, which
 * is already part of the downstream channel. Nothing is sealed; the gap is
 * moved out of the way. That is a drip edge, and it works for the same reason
 * it works on a roof.
 *
 * Overlap needs material under the outlet floor to cut the shelf from, which
 * is the one thing outletZ = 2 mm does not have. Returns {ok, why} so the
 * caller can say so.
 */
export function seamGeometry(c) {
  if (c.seam !== 'overlap') return { style: 'butt', ok: true };
  const need = c.tongueThickMM + c.clearanceMM;
  if (c.outletZMM < need + 1) {
    return {
      style: 'overlap',
      ok: false,
      why:
        `An overlapping seam cuts a ${c.tongueThickMM} mm shelf out of the ${c.outletZMM} mm of plate under the outlet, ` +
        `leaving ${(c.outletZMM - need).toFixed(1)} mm. Raise outletZMM to ${Math.ceil(need + 1)} or more ` +
        `(inletZMM follows it, and the ${c.plateMM} mm fall is unchanged).`,
    };
  }
  return {
    style: 'overlap',
    ok: true,
    tongueMM: c.tongueMM,
    tongueThickMM: c.tongueThickMM,
    rebateMM: c.tongueMM + c.clearanceMM,
    rebateDepthMM: c.tongueThickMM + c.clearanceMM,
  };
}

/** Everything that is wrong with a contract, before anything is generated. */
export function check(c) {
  const out = [];
  if ((c.fallMM / c.plateMM) % 1 !== 0) {
    out.push({ severity: 'error', message: `A fall of ${c.fallMM} mm is not a whole number of ${c.plateMM} mm plates, so no stack can hold it.` });
  }
  if (c.outletZMM < c.minChannelFloorMM) {
    out.push({
      severity: 'warning',
      message:
        `Only ${c.outletZMM} mm of plate under the channel where it leaves the tile. That is about ` +
        `${Math.round(c.outletZMM / 0.2)} layers, thin for something that holds water and gets handled. ` +
        `outletZMM ${c.minChannelFloorMM + 2} / inletZMM ${c.minChannelFloorMM + 2 + c.plateMM} has the same ${c.plateMM} mm fall with twice the floor.`,
    });
  }
  const maxSize = Math.max(...SIZE_LADDER.map((s) => s.widthMM / 2 + s.bankMM));
  if (maxSize * 2 > c.tileMM) {
    out.push({ severity: 'error', message: 'The widest river plus its banks is wider than the tile.' });
  }
  // Land has to clear the inlet, and with a 50 mm fall the inlet is 52 mm up.
  // The corner lattice raises the rim to suit, so this is a note about what
  // the datum alone would give rather than an error.
  const steepest = c.outletZMM + FALLS[FALLS.length - 1];
  if (c.edgeLandMM <= c.outletZMM + c.fallMM) {
    out.push({
      severity: 'error',
      message: `Land at the edge (${c.edgeLandMM} mm) is not above the inlet floor (${c.outletZMM + c.fallMM} mm) for the default ${c.fallMM} mm fall, so the river has no banks and runs out over the side.`,
    });
  }
  out.push({
    severity: 'note',
    message: `Falls run ${FALLS[0]}-${FALLS[FALLS.length - 1]} mm (${(100 * FALLS[0] / c.tileMM).toFixed(0)}-${(100 * FALLS[FALLS.length - 1] / c.tileMM).toFixed(0)}% gradient). ` +
             `The steepest puts an inlet ${steepest} mm up, and the rim is raised to clear it.`,
  });
  const seam = seamGeometry(c);
  if (seam.ok === false) out.push({ severity: 'error', message: seam.why });
  return out;
}
