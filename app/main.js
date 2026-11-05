// main.js — the editor. One state object, one render, and the spec as the
// document: every tool writes it, the board is planned again from it on every
// change, and everything on screen is drawn from that plan.
//
// Four stages over one spec: Draw it on the board and in a tile; Grow it
// (the generator, in a worker) and look at it in 3D; Refine it by hand on the
// 3D view, every stroke kept as an edit in the spec; Print it. Nothing leaves
// the machine.
//
// The 3D view (viewer.js, three.js) is loaded the first time Grow is opened,
// so drawing never waits for it. It shows what was grown, standing the way
// the board says it stands now: a turn is play and does not need a regrow.

import { EXAMPLE_SPEC } from '../lib/example.js';
import { plan as planBoard, worldKey, normRot } from '../lib/board.js';
import { toRGBA } from '../lib/shade.js';
import * as ops from './specops.js';
import { readTheme, makeCamera, zoomAbout } from './view.js';
import { boardBox, drawBoard, hitBoard } from './board.js';
import { tileBox, drawTileView, drawPreview } from './tilecanvas.js';
import { handles, hitHandle, localToBoard } from './features.js';
import { BOARD_TOOLS, TILE_TOOLS, BOARD_GROUPS, TILE_GROUPS, REFINE_TOOLS, REFINE_GROUPS } from './tools.js';
import { applyGroundEdits, editsFor, GROUND_OPS, EDIT_DEFAULTS } from '../lib/edits.js';
import { renderInspector } from './inspector.js';
import { reportHTML, downloadsHTML, fmt, bytes, esc } from './report.js';
import { migrateSpec, needsMigration } from '../lib/scale.js';

const $ = (id) => document.getElementById(id);
const el = {
  app: $('app'), left: $('left'), inspector: $('inspector'), canvas: $('canvas'), host: $('canvas-host'),
  crumbs: $('crumbs'), tip: $('tip'), readout: $('readout'), sheet: $('sheet'),
  counts: $('counts'), say: $('say'), rims: $('rims'), sayAll: $('say-all'), sentences: $('sentences'),
  jsonToggle: $('json-toggle'), drawer: $('drawer'), spec: $('spec'), jsonErr: $('json-err'), jsonChanged: $('json-changed'),
  name: $('map-name'), unsupported: $('unsupported'), openFile: $('open-file'),
  view3d: $('view3d'), overlay3d: $('overlay3d'), viewMode: $('view-mode'),
};
const ctx = el.canvas.getContext('2d');
const STORE = 'mmb.spec.v1';

/* ------------------------------------------------------------- the state */

const state = {
  spec: null,
  plan: null,
  stage: 'draw',
  view: { mode: 'board', tile: null, zoom: 1, panX: 0, panY: 0 },
  boardView: null,
  tool: { board: 'select', tile: 'select', refine: 'select' },
  palette: { riverSize: 'creek', fall: 10, riser: 'auto', woodKind: 'deciduous', brushWidth: 24, brushMM: 4, plantKind: 'deciduous' },
  selection: null,
  hover: null,
  gesture: null,
  world: null,
  grown: null,
  prefer3d: true,
  busy: null,
  history: [],
  hIndex: -1,
  frame: null,
  cam: null,
  theme: readTheme(),
  message: null,
  lastChanged: [],
};

let migratedThisLoad = false;

function loadSpec() {
  try {
    const raw = localStorage.getItem(STORE);
    if (raw) {
      const v = JSON.parse(raw);
      if (v && typeof v === 'object' && !Array.isArray(v)) {
        return needsMigration(v) ? migrateSpec(v, v.contract?.tileMM ?? 200) : v;
      }
    }
  } catch { /* private mode, or a spec that will not parse: start from the example */ }
  return structuredClone(EXAMPLE_SPEC);
}

function persist() {
  try { localStorage.setItem(STORE, JSON.stringify(state.spec)); } catch { /* storage is a convenience */ }
}

/* ------------------------------------------------------------------- plan */

/** The ground the board reads its rims from, if it is still the ground this spec would grow. */
function groundFor(spec) {
  const w = state.world;
  if (!w) return null;
  if (w.source === 'grown' && w.iceKey === worldKey(spec, { ice: true })) return w;
  if (w.key === worldKey(spec)) return w;
  return { ...w, stale: true };
}

function replan() {
  const g = groundFor(state.spec);
  state.plan = planBoard(state.spec, { world: g ? g.field : null });
  state.plan.rimsFrom = !g ? 'datum' : g.stale ? 'updating' : g.source;
  if (state.grown) state.grown.stale = state.grown.printKey !== printKey(state.spec);
  validateSelection();
}

/** What a print depends on: everything but the name and how the pieces are turned on the table. */
const printKey = (spec) => JSON.stringify({ ...spec, name: undefined, rot: undefined });

function validateSelection() {
  const s = state.selection;
  if (!s) return;
  const sp = state.spec;
  const ok = (() => {
    switch (s.type) {
      case 'tile': return state.plan.placements.some((p) => p.col === s.col && p.row === s.row);
      case 'river': return !!sp.rivers?.[s.index];
      case 'seam': return state.plan.seams.some((x) => x.id === s.id);
      case 'spine': return Array.isArray(sp.spine);
      case 'volcano': return !!sp.volcanoes?.[s.index];
      case 'flat': return !!sp.flats?.[s.index];
      case 'lake': return !!sp.lakes?.place?.[s.index];
      case 'springpoint': return !!sp.fountains?.place?.[s.index];
      case 'wood': return !!sp.canopy?.[s.index];
      case 'corner': return true;
      default: return false;
    }
  })();
  if (!ok) state.selection = null;
}

/* ---------------------------------------------------------------- history */

function topKeysChanged(a, b) {
  const keys = new Set([...Object.keys(a || {}), ...Object.keys(b || {})]);
  return [...keys].filter((k) => JSON.stringify(a?.[k]) !== JSON.stringify(b?.[k]));
}

function record(label) {
  const json = JSON.stringify(state.spec);
  const prev = state.history[state.hIndex];
  if (prev === json) return;
  state.lastChanged = prev ? topKeysChanged(JSON.parse(prev), state.spec) : [];
  state.history = state.history.slice(0, state.hIndex + 1);
  state.history.push(json);
  if (state.history.length > 200) state.history.shift();
  state.hIndex = state.history.length - 1;
  state.lastLabel = label;
  persist();
  wantWorld();
  maybeRegrow();
}

function setSpec(next, label = 'edit', { keepJson = false } = {}) {
  // A map written before the units changed still opens. needsMigration only
  // fires on a spec that actually carries the old world-metre fields, so
  // this is a no-op for anything written since. See lib/scale.js for what
  // survives the conversion (horizontal, exactly) and what cannot (vertical,
  // which the old format squashed and therefore never pinned down).
  if (needsMigration(next)) {
    next = migrateSpec(next, next.contract?.tileMM ?? 200);
    migratedThisLoad = true;
  }
  state.spec = next;
  replan();
  record(label);
  invalidate('all', keepJson ? { keepJson } : undefined);
}

function commit(fn, label = 'edit') {
  const next = structuredClone(state.spec);
  const r = fn(next);
  setSpec(next, label);
  return r;
}

let liveBase = null;
const begin = () => { liveBase = JSON.stringify(state.spec); };
function live(fn) {
  if (liveBase === null) begin();
  const next = JSON.parse(liveBase);
  fn(next);
  state.spec = next;
  replan();
  invalidate('canvas', 'status', 'inspector', 'left');
}
function end(label) {
  const changed = liveBase !== null && JSON.stringify(state.spec) !== liveBase;
  liveBase = null;
  if (changed) { record(label); invalidate('all'); }
}
function cancelLive() {
  if (liveBase !== null) { state.spec = JSON.parse(liveBase); liveBase = null; replan(); invalidate('all'); }
}

function undo() {
  if (state.hIndex <= 0) return;
  state.hIndex -= 1;
  restore();
}
function redo() {
  if (state.hIndex >= state.history.length - 1) return;
  state.hIndex += 1;
  restore();
}
function restore() {
  const prev = state.spec;
  state.spec = JSON.parse(state.history[state.hIndex]);
  state.lastChanged = topKeysChanged(prev, state.spec);
  state.gesture = null;
  replan();
  persist();
  wantWorld();
  maybeRegrow();
  invalidate('all');
}

/* ------------------------------------------------------------------ world */

// The ground without its ice, from the second worker, whenever the fields
// the ground depends on change. Until it arrives the old ground stands in.
let estimator = null;
let worldTimer = 0;
let worldAsked = null;
function wantWorld() {
  const key = worldKey(state.spec);
  const g = groundFor(state.spec);
  if (g && !g.stale) return;
  if (worldAsked === key) return;
  clearTimeout(worldTimer);
  worldTimer = setTimeout(() => {
    if (!workersOK) return;
    estimator = estimator || makeWorker(onEstimate);
    worldAsked = key;
    estimator.postMessage({ type: 'world', spec: state.spec, key });
  }, 220);
}
function onEstimate(msg) {
  if (msg.type !== 'world') return;
  worldAsked = null;
  if (msg.key !== worldKey(state.spec)) { wantWorld(); return; }
  if (state.world?.source === 'grown' && !groundFor(state.spec)?.stale) return;
  state.world = { field: msg.field, key: msg.key, source: 'estimate' };
  replan();
  invalidate('canvas', 'status', 'inspector');
}

/* ------------------------------------------------------------------- grow */

let builder = null;
let growId = 0;

function makeWorker(onMsg) {
  const w = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
  w.onmessage = (ev) => onMsg(ev.data);
  w.onerror = (ev) => {
    state.busy = null;
    say(`Worker failed: ${ev.message || 'could not start'}`, 'err');
    invalidate('left', 'status');
  };
  return w;
}

function grow(mode = 'build') {
  if (state.busy || !workersOK) return;
  const { cols, rows } = ops.dims(state.spec);
  const pxPerTile = Math.max(90, Math.min(220, Math.floor(1400 / Math.max(cols, rows))));
  state.busy = { mode, startedAt: Date.now(), progress: [], label: mode === 'check' ? 'Checking' : 'Growing', id: ++growId, specAt: state.spec };
  builder = builder || makeWorker(onBuild);
  builder.postMessage({ type: 'run', spec: state.spec, mode, pxPerTile, id: state.busy.id });
  invalidate('left', 'status', 'stage');
}

function cancelGrow() {
  // buildMap is one long synchronous call; ending the worker is the only way out.
  if (builder) { builder.terminate(); builder = null; }
  if (state.grown) state.grown.filesGone = true;
  state.busy = null;
  say('Cancelled.');
  invalidate('left', 'status', 'sheet');
}

function onBuild(msg) {
  if (msg.type === 'progress') {
    if (!state.busy) return;
    const p = state.busy.progress;
    const stage = (m) => m.replace(/\s*\(.*$/, '').replace(/^Tile .*/, 'Tiles');
    if (p.length && stage(p[p.length - 1]) === stage(msg.message)) p[p.length - 1] = msg.message;
    else p.push(msg.message);
    invalidate('left');
    return;
  }
  if (msg.type === 'error') {
    if (state.busy?.mode === 'build' || state.busy?.mode === 'check') {
      state.buildFailed = { message: msg.message, key: printKey(state.busy.specAt || state.spec) };
    }
    state.busy = null;
    say(msg.message, 'err');
    invalidate('left', 'status', 'stage');
    return;
  }
  if (msg.type === 'report') {
    const { rgb, width, height, pxPerTile } = msg.preview;
    const img = document.createElement('canvas');
    img.width = width; img.height = height;
    img.getContext('2d').putImageData(new ImageData(toRGBA(new Uint8Array(rgb), width, height), width, height), 0, 0);
    const rowsImg = msg.report.grid.rows;
    const cells = new Map(msg.report.tiles.map((t) => [ops.keyOf(t.col, t.row), { sx: t.col * pxPerTile, sy: (rowsImg - 1 - t.row) * pxPerTile, size: pxPerTile }]));
    const specAt = state.busy?.specAt || state.spec;
    // The heights follow this message; until they land, the 3D view keeps
    // showing the last ones rather than dropping to the board for a frame.
    const shownUntilHeights = state.grown?.tiles3d ?? null;
    state.grown = {
      image: img, cells, report: msg.report, files: msg.files, elapsedMS: msg.elapsedMS, mode: msg.report.mode,
      printKey: printKey(specAt), stale: false, filesGone: false,
      // What the 3D view needs to say what the water does on THESE tiles,
      // whatever the spec has become since: the spec they were grown from,
      // and the ground they were cut out of. The heights follow.
      id: msg.id, spec: specAt, world: msg.world, tiles3d: shownUntilHeights,
    };
    state.buildFailed = null;
    if (msg.report.mode !== 'check') state.world = { field: msg.world, key: worldKey(specAt), iceKey: msg.worldKey, source: 'grown' };
    state.busy = null;
    replan();
    const errs = msg.report.errors.length;
    say(`${msg.report.mode === 'check' ? 'Checked' : 'Grown'} in ${(msg.elapsedMS / 1000).toFixed(1)}s${errs ? ` — ${errs} error${errs > 1 ? 's' : ''} in the contract` : ''}.`, errs ? 'err' : 'ok');
    invalidate('all');
    // In Refine, an edit made while that was growing is grown next.
    maybeRegrow();
    return;
  }
  if (msg.type === 'heights') {
    if (!state.grown || state.grown.id !== msg.id) return;
    state.grown.tiles3d = { contract: msg.contract, tiles: msg.tiles, at: performance.now() };
    repreview(state.grown);
    invalidate('canvas', 'stage', 'left');
    return;
  }
  if (msg.type === 'file') {
    saveBlob(new Blob([msg.bytes], { type: 'model/stl' }), msg.name);
    state.busy = null;
    say(`${msg.name} — ${bytes(msg.bytes.byteLength)}`, 'ok');
    invalidate('left', 'status');
    return;
  }
  if (msg.type === 'zip') {
    saveBlob(msg.blob, msg.name);
    state.busy = null;
    say(`${msg.name} — ${bytes(msg.blob.size)}`, 'ok');
    invalidate('left', 'status');
  }
}

function saveBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

/** A rough fit over measured runs; the status line reports the real time. */
function estimateSeconds(s, mode) {
  const { cols, rows, T } = ops.dims(s);
  const meshMM = Number(s.meshMM) || 0.8;
  const cells = cols * rows * ((T / meshMM) + 1) ** 2;
  const cycles = mode === 'check' || s.glacier === false ? 0 : (s.glacier?.cycles ?? 30);
  return (0.2 + cells * 1.57e-5 + cycles * 0.25) * 1.15;
}

/* --------------------------------------------------------------------- 3D */

let viewer = null;
let viewerModule = null;
let viewerFailed = null;
let viewerPending = false;

/**
 * three.js and the viewer, fetched once, the first time anybody might need
 * them. A fetch that fails is forgotten, so opening Grow again tries again.
 */
function loadViewer() {
  viewerModule = viewerModule || import('./viewer.js').catch((e) => { viewerModule = null; throw e; });
  return viewerModule;
}

function ensureViewer() {
  if (viewer || viewerFailed || viewerPending) return;
  viewerPending = true;
  loadViewer()
    .then((mod) => {
      try {
        viewer = mod.createViewer({
          canvas: el.view3d, overlay: el.overlay3d, theme: state.theme,
          onHover: hover3d, onPick: pick3d, onStroke: stroke3d, onPlace: place3d, onHandle: handle3d,
        });
      } catch (e) {
        // No WebGL: that is the browser, and it will not change.
        viewerFailed = { message: (e && e.message) || String(e), retry: false };
        say(`No 3D view in this browser (${viewerFailed.message}). The grown map is the hillshade under the board.`, 'warn');
      }
    })
    .catch((e) => {
      viewerFailed = { message: (e && e.message) || String(e), retry: true };
      say(`The 3D view did not load (${viewerFailed.message}). Open Grow again to try again.`, 'warn');
    })
    .finally(() => { viewerPending = false; invalidate('canvas', 'stage', 'left'); });
}

/** There is a grown map to stand up, in a stage that shows it, and nothing has said no. */
const can3d = () => (state.stage === 'grow' || state.stage === 'refine') && state.view.mode === 'board'
  && !!state.grown?.tiles3d && !viewerFailed;
const show3d = () => can3d() && state.prefer3d;

let plan3dMemo = null;
/**
 * What the board says about the GROWN tiles. While the spec is still the one
 * they were grown from, and the plan reads the ground they were cut from,
 * that is simply the plan; otherwise it is the plan of the spec as grown, on
 * that ground, turned the way the tiles are turned now -- so the water drawn
 * is always the water on the pieces drawn. (A Check is cut from the ground
 * without its ice, which never becomes the plan's ground.)
 */
function plan3d() {
  const g = state.grown;
  if (!g.stale && state.world?.field === g.world) return state.plan;
  const key = JSON.stringify(state.spec.rot || {});
  if (plan3dMemo?.g !== g || plan3dMemo.key !== key) {
    plan3dMemo = { g, key, plan: planBoard({ ...g.spec, rot: state.spec.rot }, { world: g.world }) };
  }
  return plan3dMemo.plan;
}

let toolKey = null;
function sync3d() {
  if (!viewer) { ensureViewer(); return; }
  const g = state.grown;
  if (viewer.payload() !== g.tiles3d) viewer.setTiles(g.tiles3d);
  viewer.setBoard(plan3d(), { selection: state.selection, hover: state.hover });
  // The tool only when it changes: handing it over again would drop a stroke in progress.
  const vt = viewerTool();
  const k = JSON.stringify(vt);
  if (k !== toolKey) { viewer.setTool(vt); toolKey = k; }
  if (vt?.kind === 'select') viewer.setHandles(handles3d());
}

/* ----------------------------------------------------------------- refine */

// Refine works on the 3D view. A brushstroke is written into the spec as an
// edit on every tile it reaches (specops.addStroke), shown at once on the
// ground as it stands, and then the map is grown again so the edit is
// replayed for real -- after the carve, before the lakes -- with the ground
// kept from the last build so that is the tiles and not the ice. The whole
// map rebuilds on every stroke at this stage; it is slow and it is correct.

const refineTool = () => REFINE_TOOLS.find((t) => t.id === state.tool.refine) || REFINE_TOOLS[0];
const rimLock = () => ops.contractOf(state.spec).rimLockMM ?? EDIT_DEFAULTS.rimLockMM;

function setRefineTool(id) {
  viewer?.cancelGesture();
  state.tool.refine = id;
  invalidate('left', 'canvas', 'stage');
}

/** What the viewer's pointer does: nothing but orbit and pick outside Refine. */
function viewerTool() {
  if (state.stage !== 'refine') return null;
  const t = refineTool();
  if (t.brush) return { kind: 'brush', radiusMM: state.palette.brushWidth / 2, lockMM: rimLock() };
  if (t.place) return { kind: 'place' };
  return { kind: 'select' };
}

/** The things the select tool can drag in 3D, in board mm, each tile's turned the way it sits. */
function handles3d() {
  const s = state.spec;
  const { T } = ops.dims(s);
  const out = [];
  const world = (list, kind, at) => (list || []).forEach((x, i) => {
    const p = at(x);
    if (!Array.isArray(p)) return;
    // Where the ground it shapes sits on the table: turned with its tile.
    const b = ops.turnPoint(s, ops.toBoard(s, p));
    out.push({ key: `${kind}:${i}`, kind, index: i, x: b.x, y: b.y });
  });
  world(s.spine, 'spine', (p) => p);
  world(s.volcanoes, 'volcano', (v) => v.at);
  world(s.flats, 'flat', (f) => f.at);
  const onTile = (list, kind) => (list || []).forEach((spot, i) => {
    const p = ops.parseLabel(spot?.tile);
    if (!p || !Array.isArray(spot.atMM)) return;
    const b = localToBoard(T, p.col, p.row, normRot(s.rot?.[ops.keyOf(p.col, p.row)]), spot.atMM[0], spot.atMM[1]);
    out.push({ key: `${kind}:${i}`, kind, index: i, x: b.x, y: b.y });
  });
  onTile(s.lakes?.place, 'lake');
  onTile(s.fountains?.place, 'springpoint');
  return out;
}

/**
 * Show edits on the ground at once, on the heights as they stand, before the
 * build has replayed them: only the ground ops can be, the trees and the
 * lakes wait for the regrow. The heights as grown are kept, so if the spec
 * goes back to what was grown -- an undo before the regrow -- they go back.
 */
function previewOps(g, label, list) {
  const h = g?.tiles3d?.tiles.find((x) => x.label === label);
  const opsHere = list.filter((op) => GROUND_OPS.includes(op?.op));
  if (!h || !opsHere.length) return;
  const values = Float32Array.from(h.heights);
  applyGroundEdits({ nx: h.nx, ny: h.ny, step: h.step, values }, opsHere, { rimLockMM: rimLock() });
  if (!h.grownHeights) h.grownHeights = h.heights;
  h.heights = values;
  g.previewed = true;
  viewer?.updateHeights(h.id, values);
}

function preview3d(labels) {
  for (const label of labels) {
    const list = state.spec.edits?.[label] || [];
    previewOps(state.grown, label, list.slice(-1));
  }
}

/** The previews taken off: the ground as it was grown, because the spec is what was grown. */
function unpreview(g) {
  for (const h of g?.tiles3d?.tiles || []) {
    if (!h.grownHeights) continue;
    h.heights = h.grownHeights;
    delete h.grownHeights;
    viewer?.updateHeights(h.id, h.heights);
  }
  g.previewed = false;
}

/**
 * New heights have landed from a build that started before the last few
 * strokes: show those strokes on them too, so a stroke made during a regrow
 * does not vanish until the next one. Only edits added on the end of a
 * tile's list can be laid on like that; anything else waits for the build.
 */
function repreview(g) {
  for (const [label, now] of Object.entries(state.spec.edits || {})) {
    if (!Array.isArray(now)) continue;
    const then = editsFor(g.spec, label);
    if (now.length <= then.length || JSON.stringify(now.slice(0, then.length)) !== JSON.stringify(then)) continue;
    previewOps(g, label, now.slice(then.length));
  }
}

function stroke3d(pts) {
  const t = refineTool();
  if (!t.brush || !pts.length || state.stage !== 'refine') return;
  const p = state.palette;
  const placements = state.plan.placements.map((q) => ({ col: q.col, row: q.row, rot: q.rot, label: q.label, riserMM: q.riserMM }));
  let touched = [];
  commit((s) => {
    touched = ops.addStroke(s, placements, pts, {
      op: t.id, radiusMM: p.brushWidth / 2, mm: p.brushMM, kind: p.plantKind,
      // To the ground where it began -- the ground, not the top of a tree on it.
      toWorldMM: viewer?.bareAt(pts[0].x, pts[0].y) ?? pts[0].z,
    });
    ops.tidy(s);
  }, `${t.label.toLowerCase()} by hand`);
  if (!touched.length) { say('That stroke only reached the locked rim, so it moves nothing.', 'warn'); return; }
  preview3d(touched);
  say(`${t.label} on ${touched.join(', ')}. Growing again to replay it…`);
}

function place3d(hit) {
  const t = refineTool();
  if (!hit || hit.kind !== 'tile' || !t.place) return;
  if (!state.plan.placements.some((q) => q.col === hit.col && q.row === hit.row)) return;
  const at = [hit.localX, hit.localY];
  let index = -1;
  if (t.id === 'lake') commit((s) => { index = ops.addLake(s, hit.label, at); }, `lake on ${hit.label}`);
  else commit((s) => { index = ops.addSpringPoint(s, hit.label, at); }, `spring on ${hit.label}`);
  select({ type: t.id === 'lake' ? 'lake' : 'springpoint', index });
}

const HANDLE_NAMES = { spine: 'ridge point', volcano: 'volcano', flat: 'flat', lake: 'lake', springpoint: 'spring' };
function handle3d(hd, at, phase) {
  // A click on a handle selects what it moves, as the 2D select tool does.
  if (phase === 'click') { select(hd.kind === 'spine' ? { type: 'spine' } : { type: hd.kind, index: hd.index }); return; }
  // A drag dropped half way, by Escape or a change of tool: put it back.
  if (phase === 'cancel') { cancelLive(); maybeRegrow(); return; }
  if (at) live((s) => ops.moveFeature(s, hd.kind, hd.index, at));
  if (phase === 'end') end(`move a ${HANDLE_NAMES[hd.kind] || hd.kind}`);
}

/** In Refine, the 3D view keeps up with the spec: grow again once it settles. */
let regrowTimer = 0;
const failedHere = () => state.buildFailed && state.buildFailed.key === printKey(state.spec);
function maybeRegrow() {
  clearTimeout(regrowTimer);
  const g = state.grown;
  if (g?.previewed && !g.stale) unpreview(g);
  if (state.stage !== 'refine' || !g?.stale || !workersOK || failedHere()) return;
  regrowTimer = setTimeout(() => {
    if (state.stage === 'refine' && state.grown?.stale && !state.busy && liveBase === null && !failedHere()) grow('build');
  }, 350);
}

function hover3d(hit, px, py, dragging) {
  const key = JSON.stringify([hit?.kind, hit?.id]);
  if (key !== state.hoverKey) {
    state.hover = hit;
    state.hoverKey = key;
    invalidate('canvas', 'status');
  } else if (hit) {
    state.hover = hit; // the same thing, at a new point: keep the point for the readout
  }
  if (dragging || !hit) { el.tip.hidden = true; el.readout.textContent = ''; return; }
  showTip({ px, py }, hit, plan3d());
  el.readout.textContent = hit.kind === 'tile'
    ? `${hit.label}  ${hit.z.toFixed(1)} mm up  ·  x ${hit.localX.toFixed(0)}  y ${hit.localY.toFixed(0)} in the tile`
    : '';
}

function pick3d(hit) {
  if (!hit) { select(null); return; }
  // The inspector speaks for the spec as it is now. In a view grown from an
  // older one, a piece that is no longer on the board has nothing to say.
  const p = state.plan;
  const there = hit.kind === 'seam' ? p.seams.some((s) => s.id === hit.id) : p.placements.some((x) => x.col === hit.col && x.row === hit.row);
  if (!there) { say('That is from before the last change, and is not on the board now. Grow again to see what is.', 'warn'); return; }
  select(hit.kind === 'seam' ? { type: 'seam', id: hit.id } : { type: 'tile', col: hit.col, row: hit.row });
}

/* ------------------------------------------------------------------- api */

function say(text, kind = 'info') {
  state.message = { text, kind, at: Date.now() };
  invalidate('status');
}

function select(sel) {
  state.selection = sel;
  invalidate('canvas', 'inspector', 'left', 'status');
}

function currentTool() {
  if (state.stage !== 'draw') return (state.view.mode === 'tile' ? TILE_TOOLS : BOARD_TOOLS)[0];
  const list = state.view.mode === 'tile' ? TILE_TOOLS : BOARD_TOOLS;
  return list.find((t) => t.id === state.tool[state.view.mode]) || list[0];
}

function setTool(id) {
  if (state.gesture?.cancel) state.gesture.cancel();
  state.gesture = null;
  state.tool[state.view.mode] = id;
  invalidate('left', 'canvas');
}

function openTile(col, row) {
  if (state.view.mode === 'board') state.boardView = { ...state.view };
  state.gesture = null;
  state.view = { mode: 'tile', tile: { col, row }, zoom: 1, panX: 0, panY: 0 };
  el.app.dataset.view = 'tile';
  state.selection = { type: 'tile', col, row };
  invalidate('all');
}

function closeTile() {
  const t = state.view.tile;
  state.gesture = null;
  state.view = state.boardView ? { ...state.boardView } : { mode: 'board', tile: null, zoom: 1, panX: 0, panY: 0 };
  state.view.mode = 'board';
  el.app.dataset.view = 'board';
  if (t) state.selection = { type: 'tile', col: t.col, row: t.row };
  invalidate('all');
}

const api = {
  state,
  theme: () => state.theme,
  commit, begin, live, end, cancel: cancelLive,
  select, say, openTile, closeTile,
  setPalette: (p) => { Object.assign(state.palette, p); invalidate('left'); },
  setView: (v) => { state.view = v; invalidate('canvas'); },
  redraw: () => invalidate('canvas'),
  clearGesture: () => { state.gesture = null; invalidate('canvas'); },
};

/* ----------------------------------------------------------------- render */

const dirty = new Set();
let frameAsked = false;
function invalidate(...parts) {
  for (const p of parts) {
    if (typeof p !== 'string') continue;
    if (p === 'all') ['canvas', 'left', 'inspector', 'status', 'json', 'stage', 'sheet'].forEach((k) => dirty.add(k));
    else dirty.add(p);
  }
  if (!frameAsked) { frameAsked = true; requestAnimationFrame(render); }
}

function render() {
  frameAsked = false;
  const d = new Set(dirty);
  dirty.clear();
  if (d.has('stage')) renderStage();
  if (d.has('canvas')) drawCanvas();
  if (d.has('left')) renderLeft();
  if (d.has('inspector')) renderInspector(el.inspector, api);
  if (d.has('status')) renderStatus();
  if (d.has('json')) renderJSON();
  if (d.has('sheet')) renderSheet();
}

function renderStage() {
  el.app.dataset.stage = state.stage;
  for (const b of document.querySelectorAll('.stages button')) b.setAttribute('aria-selected', String(b.dataset.stage === state.stage));
  el.sheet.hidden = state.stage !== 'print';
  if (document.activeElement !== el.name) el.name.value = state.spec.name || '';
  const t = state.view.tile;
  el.crumbs.replaceChildren();
  if (state.view.mode === 'tile' && t) {
    const back = document.createElement('button');
    back.type = 'button'; back.className = 'mini'; back.textContent = '← Board';
    back.addEventListener('click', closeTile);
    const here = document.createElement('span');
    here.className = 'here'; here.textContent = ops.labelOf(t.col, t.row);
    const rot = state.spec.rot?.[ops.keyOf(t.col, t.row)];
    const note = document.createElement('span');
    note.className = 'hint';
    note.textContent = rot ? 'shown as designed; it is turned on the board' : 'tile millimetres, north up';
    el.crumbs.append(back, here, note);
  } else if (state.stage !== 'print') {
    const three = show3d();
    const rt = state.stage === 'refine' && three ? refineTool() : null;
    const coarse = window.matchMedia?.('(pointer: coarse)').matches;
    const text = rt && state.busy ? 'Growing again with the last change. The ground shows the stroke already; the build replays it for real.'
      : rt?.brush ? (coarse ? 'One finger paints, two fingers turn and zoom. Red is the rim: a stroke fades to nothing there.'
        : 'Left-drag paints; right-drag orbits, Shift+right-drag pans, scroll zooms. Red is the rim: a stroke fades to nothing there.')
        : rt?.place ? 'Click a tile to place it there; right-drag orbits.'
          : rt ? 'Drag a handle to move it along the ground; drag anywhere else to orbit.'
            : state.grown?.stale
      ? (three ? 'The 3D view is from before the last change, turned the way the tiles are turned now. Grow again to see the new ground.'
        : 'The hillshade is from before the last change. Grow again to see the new ground.')
      : three ? (window.matchMedia?.('(pointer: coarse)').matches
        ? 'Drag to orbit, two fingers to pan and zoom; tap a tile or a badge to inspect it.'
        : 'Drag to orbit, right-drag to pan, scroll to zoom. Double-click a tile to go to it; R turns the one under the pointer.')
        : state.stage === 'grow' && !state.grown && !state.busy ? 'Nothing grown yet. Grow stands the map up here in 3D.'
          : null;
    if (text) {
      const s = document.createElement('span');
      s.className = 'hint';
      s.textContent = text;
      el.crumbs.append(s);
    }
  }
  // Board or 3D, once there is something grown to stand up.
  el.viewMode.hidden = !can3d();
  for (const b of el.viewMode.querySelectorAll('button')) b.setAttribute('aria-pressed', String((b.dataset.view === '3d') === state.prefer3d));
}

function fitCanvas() {
  const dpr = window.devicePixelRatio || 1;
  const w = Math.max(10, el.host.clientWidth);
  const h = Math.max(10, el.host.clientHeight);
  if (el.canvas.width !== Math.round(w * dpr) || el.canvas.height !== Math.round(h * dpr)) {
    el.canvas.width = Math.round(w * dpr);
    el.canvas.height = Math.round(h * dpr);
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { w, h };
}

function drawCanvas() {
  const three = show3d();
  if (el.app.dataset.three !== (three ? 'on' : 'off')) {
    el.app.dataset.three = three ? 'on' : 'off';
    el.tip.hidden = true;
    el.readout.textContent = '';
  }
  if (state.stage === 'print') return;
  if (three) { sync3d(); return; }
  const { w, h } = fitCanvas();
  const v = state.view;
  const box = v.mode === 'tile' ? tileBox(state.spec, v.tile.col, v.tile.row) : boardBox(state.spec, state.plan);
  const cam = makeCamera({ width: w, height: h, box, zoom: v.zoom, panX: v.panX, panY: v.panY });
  state.cam = cam;
  const tool = currentTool();
  const st = { ...state, tool: tool.id };
  const th = state.theme;
  if (v.mode === 'tile') {
    state.frame = drawTileView(ctx, st, cam, th);
  } else {
    state.frame = drawBoard(ctx, st, cam, th, { ghosts: !!tool.ghosts && state.stage === 'draw', features: 'faint' });
    state.frame.handles = handles(st, cam);
    if (state.gesture?.preview) drawPreview(ctx, state.gesture.preview, cam, th);
  }
}

/* ------------------------------------------------------------------- left */

function h(tag, attrs = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat(Infinity)) if (kid !== null && kid !== undefined && kid !== false) e.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  return e;
}

function renderLeft() {
  const kids = [];
  if (state.stage === 'draw') kids.push(...drawLeft());
  else if (state.stage === 'grow') kids.push(...growLeft());
  else if (state.stage === 'refine') kids.push(...refineLeft());
  else kids.push(...printLeft());
  el.left.replaceChildren(...kids.flat(Infinity).filter(Boolean));
}

function drawLeft() {
  const mode = state.view.mode;
  const list = mode === 'tile' ? TILE_TOOLS : BOARD_TOOLS;
  const groups = mode === 'tile' ? TILE_GROUPS : BOARD_GROUPS;
  const tool = currentTool();
  const out = [h('h2', { class: 'panel-title' }, mode === 'tile' ? `Tools — ${ops.labelOf(state.view.tile.col, state.view.tile.row)}` : 'Tools')];
  for (const [title, ids] of groups) {
    out.push(h('div', { class: 'tool-sub' }, title));
    out.push(h('div', { class: 'toolgrid' }, ids.map((id) => list.find((t) => t.id === id)).filter(Boolean).map((t) => h('button', {
      type: 'button', class: 'tool', 'aria-pressed': String(t.id === tool.id), title: `${t.label} (${t.key})`,
      onclick: () => setTool(t.id), 'data-tool': t.id,
    }, h('span', { class: 'glyph', 'aria-hidden': 'true' }, t.glyph), t.label, h('span', { class: 'key' }, t.key)))));
  }
  const pal = (tool.palette ? tool.palette(api) : []);
  out.push(h('div', { class: 'group palette' },
    h('h2', { class: 'panel-title' }, tool.label),
    h('p', { class: 'hint' }, tool.hint),
    pal.map((p) => [
      p.chips ? h('div', { class: 'chips', role: 'group', 'aria-label': `${tool.label} options` }, p.chips.map(([v, t]) => h('button', {
        type: 'button', 'aria-pressed': String(String(v) === String(p.value)), onclick: () => p.pick(v), 'data-chip': String(v),
      }, t))) : null,
      p.note ? h('p', { class: 'hint' }, p.note) : null,
    ])));
  if (mode === 'board') {
    out.push(h('div', { class: 'group' }, h('h2', { class: 'panel-title' }, 'Tiles'),
      h('ul', { class: 'tile-list' }, [...state.plan.tiles].sort((a, b) => b.row - a.row || a.col - b.col).map((t) => {
        const sel = state.selection?.type === 'tile' && state.selection.col === t.col && state.selection.row === t.row;
        const what = t.overtops ? 'overtops' : t.ponds ? `ponds ${Math.round(t.levelMM)}` : t.wet ? 'wet' : (Object.values(t.placed.edges || {}).some((e) => e && e.type !== 'land') ? 'dry bed' : 'land');
        return h('li', {
          class: sel ? 'sel' : null, onclick: () => select({ type: 'tile', col: t.col, row: t.row }),
          ondblclick: () => openTile(t.col, t.row), title: 'Double-click to open',
        }, h('b', {}, t.label), h('span', {}, `${t.riserMM} mm · ${what}${t.rot ? ` · ${t.rot * 90}°` : ''}`));
      }))));
  } else {
    out.push(h('div', { class: 'group' }, h('button', { type: 'button', onclick: closeTile }, '← Back to the board')));
  }
  return out;
}

const MESHES = [['2.5', 'Draft 2.5'], ['0.9', 'Normal 0.9'], ['0.6', 'Fine 0.6']];

function growLeft() {
  const s = state.spec;
  const b = state.busy;
  const mesh = String(s.meshMM ?? 0.8);
  const est = estimateSeconds(s, 'build');
  const g = state.grown;
  return [
    h('h2', { class: 'panel-title' }, 'Grow'),
    h('p', { class: 'hint' }, 'Runs the generator on the spec: the ground, the ice, every tile cut, carved, conformed, planted and meshed. It runs in a worker, so the page stays live.'),
    h('div', { class: 'group' },
      h('div', { class: 'tool-sub' }, 'Mesh'),
      h('div', { class: 'chips' }, MESHES.map(([v, t]) => h('button', {
        type: 'button', 'aria-pressed': String(mesh === v), disabled: !!b,
        onclick: () => commit((x) => { x.meshMM = Number(v); }, 'mesh'),
      }, t)), MESHES.some(([v]) => v === mesh) ? null : h('button', { type: 'button', 'aria-pressed': 'true' }, `${mesh} mm`)),
      h('p', { class: 'hint' }, 'Start on draft: the contract, the plate levels, the seams and the keys are identical at 2.5 mm, and it comes back in seconds.'),
      h('p', { class: 'hint' }, est < 2 ? 'About a second.' : est < 90 ? `Roughly ${Math.round(est)} s at this mesh.` : `Roughly ${Math.round(est / 60)} min at this mesh.`)),
    h('div', { class: 'group row-btns', style: 'display:flex;gap:6px;flex-wrap:wrap' },
      h('button', { type: 'button', class: 'primary', disabled: !!b || !workersOK, onclick: () => grow('build'), id: 'grow-go' }, 'Grow'),
      h('button', { type: 'button', disabled: !!b || !workersOK, onclick: () => grow('check'), title: 'The contract and the seams, without the ice' }, 'Check'),
      b ? h('button', { type: 'button', class: 'danger', onclick: cancelGrow }, 'Cancel') : null),
    b ? h('div', { class: 'group' }, h('p', { class: 'busy' }, `${b.label} — ${((Date.now() - b.startedAt) / 1000).toFixed(1)} s`),
      h('ol', { class: 'progress' }, b.progress.map((m, i) => h('li', { class: i === b.progress.length - 1 ? 'now' : null }, m)))) : null,
    g && !b ? h('div', { class: 'group' },
      h('h2', { class: 'panel-title' }, g.mode === 'check' ? 'Last check' : 'Last grown'),
      h('ul', { class: 'facts' }, [
        ['Time', `${(g.elapsedMS / 1000).toFixed(1)} s`],
        ['Tiles', String(g.report.tiles.length)],
        ['Triangles', fmt(g.report.totals.triangles)],
        ['Worst edge error', `${fmt(g.report.totals.worstEdgeMM, 4)} mm`],
        ['Did not close', String(g.report.totals.leaks)],
      ].map(([k, v]) => h('li', {}, h('span', {}, k), h('span', {}, v)))),
      g.stale ? h('p', { class: 'warn-line' }, 'The spec has changed since. Grow again to see it.') : null,
      h('button', { type: 'button', onclick: () => setStage('print') }, 'Report and files →')) : null,
    g && !b ? h('p', { class: 'hint' }, viewerFailed && !viewerFailed.retry
      ? 'This browser could not start WebGL, so there is no 3D view: the hillshade lies under the board instead, each tile turned the way it sits.'
      : viewerFailed
        ? 'The 3D view did not load, so the hillshade lies under the board for now. Open Grow again to try again.'
        : 'In the middle, in 3D: each tile on its risers and turned the way it sits, the water where the board says it goes, and what every seam does floating over it. Turning a tile is play, so the view follows without growing again.') : null,
  ];
}

function refineLeft() {
  const g = state.grown;
  const b = state.busy;
  const out = [h('h2', { class: 'panel-title' }, 'Refine')];
  if (!g) {
    out.push(
      h('p', { class: 'hint' }, 'The brushes work on the grown ground, in 3D. Grow the map first.'),
      h('div', { class: 'group' }, h('button', { type: 'button', class: 'primary', disabled: !!b || !workersOK, onclick: () => grow('build') }, 'Grow it')),
      b ? h('p', { class: 'busy' }, `${b.label} — ${((Date.now() - b.startedAt) / 1000).toFixed(1)} s`) : null,
    );
    return out;
  }
  const tool = refineTool();
  for (const [title, ids] of REFINE_GROUPS) {
    out.push(h('div', { class: 'tool-sub' }, title));
    out.push(h('div', { class: 'toolgrid' }, ids.map((id) => REFINE_TOOLS.find((t) => t.id === id)).filter(Boolean).map((t) => h('button', {
      type: 'button', class: 'tool', 'aria-pressed': String(t.id === tool.id), title: `${t.label} (${t.key})`,
      onclick: () => setRefineTool(t.id), 'data-tool': t.id,
    }, h('span', { class: 'glyph', 'aria-hidden': 'true' }, t.glyph), t.label, h('span', { class: 'key' }, t.key)))));
  }
  const pal = tool.palette ? tool.palette(api) : [];
  out.push(h('div', { class: 'group palette' },
    h('h2', { class: 'panel-title' }, tool.label),
    h('p', { class: 'hint' }, tool.hint),
    pal.map((p) => [
      h('div', { class: 'chips', role: 'group', 'aria-label': `${tool.label} options` }, p.chips.map(([v, t]) => h('button', {
        type: 'button', 'aria-pressed': String(String(v) === String(p.value)), onclick: () => p.pick(v), 'data-chip': String(v),
      }, t))),
      p.note ? h('p', { class: 'hint' }, p.note) : null,
    ])));
  // What happens after a stroke, and how long it takes: the tiles, not the ice.
  const again = estimateSeconds({ ...state.spec, glacier: false }, 'build');
  const n = Object.values(state.spec.edits || {}).reduce((a, l) => a + (Array.isArray(l) ? l.length : 0), 0);
  out.push(h('div', { class: 'group' },
    b ? [h('p', { class: 'busy' }, `${b.label} — ${((Date.now() - b.startedAt) / 1000).toFixed(1)} s`),
      h('ol', { class: 'progress' }, b.progress.map((m, i) => h('li', { class: i === b.progress.length - 1 ? 'now' : null }, m)))]
      : failedHere() ? [h('p', { class: 'err-line' }, `The last build failed: ${state.buildFailed.message}`),
        h('button', { type: 'button', onclick: () => grow('build') }, 'Try again')]
        : h('p', { class: g.stale ? 'warn-line' : 'hint' }, g.stale ? 'Growing again with the last change…' : `Grown with ${n ? `all ${n} edit${n > 1 ? 's' : ''}` : 'no edits yet'}.`),
    h('p', { class: 'hint' }, `Every change here grows the map again, keeping the ground and the ice from last time: ${again < 2 ? 'about a second' : `about ${Math.round(again)} s`} at this mesh.${(Number(state.spec.meshMM) || 0.8) < 2.5 ? ' Refine on the draft mesh and print on a finer one: the edits are the same at any mesh.' : ''}`),
    h('p', { class: 'hint' }, 'Edits are kept as strokes, not as the ground they changed, so a new seed or a new climate keeps every one. Select a tile to see its list.')));
  return out;
}

function printLeft() {
  const g = state.grown;
  if (!g) return [h('h2', { class: 'panel-title' }, 'Print'), h('p', { class: 'hint' }, 'Nothing grown yet.'), h('button', { type: 'button', class: 'primary', onclick: () => setStage('grow') }, 'Grow it')];
  const t = g.report.totals;
  return [
    h('h2', { class: 'panel-title' }, 'Print'),
    h('ul', { class: 'facts' }, [
      ['Tiles', String(g.report.tiles.length)],
      ['Plates', String(t.totalPlates)],
      ['Keys', String(g.report.keys.usable)],
      ['Springs', String(g.report.springs.length)],
      ['Epoxy', g.report.lakes.totalMl ? `${fmt(g.report.lakes.totalMl, 1)} ml` : '—'],
    ].map(([k, v]) => h('li', {}, h('span', {}, k), h('span', {}, v)))),
    g.stale ? h('p', { class: 'warn-line' }, 'These are from before the last change.') : null,
    g.mode === 'check' ? h('p', { class: 'warn-line' }, 'This was a check, with the ice off. Grow to print the real thing.') : null,
  ];
}

/* ----------------------------------------------------------------- sheet */

function renderSheet() {
  if (state.stage !== 'print') return;
  const g = state.grown;
  if (!g) {
    el.sheet.innerHTML = '<div class="wrap"><div class="card empty"><p>Nothing grown yet. Grow the map, then come back for the report and the files.</p></div></div>';
    return;
  }
  const files = g.filesGone
    ? '<p class="hint">The files went with the cancelled worker. Grow again to get them back.</p>'
    : downloadsHTML(g.report, g.files);
  el.sheet.innerHTML = `<div class="wrap">${g.stale ? '<p class="banner err">The spec has changed since this was grown, so these are the old tiles. Grow again for the new ones.</p>' : ''}`
    + `<div class="card"><h2>Report</h2>${reportHTML(g.report, g.elapsedMS)}</div>`
    + `<div class="card"><h2>Print files</h2>${files}</div></div>`;
}

el.sheet.addEventListener('click', (ev) => {
  const b = ev.target.closest('button');
  if (!b || state.busy || !builder || state.grown?.filesGone) return;
  if (b.dataset.zip) {
    state.busy = { mode: 'zip', startedAt: Date.now(), progress: [], label: 'Packing' };
    builder.postMessage({ type: 'zip' });
  } else if (b.dataset.id) {
    state.busy = { mode: 'stl', startedAt: Date.now(), progress: [], label: 'Writing STL' };
    builder.postMessage({ type: 'stl', id: b.dataset.id });
  }
  say(`${state.busy.label}…`);
  invalidate('left');
});

/* ---------------------------------------------------------------- status */

const COUNT_ORDER = [
  ['spring', 'spring', '--c-spring'], ['flow', 'flow', '--c-water'], ['waterfall', 'waterfall', '--c-water'],
  ['dam', 'dam', '--c-dam'], ['blocked', 'bank', '--c-dam'], ['overtops', 'overtops', '--c-dam'],
  ['spills', 'spills', '--c-spill'], ['spreads', 'spreads', '--c-spill'], ['head-on', 'head on', '--c-headon'],
  ['drains', 'drain', '--c-water'], ['back', 'spills back', '--c-water'], ['dry', 'dry', '--c-dry'], ['cliff', 'cliff', '--c-cliff'], ['ponds', 'ponding', '--c-water'],
];
const RIMS = {
  datum: 'rims at the land datum: no ground yet',
  updating: 'rims from the last ground; the new one is coming',
  estimate: 'rims from the ground, before the ice',
  grown: 'rims as grown',
};

function renderStatus() {
  const p = state.plan;
  const n = p.counts;
  el.counts.replaceChildren(...COUNT_ORDER.filter(([k]) => n[k]).map(([k, label, color]) => {
    const c = document.createElement('span');
    c.className = 'count';
    c.style.setProperty('--dot', `var(${color})`);
    c.title = `${n[k]} ${label}`;
    const i = document.createElement('i');
    c.append(i, `${n[k]} ${label}${n[k] > 1 && !['dry', 'spreads', 'overtops', 'ponding', 'head on', 'spills back'].includes(label) ? 's' : ''}`);
    return c;
  }));
  const parts = [];
  const msg = state.message && Date.now() - state.message.at < 6000 ? state.message : null;
  if (state.busy) parts.push({ kind: 'busy', text: `${state.busy.label}…` });
  if (msg) parts.push({ kind: msg.kind, text: msg.text });
  const focus = state.hover?.kind === 'seam' ? state.hover.id : state.selection?.type === 'seam' ? state.selection.id : null;
  const first = focus ? p.sentences.filter((x) => x.seam === focus) : [];
  for (const x of [...first, ...p.sentences.filter((x) => !first.includes(x))]) parts.push(x);
  el.say.replaceChildren(...parts.map((x) => {
    const s = document.createElement('span');
    s.className = `s ${x.kind}`;
    if (x.kind === 'err') s.style.color = 'var(--err)';
    if (x.kind === 'warn') s.style.color = 'var(--warn)';
    s.textContent = x.text;
    return s;
  }));
  el.rims.textContent = RIMS[p.rimsFrom] || '';
  if (msg && !msg.timer) msg.timer = setTimeout(() => invalidate('status'), 6100);
  if (!el.sentences.hidden) renderSentences();
}

function renderSentences() {
  const p = state.plan;
  const design = p.design.filter((d) => d.severity !== 'note' || d.kind === 'drain' || d.kind === 'open-inlet');
  el.sentences.innerHTML = `<h3>What the board does</h3><ol>${p.sentences.map((x) => `<li class="${esc(x.kind)}">${esc(x.text)}</li>`).join('')}</ol>`
    + `<h3>To build it</h3>${design.length ? design.map((d) => `<p class="msg ${esc(d.severity)}">${esc(d.message)}</p>`).join('') : '<p class="msg">Nothing stands in the way.</p>'}`
    + `<p class="hint">${esc(RIMS[p.rimsFrom] || '')}. The board predicts and never refuses: what it says is what the water will do if the pieces are set out like this.</p>`;
}

el.sayAll.addEventListener('click', () => {
  el.sentences.hidden = !el.sentences.hidden;
  el.sayAll.setAttribute('aria-expanded', String(!el.sentences.hidden));
  if (!el.sentences.hidden) renderSentences();
});

/* ------------------------------------------------------------------ JSON */

function renderJSON() {
  if (el.drawer.hidden) return;
  if (document.activeElement === el.spec) return; // never rewrite what is being typed
  el.spec.value = ops.formatSpec(state.spec);
  el.jsonErr.hidden = true;
  el.jsonChanged.textContent = state.lastChanged.length ? `changed: ${state.lastChanged.join(', ')}` : '';
}

let jsonTimer = 0;
el.spec.addEventListener('input', () => {
  clearTimeout(jsonTimer);
  jsonTimer = setTimeout(() => {
    try {
      const v = JSON.parse(el.spec.value);
      if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('the spec has to be a JSON object');
      el.jsonErr.hidden = true;
      setSpec(v, 'edit the JSON');
    } catch (e) {
      el.jsonErr.textContent = e.message;
      el.jsonErr.hidden = false;
    }
  }, 350);
});
el.spec.addEventListener('blur', () => invalidate('json'));
function toggleDrawer(open = el.drawer.hidden) {
  el.drawer.hidden = !open;
  el.jsonToggle.setAttribute('aria-expanded', String(open));
  if (open) renderJSON();
}
el.jsonToggle.addEventListener('click', () => toggleDrawer());
$('json-close').addEventListener('click', () => toggleDrawer(false));
$('json-format').addEventListener('click', () => { el.spec.blur(); renderJSON(); });
$('json-copy').addEventListener('click', async (ev) => {
  try {
    await navigator.clipboard.writeText(ops.formatSpec(state.spec));
    ev.target.textContent = 'Copied';
    setTimeout(() => { ev.target.textContent = 'Copy'; }, 1400);
  } catch { el.spec.select(); }
});

/* --------------------------------------------------------------- pointer */

let spaceDown = false;

function evAt(ev) {
  const r = el.canvas.getBoundingClientRect();
  const px = ev.clientX - r.left;
  const py = ev.clientY - r.top;
  const cam = state.cam;
  const pt = cam ? cam.toBoard(px, py) : { x: 0, y: 0 };
  const tool = currentTool();
  const list = state.frame?.handles || [];
  const wantsHandles = tool.id === 'select' || tool.id === 'corner';
  const handle = wantsHandles ? hitHandle(list, px, py, { corners: state.view.mode === 'tile', spineLine: false }) : null;
  const hit = cam ? hitBoard(state, cam, px, py, state.frame, { ghosts: !!tool.ghosts && state.stage === 'draw' }) : { kind: 'empty' };
  return { px, py, pt, hit, handle, ev };
}

el.canvas.addEventListener('pointerdown', (ev) => {
  el.canvas.focus({ preventScroll: true });
  const e = evAt(ev);
  if (ev.button === 1 || ev.button === 2 || spaceDown) {
    const v0 = { ...state.view };
    state.gesture = { kind: 'pan', move: (e2) => api.setView({ ...state.view, panX: v0.panX + (e2.px - e.px), panY: v0.panY + (e2.py - e.py) }), up: () => {} };
  } else {
    const tool = currentTool();
    const g = tool.down ? tool.down(api, e) : null;
    state.gesture = g || (state.gesture?.sticky ? state.gesture : null);
  }
  if (state.gesture && !state.gesture.sticky) el.canvas.setPointerCapture(ev.pointerId);
  invalidate('canvas');
});

el.canvas.addEventListener('pointermove', (ev) => {
  const e = evAt(ev);
  const g = state.gesture;
  if (g && !g.sticky && g.move && (ev.buttons || g.kind === 'pan')) {
    g.move(e);
    invalidate('canvas');
  } else if (g?.sticky && g.hover) {
    g.hover(e);
    invalidate('canvas');
  }
  const hov = e.handle?.kind === 'corner' ? { kind: 'corner', corner: e.handle.corner }
    : e.handle ? { kind: 'handle', h: e.handle } : e.hit;
  const key = JSON.stringify([hov?.kind, hov?.id, hov?.col, hov?.row, hov?.side, hov?.corner, hov?.h?.kind, hov?.h?.index]);
  if (key !== state.hoverKey) {
    state.hover = hov;
    state.hoverKey = key;
    invalidate('canvas', 'status');
  }
  showTip(e, hov);
  readout(e);
});

el.canvas.addEventListener('pointerup', (ev) => {
  const g = state.gesture;
  if (g && !g.sticky) {
    g.up?.(evAt(ev));
    state.gesture = null;
    invalidate('canvas');
  }
  if (el.canvas.hasPointerCapture(ev.pointerId)) el.canvas.releasePointerCapture(ev.pointerId);
});

el.canvas.addEventListener('pointerleave', () => {
  el.tip.hidden = true;
  el.readout.textContent = '';
  if (state.hover) { state.hover = null; state.hoverKey = null; invalidate('canvas', 'status'); }
});

el.canvas.addEventListener('contextmenu', (ev) => ev.preventDefault());

el.canvas.addEventListener('dblclick', (ev) => {
  const g = state.gesture;
  if (g?.sticky && g.finish) { g.finish(); return; }
  if (state.stage !== 'draw' && state.stage !== 'grow' && state.stage !== 'refine') return;
  const e = evAt(ev);
  if (e.hit.kind === 'tile') {
    const t = state.view.tile;
    if (state.view.mode === 'tile' && t && t.col === e.hit.col && t.row === e.hit.row) return;
    openTile(e.hit.col, e.hit.row);
  }
});

el.canvas.addEventListener('wheel', (ev) => {
  ev.preventDefault();
  if (!state.cam) return;
  const r = el.canvas.getBoundingClientRect();
  const z = Math.max(0.3, Math.min(14, state.view.zoom * Math.exp(-ev.deltaY * 0.0016)));
  state.view = zoomAbout(state.cam, ev.clientX - r.left, ev.clientY - r.top, z, state.view);
  invalidate('canvas');
}, { passive: false });

function zoomBy(f) {
  if (show3d()) { viewer?.zoomBy(f); return; }
  if (!state.cam) return;
  const z = Math.max(0.3, Math.min(14, state.view.zoom * f));
  state.view = zoomAbout(state.cam, state.cam.width / 2, state.cam.height / 2, z, state.view);
  invalidate('canvas');
}
function zoomFit() {
  if (show3d()) { viewer?.reframe(); return; }
  state.view = { ...state.view, zoom: 1, panX: 0, panY: 0 };
  invalidate('canvas');
}
$('zoom-in').addEventListener('click', () => zoomBy(1.25));
$('zoom-out').addEventListener('click', () => zoomBy(0.8));
$('zoom-fit').addEventListener('click', zoomFit);
el.viewMode.addEventListener('click', (ev) => {
  const b = ev.target.closest('button[data-view]');
  if (!b) return;
  state.prefer3d = b.dataset.view === '3d';
  state.hover = null;
  state.hoverKey = null;
  el.tip.hidden = true;
  invalidate('canvas', 'stage');
});

function showTip(e, hov, p = state.plan) {
  let text = null;
  if (hov?.kind === 'seam') {
    const said = p.sentences.filter((x) => x.seam === hov.id).map((x) => x.text);
    const sm = p.seams.find((x) => x.id === hov.id);
    text = said.length ? said.join(' ') : sm ? quiet(sm) : null;
  } else if (hov?.kind === 'handle') {
    const names = { spine: 'Ridge point', volcano: 'Volcano', 'volcano-rim': 'Foot of the cone', flat: 'Flat', 'flat-rim': 'Edge of the flat', lake: 'Lake', springpoint: 'Spring', 'wood-vertex': 'Edge of the wood', wood: 'Wood' };
    text = `${names[hov.h.kind] || hov.h.kind} — drag to move`;
  } else if (hov?.kind === 'corner') {
    text = 'A corner: click to raise it a plate with the corner tool';
  } else if (hov?.kind === 'ghost') {
    text = `Add a ${hov.side === 'E' || hov.side === 'W' ? 'column' : 'row'} on the ${{ N: 'north', E: 'east', S: 'south', W: 'west' }[hov.side]}`;
  }
  if (!text || state.gesture) { el.tip.hidden = true; return; }
  el.tip.textContent = text;
  el.tip.hidden = false;
  const W = el.host.clientWidth;
  const x = Math.min(e.px + 16, W - el.tip.offsetWidth - 8);
  el.tip.style.left = `${Math.max(8, x)}px`;
  el.tip.style.top = `${Math.max(8, e.py + 18)}px`;
}

function quiet(sm) {
  if (sm.kind === 'cliff') return `The land steps ${Math.round(Math.abs(sm.landStepMM))} mm along this seam.`;
  if (!sm.wet) return sm.kind === 'dry' ? 'A dry inlet: nothing feeds it.' : 'A river bed with no water in it: nothing upstream feeds it.';
  return sm.kind;
}

function readout(e) {
  if (state.view.mode === 'tile') {
    const { T } = ops.dims(state.spec);
    const t = state.view.tile;
    const x = e.pt.x - t.col * T;
    const y = e.pt.y - t.row * T;
    el.readout.textContent = x >= 0 && y >= 0 && x <= T && y <= T ? `${ops.labelOf(t.col, t.row)}  x ${x.toFixed(0)}  y ${y.toFixed(0)} mm` : `board ${e.pt.x.toFixed(0)}, ${e.pt.y.toFixed(0)} mm`;
  } else {
    el.readout.textContent = `${e.pt.x.toFixed(0)}, ${e.pt.y.toFixed(0)} mm`;
  }
}

/* -------------------------------------------------------------- keyboard */

function deleteSelection() {
  const s = state.selection;
  if (!s) return;
  const { cols, rows } = ops.dims(state.spec);
  switch (s.type) {
    case 'tile': {
      const side = s.col === 0 && cols > 1 ? 'W' : s.col === cols - 1 && cols > 1 ? 'E' : s.row === 0 && rows > 1 ? 'S' : s.row === rows - 1 && rows > 1 ? 'N' : null;
      if (!side) { say('Only a tile on the edge of the board comes off, with its row or column: a map-style board is a rectangle.', 'warn'); return; }
      commit((x) => ops.shrinkBoard(x, side), `remove a ${side === 'E' || side === 'W' ? 'column' : 'row'}`);
      select(null);
      return;
    }
    case 'river': commit((x) => ops.removeRiver(x, s.index), 'delete a river'); break;
    case 'spine': commit((x) => { delete x.spine; }, 'delete the ridge'); break;
    case 'volcano': commit((x) => { x.volcanoes.splice(s.index, 1); ops.tidy(x); }, 'delete a volcano'); break;
    case 'flat': commit((x) => { x.flats.splice(s.index, 1); ops.tidy(x); }, 'delete a flat'); break;
    case 'lake': commit((x) => { x.lakes.place.splice(s.index, 1); ops.tidy(x); }, 'delete a lake'); break;
    case 'springpoint': commit((x) => { x.fountains.place.splice(s.index, 1); ops.tidy(x); }, 'delete a spring'); break;
    case 'wood': commit((x) => { x.canopy.splice(s.index, 1); ops.tidy(x); }, 'delete a wood'); break;
    case 'corner': commit((x) => { if (x.cornerRaise) delete x.cornerRaise[`${s.cc},${s.rr}`]; ops.tidy(x); }, 'lower a corner'); break;
    default: return;
  }
  select(null);
}

function turnUnderPointer(back) {
  const t = state.hover?.kind === 'tile' ? state.hover : state.selection?.type === 'tile' ? state.selection : null;
  if (!t || state.view.mode !== 'board') return;
  // A grown tile that has since come off the board is not there to turn.
  if (!state.plan.placements.some((p) => p.col === t.col && p.row === t.row)) return;
  const k = ops.keyOf(t.col, t.row);
  const now = state.spec.rot?.[k] || 0;
  commit((x) => ops.setRot(x, t.col, t.row, now + (back ? -1 : 1)), `turn ${ops.labelOf(t.col, t.row)}`);
}

window.addEventListener('keydown', (ev) => {
  const target = ev.target;
  const typing = target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT' || target.isContentEditable);
  const mod = ev.ctrlKey || ev.metaKey;
  if (mod && (ev.key === 'z' || ev.key === 'Z') && !typing) { ev.preventDefault(); if (ev.shiftKey) redo(); else undo(); return; }
  if (mod && (ev.key === 'y' || ev.key === 'Y') && !typing) { ev.preventDefault(); redo(); return; }
  if (typing) { if (ev.key === 'Escape') target.blur(); return; }
  if (mod || ev.altKey) return;
  if (ev.key === ' ') { spaceDown = true; ev.preventDefault(); return; }
  if (ev.key === 'Escape') {
    if (state.stage === 'refine' && viewer) viewer.cancelGesture();
    if (state.gesture?.cancel) { state.gesture.cancel(); state.gesture = null; invalidate('canvas'); return; }
    if (!el.sentences.hidden) { el.sentences.hidden = true; return; }
    if (state.view.mode === 'tile') { closeTile(); return; }
    select(null);
    return;
  }
  if (ev.key === 'Enter' && state.gesture?.finish) { state.gesture.finish(); return; }
  if (ev.key === 'Delete' || ev.key === 'Backspace') { if (state.stage === 'draw') { ev.preventDefault(); deleteSelection(); } return; }
  if (ev.key === '0') { zoomFit(); return; }
  if (ev.key === '+' || ev.key === '=') { zoomBy(1.25); return; }
  if (ev.key === '-') { zoomBy(0.8); return; }
  // A turn is play, so it works on the grown map too: nothing has to be grown again.
  if ((ev.key === 'r' || ev.key === 'R') && show3d()) { turnUnderPointer(ev.shiftKey); return; }
  if (state.stage === 'refine') {
    const t = REFINE_TOOLS.find((x) => x.key.toLowerCase() === ev.key.toLowerCase());
    if (t) setRefineTool(t.id);
    return;
  }
  if (state.stage !== 'draw') return;
  if (ev.key === 'r' || ev.key === 'R') { turnUnderPointer(ev.shiftKey); return; }
  const list = state.view.mode === 'tile' ? TILE_TOOLS : BOARD_TOOLS;
  const t = list.find((x) => x.key.toLowerCase() === ev.key.toLowerCase());
  if (t) setTool(t.id);
});
window.addEventListener('keyup', (ev) => { if (ev.key === ' ') spaceDown = false; });

/* ---------------------------------------------------------------- header */

function setStage(stage) {
  if (state.gesture?.cancel) state.gesture.cancel();
  state.gesture = null;
  state.stage = stage;
  state.hover = null;
  state.hoverKey = null;
  el.tip.hidden = true;
  // Fetch three.js while the map grows, so the 3D view is ready when it lands.
  if ((stage === 'grow' || stage === 'refine') && workersOK) {
    if (viewerFailed?.retry) viewerFailed = null;
    loadViewer().catch(() => {});
  }
  if (stage !== 'refine') clearTimeout(regrowTimer);
  maybeRegrow();
  invalidate('all');
}
for (const b of document.querySelectorAll('.stages button')) b.addEventListener('click', () => setStage(b.dataset.stage));

$('undo').addEventListener('click', undo);
$('redo').addEventListener('click', redo);
$('new').addEventListener('click', () => {
  if (state.view.mode === 'tile') closeTile();
  state.selection = null;
  setSpec(ops.blankSpec(), 'new board');
  say('A new board: one plain tile. Use Place to add rows and columns.');
});
$('example').addEventListener('click', () => {
  if (state.view.mode === 'tile') closeTile();
  state.selection = null;
  setSpec(structuredClone(EXAMPLE_SPEC), 'load the example');
});
$('save').addEventListener('click', () => {
  const name = (state.spec.name || 'map').replace(/[^\w.-]+/g, '-');
  saveBlob(new Blob([`${ops.formatSpec(state.spec)}\n`], { type: 'application/json' }), `${name}.json`);
});
$('open').addEventListener('click', () => el.openFile.click());
el.openFile.addEventListener('change', async () => {
  const f = el.openFile.files?.[0];
  if (!f) return;
  try {
    const v = JSON.parse(await f.text());
    if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('not a spec');
    if (state.view.mode === 'tile') closeTile();
    state.selection = null;
    migratedThisLoad = false;
    setSpec(v, `open ${f.name}`);
    say(migratedThisLoad
      ? `Opened ${f.name}, and converted it from world metres to millimetres. Heights will have changed: the old format squashed them to fit a relief budget, so they never had a fixed printed height. Check Mountains in the inspector.`
      : `Opened ${f.name}.`, 'ok');
  } catch (e) {
    say(`Could not open ${f.name}: ${e.message}`, 'err');
  }
  el.openFile.value = '';
});
el.name.addEventListener('change', () => commit((x) => { const v = el.name.value.trim(); if (v) x.name = v; else delete x.name; }, 'rename'));

/* --------------------------------------------------------------- startup */

function moduleWorkersWork() {
  let seen = false;
  const url = URL.createObjectURL(new Blob([''], { type: 'text/javascript' }));
  try {
    new Worker(url, { get type() { seen = true; return 'module'; } }).terminate();
  } catch { /* seen stays false */ } finally {
    URL.revokeObjectURL(url);
  }
  return seen;
}

const workersOK = moduleWorkersWork();
if (!workersOK) {
  el.unsupported.textContent = 'This browser does not support ES-module web workers, which is how the editor grows a map without freezing. Drawing works; growing needs a current Chrome, Edge, Firefox or Safari.';
  el.unsupported.hidden = false;
}
if (location.protocol === 'file:') {
  el.unsupported.textContent = 'Opened from the filesystem, so the browser will refuse the ES modules this page is made of. Serve the repository over HTTP instead: python3 -m http.server from its root, then open /app/.';
  el.unsupported.hidden = false;
}

window.matchMedia?.('(prefers-color-scheme: dark)').addEventListener?.('change', () => {
  state.theme = readTheme();
  viewer?.setTheme(state.theme);
  invalidate('canvas');
});
new ResizeObserver(() => invalidate('canvas')).observe(el.host);
setInterval(() => { if (state.busy) invalidate('left'); }, 250);

state.spec = loadSpec();
replan();
state.history = [JSON.stringify(state.spec)];
state.hIndex = 0;
wantWorld();
invalidate('all');

// For the browser test and for poking at it from the console.
window.mmb = { state, api, ops, undo, redo, grow, setStage, openTile, closeTile, setTool, viewer: () => viewer, show3d };
