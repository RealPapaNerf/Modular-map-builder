import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeField, fill } from '../lib/field.js';
import { makeContract } from '../lib/contract.js';
import { meshTile, checkWatertight, boundingBox } from '../lib/mesh.js';
import {
  planKeys, cutRecesses, keySolid, keyOutline, keySheet, earClip,
  edgeFrame, jointSettings, JOINT_DEFAULTS,
} from '../lib/joint.js';

const c = makeContract();
const mk = (col, row, edges = {}) => [`${col},${row}`, { col, row, edges }];
const tile = (z = 20, n = 201) => {
  const f = makeField(n, n, c.tileMM / (n - 1));
  f.values.fill(z);
  return f;
};

test('the key is a closed solid despite its reflex corners', () => {
  // A dog-bone is not convex: both shoulders turn the wrong way, so a fan
  // from one vertex puts triangles outside the shape. Ear clipping is why
  // this passes.
  const poly = keyOutline();
  assert.equal(poly.length, 12);
  assert.equal(earClip(poly).length, 10, 'a simple polygon of n vertices gives n-2 triangles');
  const w = checkWatertight(keySolid());
  assert.ok(w.watertight, `${w.unpaired} unpaired edges`);
});

test('a sheet of keys is a closed solid too', () => {
  assert.ok(checkWatertight(keySheet(9)).watertight);
});

test('the neck is always narrower than the pad, whatever is asked for', () => {
  // A neck as wide as its pad is a plain spline: it registers but it does
  // not lock, and the seam opens.
  const j = jointSettings({ padMM: 20, neckMM: 40 });
  assert.ok(j.neckMM < j.padMM, `neck ${j.neckMM} against pad ${j.padMM}`);
});

test('the key is smaller than its recess by the clearance, so it drops in', () => {
  const j = jointSettings({ padMM: 20, neckMM: 9, depthMM: 3, clearanceMM: 0.35 });
  const bb = boundingBox(keySolid(j));
  assert.ok(bb.size[0] < j.padMM, `key is ${bb.size[0].toFixed(2)} mm across a ${j.padMM} mm pad recess`);
  assert.ok(bb.size[2] < j.depthMM, 'and sits below the surface of the plate');
  assert.ok(bb.size[2] > j.depthMM - 1, 'but not so far it rattles');
});

test('the two halves of a key land on the same point of the seam', () => {
  // A at (0,0) keyed on its east edge against B at (1,0) on its west. The
  // halves are planned from one number, and this is the check that the two
  // edge frames actually agree about where that number is.
  const T = c.tileMM;
  const u = 73;
  const fa = edgeFrame(c, 'E');
  const fb = edgeFrame(c, 'W');
  const at = (f, uu) => [f.o[0] + f.u[0] * uu, f.o[1] + f.u[1] * uu];
  const [ax, ay] = at(fa, u);
  const [bx, by] = at(fb, T - u);
  assert.ok(Math.abs((0 * T + ax) - (1 * T + bx)) < 1e-9, 'x disagrees across the seam');
  assert.ok(Math.abs(ay - by) < 1e-9, 'y disagrees along the seam');
});

test('keys go only between tiles at the same plate level', () => {
  // Two tiles a plate apart have undersides 10 mm apart and cannot share
  // anything cut into them.
  const tiles = new Map([mk(0, 0), mk(1, 0), mk(0, 1)]);
  const same = planKeys(tiles, new Map([['0,0', 2], ['1,0', 2], ['0,1', 2]]), c);
  const stepped = planKeys(tiles, new Map([['0,0', 2], ['1,0', 2], ['0,1', 5]]), c);
  assert.ok(same.length > stepped.length, `${same.length} against ${stepped.length}`);
  for (const k of stepped) {
    assert.ok(!(k.a.row !== k.b.row), 'the seam with a level change should have been skipped');
  }
});

test('each key is planned once, from one side of the seam', () => {
  const tiles = new Map([mk(0, 0), mk(1, 0)]);
  const keys = planKeys(tiles, new Map([['0,0', 0], ['1,0', 0]]), c, { spacingMM: 200 });
  assert.equal(keys.length, 1);
  assert.equal(keys[0].a.edge, 'E');
  assert.equal(keys[0].b.edge, 'W');
  assert.ok(Math.abs(keys[0].a.uMM + keys[0].b.uMM - c.tileMM) < 1e-9,
    'the two halves are mirror positions on the same seam');
});

test('a recess never breaks through to the map face', () => {
  const f = tile(20);
  const before = Float64Array.from(f.values);
  const keys = [{ edge: 'E', uMM: 100, id: 'k' }];
  const r = cutRecesses(f, c, keys, { depthMM: 3 });
  assert.deepEqual(Array.from(f.values), Array.from(before), 'the top surface must be untouched');
  assert.ok(r.placed.length === 1);
  let cut = 0;
  for (const v of r.floor) if (v > 0) cut++;
  assert.ok(cut > 0, 'and something was actually taken out of the underside');
});

test('a recess where the plate runs thin is refused WHOLE, not cut short', () => {
  // A recess a key cannot sit in is worse than no recess: the tile rocks.
  const f = tile(20);
  // A river channel across where the key would go.
  const n = f.nx;
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const y = j * f.step;
      if (Math.abs(y - 100) < 12) f.values[j * n + i] = 2.5;
    }
  }
  const r = cutRecesses(f, c, [{ edge: 'E', uMM: 100, id: 'k' }], { depthMM: 3, minFloorMM: 1.6 });
  assert.equal(r.placed.length, 0);
  assert.equal(r.refused.length, 1);
  assert.match(r.refused[0].why, /only 2\.5 mm there/);
  for (const v of r.floor) assert.equal(v, 0, 'nothing should have been cut');
});

test('a recess that runs into a tube bore is refused', () => {
  const f = tile(20);
  const bore = { x: c.tileMM - 12, y: 100, rMM: 6.75 };
  const r = cutRecesses(f, c, [{ edge: 'E', uMM: 100, id: 'k' }], {}, [bore]);
  assert.equal(r.placed.length, 0);
  assert.match(r.refused[0].why, /tube bore/);
});

test('a tile with recesses is still a closed solid', () => {
  const f = tile(20, 161);
  const keys = [
    { edge: 'E', uMM: 70, id: 'a' }, { edge: 'E', uMM: 140, id: 'b' },
    { edge: 'N', uMM: 100, id: 'cc' }, { edge: 'S', uMM: 60, id: 'd' },
  ];
  const r = cutRecesses(f, c, keys, {});
  assert.equal(r.placed.length, 4);
  const w = checkWatertight(meshTile(f, { floor: r.floor }));
  assert.ok(w.watertight, `${w.unpaired} unpaired, ${w.overused} overused`);
});

test('a recess and a bore in one tile still close', () => {
  const f = tile(20, 161);
  const bore = { x: 60, y: 60, rMM: 6.75 };
  const r = cutRecesses(f, c, [{ edge: 'E', uMM: 100, id: 'k' }], {}, [bore]);
  const w = checkWatertight(meshTile(f, { floor: r.any ? r.floor : null, bores: [bore] }));
  assert.ok(w.watertight);
});

test('the recess is deeper than the key is thick, by the clearance', () => {
  const j = jointSettings({ depthMM: 3, clearanceMM: 0.35 });
  const h = boundingBox(keySolid(j)).size[2];
  assert.ok(Math.abs(h - (j.depthMM - j.clearanceMM)) < 1e-6,
    `key is ${h.toFixed(2)} mm thick in a ${j.depthMM} mm recess`);
});
