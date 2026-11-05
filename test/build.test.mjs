import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildTile, buildWorld, worldKey } from '../lib/build.js';
import { makeContract, portFloor, EDGES } from '../lib/contract.js';
import { cutTile } from '../lib/tile.js';
import { meshTile, checkWatertight } from '../lib/mesh.js';
import { makeField, fill } from '../lib/field.js';
import { writeSTL } from '../lib/stl.js';
import { EXAMPLE_SPEC } from '../lib/example.js';
import { isBoardSpec } from '../lib/scale.js';

// A small module, quick to grow: coarse world, draft mesh, no ice.
const SPEC = {
  name: 'test', seed: 3, meshMM: 3, worldGrid: 48,
  spine: [[-60, 150], [120, 130], [280, 160]],
  glacier: false,
  channels: [{ name: 'main', widthMM: 30, path: [[100, 200], [110, 120], [90, 60], [100, 0]] }],
  lakes: { fillHollows: false },
};

test('the finished module honours its edge contract exactly', () => {
  const r = buildTile(SPEC);
  assert.equal(r.problems.filter((p) => p.severity === 'error').length, 0, JSON.stringify(r.problems));
  assert.ok(r.tile.edges.worst < 1e-6, `${r.tile.edges.worst.toFixed(6)} mm off its contract`);
  assert.deepEqual(r.tile.ports, { N: true, E: false, S: true, W: false });
  assert.equal(r.tile.signatures.N, `channel 30@${portFloor(r.contract)} 22`);
  assert.equal(r.tile.signatures.E, 'land 22');
});

test('the finished module is a closed solid of exactly the declared size', () => {
  const r = buildTile(SPEC);
  assert.ok(r.tile.mesh.watertight, `${r.tile.mesh.unpaired} unpaired edges, ${r.tile.mesh.overused} overused`);
  assert.ok(Math.abs(r.tile.bbox.size[0] - 200) < 1e-6);
  assert.ok(Math.abs(r.tile.bbox.size[1] - 200) < 1e-6);
  assert.ok(r.tile.bbox.lo[2] === 0, 'it stands on the table');
});

test('any two modules built to one contract mate: a land edge against a land edge, a channel edge against a channel edge', () => {
  // Two different modules, different seeds, different channels. A's east
  // edge against B's west: the same line. A's north against B's south, both
  // with a channel: the same line, port and all.
  const a = buildTile({ ...SPEC, seed: 11, channels: [{ path: [[100, 200], [60, 100], [0, 100]] }] }).tile.local;
  const b = buildTile({ ...SPEC, seed: 12, spine: [[20, 40], [180, 60]], channels: [{ path: [[200, 100], [140, 40], [100, 0]] }] }).tile.local;
  const n = a.nx;
  assert.equal(b.nx, n);
  for (let k = 0; k < n; k++) {
    // A's east column, south to north, against B's west column, south to north: a port on both at the middle.
    assert.ok(Math.abs(a.values[k * n + n - 1] - b.values[k * n]) < 1e-6, `E/W at ${k}`);
    // A's north row against B's south row: both channels, one line.
    assert.ok(Math.abs(a.values[(n - 1) * n + k] - b.values[k]) < 1e-6, `N/S at ${k}`);
  }
});

test('a module with no channel is land on all four sides and has no port', () => {
  const r = buildTile({ ...SPEC, channels: [] });
  assert.deepEqual(r.tile.ports, { N: false, E: false, S: false, W: false });
  for (const e of EDGES) assert.equal(r.tile.signatures[e], 'land 22');
  const n = r.tile.local.nx;
  for (let k = 0; k < n; k++) assert.ok(Math.abs(r.tile.local.values[k] - 22) < 1e-6);
});

test('the same spec builds the same bytes twice, and a world handed in builds the same bytes as one grown', () => {
  const one = buildTile(SPEC);
  const two = buildTile(SPEC);
  const given = buildTile(SPEC, () => {}, { world: buildWorld(SPEC) });
  const bytes = Buffer.from(writeSTL(one.tile.tris, 't'));
  assert.deepEqual(Buffer.from(writeSTL(two.tile.tris, 't')), bytes);
  assert.deepEqual(Buffer.from(writeSTL(given.tile.tris, 't')), bytes);
});

test('the world is the module and its margin, and features are in module millimetres', () => {
  const w = buildWorld({ ...SPEC, marginMM: 100 });
  const T = 200;
  assert.ok(Math.abs(w.worldSizeM - (T + 200) * 25) < 1e-6, '400 mm of ground at 25 m/mm');
  assert.equal(w.marginMM, 100);
  // A volcano at the middle of the module is the highest thing on a flat world.
  const v = buildWorld({ seed: 1, worldGrid: 48, glacier: false, spineHeightMM: 0, roughness: 0, volcanoes: [{ at: [100, 100], heightMM: 40, baseRadiusMM: 60 }] });
  let best = 0; let bi = 0;
  for (let k = 0; k < v.bed.values.length; k++) if (v.bed.values[k] > best) { best = v.bed.values[k]; bi = k; }
  const i = bi % v.bed.nx; const j = (bi - i) / v.bed.nx;
  assert.ok(Math.abs(i * v.bed.step - 200 * 25) < 2 * v.bed.step, 'the vent is 100 mm plus the 100 mm margin in');
  assert.ok(Math.abs(j * v.bed.step - 200 * 25) < 2 * v.bed.step);
});

test('the module is cut from the middle of the world, with its rim where a channel leaves it', () => {
  const c = makeContract();
  const w = makeField(41, 41, 250, 0, 0); // 10 km square: a 200 mm module with 100 mm margins at 25 m/mm
  fill(w, (x) => x * 0.1); // rising eastward, 1 km over the world
  const local = cutTile(w, c, { marginMM: 100, metresPerMM: 25, meshMM: 5, ports: { W: true, E: true } });
  const n = local.nx;
  const mid = (n - 1) / 2;
  // The lean has taken the tilt out: the rim is at the datum on every side.
  for (let k = 0; k < n; k++) {
    assert.ok(Math.abs(local.values[k * n] - c.edgeLandMM) < 1e-6, 'west rim');
    assert.ok(Math.abs(local.values[k * n + n - 1] - c.edgeLandMM) < 1e-6, 'east rim');
  }
  assert.ok(Math.abs(local.values[mid * n + mid] - c.edgeLandMM) < 1e-6, 'a plane tilt leaves the middle at the datum too');
  // Ground below the rim is squeezed, never through the plate.
  const deep = makeField(41, 41, 250, 0, 0);
  fill(deep, (x, y) => (Math.hypot(x - 5000, y - 5000) < 1500 ? -3000 : 0)); // a 3 km hole in the middle of the module
  const squeezed = cutTile(deep, c, { marginMM: 100, metresPerMM: 25, meshMM: 5 });
  let lo = Infinity;
  for (const v of squeezed.values) lo = Math.min(lo, v);
  assert.ok(lo >= c.minLandMM - 1e-6, `the floor is kept: lowest ${lo.toFixed(2)} mm`);
  assert.ok(squeezed.squeezedMM > 50, 'and the report knows how much was taken out of it');
});

test('a broken contract stops the build, and an old board spec is refused as one', () => {
  const r = buildTile({ ...SPEC, contract: { portWidthMM: 150 } });
  assert.ok(r.contractNotes.some((n) => n.severity === 'error'));
  assert.ok(isBoardSpec({ cols: 3, rows: 3, rivers: [] }));
  assert.ok(isBoardSpec({ spine: [[0.1, 0.8], [0.9, 0.7]] }), 'a spine in fractions is the old frame');
  assert.ok(!isBoardSpec(EXAMPLE_SPEC));
  assert.ok(!isBoardSpec({ name: 'x' }));
});

test('STL round-trips to the right byte count', () => {
  const f = makeField(5, 5, 50);
  f.values.fill(10);
  const tris = meshTile(f);
  const bytes = writeSTL(tris, 'x');
  const count = new DataView(bytes.buffer, bytes.byteOffset).getUint32(80, true);
  assert.equal(count, tris.length / 9);
  assert.equal(bytes.byteLength, 84 + count * 50);
  assert.ok(checkWatertight(tris).watertight);
});

test('the world is keyed on the fields the ground depends on, and nothing else', () => {
  const a = worldKey(SPEC);
  assert.equal(worldKey({ ...SPEC, channels: [], canopy: [{}], edits: [{ op: 'raise' }], name: 'other' }), a, 'a channel or a stroke does not grow the world again');
  assert.notEqual(worldKey({ ...SPEC, seed: 4 }), a);
  assert.notEqual(worldKey({ ...SPEC, spine: [[0, 0], [1, 1]] }), a);
  assert.notEqual(worldKey({ ...SPEC, marginMM: 50 }), a);
  assert.notEqual(worldKey(SPEC, { ice: true }), worldKey({ ...SPEC, glacier: { cycles: 3 } }, { ice: true }));
});

test('the example grows with its channel down the valley and its ice gone', { timeout: 300000 }, () => {
  const r = buildTile({ ...EXAMPLE_SPEC, meshMM: 2.5, glacier: { ...EXAMPLE_SPEC.glacier, cycles: 6 } });
  assert.ok(r.tile.edges.worst < 1e-6);
  assert.ok(r.tile.mesh.watertight);
  assert.equal(r.world.glacierStats.finalIceM, 0, 'no ice on the module');
  assert.ok(r.world.glacierStats.maxIceM > 0, 'but there was ice');
  const [ch] = r.tile.channels;
  assert.equal(ch.routed, true);
  assert.equal(ch.to, 'S');
  assert.equal(ch.from, null);
  assert.ok(Math.abs(ch.endFloorMM - portFloor(r.contract)) < 1e-6);
  assert.ok(r.tile.springs.length === 1, 'a spring at its start');
});
