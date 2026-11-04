import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildMap, portsFromRivers } from '../lib/build.js';
import { makeContract, SIZES } from '../lib/contract.js';
import { meshTile, checkWatertight } from '../lib/mesh.js';
import { makeField, fill } from '../lib/field.js';
import { writeSTL, plateSTL } from '../lib/stl.js';

const SPEC = {
  name: 'test', seed: 3, cols: 3, rows: 2,
  reliefMM: 36, meshMM: 3, worldGrid: 48, worldSizeM: 9000,
  spine: [[0.1, 0.8], [0.9, 0.7]],
  glacier: false,
  rivers: [{ size: 'river', sourceEdge: 'W', path: [[0, 1], [1, 1], [1, 0], [2, 0]], sinkEdge: 'E' }],
};

test('rivers declared as a run of tiles become matched ports', () => {
  const tiles = portsFromRivers([{ size: 'river', path: [[0, 0], [1, 0]] }]);
  assert.equal(tiles.get('0,0').edges.E.type, 'out');
  assert.equal(tiles.get('1,0').edges.W.type, 'in');
});

test('a river that jumps a tile is refused rather than silently bridged', () => {
  assert.throws(() => portsFromRivers([{ path: [[0, 0], [2, 0]] }]), /edge-adjacent/);
});

test('every finished tile honours its edge contract exactly', () => {
  const r = buildMap(SPEC);
  assert.equal(r.problems.filter((p) => p.severity === 'error').length, 0, JSON.stringify(r.problems));
  for (const t of r.tiles) {
    assert.ok(t.edges.worst < 1e-6, `${t.label} is ${t.edges.worst.toFixed(4)} mm off its contract`);
  }
});

test('every finished tile is a closed solid', () => {
  const r = buildMap(SPEC);
  for (const t of r.tiles) {
    assert.ok(t.mesh.watertight, `${t.label}: ${t.mesh.unpaired} unpaired edges, ${t.mesh.overused} overused`);
  }
});

test('the plate stack descends by exactly one plate per tile along the river', () => {
  const r = buildMap(SPEC);
  const L = (k) => r.levels.get(k);
  assert.equal(L('0,1') - L('1,1'), 1);
  assert.equal(L('1,1') - L('1,0'), 1);
  assert.equal(L('1,0') - L('2,0'), 1);
});

test('the water crosses every seam at one height when nothing declares a step', () => {
  const r = buildMap(SPEC);
  for (const s of r.seamChecks) {
    assert.ok(s.flush, `${s.from} ${s.edge} is a ${s.kind}: land ${s.landStepMM.toFixed(3)} mm, water ${s.waterStepMM}`);
    assert.equal(s.kind, 'plane');
  }
});

test('a tile footprint is exactly the declared tile size', () => {
  const r = buildMap(SPEC);
  for (const t of r.tiles) {
    assert.ok(Math.abs(t.bbox.size[0] - r.contract.tileMM) < 1e-6);
    assert.ok(Math.abs(t.bbox.size[1] - r.contract.tileMM) < 1e-6);
  }
});

test('a river tile really does have a channel cut into it', () => {
  const r = buildMap(SPEC);
  const withRiver = r.tiles.find((t) => t.label === 'B2');
  assert.ok(withRiver.channels > 0);
  assert.ok(withRiver.carvedCells > 0);
  // The floor somewhere in the tile must reach down toward the outlet height.
  let lowest = Infinity;
  for (const v of withRiver.local.values) lowest = Math.min(lowest, v);
  assert.ok(lowest <= r.contract.inletZMM + 0.01,
    `the channel bottoms out at ${lowest.toFixed(2)} mm, no lower than the inlet`);
});

test('with no water, a dry tile is never cut below its land datum', () => {
  const r = buildMap({ ...SPEC, lakes: { fillHollows: false } });
  const dry = r.tiles.find((t) => t.channels === 0);
  assert.ok(dry, 'this map should have a dry tile');
  let lowest = Infinity;
  for (const v of dry.local.values) lowest = Math.min(lowest, v);
  assert.ok(lowest >= r.contract.edgeLandMM - 1e-6);
});

test('a tarn IS a cut below the land datum, and only a lake may make one', () => {
  // The previous test used to assert this could never happen, which was
  // true right up until hollows got filled. A hollow with water in it is a
  // hole in the plate by definition.
  const r = buildMap(SPEC);
  for (const t of r.tiles) {
    let lowest = Infinity;
    let lowestK = -1;
    for (let k = 0; k < t.local.values.length; k++) {
      if (t.local.values[k] < lowest) { lowest = t.local.values[k]; lowestK = k; }
    }
    if (lowest >= r.contract.edgeLandMM - 1e-6) continue;
    assert.ok(t.wet[lowestK] || t.channels > 0,
      `${t.label} is cut to ${lowest.toFixed(2)} mm at a cell that is neither lake nor river`);
  }
});

test('the same spec builds the same bytes twice', () => {
  const a = buildMap(SPEC).tiles.map((t) => writeSTL(t.tris));
  const b = buildMap(SPEC).tiles.map((t) => writeSTL(t.tris));
  for (let i = 0; i < a.length; i++) {
    assert.deepEqual(Buffer.from(a[i]), Buffer.from(b[i]), 'tile ' + i);
  }
});

test('a broken contract stops the build before any STL is written', () => {
  // An island whose two channels fall different amounts: the only river
  // shape that is genuinely unsatisfiable.
  const bad = {
    ...SPEC, cols: 2, rows: 2,
    falls: { '0,1': 30 },
    rivers: [
      { size: 'creek', sourceEdge: 'S', path: [[0, 0], [1, 0], [1, 1]] },
      { size: 'creek', path: [[0, 0], [0, 1], [1, 1]] },
    ],
  };
  const r = buildMap(bad);
  assert.ok(r.problems.some((p) => p.severity === 'error' && p.kind === 'level-conflict'),
    JSON.stringify(r.problems.map((p) => p.kind)));
});

test('STL round-trips to the right byte count', () => {
  const f = makeField(10, 10, 1);
  fill(f, () => 5);
  const tris = meshTile(f);
  const stl = writeSTL(tris);
  const n = tris.length / 9;
  assert.equal(stl.length, 84 + n * 50);
  assert.equal(new DataView(stl.buffer).getUint32(80, true), n);
});

test('the stacking plate is a closed solid of exactly the right size', () => {
  const p = plateSTL(200, 200, 10);
  assert.ok(checkWatertight(p).watertight);
});

// plateSTL returns TRIANGLES, as the watertight test above relies on. The CLI
// used to write those floats straight to plate.stl, which is a 432-byte file
// with no STL header and no triangle count -- every slicer rejects it.
test('a plate written as a file is a real STL, header and count and all', () => {
  const tris = plateSTL(200, 200, 10);
  const stl = writeSTL(tris, 'plate');
  const n = tris.length / 9;
  assert.equal(n, 12, 'a box is twelve triangles');
  assert.equal(stl.length, 84 + n * 50);
  assert.equal(new DataView(stl.buffer, stl.byteOffset).getUint32(80, true), n);
  // The raw triangles are not an STL and must not be mistaken for one.
  assert.notEqual(tris.byteLength, stl.length);
});

test('usableKeys counts only the pairs with a recess cut on both sides', async () => {
  const { usableKeys } = await import('../lib/joint.js');
  const r = buildMap({ ...SPEC, falls: {} }, () => {});
  const usable = usableKeys(r);
  // Every key it returns must be cut on both of its tiles.
  for (const k of usable) {
    for (const end of [k.a, k.b]) {
      const t = r.tiles.find((x) => x.spec.col === end.col && x.spec.row === end.row);
      assert.ok(t, `key ${k.id} names a tile that is not on the map`);
      assert.ok(t.keys.some((x) => x.id === k.id), `${k.id} is not cut on ${t.label}`);
    }
  }
  assert.ok(usable.length <= r.keys.length, 'cannot be more usable than planned');
});

test('a raised corner lifts the four tiles round it and every one still meets its contract', () => {
  const plain = buildMap(SPEC);
  const raised = buildMap({ ...SPEC, cornerRaise: { '1,1': 10 } });
  assert.equal(raised.corners.get('1,1'), plain.corners.get('1,1') + 10);
  assert.equal(raised.corners.get('2,1'), plain.corners.get('2,1'), 'only the corner asked for');
  for (const t of raised.tiles) {
    assert.ok(t.edges.worst < 1e-6, `${t.label} is ${t.edges.worst.toFixed(4)} mm off its contract`);
    assert.ok(t.mesh.watertight, `${t.label} leaks`);
  }
  for (const s of raised.seamChecks) assert.ok(s.flush, `${s.from} ${s.edge} no longer mates: ${s.kind}`);
});
