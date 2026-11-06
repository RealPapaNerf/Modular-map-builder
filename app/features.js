// features.js — the things drawn ON the module, and the handles to move them.
//
// All in module mm, which is the one frame there is now: the ridge, the
// volcanoes and the flats (which may run out into the margin), and the
// channels, lakes, springs and woods (which are on the module).

import { dims, channelEnds } from './specops.js';
import { CHANNEL_DEFAULTS } from '../lib/channel.js';
import { inPolygon, distToSegment } from './view.js';

const volcanoR = (spec, v) => v.baseRadiusMM ?? dims(spec).T * 0.36;
const flatR = (spec, f) => f.radiusMM ?? dims(spec).T * 0.2;

/* ----------------------------------------------------------------- ground */

/** The ridge, the volcanoes and the flats. */
export function drawGround(ctx, st, cam, th, alpha = 1) {
  const { spec } = st;
  ctx.save();
  ctx.globalAlpha = alpha;
  if (Array.isArray(spec.spine) && spec.spine.length >= 2) {
    const pts = spec.spine.map(([x, y]) => ({ x, y }));
    ctx.strokeStyle = th.ridge; ctx.lineWidth = 3; ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    ctx.beginPath();
    pts.forEach((p, i) => (i ? ctx.lineTo(cam.sx(p.x), cam.sy(p.y)) : ctx.moveTo(cam.sx(p.x), cam.sy(p.y))));
    ctx.stroke();
    // Ticks down the flanks, so a ridge reads as a ridge and not a road.
    ctx.lineWidth = 1.2;
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1]; const b = pts[i];
      const L = Math.hypot(b.x - a.x, b.y - a.y) || 1;
      const n = Math.floor(L / 16);
      const nx = -(b.y - a.y) / L; const ny = (b.x - a.x) / L;
      for (let k = 1; k < n; k++) {
        const t = k / n;
        const x = a.x + (b.x - a.x) * t; const y = a.y + (b.y - a.y) * t;
        for (const sgn of [1, -1]) {
          ctx.beginPath(); ctx.moveTo(cam.sx(x + nx * 2.5 * sgn), cam.sy(y + ny * 2.5 * sgn));
          ctx.lineTo(cam.sx(x + nx * 8 * sgn), cam.sy(y + ny * 8 * sgn)); ctx.stroke();
        }
      }
    }
    ctx.fillStyle = th.ridge;
    for (const p of pts) { ctx.beginPath(); ctx.arc(cam.sx(p.x), cam.sy(p.y), 4, 0, Math.PI * 2); ctx.fill(); }
  }
  for (const v of spec.volcanoes || []) {
    const [cx, cy] = v.at;
    const R = volcanoR(spec, v);
    ctx.strokeStyle = th.ridge; ctx.lineWidth = 1.6; ctx.setLineDash([6, 4]);
    ctx.beginPath(); ctx.arc(cam.sx(cx), cam.sy(cy), R * cam.s, 0, Math.PI * 2); ctx.stroke();
    ctx.setLineDash([]);
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.arc(cam.sx(cx), cam.sy(cy), R * cam.s * 0.5, 0, Math.PI * 2); ctx.stroke();
    const cr = Math.max(4, (v.craterRadiusMM ?? 16) * cam.s);
    ctx.fillStyle = th.ridge;
    ctx.beginPath(); ctx.arc(cam.sx(cx), cam.sy(cy), cr, 0, Math.PI * 2);
    if (cr < 12) ctx.fill(); else { ctx.lineWidth = 2; ctx.stroke(); ctx.beginPath(); ctx.arc(cam.sx(cx), cam.sy(cy), 4, 0, Math.PI * 2); ctx.fill(); }
    if (Number.isFinite(v.breachAzimuthDeg)) {
      const a = (v.breachAzimuthDeg * Math.PI) / 180;
      ctx.strokeStyle = th.ridge; ctx.lineWidth = 2.5;
      ctx.beginPath(); ctx.moveTo(cam.sx(cx), cam.sy(cy));
      ctx.lineTo(cam.sx(cx + Math.cos(a) * R * 0.55), cam.sy(cy + Math.sin(a) * R * 0.55)); ctx.stroke();
    }
  }
  for (const f of spec.flats || []) {
    const [cx, cy] = f.at;
    const R = flatR(spec, f);
    ctx.strokeStyle = th.ridge; ctx.lineWidth = 1.5; ctx.setLineDash([2, 4]);
    ctx.beginPath(); ctx.arc(cam.sx(cx), cam.sy(cy), R * cam.s, 0, Math.PI * 2); ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = th.ridge;
    ctx.fillRect(cam.sx(cx) - 4, cam.sy(cy) - 1.5, 8, 3);
  }
  ctx.restore();
}

/* --------------------------------------------------------------- channels */

/**
 * The channels: the line as drawn, faint, and the line as it will be cut --
 * its ends snapped to the ports -- as a band the channel's width.
 */
export function drawChannels(ctx, st, cam, th, { alpha = 1 } = {}) {
  const { spec } = st;
  ctx.save();
  ctx.globalAlpha = alpha;
  (spec.channels || []).forEach((ch, i) => {
    const w = Number(ch.widthMM) || CHANNEL_DEFAULTS.widthMM;
    const sel = st.selection?.type === 'channel' && st.selection.index === i;
    const ends = channelEnds(spec, ch);
    const cut = ends?.pts;
    if (cut) {
      ctx.strokeStyle = th.waterSoft; ctx.lineWidth = Math.max(2, w * cam.s); ctx.lineJoin = 'round'; ctx.lineCap = 'butt';
      ctx.beginPath();
      cut.forEach((p, k) => (k ? ctx.lineTo(cam.sx(p[0]), cam.sy(p[1])) : ctx.moveTo(cam.sx(p[0]), cam.sy(p[1]))));
      ctx.stroke();
    }
    if (Array.isArray(ch.path)) {
      ctx.strokeStyle = sel ? th.select : th.water; ctx.lineWidth = sel ? 2.5 : 1.6; ctx.setLineDash(cut ? [] : [4, 4]);
      ctx.beginPath();
      ch.path.forEach((p, k) => (k ? ctx.lineTo(cam.sx(p[0]), cam.sy(p[1])) : ctx.moveTo(cam.sx(p[0]), cam.sy(p[1]))));
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = th.water;
      for (const p of ch.path) { ctx.beginPath(); ctx.arc(cam.sx(p[0]), cam.sy(p[1]), sel ? 4 : 2.5, 0, Math.PI * 2); ctx.fill(); }
    } else if (cut) {
      // Routed: no line of its own, only where it comes in and goes out.
      ctx.strokeStyle = sel ? th.select : th.water; ctx.lineWidth = 1.2; ctx.setLineDash([3, 5]);
      ctx.beginPath();
      cut.forEach((p, k) => (k ? ctx.lineTo(cam.sx(p[0]), cam.sy(p[1])) : ctx.moveTo(cam.sx(p[0]), cam.sy(p[1]))));
      ctx.stroke();
      ctx.setLineDash([]);
    }
  });
  ctx.restore();
}

/* -------------------------------------------------------------------- on it */

/** Lakes and springs placed by hand, and woods drawn as shapes. */
export function drawTileFeatures(ctx, st, cam, th, { alpha = 1 } = {}) {
  const { spec } = st;
  ctx.save();
  ctx.globalAlpha = alpha;
  (spec.canopy || []).forEach((layer) => {
    if (!Array.isArray(layer.region) || layer.region.length < 3) return;
    const pts = layer.region;
    ctx.beginPath();
    pts.forEach((p, i) => (i ? ctx.lineTo(cam.sx(p[0]), cam.sy(p[1])) : ctx.moveTo(cam.sx(p[0]), cam.sy(p[1]))));
    ctx.closePath();
    ctx.save();
    ctx.globalAlpha *= 0.22;
    ctx.fillStyle = th.wood;
    ctx.fill();
    ctx.restore();
    ctx.strokeStyle = th.wood; ctx.lineWidth = 1.8; ctx.stroke();
    const c = pts.reduce((a, p) => ({ x: a.x + p[0] / pts.length, y: a.y + p[1] / pts.length }), { x: 0, y: 0 });
    ctx.fillStyle = th.wood;
    for (const [ox, oy] of [[0, 0], [-6, -4], [6, -3], [-2, 6], [5, 5]]) {
      ctx.beginPath(); ctx.arc(cam.sx(c.x + ox), cam.sy(c.y + oy), Math.max(2, 2.2 * cam.s), 0, Math.PI * 2); ctx.fill();
    }
  });
  for (const spot of spec.lakes?.place || []) {
    if (Array.isArray(spot.pathMM) && spot.pathMM.length > 1) {
      ctx.strokeStyle = th.waterSoft; ctx.lineWidth = Math.max(3, 2 * (spot.radiusMM || 10) * cam.s); ctx.lineCap = 'round'; ctx.lineJoin = 'round';
      ctx.beginPath();
      spot.pathMM.forEach((p, i) => (i ? ctx.lineTo(cam.sx(p[0]), cam.sy(p[1])) : ctx.moveTo(cam.sx(p[0]), cam.sy(p[1]))));
      ctx.stroke();
      continue;
    }
    if (!Array.isArray(spot.atMM)) continue;
    const [x, y] = spot.atMM;
    const r = Math.max(5, (spot.radiusMM || 9) * cam.s);
    ctx.fillStyle = th.waterSoft;
    ctx.beginPath(); ctx.ellipse(cam.sx(x), cam.sy(y), r * 1.3, r, 0, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = th.water; ctx.lineWidth = 1.5; ctx.stroke();
    ctx.fillStyle = th.water;
    ctx.beginPath(); ctx.arc(cam.sx(x), cam.sy(y), 2.5, 0, Math.PI * 2); ctx.fill();
  }
  for (const spot of spec.fountains?.place || []) {
    if (!Array.isArray(spot.atMM)) continue;
    const [x, y] = spot.atMM;
    const r = Math.max(4, (spec.fountains.poolRadiusMM ?? 16) * cam.s);
    ctx.strokeStyle = th.spring; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.arc(cam.sx(x), cam.sy(y), r, 0, Math.PI * 2); ctx.stroke();
    ctx.fillStyle = th.spring;
    ctx.beginPath(); ctx.arc(cam.sx(x), cam.sy(y), Math.max(3, r * 0.35), 0, Math.PI * 2); ctx.fill();
  }
  ctx.restore();
}

/* ---------------------------------------------------------------- handles */

/** Every handle a pointer can grab, in screen px. */
export function handles(st, cam) {
  const { spec } = st;
  const out = [];
  (spec.spine || []).forEach(([x, y], i) => out.push({ kind: 'spine', index: i, x: cam.sx(x), y: cam.sy(y), r: 8 }));
  (spec.volcanoes || []).forEach((v, i) => {
    const [x, y] = v.at;
    out.push({ kind: 'volcano', index: i, x: cam.sx(x), y: cam.sy(y), r: 10 });
    out.push({ kind: 'volcano-rim', index: i, x: cam.sx(x + volcanoR(spec, v)), y: cam.sy(y), r: 7 });
  });
  (spec.flats || []).forEach((f, i) => {
    const [x, y] = f.at;
    out.push({ kind: 'flat', index: i, x: cam.sx(x), y: cam.sy(y), r: 9 });
    out.push({ kind: 'flat-rim', index: i, x: cam.sx(x + flatR(spec, f)), y: cam.sy(y), r: 7 });
  });
  (spec.channels || []).forEach((ch, i) => {
    if (!Array.isArray(ch.path)) return;
    ch.path.forEach(([x, y], vi) => out.push({ kind: 'channel-vertex', index: i, vertex: vi, x: cam.sx(x), y: cam.sy(y), r: 7 }));
    out.push({ kind: 'channel', index: i, line: ch.path.map(([x, y]) => [cam.sx(x), cam.sy(y)]) });
  });
  (spec.lakes?.place || []).forEach((s, i) => {
    if (!Array.isArray(s.atMM)) return;
    out.push({ kind: 'lake', index: i, x: cam.sx(s.atMM[0]), y: cam.sy(s.atMM[1]), r: 10 });
  });
  (spec.fountains?.place || []).forEach((s, i) => {
    if (!Array.isArray(s.atMM)) return;
    out.push({ kind: 'springpoint', index: i, x: cam.sx(s.atMM[0]), y: cam.sy(s.atMM[1]), r: 10 });
  });
  (spec.canopy || []).forEach((layer, li) => {
    if (!Array.isArray(layer.region)) return;
    layer.region.forEach(([x, y], vi) => out.push({ kind: 'wood-vertex', index: li, vertex: vi, x: cam.sx(x), y: cam.sy(y), r: 7 }));
    out.push({ kind: 'wood', index: li, poly: layer.region.map(([x, y]) => [cam.sx(x), cam.sy(y)]) });
  });
  return out;
}

/** The handle under a screen point: the nearest point handle, then a channel's line, then a wood's inside. */
export function hitHandle(list, px, py) {
  let best = null;
  let bestD = Infinity;
  for (const h of list) {
    if (h.kind === 'wood' || h.kind === 'channel') continue;
    const d = Math.hypot(px - h.x, py - h.y);
    if (d <= h.r && d < bestD) { best = h; bestD = d; }
  }
  if (best) return best;
  for (const h of list) {
    if (h.kind !== 'channel') continue;
    for (let i = 1; i < h.line.length; i++) {
      if (distToSegment(px, py, h.line[i - 1][0], h.line[i - 1][1], h.line[i][0], h.line[i][1]) < 7) return h;
    }
  }
  for (const h of list) if (h.kind === 'wood' && inPolygon(h.poly, px, py)) return h;
  return null;
}
