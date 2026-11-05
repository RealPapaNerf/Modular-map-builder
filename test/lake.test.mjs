import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeField, fill } from '../lib/field.js';
import { fillHollows, placeLake, lakeExtent, distanceToShore, carveLake, LAKE_DEFAULTS, PROFILES } from '../lib/lake.js';

/** A tilted tile with a bowl punched into the middle of it. */
function bowl({ n = 161, step = 1, depth = 9, radius = 40 } = {}) {
  const f = makeField(n, n, step);
  const cx = ((n - 1) * step) / 2;
  fill(f, (x, y) => {
    const d = Math.hypot(x - cx, y - cx);
    return 30 + 0.05 * x - (d < radius ? depth * (1 - (d / radius) * (d / radius)) : 0);
  });
  return f;
}
const ring = (f) => {
  const out = [];
  const n = f.nx;
  for (let k = 0; k < n; k++) out.push(f.values[k], f.values[(n - 1) * n + k], f.values[k * n], f.values[k * n + n - 1]);
  return out;
};

test('a closed hollow becomes a tarn', () => {
  const f = bowl();
  const r = fillHollows(f, { depthMM: 5, shoreMM: 10 });
  assert.equal(r.lakes.length, 1);
  const l = r.lakes[0];
  assert.ok(l.areaMM2 > 1000, `a 40 mm bowl should be a real lake, got ${l.areaMM2.toFixed(0)} mm2`);
  assert.ok(l.millilitres > 1, 'and hold something');
  assert.ok(l.deepestMM > 4);
});

test('the water surface is flat — nothing pokes through it', () => {
  const f = bowl();
  const r = fillHollows(f, { depthMM: 5, shoreMM: 10 });
  const l = r.lakes[0];
  for (let k = 0; k < f.values.length; k++) {
    if (!r.wet[k]) continue;
    assert.ok(f.values[k] <= l.surfaceZ + 1e-9,
      `a wet cell sits at ${f.values[k].toFixed(3)}, above the water line ${l.surfaceZ.toFixed(3)}`);
  }
});

test('a lake is a hole — it never raises the ground', () => {
  const f = bowl();
  const before = Float64Array.from(f.values);
  fillHollows(f, { depthMM: 5, shoreMM: 10 });
  for (let k = 0; k < f.values.length; k++) {
    assert.ok(f.values[k] <= before[k] + 1e-9, `cell ${k} was raised`);
  }
});

test('a tarn in a deep cirque is not made shallower than the hollow it sits in', () => {
  // carveLake only ever cuts down. Setting the bed outright would fill a
  // deep hollow back in to a fixed depth.
  const deep = bowl({ depth: 25 });
  const natural = 25;
  const r = fillHollows(deep, { depthMM: 3, shoreMM: 8 });
  assert.ok(r.lakes[0].deepestMM > natural * 0.8,
    `a ${natural} mm hollow should still be about that deep, got ${r.lakes[0].deepestMM.toFixed(1)}`);
});

test('no lake touches the rim; one that would is reported, not clipped', () => {
  // A bowl pushed hard against the west edge.
  const n = 161;
  const f = makeField(n, n, 1);
  fill(f, (x, y) => {
    const d = Math.hypot(x - 10, y - 80);
    return 30 - (d < 45 ? 9 * (1 - (d / 45) * (d / 45)) : 0);
  });
  const before = ring(f);
  const r = fillHollows(f, { depthMM: 5, shoreMM: 10 });
  assert.deepEqual(ring(f), before, 'the boundary ring must be untouched');
  assert.ok(r.skipped.length > 0 || r.lakes.length === 0, 'a hollow on the rim is skipped');
});

test('a placed lake that runs off the tile is refused rather than cut in half', () => {
  const f = makeField(161, 161, 1);
  f.values.fill(20);
  const r = placeLake(f, { atMM: [80, 80], surfaceZMM: 25 }); // the whole tile is below 25
  assert.ok(r.skipped, 'this would flood the entire tile and reach every edge');
  assert.match(r.skipped, /rim/);
});

test('the bed is never cut through the plate', () => {
  const f = bowl({ depth: 2 });
  const r = fillHollows(f, { depthMM: 60, shoreMM: 5, minBedMM: 2.5 });
  for (let k = 0; k < f.values.length; k++) {
    if (r.wet[k]) assert.ok(f.values[k] >= 2.5 - 1e-9, `bed at ${f.values[k].toFixed(2)} is under the floor`);
  }
  assert.ok(r.lakes[0].clamped > 0, 'and it should say it had to stop');
});

test('the three bed profiles hold different amounts, in the expected order', () => {
  // Carved directly onto level ground with a disc mask, because carveLake
  // only ever cuts DOWN: over a natural hollow the existing bed wins in the
  // middle and the profile has nothing left to decide.
  const n = 161;
  const vols = {};
  for (const profile of PROFILES) {
    const f = makeField(n, n, 1);
    f.values.fill(30);
    const mask = new Uint8Array(n * n);
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) if (Math.hypot(i - 80, j - 80) < 40) mask[j * n + i] = 1;
    }
    vols[profile] = carveLake(f, mask, { surfaceZ: 30, depthMM: 6, shoreMM: 14, profile, minBedMM: 1 }).millilitres;
  }
  // A cone is a V and holds far less than either. Between the other two,
  // the ROUNDED shore reaches full depth sooner than the straight one, so a
  // dish holds more than a flat bed -- the opposite of what the names
  // suggest, which is exactly why it is pinned here.
  assert.ok(vols.cone < vols.dish * 0.7, `a cone holds far least: ${JSON.stringify(vols)}`);
  assert.ok(vols.cone < vols.flat * 0.7, JSON.stringify(vols));
  assert.ok(vols.dish > vols.flat, `a rounded shore holds more than a straight one: ${JSON.stringify(vols)}`);
});

test('the fill does not leak diagonally through a one-cell gap', () => {
  // Four-connected on purpose. An eight-connected fill escapes a basin
  // through a corner, and a lake that escapes is invisible until it prints.
  const n = 41;
  const f = makeField(n, n, 1);
  f.values.fill(10); // all below the surface we will ask for
  // A wall with a diagonal-only gap at (20,20)/(21,21).
  for (let j = 0; j < n; j++) f.values[j * n + 20] = 50;
  f.values[20 * n + 20] = 10;
  for (let j = 0; j < n; j++) f.values[j * n + 21] = 50;
  f.values[21 * n + 21] = 10;
  const { mask } = lakeExtent(f, 20 * n + 5, 30, { keepClearMM: 0 });
  let rightSide = 0;
  for (let j = 0; j < n; j++) for (let i = 22; i < n; i++) if (mask[j * n + i]) rightSide++;
  assert.equal(rightSide, 0, 'water escaped through the diagonal');
});

test('distance to shore is zero at the edge and grows inward', () => {
  const n = 41;
  const mask = new Uint8Array(n * n);
  for (let j = 10; j < 31; j++) for (let i = 10; i < 31; i++) mask[j * n + i] = 1;
  const d = distanceToShore(mask, n, n, 1);
  assert.equal(d[5 * n + 5], 0, 'dry ground is zero');
  assert.ok(Math.abs(d[10 * n + 10] - 1) < 0.01, 'the first wet cell is one step in');
  assert.ok(d[20 * n + 20] > 9, `the middle of a 21-cell square should be ~10 in, got ${d[20 * n + 20].toFixed(1)}`);
});

test('volume is reported in millilitres and matches the geometry', () => {
  // A flat-bedded lake over a known area: volume is area times depth, less
  // the shore ramp.
  const n = 201;
  const f = makeField(n, n, 1);
  f.values.fill(40);
  const mask = new Uint8Array(n * n);
  let cells = 0;
  for (let j = 50; j < 151; j++) for (let i = 50; i < 151; i++) { mask[j * n + i] = 1; cells++; }
  const r = carveLake(f, mask, { surfaceZ: 40, depthMM: 5, shoreMM: 0.001, profile: 'flat', minBedMM: 1 });
  const expected = (cells * 1 * 5) / 1000;
  assert.ok(Math.abs(r.millilitres - expected) / expected < 0.02,
    `${r.millilitres.toFixed(2)} ml against ${expected.toFixed(2)} ml`);
});

test('a hollow too small to bother with is left alone', () => {
  const f = bowl({ radius: 3, depth: 2 });
  const before = Float64Array.from(f.values);
  const r = fillHollows(f, { minAreaMM2: 400 });
  assert.equal(r.lakes.length, 0);
  assert.deepEqual(Array.from(f.values), Array.from(before));
});

// ---------------------------------------------------------------------------
// Water painted along a stroke, rather than placed at a point.
// ---------------------------------------------------------------------------

test('a painted lake follows its stroke instead of being a disc', () => {
  // A long thin stroke should give a long thin lake. The test that matters
  // is the shape: wet far along the stroke, dry well off to the side at the
  // same distance from the middle, which a disc could never do.
  const f = makeField(201, 201, 1);
  fill(f, () => 40);
  const r = placeLake(f, {
    ...LAKE_DEFAULTS,
    pathMM: [[40, 100], [160, 100]],
    radiusMM: 14,
    depthMM: 6,
    allowRim: true,
  });
  assert.ok(!r.skipped, `should have carved: ${r.skipped}`);
  const wetAt = (x, y) => !!r.wet[Math.round(y) * 201 + Math.round(x)];
  assert.ok(wetAt(100, 100), 'the middle of the stroke is water');
  assert.ok(wetAt(50, 100) && wetAt(150, 100), 'and so are both ends');
  // 60 mm off the line, but only 40 mm from the stroke's midpoint: a disc
  // big enough to reach the ends would cover this. The stroke must not.
  assert.ok(!wetAt(100, 160), 'well off to the side is dry');
  assert.ok(!wetAt(100, 40), 'on both sides');
});

test('painted water sits at the lowest ground under the stroke', () => {
  // Water finds its level. Painting up a slope must not perch the surface at
  // whatever height the pointer went down at, or the lake hangs on the hill.
  // A FRESH field each time: placeLake carves in place, so reusing one
  // would mean the second call read ground the first had already dug out.
  const slope = () => { const f = makeField(201, 201, 1); fill(f, (x) => 20 + x * 0.1); return f; };
  const up = placeLake(slope(), { ...LAKE_DEFAULTS, pathMM: [[40, 100], [160, 100]], radiusMM: 12, depthMM: 5, allowRim: true });
  const down = placeLake(slope(), { ...LAKE_DEFAULTS, pathMM: [[160, 100], [40, 100]], radiusMM: 12, depthMM: 5, allowRim: true });
  assert.ok(!up.skipped && !down.skipped);
  // Drawn uphill or downhill, the same stroke gives the same surface.
  assert.equal(up.surfaceZ, down.surfaceZ,
    `the direction the stroke was drawn must not change the water level: ${up.surfaceZ} against ${down.surfaceZ}`);
  // And it is the LOW end that sets it: ground there is 24 mm, not the
  // 36 mm at the top of the stroke.
  assert.ok(up.surfaceZ < 30, `surface should sit near the low end, got ${up.surfaceZ}`);
});

test('a one-point stroke is still a plain round lake', () => {
  const f = makeField(201, 201, 1);
  fill(f, () => 40);
  const r = placeLake(f, { ...LAKE_DEFAULTS, pathMM: [[100, 100]], radiusMM: 20, depthMM: 6, allowRim: true });
  assert.ok(!r.skipped, `should have carved: ${r.skipped}`);
  const wetAt = (x, y) => !!r.wet[Math.round(y) * 201 + Math.round(x)];
  assert.ok(wetAt(100, 100));
  assert.ok(wetAt(100, 112) && wetAt(112, 100), 'round, so wet in every direction');
});
