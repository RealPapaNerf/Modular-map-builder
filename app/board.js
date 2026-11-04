// board.js (app) — the board canvas: tiles on their risers, the water, and
// a badge on every seam saying what it does there.
//
// Everything drawn comes from the plan (lib/board.js run on the spec), never
// from the spec directly, so what is on screen is what the board predicts.
// The tile view (tilecanvas.js) draws this too, zoomed, and adds its own.

import { OPPOSITE, STEP, sizeFor } from '../lib/contract.js';
import { facingEdge, turnEdge } from '../lib/board.js';
import { roundRect, arrowHead, pill, mix } from './view.js';
import { dims, cellAt } from './specops.js';
import { drawGround, drawTileFeatures } from './features.js';

/** The board's extent in mm, with room round it for the ghost cells and for a stroke to start off the edge. */
export function boardBox(spec, plan, margin = 0.6) {
  const { cols, rows, T } = dims(spec);
  let c0 = 0; let r0 = 0; let c1 = cols; let r1 = rows;
  for (const p of plan?.placements || []) {
    c0 = Math.min(c0, p.col); r0 = Math.min(r0, p.row);
    c1 = Math.max(c1, p.col + 1); r1 = Math.max(r1, p.row + 1);
  }
  return { x0: (c0 - margin) * T, y0: (r0 - margin) * T, x1: (c1 + margin) * T, y1: (r1 + margin) * T };
}

/** Lookups the drawing and the hit test both want, built once per plan. */
export function indexPlan(plan) {
  if (plan._index) return plan._index;
  const tileById = new Map(plan.tiles.map((t) => [t.id, t]));
  const placeById = new Map(plan.placements.map((p) => [p.id, p]));
  const tileAt = new Map(plan.tiles.map((t) => [`${t.col},${t.row}`, t]));
  const seamAt = new Map();
  for (const s of plan.seams) {
    seamAt.set(`${s.a}|${s.edge}`, s);
    if (s.b) seamAt.set(`${s.b}|${OPPOSITE[s.edge]}`, s);
  }
  const maxRiser = Math.max(10, ...plan.tiles.map((t) => t.riserMM));
  plan._index = { tileById, placeById, tileAt, seamAt, maxRiser };
  return plan._index;
}

const edgeMid = (T, col, row, e) => {
  switch (e) {
    case 'N': return { x: (col + 0.5) * T, y: (row + 1) * T };
    case 'S': return { x: (col + 0.5) * T, y: row * T };
    case 'E': return { x: (col + 1) * T, y: (row + 0.5) * T };
    default: return { x: col * T, y: (row + 0.5) * T };
  }
};

/* ------------------------------------------------------------------ badges */

const r0 = (v) => Math.round(v);

/** What a seam's badge looks like. */
export function badgeStyle(s, th) {
  const wet = s.wet;
  // A pond that went out backwards, through an inlet's notch.
  if (s.backFrom && s.kind === 'dry') return { text: s.backTo ? '\u21a9 spills' : '\u21a9 tray', fill: th.water, ink: '#fff' };
  switch (s.kind) {
    case 'flow': return { shape: 'dot', fill: wet ? th.water : th.panel, stroke: wet ? null : th.dry, ink: wet ? '#fff' : th.dry, arrow: true };
    case 'waterfall': return { text: `↓${r0(s.dropMM)}`, fill: wet ? th.fall : th.panel, stroke: wet ? th.water : th.dry, ink: wet ? '#1b1d1f' : th.dry };
    case 'dam':
    case 'blocked': {
      const word = s.kind === 'dam' ? 'dam' : 'bank';
      if (s.holds === false) return { text: 'overtops', fill: th.panel, stroke: th.dam, ink: th.dam, dashed: true };
      if (!wet) return { text: word, fill: th.panel, stroke: th.dry, ink: th.dry };
      return { text: `${word} ≈${r0(s.pondToMM)}`, fill: th.dam, ink: '#fff' };
    }
    case 'spills': return { text: `↘${r0(s.dropMM)}`, fill: wet ? th.spill : th.panel, stroke: wet ? null : th.dry, ink: wet ? '#fff' : th.dry };
    case 'head-on': return { text: s.from ? `⇄${r0(s.dropMM)}` : '⇄', fill: th.headon, ink: '#fff' };
    case 'drains': return { text: 'tray', fill: wet ? th.water : th.panel, stroke: wet ? null : th.dry, ink: wet ? '#fff' : th.dry, arrow: true };
    case 'spring': return { shape: 'spring', fill: th.spring };
    case 'dry': return { shape: 'dry', fill: th.panel, stroke: th.dry };
    case 'cliff': return { text: `cliff ${r0(Math.abs(s.landStepMM))}`, fill: th.panel, stroke: th.cliff, ink: th.cliff };
    default: return null;
  }
}

/** Which way the water goes across a seam, in board mm (north is +y): out of `a` by its edge, or in, for a spring. */
export function flowOnBoard(s) {
  const [dx, dy] = STEP[s.edge];
  return s.kind === 'spring' ? { x: -dx, y: -dy } : { x: dx, y: dy };
}

/** The same, as a screen-space unit vector on the board canvas, whose y runs down. */
function flowDir(s) {
  const d = flowOnBoard(s);
  return { x: d.x, y: -d.y };
}

/**
 * One seam's badge, centred on (x, y) in screen px. `dir` is which way the
 * water crosses, on screen; the board works it out from the seam, and the 3D
 * view, whose camera can face any way, passes its own.
 */
export function drawBadge(ctx, s, x, y, th, ring, dir = null) {
  const st = badgeStyle(s, th);
  if (!st) return null;
  let rect;
  if (st.shape === 'dot' || st.shape === 'spring' || st.shape === 'dry') {
    const r = st.shape === 'dry' ? 7 : 8.5;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fillStyle = st.fill;
    ctx.fill();
    if (st.stroke) { ctx.lineWidth = 1.5; ctx.strokeStyle = st.stroke; ctx.stroke(); }
    if (st.shape === 'dot') {
      const d = dir || flowDir(s);
      ctx.strokeStyle = st.ink; ctx.fillStyle = st.ink; ctx.lineWidth = 1.8;
      ctx.beginPath(); ctx.moveTo(x - d.x * 4.5, y - d.y * 4.5); ctx.lineTo(x + d.x * 2, y + d.y * 2); ctx.stroke();
      arrowHead(ctx, x + d.x * 5, y + d.y * 5, d.x, d.y, 4);
    } else if (st.shape === 'spring') {
      ctx.fillStyle = '#fff';
      ctx.beginPath(); ctx.arc(x, y, 3, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.2;
      ctx.beginPath(); ctx.arc(x, y, 5.6, 0, Math.PI * 2); ctx.stroke();
    } else {
      ctx.strokeStyle = st.stroke; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.moveTo(x - 3.5, y); ctx.lineTo(x + 3.5, y); ctx.stroke();
    }
    rect = { x: x - r, y: y - r, w: 2 * r, h: 2 * r };
  } else {
    rect = pill(ctx, x, y, st.text, st);
    if (st.arrow) {
      const d = dir || flowDir(s);
      ctx.fillStyle = st.fill === th.panel ? th.dry : st.fill;
      arrowHead(ctx, x + d.x * (rect.w / 2 + 6), y + d.y * (rect.h / 2 + 6), d.x, d.y, 5);
    }
  }
  if (s.spreads && s.wet) {
    const sx = rect.x + rect.w + 7;
    ctx.beginPath(); ctx.arc(sx, y, 6, 0, Math.PI * 2);
    ctx.fillStyle = th.spill; ctx.fill();
    ctx.fillStyle = '#fff'; ctx.font = '700 9px system-ui, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText('⋔', sx, y + 0.5);
    rect = { ...rect, w: rect.w + 14 };
  }
  if (ring) {
    ctx.lineWidth = 2;
    ctx.strokeStyle = th.select;
    roundRect(ctx, rect.x - 3, rect.y - 3, rect.w + 6, rect.h + 6, 8);
    ctx.stroke();
  }
  return rect;
}

/* ------------------------------------------------------------------- draw */

/**
 * Draw the board. `st` is the editor state; `opt.focus` dims every tile but
 * one (the tile view); `opt.features` is 'faint', 'full' or 'none'.
 * Returns the badge rectangles, for the hit test.
 */
export function drawBoard(ctx, st, cam, th, opt = {}) {
  const { spec, plan } = st;
  const { cols, rows, T } = dims(spec);
  const ix = indexPlan(plan);
  const s = cam.s;
  const tilePx = T * s;
  ctx.fillStyle = th.canvas;
  ctx.fillRect(0, 0, cam.width, cam.height);

  // Ghost cells round the board, for the place tool.
  if (opt.ghosts) {
    const hover = st.hover?.kind === 'ghost' ? st.hover.side : null;
    const cells = [];
    for (let r = 0; r < rows; r++) { cells.push({ side: 'W', col: -1, row: r }); cells.push({ side: 'E', col: cols, row: r }); }
    for (let c = 0; c < cols; c++) { cells.push({ side: 'S', col: c, row: -1 }); cells.push({ side: 'N', col: c, row: rows }); }
    for (const g of cells) {
      const x = cam.sx(g.col * T) + tilePx * 0.06;
      const y = cam.sy((g.row + 1) * T) + tilePx * 0.06;
      const on = hover === g.side;
      roundRect(ctx, x, y, tilePx * 0.88, tilePx * 0.88, 8);
      ctx.setLineDash([5, 4]);
      ctx.lineWidth = on ? 2 : 1;
      ctx.strokeStyle = on ? th.select : th.ghost;
      ctx.stroke();
      ctx.setLineDash([]);
      if (on) { ctx.fillStyle = mix(th.canvas, th.select, 0.08); ctx.fill(); }
      ctx.fillStyle = on ? th.select : th.ghost;
      ctx.font = `600 ${Math.max(12, Math.min(22, tilePx * 0.12))}px system-ui, sans-serif`;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(on ? (g.side === 'E' || g.side === 'W' ? '+ column' : '+ row') : '+', x + tilePx * 0.44, y + tilePx * 0.44);
    }
  }

  const focusId = opt.focus ? `${opt.focus.col},${opt.focus.row}` : null;
  const grown = st.grown && st.grown.image ? st.grown : null;
  const shadeAlpha = grown ? (st.stage === 'draw' ? (grown.stale ? 0.4 : 0.7) : (grown.stale ? 0.55 : 1)) : 0;

  // Tiles.
  for (const t of plan.tiles) {
    const p = ix.placeById.get(t.id);
    const x = cam.sx(t.col * T);
    const y = cam.sy((t.row + 1) * T);
    const dim = focusId && t.id !== focusId;
    ctx.save();
    if (dim) ctx.globalAlpha = 0.5;
    roundRect(ctx, x + 1, y + 1, tilePx - 2, tilePx - 2, Math.max(2, 4 * s));
    ctx.fillStyle = mix(th.landLo, th.landHi, ix.maxRiser ? t.riserMM / ix.maxRiser : 0);
    ctx.fill();
    if (grown && shadeAlpha && grown.cells.has(t.id)) {
      ctx.save();
      ctx.clip();
      ctx.globalAlpha *= shadeAlpha;
      const g = grown.cells.get(t.id);
      // The design is drawn turned the way the piece sits on the table.
      const rot = opt.unturned && t.id === focusId ? 0 : t.rot;
      ctx.translate(x + tilePx / 2, y + tilePx / 2);
      ctx.rotate((rot * Math.PI) / 2);
      ctx.drawImage(grown.image, g.sx, g.sy, g.size, g.size, -tilePx / 2, -tilePx / 2, tilePx, tilePx);
      ctx.restore();
    }
    ctx.lineWidth = 1;
    ctx.strokeStyle = p?.outside ? th.dam : th.edge;
    if (p?.outside) ctx.setLineDash([6, 4]);
    roundRect(ctx, x + 1, y + 1, tilePx - 2, tilePx - 2, Math.max(2, 4 * s));
    ctx.stroke();
    ctx.setLineDash([]);

    // A pond: the tile filling with water. Dashed where it runs over.
    if (t.ponds) {
      ctx.fillStyle = th.waterSoft;
      roundRect(ctx, x + tilePx * 0.1, y + tilePx * 0.1, tilePx * 0.8, tilePx * 0.8, tilePx * 0.12);
      ctx.fill();
      if (t.overtops) {
        const a = edgeMid(T, t.col, t.row, t.overSide);
        const [dx, dy] = STEP[t.overSide];
        const along = { x: dy !== 0 ? 1 : 0, y: dx !== 0 ? 1 : 0 };
        ctx.strokeStyle = th.dam; ctx.lineWidth = 3; ctx.setLineDash([6, 5]);
        ctx.beginPath();
        ctx.moveTo(cam.sx(a.x - along.x * T * 0.42), cam.sy(a.y - along.y * T * 0.42));
        ctx.lineTo(cam.sx(a.x + along.x * T * 0.42), cam.sy(a.y + along.y * T * 0.42));
        ctx.stroke(); ctx.setLineDash([]);
      }
    }
    ctx.restore();
  }

  // Channels, schematic: each inlet to the middle, the middle to each outlet.
  for (const t of plan.tiles) {
    const dim = focusId && t.id !== focusId;
    const ins = [];
    const outs = [];
    for (const e of ['N', 'E', 'S', 'W']) {
      const ed = t.placed.edges?.[e];
      if (!ed || ed.type === 'land') continue;
      (ed.type === 'in' ? ins : outs).push({ e, w: sizeFor(ed.size).widthMM, wet: ix.seamAt.get(`${t.id}|${e}`)?.wet ?? false });
    }
    if (!ins.length && !outs.length) continue;
    ctx.save();
    if (dim) ctx.globalAlpha = 0.45;
    if (shadeAlpha >= 1 && grown?.cells.has(t.id)) ctx.globalAlpha *= 0.55;
    const C = { x: (t.col + 0.5) * T, y: (t.row + 0.5) * T };
    const P = (e) => edgeMid(T, t.col, t.row, e);
    const stroke = (wet, w) => {
      ctx.strokeStyle = wet ? th.water : th.dry;
      ctx.lineWidth = Math.max(2, Math.min(w * s * 0.85, 26));
      ctx.setLineDash(wet ? [] : [Math.max(3, 5 * s), Math.max(3, 4 * s)]);
      ctx.lineCap = 'round';
    };
    const halfCurve = (a, b, c) => { // quadratic a -> b(control) -> c
      ctx.beginPath(); ctx.moveTo(cam.sx(a.x), cam.sy(a.y));
      ctx.quadraticCurveTo(cam.sx(b.x), cam.sy(b.y), cam.sx(c.x), cam.sy(c.y)); ctx.stroke();
    };
    const pairs = [];
    if (ins.length && outs.length) {
      for (const i of ins) pairs.push([i, outs[0]]);
      for (const o of outs.slice(1)) pairs.push([ins[0], o]);
    }
    for (const [i, o] of pairs) {
      const A = P(i.e); const B = P(o.e);
      const mid = { x: 0.25 * A.x + 0.5 * C.x + 0.25 * B.x, y: 0.25 * A.y + 0.5 * C.y + 0.25 * B.y };
      stroke(i.wet, i.w); halfCurve(A, { x: (A.x + C.x) / 2, y: (A.y + C.y) / 2 }, mid);
      stroke(o.wet, o.w); halfCurve(mid, { x: (C.x + B.x) / 2, y: (C.y + B.y) / 2 }, B);
    }
    if (!outs.length) {
      for (const i of ins) { stroke(i.wet, i.w); halfCurve(P(i.e), C, C); }
      ctx.setLineDash([]);
      ctx.fillStyle = ins.some((i) => i.wet) ? th.water : th.dry;
      ctx.beginPath(); ctx.arc(cam.sx(C.x), cam.sy(C.y), Math.max(4, 14 * s), 0, Math.PI * 2); ctx.fill();
    }
    if (!ins.length) {
      for (const o of outs) { stroke(o.wet, o.w); halfCurve(C, C, P(o.e)); }
      ctx.setLineDash([]);
      ctx.fillStyle = outs.some((o) => o.wet) ? th.spring : th.dry;
      ctx.beginPath(); ctx.arc(cam.sx(C.x), cam.sy(C.y), Math.max(3, 7 * s), 0, Math.PI * 2); ctx.fill();
    }
    ctx.setLineDash([]);
    // Port notches, to scale, once there is room to see them.
    if (tilePx > 170 || t.id === focusId) {
      for (const pp of [...ins, ...outs]) {
        const m = P(pp.e);
        const [dx, dy] = STEP[pp.e];
        const along = { x: dy !== 0 ? 1 : 0, y: dx !== 0 ? 1 : 0 };
        ctx.strokeStyle = th.edge; ctx.lineWidth = 3; ctx.lineCap = 'butt';
        ctx.beginPath();
        ctx.moveTo(cam.sx(m.x - along.x * pp.w / 2), cam.sy(m.y - along.y * pp.w / 2));
        ctx.lineTo(cam.sx(m.x + along.x * pp.w / 2), cam.sy(m.y + along.y * pp.w / 2));
        ctx.stroke();
      }
    }
    ctx.restore();
  }

  // The ground's features, faint on the board and full in the tile view.
  if (opt.features !== 'none') {
    drawGround(ctx, st, cam, th, opt.features === 'full' ? 1 : 0.6);
    drawTileFeatures(ctx, st, cam, th, { alpha: 0.75 });
  }

  // Labels.
  for (const t of plan.tiles) {
    const p = ix.placeById.get(t.id);
    const dim = focusId && t.id !== focusId;
    const x = cam.sx(t.col * T);
    const y = cam.sy((t.row + 1) * T);
    const fs = Math.max(10, Math.min(15, tilePx * 0.075));
    ctx.save();
    if (dim) ctx.globalAlpha = 0.5;
    ctx.fillStyle = th.label;
    ctx.textBaseline = 'top'; ctx.textAlign = 'left';
    ctx.font = `700 ${fs}px system-ui, sans-serif`;
    // A halo where there is a hillshade under the label, so it still reads.
    const halo = shadeAlpha > 0 && grown?.cells.has(t.id);
    ctx.lineJoin = 'round';
    ctx.strokeStyle = halo ? th.landHi : 'transparent'; ctx.lineWidth = halo ? 3 : 0;
    if (halo) ctx.strokeText(t.label, x + 7, y + 6);
    ctx.fillText(t.label, x + 7, y + 6);
    if (tilePx > 70) {
      ctx.font = `500 ${fs * 0.85}px ui-monospace, Menlo, monospace`;
      ctx.textBaseline = 'bottom';
      // The riser: a little stack of plates and how tall it is.
      const bx = x + 8; const by = y + tilePx - 8;
      ctx.strokeStyle = th.label; ctx.lineWidth = 1.4;
      for (let k = 0; k < 3; k++) { ctx.beginPath(); ctx.moveTo(bx, by - 2 - k * 3.4); ctx.lineTo(bx + 11, by - 2 - k * 3.4); ctx.stroke(); }
      if (halo) ctx.strokeText(`${r0(t.riserMM)}`, bx + 15, by + 1);
      ctx.fillText(`${r0(t.riserMM)}`, bx + 15, by + 1);
      const hasRiver = Object.values(p.tile.edges || {}).some((ed) => ed && ed.type !== 'land');
      if (hasRiver) {
        ctx.textAlign = 'right';
        if (halo) ctx.strokeText(`fall ${t.fallMM}`, x + tilePx - 8, by + 1);
        ctx.fillText(`fall ${t.fallMM}`, x + tilePx - 8, by + 1);
      }
    }
    if (t.rot) {
      // Where the design's north now points.
      const n = turnEdge('N', t.rot);
      const [dx, dy] = STEP[n];
      const cx = x + tilePx - 15; const cy = y + 15;
      ctx.strokeStyle = th.accent; ctx.fillStyle = th.accent; ctx.lineWidth = 1.6;
      ctx.beginPath(); ctx.arc(cx, cy, 9, 0, Math.PI * 2); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(cx - dx * 5, cy + dy * 5); ctx.lineTo(cx + dx * 3, cy - dy * 3); ctx.stroke();
      arrowHead(ctx, cx + dx * 6, cy - dy * 6, dx, -dy, 4);
      ctx.font = '700 8px system-ui, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText('N', cx - 13, cy);
    }
    ctx.restore();
  }

  // Selection and hover.
  const sel = st.selection;
  const outline = (col, row, color, w) => {
    ctx.lineWidth = w; ctx.strokeStyle = color;
    roundRect(ctx, cam.sx(col * T) + 2, cam.sy((row + 1) * T) + 2, tilePx - 4, tilePx - 4, Math.max(2, 4 * s));
    ctx.stroke();
  };
  if (st.hover?.kind === 'tile' && !opt.focus) outline(st.hover.col, st.hover.row, mix(th.select, th.canvas, 0.45), 2);
  if (sel?.type === 'tile') outline(sel.col, sel.row, th.select, 3);
  if (sel?.type === 'river') {
    const r = spec.rivers?.[sel.index];
    if (r) for (const [c, w] of r.path || []) outline(c, w, th.water, 3);
  }

  // Badges last, so nothing covers them.
  const badges = [];
  for (const sm of plan.seams) {
    if (sm.kind === 'plane') continue;
    if (focusId && sm.a !== focusId && sm.b !== focusId && tilePx > 400) continue;
    let px = cam.sx(sm.at.x);
    let py = cam.sy(sm.at.y);
    if (!sm.b) { const [dx, dy] = STEP[sm.edge]; px += dx * 15; py -= dy * 15; }
    const ring = (sel?.type === 'seam' && sel.id === sm.id) || (st.hover?.kind === 'seam' && st.hover.id === sm.id);
    const r = drawBadge(ctx, sm, px, py, th, ring);
    if (r) badges.push({ id: sm.id, rect: r });
  }
  return { badges };
}

/* -------------------------------------------------------------------- hit */

/**
 * What is under a screen point. Badges first, because they sit on top; then
 * the ghost cells; then a tile, with the edge the point is nearest if it is
 * close enough to one to mean it.
 */
export function hitBoard(st, cam, px, py, frame, { ghosts = false } = {}) {
  for (const b of frame?.badges || []) {
    const r = b.rect;
    if (px >= r.x - 3 && px <= r.x + r.w + 3 && py >= r.y - 3 && py <= r.y + r.h + 3) return { kind: 'seam', id: b.id };
  }
  const { spec, plan } = st;
  const { cols, rows, T } = dims(spec);
  const pt = cam.toBoard(px, py);
  const cell = cellAt(spec, pt);
  if (ghosts && !cell.inside) {
    const inRows = cell.row >= 0 && cell.row < rows;
    const inCols = cell.col >= 0 && cell.col < cols;
    if (cell.col === -1 && inRows) return { kind: 'ghost', side: 'W', pt };
    if (cell.col === cols && inRows) return { kind: 'ghost', side: 'E', pt };
    if (cell.row === -1 && inCols) return { kind: 'ghost', side: 'S', pt };
    if (cell.row === rows && inCols) return { kind: 'ghost', side: 'N', pt };
  }
  const t = indexPlan(plan).tileAt.get(`${cell.col},${cell.row}`);
  if (!t) return { kind: 'empty', pt, cell };
  const d = { W: cell.lx, E: T - cell.lx, S: cell.ly, N: T - cell.ly };
  let edge = null;
  let best = T * 0.26;
  for (const [e, v] of Object.entries(d)) if (v < best) { best = v; edge = e; }
  return {
    kind: 'tile', col: t.col, row: t.row, id: t.id, label: t.label, rot: t.rot,
    edge, designEdge: edge ? facingEdge(edge, t.rot) : null, pt, lx: cell.lx, ly: cell.ly,
  };
}
