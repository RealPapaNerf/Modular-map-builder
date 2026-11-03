// contract.js — the edge contract. Design this first; everything else is
// downstream of it.
//
// WHAT PROBLEM THIS SOLVES. Relief guarantees that two tiles meet because they
// are cut from one global grid of one map. That is not the guarantee wanted
// here. Here any piece's north edge has to mate with any piece's south edge,
// across different maps, printed months apart. So the boundary of a tile is
// not whatever the generator produced -- it is a DECLARED PROFILE that every
// tile of a given size is held to, and the generator is only free in the
// middle.
//
// THE FLOW RULE AND WHAT IS ACTUALLY FIXED BY IT.
//
// The brief was: rivers enter a tile 12 mm up and leave 2 mm from the bottom.
// Work out what that forces. Water leaves tile A at 2 mm above A's base and
// has to arrive at B's inlet, which is 12 mm above B's base. For the water
// surface to be continuous:
//
//     baseZ(A) + 2  =  baseZ(B) + 12      =>   baseZ(B) = baseZ(A) - 10
//
// So the downstream tile sits exactly one 10 mm plate lower. The plate stack
// is not scenery under the map -- IT IS THE RIVER'S GRADIENT, quantised. Every
// seam the river crosses spends one plate.
//
// Which means the real contract is not "12 and 2". It is:
//
//     inletZ - outletZ = plateMM
//
// The absolute heights are free, and that freedom is worth having, because at
// outletZ = 2 there is only 2 mm of plastic under the channel floor where it
// leaves the tile -- about five layers at 0.2 mm, which is thin for something
// expected to hold water and be handled by a child. Raise both by 2 mm and
// 14/4 keeps the exact same 10 mm fall, the exact same plate quantum, and
// doubles the floor. The default here is the 12/2 that was asked for, and
// `check()` says so when it is thin rather than deciding for you.
//
// WHAT THE FALL BUYS. 10 mm over a 200 mm tile is a 5% gradient. That is steep
// for a real river and about right for a 3D-printed channel, where layer lines
// and surface tension will stall a shallower one.

export const DEFAULTS = {
  tileMM: 200, // footprint of one modular piece, square
  plateMM: 10, // the stacking plate; also the fall per tile, see above
  outletZMM: 2, // channel floor where the river leaves, above the tile base
  edgeLandMM: 18, // land height at any tile edge, above the tile base
  bankMM: 14, // how far in from the channel the bank climbs to edgeLandMM
  cornerRadiusMM: 4, // rounded corners, as on the printed pieces
  seam: 'butt', // 'butt' | 'overlap' -- see seamGeometry()
  tongueMM: 6, // overlap only: how far the outlet shelf reaches past the edge
  tongueThickMM: 2.5, // overlap only: how thick that shelf is
  clearanceMM: 0.3, // slip fit, everywhere two printed parts meet
  minChannelFloorMM: 3, // plastic under the channel floor before it is called thin
};

/**
 * Standard river sizes. Width is the variable; the floor heights are NOT,
 * because they are what make pieces interchangeable. A narrow creek and a wide
 * river both enter at inletZ and leave at outletZ, so a creek tile can sit
 * upstream of a river tile and the water still lines up. Depth is expressed in
 * the terrain either side of the channel, not in the port.
 */
export const SIZES = {
  creek: { id: 'creek', widthMM: 12, bankMM: 10 },
  river: { id: 'river', widthMM: 24, bankMM: 14 },
  wide: { id: 'wide', widthMM: 40, bankMM: 20 },
};

export const EDGES = ['N', 'E', 'S', 'W'];
export const OPPOSITE = { N: 'S', S: 'N', E: 'W', W: 'E' };
/** Unit step in tile coordinates (col, row); row increases northward. */
export const STEP = { N: [0, 1], S: [0, -1], E: [1, 0], W: [-1, 0] };

export function makeContract(o = {}) {
  const c = { ...DEFAULTS, ...o };
  c.inletZMM = c.outletZMM + c.plateMM;
  return c;
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
export function edgeProfile(c, edge, s, landA = c.edgeLandMM, landB = c.edgeLandMM) {
  const u = Math.max(0, Math.min(1, s / c.tileMM));
  const land = landA + (landB - landA) * u;
  if (!edge || edge.type === 'land') return land;
  const size = SIZES[edge.size] || SIZES.river;
  const floor = edge.type === 'in' ? c.inletZMM : c.outletZMM;
  const half = size.widthMM / 2;
  const bank = size.bankMM;
  const d = Math.abs(s - c.tileMM / 2); // distance from the middle of the side
  if (d <= half) return floor;
  if (d >= half + bank) return land;
  const t = (d - half) / bank;
  const sm = t * t * (3 - 2 * t);
  return floor + (land - floor) * sm;
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
  return edgeProfile(c, spec.edges?.[e], s, a, b);
}

/**
 * Two mating edges, expressed in WORLD height, to prove they meet.
 *
 * Two different things are measured, and conflating them is a mistake worth
 * not making twice:
 *
 *   channel — disagreement where the WATER runs. This must be zero. Anything
 *             here is a step the water falls down, or a lip it backs up
 *             behind, and it is the contract failing.
 *   land    — disagreement either side of the water. This is EXPECTED to be
 *             the plate drop. Two tiles one plate apart have a 10 mm terrace
 *             between them, which is where the map gets its relief from and
 *             is exactly what the mountain-to-plain seams on the printed
 *             pieces already look like.
 */
export function seamMismatch(c, specA, levelA, specB, levelB, e, samples = 401) {
  let channel = 0;
  let land = 0;
  const eb = OPPOSITE[e];
  const edgeA = specA?.edges?.[e];
  const edgeB = specB?.edges?.[eb];
  const wet = (ed, s) => {
    if (!ed || ed.type === 'land') return false;
    const size = SIZES[ed.size] || SIZES.river;
    return Math.abs(s - c.tileMM / 2) <= size.widthMM / 2;
  };
  for (let k = 0; k < samples; k++) {
    const s = (k / (samples - 1)) * c.tileMM;
    // The two tiles meet along one physical line, so B's edge runs the other
    // way round: B's start corner is A's end corner.
    const sb = c.tileMM - s;
    const za = levelA * c.plateMM + tileEdgeProfile(c, specA, e, s);
    const zb = levelB * c.plateMM + tileEdgeProfile(c, specB, eb, sb);
    const d = Math.abs(za - zb);
    if (wet(edgeA, s) && wet(edgeB, sb)) channel = Math.max(channel, d);
    else land = Math.max(land, d);
  }
  return { channel, land, ok: channel < 1e-9 && land < 1e-9 };
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
export function assignLevels(tiles) {
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
      if ((back.size || 'river') !== (edge.size || 'river')) {
        problems.push({
          kind: 'size-mismatch', severity: 'error', tile: key(t.col, t.row), edge: e,
          message: `${label(t)} ${e} is a ${edge.size || 'river'} but ${label(n)} ${OPPOSITE[e]} is a ${back.size || 'river'}. Standard widths only mate with themselves.`,
        });
      }
      if (!out.has(key(t.col, t.row))) out.set(key(t.col, t.row), []);
      out.get(key(t.col, t.row)).push(nk);
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

  // Longest path over the river tiles, checking every arrival agrees.
  const level = new Map();
  const queue = [];
  for (const [k, d] of indeg) if (d === 0) { level.set(k, 0); queue.push(k); }
  let seen = 0;
  const pending = new Map(indeg);
  while (queue.length) {
    const k = queue.shift();
    seen++;
    for (const nk of out.get(k) || []) {
      const want = level.get(k) - 1;
      if (level.has(nk) && level.get(nk) !== want) {
        problems.push({
          kind: 'level-conflict', severity: 'error', tile: nk,
          message:
            `Tile ${nk} is reached by two rivers that have run different numbers of tiles, so it would have to sit ` +
            `${level.get(nk)} and ${want} plates up at once. Lengthen the shorter branch by a tile, or move the confluence a tile downstream.`,
        });
      } else {
        level.set(nk, want);
      }
      pending.set(nk, pending.get(nk) - 1);
      if (pending.get(nk) === 0) queue.push(nk);
    }
  }
  if (seen < indeg.size) {
    const stuck = [...pending.entries()].filter(([, d]) => d > 0).map(([k]) => k);
    problems.push({
      kind: 'cycle', severity: 'error',
      message: `The river runs in a circle through ${stuck.join(' ')}. Water cannot flow uphill back to where it started.`,
    });
  }

  // Normalise against the river tiles, so the lowest water is plate zero.
  let min = Infinity;
  for (const v of level.values()) if (v < min) min = v;
  if (!isFinite(min)) min = 0;

  const levels = new Map();
  const fixed = new Set();
  for (const t of tiles.values()) {
    const k = key(t.col, t.row);
    if (Number.isFinite(t.level)) { levels.set(k, t.level); fixed.add(k); }
    else if (level.has(k)) { levels.set(k, level.get(k) - min); fixed.add(k); }
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
  if (c.inletZMM !== c.outletZMM + c.plateMM) {
    out.push({ severity: 'error', message: 'inletZ - outletZ must equal the plate thickness, or the river steps at every seam.' });
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
  const maxSize = Math.max(...Object.values(SIZES).map((s) => s.widthMM / 2 + s.bankMM));
  if (maxSize * 2 > c.tileMM) {
    out.push({ severity: 'error', message: 'The widest river plus its banks is wider than the tile.' });
  }
  if (c.edgeLandMM <= c.inletZMM) {
    out.push({
      severity: 'error',
      message: `Land at the edge (${c.edgeLandMM} mm) is not above the inlet floor (${c.inletZMM} mm), so the river has no banks and runs out over the side.`,
    });
  }
  const seam = seamGeometry(c);
  if (seam.ok === false) out.push({ severity: 'error', message: seam.why });
  const fall = (c.plateMM / c.tileMM) * 100;
  out.push({ severity: 'note', message: `Fall is ${c.plateMM} mm per tile over ${c.tileMM} mm — a ${fall.toFixed(1)}% gradient.` });
  return out;
}
