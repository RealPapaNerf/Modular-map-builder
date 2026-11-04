// report.js — the Print stage: the build report and the files, as HTML.
//
// The same facts `mmb check` prints, as tables, and the same set of STLs
// `mmb build` writes. Lifted from the first app unchanged in what it says.

export const fmt = (n, d = 0) => (n == null || !Number.isFinite(n) ? '\u2014' : n.toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d }));
export const bytes = (n) => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(0)} kB` : `${(n / 1048576).toFixed(1)} MB`);
export const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function msgList(items, kind) {
  if (!items.length) return '';
  const label = { error: 'error', warning: 'warning', note: 'note' }[kind];
  return `<ul class="msgs">${items.map((m) => `<li class="${kind}"><b>${label}</b> — ${esc(m)}</li>`).join('')}</ul>`;
}

export function reportHTML(r, elapsedMS) {
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

  return out.filter(Boolean).join('');
}

const GROUPS = [['tiles', 'Tiles'], ['plates', 'Plates'], ['joinery', 'Keys and tray']];

export function downloadsHTML(r, files) {
  if (r.errors.length) {
    return '<p class="hint">Not offering STLs while the contract is broken \u2014 fix the errors in the report first.</p>';
  }
  const note = '<p class="hint">Binary STL, millimetres, Z up \u2014 drop straight into a slicer. '
    + `The whole set is ${fmt(r.totals.triangles)} triangles, so the ZIP takes a moment to compress.</p>`;

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
  return note + html.join('');
}

