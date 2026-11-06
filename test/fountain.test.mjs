import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeField, fill } from '../lib/field.js';
import { meshTile, checkWatertight } from '../lib/mesh.js';
import { carveSpring, boreRadiusMM, plateBores, trayField, FOUNTAIN_DEFAULTS } from '../lib/fountain.js';

const slope = (n = 201, step = 1) => {
  const f = makeField(n, n, step);
  fill(f, (x) => 40 + 0.05 * x);
  return f;
};

test('a bore leaves the mesh closed', () => {
  // The one piece of geometry here that cannot be done by moving vertices
  // up and down. A block of cells is removed and the gap between that
  // rectangle and the circle is stitched as an annulus.
  const f = makeField(81, 81, 1);
  fill(f, (x, y) => 20 + 3 * Math.sin(x / 9) * Math.cos(y / 9));
  for (const rMM of [2, 4, 7, 11]) {
    const w = checkWatertight(meshTile(f, { bores: [{ x: 40, y: 40, rMM }] }));
    assert.ok(w.watertight, `r=${rMM}: ${w.unpaired} unpaired, ${w.overused} overused`);
  }
});

test('two bores in one tile are both closed', () => {
  const f = makeField(81, 81, 1);
  fill(f, (x, y) => 20 + 2 * Math.sin(x / 7));
  const w = checkWatertight(meshTile(f, { bores: [{ x: 22, y: 22, rMM: 4 }, { x: 58, y: 58, rMM: 5 }] }));
  assert.ok(w.watertight, `${w.unpaired} unpaired, ${w.overused} overused`);
});

test('a bore actually removes material', () => {
  const f = makeField(81, 81, 1);
  f.values.fill(20);
  const solid = meshTile(f).length / 9;
  const holed = meshTile(f, { bores: [{ x: 40, y: 40, rMM: 8 }] }).length / 9;
  // Not a triangle count comparison -- the underside changes from a fan to
  // a grid -- so check the hole is empty of surface instead.
  const tris = meshTile(f, { bores: [{ x: 40, y: 40, rMM: 8 }] });
  let inside = 0;
  for (let t = 0; t < tris.length; t += 9) {
    const cx = (tris[t] + tris[t + 3] + tris[t + 6]) / 3;
    const cy = (tris[t + 1] + tris[t + 4] + tris[t + 7]) / 3;
    const cz = (tris[t + 2] + tris[t + 5] + tris[t + 8]) / 3;
    // A triangle whose centre is well inside the bore and not on its wall.
    if (Math.hypot(cx - 40, cy - 40) < 6 && (cz > 19.9 || cz < 0.1)) inside++;
  }
  assert.equal(inside, 0, 'there is still a lid or a floor across the bore');
  assert.ok(solid > 0 && holed > 0);
});

test('the bore is round, not a staircase', () => {
  const f = makeField(81, 81, 1);
  f.values.fill(20);
  const tris = meshTile(f, { bores: [{ x: 40, y: 40, rMM: 7 }] });
  // Every vertex on the shaft sits on the circle.
  let onWall = 0;
  for (let v = 0; v < tris.length; v += 3) {
    const d = Math.hypot(tris[v] - 40, tris[v + 1] - 40);
    if (Math.abs(d - 7) < 1e-6) onWall++;
  }
  assert.ok(onWall > 100, `expected a ring of vertices exactly on the circle, found ${onWall}`);
});

/** Signed volume of a closed mesh: positive when its normals point out. */
const volume = (tris) => {
  let v = 0;
  for (let o = 0; o < tris.length; o += 9) {
    const [ax, ay, az, bx, by, bz, cx, cy, cz] = tris.subarray(o, o + 9);
    v += ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx);
  }
  return v / 6;
};

/** The heights at which a vertical line through (x, y) crosses the surface. */
const crossings = (tris, x, y) => {
  const out = [];
  for (let o = 0; o < tris.length; o += 9) {
    const [ax, ay, az, bx, by, bz, cx, cy, cz] = tris.subarray(o, o + 9);
    const d = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy);
    if (Math.abs(d) < 1e-12) continue; // a wall, edge on
    const l1 = ((by - cy) * (x - cx) + (cx - bx) * (y - cy)) / d;
    const l2 = ((cy - ay) * (x - cx) + (ax - cx) * (y - cy)) / d;
    const l3 = 1 - l1 - l2;
    if (l1 < 0 || l2 < 0 || l3 < 0) continue;
    out.push(l1 * az + l2 * bz + l3 * cz);
  }
  return out.sort((p, q) => p - q);
};

test('a blind bore is a closed hole up from the underside to its depth, and leaves the top whole', () => {
  const f = makeField(81, 81, 1);
  f.values.fill(20);
  const bore = { x: 40.3, y: 39.6, rMM: 8, blindMM: 6 };
  const tris = meshTile(f, { bores: [bore] });
  const w = checkWatertight(tris);
  assert.ok(w.watertight, `${w.unpaired} unpaired, ${w.overused} overused`);
  // The top is all there: its triangles cover the whole module.
  let top = 0;
  for (let o = 0; o < tris.length; o += 9) {
    if (tris[o + 2] !== 20 || tris[o + 5] !== 20 || tris[o + 8] !== 20) continue;
    top += Math.abs((tris[o + 3] - tris[o]) * (tris[o + 7] - tris[o + 1]) - (tris[o + 4] - tris[o + 1]) * (tris[o + 6] - tris[o])) / 2;
  }
  assert.ok(Math.abs(top - 80 * 80) < 1e-6, `top covers ${top} mm²`);
  // Inside the circle, a line up through the module meets the roof of the
  // hole and then the top: empty from 0 to 6, solid from 6 to 20.
  for (const [x, y] of [[40.31, 39.62], [45.1, 41.3], [36.27, 35.41]]) assert.deepEqual(crossings(tris, x, y).map((v) => +v.toFixed(6)), [6, 20], `at ${x},${y}`);
  // Outside it, solid all the way.
  for (const [x, y] of [[10.2, 10.3], [40.3, 49.2], [52.33, 40.71]]) assert.deepEqual(crossings(tris, x, y).map((v) => +v.toFixed(6)), [0, 20], `at ${x},${y}`);
  // And the volume taken out is the polygon of the circle, 6 mm tall.
  const n = 48;
  const disc = (n / 2) * bore.rMM * bore.rMM * Math.sin((2 * Math.PI) / n);
  const want = 80 * 80 * 20 - disc * bore.blindMM;
  assert.ok(Math.abs(volume(tris) - want) < 0.05, `volume ${volume(tris).toFixed(3)}, wanted ${want.toFixed(3)}`);
});

test('a blind bore stays closed where a channel cut into the underside runs into it', () => {
  // The cam's entry channel: cut up into the floor field to the bore's own
  // depth, from the side of the module to the bore's axis. Where it meets
  // the circle the shaft has no height at all.
  for (const step of [1, 0.9, 2.5]) {
    const n = Math.round(80 / step) + 1;
    const f = makeField(n, n, 80 / (n - 1));
    f.values.fill(20);
    const floor = new Float64Array(n * n);
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
      if (Math.abs(j * f.step - 40) <= 4.5 && i * f.step >= 40) floor[j * n + i] = 6;
    }
    const tris = meshTile(f, { floor, bores: [{ x: 40, y: 40, rMM: 9.3, blindMM: 6 }, { x: 15, y: 68, rMM: 6.75 }] }); // their blocks clear at every step
    const w = checkWatertight(tris);
    assert.ok(w.watertight, `step ${step}: ${w.unpaired} unpaired, ${w.overused} overused`);
    assert.ok(volume(tris) > 0, 'facing out');
    // No triangle is folded over: on the shaft, nothing goes below its floor.
    for (let o = 0; o < tris.length; o += 9) {
      for (let a = 2; a < 9; a += 3) assert.ok(tris[o + a] >= 0 && tris[o + a] <= 20);
    }
    // Under the channel, beside the bore, a line up meets the channel's roof.
    assert.deepEqual(crossings(tris, 70.13, 40.2).map((v) => +v.toFixed(6)), [6, 20]);
  }
});

test('a spring is a pool with a lip and one notch in it', () => {
  const f = slope();
  const s = carveSpring(f, { atMM: [100, 100], spillToward: 0 });
  assert.ok(!s.skipped, s.skipped);
  assert.ok(s.rimMM > s.bedMM, 'the rim stands above the water');
  assert.ok(s.spillMM < s.rimMM, 'and the notch is below the rest of the rim');
  const at = (x, y) => f.values[Math.round(y) * f.nx + Math.round(x)];
  assert.ok(Math.abs(at(100, 100) - s.bedMM) < 1e-6, 'the bed is flat at the middle');
  // Round the rim: high everywhere except toward the spill bearing.
  const rimAt = (deg) => {
    const a = (deg * Math.PI) / 180;
    const r = s.poolRadiusMM + FOUNTAIN_DEFAULTS.lipWidthMM / 2;
    return at(100 + r * Math.cos(a), 100 + r * Math.sin(a));
  };
  assert.ok(rimAt(0) < rimAt(180), 'the notch faces the spill bearing');
  assert.ok(rimAt(90) > s.bedMM + 1, 'and the sides are a real lip');
});

test('the tube comes out under water, in the middle of the pool', () => {
  const f = slope();
  const s = carveSpring(f, { atMM: [100, 100], spillToward: 0 });
  assert.equal(s.bore.x, 100);
  assert.equal(s.bore.y, 100);
  assert.ok(s.bore.rMM * 2 < s.poolRadiusMM * 2, 'the bore fits inside the pool');
  // And the mesh survives it.
  assert.ok(checkWatertight(meshTile(f, { bores: [s.bore] })).watertight);
});

test('the bore is sized for the tube plus a slip fit', () => {
  const r = boreRadiusMM({ tubeOdMM: 12.7, clearanceMM: 0.4 });
  assert.ok(Math.abs(r * 2 - 13.5) < 1e-9, `${(r * 2).toFixed(2)} mm for a 12.7 mm tube`);
  assert.ok(boreRadiusMM({ tubeOdMM: 6 }) < r, 'a thinner tube needs a smaller hole');
});

test('a pool too small for its own tube is refused, not fudged', () => {
  const f = slope();
  const s = carveSpring(f, { atMM: [100, 100], spillToward: 0, poolRadiusMM: 5, tubeOdMM: 12.7 });
  assert.ok(s.skipped);
  assert.match(s.skipped, /too small/);
});

test('every plate under a spring needs the same hole', () => {
  // Two plates of the same size only swap if they are drilled the same, so
  // the plan has to say which are which.
  const springs = [{ bore: { x: 115, y: 161, rMM: 6.75 } }];
  assert.equal(plateBores(springs, 0).length, 0, 'a tile on the ground needs none');
  const three = plateBores(springs, 3);
  assert.equal(three.length, 3);
  for (const p of three) {
    assert.equal(p.bores.length, 1);
    assert.equal(p.bores[0].x, 115);
    assert.equal(p.bores[0].rMM, 6.75);
  }
});

test('a drilled plate is a closed solid', () => {
  const n = 134;
  const f = makeField(n, n, 200 / (n - 1));
  f.values.fill(10);
  const w = checkWatertight(meshTile(f, { bores: [{ x: 115, y: 161, rMM: 6.75 }] }));
  assert.ok(w.watertight, `${w.unpaired} unpaired`);
});

test('the tray is a closed tub the map can sit down into', () => {
  const t = trayField(makeField, { widthMM: 400, depthMM: 400 });
  assert.ok(t.outerMM[0] > 400, 'it is bigger than the map it holds');
  assert.ok(t.sitsAtMM < t.heightMM, 'the map rests below the rim');
  assert.ok(checkWatertight(meshTile(t.field)).watertight);
  // There is a floor, a ledge and a wall: three distinct heights.
  const heights = new Set(Array.from(t.field.values).map((v) => v.toFixed(3)));
  assert.ok(heights.size >= 3, `expected floor, ledge and wall, got ${heights.size} levels`);
});
