// specops.js — every edit the editor makes, as a function of the spec.
//
// The spec is the document. A tool never keeps state of its own that the
// spec does not hold: it calls one of these, the spec changes, the board is
// planned again from the spec, and everything on screen is redrawn from that.
// So these are pure in the one way that matters -- they take a spec and leave
// it as the CLI would read it -- and they run in node, which is how the tests
// draw the example map without a browser.
//
// COORDINATES. Three frames, and only these functions convert between them:
//
//   board mm    X east, Y north, from the south-west corner of A1. Tile
//               (col, row) covers [col*T, (col+1)*T] x [row*T, (row+1)*T].
//               Row 0 is the SOUTH row, as in the spec and in shade.js.
//   tile mm     the same, from the south-west corner of one tile. lakes.place,
//               fountains.place and a wood's region are written in it.
//   world frac  [u, v] in 0..1 across the whole map. spine, volcanoes and
//               flats are written in it, because the generator reads them so.

import { columnLabel, EDGES, OPPOSITE, STEP, makeContract } from '../lib/contract.js';
import { boardFromSpec } from '../lib/board.js';
import { EDIT_DEFAULTS, editsFor, strokeWeight } from '../lib/edits.js';
import { worldSizeM as worldSizeOf, DEFAULT_M_PER_MM } from '../lib/scale.js';

/* ------------------------------------------------------------------ basics */

export const keyOf = (col, row) => `${col},${row}`;
export const labelOf = (col, row) => `${columnLabel(col)}${row + 1}`;

/** 'B2' -> {col: 1, row: 1}; 'AA10' -> {col: 26, row: 9}. Null if it is not a label. */
export function parseLabel(label) {
  const m = /^([A-Z]+)(\d+)$/.exec(String(label || '').trim());
  if (!m) return null;
  let col = 0;
  for (const ch of m[1]) col = col * 26 + (ch.charCodeAt(0) - 64);
  return { col: col - 1, row: Number(m[2]) - 1 };
}

export function dims(spec) {
  return {
    cols: spec.cols || 3,
    rows: spec.rows || 3,
    T: spec.contract?.tileMM ?? 200,
  };
}

const r6 = (v) => Math.round(v * 1e6) / 1e6;
const r1 = (v) => Math.round(v * 10) / 10;

/** World fraction -> board mm. */
export function toBoard(spec, [u, v]) {
  const { cols, rows, T } = dims(spec);
  return { x: r6(u * cols * T), y: r6(v * rows * T) };
}

/** Board mm -> world fraction, rounded so 60/600 comes back as 0.1 and stays there. */
export function toWorld(spec, { x, y }) {
  const { cols, rows, T } = dims(spec);
  return [r6(x / (cols * T)), r6(y / (rows * T))];
}

/** How many metres of the world one board millimetre is, each way. */
export function metresPerMM(spec) {
  const { cols, rows, T } = dims(spec);
  const W = worldSizeOf(spec, spec.contract?.tileMM ?? 200);
  return { x: W / (cols * T), y: W / (rows * T) };
}

/** Which cell a board point is in, and where in it. */
export function cellAt(spec, { x, y }) {
  const { cols, rows, T } = dims(spec);
  const col = Math.floor(x / T);
  const row = Math.floor(y / T);
  return { col, row, inside: col >= 0 && row >= 0 && col < cols && row < rows, lx: x - col * T, ly: y - row * T };
}

/** Delete keys whose value is undefined, null, or an empty object or array. */
export function tidy(spec) {
  for (const k of ['falls', 'waterfalls', 'levels', 'rot', 'cornerRaise']) {
    if (spec[k] && typeof spec[k] === 'object' && !Object.keys(spec[k]).length) delete spec[k];
  }
  for (const k of ['volcanoes', 'flats', 'rivers', 'canopy']) {
    if (Array.isArray(spec[k]) && !spec[k].length) delete spec[k];
  }
  if (Array.isArray(spec.spine) && spec.spine.length < 2) delete spec.spine;
  for (const k of ['lakes', 'fountains']) {
    if (spec[k] && Array.isArray(spec[k].place) && !spec[k].place.length) delete spec[k].place;
  }
  if (spec.edits && typeof spec.edits === 'object') {
    for (const [label, list] of Object.entries(spec.edits)) if (!Array.isArray(list) || !list.length) delete spec.edits[label];
    if (!Object.keys(spec.edits).length) delete spec.edits;
  }
  return spec;
}

/** A board with one plain tile on it and nothing drawn. */
export function blankSpec() {
  return { name: 'untitled', seed: 1, cols: 1, rows: 1, meshMM: 0.9, metresPerMM: DEFAULT_M_PER_MM };
}

/* ------------------------------------------------------------- per tile */

function setCell(spec, mapKey, col, row, value) {
  const k = keyOf(col, row);
  if (value === null || value === undefined || value === '') {
    if (spec[mapKey]) delete spec[mapKey][k];
  } else {
    spec[mapKey] = spec[mapKey] || {};
    spec[mapKey][k] = value;
  }
  return tidy(spec);
}

/** A tile's fall, 10-50 mm, or null for the contract's default. */
export const setFall = (spec, col, row, mm) => setCell(spec, 'falls', col, row, mm);
/** Extra free-fall at the tile's first inlet, or null for none. */
export const setWaterfall = (spec, col, row, mm) => setCell(spec, 'waterfalls', col, row, mm || null);
/** The riser a tile's design stands on, in plates, or null to let the river decide. */
export const setLevel = (spec, col, row, plates) => setCell(spec, 'levels', col, row, plates);
/** Quarter turns on the table. 0 is no entry at all. */
export const setRot = (spec, col, row, rot) => setCell(spec, 'rot', col, row, ((Math.round(rot) % 4) + 4) % 4 || null);

/**
 * Set a tile's riser, writing it only where it differs from what the river
 * would give: a level the solver would pick anyway is not worth a key.
 */
export function setRiser(spec, col, row, plates) {
  const k = keyOf(col, row);
  setLevel(spec, col, row, Math.max(0, Math.round(plates)));
  // Dry tiles take their level from their neighbours, so a key can matter to
  // a tile next door even when it matches what this one would get anyway.
  // It goes only if the whole board stands the same without it.
  const withKey = boardFromSpec(spec).levels;
  const trial = structuredClone(spec);
  delete trial.levels[k];
  tidy(trial);
  const without = boardFromSpec(trial).levels;
  if ([...withKey].every(([kk, v]) => without.get(kk) === v)) {
    delete spec.levels[k];
    tidy(spec);
  }
  return spec;
}

/** Lift or drop one lattice corner by `mm`, keyed 'cc,rr'. Toggles when asked twice. */
export function toggleCornerRaise(spec, cc, rr, mm) {
  const k = `${cc},${rr}`;
  if (spec.cornerRaise?.[k]) delete spec.cornerRaise[k];
  else { spec.cornerRaise = spec.cornerRaise || {}; spec.cornerRaise[k] = mm; }
  return tidy(spec);
}

/* -------------------------------------------------------------- the board */

/** Shift every tile reference by (dc, dr): paths, per-cell maps, labels, corners. */
function shiftRefs(spec, dc, dr) {
  if (!dc && !dr) return;
  for (const r of spec.rivers || []) r.path = (r.path || []).map(([c, w]) => [c + dc, w + dr]);
  for (const m of ['falls', 'waterfalls', 'levels', 'rot', 'cornerRaise']) {
    if (!spec[m]) continue;
    const next = {};
    for (const [k, v] of Object.entries(spec[m])) {
      const [c, w] = k.split(',').map(Number);
      next[`${c + dc},${w + dr}`] = v;
    }
    spec[m] = next;
  }
  const relabel = (label) => {
    const p = parseLabel(label);
    return p ? labelOf(p.col + dc, p.row + dr) : label;
  };
  for (const k of ['lakes', 'fountains']) {
    for (const spot of spec[k]?.place || []) if (spot.tile) spot.tile = relabel(spot.tile);
  }
  for (const layer of spec.canopy || []) if (Array.isArray(layer.tiles)) layer.tiles = layer.tiles.map(relabel);
  if (spec.edits && typeof spec.edits === 'object') {
    const next = {};
    for (const [label, list] of Object.entries(spec.edits)) next[relabel(label)] = list;
    spec.edits = next;
  }
}

/**
 * Keep the world's features over the same tiles when the board changes
 * shape. They are stored as fractions of the whole map, so a fourth column
 * would otherwise slide every volcano a third of a tile west. Their sizes
 * stay in metres: the world is one square and a board that is not square
 * stretches it, which is how the generator has always read a 4 x 3 map.
 */
function refit(spec, before, after, dc, dr) {
  const fit = ([u, v]) => [r6((u * before.cols + dc) / after.cols), r6((v * before.rows + dr) / after.rows)];
  if (Array.isArray(spec.spine)) spec.spine = spec.spine.map(fit);
  for (const v of spec.volcanoes || []) v.at = fit(v.at);
  for (const f of spec.flats || []) f.at = fit(f.at);
}

/** Add a row or column on one side of the board. */
export function growBoard(spec, side) {
  const before = dims(spec);
  const after = { ...before };
  let dc = 0;
  let dr = 0;
  if (side === 'E' || side === 'W') after.cols += 1;
  else after.rows += 1;
  if (side === 'W') dc = 1;
  if (side === 'S') dr = 1;
  shiftRefs(spec, dc, dr);
  refit(spec, before, after, dc, dr);
  spec.cols = after.cols;
  spec.rows = after.rows;
  // A river that came in from, or drained off, this side would now face the
  // new tiles' land. Carry it on into the new strip, so it still comes in
  // from (or drains off) the edge of the board, as it did.
  const [sc, sr] = STEP[side];
  const inStrip = ([c, w]) => (side === 'E' ? c === after.cols - 1 : side === 'W' ? c === 0 : side === 'N' ? w === after.rows - 1 : w === 0);
  for (const r of spec.rivers || []) {
    const path = r.path || [];
    if (!path.length) continue;
    const first = path[0];
    const last = path[path.length - 1];
    if (r.sinkEdge === side && inStrip([last[0] + sc, last[1] + sr])) path.push([last[0] + sc, last[1] + sr]);
    if (r.sourceEdge === side && inStrip([first[0] + sc, first[1] + sr])) path.unshift([first[0] + sc, first[1] + sr]);
    r.path = path;
  }
  return tidy(spec);
}

/**
 * Take the row or column off one side of the board.
 *
 * A river that ran through it is cut, and the cut ends become what they
 * now are: where it came in from the strip that went, it comes in from off
 * the map; where it went out into it, it drains. A river cut in the middle
 * becomes two. Each piece keeps the width it had where it was cut, read off
 * the board before anything moved, so taking a column off does not quietly
 * change the size of the river in the next one.
 */
export function shrinkBoard(spec, side) {
  const before = dims(spec);
  if ((side === 'E' || side === 'W') ? before.cols <= 1 : before.rows <= 1) return spec;
  const gone = (c, w) => (side === 'E' ? c === before.cols - 1 : side === 'W' ? c === 0
    : side === 'N' ? w === before.rows - 1 : w === 0);
  const read = boardFromSpec(spec);
  const sizeAt = (c, w, e) => read.placements.find((p) => p.col === c && p.row === w)?.tile.edges?.[e]?.size ?? null;
  const toward = side; // the edge of a kept tile that faces the strip being removed

  const rivers = [];
  for (const r of spec.rivers || []) {
    const path = r.path || [];
    let run = [];
    let runStart = 0;
    const pieces = [];
    path.forEach(([c, w], i) => {
      if (gone(c, w)) {
        if (run.length) pieces.push({ cells: run, from: runStart, to: i - 1 });
        run = [];
      } else {
        if (!run.length) runStart = i;
        run.push([c, w]);
      }
    });
    if (run.length) pieces.push({ cells: run, from: runStart, to: path.length - 1 });
    pieces.forEach((piece, n) => {
      const first = piece.from === 0;
      const last = piece.to === path.length - 1;
      const [c0, w0] = piece.cells[0];
      const out = { ...r, path: piece.cells };
      if (n > 0) out.name = `${r.name || 'river'} (${n + 1})`;
      if (!first) {
        out.sourceEdge = toward;
        out.size = sizeAt(c0, w0, toward) ?? r.size ?? null;
      }
      if (!last) {
        out.sinkEdge = toward;
        delete out.sinkSize;
      }
      rivers.push(orderRiver(out));
    });
  }
  if (spec.rivers) spec.rivers = rivers;

  for (const m of ['falls', 'waterfalls', 'levels', 'rot']) {
    if (!spec[m]) continue;
    for (const k of Object.keys(spec[m])) {
      const [c, w] = k.split(',').map(Number);
      if (gone(c, w)) delete spec[m][k];
    }
  }
  if (spec.cornerRaise) {
    const line = side === 'E' ? ['c', before.cols] : side === 'W' ? ['c', 0] : side === 'N' ? ['r', before.rows] : ['r', 0];
    for (const k of Object.keys(spec.cornerRaise)) {
      const [cc, rr] = k.split(',').map(Number);
      if ((line[0] === 'c' ? cc : rr) === line[1]) delete spec.cornerRaise[k];
    }
  }
  const isGone = (label) => { const p = parseLabel(label); return p && gone(p.col, p.row); };
  for (const k of ['lakes', 'fountains']) {
    if (spec[k]?.place) spec[k].place = spec[k].place.filter((s) => !s.tile || !isGone(s.tile));
  }
  if (spec.canopy) {
    spec.canopy = spec.canopy
      .map((l) => (Array.isArray(l.tiles) ? { ...l, tiles: l.tiles.filter((t) => !isGone(t)) } : l))
      .filter((l) => !Array.isArray(l.tiles) || l.tiles.length);
  }
  // A tile's edits go with it, as its lakes and woods do.
  if (spec.edits) for (const label of Object.keys(spec.edits)) if (isGone(label)) delete spec.edits[label];

  const after = { ...before };
  let dc = 0;
  let dr = 0;
  if (side === 'E' || side === 'W') after.cols -= 1; else after.rows -= 1;
  if (side === 'W') dc = -1;
  if (side === 'S') dr = -1;
  shiftRefs(spec, dc, dr);
  refit(spec, before, after, dc, dr);
  spec.cols = after.cols;
  spec.rows = after.rows;
  return tidy(spec);
}

/* ----------------------------------------------------------------- rivers */

/**
 * The cells a stroke passes through, four-connected, in order.
 *
 * A stroke is the pointer's path in board mm. It is walked cell boundary by
 * cell boundary, so a pointer that cuts a corner diagonally still yields
 * edge-adjacent tiles: portsFromRivers refuses anything else, and should.
 */
export function strokeCells(spec, pts) {
  const { T } = dims(spec);
  const cells = [];
  const push = (c, w) => {
    const last = cells[cells.length - 1];
    if (!last || last[0] !== c || last[1] !== w) cells.push([c, w]);
  };
  if (!pts.length) return cells;
  push(Math.floor(pts[0].x / T), Math.floor(pts[0].y / T));
  for (let i = 1; i < pts.length; i++) {
    let x = pts[i - 1].x / T;
    let y = pts[i - 1].y / T;
    const x1 = pts[i].x / T;
    const y1 = pts[i].y / T;
    let c = Math.floor(x);
    let w = Math.floor(y);
    const c1 = Math.floor(x1);
    const w1 = Math.floor(y1);
    const dx = x1 - x;
    const dy = y1 - y;
    const sx = Math.sign(dx);
    const sy = Math.sign(dy);
    // Amanatides-Woo: step whichever boundary the segment reaches first --
    // but only along an axis that still has somewhere to go. A point exactly
    // on a grid corner ties the two, and stepping the one already done sends
    // the walk off along the ray and never back.
    let tMaxX = sx ? ((sx > 0 ? c + 1 : c) - x) / dx : Infinity;
    let tMaxY = sy ? ((sy > 0 ? w + 1 : w) - y) / dy : Infinity;
    const tDX = sx ? sx / dx : Infinity;
    const tDY = sy ? sy / dy : Infinity;
    while (c !== c1 || w !== w1) {
      const stepX = c === c1 ? false : w === w1 ? true : tMaxX <= tMaxY;
      if (stepX) { c += Math.sign(c1 - c); tMaxX += tDX; } else { w += Math.sign(w1 - w); tMaxY += tDY; }
      push(c, w);
    }
    x = x1; y = y1;
  }
  return cells;
}

/**
 * A stroke as a river: which tiles, and where it comes in and goes out.
 *
 * Start off the board and the river comes in from that side; finish off it
 * and it drains there. Only the first stretch on the board counts, and
 * doubling back over a tile already drawn rubs the loop out, so a stroke
 * that wanders is corrected by drawing back over it.
 */
export function strokeToRiver(spec, pts) {
  const { cols, rows } = dims(spec);
  const on = ([c, w]) => c >= 0 && w >= 0 && c < cols && w < rows;
  const cells = strokeCells(spec, pts);
  const path = [];
  let sourceEdge = null;
  let sinkEdge = null;
  let started = false;
  for (let i = 0; i < cells.length; i++) {
    const cell = cells[i];
    if (!on(cell)) {
      if (started) {
        const last = path[path.length - 1];
        sinkEdge = EDGES.find((e) => STEP[e][0] === cell[0] - last[0] && STEP[e][1] === cell[1] - last[1]) || null;
        break;
      }
      continue;
    }
    if (!started) {
      started = true;
      if (i > 0) {
        const prev = cells[i - 1];
        sourceEdge = EDGES.find((e) => STEP[e][0] === prev[0] - cell[0] && STEP[e][1] === prev[1] - cell[1]) || null;
      }
    }
    const seen = path.findIndex(([c, w]) => c === cell[0] && w === cell[1]);
    if (seen >= 0) path.length = seen + 1;
    else path.push(cell);
  }
  if (!path.length) return null;
  if (path.length === 1 && !sourceEdge && !sinkEdge) return null;
  // In and straight back out of the same side: the drain would overwrite the inlet.
  if (path.length === 1 && sourceEdge && sourceEdge === sinkEdge) return null;
  return { path, sourceEdge, sinkEdge };
}

/** A river's keys in the order the example writes them, so the JSON reads the same way. */
export function orderRiver(r) {
  const out = {};
  for (const k of ['name', 'sourceEdge', 'path', 'sinkEdge', 'sinkSize', 'size']) if (r[k] !== undefined && r[k] !== null) out[k] = r[k];
  for (const k of Object.keys(r)) if (!(k in out) && r[k] !== undefined && r[k] !== null) out[k] = r[k];
  return out;
}

/** A fresh name, 'river 1', 'river 2', ... not already on the map. */
export function freshRiverName(spec) {
  const used = new Set((spec.rivers || []).map((r) => r.name));
  for (let i = 1; ; i++) if (!used.has(`river ${i}`)) return `river ${i}`;
}

/** Add a river drawn as a stroke. Returns its index, or -1 if it was not one. */
export function addRiver(spec, drawn, { size = 'creek', name = null } = {}) {
  if (!drawn || !drawn.path?.length) return -1;
  const r = { name: name || freshRiverName(spec), size };
  if (drawn.sourceEdge) r.sourceEdge = drawn.sourceEdge;
  r.path = drawn.path.map(([c, w]) => [c, w]);
  if (drawn.sinkEdge) r.sinkEdge = drawn.sinkEdge;
  spec.rivers = spec.rivers || [];
  spec.rivers.push(orderRiver(r));
  return spec.rivers.length - 1;
}

export function removeRiver(spec, index) {
  if (spec.rivers) spec.rivers.splice(index, 1);
  return tidy(spec);
}

/** Which rivers pass through a tile, by index. */
export function riversAt(spec, col, row) {
  return (spec.rivers || []).map((r, i) => (r.path || []).some(([c, w]) => c === col && w === row) ? i : -1).filter((i) => i >= 0);
}

/* ---------------------------------------------------------- springs, drains */

/** Inlets with nothing upstream in the design: where a spring can go on a port. */
export function openInlets(spec) {
  const read = boardFromSpec(spec);
  const at = new Map(read.placements.map((p) => [p.id, p]));
  const out = [];
  for (const p of read.placements) {
    for (const e of EDGES) {
      if (p.tile.edges?.[e]?.type !== 'in') continue;
      const [dc, dr] = STEP[e];
      const up = at.get(keyOf(p.col + dc, p.row + dr));
      if (up && up.tile.edges?.[OPPOSITE[e]]?.type === 'out') continue;
      out.push({ tile: p.label, edge: e, col: p.col, row: p.row });
    }
  }
  return out;
}

/** Is there a spring on this port right now, as the build would place one? */
export function springOn(spec, label, edge) {
  const f = spec.fountains;
  if (!f) return false;
  if ((f.place || []).some((s) => s.tile === label && s.edge === edge && !s.atMM)) return true;
  return f.auto !== false && openInlets(spec).some((o) => o.tile === label && o.edge === edge);
}

/**
 * Put a spring on a river's open end, or take it off.
 *
 * Only the port asked about changes. A spring placed by hand on a port --
 * with its own pool size, say, or on a port that is no longer an open
 * inlet -- is left exactly as it is. The short form, `auto`, is used only
 * when every open inlet has a plain spring and nothing would be lost by it.
 */
export function toggleSpring(spec, label, edge) {
  const open = openInlets(spec);
  const isOpen = open.some((o) => o.tile === label && o.edge === edge);
  const f = spec.fountains ? { ...spec.fountains } : null;
  const place = [...(f?.place || [])];
  const at = (t, e) => place.findIndex((x) => x.tile === t && x.edge === e && !x.atMM);
  const write = (next) => {
    if (!next.place?.length) delete next.place;
    spec.fountains = next;
    return spec;
  };

  // Placed on this port by hand: it comes off, open inlet or not.
  const mine = at(label, edge);
  if (mine >= 0) {
    place.splice(mine, 1);
    return write({ ...f, place });
  }
  // On through `auto`: auto goes, and every other open inlet keeps its spring.
  if (f && f.auto !== false && isOpen) {
    const others = open.filter((o) => !(o.tile === label && o.edge === edge) && at(o.tile, o.edge) < 0)
      .map((o) => ({ tile: o.tile, edge: o.edge }));
    return write({ ...f, auto: false, place: [...place, ...others] });
  }
  if (!isOpen) {
    // Not an open inlet. If it is the first tile of a river with no way in,
    // give the river this side as its source, and the spring with it.
    const p = parseLabel(label);
    const { cols, rows } = dims(spec);
    const [dc, dr] = STEP[edge];
    const offBoard = p && (p.col + dc < 0 || p.row + dr < 0 || p.col + dc >= cols || p.row + dr >= rows);
    const r = p && offBoard && (spec.rivers || []).find((x) => !x.sourceEdge && x.path?.[0]?.[0] === p.col && x.path?.[0]?.[1] === p.row);
    if (!r) return spec;
    r.sourceEdge = edge;
    spec.rivers[spec.rivers.indexOf(r)] = orderRiver(r);
    if (!springOn(spec, label, edge)) toggleSpring(spec, label, edge);
    return spec;
  }
  // Off, and an open inlet: put one on.
  place.push({ tile: label, edge });
  const plain = (x) => Object.keys(x).every((k) => k === 'tile' || k === 'edge');
  const everyOne = open.every((o) => { const i = at(o.tile, o.edge); return i >= 0 && plain(place[i]); });
  if (everyOne) {
    const isOpenPort = (x) => x.edge && !x.atMM && open.some((o) => o.tile === x.tile && o.edge === x.edge);
    return write({ ...(f || {}), auto: true, place: place.filter((x) => !isOpenPort(x)) });
  }
  return write({ ...(f || {}), auto: false, place });
}

/** Make the river ending in this tile drain off this side, or stop draining there. */
export function toggleDrain(spec, label, edge) {
  const p = parseLabel(label);
  if (!p) return spec;
  const { cols, rows } = dims(spec);
  const [dc, dr] = STEP[edge];
  const offBoard = p.col + dc < 0 || p.row + dr < 0 || p.col + dc >= cols || p.row + dr >= rows;
  const ends = (spec.rivers || []).filter((r) => {
    const last = r.path?.[r.path.length - 1];
    return last && last[0] === p.col && last[1] === p.row;
  });
  const draining = ends.find((r) => r.sinkEdge === edge);
  if (draining) {
    delete draining.sinkEdge;
    delete draining.sinkSize;
    return spec;
  }
  if (!offBoard) return spec;
  const r = ends.find((x) => !x.sinkEdge);
  if (r) spec.rivers[spec.rivers.indexOf(r)] = orderRiver({ ...r, sinkEdge: edge });
  return spec;
}

/* ------------------------------------------------------------- the ground */

/** The spine, from board-mm points. Fewer than two points takes it away. */
export function setSpine(spec, pts) {
  if (pts.length < 2) { delete spec.spine; return spec; }
  spec.spine = pts.map((p) => toWorld(spec, p));
  return spec;
}

export function addVolcano(spec, at, radiusMM, o = {}) {
  const m = metresPerMM(spec);
  spec.volcanoes = spec.volcanoes || [];
  // The drawn radius is already millimetres on the board, which is what
  // the spec wants now -- it used to be multiplied up into world metres.
  spec.volcanoes.push({ at: toWorld(spec, at), heightMM: o.heightMM ?? 32, baseRadiusMM: Math.round(radiusMM), ...(o.breachAzimuthDeg != null ? { breachAzimuthDeg: o.breachAzimuthDeg } : {}) });
  return spec.volcanoes.length - 1;
}

export function addFlat(spec, at, radiusMM, o = {}) {
  const m = metresPerMM(spec);
  spec.flats = spec.flats || [];
  spec.flats.push({ at: toWorld(spec, at), radiusM: Math.round(radiusMM * m.x), ...(o.elevM != null ? { elevM: o.elevM } : {}) });
  return spec.flats.length - 1;
}

/** A lake placed by hand, in one tile's millimetres. */
export function addLake(spec, label, atMM, o = {}) {
  spec.lakes = spec.lakes || {};
  spec.lakes.place = spec.lakes.place || [];
  spec.lakes.place.push({ tile: label, atMM: [r1(atMM[0]), r1(atMM[1])], ...o });
  return spec.lakes.place.length - 1;
}

/**
 * Water PAINTED along a stroke, split across whatever tiles it crossed.
 *
 * One stroke becomes one lake per tile, each carrying the piece of the path
 * that fell inside it, so a lake drawn across a seam comes out as two
 * designs that still mate -- the same rule rivers and woods already follow.
 *
 * A stroke of a single point is written as a plain `atMM` lake instead,
 * which is exactly what clicking used to do. That is not a special case for
 * its own sake: a point lake keeps its drag handle (see features.js, which
 * skips anything without an atMM), so a click still gives something you can
 * pick up and move, and only a real drag gives up the handle in exchange
 * for a shape.
 */
export function addWaterStroke(spec, placements, pts, o = {}) {
  const { T } = dims(spec);
  const R = Number(o.radiusMM);
  if (!pts.length || !(R > 0)) return [];
  const touched = [];
  for (const p of placements) {
    const local = pts.map(({ x, y }) => intoTile(T, p.col, p.row, p.rot, x, y));
    let x0 = Infinity; let y0 = Infinity; let x1 = -Infinity; let y1 = -Infinity;
    for (const q of local) { x0 = Math.min(x0, q.x); y0 = Math.min(y0, q.y); x1 = Math.max(x1, q.x); y1 = Math.max(y1, q.y); }
    if (x1 + R <= 0 || y1 + R <= 0 || x0 - R >= T || y0 - R >= T) continue;
    // Only the part of the stroke that actually fell on this tile.
    const inside = local.filter((q) => q.x >= -R && q.y >= -R && q.x <= T + R && q.y <= T + R);
    if (!inside.length) continue;
    const path = thin(inside.map((q) => [r1(q.x), r1(q.y)]), Math.max(0.5, R * 0.05));
    spec.lakes = spec.lakes || {};
    spec.lakes.place = spec.lakes.place || [];
    if (path.length === 1) {
      spec.lakes.place.push({ tile: p.label, atMM: path[0], radiusMM: r1(R) });
    } else {
      spec.lakes.place.push({ tile: p.label, pathMM: path, radiusMM: r1(R) });
    }
    touched.push(p.label);
  }
  return touched;
}

/**
 * A spring placed at a point. If the map had no fountains at all, this
 * turns them on for this spring only: `auto` would otherwise put one on
 * every open inlet too, which is a different thing from what was clicked.
 */
export function addSpringPoint(spec, label, atMM) {
  if (!spec.fountains) spec.fountains = { auto: false };
  spec.fountains.place = spec.fountains.place || [];
  spec.fountains.place.push({ tile: label, atMM: [r1(atMM[0]), r1(atMM[1])] });
  return spec.fountains.place.length - 1;
}

export const WOOD_KINDS = {
  conifer: { kind: 'conifer', crownMM: 7, heightMM: 9, density: 0.6, maxSlopeDeg: 36 },
  deciduous: { kind: 'deciduous', crownMM: 12, heightMM: 7, density: 0.5, maxSlopeDeg: 24 },
};

/** A wood drawn as a shape on one tile. */
export function addWood(spec, label, region, kind = 'deciduous') {
  spec.canopy = spec.canopy || [];
  spec.canopy.push({ ...WOOD_KINDS[kind] || WOOD_KINDS.deciduous, tiles: [label], region: region.map(([x, y]) => [r1(x), r1(y)]) });
  return spec.canopy.length - 1;
}

/** A wood over the whole map, as the example's are. */
export function addWoodLayer(spec, kind = 'deciduous') {
  spec.canopy = spec.canopy || [];
  spec.canopy.push({ ...WOOD_KINDS[kind] || WOOD_KINDS.deciduous });
  return spec.canopy.length - 1;
}

/* ------------------------------------------------------------------ edits */

/** A board point in a tile's own millimetres, undoing its turn (as features.js boardToLocal). */
function intoTile(T, col, row, rot, X, Y) {
  let dx = X - (col * T + T / 2);
  let dy = Y - (row * T + T / 2);
  for (let i = 0; i < (rot || 0); i++) [dx, dy] = [-dy, dx];
  return { x: dx + T / 2, y: dy + T / 2 };
}

/** Distance from point p to the segment a-b (to a itself when the segment has no length). */
function segDist([px, py], [ax, ay], [bx, by]) {
  const dx = bx - ax;
  const dy = by - ay;
  const L2 = dx * dx + dy * dy;
  const t = L2 > 0 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / L2)) : 0;
  return Math.hypot(px - ax - t * dx, py - ay - t * dy);
}

/**
 * Douglas-Peucker on [x, y] pairs: a dragged stroke is a few vertices, not
 * one per mouse move. Distance is to the SEGMENT, not the line through it,
 * so a stroke that doubles back, or comes round in a circle, keeps its turn.
 */
function thin(pts, tol) {
  if (pts.length < 3) return pts.slice();
  const keep = new Uint8Array(pts.length);
  keep[0] = 1;
  keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    let best = -1;
    let bestD = tol;
    for (let i = a + 1; i < b; i++) {
      const d = segDist(pts[i], pts[a], pts[b]);
      if (d > bestD) { bestD = d; best = i; }
    }
    if (best >= 0) { keep[best] = 1; stack.push([a, best], [best, b]); }
  }
  return pts.filter((_, i) => keep[i]);
}

/**
 * A brushstroke drawn on the board, written as an edit on every tile it
 * reaches, each in that tile's own millimetres: turned back the way the tile
 * is turned, so the stroke stays on the ground it was drawn on whichever way
 * the piece sits. A tile the stroke only grazes -- less than half a percent
 * of it anywhere, once the rim lock has faded it -- gets nothing.
 *
 *   placements  the board's tiles: { col, row, rot, label, riserMM }
 *   pts         the stroke, in board mm
 *   o           { op, radiusMM, mm, strength, kind, toWorldMM }; a flatten
 *               is to one height ON THE TABLE, so each tile gets it less
 *               its own riser
 *
 * Returns the labels written to.
 */
export function addStroke(spec, placements, pts, o) {
  const { T } = dims(spec);
  const c = contractOf(spec);
  const lock = c.rimLockMM ?? EDIT_DEFAULTS.rimLockMM;
  const R = Number(o.radiusMM);
  if (!pts.length || !(R > 0)) return [];
  const touched = [];
  for (const p of placements) {
    const local = pts.map(({ x, y }) => intoTile(T, p.col, p.row, p.rot, x, y));
    let x0 = Infinity; let y0 = Infinity; let x1 = -Infinity; let y1 = -Infinity;
    for (const q of local) { x0 = Math.min(x0, q.x); y0 = Math.min(y0, q.y); x1 = Math.max(x1, q.x); y1 = Math.max(y1, q.y); }
    if (x1 + R <= 0 || y1 + R <= 0 || x0 - R >= T || y0 - R >= T) continue;
    const path = thin(local.map((q) => [r1(q.x), r1(q.y)]), Math.max(0.5, R * 0.05));
    const e = { op: o.op, path, radiusMM: r1(R) };
    // How much of the stroke this tile keeps at most, on a 1 mm grid over where it reaches.
    let most = 0;
    for (let y = Math.max(0, y0 - R); y <= Math.min(T, y1 + R) && most < 0.005; y += 1) {
      for (let x = Math.max(0, x0 - R); x <= Math.min(T, x1 + R) && most < 0.005; x += 1) most = Math.max(most, strokeWeight(e, path, x, y, T, lock));
    }
    if (most < 0.005) continue;
    if (o.op === 'raise' || o.op === 'lower') e.mm = r1(Number(o.mm) || 0);
    if (o.op === 'smooth' && Number.isFinite(o.strength)) e.strength = o.strength;
    if (o.op === 'flatten') e.toMM = r1(Math.max(EDIT_DEFAULTS.floorMM, o.toWorldMM - (p.riserMM || 0)));
    if (o.op === 'plant') e.kind = o.kind || 'deciduous';
    spec.edits = spec.edits || {};
    spec.edits[p.label] = [...editsFor(spec, p.label), e];
    touched.push(p.label);
  }
  return touched;
}

/** How far a tile is turned, folded into 0..3, as the board reads it. */
const turnOf = (spec, col, row) => ((Math.round(Number(spec.rot?.[keyOf(col, row)]) || 0) % 4) + 4) % 4;

/**
 * A point as it sits on the table, back in the map's own frame: undone
 * through the turn of the tile it is on. A world feature is drawn where the
 * ground it shapes has been turned to, so it is dragged back the same way.
 */
export function unturnPoint(spec, { x, y }) {
  const { cols, rows, T } = dims(spec);
  const col = Math.floor(x / T);
  const row = Math.floor(y / T);
  if (col < 0 || row < 0 || col >= cols || row >= rows) return { x, y };
  const l = intoTile(T, col, row, turnOf(spec, col, row), x, y);
  return { x: col * T + l.x, y: row * T + l.y };
}

/**
 * Move something already placed to a point as it sits on the table, as a
 * handle drag in 3D does: a ridge point, a volcano or a flat to its fraction
 * of the world, through the turn of the tile it lands on; a lake or a spring
 * to the millimetres of the tile it belongs to, turned back the way that
 * tile is turned, and kept on it, a hair in from its rim.
 */
export function moveFeature(spec, kind, index, { x, y }) {
  const { T } = dims(spec);
  const clamp = (v) => Math.max(2, Math.min(T - 2, v));
  const world = () => toWorld(spec, unturnPoint(spec, { x, y }));
  switch (kind) {
    case 'spine': if (Array.isArray(spec.spine) && spec.spine[index]) spec.spine[index] = world(); break;
    case 'volcano': if (spec.volcanoes?.[index]) spec.volcanoes[index].at = world(); break;
    case 'flat': if (spec.flats?.[index]) spec.flats[index].at = world(); break;
    case 'lake':
    case 'springpoint': {
      const spot = (kind === 'lake' ? spec.lakes?.place : spec.fountains?.place)?.[index];
      const p = parseLabel(spot?.tile);
      if (!p) break;
      const l = intoTile(T, p.col, p.row, turnOf(spec, p.col, p.row), x, y);
      spot.atMM = [r1(clamp(l.x)), r1(clamp(l.y))];
      break;
    }
    default: break;
  }
  return spec;
}

/**
 * Where a world feature at a board point (the map's own frame) sits on the
 * table: on whichever tile it is in, turned as that tile is.
 */
export function turnPoint(spec, { x, y }) {
  const { cols, rows, T } = dims(spec);
  const col = Math.floor(x / T);
  const row = Math.floor(y / T);
  if (col < 0 || row < 0 || col >= cols || row >= rows) return { x, y };
  let dx = x - (col * T + T / 2);
  let dy = y - (row * T + T / 2);
  for (let i = 0; i < turnOf(spec, col, row); i++) [dx, dy] = [dy, -dx];
  return { x: col * T + T / 2 + dx, y: row * T + T / 2 + dy };
}

/** Take one edit off a tile, by its place in the list. */
export function removeEdit(spec, label, index) {
  const list = editsFor(spec, label);
  if (index < 0 || index >= list.length) return spec;
  spec.edits[label] = list.filter((_, i) => i !== index);
  return tidy(spec);
}

/** Every edit off a tile. */
export function clearEdits(spec, label) {
  if (spec.edits) delete spec.edits[label];
  return tidy(spec);
}

/** What an edit did, in a few words, for the inspector's list. */
export function describeEdit(e) {
  const r = Number(e.radiusMM) || 0;
  const wide = `${Math.round(r * 2)} mm wide`;
  const along = (e.path?.length || 0) > 1 ? ' along a line' : '';
  switch (e.op) {
    case 'raise': return `Raised ${e.mm} mm${along}, ${wide}`;
    case 'lower': return `Lowered ${e.mm} mm${along}, ${wide}`;
    case 'smooth': return `Smoothed${along}, ${wide}`;
    case 'flatten': return `Flattened to ${e.toMM ?? 'where it began'} mm${along}, ${wide}`;
    case 'clear': return `Trees cleared${along}, ${wide}`;
    case 'plant': return `${e.kind === 'conifer' ? 'Conifers' : 'Broadleaf'} planted${along}, ${wide}`;
    default: return `${e.op}?`;
  }
}

/* --------------------------------------------------------------- printing */

/** The order the example writes its keys in, so the JSON reads the same however it was drawn. */
export const KEY_ORDER = ['name', 'seed', 'cols', 'rows', 'terraceMM', 'meshMM', 'metresPerMM', 'worldGrid',
  'spineHeightMM', 'spineWidthMM', 'baseElevMM', 'roughness', 'spine', 'flats', 'volcanoes', 'glacier', 'reposeDeg', 'reposePasses',
  'levels', 'falls', 'waterfalls', 'rot', 'cornerRaise', 'rivers', 'canopy', 'lakes', 'fountains', 'edits', 'joints', 'tray', 'contract'];

const ORDERS = {
  canopy: ['kind', 'crownMM', 'heightMM', 'density', 'spacingMM', 'minZMM', 'maxZMM', 'thinningMM', 'maxSlopeDeg', 'tiles', 'region'],
  volcanoes: ['at', 'heightMM', 'baseRadiusMM', 'craterRadiusMM', 'craterDepthMM', 'breachAzimuthDeg'],
  flats: ['at', 'radiusM', 'elevM'],
  lakes: ['fillHollows', 'depthMM', 'shoreMM', 'profile', 'place'],
  fountains: ['auto', 'tubeOdMM', 'poolRadiusMM', 'place'],
  place: ['tile', 'edge', 'atMM', 'pathMM', 'radiusMM', 'depthMM'],
  contract: ['tileMM', 'plateMM', 'outletZMM', 'edgeLandMM'],
};

/** An object's keys in a given order, then whatever else it has. */
function orderKeys(o, order) {
  if (!o || typeof o !== 'object' || Array.isArray(o)) return o;
  const out = {};
  for (const k of order) if (o[k] !== undefined) out[k] = o[k];
  for (const k of Object.keys(o)) if (!(k in out) && o[k] !== undefined) out[k] = o[k];
  return out;
}

export function canonical(spec) {
  const out = orderKeys(spec, KEY_ORDER);
  if (Array.isArray(out.rivers)) out.rivers = out.rivers.map((r) => (r && typeof r === 'object' ? orderRiver(r) : r));
  for (const k of ['canopy', 'volcanoes', 'flats']) if (Array.isArray(out[k])) out[k] = out[k].map((x) => orderKeys(x, ORDERS[k]));
  for (const k of ['lakes', 'fountains']) {
    if (!out[k] || typeof out[k] !== 'object') continue;
    out[k] = orderKeys(out[k], ORDERS[k]);
    if (Array.isArray(out[k].place)) out[k].place = out[k].place.map((x) => orderKeys(x, ORDERS.place));
  }
  if (out.contract) out.contract = orderKeys(out.contract, ORDERS.contract);
  return out;
}

/**
 * The spec as JSON a person can read: objects one key to a line, as
 * JSON.stringify does, but a short array of numbers or of short arrays --
 * a spine, a path, a point -- on one line, the way the example is written.
 */
export function formatSpec(value, indent = '') {
  if (!indent && value && typeof value === 'object' && !Array.isArray(value)) value = canonical(value);
  const inner = `${indent}  `;
  const flat = (v) => (Array.isArray(v) ? `[${v.map(flat).join(', ')}]` : JSON.stringify(v));
  const shallow = (v) => v === null || typeof v !== 'object' || (Array.isArray(v) && v.every((w) => w === null || typeof w !== 'object' || (Array.isArray(w) && w.every((u) => typeof u !== 'object'))));
  if (Array.isArray(value)) {
    if (!value.length) return '[]';
    const simple = value.every((v) => v === null || typeof v !== 'object' || (Array.isArray(v) && v.every((w) => w === null || typeof w !== 'object')));
    const one = `[${value.map(flat).join(', ')}]`;
    if (simple && one.length + indent.length <= 96) return one;
    return `[\n${value.map((v) => inner + formatSpec(v, inner)).join(',\n')}\n${indent}]`;
  }
  if (value && typeof value === 'object') {
    const keys = Object.keys(value).filter((k) => value[k] !== undefined);
    if (!keys.length) return '{}';
    const one = `{ ${keys.map((k) => `${flat(k)}: ${flat(value[k])}`).join(', ')} }`;
    const small = keys.length <= 6 && keys.every((k) => shallow(value[k]));
    if (small && one.length + indent.length <= 96) return one;
    return `{\n${keys.map((k) => `${inner}${flat(k)}: ${formatSpec(value[k], inner)}`).join(',\n')}\n${indent}}`;
  }
  return flat(value);
}

/* ---------------------------------------------------------------- reading */

/** The contract as the build will read it, defaults and all. */
export const contractOf = (spec) => makeContract(spec.contract || {});

/** Set a value at a dotted path ('lakes.depthMM'), deleting it for undefined. */
export function setPath(spec, path, value) {
  const parts = path.split('.');
  let o = spec;
  for (let i = 0; i < parts.length - 1; i++) {
    const k = parts[i];
    if (value === undefined && (o[k] === undefined || o[k] === null)) return spec;
    if (o[k] === undefined || o[k] === null || typeof o[k] !== 'object') o[k] = {};
    o = o[k];
  }
  const last = parts[parts.length - 1];
  if (value === undefined) delete o[last];
  else o[last] = value;
  return spec;
}

export function getPath(spec, path) {
  return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), spec);
}
