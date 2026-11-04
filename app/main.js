// main.js — the UI. Everything slow happens in worker.js; this file edits a
// spec, draws a picture and hands out files.

import { EXAMPLE_SPEC } from '../lib/example.js';
import { toRGBA } from '../lib/shade.js';

const $ = (id) => document.getElementById(id);
const el = {
  spec: $('spec'), jsonErr: $('json-err'), status: $('status'), est: $('est'),
  check: $('check'), build: $('build'), cancel: $('cancel'),
  loadExample: $('load-example'), format: $('format'), copySpec: $('copy-spec'),
  canvas: $('canvas'), previewPanel: $('preview-panel'), previewHint: $('preview-hint'),
  reportPanel: $('report-panel'), report: $('report'),
  dlPanel: $('dl-panel'), downloads: $('downloads'), dlNote: $('dl-note'),
  dlPng: $('dl-png'), unsupported: $('unsupported'), specDetails: $('spec-details'),
  q: {
    seed: $('q-seed'), cols: $('q-cols'), rows: $('q-rows'), relief: $('q-relief'),
    quality: $('q-quality'), custom: $('q-quality-custom'), glacier: $('q-glacier'), dice: $('q-dice'),
  },
};

const fmt = (n, d = 0) => (n == null || !Number.isFinite(n) ? '—' : n.toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d }));
const bytes = (n) => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(0)} kB` : `${(n / 1048576).toFixed(1)} MB`);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/* ------------------------------------------------------------ capability */

// The classic getter probe: the `type` option is only read by engines that
// understand worker options at all.
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

if (!moduleWorkersWork()) {
  el.unsupported.textContent =
    'This browser does not support ES-module web workers, which is how the builder keeps '
    + 'the page responsive during a build. Try a current Chrome, Edge, Firefox or Safari.';
  el.unsupported.hidden = false;
  for (const b of [el.check, el.build]) b.disabled = true;
}

if (location.protocol === 'file:') {
  el.unsupported.textContent =
    'Opened from the filesystem, so the browser will refuse to load the ES modules this '
    + 'page is made of. Serve the directory over HTTP instead — from the repository root: '
    + 'python3 -m http.server, then open /app/.';
  el.unsupported.hidden = false;
}

/* ------------------------------------------------------------- spec state */

let spec = structuredClone(EXAMPLE_SPEC);

function writeTextarea() {
  el.spec.value = JSON.stringify(spec, null, 2);
}

/** Parse the textarea. Returns null and shows why if it will not parse. */
function readTextarea() {
  try {
    const v = JSON.parse(el.spec.value);
    if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('the spec has to be a JSON object');
    el.jsonErr.hidden = true;
    return v;
  } catch (e) {
    el.jsonErr.textContent = e.message;
    el.jsonErr.hidden = false;
    return null;
  }
}

const QUALITIES = ['2.5', '0.9', '0.6'];

function syncControlsFromSpec() {
  el.q.seed.value = spec.seed ?? 1;
  el.q.cols.value = spec.cols ?? 3;
  el.q.rows.value = spec.rows ?? 3;
  el.q.relief.value = spec.reliefMM ?? 40;
  el.q.glacier.checked = spec.glacier !== false;
  const mesh = String(spec.meshMM ?? 0.8);
  if (QUALITIES.includes(mesh)) {
    el.q.custom.hidden = true;
    el.q.quality.value = mesh;
  } else {
    el.q.custom.hidden = false;
    el.q.custom.textContent = `Custom — ${mesh} mm`;
    el.q.quality.value = '';
  }
  showEstimate();
}

/** A rough fit over measured runs; the status line reports the real time. */
function estimateSeconds(s, mode) {
  const cols = Number(s.cols) || 3;
  const rows = Number(s.rows) || 3;
  const tileMM = s.contract?.tileMM ?? 200;
  const meshMM = Number(s.meshMM) || 0.8;
  const cells = cols * rows * ((tileMM / meshMM) + 1) ** 2;
  const cycles = mode === 'check' || s.glacier === false ? 0 : (s.glacier?.cycles ?? 30);
  // Fitted against measured runs, plus a little headroom. Chromium's V8 and
  // node's are the same engine, so there is no browser penalty to speak of.
  return (0.2 + cells * 1.57e-5 + cycles * 0.25) * 1.15;
}

function showEstimate() {
  const s = readTextarea() || spec;
  const b = estimateSeconds(s, 'build');
  el.est.textContent = b < 2 ? 'about a second' : b < 90 ? `roughly ${Math.round(b)}s to build` : `roughly ${Math.round(b / 60)} min to build`;
}

/** Quick control -> spec -> textarea, so the JSON stays the single source. */
function patch(fn) {
  const parsed = readTextarea();
  if (!parsed) return;
  spec = parsed;
  fn(spec);
  writeTextarea();
  syncControlsFromSpec();
}

const int = (input, lo, hi, dflt) => {
  const v = Math.round(Number(input.value));
  return Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : dflt;
};

el.q.seed.addEventListener('change', () => patch((s) => { s.seed = int(el.q.seed, 0, 2 ** 31, 1); }));
el.q.cols.addEventListener('change', () => patch((s) => { s.cols = int(el.q.cols, 1, 8, 3); }));
el.q.rows.addEventListener('change', () => patch((s) => { s.rows = int(el.q.rows, 1, 8, 3); }));
el.q.relief.addEventListener('change', () => patch((s) => { s.reliefMM = int(el.q.relief, 5, 200, 40); }));
el.q.dice.addEventListener('click', () => patch((s) => { s.seed = Math.floor(Math.random() * 100000); }));
el.q.quality.addEventListener('change', () => {
  if (!el.q.quality.value) return; // the Custom placeholder
  patch((s) => { s.meshMM = Number(el.q.quality.value); });
});
el.q.glacier.addEventListener('change', () => patch((s) => {
  if (el.q.glacier.checked) {
    // Put back a real cycle count rather than `true`, which buildWorld reads
    // as an empty options object.
    s.glacier = s.glacier && typeof s.glacier === 'object' ? s.glacier : { cycles: 30 };
  } else {
    s.glacier = false;
  }
}));

el.spec.addEventListener('input', () => {
  const parsed = readTextarea();
  if (parsed) { spec = parsed; syncControlsFromSpec(); }
});
el.loadExample.addEventListener('click', () => {
  spec = structuredClone(EXAMPLE_SPEC);
  writeTextarea();
  syncControlsFromSpec();
});
el.format.addEventListener('click', () => patch(() => {}));
el.copySpec.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(el.spec.value);
    el.copySpec.textContent = 'Copied';
    setTimeout(() => { el.copySpec.textContent = 'Copy'; }, 1400);
  } catch {
    el.spec.select();
  }
});

/* ---------------------------------------------------------------- running */

let worker = null;
let busy = false;
let startedAt = 0;
let ticker = null;
let lastFiles = [];

function makeWorker() {
  const w = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
  w.onmessage = (ev) => onWorkerMessage(ev.data);
  w.onerror = (ev) => {
    // A module worker that cannot even be parsed reports here.
    finish();
    say(`Worker failed: ${ev.message || 'could not start'}`, true);
  };
  return w;
}

function say(msg, isError = false) {
  el.status.textContent = msg;
  el.status.classList.toggle('busy', busy);
  el.status.style.color = isError ? 'var(--err)' : '';
}

function setBusy(on, what = '') {
  busy = on;
  el.check.disabled = on;
  el.build.disabled = on;
  el.cancel.hidden = !on;
  el.spec.readOnly = on;
  for (const k of ['seed', 'cols', 'rows', 'relief', 'quality', 'glacier', 'dice']) el.q[k].disabled = on;
  if (on) {
    startedAt = Date.now();
    ticker = setInterval(() => {
      const s = ((Date.now() - startedAt) / 1000).toFixed(1);
      el.status.textContent = `${what} — ${s}s`;
    }, 100);
  }
  el.status.classList.toggle('busy', on);
}

function finish() {
  setBusy(false);
  if (ticker) { clearInterval(ticker); ticker = null; }
}

let progressLabel = '';

function run(mode) {
  const parsed = readTextarea();
  if (!parsed) { el.specDetails.open = true; return; }
  spec = parsed;
  if (!worker) worker = makeWorker();
  progressLabel = mode === 'check' ? 'Checking' : 'Building';
  setBusy(true, progressLabel);
  // Enough pixels to see a 200 mm tile's channels, capped so a 6x6 map does
  // not allocate a 50-megapixel buffer.
  const cols = Number(spec.cols) || 3;
  const rows = Number(spec.rows) || 3;
  const pxPerTile = Math.max(90, Math.min(220, Math.floor(1400 / Math.max(cols, rows))));
  worker.postMessage({ type: 'run', spec, mode, pxPerTile });
}

el.check.addEventListener('click', () => run('check'));
el.build.addEventListener('click', () => run('build'));
el.cancel.addEventListener('click', () => {
  // buildMap is one long synchronous call; terminating is the only way out.
  if (worker) { worker.terminate(); worker = null; }
  finish();
  say('Cancelled.');
});

function onWorkerMessage(msg) {
  if (msg.type === 'progress') {
    progressLabel = `${msg.message}`;
    return;
  }
  if (msg.type === 'error') {
    finish();
    say(msg.message, true);
    el.specDetails.open = true;
    return;
  }
  if (msg.type === 'report') {
    finish();
    lastFiles = msg.files;
    drawPreview(msg.preview);
    renderReport(msg.report, msg.elapsedMS);
    renderDownloads(msg.report, msg.files);
    const secs = (msg.elapsedMS / 1000).toFixed(1);
    const errs = msg.report.errors.length;
    say(errs
      ? `${msg.report.mode === 'check' ? 'Checked' : 'Built'} in ${secs}s — ${errs} error${errs > 1 ? 's' : ''} in the contract.`
      : `${msg.report.mode === 'check' ? 'Checked' : 'Built'} in ${secs}s.`);
    return;
  }
  if (msg.type === 'file') {
    saveBlob(new Blob([msg.bytes], { type: 'model/stl' }), msg.name);
    finish();
    say(`${msg.name} — ${bytes(msg.bytes.byteLength)}`);
    return;
  }
  if (msg.type === 'zip') {
    saveBlob(msg.blob, msg.name);
    finish();
    say(`${msg.name} — ${bytes(msg.blob.size)}`);
  }
}

// The progress ticker owns the status line, so progress messages land here.
setInterval(() => {
  if (busy && progressLabel) {
    const s = ((Date.now() - startedAt) / 1000).toFixed(1);
    el.status.textContent = `${progressLabel} — ${s}s`;
  }
}, 120);

/* ---------------------------------------------------------------- preview */

function drawPreview({ rgb, width, height }) {
  const cv = el.canvas;
  cv.width = width;
  cv.height = height;
  const ctx = cv.getContext('2d');
  ctx.putImageData(new ImageData(toRGBA(new Uint8Array(rgb), width, height), width, height), 0, 0);
  el.previewHint.textContent = `${width} × ${height}`;
  el.previewPanel.hidden = false;
}

el.dlPng.addEventListener('click', () => {
  el.canvas.toBlob((b) => { if (b) saveBlob(b, 'preview.png'); }, 'image/png');
});

/* ----------------------------------------------------------------- report */

function msgList(items, kind) {
  if (!items.length) return '';
  const label = { error: 'error', warning: 'warning', note: 'note' }[kind];
  return `<ul class="msgs">${items.map((m) => `<li class="${kind}"><b>${label}</b> — ${esc(m)}</li>`).join('')}</ul>`;
}

function renderReport(r, elapsedMS) {
  const c = r.contract;
  const t = r.totals;
  const out = [];

  out.push(`<p class="line">${c.tileMM} mm tiles on ${c.plateMM} mm plates, outlet at ${c.outletZMM} mm, `
    + `inlet at ${c.inletZMM} mm, falls ${c.falls.join('/')} mm, seam ${esc(c.seamStyle)}. `
    + `${r.grid.cols}×${r.grid.rows} = ${r.tiles.length} tiles in ${(elapsedMS / 1000).toFixed(1)}s`
    + `${r.mode === 'check' ? ', glacier off' : ''}.</p>`);

  out.push(msgList(r.contractNotes.filter((n) => n.severity === 'error').map((n) => n.message), 'error'));
  out.push(msgList(r.errors, 'error'));
  out.push(msgList(r.contractNotes.filter((n) => n.severity !== 'error').map((n) => n.message), 'warning'));
  out.push(msgList(r.warnings, 'warning'));
  out.push(msgList(r.notes, 'note'));

  /* tiles */
  out.push('<h3>Tiles</h3><div class="scroll"><table><thead><tr>'
    + '<th>Tile</th><th>Plates</th><th>Stand</th><th>Fall</th><th>Ports</th><th>Trees</th>'
    + '<th>Epoxy</th><th>Prints</th><th>Edge err</th><th>Mesh</th></tr></thead><tbody>'
    + r.tiles.map((x) => {
      const ports = x.ports.length
        ? x.ports.map((p) => `${p.edge}:${p.dir === 'in' ? '&gt;' : '&lt;'}${p.widthMM}`).join(' ')
        : '—';
      return `<tr><td><b>${esc(x.label)}</b></td>`
        + `<td>${x.plates}</td><td>${fmt(x.standMM)} mm</td><td>${x.fallMM} mm</td>`
        + `<td class="ports">${ports}</td><td>${fmt(x.trees)}</td>`
        + `<td>${x.millilitres ? `${fmt(x.millilitres, 1)} ml` : '—'}</td>`
        + `<td>${fmt(x.printsMM, 1)} mm</td>`
        + `<td class="mono">${fmt(x.edgeWorstMM, 4)}</td>`
        + `<td class="${x.watertight ? 'good' : 'bad'}">${x.watertight ? 'closed' : 'LEAKS'}</td></tr>`;
    }).join('')
    + '</tbody></table></div>');

  /* seams */
  const kinds = Object.entries(r.seams.kinds).map(([k, v]) => `${v} ${k}`).join(', ');
  out.push(`<h3>Seams</h3><p class="line">${esc(kinds) || 'none'}.</p>`);
  if (r.seams.notFlat.length) {
    out.push('<div class="scroll"><table><thead><tr><th>Seam</th><th>Edge</th><th>Kind</th><th>Step</th></tr></thead><tbody>'
      + r.seams.notFlat.map((s) => {
        const step = s.waterStepMM != null && Math.abs(s.waterStepMM) > 1e-6
          ? `${fmt(Math.abs(s.waterStepMM), 0)} mm of water`
          : `${fmt(Math.abs(s.landStepMM), 0)} mm of land`;
        return `<tr><td><b>${esc(s.from)}</b> → ${esc(s.to)}</td><td>${s.edge}</td>`
          + `<td>${esc(s.kind.toUpperCase())}</td><td>${step}</td></tr>`;
      }).join('') + '</tbody></table></div>');
  }

  /* keys */
  if (r.keys.planned) {
    const k = r.keys;
    out.push('<h3>Seam keys</h3>'
      + `<p class="line">${k.planned} planned, ${k.placed} of ${k.halves} recesses cut, `
      + `<b>${k.usable} will actually hold — print that many</b>. `
      + `${k.joint.padMM} mm pad on a ${k.joint.neckMM} mm neck, ${k.joint.depthMM} mm deep, `
      + `${k.joint.clearanceMM} mm slip fit, not glued.</p>`);
    const why = Object.entries(k.refusedByWhy);
    if (why.length) out.push(msgList(why.map(([w, n]) => `${n} half-recess(es) left out: ${w}`), 'note'));
    if (r.seams.stepped.length) {
      out.push(msgList([`${r.seams.stepped.length} seam(s) have a plate step and take no key `
        + `(${r.seams.stepped.join(', ')}). Those tiles are registered by the plate stack under them.`], 'note'));
    }
  }

  /* water */
  if (r.lakes.totalMl) {
    const byKind = Object.entries(r.lakes.byKind).map(([k, v]) => `${v} ${k}${v > 1 ? 's' : ''}`).join(', ');
    out.push(`<h3>Standing water</h3><p class="line">${esc(byKind)}, ${fmt(r.lakes.totalMl, 1)} ml of epoxy in all.</p>`
      + '<div class="scroll"><table><thead><tr><th>Tile</th><th>What</th><th>Area</th><th>Deepest</th><th>Epoxy</th></tr></thead><tbody>'
      + r.lakes.top.map((l) => `<tr><td><b>${esc(l.tile)}</b></td><td>${esc(l.what)}</td>`
        + `<td>${fmt(l.areaMM2)} mm²</td><td>${fmt(l.deepestMM, 1)} mm</td><td>${fmt(l.millilitres, 2)} ml</td></tr>`).join('')
      + '</tbody></table></div>');
  }
  if (r.lakesSkipped.length) {
    out.push(msgList(r.lakesSkipped.map((s) => `${s.tile}: ${s.what} not carved — ${s.why}`), 'note'));
  }

  /* fountain */
  if (r.springs.length) {
    out.push('<h3>Fountain</h3><div class="scroll"><table><thead><tr>'
      + '<th>Tile</th><th>Spring at</th><th>Pool bed</th><th>Spills at</th><th>Bore</th><th>Drilled plates</th>'
      + '</tr></thead><tbody>'
      + r.springs.map((s) => `<tr><td><b>${esc(s.tile)}</b></td>`
        + `<td class="mono">${s.atMM.join(', ')} mm</td><td>${fmt(s.bedMM, 1)} mm</td>`
        + `<td>${fmt(s.spillMM, 1)} mm</td><td>${fmt(s.boreMM, 1)} mm for ${s.tubeOdMM} mm tube</td>`
        + `<td>${s.level}</td></tr>`).join('')
      + '</tbody></table></div>');
  }

  /* ice */
  if (r.glacier) {
    const g = r.glacier;
    out.push(`<h3>Ice</h3><p class="line">ELA ${fmt(g.elaM)} m, ${fmt(g.glaciatedPct)}% of the map glaciated, `
      + `up to ${fmt(g.maxIceM)} m thick, sliding to ${fmt(g.maxSlideMPerYear)} m/yr, cutting up to ${fmt(g.maxIncisionM)} m.</p>`);
    if (g.runaway) out.push(msgList(['Ice is against its ceiling — this climate builds an ice cap, not valley glaciers. Raise glacier.elaM.'], 'warning'));
  }

  /* totals */
  out.push('<h3>Totals</h3><ul class="facts">'
    + `<li><span>Worst edge error, any tile</span><span class="${t.worstEdgeMM > 0.01 ? 'bad' : ''}">${fmt(t.worstEdgeMM, 4)} mm</span></li>`
    + `<li><span>Tallest stack</span><span class="${t.overStack ? 'bad' : ''}">${t.maxLevel} plates (${fmt(t.maxStackMM)} mm)</span></li>`
    + `<li><span>Plates to print</span><span>${fmt(t.totalPlates)}</span></li>`
    + `<li><span>Triangles</span><span>${fmt(t.triangles)}</span></li>`
    + `<li><span>Tiles that did not close</span><span class="${t.leaks ? 'bad' : 'good'}">${t.leaks}</span></li>`
    + '</ul>');
  if (t.overStack) {
    out.push(msgList([`That is ${fmt(t.maxStackMM)} mm of plates before the terrain starts, past the `
      + `${c.maxStackPlates}-plate guide. Gentler falls, or a shorter river, would bring it down.`], 'warning'));
  }

  el.report.innerHTML = out.filter(Boolean).join('');
  el.reportPanel.hidden = false;
}

/* -------------------------------------------------------------- downloads */

const GROUPS = [['tiles', 'Tiles'], ['plates', 'Plates'], ['joinery', 'Keys and tray']];

function renderDownloads(r, files) {
  if (r.errors.length) {
    el.dlNote.textContent = 'Not offering STLs while the contract is broken — fix the errors above first.';
    el.downloads.innerHTML = '';
    el.dlPanel.hidden = false;
    return;
  }
  el.dlNote.innerHTML = 'Binary STL, millimetres, Z up — drop straight into a slicer. '
    + `The whole set is ${fmt(r.totals.triangles)} triangles, so the ZIP takes a moment to compress.`;

  const html = [];
  for (const [group, title] of GROUPS) {
    const mine = files.filter((f) => f.group === group);
    if (!mine.length) continue;
    html.push(`<div class="dl-group"><h3>${title}</h3><div class="dl-grid">`
      + mine.map((f) => `<button type="button" class="dl" data-id="${esc(f.id)}">`
        + `<b>${esc(f.name)}</b><span>${esc(f.note)}</span></button>`).join('')
      + '</div></div>');
  }
  html.push('<div class="dl-grid"><button type="button" class="dl primary" data-zip="1">'
    + `<b>Everything as a ZIP</b><span>${files.length} files</span></button></div>`);
  el.downloads.innerHTML = html.join('');
  el.dlPanel.hidden = false;
}

el.downloads.addEventListener('click', (ev) => {
  const b = ev.target.closest('button');
  if (!b || busy || !worker) return;
  if (b.dataset.zip) {
    setBusy(true, 'Packing');
    progressLabel = 'Packing';
    worker.postMessage({ type: 'zip' });
  } else if (b.dataset.id) {
    setBusy(true, 'Writing STL');
    progressLabel = `Writing ${b.querySelector('b').textContent}`;
    worker.postMessage({ type: 'stl', id: b.dataset.id });
  }
});

function saveBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Give the download a moment to start before the URL goes away.
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

/* ------------------------------------------------------------------ start */

writeTextarea();
syncControlsFromSpec();
say('Ready. Draft mesh first — it is a few seconds, and the contract and the seams are the same.');
