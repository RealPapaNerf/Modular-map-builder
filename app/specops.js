// specops.js — every edit the editor makes, as a function of the spec.
//
// The spec is the document. A tool never keeps state of its own that the
// spec does not hold: it calls one of these, the spec changes, and
// everything on screen is redrawn from it. So these are pure in the one way
// that matters -- they take a spec and leave it as the CLI would read it --
// and they run in node, which is how the tests draw the example module
// without a browser.
//
// COORDINATES. One frame: millimetres on the module, x east, y north, (0, 0)
// at the south-west corner. The ridge, a volcano or a flat may sit outside
// 0..tileMM -- in the margin, where the ground is grown but not printed.
// Channels, lakes, springs, woods and edits are on the module.

import { makeContract, EDGES, edgeLand, classOf, portFloorAt, landOfClass } from '../lib/contract.js';
import { snapToPorts, endPoint, isEdge, CHANNEL_DEFAULTS } from '../lib/channel.js';
import { EDIT_DEFAULTS, editsFor, strokeWeight } from '../lib/edits.js';
import { DEFAULT_M_PER_MM, marginOf } from '../lib/scale.js';

/* ------------------------------------------------------------------ basics */

export function dims(spec) {
  const T = spec.contract?.tileMM ?? 200;
  return { T, marginMM: marginOf(spec, T) };
}

const r1 = (v) => Math.round(v * 10) / 10;

/** Delete keys whose value is undefined, null, or an empty object or array. */
export function tidy(spec) {
  for (const k of ['volcanoes', 'flats', 'channels', 'canopy', 'edits']) {
    if (Array.isArray(spec[k]) && !spec[k].length) delete spec[k];
  }
  if (Array.isArray(spec.spine) && spec.spine.length < 2) delete spec.spine;
  for (const k of ['lakes', 'fountains']) {
    if (spec[k] && Array.isArray(spec[k].place) && !spec[k].place.length) delete spec[k].place;
  }
  return spec;
}

/** A module with nothing drawn on it. */
export function blankSpec() {
  return { name: 'untitled', seed: 1, meshMM: 0.9, metresPerMM: DEFAULT_M_PER_MM };
}

/** The contract as the build will read it, defaults and all. */
export const contractOf = (spec) => makeContract(spec.contract || {});

/** A fresh name, 'channel 1', 'channel 2', ... not already in `list`. */
export function freshName(list, base) {
  const used = new Set((list || []).map((r) => r && r.name));
  for (let i = 1; ; i++) if (!used.has(`${base} ${i}`)) return `${base} ${i}`;
}

/* -------------------------------------------------------------- the ground */

/** The ridge, from points in module mm. Fewer than two points takes it away. */
export function setSpine(spec, pts) {
  if (pts.length < 2) { delete spec.spine; return spec; }
  spec.spine = pts.map((p) => [r1(p.x), r1(p.y)]);
  return spec;
}

export function addVolcano(spec, at, radiusMM, o = {}) {
  spec.volcanoes = spec.volcanoes || [];
  spec.volcanoes.push({ at: [r1(at.x), r1(at.y)], heightMM: o.heightMM ?? 32, baseRadiusMM: Math.round(radiusMM), ...(o.breachAzimuthDeg != null ? { breachAzimuthDeg: o.breachAzimuthDeg } : {}) });
  return spec.volcanoes.length - 1;
}

export function addFlat(spec, at, radiusMM, o = {}) {
  spec.flats = spec.flats || [];
  spec.flats.push({ at: [r1(at.x), r1(at.y)], radiusMM: Math.round(radiusMM), ...(o.elevMM != null ? { elevMM: o.elevMM } : {}) });
  return spec.flats.length - 1;
}

/* ---------------------------------------------------------------- channels */

/**
 * A channel drawn as a stroke, in module mm. The stroke is thinned to a few
 * vertices; its ends are snapped to the ports when it is built (and shown
 * snapped while it is drawn), not here, so the line in the spec is the line
 * that was drawn. Returns its index, or -1 for a stroke too short to be one.
 */
export function addChannel(spec, pts, { widthMM = CHANNEL_DEFAULTS.widthMM, depthMM = null, name = null } = {}) {
  const path = thin(pts.map((p) => [r1(p.x), r1(p.y)]), 1.5);
  if (path.length < 2) return -1;
  const c = contractOf(spec);
  if (!snapToPorts(c, path, widthMM)) return -1;
  spec.channels = spec.channels || [];
  const ch = { name: name || freshName(spec.channels, 'channel'), widthMM };
  if (Number.isFinite(depthMM) && depthMM !== c.channelDepthMM) ch.depthMM = depthMM;
  ch.path = path;
  spec.channels.push(ch);
  return spec.channels.length - 1;
}

export function removeChannel(spec, index) {
  if (spec.channels) spec.channels.splice(index, 1);
  return tidy(spec);
}

/** What a channel's line does at its ends, as the build will read it: the ports it snaps to. */
export function channelEnds(spec, ch) {
  const c = contractOf(spec);
  if (!Array.isArray(ch?.path)) {
    if (!ch?.from || !ch?.to) return null;
    const port = (e) => (isEdge(e) ? e : null);
    const at = (e) => { const p = endPoint(c, e); return [p.x, p.y]; };
    return { from: port(ch.from), to: port(ch.to), routed: true, pts: [at(ch.from), at(ch.to)] };
  }
  const s = snapToPorts(c, ch.path, Number(ch.widthMM) || CHANNEL_DEFAULTS.widthMM);
  return s ? { from: s.from, to: s.to, pts: s.pts, routed: false } : null;
}

/**
 * Give a routed channel the line the generator found for it, so it can be
 * edited: `pts` is the line as grown, in module mm, thinned to a few
 * vertices. The ends that were ports stay on them.
 */
export function takeLine(spec, index, pts) {
  const ch = spec.channels?.[index];
  if (!ch || !Array.isArray(pts) || pts.length < 2) return spec;
  ch.path = thin(pts.map(([x, y]) => [r1(x), r1(y)]), 2.5);
  delete ch.from;
  delete ch.to;
  delete ch.route;
  return spec;
}

/* ------------------------------------------------------------- the water */

/** A lake placed at a point. */
export function addLake(spec, atMM, o = {}) {
  spec.lakes = spec.lakes || {};
  spec.lakes.place = spec.lakes.place || [];
  spec.lakes.place.push({ atMM: [r1(atMM[0]), r1(atMM[1])], ...o });
  return spec.lakes.place.length - 1;
}

/**
 * Water PAINTED along a stroke: a lake whose shore follows the line, at the
 * brush's width. A stroke of a single point is written as a plain `atMM`
 * lake instead, which keeps its drag handle (see features.js). Returns the
 * index, or -1 if the stroke missed the module.
 */
export function addWaterStroke(spec, pts, { radiusMM }) {
  const { T } = dims(spec);
  const R = Number(radiusMM);
  if (!pts.length || !(R > 0)) return -1;
  const inside = pts.filter((q) => q.x >= -R && q.y >= -R && q.x <= T + R && q.y <= T + R);
  if (!inside.length) return -1;
  const path = thin(inside.map((q) => [r1(q.x), r1(q.y)]), Math.max(0.5, R * 0.05));
  spec.lakes = spec.lakes || {};
  spec.lakes.place = spec.lakes.place || [];
  if (path.length === 1) spec.lakes.place.push({ atMM: path[0], radiusMM: r1(R) });
  else spec.lakes.place.push({ pathMM: path, radiusMM: r1(R) });
  return spec.lakes.place.length - 1;
}

/**
 * A spring placed at a point. If the module had no fountains at all, this
 * turns them on for this spring only: `auto` would otherwise put one at the
 * start of every channel too, which is a different thing from what was clicked.
 */
export function addSpringPoint(spec, atMM) {
  if (!spec.fountains) spec.fountains = { auto: false };
  spec.fountains.place = spec.fountains.place || [];
  spec.fountains.place.push({ atMM: [r1(atMM[0]), r1(atMM[1])] });
  return spec.fountains.place.length - 1;
}

/* ------------------------------------------------------------------ woods */

export const WOOD_KINDS = {
  conifer: { kind: 'conifer', crownMM: 7, heightMM: 9, density: 0.6, maxSlopeDeg: 36 },
  deciduous: { kind: 'deciduous', crownMM: 12, heightMM: 7, density: 0.5, maxSlopeDeg: 24 },
};

/** A wood drawn as a shape. */
export function addWood(spec, region, kind = 'deciduous') {
  spec.canopy = spec.canopy || [];
  spec.canopy.push({ ...WOOD_KINDS[kind] || WOOD_KINDS.deciduous, region: region.map(([x, y]) => [r1(x), r1(y)]) });
  return spec.canopy.length - 1;
}

/** A wood over the whole module, as the example's are. */
export function addWoodLayer(spec, kind = 'deciduous') {
  spec.canopy = spec.canopy || [];
  spec.canopy.push({ ...WOOD_KINDS[kind] || WOOD_KINDS.deciduous });
  return spec.canopy.length - 1;
}

/* ------------------------------------------------------------------ edits */

/** Distance from point p to the segment a-b (to a itself when the segment has no length). */
function segDist([px, py], [ax, ay], [bx, by]) {
  const dx = bx - ax;
  const dy = by - ay;
  const L2 = dx * dx + dy * dy;
  const t = L2 > 0 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / L2)) : 0;
  return Math.hypot(px - ax - t * dx, py - ay - t * dy);
}

/**
 * Douglas-Peucker on [x, y] pairs: a dragged stroke is a few vertices, not
 * one per mouse move. Distance is to the SEGMENT, not the line through it,
 * so a stroke that doubles back, or comes round in a circle, keeps its turn.
 */
export function thin(pts, tol) {
  if (pts.length < 3) return pts.slice();
  const keep = new Uint8Array(pts.length);
  keep[0] = 1;
  keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    let best = -1;
    let bestD = tol;
    for (let i = a + 1; i < b; i++) {
      const d = segDist(pts[i], pts[a], pts[b]);
      if (d > bestD) { bestD = d; best = i; }
    }
    if (best >= 0) { keep[best] = 1; stack.push([a, best], [best, b]); }
  }
  return pts.filter((_, i) => keep[i]);
}

/**
 * A brushstroke, written as an edit in module mm. A stroke that only grazes
 * the module -- less than half a percent of it anywhere, once the rim lock
 * has faded it -- writes nothing.
 *
 *   pts   the stroke, in module mm
 *   o     { op, radiusMM, mm, strength, kind, toMM }
 *
 * Returns true if an edit was written.
 */
export function addStroke(spec, pts, o) {
  const { T } = dims(spec);
  const c = contractOf(spec);
  const lock = c.rimLockMM ?? EDIT_DEFAULTS.rimLockMM;
  const R = Number(o.radiusMM);
  if (!pts.length || !(R > 0)) return false;
  let x0 = Infinity; let y0 = Infinity; let x1 = -Infinity; let y1 = -Infinity;
  for (const q of pts) { x0 = Math.min(x0, q.x); y0 = Math.min(y0, q.y); x1 = Math.max(x1, q.x); y1 = Math.max(y1, q.y); }
  if (x1 + R <= 0 || y1 + R <= 0 || x0 - R >= T || y0 - R >= T) return false;
  const path = thin(pts.map((q) => [r1(q.x), r1(q.y)]), Math.max(0.5, R * 0.05));
  const e = { op: o.op, path, radiusMM: r1(R) };
  let most = 0;
  for (let y = Math.max(0, y0 - R); y <= Math.min(T, y1 + R) && most < 0.005; y += 1) {
    for (let x = Math.max(0, x0 - R); x <= Math.min(T, x1 + R) && most < 0.005; x += 1) most = Math.max(most, strokeWeight(e, path, x, y, T, lock));
  }
  if (most < 0.005) return false;
  if (o.op === 'raise' || o.op === 'lower') e.mm = r1(Number(o.mm) || 0);
  if (o.op === 'smooth' && Number.isFinite(o.strength)) e.strength = o.strength;
  if (o.op === 'flatten') e.toMM = r1(Math.max(EDIT_DEFAULTS.floorMM, o.toMM));
  if (o.op === 'plant') e.kind = o.kind || 'deciduous';
  spec.edits = [...editsFor(spec), e];
  return true;
}

/** Take one edit off, by its place in the list. */
export function removeEdit(spec, index) {
  const list = editsFor(spec);
  if (index < 0 || index >= list.length) return spec;
  spec.edits = list.filter((_, i) => i !== index);
  return tidy(spec);
}

/** Every edit off. */
export function clearEdits(spec) {
  delete spec.edits;
  return spec;
}

/** What an edit did, in a few words, for the inspector's list. */
export function describeEdit(e) {
  const r = Number(e.radiusMM) || 0;
  const wide = `${Math.round(r * 2)} mm wide`;
  const along = (e.path?.length || 0) > 1 ? ' along a line' : '';
  switch (e.op) {
    case 'raise': return `Raised ${e.mm} mm${along}, ${wide}`;
    case 'lower': return `Lowered ${e.mm} mm${along}, ${wide}`;
    case 'smooth': return `Smoothed${along}, ${wide}`;
    case 'flatten': return `Flattened to ${e.toMM ?? 'where it began'} mm${along}, ${wide}`;
    case 'clear': return `Trees cleared${along}, ${wide}`;
    case 'plant': return `${e.kind === 'conifer' ? 'Conifers' : 'Broadleaf'} planted${along}, ${wide}`;
    default: return `${e.op}?`;
  }
}

/* ----------------------------------------------------------------- moving */

/**
 * Move something already placed to a point in module mm: a ridge point, a
 * volcano or a flat anywhere (the margin included); a channel's vertex, a
 * lake, a spring or a wood's vertex on the module, a hair in from its rim.
 */
export function moveFeature(spec, kind, index, { x, y }, vertex = null) {
  const { T } = dims(spec);
  const clamp = (v) => r1(Math.max(0, Math.min(T, v)));
  const free = [r1(x), r1(y)];
  switch (kind) {
    case 'spine': if (Array.isArray(spec.spine) && spec.spine[index]) spec.spine[index] = free; break;
    case 'volcano': if (spec.volcanoes?.[index]) spec.volcanoes[index].at = free; break;
    case 'flat': if (spec.flats?.[index]) spec.flats[index].at = free; break;
    case 'channel-vertex': {
      const ch = spec.channels?.[index];
      if (ch && Array.isArray(ch.path) && ch.path[vertex]) ch.path[vertex] = [clamp(x), clamp(y)];
      break;
    }
    case 'lake':
    case 'springpoint': {
      const spot = (kind === 'lake' ? spec.lakes?.place : spec.fountains?.place)?.[index];
      if (spot && Array.isArray(spot.atMM)) spot.atMM = [clamp(x), clamp(y)];
      break;
    }
    case 'wood-vertex': {
      const w = spec.canopy?.[index];
      if (w && Array.isArray(w.region) && w.region[vertex]) w.region[vertex] = [clamp(x), clamp(y)];
      break;
    }
    default: break;
  }
  return spec;
}

/** Shift a whole wood or channel by (dx, dy), kept on the module. */
export function shiftFeature(spec, kind, index, dx, dy) {
  const { T } = dims(spec);
  const clamp = (v) => r1(Math.max(0, Math.min(T, v)));
  const list = kind === 'wood' ? spec.canopy?.[index]?.region : kind === 'channel' ? spec.channels?.[index]?.path : null;
  if (!Array.isArray(list)) return spec;
  const moved = list.map(([x, y]) => [clamp(x + dx), clamp(y + dy)]);
  if (kind === 'wood') spec.canopy[index].region = moved; else spec.channels[index].path = moved;
  return spec;
}

/* --------------------------------------------------------------- printing */

/** The order the example writes its keys in, so the JSON reads the same however it was drawn. */
export const KEY_ORDER = ['name', 'seed', 'meshMM', 'metresPerMM', 'marginMM', 'worldGrid',
  'spineHeightMM', 'spineWidthMM', 'baseElevMM', 'roughness', 'spine', 'flats', 'volcanoes', 'glacier', 'reposeDeg', 'reposePasses',
  'channels', 'channelDefaults', 'canopy', 'lakes', 'fountains', 'edits', 'joints', 'locks', 'plates', 'tray', 'contract'];

const ORDERS = {
  channels: ['name', 'widthMM', 'depthMM', 'from', 'to', 'path'],
  canopy: ['kind', 'crownMM', 'heightMM', 'density', 'spacingMM', 'minZMM', 'maxZMM', 'thinningMM', 'maxSlopeDeg', 'region'],
  volcanoes: ['at', 'heightMM', 'baseRadiusMM', 'craterRadiusMM', 'craterDepthMM', 'breachAzimuthDeg'],
  flats: ['at', 'radiusMM', 'elevMM'],
  lakes: ['fillHollows', 'depthMM', 'shoreMM', 'profile', 'place', 'resize'],
  fountains: ['auto', 'tubeOdMM', 'poolRadiusMM', 'place'],
  place: ['atMM', 'pathMM', 'radiusMM', 'depthMM'],
  contract: ['tileMM', 'edgeLandMM', 'edges', 'blends', 'portWidthMM', 'channelDepthMM'],
  sides: ['N', 'E', 'S', 'W'],
};

/** An object's keys in a given order, then whatever else it has. */
function orderKeys(o, order) {
  if (!o || typeof o !== 'object' || Array.isArray(o)) return o;
  const out = {};
  for (const k of order) if (o[k] !== undefined) out[k] = o[k];
  for (const k of Object.keys(o)) if (!(k in out) && o[k] !== undefined) out[k] = o[k];
  return out;
}

export function canonical(spec) {
  const out = orderKeys(spec, KEY_ORDER);
  for (const k of ['channels', 'canopy', 'volcanoes', 'flats']) if (Array.isArray(out[k])) out[k] = out[k].map((x) => orderKeys(x, ORDERS[k]));
  for (const k of ['lakes', 'fountains']) {
    if (!out[k] || typeof out[k] !== 'object') continue;
    out[k] = orderKeys(out[k], ORDERS[k]);
    if (Array.isArray(out[k].place)) out[k].place = out[k].place.map((x) => orderKeys(x, ORDERS.place));
  }
  if (out.contract) {
    out.contract = orderKeys(out.contract, ORDERS.contract);
    for (const k of ['edges', 'blends']) if (out.contract[k]) out.contract[k] = orderKeys(out.contract[k], ORDERS.sides);
  }
  return out;
}

/**
 * The spec as JSON a person can read: objects one key to a line, as
 * JSON.stringify does, but a short array of numbers or of short arrays --
 * a spine, a path, a point -- on one line, the way the example is written.
 */
export function formatSpec(value, indent = '') {
  if (!indent && value && typeof value === 'object' && !Array.isArray(value)) value = canonical(value);
  const inner = `${indent}  `;
  const flat = (v) => (Array.isArray(v) ? `[${v.map(flat).join(', ')}]` : JSON.stringify(v));
  const shallow = (v) => v === null || typeof v !== 'object' || (Array.isArray(v) && v.every((w) => w === null || typeof w !== 'object' || (Array.isArray(w) && w.every((u) => typeof u !== 'object'))));
  if (Array.isArray(value)) {
    if (!value.length) return '[]';
    const simple = value.every((v) => v === null || typeof v !== 'object' || (Array.isArray(v) && v.every((w) => w === null || typeof w !== 'object')));
    const one = `[${value.map(flat).join(', ')}]`;
    if (simple && one.length + indent.length <= 96) return one;
    return `[\n${value.map((v) => inner + formatSpec(v, inner)).join(',\n')}\n${indent}]`;
  }
  if (value && typeof value === 'object') {
    const keys = Object.keys(value).filter((k) => value[k] !== undefined);
    if (!keys.length) return '{}';
    const one = `{ ${keys.map((k) => `${flat(k)}: ${flat(value[k])}`).join(', ')} }`;
    const small = keys.length <= 6 && keys.every((k) => shallow(value[k]));
    if (small && one.length + indent.length <= 96) return one;
    return `{\n${keys.map((k) => `${inner}${flat(k)}: ${formatSpec(value[k], inner)}`).join(',\n')}\n${indent}}`;
  }
  return flat(value);
}

/* ---------------------------------------------------------------- reading */

/** Set a value at a dotted path ('lakes.depthMM'), deleting it for undefined. */
export function setPath(spec, path, value) {
  const parts = path.split('.');
  let o = spec;
  for (let i = 0; i < parts.length - 1; i++) {
    const k = parts[i];
    if (value === undefined && (o[k] === undefined || o[k] === null)) return spec;
    if (o[k] === undefined || o[k] === null || typeof o[k] !== 'object') o[k] = {};
    o = o[k];
  }
  const last = parts[parts.length - 1];
  if (value === undefined) delete o[last];
  else o[last] = value;
  return spec;
}

export function getPath(spec, path) {
  return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), spec);
}

/* ----------------------------------------------------------------- edges */

/**
 * One side's class: its rim stands baseMM + cls above the module's base. The
 * default class (the contract's edgeLandMM) is written as no entry at all,
 * so a spec that never touched a side reads as it did.
 */
export function setEdgeClass(spec, edge, cls) {
  if (!EDGES.includes(edge)) return;
  const c = contractOf(spec);
  spec.contract = { ...(spec.contract || {}) };
  const edges = { ...(spec.contract.edges || {}) };
  const land = Number.isFinite(cls) ? landOfClass(c, cls) : undefined;
  if (land === undefined || land === c.edgeLandMM) delete edges[edge]; else edges[edge] = land;
  if (Object.keys(edges).length) spec.contract.edges = edges; else delete spec.contract.edges;
  if (!Object.keys(spec.contract).length) delete spec.contract;
}

/** How one side's ground meets its rim: the blend in mm, or undefined for the module's. */
export function setEdgeBlend(spec, edge, mm) {
  if (!EDGES.includes(edge)) return;
  spec.contract = { ...(spec.contract || {}) };
  const b = { ...(spec.contract.blends || {}) };
  if (Number.isFinite(mm)) b[edge] = mm; else delete b[edge];
  if (Object.keys(b).length) spec.contract.blends = b; else delete spec.contract.blends;
  if (!Object.keys(spec.contract).length) delete spec.contract;
}

/* ----------------------------------------------------------------- lakes */

/**
 * A grown lake made a different size: written as a resize at the lake's own
 * middle, so the build finds the hollow again by where it is. `lake` is the
 * lake as the report gives it, with its shape; a resize already written
 * for it is replaced, not stacked.
 */
export function resizeLake(spec, lake, { lengthMM, widthMM } = {}) {
  if (!lake?.shape?.atMM) return -1;
  spec.lakes = spec.lakes || {};
  const list = Array.isArray(spec.lakes.resize) ? spec.lakes.resize : [];
  const at = lake.shape.atMM.map(r1);
  const entry = { atMM: at };
  if (Number.isFinite(lengthMM)) entry.lengthMM = r1(lengthMM);
  if (Number.isFinite(widthMM)) entry.widthMM = r1(widthMM);
  const i = resizeIndexFor(list, lake, at);
  if (i >= 0) list[i] = { ...entry, atMM: list[i].atMM };
  else list.push(entry);
  spec.lakes.resize = list;
  return i >= 0 ? i : list.length - 1;
}

/**
 * The resize already written for this lake: the one the build says it used,
 * or one written at this same spot since -- a second change made before the
 * module has grown again replaces the first instead of stacking on it.
 */
function resizeIndexFor(list, lake, at) {
  if (Number.isInteger(lake.resizeIndex) && list[lake.resizeIndex]) return lake.resizeIndex;
  return list.findIndex((r) => Array.isArray(r?.atMM) && Math.hypot(r.atMM[0] - at[0], r.atMM[1] - at[1]) < 1);
}

/** Fill a grown lake in: dry ground where it was. */
export function fillLake(spec, lake) {
  if (!lake?.shape?.atMM) return -1;
  spec.lakes = spec.lakes || {};
  const list = Array.isArray(spec.lakes.resize) ? spec.lakes.resize : [];
  const i = resizeIndexFor(list, lake, lake.shape.atMM.map(r1));
  const entry = { atMM: i >= 0 ? list[i].atMM : lake.shape.atMM.map(r1), fill: true };
  if (i >= 0) list[i] = entry; else list.push(entry);
  spec.lakes.resize = list;
  return i >= 0 ? i : list.length - 1;
}

/** Take a resize off: the lake goes back to the size the ice dug it. */
export function unresizeLake(spec, index) {
  const list = spec.lakes?.resize;
  if (!Array.isArray(list) || !list[index]) return;
  list.splice(index, 1);
  if (!list.length) delete spec.lakes.resize;
}

/* ---------------------------------------------------------------- the say */

const SIDE = { N: 'north', E: 'east', S: 'south', W: 'west' };

/**
 * What the module is, in a sentence or two, and anything about it worth
 * saying before it is grown: the ports its channels cross, a channel that
 * will not cut, two channels on one port. The status strip and the
 * inspector both read this. Never throws.
 */
export function describe(spec) {
  const c = contractOf(spec);
  const { T } = dims(spec);
  const out = [];
  const notes = [];
  const ports = {};
  const chans = (spec.channels || []).map((ch, i) => ({ ch, i, ends: channelEnds(spec, ch) }));
  for (const { ch, i, ends } of chans) {
    const name = ch.name || `channel ${i + 1}`;
    if (!ends) { notes.push({ severity: 'warning', message: `${name} is too short to cut, or leaves by the side it came in.` }); continue; }
    for (const e of [ends.from, ends.to]) {
      if (!e) continue;
      if (ports[e]) notes.push({ severity: 'warning', message: `${name} and ${ports[e]} both cross the ${e} side; there is one port a side, so they share it.` });
      else ports[e] = name;
    }
  }
  const portList = EDGES.filter((e) => ports[e]);
  const chanText = chans.length
    ? chans.map(({ ch, i, ends }) => {
      const name = ch.name || `channel ${i + 1}`;
      const w = Number(ch.widthMM) || CHANNEL_DEFAULTS.widthMM;
      const d = Number.isFinite(ch.depthMM) ? ch.depthMM : c.channelDepthMM;
      const where = !ends ? 'nowhere' : `${ends.from ? `in at the ${SIDE[ends.from]}` : 'from inside'}, ${ends.to ? `out at the ${SIDE[ends.to]}` : 'to inside'}`;
      return `${name}: ${w} by ${d} mm, ${where}`;
    }).join('; ')
    : 'no channels';
  const sides = EDGES.map((e) => classOf(c, e));
  const classText = sides.every((k) => k === sides[0]) ? `every side class ${sides[0]} (${edgeLand(c, 'N')} mm)`
    : `sides ${EDGES.map((e) => `${e} ${classOf(c, e)}`).join(', ')}`;
  out.push({ kind: 'module', text: `A ${T} mm module, ${classText}. ${chanText.charAt(0).toUpperCase()}${chanText.slice(1)}.` });
  for (const { ch, i, ends } of chans) {
    if (!ends?.from || !ends?.to) continue;
    const fin = portFloorAt(c, ends.from);
    const fout = portFloorAt(c, ends.to);
    if (fin <= fout) {
      notes.push({
        severity: 'warning',
        message: `${ch.name || `channel ${i + 1}`} comes in by the ${SIDE[ends.from]} (floor ${fin} mm) and leaves by the ${SIDE[ends.to]} (floor ${fout} mm): `
          + `${fin === fout ? 'there is no fall across the module' : 'it would have to climb'}. Give the ${SIDE[ends.from]} side a higher class.`,
      });
    }
  }
  const woods = (spec.canopy || []).length;
  const lakes = (spec.lakes?.place || []).length;
  const springs = (spec.fountains?.place || []).length + (spec.fountains && spec.fountains.auto !== false ? chans.length : 0);
  const bits = [];
  if (spec.glacier !== false) bits.push('ice that melts out before it is printed');
  if (spec.lakes?.fillHollows !== false) bits.push('tarns in the hollows');
  if (lakes) bits.push(`${lakes} lake${lakes > 1 ? 's' : ''} placed`);
  if (springs) bits.push(`${springs} spring${springs > 1 ? 's' : ''}`);
  if (woods) bits.push(`${woods} wood${woods > 1 ? 's' : ''}`);
  if (bits.length) out.push({ kind: 'on', text: `${bits.join(', ')}.`.replace(/^./, (m) => m.toUpperCase()) });
  out.push({ kind: 'ports', text: portList.length
    ? `A channel crosses the ${portList.map((e) => `${SIDE[e]} at ${portFloorAt(c, e)} mm`).join(' and the ')}; the rest is land. Each side mates flush with any side of its class.`
    : 'All four sides are land: each mates flush with any land side of its class.' });
  return { sentences: out, notes, ports: Object.fromEntries(EDGES.map((e) => [e, !!ports[e]])) };
}
