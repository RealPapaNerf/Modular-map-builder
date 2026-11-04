// Hand edits: kept as operations, replayed onto whatever ground the tile is
// cut from, never touching the rim.

import test from 'node:test';
import assert from 'node:assert/strict';
import { makeField } from '../lib/field.js';
import { buildMap, buildWorld } from '../lib/build.js';
import { writeSTL } from '../lib/stl.js';
import {
  applyGroundEdits, clearFilter, plantings, editsFor, strokeOf, distToStroke, falloff, rimWeight, EDIT_DEFAULTS,
} from '../lib/edits.js';

/** A 200 mm tile at 2.5 mm, every sample at `z`. */
function flat(z = 20) {
  const f = makeField(81, 81, 2.5, 0, 0);
  f.values.fill(z);
  return f;
}
const at = (f, x, y) => f.values[Math.round(y / f.step) * f.nx + Math.round(x / f.step)];
const rim = (f) => {
  const out = [];
  for (let k = 0; k < f.nx; k++) out.push(f.values[k], f.values[(f.ny - 1) * f.nx + k], f.values[k * f.nx], f.values[k * f.nx + f.nx - 1]);
  return out;
};

test('a stroke weighs 1 on its line and nothing at its radius; the rim weighs nothing and the lock ends 12 mm in', () => {
  assert.equal(falloff(0), 1);
  assert.equal(falloff(1), 0);
  assert.ok(Math.abs(falloff(0.5) - 0.5) < 1e-12);
  assert.equal(rimWeight(0, 100, 200), 0);
  assert.equal(rimWeight(100, 200, 200), 0);
  assert.equal(rimWeight(12, 100, 200), 1);
  assert.equal(rimWeight(100, 100, 200), 1);
  assert.ok(Math.abs(rimWeight(6, 100, 200) - 0.5) < 1e-12, 'smoothstep half way');
  assert.equal(EDIT_DEFAULTS.rimLockMM, 12);
  assert.deepEqual(strokeOf({ at: [3, 4] }), [[3, 4]]);
  assert.equal(distToStroke([[0, 0], [10, 0]], 5, 3), 3);
  assert.equal(distToStroke([[0, 0], [10, 0]], 13, 4), 5);
});

test('raise lifts a ridge with a level crest along its line, and leaves the rim exactly as it was', () => {
  const f = flat(20);
  const before = rim(f);
  const r = applyGroundEdits(f, [{ op: 'raise', path: [[60, 100], [140, 100]], radiusMM: 20, mm: 4 }]);
  assert.equal(r.applied, 1);
  for (const x of [60, 80, 100, 120, 140]) assert.ok(Math.abs(at(f, x, 100) - 24) < 1e-9, `crest at x ${x}`);
  assert.ok(Math.abs(at(f, 100, 110) - 22) < 1e-9, 'half way down at half the radius');
  assert.equal(at(f, 100, 125), 20, 'nothing past the radius');
  assert.deepEqual(rim(f), before);
});

test('a stroke across the rim fades to nothing on it', () => {
  const f = flat(20);
  const before = rim(f);
  applyGroundEdits(f, [{ op: 'raise', path: [[0, 100], [40, 100]], radiusMM: 15, mm: 10 }]);
  assert.deepEqual(rim(f), before, 'the rim is untouched');
  assert.ok(Math.abs(at(f, 5, 100) - (20 + 10 * rimWeight(5, 100, 200))) < 1e-9, 'inside the lock, scaled by it');
  assert.ok(Math.abs(at(f, 20, 100) - 30) < 1e-9, 'past the lock, the whole stroke');
});

test('lower never digs through the 2 mm floor, and does not lift what was already under it', () => {
  const f = flat(6);
  f.values[40 * 81 + 41] = 1; // a cell already below the floor
  applyGroundEdits(f, [{ op: 'lower', path: [[100, 100]], radiusMM: 30, mm: 10 }]);
  assert.equal(at(f, 100, 100), 2);
  assert.equal(f.values[40 * 81 + 41], 1);
  let lo = Infinity;
  for (const v of f.values) lo = Math.min(lo, v);
  assert.equal(lo, 1);
});

test('flatten takes the ground to one height, and to where the stroke began when no height is given', () => {
  const f = flat(20);
  for (let i = 0; i < f.values.length; i++) f.values[i] = 20 + (i % 81) * 0.1; // a slope eastward
  applyGroundEdits(f, [{ op: 'flatten', at: [100, 100], radiusMM: 20, toMM: 30 }]);
  assert.ok(Math.abs(at(f, 100, 100) - 30) < 1e-9);
  const g = flat(20);
  for (let i = 0; i < g.values.length; i++) g.values[i] = 20 + (i % 81) * 0.1;
  const start = at(g, 50, 100);
  applyGroundEdits(g, [{ op: 'flatten', path: [[50, 100], [150, 100]], radiusMM: 10 }]);
  for (const x of [50, 100, 150]) assert.ok(Math.abs(at(g, x, 100) - start) < 1e-9, `level at x ${x}`);
});

test('smooth calms the ground under the stroke and only there', () => {
  const f = flat(20);
  for (let j = 0; j < 81; j++) for (let i = 0; i < 81; i++) f.values[j * 81 + i] = 20 + ((i + j) % 2 ? 3 : -3);
  const spread = (g, x0, x1) => {
    let lo = Infinity; let hi = -Infinity;
    for (let x = x0; x <= x1; x += 2.5) { const v = at(g, x, 100); lo = Math.min(lo, v); hi = Math.max(hi, v); }
    return hi - lo;
  };
  const before = spread(f, 90, 110);
  const edge = rim(f);
  const far = at(f, 100, 150);
  applyGroundEdits(f, [{ op: 'smooth', path: [[80, 100], [120, 100]], radiusMM: 15, strength: 1 }]);
  assert.ok(spread(f, 90, 110) < before / 4, 'the checkerboard is smoothed out');
  assert.equal(at(f, 100, 150), far, 'far from the stroke, untouched');
  assert.deepEqual(rim(f), edge);
});

test('edits are replayed in order, the same way every time, and anything unknown is said rather than guessed', () => {
  const ops = [
    { op: 'raise', path: [[50, 50], [150, 150]], radiusMM: 25, mm: 6 },
    { op: 'smooth', path: [[100, 100]], radiusMM: 30 },
    { op: 'flatten', at: [60, 140], radiusMM: 15, toMM: 12 },
    { op: 'dig', at: [10, 10], radiusMM: 5 },
    { op: 'raise', path: [], radiusMM: 5, mm: 2 },
    { op: 'clear', path: [[30, 30]], radiusMM: 10 },
  ];
  const a = flat(20);
  const b = flat(20);
  const ra = applyGroundEdits(a, ops);
  applyGroundEdits(b, ops);
  assert.deepEqual(Array.from(a.values), Array.from(b.values));
  assert.equal(ra.applied, 3);
  assert.deepEqual(ra.skipped.map((s) => s.index), [3, 4], 'the unknown op and the empty stroke; the tree op is not the ground\'s');
  const c = flat(20);
  applyGroundEdits(c, [ops[2], ops[1], ops[0]]);
  assert.notDeepEqual(Array.from(c.values), Array.from(a.values), 'order matters, so order is kept');
});

test('cleared ground keeps its trees off; a planted wood has its own kind, density and seed', () => {
  assert.equal(clearFilter([{ op: 'raise', path: [[0, 0]], radiusMM: 5, mm: 1 }]), null);
  const keep = clearFilter([{ op: 'clear', path: [[50, 50], [80, 50]], radiusMM: 10 }]);
  assert.equal(keep(60, 55), false);
  assert.equal(keep(60, 65), true);
  const ops = [{ op: 'plant', path: [[100, 100]], radiusMM: 30, kind: 'conifer', density: 0.8 }, { op: 'plant', path: [[20, 20]], radiusMM: 0 }];
  const p = plantings(ops);
  assert.equal(p.length, 1, 'a stroke with no radius plants nothing');
  assert.equal(p[0].kind, 'conifer');
  assert.equal(p[0].density, 0.8);
  assert.equal(p[0].inside(110, 100), true);
  assert.equal(p[0].inside(140, 100), false);
  assert.equal(plantings(ops)[0].seed, p[0].seed, 'the same stroke, the same trees');
  assert.equal(editsFor({ edits: { B2: [ops[0], null] } }, 'B2').length, 1);
  assert.deepEqual(editsFor({}, 'B2'), []);
});

/* ------------------------------------------------------------- the build */

// A small map with nothing that moves with the ground except the ground: no
// woods, no tarns, so the difference an edit makes is the edit itself.
const RIDGE = { op: 'raise', path: [[50, 60], [150, 140]], radiusMM: 18, mm: 5 };
const base = (seed, edits) => ({
  name: 'ridge', seed, cols: 2, rows: 1, meshMM: 2.5, glacier: false,
  rivers: [{ name: 'r', size: 'creek', path: [[0, 0], [1, 0]], sourceEdge: 'W', sinkEdge: 'E' }],
  lakes: { fillHollows: false },
  ...(edits ? { edits } : {}),
});
const tileOf = (r, label) => r.tiles.find((t) => t.label === label);
const worstEdge = (r) => Math.max(...r.tiles.map((t) => t.edges.worst));

test('DONE WHEN: a raised ridge survives a change of seed, and the edge check still reads zero', () => {
  for (const seed of [7, 8]) {
    const plain = buildMap(base(seed));
    const ridged = buildMap(base(seed, { B1: [RIDGE] }));
    assert.ok(worstEdge(ridged) < 1e-6, `seed ${seed}: worst edge ${worstEdge(ridged)} mm`);
    const a = tileOf(plain, 'B1').local;
    const b = tileOf(ridged, 'B1').local;
    // Along the crest, away from where the river was cut, the ground stands 5 mm higher.
    for (const [x, y] of [[50, 60], [75, 80], [125, 120], [150, 140]]) {
      const k = Math.round(y / a.step) * a.nx + Math.round(x / a.step);
      assert.ok(Math.abs(b.values[k] - a.values[k] - 5) < 1e-6, `seed ${seed}: +${(b.values[k] - a.values[k]).toFixed(4)} mm at ${x},${y}`);
    }
    // And A1 has no edits, so A1 is byte for byte what it was.
    assert.deepEqual(Buffer.from(writeSTL(tileOf(ridged, 'A1').tris, 'A1')), Buffer.from(writeSTL(tileOf(plain, 'A1').tris, 'A1')));
  }
  // The two seeds really are different ground under the same ridge.
  const s7 = tileOf(buildMap(base(7, { B1: [RIDGE] })), 'B1').local.values;
  const s8 = tileOf(buildMap(base(8, { B1: [RIDGE] })), 'B1').local.values;
  assert.notDeepEqual(Array.from(s7), Array.from(s8));
});

test('a spec with edits builds the same bytes twice, and a world handed in builds the same bytes as one grown', () => {
  const spec = { ...base(3, { A1: [RIDGE, { op: 'smooth', path: [[100, 100]], radiusMM: 30 }], B1: [{ op: 'flatten', at: [100, 100], radiusMM: 25, toMM: 20 }] }), glacier: { cycles: 2 } };
  const one = buildMap(spec);
  const two = buildMap(spec);
  const given = buildMap(spec, () => {}, { world: buildWorld(spec) });
  for (let i = 0; i < one.tiles.length; i++) {
    const bytes = Buffer.from(writeSTL(one.tiles[i].tris, 't'));
    assert.deepEqual(Buffer.from(writeSTL(two.tiles[i].tris, 't')), bytes, `tile ${i} twice`);
    assert.deepEqual(Buffer.from(writeSTL(given.tiles[i].tris, 't')), bytes, `tile ${i} on a world handed in`);
  }
  assert.ok(worstEdge(one) < 1e-6);
});

test('cleared ground grows no trees and a planted wood grows where it was drawn', () => {
  const woods = { canopy: [{ kind: 'deciduous', density: 0.6, tiles: ['A1'] }] };
  const trees = (r, label) => tileOf(r, label).trees;
  const plain = buildMap({ ...base(5), ...woods });
  const cleared = buildMap({ ...base(5, { A1: [{ op: 'clear', path: [[40, 40], [160, 160]], radiusMM: 40 }] }), ...woods });
  assert.ok(trees(cleared, 'A1') < trees(plain, 'A1') * 0.75, `${trees(cleared, 'A1')} trees left of ${trees(plain, 'A1')}`);
  assert.equal(trees(plain, 'B1'), 0);
  const planted = buildMap({ ...base(5, { B1: [{ op: 'plant', path: [[60, 150], [140, 150]], radiusMM: 25, kind: 'conifer' }] }), ...woods });
  assert.ok(trees(planted, 'B1') > 5, `${trees(planted, 'B1')} trees planted`);
  assert.ok(worstEdge(planted) < 1e-6);
  const w = tileOf(planted, 'B1').woods.find((x) => x.planted);
  assert.equal(w.kind, 'conifer');
});

test('edits for a tile the map does not have are kept and said', () => {
  const r = buildMap(base(2, { C9: [RIDGE] }));
  assert.ok(r.problems.some((p) => p.kind === 'edit' && /C9/.test(p.message)));
  const bad = buildMap(base(2, { A1: [{ op: 'bulldoze', at: [100, 100], radiusMM: 10 }] }));
  assert.ok(bad.problems.some((p) => p.kind === 'edit' && /bulldoze/.test(p.message)));
});
