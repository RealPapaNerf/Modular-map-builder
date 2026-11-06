import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeField, fill } from '../lib/field.js';
import { makeContract } from '../lib/contract.js';
import { meshTile, checkWatertight, boundingBox } from '../lib/mesh.js';
import {
  edgeKeys, cutRecesses, keySolid, keyOutline, keySheet, earClip, usableKeys,
  edgeFrame, jointSettings, JOINT_DEFAULTS,
} from '../lib/joint.js';

const c = makeContract();
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

test('every edge gets the same recesses, mirrored about its middle, so any two modules meet', () => {
  // A module is built alone. Its east edge's recess at u has to land on the
  // next module's west edge at T - u, whichever module that turns out to be,
  // so the set of positions on every edge is symmetric about the middle.
  const keys = edgeKeys(c);
  assert.equal(keys.length, 8, 'two a side on a 200 mm module at 120 mm spacing');
  for (const e of ['N', 'E', 'S', 'W']) {
    const us = keys.filter((k) => k.edge === e).map((k) => k.uMM).sort((p, q) => p - q);
    assert.equal(us.length, 2);
    assert.ok(Math.abs(us[0] + us[1] - c.tileMM) < 1e-9, `${e}: ${us} are not mirror positions`);
  }
  assert.equal(edgeKeys(c, { spacingMM: 200 }).length, 4);
  assert.equal(edgeKeys(c, { enabled: false }).length, 0);
  const port = c.tileMM / 2;
  for (const k of keys) assert.ok(Math.abs(k.uMM - port) > c.portWidthMM / 2 + 10, 'a key is never under the port in the middle of the side');
});

test('the keys to print are the recesses that were cut', () => {
  assert.equal(usableKeys({ keys: [{ id: 'a' }, { id: 'b' }] }).length, 2);
  assert.equal(usableKeys({}).length, 0);
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
