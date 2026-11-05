// tools.js — what each tool does with the pointer.
//
// A tool is an object with down / move / up (and optionally hover, key,
// cancel). It never keeps the document: it calls the api, the api edits the
// spec through specops.js, and everything is redrawn from the spec. A drag
// that should update the canvas while it moves uses api.live, which replays
// the edit onto the spec as it was when the drag began, so a drag is one
// undo step however many times it moved.
//
// The event every tool sees: { px, py, pt, hit, handle, ev } -- screen px,
// module mm, what tilecanvas.js and the handles say is under the pointer,
// and the event.

import * as ops from './specops.js';
import { dims } from './specops.js';
import { WIDTHS } from '../lib/contract.js';
import { snapToPorts, CHANNEL_DEFAULTS } from '../lib/channel.js';

/** Snap to whole millimetres, or to 10 mm with Shift held. */
export const snap = (pt, ev) => {
  const q = ev?.shiftKey ? 10 : 1;
  return { x: Math.round(pt.x / q) * q, y: Math.round(pt.y / q) * q };
};

const clampMM = (v, T) => Math.round(Math.max(0, Math.min(T, v)) * 10) / 10;

/* ---------------------------------------------------------- shared drags */

/** Dragging something already placed, from the select tool, on whatever the handles say is under the pointer. */
function dragHandle(api, h, e) {
  const st = api.state;
  const { T } = dims(st.spec);
  const start = e.pt;
  api.begin();
  const g = { kind: 'handle', h, start, moved: false };
  g.move = (e2) => {
    const p = snap(e2.pt, e2.ev);
    g.moved = g.moved || Math.hypot(e2.px - e.px, e2.py - e.py) > 3;
    if (!g.moved) return;
    api.live((s) => {
      switch (h.kind) {
        case 'spine': case 'volcano': case 'flat': case 'lake': case 'springpoint':
          ops.moveFeature(s, h.kind, h.index, p); break;
        case 'channel-vertex': case 'wood-vertex':
          ops.moveFeature(s, h.kind, h.index, p, h.vertex); break;
        case 'volcano-rim':
        case 'flat-rim': {
          const list = h.kind === 'volcano-rim' ? s.volcanoes : s.flats;
          const [cx, cy] = list[h.index].at;
          const r = Math.max(5, Math.round(Math.hypot(p.x - cx, p.y - cy)));
          if (h.kind === 'volcano-rim') list[h.index].baseRadiusMM = r; else list[h.index].radiusMM = r;
          break;
        }
        case 'wood': case 'channel':
          ops.shiftFeature(s, h.kind, h.index, Math.round(e2.pt.x - start.x), Math.round(e2.pt.y - start.y)); break;
        default: break;
      }
    });
  };
  g.up = () => {
    if (g.moved) api.end(`move ${h.kind.replace('-rim', ' size').replace('-vertex', ' point')}`);
    else api.cancel();
    api.select(selectionFor(h));
  };
  return g;
}

function selectionFor(h) {
  switch (h.kind) {
    case 'spine': return { type: 'spine', vertex: h.index };
    case 'volcano': case 'volcano-rim': return { type: 'volcano', index: h.index };
    case 'flat': case 'flat-rim': return { type: 'flat', index: h.index };
    case 'lake': return { type: 'lake', index: h.index };
    case 'springpoint': return { type: 'springpoint', index: h.index };
    case 'wood': case 'wood-vertex': return { type: 'wood', index: h.index };
    case 'channel': case 'channel-vertex': return { type: 'channel', index: h.index };
    default: return null;
  }
}

/** Pan the view by dragging empty space. */
function panDrag(api, e) {
  const v0 = { ...api.state.view };
  return {
    kind: 'pan',
    move: (e2) => api.setView({ ...api.state.view, panX: v0.panX + (e2.px - e.px), panY: v0.panY + (e2.py - e.py) }),
    up: () => {},
  };
}

/* ------------------------------------------------------------------ tools */

const select = {
  id: 'select', label: 'Select', glyph: '↖', key: 'V',
  hint: 'Click a channel, a lake, a wood or a ridge point to see it in the inspector, and drag it to move it. Drag empty space to pan.',
  down(api, e) {
    const h = e.handle;
    if (h) return dragHandle(api, h, e);
    api.select(null);
    return panDrag(api, e);
  },
};

const channel = {
  id: 'channel', label: 'Channel', glyph: '∿', key: 'W',
  hint: 'Drag a line across the module. Start or finish on a port mark (the middle of a side) to have the channel cross the rim there; an end within reach of a side snaps to its port. The channel is cut this wide and this deep, in a ) cross-section.',
  palette: (api) => [
    {
      chips: WIDTHS.map((w) => [w, `${w}`]),
      value: api.state.palette.channelWidth,
      pick: (v) => api.setPalette({ channelWidth: v }),
      note: 'Width, bank to bank, in mm. Where it crosses the rim it is the port\'s width, so that any two modules meet.',
    },
    {
      chips: [[5, '5'], [8, '8'], [10, '10'], [15, '15']],
      value: api.state.palette.channelDepth,
      pick: (v) => api.setPalette({ channelDepth: v }),
      note: 'Depth below the ground along the line, in mm. The floor follows the ground, smoothed; the report says where it climbs.',
    },
  ],
  down(api, e) {
    const pts = [e.pt];
    const g = { kind: 'channel', pts };
    const c = ops.contractOf(api.state.spec);
    const width = api.state.palette.channelWidth;
    const show = () => {
      const snapped = snapToPorts(c, pts.map((p) => [p.x, p.y]), width);
      g.snapped = snapped;
      g.preview = { pts: pts.slice(), color: api.theme().water, noDots: true, band: snapped?.pts || null, width };
    };
    show();
    g.move = (e2) => {
      const last = pts[pts.length - 1];
      if (Math.hypot(e2.pt.x - last.x, e2.pt.y - last.y) < 2) return;
      pts.push(e2.pt);
      show();
      api.redraw();
    };
    g.up = () => {
      if (!g.snapped) { api.say('A channel needs a line on the module: drag across it, and start or finish on a port to cross the rim.', 'warn'); return; }
      let index = -1;
      api.commit((s) => { index = ops.addChannel(s, pts, { widthMM: width, depthMM: api.state.palette.channelDepth }); }, 'draw a channel');
      if (index >= 0) api.select({ type: 'channel', index });
    };
    return g;
  },
};

/** Click points; double-click, Enter or a click on the first point finishes. */
function polyline(api, e, { closeOnFirst = false, finish, color }) {
  const st = api.state;
  const existing = st.gesture?.kind === 'poly' ? st.gesture : null;
  const p = snap(e.pt, e.ev);
  if (existing) {
    if (closeOnFirst && existing.pts.length >= 3 && Math.hypot(e.px - existing.firstPx.x, e.py - existing.firstPx.y) < 10) {
      existing.finish();
      return null;
    }
    const last = existing.pts[existing.pts.length - 1];
    if (!last || last.x !== p.x || last.y !== p.y) existing.pts.push(p);
    existing.preview.pts = existing.pts.slice();
    return existing;
  }
  const g = {
    kind: 'poly', sticky: true, pts: [p], firstPx: { x: e.px, y: e.py },
    preview: { pts: [p], color, closed: closeOnFirst },
  };
  g.hover = (e2) => { g.preview.cursor = snap(e2.pt, e2.ev); };
  g.finish = () => { api.clearGesture(); finish(g.pts); };
  g.cancel = () => api.clearGesture();
  return g;
}

const ridge = {
  id: 'ridge', label: 'Ridge', glyph: '⋀', key: 'I',
  hint: 'Click along the crest of the range, then double-click or press Enter. It can run out into the margin, where the ice comes down from. The module has one ridge; drawing another replaces it. Shift snaps to 10 mm.',
  palette: (api) => [{ note: `Peak height ${api.state.spec.spineHeightMM ?? 60} mm: set it, and the ridge width, with the ridge selected.` }],
  down(api, e) {
    return polyline(api, e, {
      color: api.theme().ridge,
      finish: (pts) => {
        if (pts.length < 2) { api.say('A ridge needs two points at least.', 'warn'); return; }
        api.commit((s) => ops.setSpine(s, pts), 'draw the ridge');
        api.select({ type: 'spine' });
      },
    });
  },
};

function circleTool(id, label, glyph, key, hint, add, defaultMM) {
  return {
    id, label, glyph, key, hint,
    down(api, e) {
      const c = snap(e.pt, e.ev);
      const g = { kind: id, c, r: 0 };
      g.preview = { circle: { x: c.x, y: c.y, r: defaultMM }, color: api.theme().ridge };
      g.move = (e2) => {
        g.r = Math.round(Math.hypot(e2.pt.x - c.x, e2.pt.y - c.y));
        const r = Math.max(5, g.r);
        g.preview = { circle: { x: c.x, y: c.y, r }, color: api.theme().ridge, label: { px: e2.px + 16, py: e2.py - 12, text: `${r} mm` } };
        api.redraw();
      };
      g.up = () => {
        const r = g.r >= 5 ? g.r : defaultMM;
        let index = -1;
        api.commit((s) => { index = add(s, c, r); }, `place a ${label.toLowerCase()}`);
        api.select({ type: id, index });
      };
      return g;
    },
  };
}

const volcano = circleTool('volcano', 'Volcano', '▲', 'O',
  'Press where the vent is and drag out to the foot of the cone. Height, crater and the breach are in the inspector.',
  (s, c, r) => ops.addVolcano(s, c, r), 70);
const flat = circleTool('flat', 'Flat', '▭', 'L',
  'Press and drag out a place the module should keep level: a plain, a plateau, somewhere to put a town.',
  (s, c, r) => ops.addFlat(s, c, r), 40);

/** Round 10 mm steps, fine to broad; the wide end lays down a landform in one pass. */
const BRUSH_WIDTHS = [10, 20, 30, 50, 80, 120];
const widthChips = (api) => ({
  chips: BRUSH_WIDTHS.map((w) => [w, `${w}`]),
  value: api.state.palette.brushWidth,
  pick: (v) => api.setPalette({ brushWidth: v }),
  note: 'Brush width, in mm. It fades to nothing over the last 12 mm of the rim, which is drawn red while a brush is in hand.',
});

const lake = {
  id: 'lake', label: 'Water', glyph: '◌', key: 'K', brush: true,
  hint: 'Drag to paint a lake along the stroke at the brush width; its surface sits at the lowest ground under it. A click drops a round lake you can pick up and move.',
  palette: (api) => [widthChips(api)],
  down(api, e) {
    if (!e.hit.inside) { api.say('Water goes on the module.', 'warn'); return null; }
    const pts = [e.pt];
    const g = { kind: 'lake', pts };
    const R = api.state.palette.brushWidth / 2;
    g.preview = { pts: pts.slice(), color: api.theme().water, noDots: true, width: 2 * R, band: [[e.pt.x, e.pt.y]] };
    g.move = (e2) => {
      const last = pts[pts.length - 1];
      if (Math.hypot(e2.pt.x - last.x, e2.pt.y - last.y) < 2) return;
      pts.push(e2.pt);
      g.preview = { ...g.preview, pts: pts.slice(), band: pts.map((p) => [p.x, p.y]) };
      api.redraw();
    };
    g.up = () => {
      let index = -1;
      api.commit((s) => { index = pts.length > 2 ? ops.addWaterStroke(s, pts, { radiusMM: R }) : ops.addLake(s, [pts[0].x, pts[0].y]); }, 'paint water');
      if (index >= 0) api.select({ type: 'lake', index });
    };
    return g;
  },
};

const springPoint = {
  id: 'springpoint', label: 'Spring', glyph: '◉', key: 'S',
  hint: 'Click where a spring should come up: a pool with one notch, and a tube bore straight down through the module.',
  down(api, e) {
    if (!e.hit.inside) { api.say('A spring goes on the module.', 'warn'); return null; }
    const p = snap(e.pt, e.ev);
    let index = -1;
    api.commit((s) => { index = ops.addSpringPoint(s, [p.x, p.y]); }, 'place a spring');
    api.select({ type: 'springpoint', index });
    return null;
  },
};

const wood = {
  id: 'wood', label: 'Wood', glyph: '♣', key: 'G',
  hint: 'Click round the edge of a wood, then double-click, press Enter or click the first point. Trees stand only inside the line and never cross the rim.',
  palette: (api) => [{
    chips: [['deciduous', 'broadleaf'], ['conifer', 'conifer']],
    value: api.state.palette.woodKind,
    pick: (v) => api.setPalette({ woodKind: v }),
  }],
  down(api, e) {
    if (!e.hit.inside && !api.state.gesture) { api.say('Draw the wood on the module.', 'warn'); return null; }
    return polyline(api, e, {
      closeOnFirst: true,
      color: api.theme().wood,
      finish: (pts) => {
        if (pts.length < 3) { api.say('A wood needs three points at least.', 'warn'); return; }
        const { T } = dims(api.state.spec);
        const region = pts.map((p) => [clampMM(p.x, T), clampMM(p.y, T)]);
        let index = -1;
        api.commit((s) => { index = ops.addWood(s, region, api.state.palette.woodKind); }, 'draw a wood');
        api.select({ type: 'wood', index });
      },
    });
  },
};

/* ------------------------------------------------------------------ refine */

// The Refine tools work on the 3D view, so the pointer is the viewer's: it
// paints a stroke along the ground, or places a point, or drags a handle,
// and main.js writes what it did into the spec. What is here is what the
// panel shows: the tools, their keys, and their palettes.

const heightChips = (api) => ({
  chips: [[2, '2'], [4, '4'], [8, '8'], [15, '15']],
  value: api.state.palette.brushMM,
  pick: (v) => api.setPalette({ brushMM: v }),
  note: 'How far a stroke moves the ground along its line, in mm.',
});

export const REFINE_TOOLS = [
  { id: 'select', label: 'Select', glyph: '↖', key: 'V', hint: 'Click the ground to see the module in the inspector. Drag a lake, a spring, a volcano, a flat or a ridge point along the ground to move it.' },
  { id: 'raise', label: 'Raise', glyph: '▲', key: 'U', brush: true, hint: 'Drag along the ground to raise a ridge. The right button orbits.', palette: (api) => [widthChips(api), heightChips(api)] },
  { id: 'lower', label: 'Lower', glyph: '▼', key: 'J', brush: true, hint: 'Drag along the ground to cut it down. Nothing goes below the 2 mm of floor the module keeps.', palette: (api) => [widthChips(api), heightChips(api)] },
  { id: 'smooth', label: 'Smooth', glyph: '≈', key: 'M', brush: true, hint: 'Drag to ease the ground towards its own average: knocks the noise off a slope and keeps its shape.', palette: (api) => [widthChips(api)] },
  { id: 'flatten', label: 'Flatten', glyph: '▭', key: 'N', brush: true, hint: 'Drag to level the ground to the height where the stroke began: a terrace, a road bed, a place for something to stand.', palette: (api) => [widthChips(api)] },
  { id: 'lake', label: 'Water', glyph: '◌', key: 'K', brush: true, hint: 'Drag to paint water along the stroke, at the brush width. Its surface sits at the lowest ground under the stroke. A single click drops a round lake you can pick up and move.', palette: (api) => [widthChips(api)] },
  { id: 'springpoint', label: 'Spring', glyph: '◉', key: 'S', place: true, hint: 'Click where a spring should come up.' },
  { id: 'plant', label: 'Plant', glyph: '♣', key: 'G', brush: true, hint: 'Drag to plant a wood along the stroke. It keeps off water, steep ground and the woods already there.', palette: (api) => [widthChips(api), { chips: [['deciduous', 'Broadleaf'], ['conifer', 'Conifers']], value: api.state.palette.plantKind, pick: (v) => api.setPalette({ plantKind: v }) }] },
  { id: 'clear', label: 'Clear', glyph: '⌫', key: 'X', brush: true, hint: 'Drag to clear trees: none of the module\'s woods grows under the stroke.', palette: (api) => [widthChips(api)] },
];
export const REFINE_GROUPS = [['Look', ['select']], ['The ground', ['raise', 'lower', 'smooth', 'flatten']], ['On it', ['lake', 'springpoint', 'plant', 'clear']]];

export const DRAW_TOOLS = [select, channel, ridge, volcano, flat, lake, springPoint, wood];
export const DRAW_GROUPS = [['Look', ['select']], ['The water', ['channel', 'lake', 'springpoint']], ['The ground', ['ridge', 'volcano', 'flat']], ['On it', ['wood']]];

export { CHANNEL_DEFAULTS };
