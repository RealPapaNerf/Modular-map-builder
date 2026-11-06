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
import { baseTerrain, addVolcano } from './terrain.js';
import { glaciate } from './glacier.js';
import { massWaste } from './hillslope.js';
import { scaleOf, marginOf, worldSizeM as worldSizeOf } from './scale.js';
import { makeContract, check, EDGES, edgeSignature, portFloor, portFloorAt, edgeLand, minEdgeLand, classOf } from './contract.js';
import { planChannels, profileChannels, carveChannels, springOnChannel } from './channel.js';
import { cutTile, conformToContract, verifyEdges, cutSeamGrooves } from './tile.js';
import { meshTile, checkWatertight, boundingBox } from './mesh.js';
import { scatterCanopy, CANOPY_DEFAULTS } from './canopy.js';
import { fillHollows, placeLake, LAKE_DEFAULTS } from './lake.js';
import { carveSpring, FOUNTAIN_DEFAULTS } from './fountain.js';
import { edgeLocks, cutLockFeatures, cutSockets, lockSettings, checkLock, camHeights } from './joint.js';
import { editsFor, applyGroundEdits, clearFilter, plantings, EDIT_DEFAULTS } from './edits.js';

/**
 * The spec fields the ground depends on, which is what a kept world is
 * keyed on. The ice is left out on request: an editor can estimate the
 * ground without it in a tenth of a second where the glacier takes seconds.
 */
export const WORLD_FIELDS = ['seed', 'worldGrid', 'marginMM', 'metresPerMM', 'spine', 'spineHeightMM', 'spineWidthMM',
  'baseElevMM', 'roughness', 'flats', 'volcanoes', 'reposeDeg', 'reposePasses'];

export function worldKey(spec, { ice = false } = {}) {
  const pick = {};
  for (const k of WORLD_FIELDS) if (spec[k] !== undefined) pick[k] = spec[k];
  pick.tileMM = spec.contract?.tileMM ?? 200;
  if (ice) pick.glacier = spec.glacier ?? null;
  return JSON.stringify(pick);
}

/**
 * The world bed: uplift, then ice, then gravity.
 *
 * Everything in the spec is millimetres on the module, with (0, 0) at its
 * south-west corner; a feature may sit in the margin, outside 0..tileMM,
 * which is how a range the ice comes down from is put beyond the rim.
 * Everything from here down is metres of real ground, because that is the
 * only scale on which ice behaves like ice. See scale.js.
 */
export function buildWorld(spec, onProgress = () => {}) {
  // 96 over the module and its margins is the same ground resolution the old
  // 3 x 3 board had from 128 over three modules, at a third of the ice cost.
  const n = spec.worldGrid || 96;
  const scale = scaleOf(spec);
  const tileMM = spec.contract?.tileMM ?? 200;
  const marginMM = marginOf(spec, tileMM);
  const worldSizeM = worldSizeOf(spec, tileMM);
  const stepM = worldSizeM / (n - 1);
  const mm = (v) => v * scale; // print mm -> ground metres
  const at = ([x, y]) => ({ x: mm((Number(x) || 0) + marginMM), y: mm((Number(y) || 0) + marginMM) });

  onProgress('Uplift');
  const spine = (spec.spine || []).map(at);
  let bed = baseTerrain({
    nx: n, ny: n, stepM,
    spine: spine.length >= 2 ? spine : null,
    spineHeightM: mm(spec.spineHeightMM ?? 60),
    spineWidthM: spec.spineWidthMM !== undefined ? mm(spec.spineWidthMM) : mm(tileMM) * 0.45,
    baseElevM: mm(spec.baseElevMM ?? 16),
    roughness: spec.roughness ?? 0.22,
    seed: spec.seed ?? 1,
    flats: (spec.flats || []).map((f) => ({
      ...at(f.at),
      radiusM: f.radiusMM !== undefined ? mm(f.radiusMM) : mm(tileMM) * 0.2,
      elevM: f.elevMM !== undefined ? mm(f.elevMM) : undefined,
    })),
  });

  for (const v of spec.volcanoes || []) {
    onProgress('Volcano');
    addVolcano(bed, {
      ...at(v.at),
      heightM: mm(v.heightMM ?? 32),
      baseRadiusM: v.baseRadiusMM !== undefined ? mm(v.baseRadiusMM) : mm(tileMM) * 0.36,
      craterRadiusM: mm(v.craterRadiusMM ?? 16),
      craterDepthM: mm(v.craterDepthMM ?? 7),
      breachAzimuthDeg: v.breachAzimuthDeg ?? null, seed: (spec.seed ?? 1) + 5,
    });
  }

  let glacierStats = null;
  if (spec.glacier !== false) {
    onProgress('Ice');
    const gspec = { ...(spec.glacier || {}) };
    if (gspec.elaSwingMM !== undefined) { gspec.elaSwingM = mm(gspec.elaSwingMM); delete gspec.elaSwingMM; }
    if (gspec.elaMM !== undefined) { gspec.elaM = mm(gspec.elaMM); delete gspec.elaMM; }
    const g = glaciate(bed, gspec);
    bed = g.bed;
    glacierStats = g.stats;
  }

  onProgress('Mass wasting');
  massWaste(bed, { critDeg: spec.reposeDeg ?? 42, passes: spec.reposePasses ?? 8 });

  return { bed, glacierStats, worldSizeM, marginMM, tileMM };
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
  const cutOpts = { marginMM: world.marginMM ?? marginOf(spec, c.tileMM), metresPerMM: scaleOf(spec), meshMM: spec.meshMM ?? 0.8 };
  // CHANNELS: planned on the raw ground, so a routed one finds the valley
  // the ice left rather than one the rim fitting invented. Which ports
  // they cross is then known; the datum is read at them (see cutTile) and
  // the rim is conformed to them.
  let local = cutTile(world.bed, c, cutOpts);
  const planned = planChannels(c, spec, local, { seed: spec.seed ?? 1 });
  for (const n of planned.notes) problems.push({ kind: 'channel', ...n });
  const ports = planned.ports;
  if (EDGES.some((e) => ports[e])) local = cutTile(world.bed, c, { ...cutOpts, ports });
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
    if (ch.gorgeMM > 0.5) {
      problems.push({
        kind: 'channel', severity: 'note',
        message: `${ch.name} runs through high ground on its line, so it is cut as a gorge there, up to ${ch.gorgeMM.toFixed(1)} mm ` +
                 `deeper than its ${ch.depthMM} mm: water does not run uphill.`,
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
    const clear = fSpec.poolRadiusMM + fSpec.lipWidthMM + fSpec.blendMM + 2;
    for (const ch of planned.channels) wantSpring.push({ ...springOnChannel(c, ch, clear), channel: ch.name });
  }
  for (const spot of (spec.fountains?.place) || []) wantSpring.push({ ...spot, manual: true });
  for (const want of wantSpring) {
    const r = carveSpring(local, { ...fSpec, ...want, spillToward: want.spillToward ?? 0 });
    if (r.skipped) { problems.push({ kind: 'fountain', severity: 'warning', message: `no spring placed — ${r.skipped}` }); continue; }
    springs.push(r);
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

  // THE LOCKS, before the woods so no tree stands on a cam's terrace: on
  // every side a cam housing bored from the top and a key recess in the
  // underside, mirrored about the port; and a socket in each corner of the
  // underside for a spacer plate's stud. See joint.js.
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
  const offLimits = Uint8Array.from(carved.wet, (v, k) => (v || locks.keepClear[k] ? 1 : 0));
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

  const tile = {
    local, ports, lowMM, highMM,
    signatures: Object.fromEntries(EDGES.map((e) => [e, edgeSignature(c, ports, e)])),
    classes: Object.fromEntries(EDGES.map((e) => [e, classOf(c, e)])),
    rims: Object.fromEntries(EDGES.map((e) => [e, edgeLand(c, e)])),
    portFloors: Object.fromEntries(EDGES.map((e) => [e, portFloorAt(c, e)])),
    grooveCells: grooves.cells,
    channels: planned.channels.map((ch) => ({
      name: ch.name, from: ch.from, to: ch.to, routed: ch.routed, widthMM: ch.widthMM, depthMM: ch.depthMM, lengthMM: ch.lengthMM,
      startFloorMM: ch.startFloorMM, endFloorMM: ch.endFloorMM, lowestFloorMM: ch.lowestFloorMM,
      climbMM: ch.climbMM, pondMM: ch.pondMM, gorgeMM: ch.gorgeMM,
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
