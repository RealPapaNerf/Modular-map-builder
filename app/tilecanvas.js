// tilecanvas.js — one tile close up, in its own millimetres.
//
// It is the board, zoomed: the neighbours stay on screen, dimmed, because a
// tile's edges only mean anything against what is across them. What it adds
// is the detail a tile is designed in -- a 10 mm grid, its four corner
// heights, its ports to scale and labelled -- and the tools that write into
// its own millimetres: lakes, springs, the outline of a wood, a corner raise.
//
// A tile that is turned on the board is shown here AS DESIGNED, unturned,
// because that is the frame its lakes and woods are written in.

import { plan as planBoard } from '../lib/board.js';
import { portFloor, sizeFor, EDGES, STEP } from '../lib/contract.js';
import { drawBoard } from './board.js';
import { drawGround, drawTileFeatures, handles } from './features.js';
import { dims, keyOf, labelOf } from './specops.js';
import { roundRect, pill } from './view.js';

export function tileBox(spec, col, row, margin = 0.34) {
  const { T } = dims(spec);
  return { x0: (col - margin) * T, y0: (row - margin) * T, x1: (col + 1 + margin) * T, y1: (row + 1 + margin) * T };
}

const cache = { spec: null, key: null, world: null, plan: null };

/** The plan the tile view draws: the board as it is, but the tile in focus unturned. */
export function tilePlan(st) {
  const { col, row } = st.view.tile;
  const k = keyOf(col, row);
  if (!st.spec.rot?.[k]) return st.plan;
  const world = st.world?.field || null;
  if (cache.spec === st.spec && cache.key === k && cache.world === world) return cache.plan;
  const spec = { ...st.spec, rot: { ...st.spec.rot } };
  delete spec.rot[k];
  cache.spec = st.spec; cache.key = k; cache.world = world;
  cache.plan = planBoard(spec, { world });
  return cache.plan;
}

export function drawTileView(ctx, st, cam, th) {
  const { col, row } = st.view.tile;
  const label = labelOf(col, row);
  const { T } = dims(st.spec);
  const plan = tilePlan(st);
  const view = { ...st, plan };
  const frame = drawBoard(ctx, view, cam, th, { focus: { col, row }, features: 'none' });
  const x0 = cam.sx(col * T);
  const y0 = cam.sy((row + 1) * T);
  const size = T * cam.s;

  // A 10 mm grid inside the tile, heavier every 50.
  ctx.save();
  roundRect(ctx, x0 + 1, y0 + 1, size - 2, size - 2, 4 * cam.s);
  ctx.clip();
  for (let k = 10; k < T; k += 10) {
    ctx.strokeStyle = th.grid;
    ctx.globalAlpha = k % 50 === 0 ? 0.9 : 0.45;
    ctx.lineWidth = k % 50 === 0 ? 1 : 0.6;
    ctx.beginPath(); ctx.moveTo(x0 + k * cam.s, y0); ctx.lineTo(x0 + k * cam.s, y0 + size); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(x0, y0 + size - k * cam.s); ctx.lineTo(x0 + size, y0 + size - k * cam.s); ctx.stroke();
  }
  ctx.restore();

  drawGround(ctx, view, cam, th, 1);
  drawTileFeatures(ctx, view, cam, th, { alpha: 1, unturned: label });

  // Ports, labelled the way the catalogue names them.
  const place = plan.placements.find((p) => p.col === col && p.row === row);
  if (place) {
    for (const e of EDGES) {
      const ed = place.tile.edges?.[e];
      if (!ed || ed.type === 'land') continue;
      const floor = portFloor(plan.contract, place.tile, ed.type);
      const [dx, dy] = STEP[e];
      const mx = (col + 0.5 + dx * 0.5) * T - dx * 16;
      const my = (row + 0.5 + dy * 0.5) * T - dy * 16;
      const text = `${ed.type} ${sizeFor(ed.size).id} @${floor}${ed.drain ? ' drain' : ''}${ed.waterfallMM ? ` +${ed.waterfallMM} fall` : ''}`;
      pill(ctx, cam.sx(mx) + (dy ? 0 : 0), cam.sy(my), text, { fill: th.panel, stroke: th.water, ink: th.ink, font: '500 11px ui-monospace, Menlo, monospace' });
    }

    // Corner heights, in the tile's own millimetres. A raised one is filled.
    const raise = st.spec.cornerRaise || {};
    for (const [k, dc, dr] of [['sw', 0, 0], ['se', 1, 0], ['nw', 0, 1], ['ne', 1, 1]]) {
      const h = place.tile.corners?.[k];
      const lifted = raise[`${col + dc},${row + dr}`];
      const cx = cam.sx((col + dc) * T);
      const cy = cam.sy((row + dr) * T);
      const hot = st.hover?.kind === 'corner' && st.hover.corner === k;
      const chosen = st.selection?.type === 'corner' && st.selection.cc === col + dc && st.selection.rr === row + dr;
      ctx.beginPath(); ctx.arc(cx, cy, 13, 0, Math.PI * 2);
      ctx.fillStyle = lifted ? th.ridge : th.panel; ctx.fill();
      ctx.lineWidth = hot || chosen ? 2.5 : 1.5; ctx.strokeStyle = hot || chosen ? th.select : th.edge; ctx.stroke();
      ctx.fillStyle = lifted ? '#fff' : th.ink;
      ctx.font = '600 10px ui-monospace, Menlo, monospace'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(Number.isFinite(h) ? String(Math.round(h)) : '?', cx, cy + 0.5);
    }
  }

  // What the tool in hand would make.
  const g = st.gesture?.preview;
  if (g) drawPreview(ctx, g, cam, th);
  return { ...frame, handles: handles(view, cam, { label }) };
}

/** A gesture's preview: a polyline, a polygon, or a circle, in board mm. */
export function drawPreview(ctx, g, cam, th) {
  ctx.save();
  ctx.strokeStyle = g.color || th.accent;
  ctx.fillStyle = g.color || th.accent;
  ctx.lineWidth = 2;
  if (g.pts && g.pts.length) {
    ctx.setLineDash(g.dashed ? [5, 4] : []);
    ctx.beginPath();
    g.pts.forEach((p, i) => (i ? ctx.lineTo(cam.sx(p.x), cam.sy(p.y)) : ctx.moveTo(cam.sx(p.x), cam.sy(p.y))));
    if (g.cursor) ctx.lineTo(cam.sx(g.cursor.x), cam.sy(g.cursor.y));
    if (g.closed) ctx.closePath();
    ctx.stroke();
    ctx.setLineDash([]);
    for (const p of g.pts) { ctx.beginPath(); ctx.arc(cam.sx(p.x), cam.sy(p.y), 3.5, 0, Math.PI * 2); ctx.fill(); }
  }
  if (g.circle) {
    ctx.setLineDash([6, 4]);
    ctx.beginPath();
    ctx.ellipse(cam.sx(g.circle.x), cam.sy(g.circle.y), g.circle.rx * cam.s, (g.circle.ry ?? g.circle.rx) * cam.s, 0, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);
  }
  if (g.cells) {
    ctx.globalAlpha = 0.25;
    for (const c of g.cells) {
      ctx.fillRect(cam.sx(c.x0), cam.sy(c.y1), (c.x1 - c.x0) * cam.s, (c.y1 - c.y0) * cam.s);
    }
    ctx.globalAlpha = 1;
  }
  if (g.label) {
    pill(ctx, g.label.px, g.label.py, g.label.text, { fill: th.panel, stroke: g.color || th.accent, ink: th.ink });
  }
  ctx.restore();
}
