// view.js — the camera, the theme, and the drawing primitives both views share.
//
// The canvas works in MODULE MILLIMETRES, north up. The camera is the only
// thing that knows about pixels: screen x = ox + X*s, screen y = oy - Y*s.
// Row 0 is the south row, so the flip lives here and nowhere else.

/** Read the board colours from the stylesheet, so canvas and page share a theme. */
export function readTheme() {
  const cs = getComputedStyle(document.documentElement);
  const v = (k) => cs.getPropertyValue(k).trim();
  return {
    canvas: v('--c-canvas'), grid: v('--c-grid'), landLo: v('--c-land-lo'), landHi: v('--c-land-hi'),
    edge: v('--c-edge'), label: v('--c-label'), water: v('--c-water'), waterSoft: v('--c-water-soft'),
    dry: v('--c-dry'), fall: v('--c-fall'), dam: v('--c-dam'), spring: v('--c-spring'), spill: v('--c-spill'),
    headon: v('--c-headon'), cliff: v('--c-cliff'), ridge: v('--c-ridge'), wood: v('--c-wood'),
    select: v('--c-select'), ghost: v('--c-ghost'), margin: v('--c-margin'), ink: v('--ink'), dim: v('--dim'), panel: v('--panel'),
    accent: v('--accent'),
  };
}

/**
 * A camera that fits `box` (board mm) into a w x h canvas with `marginPx`
 * round it, then applies the user's zoom and pan (screen px).
 */
export function makeCamera({ width, height, box, zoom = 1, panX = 0, panY = 0, marginPx = 24 }) {
  const bw = Math.max(1, box.x1 - box.x0);
  const bh = Math.max(1, box.y1 - box.y0);
  const fit = Math.max(1e-3, Math.min((width - 2 * marginPx) / bw, (height - 2 * marginPx) / bh));
  const s = fit * zoom;
  const cx = (box.x0 + box.x1) / 2;
  const cy = (box.y0 + box.y1) / 2;
  const ox = width / 2 - cx * s + panX;
  const oy = height / 2 + cy * s + panY;
  return {
    s, ox, oy, fit, width, height, box,
    sx: (x) => ox + x * s,
    sy: (y) => oy - y * s,
    toBoard: (px, py) => ({ x: (px - ox) / s, y: (oy - py) / s }),
  };
}

/** The pan that keeps the board point under (px, py) still while the zoom changes. */
export function zoomAbout(cam, px, py, zoom, view) {
  const b = cam.toBoard(px, py);
  const s2 = cam.fit * zoom;
  const cx = (cam.box.x0 + cam.box.x1) / 2;
  const cy = (cam.box.y0 + cam.box.y1) / 2;
  return {
    ...view,
    zoom,
    panX: px - b.x * s2 - cam.width / 2 + cx * s2,
    panY: py + b.y * s2 - cam.height / 2 - cy * s2,
  };
}

export function roundRect(ctx, x, y, w, h, r) {
  const rr = Math.max(0, Math.min(r, Math.abs(w) / 2, Math.abs(h) / 2));
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

/** An arrowhead at (x, y) pointing along (dx, dy). */
export function arrowHead(ctx, x, y, dx, dy, size) {
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len;
  const uy = dy / len;
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.lineTo(x - ux * size - uy * size * 0.6, y - uy * size + ux * size * 0.6);
  ctx.lineTo(x - ux * size + uy * size * 0.6, y - uy * size - ux * size * 0.6);
  ctx.closePath();
  ctx.fill();
}

/** Mix two #rrggbb colours. */
export function mix(a, b, t) {
  const p = (c) => {
    const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(c || '');
    return m ? [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)] : [128, 128, 128];
  };
  const A = p(a);
  const B = p(b);
  const k = Math.max(0, Math.min(1, t));
  return `rgb(${A.map((v, i) => Math.round(v + (B[i] - v) * k)).join(',')})`;
}

/**
 * A badge: a pill of text centred on (x, y). Returns its rectangle, which is
 * what the pointer is tested against.
 */
export function pill(ctx, x, y, text, { fill, stroke, ink, dashed = false, font = '600 11px system-ui, sans-serif', h = 18 } = {}) {
  ctx.font = font;
  const w = Math.max(h, ctx.measureText(text).width + 12);
  const r = { x: x - w / 2, y: y - h / 2, w, h };
  roundRect(ctx, r.x, r.y, r.w, r.h, h / 2);
  if (fill) { ctx.fillStyle = fill; ctx.fill(); }
  if (stroke) {
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = stroke;
    if (dashed) ctx.setLineDash([3, 2.5]);
    ctx.stroke();
    ctx.setLineDash([]);
  }
  ctx.fillStyle = ink;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, x, y + 0.5);
  return r;
}

/** Douglas-Peucker, for a freehand line that should come out as a few vertices. */
export function simplify(pts, tol) {
  if (pts.length < 3) return pts.slice();
  const keep = new Uint8Array(pts.length);
  keep[0] = 1;
  keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    let best = -1;
    let bestD = tol;
    const ax = pts[a].x; const ay = pts[a].y;
    const dx = pts[b].x - ax; const dy = pts[b].y - ay;
    const L = Math.hypot(dx, dy) || 1;
    for (let i = a + 1; i < b; i++) {
      const d = Math.abs((pts[i].x - ax) * dy - (pts[i].y - ay) * dx) / L;
      if (d > bestD) { bestD = d; best = i; }
    }
    if (best >= 0) { keep[best] = 1; stack.push([a, best], [best, b]); }
  }
  return pts.filter((_, i) => keep[i]);
}

/** Even-odd point in polygon, [[x, y], ...]. */
export function inPolygon(poly, x, y) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export const distToSegment = (px, py, ax, ay, bx, by) => {
  const dx = bx - ax;
  const dy = by - ay;
  const L2 = dx * dx + dy * dy;
  const t = L2 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / L2)) : 0;
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
};
