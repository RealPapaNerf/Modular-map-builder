// features.js — the things drawn ON the ground, and the handles to move them.
//
// Two kinds, because the generator reads them in two frames:
//
//   ground  the spine, volcanoes and flats belong to the WORLD and run across
//           tiles. Stored as fractions of the whole map; drawn in board mm.
//   tile    a lake, a spring, a wood's outline belong to ONE TILE's design,
//           in its own millimetres. On the board they turn with the piece.

import { dims, toBoard, metresPerMM, parseLabel } from './specops.js';
import { inPolygon, distToSegment } from './view.js';

/** A design's tile-local point, as it sits on the board after `rot` quarter turns. */
export function localToBoard(T, col, row, rot, x, y) {
  let dx = x - T / 2;
  let dy = y - T / 2;
  for (let i = 0; i < (rot || 0); i++) [dx, dy] = [dy, -dx];
  return { x: col * T + T / 2 + dx, y: row * T + T / 2 + dy };
}

/** And back: a board point to a tile's own millimetres, undoing its turn. */
export function boardToLocal(T, col, row, rot, X, Y) {
  let dx = X - (col * T + T / 2);
  let dy = Y - (row * T + T / 2);
  for (let i = 0; i < (rot || 0); i++) [dx, dy] = [-dy, dx];
  return { x: dx + T / 2, y: dy + T / 2 };
}

const volcanoR = (spec, v) => v.baseRadiusM ?? (spec.worldSizeM || 16000) * 0.18;
const flatR = (spec, f) => f.radiusM ?? (spec.worldSizeM || 16000) * 0.1;

/* ----------------------------------------------------------------- ground */

/** The spine, the volcanoes and the flats. */
export function drawGround(ctx, st, cam, th, alpha = 1) {
  const { spec } = st;
  const m = metresPerMM(spec);
  ctx.save();
  ctx.globalAlpha = alpha;
  if (Array.isArray(spec.spine) && spec.spine.length >= 2) {
    const pts = spec.spine.map((p) => toBoard(spec, p));
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
    const c = toBoard(spec, v.at);
    const R = volcanoR(spec, v);
    const rx = R / m.x; const ry = R / m.y;
    ctx.strokeStyle = th.ridge; ctx.lineWidth = 1.6; ctx.setLineDash([6, 4]);
    ctx.beginPath(); ctx.ellipse(cam.sx(c.x), cam.sy(c.y), rx * cam.s, ry * cam.s, 0, 0, Math.PI * 2); ctx.stroke();
    ctx.setLineDash([]);
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.ellipse(cam.sx(c.x), cam.sy(c.y), rx * cam.s * 0.5, ry * cam.s * 0.5, 0, 0, Math.PI * 2); ctx.stroke();
    const cr = Math.max(4, ((v.craterRadiusM ?? 400) / m.x) * cam.s);
    ctx.fillStyle = th.ridge;
    ctx.beginPath(); ctx.arc(cam.sx(c.x), cam.sy(c.y), cr, 0, Math.PI * 2);
    if (cr < 12) ctx.fill(); else { ctx.lineWidth = 2; ctx.stroke(); ctx.beginPath(); ctx.arc(cam.sx(c.x), cam.sy(c.y), 4, 0, Math.PI * 2); ctx.fill(); }
    if (Number.isFinite(v.breachAzimuthDeg)) {
      // The azimuth the generator reads: atan2(dy, dx) in the world, so 0 is east and 90 north.
      const a = (v.breachAzimuthDeg * Math.PI) / 180;
      ctx.strokeStyle = th.ridge; ctx.lineWidth = 2.5;
      ctx.beginPath(); ctx.moveTo(cam.sx(c.x), cam.sy(c.y));
      ctx.lineTo(cam.sx(c.x + Math.cos(a) * rx * 0.55), cam.sy(c.y + Math.sin(a) * ry * 0.55)); ctx.stroke();
    }
  }
  for (const f of spec.flats || []) {
    const c = toBoard(spec, f.at);
    const R = flatR(spec, f);
    ctx.strokeStyle = th.ridge; ctx.lineWidth = 1.5; ctx.setLineDash([2, 4]);
    ctx.beginPath(); ctx.ellipse(cam.sx(c.x), cam.sy(c.y), (R / m.x) * cam.s, (R / m.y) * cam.s, 0, 0, Math.PI * 2); ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = th.ridge;
    ctx.fillRect(cam.sx(c.x) - 4, cam.sy(c.y) - 1.5, 8, 3);
  }
  ctx.restore();
}

/* ------------------------------------------------------------------- tile */

/** Where each tile sits and how it is turned, for the tile features. */
function seat(st, label, overrideRot = null) {
  const p = parseLabel(label);
  if (!p) return null;
  const t = st.plan?.tiles?.find((q) => q.col === p.col && q.row === p.row);
  return { col: p.col, row: p.row, rot: overrideRot ?? (t ? t.rot : 0) };
}

/** Lakes and springs placed by hand, and woods drawn as shapes. */
export function drawTileFeatures(ctx, st, cam, th, { alpha = 1, only = null, unturned = null } = {}) {
  const { spec } = st;
  const { T } = dims(spec);
  ctx.save();
  ctx.globalAlpha = alpha;
  const where = (label, x, y) => {
    const s = seat(st, label, unturned && unturned === label ? 0 : null);
    return s ? localToBoard(T, s.col, s.row, s.rot, x, y) : null;
  };
  (spec.canopy || []).forEach((layer) => {
    if (!Array.isArray(layer.region) || layer.region.length < 3) return;
    for (const label of layer.tiles || []) {
      if (only && label !== only) continue;
      const pts = layer.region.map(([x, y]) => where(label, x, y)).filter(Boolean);
      if (pts.length < 3) continue;
      ctx.beginPath();
      pts.forEach((p, i) => (i ? ctx.lineTo(cam.sx(p.x), cam.sy(p.y)) : ctx.moveTo(cam.sx(p.x), cam.sy(p.y))));
      ctx.closePath();
      ctx.save();
      ctx.globalAlpha *= 0.22;
      ctx.fillStyle = th.wood;
      ctx.fill();
      ctx.restore();
      ctx.strokeStyle = th.wood; ctx.lineWidth = 1.8; ctx.stroke();
      // A few crowns inside, so it reads as wood.
      const c = pts.reduce((a, p) => ({ x: a.x + p.x / pts.length, y: a.y + p.y / pts.length }), { x: 0, y: 0 });
      ctx.fillStyle = th.wood;
      for (const [ox, oy] of [[0, 0], [-6, -4], [6, -3], [-2, 6], [5, 5]]) {
        ctx.beginPath(); ctx.arc(cam.sx(c.x + ox), cam.sy(c.y + oy), Math.max(2, 2.2 * cam.s), 0, Math.PI * 2); ctx.fill();
      }
    }
  });
  for (const spot of spec.lakes?.place || []) {
    if (!spot.tile || (only && spot.tile !== only) || !Array.isArray(spot.atMM)) continue;
    const p = where(spot.tile, spot.atMM[0], spot.atMM[1]);
    if (!p) continue;
    const r = Math.max(5, 9 * cam.s);
    ctx.fillStyle = th.waterSoft;
    ctx.beginPath(); ctx.ellipse(cam.sx(p.x), cam.sy(p.y), r * 1.3, r, 0, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = th.water; ctx.lineWidth = 1.5; ctx.stroke();
    ctx.fillStyle = th.water;
    ctx.beginPath(); ctx.arc(cam.sx(p.x), cam.sy(p.y), 2.5, 0, Math.PI * 2); ctx.fill();
  }
  for (const spot of spec.fountains?.place || []) {
    if (!spot.tile || (only && spot.tile !== only) || !Array.isArray(spot.atMM)) continue;
    const p = where(spot.tile, spot.atMM[0], spot.atMM[1]);
    if (!p) continue;
    const r = Math.max(4, (spec.fountains.poolRadiusMM ?? 16) * cam.s);
    ctx.strokeStyle = th.spring; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.arc(cam.sx(p.x), cam.sy(p.y), r, 0, Math.PI * 2); ctx.stroke();
    ctx.fillStyle = th.spring;
    ctx.beginPath(); ctx.arc(cam.sx(p.x), cam.sy(p.y), Math.max(3, r * 0.35), 0, Math.PI * 2); ctx.fill();
  }
  ctx.restore();
}

/* ---------------------------------------------------------------- handles */

/**
 * Every handle a pointer can grab, in screen px. Ground handles everywhere;
 * tile handles only for `label` (the tile view's focus), unturned.
 */
export function handles(st, cam, { label = null } = {}) {
  const { spec } = st;
  const { T } = dims(spec);
  const m = metresPerMM(spec);
  const out = [];
  (spec.spine || []).forEach((p, i) => {
    const b = toBoard(spec, p);
    out.push({ kind: 'spine', index: i, x: cam.sx(b.x), y: cam.sy(b.y), r: 8 });
  });
  (spec.volcanoes || []).forEach((v, i) => {
    const b = toBoard(spec, v.at);
    const R = volcanoR(spec, v);
    out.push({ kind: 'volcano', index: i, x: cam.sx(b.x), y: cam.sy(b.y), r: 10 });
    out.push({ kind: 'volcano-rim', index: i, x: cam.sx(b.x + R / m.x), y: cam.sy(b.y), r: 7 });
  });
  (spec.flats || []).forEach((f, i) => {
    const b = toBoard(spec, f.at);
    const R = flatR(spec, f);
    out.push({ kind: 'flat', index: i, x: cam.sx(b.x), y: cam.sy(b.y), r: 9 });
    out.push({ kind: 'flat-rim', index: i, x: cam.sx(b.x + R / m.x), y: cam.sy(b.y), r: 7 });
  });
  if (label) {
    const p = parseLabel(label);
    const at = (x, y) => localToBoard(T, p.col, p.row, 0, x, y);
    (spec.lakes?.place || []).forEach((s, i) => {
      if (s.tile !== label || !Array.isArray(s.atMM)) return;
      const b = at(s.atMM[0], s.atMM[1]);
      out.push({ kind: 'lake', index: i, x: cam.sx(b.x), y: cam.sy(b.y), r: 10 });
    });
    (spec.fountains?.place || []).forEach((s, i) => {
      if (s.tile !== label || !Array.isArray(s.atMM)) return;
      const b = at(s.atMM[0], s.atMM[1]);
      out.push({ kind: 'springpoint', index: i, x: cam.sx(b.x), y: cam.sy(b.y), r: 10 });
    });
    (spec.canopy || []).forEach((layer, li) => {
      if (!Array.isArray(layer.region) || !(layer.tiles || []).includes(label)) return;
      layer.region.forEach(([x, y], vi) => {
        const b = at(x, y);
        out.push({ kind: 'wood-vertex', index: li, vertex: vi, x: cam.sx(b.x), y: cam.sy(b.y), r: 7 });
      });
      out.push({ kind: 'wood', index: li, poly: layer.region.map(([x, y]) => { const b = at(x, y); return [cam.sx(b.x), cam.sy(b.y)]; }) });
    });
    for (const [k, dc, dr] of [['sw', 0, 0], ['se', 1, 0], ['nw', 0, 1], ['ne', 1, 1]]) {
      out.push({ kind: 'corner', corner: k, cc: p.col + dc, rr: p.row + dr, x: cam.sx((p.col + dc) * T), y: cam.sy((p.row + dr) * T), r: 16 });
    }
  }
  return out;
}

/** The handle under a screen point: the nearest point handle, then the spine, then a wood's inside. */
export function hitHandle(list, px, py, { corners = false, spineLine = false } = {}) {
  let best = null;
  let bestD = Infinity;
  for (const h of list) {
    if (h.kind === 'wood') continue;
    if (h.kind === 'corner' && !corners) continue;
    const d = Math.hypot(px - h.x, py - h.y);
    if (d <= h.r && d < bestD) { best = h; bestD = d; }
  }
  if (best) return best;
  if (spineLine) {
    const sp = list.filter((h) => h.kind === 'spine');
    for (let i = 1; i < sp.length; i++) {
      if (distToSegment(px, py, sp[i - 1].x, sp[i - 1].y, sp[i].x, sp[i].y) < 6) return { kind: 'spine-line', index: i };
    }
  }
  for (const h of list) if (h.kind === 'wood' && inPolygon(h.poly, px, py)) return h;
  return null;
}
