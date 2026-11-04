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
import { scatterCanopy, CANOPY_DEFAULTS } from './canopy.js';
import { fillHollows, placeLake, LAKE_DEFAULTS } from './lake.js';
import { carveSpring, plateBores, FOUNTAIN_DEFAULTS } from './fountain.js';
import { planKeys, cutRecesses, jointSettings } from './joint.js';
import { portPoint } from './river.js';
import { editsFor, applyGroundEdits, clearFilter, plantings, EDIT_DEFAULTS } from './edits.js';

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
 *
 * `world` may be null. That is the editor asking before anything has been
 * grown, and it reads as flat ground: every corner at its floor, which is the
 * lowest a rim can come out. `raise` lifts single corners, keyed 'cc,rr' and
 * counted like tiles from the south-west ('1,1' is A1's north-east corner),
 * in mm on top of whatever the ground gave. Because a corner is shared, the
 * four tiles round it all rise together and every seam still mates.
 */
export function cornerLattice(world, c, levels, { cols, rows, reliefMM, terraceMM = null, tiles = null, raise = null }) {
  const wm = world ? minMax(world) : { min: 0, max: 1 };
  const spanM = Math.max(1e-6, wm.max - wm.min);
  const W = world ? (world.nx - 1) * world.step : 0;
  const Hh = world ? (world.ny - 1) * world.step : 0;
  const quantum = terraceMM || c.plateMM;
  const grid = new Map();
  for (let rr = 0; rr <= rows; rr++) {
    for (let cc = 0; cc <= cols; cc++) {
      const relief = world
        ? ((sample(world, world.originX + (cc / cols) * W, world.originY + (rr / rows) * Hh) - wm.min) / spanM) * reliefMM
        : 0;
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
      const ground = Math.max(floor, Math.round(want / quantum) * quantum);
      const lift = Number(raise?.[`${cc},${rr}`]) || 0;
      grid.set(`${cc},${rr}`, Math.max(floor, ground + lift));
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

/**
 * The whole job.
 *
 * `world`, if given, is the result of buildWorld for this same spec -- the
 * same worldKey(spec, { ice: true }) -- and is used instead of growing it
 * again: the ground is a pure function of those fields, so this changes
 * nothing but the time. It is how the editor rebuilds after a brushstroke
 * without running the ice again.
 */
export function buildMap(spec, onProgress = () => {}, { world: given = null } = {}) {
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

  const joint = jointSettings(spec.joints || {});
  const allKeys = planKeys(tiles, levels, c, joint);

  let world;
  if (given) {
    onProgress('The ground, as grown before');
    world = { ...given, cols, rows };
  } else {
    world = buildWorld(spec, onProgress);
  }
  const wm = minMax(world.bed);

  // Corner heights first: the seam check is meaningless until every tile
  // knows what its rim is supposed to be.
  const grid = cornerLattice(world.bed, c, levels, {
    cols, rows, tiles,
    reliefMM: spec.reliefMM ?? 40,
    terraceMM: spec.terraceMM ?? null,
    raise: spec.cornerRaise || null,
  });
  for (const t of tiles.values()) {
    t.corners = tileCorners(grid, c, t, levels.get(`${t.col},${t.row}`) ?? 0);
  }

  // Prove every seam before cutting anything.
  const seamChecks = [];
  const ponds = new Map();
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
        // The upstream tile ponds up to the level it would have to climb,
        // which is the downstream tile's inlet in world height. That is the
        // reservoir, and it is carved like any other lake.
        const surfaceWorldZ = lvB * c.plateMM + portFloor(c, nb, 'in');
        ponds.set(`${t.col},${t.row}`, { surfaceWorldZ, edge: e, from: tileLabel(nb) });
        problems.push({
          kind: 'dam', severity: 'note',
          message: `${tileLabel(t)} ${e} meets ${tileLabel(nb)} ${Math.abs(m.waterStepMM).toFixed(0)} mm HIGHER, so it is a dam. ` +
                   `${tileLabel(t)} is ponded to ${surfaceWorldZ.toFixed(0)} mm.`,
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

    // ROUTE BEFORE CONFORMING. The river is routed over the ground the
    // glacier left -- see valleyPath -- and that has to be the RAW ground.
    // Conforming first digs a trough: the rim profile has a deep notch at
    // each port, and the transfinite patch that fits the interior to it
    // interpolates between those notches, leaving a straight channel-shaped
    // depression down the middle of the tile. Route on that and every river
    // comes out dead straight, faithfully following a valley the rim
    // fitting invented.
    const channels = planChannels(c, t, { seed: spec.seed ?? 1, col: t.col, row: t.row, local });

    // Now lean the tile onto its contract, cut the river into ground that
    // is already at the right height, and conform again so the rim is exact
    // whatever the carve did near it.
    conformToContract(local, c, t);
    const carved = carveChannels(local, c, channels);
    conformToContract(local, c, t);

    // HAND EDITS, replayed onto this ground (see edits.js): after the carve,
    // so a stroke across the river is the author's to make, and before the
    // lakes, so a lake can sit in a hollow somebody dug. The rim is locked
    // inside every edit, and the conform after is the same proof the carve
    // gets.
    const edits = editsFor(spec, tileLabel(t));
    if (edits.length) {
      const r = applyGroundEdits(local, edits, { rimLockMM: c.rimLockMM ?? EDIT_DEFAULTS.rimLockMM });
      for (const sk of r.skipped) {
        problems.push({ kind: 'edit', severity: 'warning', message: `${tileLabel(t)}: edit ${sk.index + 1} was not made — ${sk.why}.` });
      }
      if (r.applied) conformToContract(local, c, t);
    }

    // WATER, after the tile has been conformed and before anything is
    // planted. After, because the contract is fitted by adding a smooth
    // correction across the whole tile and that would TILT a flat water
    // surface. Before the woods, so nothing grows in a lake.
    const lake = { lakes: [], skipped: [], millilitres: 0 };
    const lakeSpec = { ...LAKE_DEFAULTS, ...(spec.lakes || {}) };
    const addWet = (w) => { if (w) for (let k = 0; k < w.length; k++) if (w[k]) carved.wet[k] = 1; };

    // 1. The reservoir behind a dam.
    const pond = ponds.get(key);
    if (pond) {
      const pp = portPoint(c, pond.edge);
      const inward = 0.12 * c.tileMM;
      const r = placeLake(local, {
        ...lakeSpec,
        atMM: [pp.x + pp.inward[0] * inward, pp.y + pp.inward[1] * inward],
        surfaceZMM: pond.surfaceWorldZ - level * c.plateMM,
        allowRim: true,
      });
      if (r.skipped) lake.skipped.push({ what: 'dam reservoir', why: r.skipped });
      else { lake.lakes.push({ what: 'reservoir', ...r }); addWet(r.wet); }
    }

    // 2. A bay or fjord mouth opens into water, which is the whole point of
    // a 40 or 50 mm port. Its surface sits at the mouth, so the two meet.
    for (const e of EDGES) {
      const ed = t.edges?.[e];
      if (!ed || ed.type === 'land' || sizeFor(ed.size).kind !== 'water-body') continue;
      const pp = portPoint(c, e);
      const inward = 0.16 * c.tileMM;
      const mouth = sizeFor(ed.size).widthMM;
      const r = placeLake(local, {
        ...lakeSpec,
        atMM: [pp.x + pp.inward[0] * inward, pp.y + pp.inward[1] * inward],
        surfaceZMM: portFloor(c, t, ed.type),
        // Dug out, not flooded: the land gets out of the water's way.
        radiusMM: spec.lakes?.mouthRadiusMM ?? mouth * 1.6,
        seed: (spec.seed ?? 1) * 31 + t.col * 7 + t.row,
        allowRim: true,
      });
      if (r.skipped) lake.skipped.push({ what: `${sizeFor(ed.size).id} at ${e}`, why: r.skipped });
      else { lake.lakes.push({ what: sizeFor(ed.size).id, ...r }); addWet(r.wet); }
    }

    // 3. Lakes somebody placed.
    for (const spot of (spec.lakes?.place) || []) {
      if (spot.tile && spot.tile !== tileLabel(t)) continue;
      const r = placeLake(local, { ...lakeSpec, ...spot });
      if (r.skipped) lake.skipped.push({ what: `lake at ${spot.atMM}`, why: r.skipped });
      else { lake.lakes.push({ what: 'lake', ...r }); addWet(r.wet); }
    }

    // 4. And the hollows the ice left, which are tarns.
    if (spec.lakes?.fillHollows !== false) {
      const r = fillHollows(local, lakeSpec);
      for (const l of r.lakes) lake.lakes.push({ what: 'tarn', ...l });
      for (const sk of r.skipped) lake.skipped.push({ what: 'tarn', why: sk.skipped });
      addWet(r.wet);
    }
    lake.millilitres = lake.lakes.reduce((a, l) => a + (l.millilitres || 0), 0);

    // SPRINGS, where the water has to appear. The map already knows where
    // those are: an inlet with nothing upstream of it is a port taking
    // water from off the map, which is reported as needing a fountain or a
    // hose. So that is exactly where one goes.
    const springs = [];
    const fSpec = { ...FOUNTAIN_DEFAULTS, ...(spec.fountains || {}) };
    const wantSpring = [];
    if (spec.fountains?.auto !== false && spec.fountains) {
      for (const e of EDGES) {
        const ed = t.edges?.[e];
        if (!ed || ed.type !== 'in') continue;
        const [dc, dr] = STEP[e];
        const up = tiles.get(`${t.col + dc},${t.row + dr}`);
        if (up && up.edges?.[OPPOSITE[e]]?.type === 'out') continue; // fed by a neighbour
        wantSpring.push({ edge: e });
      }
    }
    for (const spot of (spec.fountains?.place) || []) {
      if (!spot.tile || spot.tile === tileLabel(t)) wantSpring.push({ ...spot, manual: true });
    }

    for (const want of wantSpring) {
      let atMM = want.atMM;
      let spillToward = want.spillToward;
      if (!atMM && want.edge) {
        // Sit the pool on the channel that leaves this port, far enough in
        // that its lip and blend are clear of the rim.
        const ch = channels.find((cc) => cc.path.pts.length > 4);
        const clear = fSpec.poolRadiusMM + fSpec.lipWidthMM + fSpec.blendMM + 2;
        if (ch) {
          const pts = ch.path.pts;
          let pick = pts[0];
          for (const q of pts) {
            if (Math.min(q.x, q.y, c.tileMM - q.x, c.tileMM - q.y) >= clear) { pick = q; break; }
          }
          atMM = [pick.x, pick.y];
          const nxt = pts[Math.min(pts.length - 1, pts.indexOf(pick) + 6)] || pts[pts.length - 1];
          spillToward = Math.atan2(nxt.y - pick.y, nxt.x - pick.x);
        } else {
          const pp = portPoint(c, want.edge);
          atMM = [pp.x + pp.inward[0] * clear, pp.y + pp.inward[1] * clear];
          spillToward = Math.atan2(pp.inward[1], pp.inward[0]);
        }
      }
      const r = carveSpring(local, { ...fSpec, ...want, atMM, spillToward: spillToward ?? 0 });
      if (r.skipped) {
        problems.push({ kind: 'fountain', severity: 'warning',
          message: `${tileLabel(t)}: no spring placed — ${r.skipped}` });
      } else {
        springs.push(r);
        // Nothing grows in the pool.
        const ri = Math.round(r.atMM[0] / local.step);
        const rj = Math.round(r.atMM[1] / local.step);
        const rad = Math.ceil(r.poolRadiusMM / local.step);
        for (let jj = rj - rad; jj <= rj + rad; jj++) {
          for (let ii = ri - rad; ii <= ri + rad; ii++) {
            if (ii < 0 || jj < 0 || ii >= local.nx || jj >= local.ny) continue;
            if (Math.hypot(ii - ri, jj - rj) <= rad) carved.wet[jj * local.nx + ii] = 1;
          }
        }
      }
    }

    // Woods go on last, and are kept clear of the rim by their own radius,
    // so a tree never crosses a seam. See canopy.js. Ground somebody cleared
    // by hand stays clear; woods somebody planted by hand go in after the
    // map's own, and not on top of them.
    const woods = [];
    const keep = clearFilter(edits);
    const warnOnce = (w) => { if (!problems.some((p) => p.message === w)) problems.push({ kind: 'canopy', severity: 'warning', message: w }); };
    for (const spot of spec.canopy || []) {
      if (spot.tiles && !spot.tiles.includes(tileLabel(t))) continue;
      const r = scatterCanopy(local, {
        ...spot,
        seed: (spec.seed ?? 1) * 131 + t.col * 17 + t.row * 7,
        wet: carved.wet,
        baseMM: level * c.plateMM, // so a treeline is a map-wide elevation
        ...(keep ? { where: keep } : {}),
      });
      if (r.trees) woods.push({ kind: spot.kind || CANOPY_DEFAULTS.kind, ...r });
      for (const w of r.warnings) warnOnce(w);
    }
    for (const { inside, ...plant } of plantings(edits)) {
      const covered = new Uint8Array(local.nx * local.ny);
      for (const w of woods) if (w.mask) for (let k = 0; k < covered.length; k++) if (w.mask[k]) covered[k] = 1;
      const cell = (x, y) => Math.min(local.ny - 1, Math.max(0, Math.round(y / local.step))) * local.nx
        + Math.min(local.nx - 1, Math.max(0, Math.round(x / local.step)));
      const r = scatterCanopy(local, {
        ...plant,
        wet: carved.wet,
        baseMM: level * c.plateMM,
        where: (x, y) => inside(x, y) && (!keep || keep(x, y)) && !covered[cell(x, y)],
      });
      if (r.trees) woods.push({ ...r, kind: plant.kind, planted: true });
      for (const w of r.warnings) warnOnce(w);
    }

    const edges = verifyEdges(local, c, t);
    // Key recesses, cut into the underside once everything above is
    // settled, so the "is there enough plate here" test sees the real
    // thing -- channel, lake bed, spring pool and all.
    const bores = springs.map((sp) => sp.bore);
    const mine = [];
    for (const key of allKeys) {
      if (key.a.col === t.col && key.a.row === t.row) mine.push({ ...key.a, id: key.id });
      if (key.b.col === t.col && key.b.row === t.row) mine.push({ ...key.b, id: key.id });
    }
    const rec = cutRecesses(local, c, mine, joint, bores);
    const tris = meshTile(local, { bores, floor: rec.any ? rec.floor : null });
    const water = checkWatertight(tris);

    out.push({
      spec: t, label: tileLabel(t), level,
      stack: plateStack(c, level, local),
      fallMM: fallOf(c, t),
      signatures: Object.fromEntries(EDGES.map((e) => [e, edgeSignature(c, t, e, level)])),
      channels: channels.length, carvedCells: carved.cells, wet: carved.wet,
      lakes: lake.lakes, lakesSkipped: lake.skipped, millilitres: lake.millilitres,
      springs, drilledPlates: plateBores(springs, level),
      keys: rec.placed, keysRefused: rec.refused,
      woods, trees: woods.reduce((a, w) => a + w.trees, 0),
      edges, mesh: water, bbox: boundingBox(tris), tris, local,
    });
  }

  // Edits for a tile the map does not have are kept, not lost: say so.
  const built = new Set(out.map((t) => t.label));
  for (const label of Object.keys(spec.edits || {})) {
    if (!built.has(label) && editsFor(spec, label).length) {
      problems.push({ kind: 'edit', severity: 'note', message: `There are edits for ${label}, which is not on this map. They are kept, and come back if it does.` });
    }
  }

  return { contract: c, contractNotes, seam, levels, problems, seamChecks, world, corners: grid, joint, keys: allKeys, tiles: out };
}
