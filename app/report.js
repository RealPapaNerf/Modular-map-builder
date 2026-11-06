// report.js — the Print stage: the build report and the files, as HTML.
//
// The same facts `mmb check` prints, as tables, and the same set of STLs
// `mmb build` writes.

export const fmt = (n, d = 0) => (n == null || !Number.isFinite(n) ? '—' : n.toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d }));
export const bytes = (n) => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(0)} kB` : `${(n / 1048576).toFixed(1)} MB`);
export const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const SIDE = { N: 'north', E: 'east', S: 'south', W: 'west' };

function msgList(items, kind) {
  if (!items.length) return '';
  const label = { error: 'error', warning: 'warning', note: 'note' }[kind];
  return `<ul class="msgs">${items.map((m) => `<li class="${kind}"><b>${label}</b> — ${esc(m)}</li>`).join('')}</ul>`;
}

export function reportHTML(r, elapsedMS) {
  const c = r.contract;
  const t = r.totals;
  const out = [];

  const cls = c.classes ? Object.entries(c.classes).map(([e, k]) => `${SIDE[e]} ${k}`).join(', ') : `all ${c.edgeLandMM - 2}`;
  out.push(`<p class="line">A ${c.tileMM} mm module; edge classes ${esc(cls)}. Ports ${c.portWidthMM} mm wide in the middle of a side, `
    + `rebated ${fmt(c.grooveDepthMM, 1)} mm for silicone over the last ${fmt(c.grooveWidthMM, 0)} mm. `
    + `Grown in ${(elapsedMS / 1000).toFixed(1)}s${r.mode === 'check' ? ', ice off' : ''}.</p>`);

  out.push(msgList(r.contractNotes.filter((n) => n.severity === 'error').map((n) => n.message), 'error'));
  out.push(msgList(r.errors, 'error'));
  out.push(msgList(r.contractNotes.filter((n) => n.severity === 'warning').map((n) => n.message), 'warning'));
  out.push(msgList(r.warnings, 'warning'));
  out.push(msgList(r.notes, 'note'));

  /* edges */
  out.push('<h3>Edges</h3><div class="scroll"><table><thead><tr><th>Side</th><th>Class</th><th>Mates with</th><th>Error</th></tr></thead><tbody>'
    + Object.entries(r.edges).map(([e, x]) => `<tr><td><b>${SIDE[e]}</b></td><td>${x.classMM ?? '—'}</td><td class="ports">${esc(x.signature)}</td><td class="mono ${x.errMM > 1e-6 ? 'bad' : 'good'}">${fmt(x.errMM, 4)} mm</td></tr>`).join('')
    + '</tbody></table></div>'
    + `<p class="line">Worst edge error ${fmt(r.worstEdgeMM, 4)} mm${r.worstEdgeMM < 1e-6 ? ': each side mates flush with any side of its class.' : ': it does NOT mate.'}</p>`);

  /* channels */
  if (r.channels.length) {
    out.push('<h3>Channels</h3><div class="scroll"><table><thead><tr><th>Channel</th><th>Ends</th><th>Width</th><th>Depth</th><th>Length</th><th>Floor</th><th>Gorge</th><th>Ponds</th></tr></thead><tbody>'
      + r.channels.map((ch) => `<tr><td><b>${esc(ch.name)}</b></td>`
        + `<td class="ports">${ch.from ? `in ${ch.from}` : 'inside'} → ${ch.to ? `out ${ch.to}` : 'inside'}${ch.routed ? ' (routed)' : ''}</td>`
        + `<td>${ch.widthMM} mm</td><td>${ch.depthMM} mm</td><td>${fmt(ch.lengthMM)} mm</td>`
        + `<td class="mono">${fmt(ch.startFloorMM, 1)} → ${fmt(ch.endFloorMM, 1)} (low ${fmt(ch.lowestFloorMM, 1)})</td>`
        + `<td>${ch.gorgeMM > 0.5 ? `${fmt(ch.gorgeMM, 1)} mm deeper` : '—'}</td>`
        + `<td class="${ch.pondMM > 0.5 ? 'bad' : ''}">${ch.pondMM > 0.5 ? `${fmt(ch.pondMM, 1)} mm` : '—'}</td></tr>`).join('')
      + '</tbody></table></div>');
  }

  /* the lock */
  const k = r.keys;
  if (k.placed || k.refused.length) {
    const cams = k.cams || [];
    out.push(`<h3>Cam lock</h3><p class="line">${cams.length} cam housing${cams.length === 1 ? '' : 's'} and ${k.usable} key pocket${k.usable === 1 ? '' : 's'}, `
      + `one of each a side, ${k.joint.offsetMM} mm either side of the port; ${k.sockets} corner socket${k.sockets === 1 ? '' : 's'} for a spacer plate's pins. `
      + `<b>Print ${k.usable} key${k.usable === 1 ? '' : 's'} and ${cams.length} cam${cams.length === 1 ? '' : 's'}</b>`
      + `${k.camHeights.length ? ` (${k.camHeights.map((h) => `${fmt(h, 1)} mm`).join(', ')} tall)` : ''}. `
      + 'Everything is in the underside, so nothing shows on top. Lay the modules face down, butted together; drop a key into each seam, '
      + 'pad into the pocket and head into the next module\'s cam bore; drop a cam into each bore over the head, coin slot up, '
      + `and turn it a quarter turn with a coin: it draws ${fmt(k.joint.drawMM, 1)} mm and pulls the faces together. Then turn the map over.</p>`);
    if (k.refused.length) out.push(msgList(k.refused.map((x) => `${x.id} left out: ${x.why}`), 'note'));
  }

  /* water */
  if (r.lakes.totalMl) {
    const byKind = Object.entries(r.lakes.byKind).map(([kk, v]) => `${v} ${kk}${v > 1 ? 's' : ''}`).join(', ');
    out.push(`<h3>Standing water</h3><p class="line">${esc(byKind)}, ${fmt(r.lakes.totalMl, 1)} ml of epoxy in all.</p>`
      + '<div class="scroll"><table><thead><tr><th>What</th><th>Size</th><th>Area</th><th>Deepest</th><th>Epoxy</th></tr></thead><tbody>'
      + r.lakes.top.map((l) => `<tr><td><b>${esc(l.what)}</b>${l.resizeIndex != null ? ' (resized)' : ''}</td>`
        + `<td>${l.shape ? `${fmt(l.shape.lengthMM)} × ${fmt(l.shape.widthMM)} mm` : '—'}</td><td>${fmt(l.areaMM2)} mm²</td><td>${fmt(l.deepestMM, 1)} mm</td><td>${fmt(l.millilitres, 2)} ml</td></tr>`).join('')
      + '</tbody></table></div>');
  }
  if (r.lakesSkipped.length) out.push(msgList(r.lakesSkipped.map((s) => `${s.what} not carved — ${s.why}`), 'note'));

  /* fountain */
  if (r.springs.length) {
    out.push('<h3>Springs</h3><div class="scroll"><table><thead><tr><th>At</th><th>Pool bed</th><th>Spills at</th><th>Bore</th></tr></thead><tbody>'
      + r.springs.map((s) => `<tr><td class="mono">${s.atMM.join(', ')} mm</td><td>${fmt(s.bedMM, 1)} mm</td><td>${fmt(s.spillMM, 1)} mm</td><td>${fmt(s.boreMM, 1)} mm for ${s.tubeOdMM} mm tube</td></tr>`).join('')
      + '</tbody></table></div>');
  }

  /* ice */
  if (r.glacier) {
    const g = r.glacier;
    out.push(`<h3>Ice</h3><p class="line">ELA ${fmt(g.elaM)} m, ${fmt(g.glaciatedPct)}% of the world under ice at some point, up to ${fmt(g.maxIceM)} m thick, `
      + `cutting up to ${fmt(g.maxIncisionM)} m and leaving ${fmt(g.basins)} closed hollows. ${fmt(g.iceBeforeMeltM)} m of ice was left when the climate finished; `
      + `it melted out in ${fmt(g.meltYears)} years, and <b>${fmt(g.finalIceM, 1)} m remains</b>. The module is the bed.</p>`);
    if (g.runaway) out.push(msgList(['Ice is against its ceiling — this climate builds an ice cap, not valley glaciers. Raise glacier.elaMM.'], 'warning'));
  }

  /* totals */
  out.push('<h3>The module</h3><ul class="facts">'
    + `<li><span>Prints</span><span>${fmt(t.printsMM, 1)} mm tall</span></li>`
    + `<li><span>Land</span><span>${fmt(t.lowMM, 1)}–${fmt(t.highMM, 1)} mm</span></li>`
    + `<li><span>Trees</span><span>${fmt(t.trees)}</span></li>`
    + `<li><span>Epoxy</span><span>${t.millilitres ? `${fmt(t.millilitres, 1)} ml` : '—'}</span></li>`
    + `<li><span>Triangles</span><span>${fmt(t.triangles)}</span></li>`
    + `<li><span>Closed solid</span><span class="${t.watertight ? 'good' : 'bad'}">${t.watertight ? 'yes' : 'NO — it leaks'}</span></li>`
    + '</ul>');

  return out.filter(Boolean).join('');
}

const GROUPS = [['module', 'The module'], ['joinery', 'Keys, cams and tray'], ['plates', 'Spacer plates (any you want)']];

export function downloadsHTML(r, files) {
  if (r.errors.length) return '<p class="hint">Not offering STLs while the contract is broken — fix the errors in the report first.</p>';
  const note = '<p class="hint">Binary STL, millimetres, Z up — drop straight into a slicer.</p>';
  const html = [];
  for (const [group, title] of GROUPS) {
    const mine = files.filter((f) => f.group === group);
    if (!mine.length) continue;
    html.push(`<div class="dl-group"><h3>${title}</h3><div class="dl-grid">`
      + mine.map((f) => `<button type="button" class="dl" data-id="${esc(f.id)}"><b>${esc(f.name)}</b><span>${esc(f.note)}</span></button>`).join('')
      + '</div></div>');
  }
  const zipped = files.filter((f) => f.group !== 'plates').length;
  if (zipped > 1) html.push(`<div class="dl-grid"><button type="button" class="dl primary" data-zip="1"><b>The module's files as a ZIP</b><span>${zipped} files, plates not included</span></button></div>`);
  return note + html.join('');
}
