// main.js — the editor. One state object, one render, and the spec as the
// document: every tool writes it, the board is planned again from it on every
// change, and everything on screen is drawn from that plan.
//
// Four stages over one spec: Draw it on the board and in a tile; Grow it
// (the generator, in a worker); Refine it (phase 3); Print it. Nothing leaves
// the machine.

import { EXAMPLE_SPEC } from '../lib/example.js';
import { plan as planBoard, worldKey } from '../lib/board.js';
import { toRGBA } from '../lib/shade.js';
import * as ops from './specops.js';
import { readTheme, makeCamera, zoomAbout } from './view.js';
import { boardBox, drawBoard, hitBoard } from './board.js';
import { tileBox, drawTileView, drawPreview } from './tilecanvas.js';
import { handles, hitHandle } from './features.js';
import { BOARD_TOOLS, TILE_TOOLS, BOARD_GROUPS, TILE_GROUPS } from './tools.js';
import { renderInspector } from './inspector.js';
import { reportHTML, downloadsHTML, fmt, bytes, esc } from './report.js';

const $ = (id) => document.getElementById(id);
const el = {
  app: $('app'), left: $('left'), inspector: $('inspector'), canvas: $('canvas'), host: $('canvas-host'),
  crumbs: $('crumbs'), tip: $('tip'), readout: $('readout'), sheet: $('sheet'),
  counts: $('counts'), say: $('say'), rims: $('rims'), sayAll: $('say-all'), sentences: $('sentences'),
  jsonToggle: $('json-toggle'), drawer: $('drawer'), spec: $('spec'), jsonErr: $('json-err'), jsonChanged: $('json-changed'),
  name: $('map-name'), unsupported: $('unsupported'), openFile: $('open-file'),
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
  tool: { board: 'select', tile: 'select' },
  palette: { riverSize: 'creek', fall: 10, riser: 'auto', woodKind: 'deciduous' },
  selection: null,
  hover: null,
  gesture: null,
  world: null,
  grown: null,
  busy: null,
  history: [],
  hIndex: -1,
  frame: null,
  cam: null,
  theme: readTheme(),
  message: null,
  lastChanged: [],
};

function loadSpec() {
  try {
    const raw = localStorage.getItem(STORE);
    if (raw) {
      const v = JSON.parse(raw);
      if (v && typeof v === 'object' && !Array.isArray(v)) return v;
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
  wantWorld();
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
  invalidate('left', 'status');
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
    state.busy = null;
    say(msg.message, 'err');
    invalidate('left', 'status');
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
    state.grown = {
      image: img, cells, report: msg.report, files: msg.files, elapsedMS: msg.elapsedMS, mode: msg.report.mode,
      printKey: printKey(specAt), stale: false, filesGone: false,
    };
    if (msg.report.mode !== 'check') state.world = { field: msg.world, key: worldKey(specAt), iceKey: msg.worldKey, source: 'grown' };
    state.busy = null;
    replan();
    const errs = msg.report.errors.length;
    say(`${msg.report.mode === 'check' ? 'Checked' : 'Grown'} in ${(msg.elapsedMS / 1000).toFixed(1)}s${errs ? ` — ${errs} error${errs > 1 ? 's' : ''} in the contract` : ''}.`, errs ? 'err' : 'ok');
    invalidate('all');
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
  } else if (state.grown?.stale && state.stage !== 'print') {
    const s = document.createElement('span');
    s.className = 'hint';
    s.textContent = 'The hillshade is from before the last change. Grow again to see the new ground.';
    el.crumbs.append(s);
  }
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
  if (state.stage === 'print') return;
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
    h('p', { class: 'hint' }, 'Phase 2 puts the grown map in 3D. Until then the hillshade lies under the board, each tile turned the way it sits.'),
  ];
}

function refineLeft() {
  return [
    h('h2', { class: 'panel-title' }, 'Refine'),
    h('p', {}, 'Brushes and handles on the grown ground arrive in phase 3: raise, lower, smooth, flatten to a height, dig a lake, place a spring, plant or clear trees.'),
    h('p', { class: 'hint' }, 'They will write an `edits` list into the spec, replayed after the river is carved and before the lakes, with the last 12 mm of the rim locked so every tile still proves its contract.'),
    h('p', { class: 'hint' }, 'Until then, draw in Draw and grow in Grow: the spec is the same either way.'),
    h('button', { type: 'button', onclick: () => setStage('draw') }, '← Draw'),
  ];
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
  if (!state.cam) return;
  const z = Math.max(0.3, Math.min(14, state.view.zoom * f));
  state.view = zoomAbout(state.cam, state.cam.width / 2, state.cam.height / 2, z, state.view);
  invalidate('canvas');
}
$('zoom-in').addEventListener('click', () => zoomBy(1.25));
$('zoom-out').addEventListener('click', () => zoomBy(0.8));
$('zoom-fit').addEventListener('click', () => { state.view = { ...state.view, zoom: 1, panX: 0, panY: 0 }; invalidate('canvas'); });

function showTip(e, hov) {
  let text = null;
  const p = state.plan;
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
    if (state.gesture?.cancel) { state.gesture.cancel(); state.gesture = null; invalidate('canvas'); return; }
    if (!el.sentences.hidden) { el.sentences.hidden = true; return; }
    if (state.view.mode === 'tile') { closeTile(); return; }
    select(null);
    return;
  }
  if (ev.key === 'Enter' && state.gesture?.finish) { state.gesture.finish(); return; }
  if (ev.key === 'Delete' || ev.key === 'Backspace') { if (state.stage === 'draw') { ev.preventDefault(); deleteSelection(); } return; }
  if (ev.key === '0') { state.view = { ...state.view, zoom: 1, panX: 0, panY: 0 }; invalidate('canvas'); return; }
  if (ev.key === '+' || ev.key === '=') { zoomBy(1.25); return; }
  if (ev.key === '-') { zoomBy(0.8); return; }
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
  el.unsupported.textContent = 'This browser does not support ES-module web workers, which is how the editor grows a map without freezing. Drawing works; growing needs a current Chrome, Edge, Firefox or Safari.';
  el.unsupported.hidden = false;
}
if (location.protocol === 'file:') {
  el.unsupported.textContent = 'Opened from the filesystem, so the browser will refuse the ES modules this page is made of. Serve the repository over HTTP instead: python3 -m http.server from its root, then open /app/.';
  el.unsupported.hidden = false;
}

window.matchMedia?.('(prefers-color-scheme: dark)').addEventListener?.('change', () => { state.theme = readTheme(); invalidate('canvas'); });
new ResizeObserver(() => invalidate('canvas')).observe(el.host);
setInterval(() => { if (state.busy) invalidate('left'); }, 250);

state.spec = loadSpec();
replan();
state.history = [JSON.stringify(state.spec)];
state.hIndex = 0;
wantWorld();
invalidate('all');

// For the browser test and for poking at it from the console.
window.mmb = { state, api, ops, undo, redo, grow, setStage, openTile, closeTile, setTool };
