// build.js — a map spec in, a set of printable tiles out.

import { makeField, minMax, normalize, sample } from './field.js';
import { baseTerrain, addVolcano, makeStrata } from './terrain.js';
import { glaciate } from './glacier.js';
import { massWaste } from './hillslope.js';
import { makeContract, check, assignLevels, classifySeam, OPPOSITE, STEP, EDGES, columnLabel, seamGeometry,
         fallOf, portFloor, sizeFor, confluenceSize, widthForFall, edgeSignature } from './contract.js';
import { planChannels, carveChannels } from './river.js';
import { cutTile, conformToContract, verifyEdges, plateStack, tileLabel } from './tile.js';
import { meshTile, checkWatertight, boundingBox } from './mesh.js';

/**
 * Turn river runs into per-tile ports.
 *
 * A river is given as the sequence of tiles it passes through, which is how
 * anyone actually thinks about it, and the outlet/inlet pair on each seam
 * falls out. Declaring forty ports by hand and getting one of them backwards
 * is not a thing anybody should have to debug.
 */
export function portsFromRivers(rivers = []) {
  const tiles = new Map();
  const get = (col, row) => {
    const k = `${col},${row}`;
    if (!tiles.has(k)) tiles.set(k, { col, row, edges: {} });
    return tiles.get(k);
  };
  for (const r of rivers) {
    // null means 'decide for me' -- autoSizeRivers fills it from the inflow.
    const size = r.size ?? null;
    const path = r.path || [];
    for (let i = 0; i < path.length; i++) {
      const [col, row] = path[i];
      const t = get(col, row);
      if (i > 0) {
        const [pc, pr] = path[i - 1];
        const side = EDGES.find((e) => STEP[e][0] === pc - col && STEP[e][1] === pr - row);
        if (!side) throw new Error(`river "${r.name || ''}" jumps from ${pc},${pr} to ${col},${row}; tiles must be edge-adjacent`);
        // Only the source carries the declared size. Everything downstream
        // is worked out from the inflow and the fall, which is the only way
        // a confluence can widen the channel.
        t.edges[side] = { type: 'in', size: null };
      } else if (r.sourceEdge) {
        t.edges[r.sourceEdge] = { type: 'in', size };
      }
      if (i < path.length - 1) {
        const [nc, nr] = path[i + 1];
        const side = EDGES.find((e) => STEP[e][0] === nc - col && STEP[e][1] === nr - row);
        if (!side) throw new Error(`river "${r.name || ''}" jumps from ${col},${row} to ${nc},${nr}; tiles must be edge-adjacent`);
        t.edges[side] = { type: 'out', size: i === 0 && !r.sourceEdge ? size : null };
      } else if (r.sinkEdge) {
        // Water leaving the map is the point, not a mistake: that is where it
        // falls back into the reservoir the pump draws from.
        t.edges[r.sinkEdge] = { type: 'out', size: r.sinkSize ?? null, drain: true };
      }
    }
  }
  return tiles;
}

/** Fill in every tile of the cols x rows grid, so dry tiles exist too. */
export function completeGrid(tiles, cols, rows, levels = {}, falls = {}, waterfalls = {}) {
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const k = `${col},${row}`;
      if (!tiles.has(k)) tiles.set(k, { col, row, edges: {} });
      const t = tiles.get(k);
      if (Number.isFinite(levels[k])) t.level = levels[k];
      if (Number.isFinite(falls[k])) t.fallMM = falls[k];
      // A declared waterfall drops this tile further below its upstream
      // neighbour than its own fall would, and the river free-falls the
      // difference. It goes on the inlet, because that is the side that
      // knows how far it has come down.
      if (Number.isFinite(waterfalls[k])) {
        for (const e of EDGES) {
          if (t.edges?.[e]?.type === 'in') { t.edges[e].waterfallMM = waterfalls[k]; break; }
        }
      }
    }
  }
  return tiles;
}

/**
 * Give every outlet a width, where the map did not.
 *
 * Walked from the sources down, so a tile's inflow is known by the time its
 * outlet is sized. Two rules compose: widths add in quadrature at a
 * confluence, and a steeper tile needs less width for the same water. An
 * outlet the map DOES declare is left alone and checked instead -- it is
 * reported if it is narrower than its inflow needs, rather than silently
 * widened, because the width is also a thing you can see on the printed tile
 * and quietly changing it would be the wrong kind of help.
 */
export function autoSizeRivers(c, tiles) {
  const notes = [];
  const key = (col, row) => `${col},${row}`;
  // Topological order over the river graph.
  const order = [];
  const indeg = new Map();
  for (const t of tiles.values()) indeg.set(key(t.col, t.row), 0);
  for (const t of tiles.values()) {
    for (const e of EDGES) {
      if (t.edges?.[e]?.type !== 'out') continue;
      const [dc, dr] = STEP[e];
      const nk = key(t.col + dc, t.row + dr);
      if (tiles.has(nk)) indeg.set(nk, indeg.get(nk) + 1);
    }
  }
  const q = [...tiles.values()].filter((t) => indeg.get(key(t.col, t.row)) === 0);
  const seen = new Set();
  while (q.length) {
    const t = q.shift();
    const k = key(t.col, t.row);
    if (seen.has(k)) continue;
    seen.add(k);
    order.push(t);
    for (const e of EDGES) {
      if (t.edges?.[e]?.type !== 'out') continue;
      const [dc, dr] = STEP[e];
      const n = tiles.get(key(t.col + dc, t.row + dr));
      if (!n) continue;
      const nk = key(n.col, n.row);
      indeg.set(nk, indeg.get(nk) - 1);
      if (indeg.get(nk) === 0) q.push(n);
    }
  }
  for (const t of tiles.values()) if (!seen.has(key(t.col, t.row))) order.push(t);

  for (const t of order) {
    const ins = EDGES.filter((e) => t.edges?.[e]?.type === 'in');
    const outs = EDGES.filter((e) => t.edges?.[e]?.type === 'out');
    if (!outs.length) continue;
    const inflow = ins.length ? confluenceSize(ins.map((e) => t.edges[e].size)) : sizeFor(t.edges[outs[0]].size);
    const want = ins.length ? widthForFall(inflow, fallOf(c, t), c) : inflow;
    for (const e of outs) {
      const declared = t.edges[e].size;
      if (declared == null) {
        t.edges[e].size = want.id;
      } else if (sizeFor(declared).widthMM < want.widthMM) {
        notes.push({
          kind: 'narrow-outlet', severity: 'warning', tile: key(t.col, t.row), edge: e,
          message: `${columnLabel(t.col)}${t.row + 1} ${e} is declared ${sizeFor(declared).widthMM} mm but takes in ` +
                   `${inflow.widthMM} mm of river over a ${fallOf(c, t)} mm fall, which wants ${want.widthMM} mm. It will flood.`,
        });
      }
      // The downstream tile's inlet has to agree with this outlet.
      const [dc, dr] = STEP[e];
      const n = tiles.get(key(t.col + dc, t.row + dr));
      const back = n?.edges?.[OPPOSITE[e]];
      if (back && back.type === 'in' && back.size == null) back.size = t.edges[e].size;
    }
  }
  return notes;
}

/** The world bed: uplift, then ice, then gravity. */
export function buildWorld(spec, onProgress = () => {}) {
  const cols = spec.cols || 3;
  const rows = spec.rows || 3;
  const n = spec.worldGrid || 128;
  // Real ground the map stands for. Big enough that the glacier has room to
  // behave like a glacier; the print scale is applied later and separately.
  const worldSizeM = spec.worldSizeM || 16000;
  const stepM = worldSizeM / (n - 1);

  onProgress('Uplift');
  const spine = (spec.spine || []).map(([u, v]) => ({ x: u * worldSizeM, y: v * worldSizeM }));
  let bed = baseTerrain({
    nx: n, ny: n, stepM,
    spine: spine.length >= 2 ? spine : null,
    spineHeightM: spec.spineHeightM ?? 1500,
    spineWidthM: spec.spineWidthM ?? worldSizeM * 0.22,
    baseElevM: spec.baseElevM ?? 400,
    roughness: spec.roughness ?? 0.22,
    seed: spec.seed ?? 1,
    flats: (spec.flats || []).map((f) => ({
      x: f.at[0] * worldSizeM, y: f.at[1] * worldSizeM, radiusM: f.radiusM ?? worldSizeM * 0.1, elevM: f.elevM,
    })),
  });

  for (const v of spec.volcanoes || []) {
    onProgress('Volcano');
    addVolcano(bed, {
      x: v.at[0] * worldSizeM, y: v.at[1] * worldSizeM,
      heightM: v.heightM ?? 900, baseRadiusM: v.baseRadiusM ?? worldSizeM * 0.18,
      craterRadiusM: v.craterRadiusM ?? 400, craterDepthM: v.craterDepthM ?? 180,
      breachAzimuthDeg: v.breachAzimuthDeg ?? null, seed: (spec.seed ?? 1) + 5,
    });
  }

  let glacierStats = null;
  if (spec.glacier !== false) {
    onProgress('Ice');
    const g = glaciate(bed, spec.glacier || {});
    bed = g.bed;
    glacierStats = g.stats;
  }

  onProgress('Mass wasting');
  massWaste(bed, { critDeg: spec.reposeDeg ?? 42, passes: spec.reposePasses ?? 8 });

  return { bed, glacierStats, worldSizeM, cols, rows };
}

/**
 * The lattice of corner land heights, which is what stops every tile coming
 * out as a plateau in a picture frame.
 *
 * A height belongs to the CORNER, not to the tiles around it, so the up-to-
 * four tiles that meet there cannot disagree, and the two tiles along a seam
 * read the same pair. Quantising to the plate is what keeps it printable and
 * swappable: a corner is always a whole number of plates up, so the terrain
 * steps across the map in 10 mm instead of being flattened at every rim, and
 * any two pieces declaring the same corners still mate exactly.
 *
 * The floor under it all: a corner is never lower than the highest level of
 * any tile touching it plus the land datum, so every tile keeps a bank above
 * its inlet.
 */
export function cornerLattice(world, c, levels, { cols, rows, reliefMM, terraceMM = null, tiles = null }) {
  const wm = minMax(world);
  const spanM = Math.max(1e-6, wm.max - wm.min);
  const W = (world.nx - 1) * world.step;
  const Hh = (world.ny - 1) * world.step;
  const quantum = terraceMM || c.plateMM;
  const grid = new Map();
  for (let rr = 0; rr <= rows; rr++) {
    for (let cc = 0; cc <= cols; cc++) {
      const wx = world.originX + (cc / cols) * W;
      const wy = world.originY + (rr / rows) * Hh;
      const relief = ((sample(world, wx, wy) - wm.min) / spanM) * reliefMM;
      // The floor under this corner: the highest tile touching it, plus the
      // land datum, so nobody's rim dips below their own base plate.
      //
      // Deliberately NOT raised to clear the deepest port. That was tried,
      // and because a 50 mm fall puts an inlet 52 mm up it dragged every
      // corner of the map above the terrain and reinstated the picture-frame
      // moat. Clearing the water is the levee's job, locally, in edgeProfile.
      let maxLevel = 0;
      for (const [dc, dr] of [[0, 0], [-1, 0], [0, -1], [-1, -1]]) {
        const k = `${cc + dc},${rr + dr}`;
        if (levels.has(k)) maxLevel = Math.max(maxLevel, levels.get(k));
      }
      const floor = maxLevel * c.plateMM + c.edgeLandMM;
      const want = maxLevel * c.plateMM + c.edgeLandMM + relief;
      grid.set(`${cc},${rr}`, Math.max(floor, Math.round(want / quantum) * quantum));
    }
  }
  return grid;
}

/** The four corner heights of one tile, in tile-local mm. */
export function tileCorners(grid, c, spec, level) {
  const base = level * c.plateMM;
  const g = (cc, rr) => (grid.get(`${cc},${rr}`) ?? base + c.edgeLandMM) - base;
  return {
    sw: g(spec.col, spec.row),
    se: g(spec.col + 1, spec.row),
    nw: g(spec.col, spec.row + 1),
    ne: g(spec.col + 1, spec.row + 1),
  };
}

/** The whole job. */
export function buildMap(spec, onProgress = () => {}) {
  const c = makeContract(spec.contract || {});
  const contractNotes = check(c);
  const seam = seamGeometry(c);
  const sizingNotes = [];

  const cols = spec.cols || 3;
  const rows = spec.rows || 3;
  const tiles = completeGrid(portsFromRivers(spec.rivers || []), cols, rows,
    spec.levels || {}, spec.falls || {}, spec.waterfalls || {});
  sizingNotes.push(...autoSizeRivers(c, tiles));
  const { levels, problems } = assignLevels(tiles, c);
  problems.push(...sizingNotes);

  const world = buildWorld(spec, onProgress);
  const wm = minMax(world.bed);

  // Corner heights first: the seam check is meaningless until every tile
  // knows what its rim is supposed to be.
  const grid = cornerLattice(world.bed, c, levels, {
    cols, rows, tiles,
    reliefMM: spec.reliefMM ?? 40,
    terraceMM: spec.terraceMM ?? null,
  });
  for (const t of tiles.values()) {
    t.corners = tileCorners(grid, c, t, levels.get(`${t.col},${t.row}`) ?? 0);
  }

  // Prove every seam before cutting anything.
  const seamChecks = [];
  for (const t of tiles.values()) {
    for (const e of ['N', 'E']) { // each seam once
      const [dc, dr] = STEP[e];
      const nb = tiles.get(`${t.col + dc},${t.row + dr}`);
      if (!nb) continue;
      const lvA = levels.get(`${t.col},${t.row}`);
      const lvB = levels.get(`${nb.col},${nb.row}`);
      const m = classifySeam(c, t, lvA, nb, lvB, e);
      seamChecks.push({ from: tileLabel(t), to: tileLabel(nb), edge: e, ...m });
      // A step is a feature now, not a fault. Only a dam is worth saying
      // something about, because the water behind one has to go somewhere
      // and lake carving is not built yet.
      if (m.kind === 'dam') {
        problems.push({
          kind: 'dam', severity: 'note',
          message: `${tileLabel(t)} ${e} meets ${tileLabel(nb)} ${Math.abs(m.waterStepMM).toFixed(0)} mm HIGHER, so it is a dam ` +
                   `and ${tileLabel(t)} ponds behind it. Nothing carves that reservoir yet — the water will sit in whatever the terrain gives it.`,
        });
      }
    }
  }

  const out = [];
  let i = 0;
  for (const t of tiles.values()) {
    const key = `${t.col},${t.row}`;
    const level = levels.get(key) ?? 0;
    onProgress(`Tile ${tileLabel(t)} (${++i}/${tiles.size})`);

    const local = cutTile(world.bed, c, t, {
      reliefMM: spec.reliefMM ?? 40,
      meshMM: spec.meshMM ?? 0.8,
      worldMinM: wm.min, worldMaxM: wm.max,
      cols, rows,
    });

    // Lean the tile onto its contract BEFORE carving, so the river is cut
    // into ground that is already at the right height, and again after, so
    // the rim is exact whatever the carve did near it.
    conformToContract(local, c, t);
    const channels = planChannels(c, t, { seed: spec.seed ?? 1, col: t.col, row: t.row });
    const carved = carveChannels(local, c, channels);
    conformToContract(local, c, t);
    const edges = verifyEdges(local, c, t);
    const tris = meshTile(local);
    const water = checkWatertight(tris);

    out.push({
      spec: t, label: tileLabel(t), level,
      stack: plateStack(c, level, local),
      fallMM: fallOf(c, t),
      signatures: Object.fromEntries(EDGES.map((e) => [e, edgeSignature(c, t, e, level)])),
      channels: channels.length, carvedCells: carved.cells, wet: carved.wet,
      edges, mesh: water, bbox: boundingBox(tris), tris, local,
    });
  }

  return { contract: c, contractNotes, seam, levels, problems, seamChecks, world, corners: grid, tiles: out };
}
