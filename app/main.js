// main.js — the editor. One state object, one render, and the spec as the
// document: every tool writes it, and everything on screen is drawn from
// it.
//
// Four stages over one spec: Draw the module flat; Grow it (the generator,
// in a worker) and look at it in 3D; Refine it by hand on the 3D view,
// every stroke kept as an edit in the spec; Print it. Nothing leaves the
// machine.
//
// The 3D view (viewer.js, three.js) is loaded the first time Grow is
// opened, so drawing never waits for it.

import { EXAMPLE_SPEC } from '../lib/example.js';
import { worldKey } from '../lib/build.js';
import { toRGBA } from '../lib/shade.js';
import { isBoardSpec, BOARD_SPEC_MESSAGE } from '../lib/scale.js';
import * as ops from './specops.js';
import { readTheme, makeCamera, zoomAbout } from './view.js';
import { tileBox, drawTile, hitTile, drawPreview } from './tilecanvas.js';
import { hitHandle } from './features.js';
import { DRAW_TOOLS, DRAW_GROUPS, REFINE_TOOLS, REFINE_GROUPS } from './tools.js';
import { applyGroundEdits, editsFor, GROUND_OPS, EDIT_DEFAULTS } from '../lib/edits.js';
import { renderInspector } from './inspector.js';
import { reportHTML, downloadsHTML, fmt, bytes } from './report.js';

const $ = (id) => document.getElementById(id);
const el = {
  app: $('app'), left: $('left'), inspector: $('inspector'), canvas: $('canvas'), host: $('canvas-host'),
  crumbs: $('crumbs'), tip: $('tip'), readout: $('readout'), sheet: $('sheet'),
  say: $('say'), notes: $('notes'),
  jsonToggle: $('json-toggle'), drawer: $('drawer'), spec: $('spec'), jsonErr: $('json-err'), jsonChanged: $('json-changed'),
  name: $('map-name'), unsupported: $('unsupported'), openFile: $('open-file'),
  view3d: $('view3d'), overlay3d: $('overlay3d'), viewMode: $('view-mode'),
};
const ctx = el.canvas.getContext('2d');
const STORE = 'mmb.module.v1';

/* ------------------------------------------------------------- the state */

const state = {
  spec: null,
  say: null,
  stage: 'draw',
  view: { zoom: 1, panX: 0, panY: 0 },
  tool: { draw: 'select', refine: 'select' },
  palette: { channelWidth: 30, channelDepth: 10, woodKind: 'deciduous', brushWidth: 30, brushMM: 4, plantKind: 'deciduous' },
  selection: null,
  hover: null,
  gesture: null,
  shade: null, // { kind: 'estimate' | 'grown', image, key }
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
  showLock: false,
};

function loadSpec() {
  try {
    const raw = localStorage.getItem(STORE);
    if (raw) {
      const v = JSON.parse(raw);
      if (v && typeof v === 'object' && !Array.isArray(v) && !isBoardSpec(v)) return v;
    }
  } catch { /* private mode, or a spec that will not parse: start from the example */ }
  return structuredClone(EXAMPLE_SPEC);
}

function persist() {
  try { localStorage.setItem(STORE, JSON.stringify(state.spec)); } catch { /* storage is a convenience */ }
}

/* ------------------------------------------------------------------- say */

/** What a print depends on: everything but the name. */
const printKey = (spec) => JSON.stringify({ ...spec, name: undefined });

function replan() {
  state.say = ops.describe(state.spec);
  if (state.grown) state.grown.stale = state.grown.printKey !== printKey(state.spec);
  if (state.shade?.kind === 'grown' && state.grown) state.shade.stale = state.grown.stale;
  validateSelection();
}

function validateSelection() {
  const s = state.selection;
  if (!s) return;
  const sp = state.spec;
  const ok = (() => {
    switch (s.type) {
      case 'channel': return !!sp.channels?.[s.index];
      case 'spine': return Array.isArray(sp.spine);
      case 'volcano': return !!sp.volcanoes?.[s.index];
      case 'flat': return !!sp.flats?.[s.index];
      case 'lake': return !!sp.lakes?.place?.[s.index];
      case 'springpoint': return !!sp.fountains?.place?.[s.index];
      case 'wood': return !!sp.canopy?.[s.index];
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
  wantEstimate();
  maybeRegrow();
}

function setSpec(next, label = 'edit', { keepJson = false } = {}) {
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
  wantEstimate();
  maybeRegrow();
  invalidate('all');
}

/* --------------------------------------------------------------- estimate */

// The ground without its ice, cut and shaded, from the second worker,
// whenever the fields the ground depends on change. It lies under the grid
// while drawing, until the module is grown.
let estimator = null;
let estimateTimer = 0;
let estimateAsked = null;
function wantEstimate() {
  const key = worldKey(state.spec);
  if (state.shade?.kind === 'grown' && !state.grown?.stale) return;
  if (state.shade?.key === key && state.shade.kind === 'estimate') return;
  if (estimateAsked === key) return;
  clearTimeout(estimateTimer);
  estimateTimer = setTimeout(() => {
    if (!workersOK) return;
    estimator = estimator || makeWorker(onEstimate);
    estimateAsked = key;
    estimator.postMessage({ type: 'estimate', spec: state.spec, key, px: 256 });
  }, 220);
}
function onEstimate(msg) {
  if (msg.type !== 'estimate') return;
  estimateAsked = null;
  if (msg.key !== worldKey(state.spec)) { wantEstimate(); return; }
  if (state.shade?.kind === 'grown' && !state.grown?.stale) return;
  state.shade = { kind: 'estimate', key: msg.key, image: toImage(msg.preview) };
  invalidate('canvas');
}

function toImage({ rgb, width, height }) {
  const img = document.createElement('canvas');
  img.width = width; img.height = height;
  img.getContext('2d').putImageData(new ImageData(toRGBA(new Uint8Array(rgb), width, height), width, height), 0, 0);
  return img;
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
  state.busy = { mode, startedAt: Date.now(), progress: [], label: mode === 'check' ? 'Checking' : 'Growing', id: ++growId, specAt: state.spec };
  builder = builder || makeWorker(onBuild);
  builder.postMessage({ type: 'run', spec: state.spec, mode, px: 512, id: state.busy.id });
  invalidate('left', 'status', 'stage');
}

function cancelGrow() {
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
    if (p.length && p[p.length - 1] === msg.message) return;
    p.push(msg.message);
    invalidate('left');
    return;
  }
  if (msg.type === 'error') {
    if (state.busy?.mode === 'build' || state.busy?.mode === 'check') state.buildFailed = { message: msg.message, key: printKey(state.busy.specAt || state.spec) };
    state.busy = null;
    say(msg.message, 'err');
    invalidate('left', 'status', 'stage');
    return;
  }
  if (msg.type === 'report') {
    const specAt = state.busy?.specAt || state.spec;
    const shownUntilHeights = state.grown?.tile3d ?? null;
    state.grown = {
      report: msg.report, files: msg.files, elapsedMS: msg.elapsedMS, mode: msg.report.mode,
      printKey: printKey(specAt), stale: false, filesGone: false, id: msg.id, spec: specAt, tile3d: shownUntilHeights,
    };
    state.buildFailed = null;
    state.shade = { kind: 'grown', key: worldKey(specAt), image: toImage(msg.preview), stale: false };
    state.busy = null;
    replan();
    const errs = msg.report.errors.length;
    say(`${msg.report.mode === 'check' ? 'Checked' : 'Grown'} in ${(msg.elapsedMS / 1000).toFixed(1)}s${errs ? ` — ${errs} error${errs > 1 ? 's' : ''}` : ''}.`, errs ? 'err' : 'ok');
    invalidate('all');
    maybeRegrow();
    return;
  }
  if (msg.type === 'heights') {
    if (!state.grown || state.grown.id !== msg.id) return;
    state.grown.tile3d = { contract: msg.contract, tile: msg.tile, at: performance.now() };
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
  const { T } = ops.dims(s);
  const meshMM = Number(s.meshMM) || 0.8;
  const cells = ((T / meshMM) + 1) ** 2;
  const cycles = mode === 'check' || s.glacier === false ? 0 : (s.glacier?.cycles ?? 30);
  return (0.2 + cells * 1.2e-5 + cycles * 0.3) * 1.15;
}

/* --------------------------------------------------------------------- 3D */

let viewer = null;
let viewerModule = null;
let viewerFailed = null;
let viewerPending = false;

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
        viewer = mod.createViewer({ canvas: el.view3d, overlay: el.overlay3d, theme: state.theme, onHover: hover3d, onPick: pick3d, onStroke: stroke3d, onPlace: place3d, onHandle: handle3d });
      } catch (e) {
        viewerFailed = { message: (e && e.message) || String(e), retry: false };
        say(`No 3D view in this browser (${viewerFailed.message}). The grown module is the hillshade under the grid.`, 'warn');
      }
    })
    .catch((e) => {
      viewerFailed = { message: (e && e.message) || String(e), retry: true };
      say(`The 3D view did not load (${viewerFailed.message}). Open Grow again to try again.`, 'warn');
    })
    .finally(() => { viewerPending = false; invalidate('canvas', 'stage', 'left'); });
}

const can3d = () => (state.stage === 'grow' || state.stage === 'refine') && !!state.grown?.tile3d && !viewerFailed;
const show3d = () => can3d() && state.prefer3d;

let toolKey = null;
function sync3d() {
  if (!viewer) { ensureViewer(); return; }
  const g = state.grown;
  if (viewer.payload() !== g.tile3d) viewer.setTile(g.tile3d);
  const vt = viewerTool();
  const k = JSON.stringify(vt);
  if (k !== toolKey) { viewer.setTool(vt); toolKey = k; }
  if (vt?.kind === 'select') viewer.setHandles(handles3d());
  viewer.setMarks(marks3d());
}

/* ----------------------------------------------------------------- refine */

const refineTool = () => REFINE_TOOLS.find((t) => t.id === state.tool.refine) || REFINE_TOOLS[0];
const rimLock = () => ops.contractOf(state.spec).rimLockMM ?? EDIT_DEFAULTS.rimLockMM;

function setRefineTool(id) {
  viewer?.cancelGesture();
  state.tool.refine = id;
  invalidate('left', 'canvas', 'stage');
}

function viewerTool() {
  if (state.stage !== 'refine') return null;
  const t = refineTool();
  if (t.brush) return { kind: 'brush', radiusMM: state.palette.brushWidth / 2, lockMM: rimLock() };
  if (t.place) return { kind: 'place' };
  return { kind: 'select' };
}

/** The things the select tool can drag in 3D, in module mm. */
function handles3d() {
  const s = state.spec;
  const { T } = ops.dims(s);
  const out = [];
  const on = (p) => Array.isArray(p) && p[0] >= 0 && p[1] >= 0 && p[0] <= T && p[1] <= T;
  (s.spine || []).forEach((p, i) => { if (on(p)) out.push({ key: `spine:${i}`, kind: 'spine', index: i, x: p[0], y: p[1] }); });
  (s.volcanoes || []).forEach((v, i) => { if (on(v.at)) out.push({ key: `volcano:${i}`, kind: 'volcano', index: i, x: v.at[0], y: v.at[1] }); });
  (s.flats || []).forEach((f, i) => { if (on(f.at)) out.push({ key: `flat:${i}`, kind: 'flat', index: i, x: f.at[0], y: f.at[1] }); });
  (s.channels || []).forEach((ch, i) => (ch.path || []).forEach((p, vi) => out.push({ key: `channel:${i}:${vi}`, kind: 'channel-vertex', index: i, vertex: vi, x: p[0], y: p[1] })));
  (s.lakes?.place || []).forEach((spot, i) => { if (on(spot.atMM)) out.push({ key: `lake:${i}`, kind: 'lake', index: i, x: spot.atMM[0], y: spot.atMM[1] }); });
  (s.fountains?.place || []).forEach((spot, i) => { if (on(spot.atMM)) out.push({ key: `springpoint:${i}`, kind: 'springpoint', index: i, x: spot.atMM[0], y: spot.atMM[1] }); });
  return out;
}

/** The selected channel's line, drawn over the ground. */
function marks3d() {
  const sel = state.selection;
  if (sel?.type !== 'channel') return [];
  const ch = state.spec.channels?.[sel.index];
  const ends = ch && ops.channelEnds(state.spec, ch);
  return ends?.pts ? [{ pts: ends.pts, color: state.theme.select }] : [];
}

/**
 * Show edits on the ground at once, on the heights as they stand, before the
 * build has replayed them: only the ground ops can be, the trees and the
 * lakes wait for the regrow.
 */
function previewOps(g, list) {
  const h = g?.tile3d?.tile;
  const opsHere = list.filter((op) => GROUND_OPS.includes(op?.op));
  if (!h || !opsHere.length) return;
  const values = Float32Array.from(h.heights);
  applyGroundEdits({ nx: h.nx, ny: h.ny, step: h.step, values }, opsHere, { rimLockMM: rimLock() });
  if (!h.grownHeights) h.grownHeights = h.heights;
  h.heights = values;
  g.previewed = true;
  viewer?.updateHeights(values);
}

function unpreview(g) {
  const h = g?.tile3d?.tile;
  if (!h || !h.grownHeights) return;
  h.heights = h.grownHeights;
  delete h.grownHeights;
  viewer?.updateHeights(h.heights);
  g.previewed = false;
}

/** New heights have landed from a build that started before the last few strokes: show those strokes on them too. */
function repreview(g) {
  const now = editsFor(state.spec);
  const then = editsFor(g.spec);
  if (now.length <= then.length || JSON.stringify(now.slice(0, then.length)) !== JSON.stringify(then)) return;
  previewOps(g, now.slice(then.length));
}

function stroke3d(pts) {
  const t = refineTool();
  if (!t.brush || !pts.length || state.stage !== 'refine') return;
  const p = state.palette;
  if (t.id === 'lake') {
    let index = -1;
    commit((s) => { index = ops.addWaterStroke(s, pts, { radiusMM: p.brushWidth / 2 }); ops.tidy(s); }, 'paint water');
    if (index < 0) { say('That stroke did not land on the module.', 'warn'); return; }
    say('Water painted. Growing again to carve it…');
    return;
  }
  let ok = false;
  commit((s) => {
    ok = ops.addStroke(s, pts, { op: t.id, radiusMM: p.brushWidth / 2, mm: p.brushMM, kind: p.plantKind, toMM: viewer?.bareAt(pts[0].x, pts[0].y) ?? pts[0].z });
    ops.tidy(s);
  }, `${t.label.toLowerCase()} by hand`);
  if (!ok) { say('That stroke only reached the locked rim, so it moves nothing.', 'warn'); return; }
  previewOps(state.grown, editsFor(state.spec).slice(-1));
  say(`${t.label} laid on. Growing again to replay it…`);
}

function place3d(hit) {
  const t = refineTool();
  if (!hit || hit.kind !== 'tile' || !t.place) return;
  let index = -1;
  commit((s) => { index = ops.addSpringPoint(s, [hit.x, hit.y]); }, 'place a spring');
  select({ type: 'springpoint', index });
}

const HANDLE_NAMES = { spine: 'ridge point', volcano: 'volcano', flat: 'flat', lake: 'lake', springpoint: 'spring', 'channel-vertex': 'channel point' };
function handle3d(hd, at, phase) {
  if (phase === 'click') { select(hd.kind === 'spine' ? { type: 'spine' } : hd.kind === 'channel-vertex' ? { type: 'channel', index: hd.index } : { type: hd.kind, index: hd.index }); return; }
  if (phase === 'cancel') { cancelLive(); maybeRegrow(); return; }
  if (at) live((s) => ops.moveFeature(s, hd.kind, hd.index, at, hd.vertex ?? null));
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
  if (key !== state.hoverKey) { state.hover = hit; state.hoverKey = key; invalidate('status'); }
  else if (hit) state.hover = hit;
  if (dragging || !hit) { el.tip.hidden = true; el.readout.textContent = ''; return; }
  if (hit.kind === 'handle') showTip({ px, py }, hit); else el.tip.hidden = true;
  el.readout.textContent = hit.kind === 'tile' ? `${hit.z.toFixed(1)} mm up  ·  x ${hit.x.toFixed(0)}  y ${hit.y.toFixed(0)} mm` : '';
}

function pick3d() {
  select(null);
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
  if (state.stage !== 'draw') return DRAW_TOOLS[0];
  return DRAW_TOOLS.find((t) => t.id === state.tool.draw) || DRAW_TOOLS[0];
}

function setTool(id) {
  if (state.gesture?.cancel) state.gesture.cancel();
  state.gesture = null;
  state.tool.draw = id;
  state.showLock = !!DRAW_TOOLS.find((t) => t.id === id)?.brush;
  invalidate('left', 'canvas');
}

const api = {
  state,
  theme: () => state.theme,
  commit, begin, live, end, cancel: cancelLive,
  select, say,
  setPalette: (p) => { Object.assign(state.palette, p); invalidate('left', 'canvas', 'stage'); },
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
  el.crumbs.replaceChildren();
  if (state.stage !== 'print') {
    const three = show3d();
    const rt = state.stage === 'refine' && three ? refineTool() : null;
    const coarse = window.matchMedia?.('(pointer: coarse)').matches;
    const text = rt && state.busy ? 'Growing again with the last change. The ground shows the stroke already; the build replays it for real.'
      : rt?.brush ? (coarse ? 'One finger paints, two fingers turn and zoom. Red is the rim: a stroke fades to nothing there.'
        : 'Left-drag paints; right-drag orbits, Shift+right-drag pans, scroll zooms. Red is the rim: a stroke fades to nothing there.')
        : rt?.place ? 'Click the ground to place it there; right-drag orbits.'
          : rt ? 'Drag a handle to move it along the ground; drag anywhere else to orbit.'
            : state.grown?.stale
              ? (three ? 'The 3D view is from before the last change. Grow again to see the new ground.' : 'The hillshade is from before the last change. Grow again to see the new ground.')
              : three ? (coarse ? 'Drag to orbit, two fingers to pan and zoom.' : 'Drag to orbit, right-drag to pan, scroll to zoom. Double-click to frame the module.')
                : state.stage === 'grow' && !state.grown && !state.busy ? 'Nothing grown yet. Grow stands the module up here in 3D.'
                  : state.stage === 'draw' ? 'Module millimetres, north up. The faint square round it is the margin: ground the ice comes down from, grown but not printed.'
                    : null;
    if (text) {
      const s = document.createElement('span');
      s.className = 'hint';
      s.textContent = text;
      el.crumbs.append(s);
    }
  }
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
  const cam = makeCamera({ width: w, height: h, box: tileBox(state.spec), zoom: v.zoom, panX: v.panX, panY: v.panY });
  state.cam = cam;
  const tool = currentTool();
  const st = { ...state, tool: tool.id };
  state.frame = drawTile(ctx, st, cam, state.theme);
  if (state.gesture?.preview) drawPreview(ctx, state.gesture.preview, cam, state.theme);
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

function toolButtons(list, groups, current, pick) {
  const out = [];
  for (const [title, ids] of groups) {
    out.push(h('div', { class: 'tool-sub' }, title));
    out.push(h('div', { class: 'toolgrid' }, ids.map((id) => list.find((t) => t.id === id)).filter(Boolean).map((t) => h('button', {
      type: 'button', class: 'tool', 'aria-pressed': String(t.id === current.id), title: `${t.label} (${t.key})`, onclick: () => pick(t.id), 'data-tool': t.id,
    }, h('span', { class: 'glyph', 'aria-hidden': 'true' }, t.glyph), t.label, h('span', { class: 'key' }, t.key)))));
  }
  const pal = (current.palette ? current.palette(api) : []);
  out.push(h('div', { class: 'group palette' },
    h('h2', { class: 'panel-title' }, current.label),
    h('p', { class: 'hint' }, current.hint),
    pal.map((p) => [
      p.chips ? h('div', { class: 'chips', role: 'group', 'aria-label': `${current.label} options` }, p.chips.map(([v, t]) => h('button', {
        type: 'button', 'aria-pressed': String(String(v) === String(p.value)), onclick: () => p.pick(v), 'data-chip': String(v),
      }, t))) : null,
      p.note ? h('p', { class: 'hint' }, p.note) : null,
    ])));
  return out;
}

function drawLeft() {
  const tool = currentTool();
  return [h('h2', { class: 'panel-title' }, 'Tools'), ...toolButtons(DRAW_TOOLS, DRAW_GROUPS, tool, setTool)];
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
    h('p', { class: 'hint' }, 'Runs the generator on the spec: the ground, the ice carving it and melting away, the module cut out, its channels cut, its water, its woods, and the mesh. It runs in a worker, so the page stays live.'),
    h('div', { class: 'group' },
      h('div', { class: 'tool-sub' }, 'Mesh'),
      h('div', { class: 'chips' }, MESHES.map(([v, t]) => h('button', { type: 'button', 'aria-pressed': String(mesh === v), disabled: !!b, onclick: () => commit((x) => { x.meshMM = Number(v); }, 'mesh') }, t)),
        MESHES.some(([v]) => v === mesh) ? null : h('button', { type: 'button', 'aria-pressed': 'true' }, `${mesh} mm`)),
      h('p', { class: 'hint' }, 'Start on draft: the contract, the ports and the keys are identical at 2.5 mm, and it comes back sooner.'),
      h('p', { class: 'hint' }, est < 2 ? 'About a second.' : est < 90 ? `Roughly ${Math.round(est)} s at this mesh.` : `Roughly ${Math.round(est / 60)} min at this mesh.`)),
    h('div', { class: 'group row-btns', style: 'display:flex;gap:6px;flex-wrap:wrap' },
      h('button', { type: 'button', class: 'primary', disabled: !!b || !workersOK, onclick: () => grow('build'), id: 'grow-go' }, 'Grow'),
      h('button', { type: 'button', disabled: !!b || !workersOK, onclick: () => grow('check'), title: 'The contract and the channels, without the ice' }, 'Check'),
      b ? h('button', { type: 'button', class: 'danger', onclick: cancelGrow }, 'Cancel') : null),
    b ? h('div', { class: 'group' }, h('p', { class: 'busy' }, `${b.label} — ${((Date.now() - b.startedAt) / 1000).toFixed(1)} s`),
      h('ol', { class: 'progress' }, b.progress.map((m, i) => h('li', { class: i === b.progress.length - 1 ? 'now' : null }, m)))) : null,
    g && !b ? h('div', { class: 'group' },
      h('h2', { class: 'panel-title' }, g.mode === 'check' ? 'Last check' : 'Last grown'),
      h('ul', { class: 'facts' }, [
        ['Time', `${(g.elapsedMS / 1000).toFixed(1)} s`],
        ['Triangles', fmt(g.report.totals.triangles)],
        ['Worst edge error', `${fmt(g.report.worstEdgeMM, 4)} mm`],
        ['Closed solid', g.report.totals.watertight ? 'yes' : 'NO'],
        g.report.glacier ? ['Ice left', `${fmt(g.report.glacier.finalIceM, 1)} m`] : null,
      ].filter(Boolean).map(([k, v]) => h('li', {}, h('span', {}, k), h('span', {}, v)))),
      g.stale ? h('p', { class: 'warn-line' }, 'The spec has changed since. Grow again to see it.') : null,
      h('button', { type: 'button', onclick: () => setStage('print') }, 'Report and files →')) : null,
    g && !b ? h('p', { class: 'hint' }, viewerFailed && !viewerFailed.retry
      ? 'This browser could not start WebGL, so there is no 3D view: the hillshade lies under the grid instead.'
      : viewerFailed ? 'The 3D view did not load, so the hillshade lies under the grid for now. Open Grow again to try again.'
        : 'In the middle, in 3D: the module as it will print, with the water in its channels and lakes.') : null,
  ];
}

function refineLeft() {
  const g = state.grown;
  const b = state.busy;
  const out = [h('h2', { class: 'panel-title' }, 'Refine')];
  if (!g) {
    out.push(
      h('p', { class: 'hint' }, 'The brushes work on the grown ground, in 3D. Grow the module first.'),
      h('div', { class: 'group' }, h('button', { type: 'button', class: 'primary', disabled: !!b || !workersOK, onclick: () => grow('build') }, 'Grow it')),
      b ? h('p', { class: 'busy' }, `${b.label} — ${((Date.now() - b.startedAt) / 1000).toFixed(1)} s`) : null,
    );
    return out;
  }
  const tool = refineTool();
  out.push(...toolButtons(REFINE_TOOLS, REFINE_GROUPS, tool, setRefineTool));
  const again = estimateSeconds({ ...state.spec, glacier: false }, 'build');
  const n = editsFor(state.spec).length;
  out.push(h('div', { class: 'group' },
    b ? [h('p', { class: 'busy' }, `${b.label} — ${((Date.now() - b.startedAt) / 1000).toFixed(1)} s`),
      h('ol', { class: 'progress' }, b.progress.map((m, i) => h('li', { class: i === b.progress.length - 1 ? 'now' : null }, m)))]
      : failedHere() ? [h('p', { class: 'err-line' }, `The last build failed: ${state.buildFailed.message}`), h('button', { type: 'button', onclick: () => grow('build') }, 'Try again')]
        : h('p', { class: g.stale ? 'warn-line' : 'hint' }, g.stale ? 'Growing again with the last change…' : `Grown with ${n ? `all ${n} edit${n > 1 ? 's' : ''}` : 'no edits yet'}.`),
    h('p', { class: 'hint' }, `Every change here grows the module again, keeping the ground and the ice from last time: ${again < 2 ? 'about a second' : `about ${Math.round(again)} s`} at this mesh.`),
    h('p', { class: 'hint' }, 'Edits are kept as strokes, not as the ground they changed, so a new seed or a new climate keeps every one. They are listed in the inspector.')));
  return out;
}

function printLeft() {
  const g = state.grown;
  if (!g) return [h('h2', { class: 'panel-title' }, 'Print'), h('p', { class: 'hint' }, 'Nothing grown yet.'), h('button', { type: 'button', class: 'primary', onclick: () => setStage('grow') }, 'Grow it')];
  const t = g.report.totals;
  return [
    h('h2', { class: 'panel-title' }, 'Print'),
    h('ul', { class: 'facts' }, [
      ['Prints', `${fmt(t.printsMM, 1)} mm tall`],
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
    el.sheet.innerHTML = '<div class="wrap"><div class="card empty"><p>Nothing grown yet. Grow the module, then come back for the report and the files.</p></div></div>';
    return;
  }
  const files = g.filesGone ? '<p class="hint">The files went with the cancelled worker. Grow again to get them back.</p>' : downloadsHTML(g.report, g.files);
  el.sheet.innerHTML = `<div class="wrap">${g.stale ? '<p class="banner err">The spec has changed since this was grown, so this is the old module. Grow again for the new one.</p>' : ''}`
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

function renderStatus() {
  const parts = [];
  const msg = state.message && Date.now() - state.message.at < 6000 ? state.message : null;
  if (state.busy) parts.push({ kind: 'busy', text: `${state.busy.label}…` });
  if (msg) parts.push({ kind: msg.kind, text: msg.text });
  for (const x of state.say?.sentences || []) parts.push(x);
  el.say.replaceChildren(...parts.map((x) => {
    const s = document.createElement('span');
    s.className = `s ${x.kind}`;
    if (x.kind === 'err') s.style.color = 'var(--err)';
    if (x.kind === 'warn') s.style.color = 'var(--warn)';
    s.textContent = x.text;
    return s;
  }));
  const notes = state.say?.notes || [];
  el.notes.textContent = notes.length ? notes.map((n) => n.message).join(' ') : '';
  if (msg && !msg.timer) msg.timer = setTimeout(() => invalidate('status'), 6100);
}

/* ------------------------------------------------------------------ JSON */

function renderJSON() {
  if (el.drawer.hidden) return;
  if (document.activeElement === el.spec) return;
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
      if (isBoardSpec(v)) throw new Error(BOARD_SPEC_MESSAGE);
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
  const handle = tool.id === 'select' ? hitHandle(state.frame?.handles || [], px, py) : null;
  const hit = cam ? hitTile(state, cam, px, py) : { kind: 'empty', inside: false };
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
  const hov = e.handle ? { kind: 'handle', h: e.handle } : e.hit;
  const key = JSON.stringify([hov?.kind, hov?.port, hov?.h?.kind, hov?.h?.index, hov?.h?.vertex]);
  if (key !== state.hoverKey) {
    state.hover = hov;
    state.hoverKey = key;
    invalidate('canvas');
  }
  showTip(e, hov);
  el.readout.textContent = `x ${e.pt.x.toFixed(0)}  y ${e.pt.y.toFixed(0)} mm${e.hit.kind === 'margin' ? '  (margin)' : ''}`;
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
  if (state.hover) { state.hover = null; state.hoverKey = null; invalidate('canvas'); }
});
el.canvas.addEventListener('contextmenu', (ev) => ev.preventDefault());
el.canvas.addEventListener('dblclick', () => {
  const g = state.gesture;
  if (g?.sticky && g.finish) g.finish();
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
  state.view = { zoom: 1, panX: 0, panY: 0 };
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

const HANDLE_TIPS = { spine: 'Ridge point', volcano: 'Volcano', 'volcano-rim': 'Foot of the cone', flat: 'Flat', 'flat-rim': 'Edge of the flat', lake: 'Lake', springpoint: 'Spring', 'wood-vertex': 'Edge of the wood', wood: 'Wood', channel: 'Channel', 'channel-vertex': 'Channel point' };
function showTip(e, hov) {
  let text = null;
  if (hov?.kind === 'handle') text = `${HANDLE_TIPS[hov.h.kind] || hov.h.kind} — drag to move`;
  else if (hov?.kind === 'tile' && hov.port && currentTool().id === 'channel') text = `Port ${hov.port}: a channel ending here crosses the rim`;
  if (!text || state.gesture) { el.tip.hidden = true; return; }
  el.tip.textContent = text;
  el.tip.hidden = false;
  const W = el.host.clientWidth;
  const x = Math.min(e.px + 16, W - el.tip.offsetWidth - 8);
  el.tip.style.left = `${Math.max(8, x)}px`;
  el.tip.style.top = `${Math.max(8, e.py + 18)}px`;
}

/* -------------------------------------------------------------- keyboard */

function deleteSelection() {
  const s = state.selection;
  if (!s) return;
  switch (s.type) {
    case 'channel': commit((x) => ops.removeChannel(x, s.index), 'delete a channel'); break;
    case 'spine': commit((x) => { delete x.spine; }, 'delete the ridge'); break;
    case 'volcano': commit((x) => { x.volcanoes.splice(s.index, 1); ops.tidy(x); }, 'delete a volcano'); break;
    case 'flat': commit((x) => { x.flats.splice(s.index, 1); ops.tidy(x); }, 'delete a flat'); break;
    case 'lake': commit((x) => { x.lakes.place.splice(s.index, 1); ops.tidy(x); }, 'delete a lake'); break;
    case 'springpoint': commit((x) => { x.fountains.place.splice(s.index, 1); ops.tidy(x); }, 'delete a spring'); break;
    case 'wood': commit((x) => { x.canopy.splice(s.index, 1); ops.tidy(x); }, 'delete a wood'); break;
    default: return;
  }
  select(null);
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
    select(null);
    return;
  }
  if (ev.key === 'Enter' && state.gesture?.finish) { state.gesture.finish(); return; }
  if (ev.key === 'Delete' || ev.key === 'Backspace') { if (state.stage === 'draw' || state.stage === 'refine') { ev.preventDefault(); deleteSelection(); } return; }
  if (ev.key === '0') { zoomFit(); return; }
  if (ev.key === '+' || ev.key === '=') { zoomBy(1.25); return; }
  if (ev.key === '-') { zoomBy(0.8); return; }
  if (state.stage === 'refine') {
    const t = REFINE_TOOLS.find((x) => x.key.toLowerCase() === ev.key.toLowerCase());
    if (t) setRefineTool(t.id);
    return;
  }
  if (state.stage !== 'draw') return;
  const t = DRAW_TOOLS.find((x) => x.key.toLowerCase() === ev.key.toLowerCase());
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
  state.selection = null;
  setSpec(ops.blankSpec(), 'new module');
  say('A new module: plain ground. Draw a ridge, and a channel across it.');
});
$('example').addEventListener('click', () => {
  state.selection = null;
  setSpec(structuredClone(EXAMPLE_SPEC), 'load the example');
});
$('save').addEventListener('click', () => {
  const name = (state.spec.name || 'module').replace(/[^\w.-]+/g, '-');
  saveBlob(new Blob([`${ops.formatSpec(state.spec)}\n`], { type: 'application/json' }), `${name}.json`);
});
$('open').addEventListener('click', () => el.openFile.click());
el.openFile.addEventListener('change', async () => {
  const f = el.openFile.files?.[0];
  if (!f) return;
  try {
    const v = JSON.parse(await f.text());
    if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('not a spec');
    if (isBoardSpec(v)) throw new Error(BOARD_SPEC_MESSAGE);
    state.selection = null;
    setSpec(v, `open ${f.name}`);
    say(`Opened ${f.name}.`, 'ok');
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
  el.unsupported.textContent = 'This browser does not support ES-module web workers, which is how the editor grows a module without freezing. Drawing works; growing needs a current Chrome, Edge, Firefox or Safari.';
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
wantEstimate();
invalidate('all');

// For the browser test and for poking at it from the console.
window.mmb = { state, api, ops, undo, redo, grow, setStage, setTool, setRefineTool, viewer: () => viewer, show3d };
