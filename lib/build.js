// build.js — a module spec in, one printable module out.
//
// Two halves. buildWorld grows the ground: uplift, ice, gravity, on a world
// that is the module plus its margin, in metres. buildTile cuts the module
// out of that, leans it onto the contract, cuts the channels that were
// drawn on it, replays the hand edits, puts in the water, the springs and
// the woods, and meshes it. The world is a pure function of a few spec
// fields (see worldKey), so an editor can keep it and rebuild only the
// module when a channel moves.

import { makeField, minMax } from './field.js';
import { baseTerrain, addVolcano, addCirqueSeed } from './terrain.js';
import { fluvialErode } from './fluvial.js';
import { fbm } from './noise.js';
import { weaknessField, ROCK_DEFAULTS } from './rock.js';
import { detailPass } from './detail.js';
import { glaciate } from './glacier.js';
import { massWaste } from './hillslope.js';
import { scaleOf, marginOf, verticalOf, worldSizeM as worldSizeOf } from './scale.js';
import { makeContract, check, EDGES, edgeSignature, portFloor, portFloorAt, edgeLand, minEdgeLand, classOf } from './contract.js';
import { planChannels, profileChannels, carveChannels, springOnChannel } from './channel.js';
import { cutTile, conformToContract, verifyEdges, cutSeamGrooves } from './tile.js';
import { meshTile, checkWatertight, boundingBox } from './mesh.js';
import { scatterCanopy, CANOPY_DEFAULTS } from './canopy.js';
import { fillHollows, placeLake, LAKE_DEFAULTS } from './lake.js';
import { carveSpring, carveChamber, lakeSpring, FOUNTAIN_DEFAULTS } from './fountain.js';
import { edgeLocks, cutLockFeatures, cutSockets, lockSettings, checkLock, camHeights } from './joint.js';
import { editsFor, applyGroundEdits, clearFilter, plantings, EDIT_DEFAULTS } from './edits.js';

/**
 * The spec fields the ground depends on, which is what a kept world is
 * keyed on. The ice is left out on request: an editor can estimate the
 * ground without it in a tenth of a second where the glacier takes seconds.
 */
export const WORLD_FIELDS = ['seed', 'worldGrid', 'marginMM', 'metresPerMM', 'verticalExaggeration', 'spine', 'spineHeightMM', 'spineWidthMM',
  'baseElevMM', 'roughness', 'flats', 'volcanoes', 'cirques', 'rivers', 'rock', 'reposeDeg', 'reposePasses'];

export function worldKey(spec, { ice = false } = {}) {
  const pick = {};
  for (const k of WORLD_FIELDS) if (spec[k] !== undefined) pick[k] = spec[k];
  pick.tileMM = spec.contract?.tileMM ?? 200;
  if (ice) { pick.glacier = spec.glacier ?? null; pick.detail = spec.detail ?? null; }
  return JSON.stringify(pick);
}

/** The defaults a cirque marker is read with. */
export const CIRQUE_DEFAULTS = { radiusMM: 16, depthMM: 8, facingDeg: 90, snowM: 260 };

/**
 * The ice as a spec reads it when `glacier` says nothing: the example's
 * numbers. 24 advances, and the snowline swinging 18 mm of print either side
 * of its mean. The swing is in print millimetres so that it scales with the
 * mountain it is given: 450 real metres, the physics default, is most of a
 * 60 mm range at 2x, and the ice came and went with the climate instead of
 * carving a staircase of cirques into it.
 */
export const GLACIER_SPEC_DEFAULTS = { cycles: 24, elaSwingMM: 18 };

/**
 * The world bed: uplift, then ice, then gravity.
 *
 * Everything in the spec is millimetres on the module, with (0, 0) at its
 * south-west corner; a feature may sit in the margin, outside 0..tileMM,
 * which is how a range the ice comes down from is put beyond the rim.
 * Everything from here down is metres of real ground, because that is the
 * only scale on which ice behaves like ice. See scale.js.
 */
export function buildWorld(spec, onProgress = () => {}, { detail: wantDetail = true } = {}) {
  // 112 over the module and a 60 mm margin is under 3 mm of print a cell,
  // which holds a trough and a cirque; the fine pass (detail.js) takes it
  // from there. The ice's cost grows about seven-fold each time this
  // doubles.
  const n = spec.worldGrid || 112;
  const scale = scaleOf(spec);
  const ex = verticalOf(spec);
  const tileMM = spec.contract?.tileMM ?? 200;
  const marginMM = marginOf(spec, tileMM);
  const worldSizeM = worldSizeOf(spec, tileMM);
  const stepM = worldSizeM / (n - 1);
  const mm = (v) => v * scale; // print mm across -> ground metres
  const mmUp = (v) => (v * scale) / ex; // print mm UP -> ground metres; see verticalOf
  const at = ([x, y]) => ({ x: mm((Number(x) || 0) + marginMM), y: mm((Number(y) || 0) + marginMM) });

  onProgress('Uplift');
  const spine = (spec.spine || []).map(at);
  let bed = baseTerrain({
    nx: n, ny: n, stepM,
    spine: spine.length >= 2 ? spine : null,
    spineHeightM: mmUp(spec.spineHeightMM ?? 60),
    spineWidthM: spec.spineWidthMM !== undefined ? mm(spec.spineWidthMM) : mm(tileMM) * 0.45,
    baseElevM: mmUp(spec.baseElevMM ?? 16),
    roughness: spec.roughness ?? 0.22,
    seed: spec.seed ?? 1,
    flats: (spec.flats || []).map((f) => ({
      ...at(f.at),
      radiusM: f.radiusMM !== undefined ? mm(f.radiusMM) : mm(tileMM) * 0.2,
      elevM: f.elevMM !== undefined ? mmUp(f.elevMM) : undefined,
    })),
  });

  for (const v of spec.volcanoes || []) {
    onProgress('Volcano');
    addVolcano(bed, {
      ...at(v.at),
      heightM: mmUp(v.heightMM ?? 32),
      baseRadiusM: v.baseRadiusMM !== undefined ? mm(v.baseRadiusMM) : mm(tileMM) * 0.36,
      craterRadiusM: mm(v.craterRadiusMM ?? 16),
      craterDepthM: mmUp(v.craterDepthMM ?? 7),
      breachAzimuthDeg: v.breachAzimuthDeg ?? null, seed: (spec.seed ?? 1) + 5,
    });
  }

  // CIRQUES ASKED FOR: a hollow cut where each should start, and the
  // snowline lowered there so the ice gathers in it first. See addCirqueSeed.
  let elaShiftM = null;
  for (const cq of spec.cirques || []) {
    if (!Array.isArray(cq?.at)) continue;
    const o = { ...CIRQUE_DEFAULTS, ...cq };
    const w = addCirqueSeed(bed, { ...at(cq.at), radiusM: mm(o.radiusMM), facingRad: (o.facingDeg * Math.PI) / 180, depthM: mmUp(o.depthMM) });
    elaShiftM = elaShiftM || new Float64Array(n * n);
    for (let k = 0; k < w.length; k++) if (w[k] * o.snowM > elaShiftM[k]) elaShiftM[k] = w[k] * o.snowM;
  }

  // THE ROCK: jointed, so strong blocks stand in walls and joints give way.
  const rock = { ...ROCK_DEFAULTS, seed: (spec.seed ?? 1) + 101, ...(spec.rock || {}) };
  const weak = weaknessField(bed, rock);

  // RIVERS FIRST. See fluvial.js: the ice takes over valleys, it does not
  // invent them.
  let fluvialStats = null;
  if (spec.rivers !== false) {
    onProgress('Rivers');
    // Small-scale roughness for the drainage to organise around: on a smooth
    // flank every river runs straight down the fall line, side by side.
    const rough = (spec.rivers && Number.isFinite(spec.rivers.roughness)) ? spec.rivers.roughness : 0.04;
    if (rough > 0) {
      let lo = Infinity; let hi = -Infinity;
      for (const v of bed.values) { if (v < lo) lo = v; if (v > hi) hi = v; }
      for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
        const x = i * stepM; const y = j * stepM;
        bed.values[j * n + i] += (hi - lo) * rough * fbm(x, y, { scale: 900, octaves: 3, seed: (spec.seed ?? 1) + 303 });
      }
    }
    // The rivers' slopes are relaxed to one moderate angle, not to the
    // rock's: on this coarse grid an 80-degree wall is one cell, and the
    // ice cannot flow over walls like that without going unstable and
    // filling every valley to the brim. The walls come later, on the fine
    // grid (detail.js), where they are many cells tall.
    fluvialStats = fluvialErode(bed, {
      critDeg: 40, erodibility: Float64Array.from(weak, (v) => 0.75 + 0.5 * v), keepRelief: true, ...(spec.rivers || {}),
    });
  }

  let glacierStats = null;
  if (spec.glacier !== false) {
    onProgress('Ice');
    const gspec = { ...(spec.glacier || {}) };
    if (gspec.cycles === undefined) gspec.cycles = GLACIER_SPEC_DEFAULTS.cycles;
    if (gspec.elaSwingMM === undefined && gspec.elaSwingM === undefined) gspec.elaSwingMM = GLACIER_SPEC_DEFAULTS.elaSwingMM;
    if (gspec.elaSwingMM !== undefined) { gspec.elaSwingM = mmUp(gspec.elaSwingMM); delete gspec.elaSwingMM; }
    if (gspec.elaMM !== undefined) { gspec.elaM = mmUp(gspec.elaMM); delete gspec.elaMM; }
    // One wall angle under the ice, not the rock's: see the rivers above.
    const g = glaciate(bed, { elaShiftM, ...gspec });
    bed = g.bed;
    glacierStats = g.stats;
  }

  onProgress('Mass wasting');
  // On the coarse grid, one angle; the rock's own angles are the fine
  // pass's business, where a wall is many cells tall.
  massWaste(bed, { critDeg: spec.reposeDeg ?? 45, passes: spec.reposePasses ?? 8 });

  // THE FINE PASS over the module: towers, gullies and walls. See detail.js.
  let detail = null;
  if (wantDetail && spec.detail !== false) {
    onProgress('Frost and towers');
    detail = detailPass(bed, { tileMM, marginMM, metresPerMM: scale, exaggeration: ex, rock, ...(spec.detail || {}) });
  }

  return { bed, detail, glacierStats, fluvialStats, worldSizeM, marginMM, tileMM, exaggeration: ex };
}

/**
 * The whole job for one module.
 *
 * `world`, if given, is the result of buildWorld for this same spec -- the
 * same worldKey(spec, { ice: true }) -- and is used instead of growing it
 * again. It is how the editor rebuilds after a brushstroke without running
 * the ice again.
 */
export function buildTile(spec, onProgress = () => {}, { world: given = null } = {}) {
  const c = makeContract(spec.contract || {});
  // `locks` is the cam lock's settings; `joints` is what an older spec
  // called the seam keys, and only its on/off is still read.
  const joint = lockSettings({ ...(spec.joints?.enabled === false ? { enabled: false } : {}), ...(spec.locks || {}) });
  const contractNotes = [...check(c), ...checkLock(c, joint)];
  const problems = [];

  let world;
  if (given) {
    onProgress('The ground, as grown before');
    world = given;
  } else {
    world = buildWorld(spec, onProgress);
  }

  onProgress('Cutting the module');
  const cutOpts = { marginMM: world.marginMM ?? marginOf(spec, c.tileMM), metresPerMM: scaleOf(spec), meshMM: spec.meshMM ?? 0.8, exaggeration: world.exaggeration ?? verticalOf(spec) };
  // CHANNELS: planned on the raw ground, so a routed one finds the valley
  // the ice left rather than one the rim fitting invented. Which ports
  // they cross is then known; the datum is read at them (see cutTile) and
  // the rim is conformed to them.
  // The fine pass's field where there is one: it covers the module and a
  // little round it, in the same metres and frame as the bed.
  const ground = world.detail || world.bed;
  let local = cutTile(ground, c, cutOpts);
  const planned = planChannels(c, spec, local, { seed: spec.seed ?? 1 });
  for (const n of planned.notes) problems.push({ kind: 'channel', ...n });
  const ports = planned.ports;
  if (EDGES.some((e) => ports[e])) local = cutTile(ground, c, { ...cutOpts, ports });
  if (local.squeezedMM > 0.5) {
    problems.push({
      kind: 'ground', severity: 'note',
      message: `The lowest ground is ${local.squeezedMM.toFixed(0)} mm shallower than the metres say, so that it keeps ` +
               `${c.minLandMM} mm of plastic under it. The ice dug deeper than a ${minEdgeLand(c)} mm rim has room for.`,
    });
  }

  // The channels are read off the ground as cutTile leaves it -- leaned
  // onto a LAND rim on every side -- so a port's dip is not in the line's
  // ground (see profileChannels). The carve then cuts the port's shape, and
  // the conform after it is exact.
  onProgress('Channels');
  profileChannels(local, c, planned.channels);
  const carved = carveChannels(local, c, planned.channels);
  conformToContract(local, c, ports);
  for (const ch of planned.channels) {
    if (ch.isGorge && ch.gorgeMM > 0.5) {
      problems.push({
        kind: 'channel', severity: 'note',
        message: `${ch.name} crosses a ridge, so it is cut as a gorge through it, up to ${ch.gorgeMM.toFixed(1)} mm ` +
                 `deeper than its ${ch.depthMM} mm: water does not run uphill.`,
      });
    }
    if (!ch.isGorge && ch.climbMM > 0.5) {
      problems.push({
        kind: 'channel', severity: 'note',
        message: `${ch.name} is a creek on the surface and rides over a rise ${ch.climbMM.toFixed(1)} mm high on its line, so water ponds behind it. ` +
                 'Move the line, or make it a gorge.',
      });
    }
    if (ch.pondMM > 0.5) {
      problems.push({
        kind: 'channel', severity: 'note',
        message: `${ch.name}'s line goes ${ch.pondMM.toFixed(1)} mm below the floor of the ${ch.to} port before it gets there, ` +
                 'so the water stands that deep behind the port before it spills out. Give that side a lower class, or move the line.',
      });
    }
  }

  // HAND EDITS, replayed onto this ground (see edits.js): after the carve,
  // so a stroke across the channel is the author's to make, and before the
  // lakes, so a lake can sit in a hollow somebody dug.
  const edits = editsFor(spec);
  if (edits.length) {
    const r = applyGroundEdits(local, edits, { rimLockMM: c.rimLockMM ?? EDIT_DEFAULTS.rimLockMM });
    for (const sk of r.skipped) problems.push({ kind: 'edit', severity: 'warning', message: `edit ${sk.index + 1} was not made — ${sk.why}.` });
    if (r.applied) conformToContract(local, c, ports);
  }
  // The silicone rebate across every port, after the last conform so it is
  // a crisp step at the seam. See cutSeamGrooves.
  const grooves = cutSeamGrooves(local, c, ports);

  // WATER, after the module has been conformed -- the contract is fitted by
  // adding a smooth correction across the whole module and that would TILT
  // a flat water surface -- and before the woods, so nothing grows in a lake.
  onProgress('Water');
  const lake = { lakes: [], skipped: [], millilitres: 0 };
  const lakeSpec = { ...LAKE_DEFAULTS, ...(spec.lakes || {}) };
  const addWet = (w) => { if (w) for (let k = 0; k < w.length; k++) if (w[k]) carved.wet[k] = 1; };
  for (const spot of (spec.lakes?.place) || []) {
    const r = placeLake(local, { ...lakeSpec, ...spot });
    if (r.skipped) lake.skipped.push({ what: `lake at ${spot.atMM || 'its stroke'}`, why: r.skipped });
    else { lake.lakes.push({ what: 'lake', ...r }); addWet(r.wet); }
  }
  if (spec.lakes?.fillHollows !== false) {
    const r = fillHollows(local, lakeSpec);
    for (const l of r.lakes) lake.lakes.push({ what: 'tarn', ...l });
    for (const sk of r.skipped) lake.skipped.push({ what: 'tarn', why: sk.skipped });
    lake.filledIn = r.filledIn;
    for (const i of r.unusedResizes) {
      problems.push({
        kind: 'lake', severity: 'warning',
        message: `resize ${i + 1} of the tarns is for a lake at ${(lakeSpec.resize[i].atMM || []).map((v) => Math.round(v)).join(', ')} mm, ` +
                 'and there is no hollow there any more: the ground has changed. Take it off, or click the lake again.',
      });
    }
    addWet(r.wet);
  }
  lake.millilitres = lake.lakes.reduce((a, l) => a + (l.millilitres || 0), 0);

  // SPRINGS, where the water has to appear: at the start of every channel
  // if `auto`, and wherever one was placed.
  const springs = [];
  const fSpec = { ...FOUNTAIN_DEFAULTS, ...(spec.fountains || {}) };
  const wantSpring = [];
  if (spec.fountains && spec.fountains.auto !== false) {
    const clear = fSpec.kind === 'pool' ? fSpec.poolRadiusMM + fSpec.lipWidthMM + fSpec.blendMM + 2 : fSpec.chamberRadiusMM + 4;
    for (const ch of planned.channels) wantSpring.push({ ...springOnChannel(c, ch, clear), channel: ch.name });
  }
  for (const spot of (spec.fountains?.place) || []) wantSpring.push({ ...spot, manual: true });
  // Standing water: a spring put in it is a tube into the lake's bed.
  const still = new Uint8Array(local.nx * local.ny);
  for (const l of lake.lakes) if (l.wet) for (let k = 0; k < still.length; k++) if (l.wet[k]) still[k] = 1;
  const lidded = new Uint8Array(local.nx * local.ny); // the chambers' lids: no tree grows on one
  for (const want of wantSpring) {
    const kind = want.kind || fSpec.kind;
    const ci = Math.min(local.nx - 1, Math.max(0, Math.round(want.atMM[0] / local.step)));
    const cj = Math.min(local.ny - 1, Math.max(0, Math.round(want.atMM[1] / local.step)));
    let r;
    if (still[cj * local.nx + ci]) r = lakeSpring(local, { ...fSpec, ...want });
    else if (kind === 'pool') r = carveSpring(local, { ...fSpec, ...want, spillToward: want.spillToward ?? 0 });
    else {
      if (kind === 'lake') problems.push({ kind: 'fountain', severity: 'note', message: `the spring at ${want.atMM.map((v) => Math.round(v)).join(', ')} mm is not in a lake, so it is a chamber.` });
      r = carveChamber(local, { ...fSpec, ...want });
    }
    if (r.skipped) { problems.push({ kind: 'fountain', severity: 'warning', message: `no spring placed — ${r.skipped}` }); continue; }
    springs.push(r);
    if (r.kind === 'chamber') {
      for (const k of r.cover.cells) lidded[k] = 1;
      if (r.openRatio < 1.5) {
        problems.push({ kind: 'fountain', severity: 'warning', message: `the chamber at ${r.atMM.map((v) => Math.round(v)).join(', ')} mm opens only ${r.openRatio.toFixed(1)} times its tube's bore, so the water leaves almost as fast as it arrives. Make it wider.` });
      }
      continue;
    }
    if (r.kind === 'lake') continue;
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

  // THE LOCKS: on every side a cam housing and a key pocket, mirrored about
  // the port, and a socket in each corner for a spacer plate's pin. All of
  // it is cut up into the underside -- the cams' bores are blind -- so the
  // top is the ground and nothing else, and a tree may stand over a cam.
  // See joint.js.
  onProgress('Locks');
  const springBores = springs.map((sp) => sp.bore);
  const locks = cutLockFeatures(local, c, edgeLocks(c, joint), joint, springBores);
  const sockets = cutSockets(local, c, joint, locks.floor, [...springBores, ...locks.bores]);

  // WOODS go on last, and are kept clear of the rim by their own radius,
  // so a tree never crosses a seam. Ground somebody cleared by hand stays
  // clear; woods somebody planted by hand go in after the map's own.
  onProgress('Woods');
  const woods = [];
  const keep = clearFilter(edits);
  const offLimits = Uint8Array.from(carved.wet, (v, k) => (v || lidded[k] ? 1 : 0));
  const warnOnce = (w) => { if (!problems.some((p) => p.message === w)) problems.push({ kind: 'canopy', severity: 'warning', message: w }); };
  (spec.canopy || []).forEach((spot, i) => {
    const r = scatterCanopy(local, { ...spot, seed: (spec.seed ?? 1) * 131 + i * 17, wet: offLimits, baseMM: 0, ...(keep ? { where: keep } : {}) });
    if (r.trees) woods.push({ kind: spot.kind || CANOPY_DEFAULTS.kind, ...r });
    for (const w of r.warnings) warnOnce(w);
  });
  for (const { inside, index, ...plant } of plantings(edits)) {
    const cleared = clearFilter(edits, index);
    const covered = new Uint8Array(local.nx * local.ny);
    for (const w of woods) if (w.mask) for (let k = 0; k < covered.length; k++) if (w.mask[k]) covered[k] = 1;
    const cell = (x, y) => Math.min(local.ny - 1, Math.max(0, Math.round(y / local.step))) * local.nx
      + Math.min(local.nx - 1, Math.max(0, Math.round(x / local.step)));
    const r = scatterCanopy(local, { ...plant, wet: offLimits, baseMM: 0, where: (x, y) => inside(x, y) && (!cleared || cleared(x, y)) && !covered[cell(x, y)] });
    if (r.trees) woods.push({ ...r, kind: plant.kind, planted: true });
    for (const w of r.warnings) warnOnce(w);
  }

  onProgress('Meshing');
  const edges = verifyEdges(local, c, ports);
  const bores = [...springBores, ...locks.bores];
  const cutBelow = locks.any || sockets.placed.length > 0;
  const tris = meshTile(local, { bores, floor: cutBelow ? locks.floor : null });
  const water = checkWatertight(tris);
  const { min: lowMM, max: highMM } = minMax(local);
  // The module as it looks with its lids in: the chambers are holes in the
  // print, but the lid that drops into each is the ground that was there.
  // What the hillshade and the 3D view show.
  let surface = local;
  if (springs.some((sp) => sp.cover)) {
    surface = { ...local, values: Float64Array.from(local.values) };
    for (const sp of springs) if (sp.cover) sp.cover.cells.forEach((k, n) => { surface.values[k] = sp.cover.z[n]; });
  }

  const tile = {
    local, surface, ports, lowMM, highMM,
    signatures: Object.fromEntries(EDGES.map((e) => [e, edgeSignature(c, ports, e)])),
    classes: Object.fromEntries(EDGES.map((e) => [e, classOf(c, e)])),
    rims: Object.fromEntries(EDGES.map((e) => [e, edgeLand(c, e)])),
    portFloors: Object.fromEntries(EDGES.map((e) => [e, portFloorAt(c, e)])),
    grooveCells: grooves.cells,
    channels: planned.channels.map((ch) => ({
      name: ch.name, from: ch.from, to: ch.to, routed: ch.routed, widthMM: ch.widthMM, depthMM: ch.depthMM, lengthMM: ch.lengthMM,
      startFloorMM: ch.startFloorMM, endFloorMM: ch.endFloorMM, lowestFloorMM: ch.lowestFloorMM,
      climbMM: ch.climbMM, pondMM: ch.pondMM, gorgeMM: ch.gorgeMM, isGorge: ch.isGorge, ridgeRiseMM: ch.ridgeRiseMM, mode: ch.mode,
      pts: ch.pts,
    })),
    carvedCells: carved.cells, wet: carved.wet, water: carved.water,
    lakes: lake.lakes, lakesSkipped: lake.skipped, lakesFilledIn: lake.filledIn || [], millilitres: lake.millilitres,
    springs,
    keys: locks.placed, keysRefused: locks.refused, camHeights: camHeights(locks.placed),
    sockets: sockets.placed, socketsRefused: sockets.refused,
    woods, trees: woods.reduce((a, w) => a + w.trees, 0),
    edges, mesh: water, bbox: boundingBox(tris), tris,
  };
  return { contract: c, contractNotes, problems, world, joint, keys: locks.placed, portFloorMM: portFloor(c), tile };
}

export { makeField };
