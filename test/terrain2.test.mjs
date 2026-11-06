// Rivers before the ice, jointed rock, the fine pass, cirques, the shaded
// side, vertical exaggeration, and the cliff where a ridge meets a side.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeField, fill } from '../lib/field.js';
import { fluvialErode, routeFlow, drainageArea } from '../lib/fluvial.js';
import { weaknessField, critTanField, ROCK_DEFAULTS } from '../lib/rock.js';
import { detailPass, sampleCubic } from '../lib/detail.js';
import { massWaste } from '../lib/hillslope.js';
import { addCirqueSeed } from '../lib/terrain.js';
import { buildWorld, buildTile } from '../lib/build.js';
import { cutTile, conformToContract, verifyEdges } from '../lib/tile.js';
import { makeContract } from '../lib/contract.js';
import { verticalOf } from '../lib/scale.js';

/** A ridge along x, 1500 m high, on a 150 m plain, 10 km square. */
function ridge(n = 81) {
  const f = makeField(n, n, 10000 / (n - 1));
  fill(f, (x, y) => 150 + 1500 * Math.exp(-(((y - 5000) / 1800) ** 2)));
  return f;
}
const slopeDeg = (f) => {
  const { nx, step, values: z } = f;
  const out = [];
  for (let j = 1; j < nx - 1; j++) for (let i = 1; i < nx - 1; i++) {
    const k = j * nx + i;
    out.push(Math.atan(Math.hypot(z[k + 1] - z[k - 1], z[k + nx] - z[k - nx]) / (2 * step)) * 180 / Math.PI);
  }
  return out;
};

test('rivers cut valleys into a smooth ridge, branching rather than ruled, and keep the summit where it was', () => {
  const f = ridge();
  const before = Math.max(...f.values);
  const r = fluvialErode(f, { steps: 60, critDeg: 40, keepRelief: true });
  assert.ok(r.maxCutM > 100, `cut ${r.maxCutM.toFixed(0)} m`);
  assert.ok(Math.abs(Math.max(...f.values) - before) < 1e-6, 'the highest point stands where it stood');
  // A smooth ridge has every cross-section the same; a dissected one does not.
  const { nx, values: z } = f;
  const row = (j) => Array.from({ length: nx }, (_, i) => z[j * nx + i]);
  const mid = Math.round(nx * 0.35);
  const a = row(mid);
  const spread = Math.max(...a) - Math.min(...a);
  assert.ok(spread > 80, `the flank along a contour now has valleys and spurs: ${spread.toFixed(0)} m of difference`);
});

test('every cell drains to the edge, and drainage area adds up', () => {
  const f = ridge(41);
  const { rec, stack, n } = routeFlow(f);
  assert.equal(n, f.nx * f.ny);
  const area = drainageArea(f, rec, stack, n);
  let outlets = 0;
  for (let k = 0; k < n; k++) if (rec[k] === k) outlets += area[k];
  assert.ok(Math.abs(outlets - f.nx * f.ny * f.step * f.step) < 1e-3, 'all the area reaches an outlet');
  // Receivers are lower on the filled surface, so the stack is outlets first.
  const pos = new Int32Array(n);
  for (let s = 0; s < n; s++) pos[stack[s]] = s;
  for (let k = 0; k < n; k++) if (rec[k] !== k) assert.ok(pos[rec[k]] < pos[k]);
});

test('jointed rock: about a fifth of it is a joint, and strong rock may stand far steeper than weak or mantled ground', () => {
  const f = makeField(121, 121, 25, 1000, 1000);
  const w = weaknessField(f, { ...ROCK_DEFAULTS, seed: 4 });
  const joint = w.filter((v) => v > 0.5).length / w.length;
  assert.ok(joint > 0.08 && joint < 0.4, `${(joint * 100).toFixed(0)}% jointed`);
  const t = critTanField(w, ROCK_DEFAULTS);
  const deg = (v) => Math.atan(v) * 180 / Math.PI;
  assert.ok(deg(Math.max(...t)) > 75 && deg(Math.min(...t)) < 56);
  // Low ground is mantled whatever the rock is.
  const heights = Float64Array.from(w, (_, k) => k);
  const m = critTanField(w, ROCK_DEFAULTS, heights);
  assert.ok(Math.abs(deg(m[0]) - ROCK_DEFAULTS.mantleDeg) < 1e-6);
});

test('the slope limit is per cell when asked, and a mask keeps the rest of the ground where it is', () => {
  const f = makeField(21, 21, 10);
  fill(f, (x) => (x > 100 ? 200 : 0)); // a 200 m wall
  const strong = Float64Array.from(f.values, () => Math.tan((89.5 * Math.PI) / 180)); // the wall is 87 degrees on this grid
  const g = makeField(21, 21, 10, 0, 0, Float64Array.from(f.values));
  massWaste(g, { critTan: strong, passes: 20 });
  assert.deepEqual(Array.from(g.values), Array.from(f.values), 'sound rock holds a wall');
  const h = makeField(21, 21, 10, 0, 0, Float64Array.from(f.values));
  const only = new Uint8Array(21 * 21);
  massWaste(h, { critDeg: 33, passes: 20, only });
  assert.deepEqual(Array.from(h.values), Array.from(f.values), 'nothing outside the mask slumps');
  massWaste(f, { critDeg: 33, passes: 20 });
  assert.notDeepEqual(Array.from(f.values), Array.from(h.values), 'without the mask it would have');
});

test('the fine pass keeps the coarse shapes and makes the high ground steeper and rougher', () => {
  const bed = ridge(81);
  fluvialErode(bed, { steps: 40, critDeg: 40 });
  // A 200 mm module at 25 m/mm in the middle of the 10 km world: margin 100 mm.
  const d = detailPass(bed, { tileMM: 200, marginMM: 100, metresPerMM: 25, steps: 30 });
  assert.equal(d.nx, Math.round((200 + 24) / 1) + 1);
  // Away from the crest the resampled ground matches the bed.
  const x = d.originX + 20 * d.step;
  const y = d.originY + 20 * d.step;
  assert.ok(Math.abs(sampleCubic(d, x, y) - sampleCubic(bed, x, y)) < 30);
  const s = slopeDeg(d);
  assert.ok(s.filter((v) => v > 45).length / s.length > 0.05, 'steep ground on the range');
  assert.ok(d.detail.maxCutM > 20);
});

/** A plain at 150 m, 10 km square. */
function plain(n = 81) {
  const f = makeField(n, n, 10000 / (n - 1));
  fill(f, () => 150);
  return f;
}
/**
 * Pile a hill of `hM` metres on a field, centred at (cx, cy) with radius rM.
 * Smoothstep, not a straight cone: a cone has a kink where it meets the
 * plain, and the fine grid's Catmull-Rom resample undershoots there, which
 * drops the module's lowest ground a few metres and takes the snowline's
 * datum with it. Real ground that has been through the ice has no such kink.
 */
function cone(f, cx, cy, rM, hM) {
  const { nx, ny, step, values: z } = f;
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const d = Math.hypot(i * step - cx, j * step - cy);
      if (d >= rM) continue;
      const t = 1 - d / rM;
      z[j * nx + i] += hM * t * t * (3 - 2 * t);
    }
  }
  return f;
}
/** Mean |laplacian| of a field inside a window in world metres: how worked the ground is. */
function worked(f, cx, cy, rM) {
  const { nx, ny, step, values: z, originX: ox, originY: oy } = f;
  let sum = 0;
  let n = 0;
  for (let j = 1; j < ny - 1; j++) {
    for (let i = 1; i < nx - 1; i++) {
      if (Math.hypot(ox + i * step - cx, oy + j * step - cy) > rM) continue;
      const k = j * nx + i;
      sum += Math.abs(z[k] - 0.25 * (z[k + 1] + z[k - 1] + z[k + nx] + z[k - nx]));
      n++;
    }
  }
  return sum / Math.max(1, n);
}

// THE BUG THIS IS HERE FOR. The snowline used to be 0.6 of the module's
// relief, which pins it to the highest thing on the map: put a big peak in
// one corner and every shorter summit drops under the line and comes out of
// the fine pass untouched -- smooth as the ice left it, beside a ridge
// carved into towers. An absolute line cannot do that.
test('the frost line is an absolute height: a taller peak elsewhere does not starve a shorter one', () => {
  const opts = { tileMM: 200, marginMM: 100, metresPerMM: 25, steps: 30 };
  const alone = detailPass(cone(plain(), 3200, 3200, 1200, 800), opts);
  const beside = detailPass(cone(cone(plain(), 3200, 3200, 1200, 800), 7000, 7000, 1500, 3000), opts);

  const extraM = beside.detail.reliefM - alone.detail.reliefM;
  assert.ok(beside.detail.reliefM > 2.5 * alone.detail.reliefM,
    `the second module has far more relief (${alone.detail.reliefM.toFixed(0)} m vs ${beside.detail.reliefM.toFixed(0)} m)`);
  // The old rule would have carried the line up by 0.6 of that extra relief,
  // which is most of a kilometre, and put the short cone under it entirely.
  assert.ok(0.6 * extraM > 1000, `${(0.6 * extraM).toFixed(0)} m is what a relative line would have moved`);
  const movedM = Math.abs(alone.detail.frostFromM - beside.detail.frostFromM);
  assert.ok(movedM < 5, `the snowline did not move with it (${movedM.toFixed(1)} m)`);
  // 10 mm of print at 25 m/mm, above the 150 m plain. Not to the metre: the
  // fine grid's resample ripples a little where the hill meets the plain,
  // and the lowest cell of that ripple is the datum.
  assert.ok(Math.abs(alone.detail.frostFromM - 400) < 10, `snowline at ${alone.detail.frostFromM.toFixed(1)} m`);

  const a = worked(alone, 3200, 3200, 900);
  const b = worked(beside, 3200, 3200, 900);
  assert.ok(a > 0.5, `the short cone is worked on its own (${a.toFixed(2)})`);
  assert.ok(Math.abs(a - b) / a < 0.25, `and just as much with the big peak beside it (${a.toFixed(2)} vs ${b.toFixed(2)})`);
});

test('the frost line is read as print millimetres, so exaggeration moves it like every other height', () => {
  const opts = { tileMM: 200, marginMM: 100, metresPerMM: 25, steps: 1 };
  const one = detailPass(cone(plain(), 5000, 5000, 2000, 1500), { ...opts, exaggeration: 1 });
  const two = detailPass(cone(plain(), 5000, 5000, 2000, 1500), { ...opts, exaggeration: 2 });
  // Same ground, so the same lowest point: the line sits 10 mm up on both,
  // which is 250 m of bed at 1x and 125 m at 2x. See scale.js.
  assert.ok(Math.abs((one.detail.frostFromM - two.detail.frostFromM) - 125) < 1e-6,
    `${one.detail.frostFromM} m at 1x, ${two.detail.frostFromM} m at 2x`);
  assert.ok(Math.abs((one.detail.frostFullM - one.detail.frostFromM) - 350) < 1e-6, 'and the band is 14 mm wide at 1x');
});

test('a cirque seed is a hollow open toward its facing, and says where it is', () => {
  const f = makeField(101, 101, 50);
  fill(f, () => 1000);
  const w = addCirqueSeed(f, { x: 2500, y: 2500, radiusM: 600, facingRad: Math.PI / 2, depthM: 200 });
  const at = (x, y) => f.values[Math.round(y / 50) * 101 + Math.round(x / 50)];
  assert.ok(at(2500, 2600) < 900, 'deep in the bowl');
  assert.ok(at(2500, 3500) < at(2500, 1700), 'open downhill (north), closed behind (south)');
  assert.ok(w[Math.round(2500 / 50) * 101 + 50] > 0.5);
  assert.equal(w[0], 0);
});

test('vertical exaggeration: the print stands taller than the ground, and what is typed is still what is printed', () => {
  const base = { seed: 2, worldGrid: 48, marginMM: 40, glacier: false, rivers: false, detail: false, spineHeightMM: 40, roughness: 0, spine: [[-40, 100], [240, 100]], lakes: { fillHollows: false } };
  assert.equal(verticalOf({}), 1);
  const one = buildWorld(base);
  const two = buildWorld({ ...base, verticalExaggeration: 2 });
  const hi = (w) => Math.max(...w.bed.values) - Math.min(...w.bed.values);
  assert.ok(Math.abs(hi(two) / hi(one) - 0.5) < 0.02, 'the ground the ice sees is half as tall');
  const c = makeContract();
  const cut = (w) => cutTile(w.bed, c, { marginMM: 40, metresPerMM: 25, meshMM: 4, exaggeration: w.exaggeration });
  const r1 = (l) => Math.max(...l.values) - Math.min(...l.values);
  assert.ok(Math.abs(r1(cut(two)) - r1(cut(one))) < 1, 'and the printed mountain is the same height');
});

test('a ridge that runs out to a side meets it as a cliff; low ground slopes up to it', () => {
  const c = makeContract({ cliffMM: 6 });
  const f = makeField(201, 201, 1);
  // A 40 mm ridge running north-south out through the north and south
  // sides, on ground a little below the rim.
  fill(f, (x) => 18 + 40 * Math.exp(-(((x - 100) / 25) ** 2)));
  conformToContract(f, c, {});
  assert.ok(verifyEdges(f, c, {}, { grooves: false }).worst < 1e-6);
  const at = (x, y) => f.values[y * 201 + x];
  // On the ridge, 15 mm in from the north rim: still nearly full height.
  assert.ok(at(100, 185) > 45, `the ridge stands up to the edge: ${at(100, 185).toFixed(1)} mm 15 mm in`);
  // Off the ridge, low ground is brought up to the rim over the long blend.
  assert.ok(at(10, 185) > 18.5 && at(10, 185) < 22, `the low ground slopes: ${at(10, 185).toFixed(1)} mm`);
  // Turned off, the ridge is bent down over the long blend instead.
  const g = makeField(201, 201, 1);
  fill(g, (x) => 18 + 40 * Math.exp(-(((x - 100) / 25) ** 2)));
  conformToContract(g, makeContract({ autoCliff: false }), {});
  assert.ok(g.values[185 * 201 + 100] < at(100, 185) - 10);
});

test('cirques asked for lower the snowline where they are and grow a hollow there', { timeout: 300000 }, () => {
  const spec = { seed: 3, worldGrid: 48, marginMM: 40, detail: false, rivers: false, spine: [[-40, 100], [240, 100]], spineHeightMM: 50,
    glacier: { cycles: 4 }, lakes: { fillHollows: false } };
  const plain = buildWorld(spec);
  const withCirque = buildWorld({ ...spec, cirques: [{ at: [100, 112], facingDeg: 90 }] });
  const at = (w, x, y) => w.bed.values[Math.round((y + 40) * 25 / w.bed.step) * w.bed.nx + Math.round((x + 40) * 25 / w.bed.step)];
  assert.ok(at(withCirque, 100, 114) < at(plain, 100, 114) - 50, 'there is a hollow where the cirque was asked for');
});

test('the moraine slump only moves till: a rock wall the ice never built stays steeper than till can stand', { timeout: 300000 }, async () => {
  const { glaciate } = await import('../lib/glacier.js');
  // A 50-degree rock step in a valley floor, well below the snowline so no
  // ice comes near it. The first till slump ran over the whole bed and took
  // every slope like this down to 33 degrees.
  const f = makeField(41, 41, 100);
  fill(f, (x, y) => 400 + (x > 2000 ? 600 : 0) + (x > 2000 ? 0 : Math.min(600, Math.max(0, (x - 1700) * Math.tan((50 * Math.PI) / 180)))));
  const g = glaciate(f, { cycles: 2, elaM: 5000, elaSwingM: 0, tillPasses: 4, wallPasses: 0, hillslopeD: 0, floorCreepD: 0 });
  const s = slopeDeg(g.bed);
  assert.ok(Math.max(...s) > 45, `the rock step is still ${Math.max(...s).toFixed(0)} degrees`);
});
