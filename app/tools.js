// tools.js — what each tool does with the pointer.
//
// A tool is an object with down / move / up (and optionally hover, key,
// cancel). It never keeps the document: it calls the api, the api edits the
// spec through specops.js, and the board is planned again from the spec.
// A drag that should update the badges while it moves uses api.live, which
// replays the edit onto the spec as it was when the drag began, so a drag is
// one undo step however many times it moved.
//
// The event every tool sees: { px, py, pt, hit, ev } -- screen px, board mm,
// what lib/board.js and the handles say is under the pointer, and the event.

import * as ops from './specops.js';
import { boardToLocal } from './features.js';
import { dims, labelOf, metresPerMM } from './specops.js';
import { FALLS } from '../lib/contract.js';

const SIZES = ['creek', 'stream', 'river', 'bay', 'fjord'];

/** Snap to whole millimetres, or to 10 mm with Shift held. */
export const snap = (pt, ev) => {
  const q = ev?.shiftKey ? 10 : 1;
  return { x: Math.round(pt.x / q) * q, y: Math.round(pt.y / q) * q };
};

/* ---------------------------------------------------------- shared drags */

/**
 * Dragging something already placed. Works from the select tool in either
 * view, on whatever the handles say is under the pointer.
 */
function dragHandle(api, h, e) {
  const st = api.state;
  const { T } = dims(st.spec);
  const m = metresPerMM(st.spec);
  const focus = st.view.mode === 'tile' ? st.view.tile : null;
  const start = e.pt;
  api.begin();
  const g = { kind: 'handle', h, start, moved: false };
  g.move = (e2) => {
    const p = snap(e2.pt, e2.ev);
    g.moved = g.moved || Math.hypot(e2.px - e.px, e2.py - e.py) > 3;
    if (!g.moved) return;
    api.live((s) => {
      switch (h.kind) {
        case 'spine': s.spine[h.index] = ops.toWorld(s, p); break;
        case 'volcano': s.volcanoes[h.index].at = ops.toWorld(s, p); break;
        case 'flat': s.flats[h.index].at = ops.toWorld(s, p); break;
        case 'volcano-rim':
        case 'flat-rim': {
          const list = h.kind === 'volcano-rim' ? s.volcanoes : s.flats;
          const c = ops.toBoard(s, list[h.index].at);
          const r = Math.max(5, Math.round(Math.hypot(p.x - c.x, p.y - c.y)));
          if (h.kind === 'volcano-rim') list[h.index].baseRadiusM = Math.round(r * m.x);
          else list[h.index].radiusM = Math.round(r * m.x);
          break;
        }
        case 'lake':
        case 'springpoint': {
          const local = boardToLocal(T, focus.col, focus.row, 0, p.x, p.y);
          const spot = (h.kind === 'lake' ? s.lakes.place : s.fountains.place)[h.index];
          spot.atMM = [clampMM(local.x, T), clampMM(local.y, T)];
          break;
        }
        case 'wood-vertex': {
          const local = boardToLocal(T, focus.col, focus.row, 0, p.x, p.y);
          s.canopy[h.index].region[h.vertex] = [clampMM(local.x, T), clampMM(local.y, T)];
          break;
        }
        case 'wood': {
          const dx = Math.round(e2.pt.x - start.x);
          const dy = Math.round(e2.pt.y - start.y);
          s.canopy[h.index].region = s.canopy[h.index].region.map(([x, y]) => [clampMM(x + dx, T), clampMM(y + dy, T)]);
          break;
        }
        default: break;
      }
    });
  };
  g.up = () => {
    if (g.moved) api.end(`move ${h.kind.replace('-rim', ' size')}`);
    else api.cancel();
    api.select(selectionFor(h, focus));
  };
  return g;
}

const clampMM = (v, T) => Math.round(Math.max(0, Math.min(T, v)) * 10) / 10;

function selectionFor(h, focus) {
  switch (h.kind) {
    case 'spine': case 'spine-line': return { type: 'spine', vertex: h.kind === 'spine' ? h.index : null };
    case 'volcano': case 'volcano-rim': return { type: 'volcano', index: h.index };
    case 'flat': case 'flat-rim': return { type: 'flat', index: h.index };
    case 'lake': return { type: 'lake', index: h.index };
    case 'springpoint': return { type: 'springpoint', index: h.index };
    case 'wood': case 'wood-vertex': return { type: 'wood', index: h.index };
    case 'corner': return { type: 'corner', cc: h.cc, rr: h.rr, tile: focus };
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

/* ------------------------------------------------------------ board tools */

const select = {
  id: 'select', label: 'Select', glyph: '↖', key: 'V',
  hint: 'Click a tile, a seam badge or a river to see it in the inspector. Drag a ridge point or a volcano to move it. Drag empty space to pan; double-click a tile to open it.',
  down(api, e) {
    const h = e.handle;
    if (h) return dragHandle(api, h, e);
    const hit = e.hit;
    if (hit.kind === 'seam') { api.select({ type: 'seam', id: hit.id }); return null; }
    if (hit.kind === 'tile') {
      // A second click on a tile's river picks the river.
      const sel = api.state.selection;
      const rivers = ops.riversAt(api.state.spec, hit.col, hit.row);
      if (sel?.type === 'tile' && sel.col === hit.col && sel.row === hit.row && rivers.length) {
        api.select({ type: 'river', index: rivers[0] });
      } else if (sel?.type === 'river' && rivers.includes(sel.index)) {
        const next = rivers[(rivers.indexOf(sel.index) + 1) % rivers.length];
        api.select(rivers.length > 1 ? { type: 'river', index: next } : { type: 'tile', col: hit.col, row: hit.row });
      } else {
        api.select({ type: 'tile', col: hit.col, row: hit.row });
      }
      return null;
    }
    api.select(null);
    return panDrag(api, e);
  },
};

const place = {
  id: 'place', label: 'Place', glyph: '⊞', key: 'P', ghosts: true,
  hint: 'Click a + beside the board to add a row or a column of tiles there. Select a tile on the edge and press Delete to take its row or column off.',
  palette: () => [{ note: 'A map-style board is a rectangle: tiles come and go a row or a column at a time, and rivers through a removed strip are cut, coming in from or draining off the new edge.' }],
  down(api, e) {
    if (e.hit.kind === 'ghost') {
      api.commit((s) => ops.growBoard(s, e.hit.side), `add a ${e.hit.side === 'E' || e.hit.side === 'W' ? 'column' : 'row'}`);
      return null;
    }
    if (e.hit.kind === 'tile') api.select({ type: 'tile', col: e.hit.col, row: e.hit.row });
    return null;
  },
};

const turn = {
  id: 'turn', label: 'Turn', glyph: '↻', key: 'T',
  hint: 'Click a tile to turn it a quarter clockwise, Shift-click to turn it back. R does the same to the tile under the pointer. A turn is how the piece sits on the table: the print does not change, the water does.',
  down(api, e) {
    if (e.hit.kind !== 'tile') return null;
    const k = ops.keyOf(e.hit.col, e.hit.row);
    const now = api.state.spec.rot?.[k] || 0;
    api.commit((s) => ops.setRot(s, e.hit.col, e.hit.row, now + (e.ev.shiftKey ? -1 : 1)), `turn ${e.hit.label}`);
    api.select({ type: 'tile', col: e.hit.col, row: e.hit.row });
    return null;
  },
};

const riser = {
  id: 'riser', label: 'Risers', glyph: '☰', key: 'H',
  hint: 'Drag a tile up or down to stand it on more or fewer 10 mm plates; the badges change as you drag. Or pick a height below and click tiles to paint it.',
  palette: (api) => [{
    chips: [['auto', 'auto'], ...[0, 1, 2, 3, 4, 5, 6, 8].map((n) => [n, `${n * 10}`])],
    value: api.state.palette.riser,
    pick: (v) => api.setPalette({ riser: v }),
    note: '"auto" lets the river decide, as the example does.',
  }],
  down(api, e) {
    if (e.hit.kind !== 'tile') return null;
    const { col, row, label } = e.hit;
    const start = api.state.plan.placements.find((p) => p.col === col && p.row === row)?.level ?? 0;
    api.begin();
    api.select({ type: 'tile', col, row });
    const g = { kind: 'riser', moved: false, plates: start };
    g.move = (e2) => {
      const dy = e.py - e2.py;
      if (!g.moved && Math.abs(dy) < 5) return;
      g.moved = true;
      const plates = Math.max(0, start + Math.round(dy / 22));
      if (plates === g.plates) return;
      g.plates = plates;
      api.live((s) => ops.setRiser(s, col, row, plates));
      g.preview = { label: { px: e2.px + 18, py: e2.py - 14, text: `${label} on ${plates * 10} mm` } };
    };
    g.up = () => {
      if (g.moved) { api.end(`raise ${label}`); return; }
      api.cancel();
      const v = api.state.palette.riser;
      api.commit((s) => (v === 'auto' ? ops.setLevel(s, col, row, null) : ops.setRiser(s, col, row, v)), `riser ${label}`);
    };
    return g;
  },
};

const river = {
  id: 'river', label: 'River', glyph: '∿', key: 'W',
  hint: 'Drag across tiles. Start off the board to bring the water in from that side; finish off it to drain into the tray; end on another river to join it. Drawing back over a tile rubs the loop out.',
  palette: (api) => [{
    chips: SIZES.map((s) => [s, s]),
    value: api.state.palette.riverSize,
    pick: (v) => api.setPalette({ riverSize: v }),
    note: 'The size it starts at. Downstream the width is worked out from the flow, and widens where rivers meet. The line says which tiles and which sides: the channel is routed down the valley when it grows.',
  }],
  down(api, e) {
    const pts = [e.pt];
    const g = { kind: 'river', pts };
    const { T } = dims(api.state.spec);
    const show = () => {
      const drawn = ops.strokeToRiver(api.state.spec, pts);
      g.drawn = drawn;
      g.preview = {
        pts: pts.slice(), color: api.theme().water, dashed: true,
        cells: (drawn?.path || []).map(([c, w]) => ({ x0: c * T, y0: w * T, x1: (c + 1) * T, y1: (w + 1) * T })),
      };
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
      if (!g.drawn) { api.say('A river needs two tiles, or an edge of the board to come in from or go out to.', 'warn'); return; }
      let index = -1;
      api.commit((s) => { index = ops.addRiver(s, g.drawn, { size: api.state.palette.riverSize }); }, 'draw a river');
      api.select({ type: 'river', index });
    };
    return g;
  },
};

const fall = {
  id: 'fall', label: 'Fall', glyph: '↘', key: 'F',
  hint: 'Pick a fall and click tiles. A tile stands that far below the one upstream of it, so the fall is the river’s gradient, in whole plates.',
  palette: (api) => [{
    chips: [...FALLS.map((f) => [f, `${f}`]), ['auto', 'default']],
    value: api.state.palette.fall,
    pick: (v) => api.setPalette({ fall: v }),
    note: '10 mm is a river, 30 rapids, 50 a cascade. Every river tile falls at least 10: there is no level tile.',
  }],
  down(api, e) {
    if (e.hit.kind !== 'tile') return null;
    const v = api.state.palette.fall;
    api.commit((s) => ops.setFall(s, e.hit.col, e.hit.row, v === 'auto' ? null : v), `fall ${e.hit.label}`);
    api.select({ type: 'tile', col: e.hit.col, row: e.hit.row });
    return null;
  },
};

const spring = {
  id: 'spring', label: 'Spring', glyph: '◉', key: 'S',
  hint: 'Click a river’s open inlet — where it comes in from nothing — to put a spring on it or take one off. A spring is where the pump’s water comes up.',
  down(api, e) {
    const target = portTarget(api, e);
    if (!target) return null;
    const before = JSON.stringify(api.state.spec);
    api.commit((s) => ops.toggleSpring(s, target.label, target.edge), `spring ${target.label} ${target.edge}`);
    if (JSON.stringify(api.state.spec) === before) {
      api.say(`${target.label}'s ${target.edge} side has no open inlet. A spring goes where a river comes in from nowhere.`, 'warn');
    }
    return null;
  },
};

const drain = {
  id: 'drain', label: 'Drain', glyph: '⤓', key: 'D',
  hint: 'Click the side of a river’s last tile that faces off the board to let it drain into the tray there. Click a drain to stop it.',
  down(api, e) {
    const target = portTarget(api, e);
    if (!target) return null;
    const before = JSON.stringify(api.state.spec);
    api.commit((s) => ops.toggleDrain(s, target.label, target.edge), `drain ${target.label} ${target.edge}`);
    if (JSON.stringify(api.state.spec) === before) {
      api.say(`No river ends at ${target.label} with its ${target.edge} side off the board. A drain goes on the edge of the map.`, 'warn');
    }
    return null;
  },
};

/** The tile and DESIGN edge a click on a port means, from a tile hit or a badge. */
function portTarget(api, e) {
  if (e.hit.kind === 'seam') {
    const s = api.state.plan.seams.find((x) => x.id === e.hit.id);
    if (!s) return null;
    const t = api.state.plan.tiles.find((x) => x.id === s.a);
    if (!t) return null;
    return { label: t.label, edge: designEdgeOf(t.rot, s.edge) };
  }
  if (e.hit.kind === 'tile' && e.hit.edge) return { label: e.hit.label, edge: e.hit.designEdge };
  return null;
}
const designEdgeOf = (rot, e) => ['N', 'E', 'S', 'W'][((['N', 'E', 'S', 'W'].indexOf(e) - (rot || 0)) % 4 + 4) % 4];

/* ----------------------------------------------------------- ground tools */

/** Click points; double-click, Enter or a click on the first point finishes. */
function polyline(api, e, { closeOnFirst = false, finish, color }) {
  const st = api.state;
  const existing = st.gesture?.kind === 'poly' ? st.gesture : null;
  const p = snap(e.pt, e.ev);
  if (existing) {
    const first = existing.pts[0];
    if (closeOnFirst && existing.pts.length >= 3 && Math.hypot(e.px - existing.firstPx.x, e.py - existing.firstPx.y) < 10) {
      existing.finish();
      return null;
    }
    const last = existing.pts[existing.pts.length - 1];
    if (!last || last.x !== p.x || last.y !== p.y) existing.pts.push(p);
    existing.preview.pts = existing.pts.slice();
    void first;
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
  hint: 'Click along the crest of the range, then double-click or press Enter. The map has one spine; drawing another replaces it. Shift snaps to 10 mm.',
  palette: (api) => [{ note: `Mountain height ${api.state.spec.spineHeightM ?? 1500} m: set it, and the ridge width, with the ridge selected.` }],
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
      const m = metresPerMM(api.state.spec);
      const g = { kind: id, c, r: 0 };
      g.preview = { circle: { x: c.x, y: c.y, rx: defaultMM, ry: (defaultMM * m.x) / m.y }, color: api.theme().ridge };
      g.move = (e2) => {
        g.r = Math.round(Math.hypot(e2.pt.x - c.x, e2.pt.y - c.y));
        const r = Math.max(5, g.r);
        g.preview = {
          circle: { x: c.x, y: c.y, rx: r, ry: (r * m.x) / m.y }, color: api.theme().ridge,
          label: { px: e2.px + 16, py: e2.py - 12, text: `${r} mm ≈ ${(r * m.x / 1000).toFixed(1)} km` },
        };
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
  (s, c, r) => ops.addVolcano(s, c, r), 90);
const flat = circleTool('flat', 'Flat', '▭', 'L',
  'Press and drag out a place the map should keep level: a plain, a plateau, somewhere to put a town.',
  (s, c, r) => ops.addFlat(s, c, r), 50);

/* ------------------------------------------------------------ tile tools */

function inFocus(api, pt) {
  const { T } = dims(api.state.spec);
  const f = api.state.view.tile;
  const local = boardToLocal(T, f.col, f.row, 0, pt.x, pt.y);
  const inside = local.x >= 0 && local.y >= 0 && local.x <= T && local.y <= T;
  return { local, inside, label: labelOf(f.col, f.row), T };
}

const lake = {
  id: 'lake', label: 'Lake', glyph: '◌', key: 'K',
  hint: 'Click where a lake should be. It fills the ground that is low round that point; depth and shore are in the inspector.',
  down(api, e) {
    const f = inFocus(api, snap(e.pt, e.ev));
    if (!f.inside) { api.say('A lake goes inside the tile you have open.', 'warn'); return null; }
    let index = -1;
    api.commit((s) => { index = ops.addLake(s, f.label, [f.local.x, f.local.y]); }, `lake on ${f.label}`);
    api.select({ type: 'lake', index });
    return null;
  },
};

const springPoint = {
  id: 'springpoint', label: 'Spring', glyph: '◉', key: 'S',
  hint: 'Click where a spring should come up. A tube runs up through the plates under it, so every plate below needs the same hole.',
  down(api, e) {
    const f = inFocus(api, snap(e.pt, e.ev));
    if (!f.inside) { api.say('A spring goes inside the tile you have open.', 'warn'); return null; }
    let index = -1;
    api.commit((s) => { index = ops.addSpringPoint(s, f.label, [f.local.x, f.local.y]); }, `spring on ${f.label}`);
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
    const f = inFocus(api, e.pt);
    if (!f.inside && !api.state.gesture) { api.say('Draw the wood on the tile you have open.', 'warn'); return null; }
    return polyline(api, e, {
      closeOnFirst: true,
      color: api.theme().wood,
      finish: (pts) => {
        if (pts.length < 3) { api.say('A wood needs three points at least.', 'warn'); return; }
        const { T } = dims(api.state.spec);
        const t = api.state.view.tile;
        const region = pts.map((p) => {
          const l = boardToLocal(T, t.col, t.row, 0, p.x, p.y);
          return [clampMM(l.x, T), clampMM(l.y, T)];
        });
        let index = -1;
        api.commit((s) => { index = ops.addWood(s, labelOf(t.col, t.row), region, api.state.palette.woodKind); }, 'draw a wood');
        api.select({ type: 'wood', index });
      },
    });
  },
};

const corner = {
  id: 'corner', label: 'Corner', glyph: '◳', key: 'C',
  hint: 'Click a corner to raise it one plate, or click again to put it back. A corner is shared, so the tiles round it rise together and every seam still mates.',
  down(api, e) {
    const h = e.handle;
    if (!h || h.kind !== 'corner') { api.say('Click one of the four corner circles.', 'warn'); return null; }
    const plate = api.state.plan.contract.plateMM;
    api.commit((s) => ops.toggleCornerRaise(s, h.cc, h.rr, plate), 'raise a corner');
    api.select({ type: 'corner', cc: h.cc, rr: h.rr, tile: api.state.view.tile });
    return null;
  },
};

const tileSelect = {
  ...select,
  hint: 'Drag a lake, a spring, a wood or a ridge point to move it. Click a corner to see its height. Double-click another tile to open it; Esc goes back to the board.',
  down(api, e) {
    if (e.handle?.kind === 'corner') { api.select({ type: 'corner', cc: e.handle.cc, rr: e.handle.rr, tile: api.state.view.tile }); return null; }
    return select.down(api, e);
  },
};

export const BOARD_TOOLS = [select, place, turn, riser, river, fall, spring, drain, ridge, volcano, flat];
export const TILE_TOOLS = [tileSelect, ridge, volcano, flat, lake, springPoint, wood, corner];
export const BOARD_GROUPS = [['The board', ['select', 'place', 'turn', 'riser']], ['The water', ['river', 'fall', 'spring', 'drain']], ['The ground', ['ridge', 'volcano', 'flat']]];
export const TILE_GROUPS = [['The tile', ['select', 'corner']], ['The ground', ['ridge', 'volcano', 'flat']], ['On it', ['lake', 'springpoint', 'wood']]];

export function toolsFor(mode) {
  return mode === 'tile' ? TILE_TOOLS : BOARD_TOOLS;
}
