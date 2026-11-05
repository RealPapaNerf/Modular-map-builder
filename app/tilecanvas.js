// tilecanvas.js — the module, drawn flat: the square, its margin, its ports,
// and everything drawn on it.
//
// The canvas works in module millimetres, north up, and shows the margin
// round the module faintly: that is ground the ice comes down from, and the
// ridge can be drawn out into it. Under the grid, once there is one, lies
// the hillshade -- the estimate before anything has grown, the grown module
// after.

import { EDGES } from '../lib/contract.js';
import { roundRect, pill } from './view.js';
import { dims, contractOf } from './specops.js';
import { drawGround, drawChannels, drawTileFeatures, handles } from './features.js';

/** The module and its margin, with a little room round it. */
export function tileBox(spec, extra = 0.04) {
  const { T, marginMM } = dims(spec);
  const m = marginMM + T * extra;
  return { x0: -m, y0: -m, x1: T + m, y1: T + m };
}

/** Board mm of the middle of an edge. */
export function edgeMid(T, e) {
  switch (e) {
    case 'N': return { x: T / 2, y: T };
    case 'S': return { x: T / 2, y: 0 };
    case 'E': return { x: T, y: T / 2 };
    default: return { x: 0, y: T / 2 };
  }
}

/**
 * Draw the module. `st` is the editor state. Returns the handles, for the
 * hit test.
 */
export function drawTile(ctx, st, cam, th) {
  const { spec } = st;
  const { T, marginMM } = dims(spec);
  const c = contractOf(spec);
  const s = cam.s;
  ctx.fillStyle = th.canvas;
  ctx.fillRect(0, 0, cam.width, cam.height);

  // The margin: the world beyond the rim, grown and thrown away.
  const x0 = cam.sx(0);
  const y0 = cam.sy(T);
  const size = T * s;
  ctx.fillStyle = th.margin;
  ctx.fillRect(cam.sx(-marginMM), cam.sy(T + marginMM), (T + 2 * marginMM) * s, (T + 2 * marginMM) * s);
  ctx.setLineDash([5, 5]);
  ctx.strokeStyle = th.ghost; ctx.lineWidth = 1;
  ctx.strokeRect(cam.sx(-marginMM), cam.sy(T + marginMM), (T + 2 * marginMM) * s, (T + 2 * marginMM) * s);
  ctx.setLineDash([]);

  // The module.
  roundRect(ctx, x0, y0, size, size, Math.max(2, 4 * s));
  ctx.fillStyle = th.landLo;
  ctx.fill();
  const shade = st.shade;
  if (shade?.image) {
    ctx.save();
    ctx.clip();
    ctx.globalAlpha = shade.kind === 'grown' ? (st.grown?.stale ? 0.55 : 0.92) : 0.6;
    ctx.drawImage(shade.image, x0, y0, size, size);
    ctx.restore();
  }

  // A 10 mm grid inside the module, heavier every 50.
  ctx.save();
  roundRect(ctx, x0 + 1, y0 + 1, size - 2, size - 2, 4 * s);
  ctx.clip();
  for (let k = 10; k < T; k += 10) {
    ctx.strokeStyle = th.grid;
    ctx.globalAlpha = k % 50 === 0 ? 0.6 : 0.3;
    ctx.lineWidth = k % 50 === 0 ? 1 : 0.6;
    ctx.beginPath(); ctx.moveTo(x0 + k * s, y0); ctx.lineTo(x0 + k * s, y0 + size); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(x0, y0 + size - k * s); ctx.lineTo(x0 + size, y0 + size - k * s); ctx.stroke();
  }
  ctx.restore();

  // The rim lock band, while a brush that cares about it is in hand.
  if (st.showLock) {
    const L = c.rimLockMM;
    ctx.save();
    ctx.globalAlpha = 0.18;
    ctx.fillStyle = th.dam;
    ctx.fillRect(x0, y0, size, L * s); ctx.fillRect(x0, y0 + size - L * s, size, L * s);
    ctx.fillRect(x0, y0, L * s, size); ctx.fillRect(x0 + size - L * s, y0, L * s, size);
    ctx.restore();
  }

  ctx.lineWidth = 1.5;
  ctx.strokeStyle = th.edge;
  roundRect(ctx, x0, y0, size, size, Math.max(2, 4 * s));
  ctx.stroke();

  drawGround(ctx, st, cam, th, 1);
  drawChannels(ctx, st, cam, th, { alpha: 1 });
  drawTileFeatures(ctx, st, cam, th, { alpha: 1 });

  // The ports: a mark on the middle of each side, filled where a channel
  // crosses, hollow where one could.
  const ports = st.say?.ports || {};
  const half = c.portWidthMM / 2;
  for (const e of EDGES) {
    const m = edgeMid(T, e);
    const along = e === 'N' || e === 'S' ? { x: 1, y: 0 } : { x: 0, y: 1 };
    const on = !!ports[e];
    const hot = st.hover?.kind === 'tile' && st.hover.port === e;
    ctx.strokeStyle = on ? th.water : hot ? th.select : th.ghost;
    ctx.lineWidth = on ? 5 : 3;
    ctx.lineCap = 'butt';
    ctx.beginPath();
    ctx.moveTo(cam.sx(m.x - along.x * half), cam.sy(m.y - along.y * half));
    ctx.lineTo(cam.sx(m.x + along.x * half), cam.sy(m.y + along.y * half));
    ctx.stroke();
    if (size > 260) {
      const dx = e === 'E' ? 1 : e === 'W' ? -1 : 0;
      const dy = e === 'N' ? 1 : e === 'S' ? -1 : 0;
      const label = on ? `channel ${c.portWidthMM}@${Math.round(c.edgeLandMM - c.channelDepthMM)}` : `port ${e}`;
      pill(ctx, cam.sx(m.x + dx * 24) + (dx ? dx * 20 : 0), cam.sy(m.y + dy * 14) - (dy ? dy * 4 : 0), label,
        { fill: th.panel, stroke: on ? th.water : th.ghost, ink: on ? th.ink : th.dim, font: '500 10px ui-monospace, Menlo, monospace' });
    }
  }

  // Labels: the name, and north.
  ctx.fillStyle = th.label;
  ctx.font = '700 13px system-ui, sans-serif';
  ctx.textBaseline = 'top'; ctx.textAlign = 'left';
  ctx.fillText(spec.name || 'module', x0 + 8, y0 + 7);
  ctx.font = '600 11px system-ui, sans-serif';
  ctx.textAlign = 'right';
  ctx.fillText('N ↑', x0 + size - 8, y0 + 7);
  ctx.font = '500 10px ui-monospace, Menlo, monospace';
  ctx.textBaseline = 'bottom';
  ctx.fillStyle = th.dim;
  ctx.fillText(`${T} mm`, x0 + size - 8, y0 + size - 6);

  // Selection outline for a wood or a channel is drawn by the features;
  // the gesture's preview is drawn by main.js on top.
  return { handles: handles(st, cam) };
}

/**
 * What is under a screen point: the module, with the port the point is
 * near if it is near one, or the margin.
 */
export function hitTile(st, cam, px, py) {
  const { spec } = st;
  const { T, marginMM } = dims(spec);
  const c = contractOf(spec);
  const pt = cam.toBoard(px, py);
  const inside = pt.x >= 0 && pt.y >= 0 && pt.x <= T && pt.y <= T;
  const inMargin = pt.x >= -marginMM && pt.y >= -marginMM && pt.x <= T + marginMM && pt.y <= T + marginMM;
  let port = null;
  let best = c.portSnapMM;
  for (const e of EDGES) {
    const m = edgeMid(T, e);
    const d = Math.hypot(pt.x - m.x, pt.y - m.y);
    if (d < best) { best = d; port = e; }
  }
  if (inside) return { kind: 'tile', pt, port, inside: true };
  if (inMargin) return { kind: 'margin', pt, port, inside: false };
  return { kind: 'empty', pt, inside: false };
}

/** A gesture's preview: a polyline, a polygon, or a circle, in module mm. */
export function drawPreview(ctx, g, cam, th) {
  ctx.save();
  ctx.strokeStyle = g.color || th.accent;
  ctx.fillStyle = g.color || th.accent;
  ctx.lineWidth = g.width ? Math.max(2, g.width * cam.s) : 2;
  ctx.lineJoin = 'round'; ctx.lineCap = g.width ? 'butt' : 'round';
  if (g.band && g.band.length) {
    ctx.save();
    ctx.globalAlpha = 0.3;
    ctx.beginPath();
    g.band.forEach((p, i) => (i ? ctx.lineTo(cam.sx(p[0]), cam.sy(p[1])) : ctx.moveTo(cam.sx(p[0]), cam.sy(p[1]))));
    ctx.stroke();
    ctx.restore();
  }
  ctx.lineWidth = 2;
  if (g.pts && g.pts.length) {
    ctx.setLineDash(g.dashed ? [5, 4] : []);
    ctx.beginPath();
    g.pts.forEach((p, i) => (i ? ctx.lineTo(cam.sx(p.x), cam.sy(p.y)) : ctx.moveTo(cam.sx(p.x), cam.sy(p.y))));
    if (g.cursor) ctx.lineTo(cam.sx(g.cursor.x), cam.sy(g.cursor.y));
    if (g.closed) ctx.closePath();
    ctx.stroke();
    ctx.setLineDash([]);
    if (!g.noDots) for (const p of g.pts) { ctx.beginPath(); ctx.arc(cam.sx(p.x), cam.sy(p.y), 3.5, 0, Math.PI * 2); ctx.fill(); }
  }
  if (g.circle) {
    ctx.setLineDash([6, 4]);
    ctx.beginPath();
    ctx.arc(cam.sx(g.circle.x), cam.sy(g.circle.y), g.circle.r * cam.s, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);
  }
  if (g.label) {
    pill(ctx, g.label.px, g.label.py, g.label.text, { fill: th.panel, stroke: g.color || th.accent, ink: th.ink });
  }
  ctx.restore();
}
