import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeField, fill, minMax } from '../lib/field.js';
import { glaciate, valleyForm, GLACIER_DEFAULTS } from '../lib/glacier.js';
import { massWaste } from '../lib/hillslope.js';

function alpineValley(n = 64, dxm = 200) {
  const cx = ((n - 1) * dxm) / 2;
  const f = makeField(n, n, dxm);
  fill(f, (x, y) => 2800 - 0.157 * y + Math.min(0.45 * Math.abs(x - cx), 1000));
  return f;
}

test('no mass balance means no ice', () => {
  const f = alpineValley(48);
  const r = glaciate(f, { cycles: 1, firstRelaxSteps: 60, maxAccumM: 0, accumGradient: 0, ablateGradient: 0, maxAblateM: 0 });
  assert.equal(r.stats.maxIceM, 0);
  assert.equal(r.stats.maxIncisionM, 0);
});

test('an ELA above every summit means no ice either', () => {
  const f = alpineValley(48);
  const r = glaciate(f, { elaM: 99999, cycles: 1, firstRelaxSteps: 60 });
  assert.equal(r.stats.maxIceM, 0);
});

test('ice cannot accumulate faster than it snows', () => {
  // The defect this guards: earlier versions put 169 m of ice down in a
  // 25-year step, and 2500 m in 76 years, on a climate capped at 1.3 m/yr.
  // Convergence into a valley lets a point gain faster than the local
  // snowfall, so the bound is generous -- but not THAT generous.
  const f = alpineValley(64);
  let last = null;
  glaciate(f, { elaM: 2200, cycles: 1, firstRelaxSteps: 300, erosionK: 0, onStep: (d) => { last = d; } });
  const ceiling = GLACIER_DEFAULTS.maxAccumM * last.years * 6 + 50;
  assert.ok(last.maxH < ceiling,
    `ice reached ${last.maxH.toFixed(0)} m in ${last.years.toFixed(0)} yr, over the ${ceiling.toFixed(0)} m bound — the solver has diverged`);
});

test('ice stays off the plateau and in the valley', () => {
  const f = alpineValley(64);
  const r = glaciate(f, { elaM: 2200, cycles: 12 });
  const n = f.nx;
  const j = Math.floor(n / 2);
  const axis = r.ice.values[j * n + Math.floor(n / 2)];
  const flank = r.ice.values[j * n + 2];
  assert.ok(axis > flank * 2, `ice should pool in the trough (axis ${axis.toFixed(0)} m vs flank ${flank.toFixed(0)} m)`);
});

test('basal shear is capped, so nothing surges permanently', () => {
  const f = alpineValley(64);
  const r = glaciate(f, { elaM: 2200, cycles: 10 });
  const cap = GLACIER_DEFAULTS.slideC * GLACIER_DEFAULTS.maxTauPa ** 2;
  assert.ok(r.stats.maxSlideMPerYear <= cap + 1e-6,
    `sliding ${r.stats.maxSlideMPerYear.toFixed(0)} m/yr exceeds the plastic-yield cap ${cap.toFixed(0)}`);
  assert.ok(r.stats.maxSlideMPerYear < 400, 'a valley glacier does not slide at 1000+ m/yr');
});

test('the ice does not run away on a sane climate', () => {
  const f = alpineValley(64);
  const r = glaciate(f, { elaM: 2200, cycles: 12 });
  assert.equal(r.stats.runaway, false);
  assert.ok(r.stats.clampedFraction < 0.02);
});

test('the glacier overdeepens its bed — the signature a river cannot fake', () => {
  // A river bed can never rise downstream. A glacier flows on its SURFACE
  // slope, so it can climb out of a basin it has dug, and the reverse slope
  // it leaves behind is the single clearest proof the mechanics are right.
  const f = alpineValley(64);
  const before = Float64Array.from(f.values);
  const r = glaciate(f, { elaM: 2200, cycles: 30 });
  const n = f.nx;
  const thalweg = (vals) => {
    const out = [];
    for (let j = 0; j < n; j++) {
      let m = Infinity;
      for (let i = 0; i < n; i++) m = Math.min(m, vals[j * n + i]);
      out.push(m);
    }
    return out;
  };
  const rises = (p) => { let c = 0; for (let i = 1; i < p.length; i++) if (p[i] > p[i - 1] + 1) c++; return c; };
  const was = rises(thalweg(before));
  const now = rises(thalweg(r.bed.values));
  assert.equal(was, 0, 'the starting valley falls monotonically');
  assert.ok(now > 0, 'glaciation should leave at least one reverse slope along the floor');
});

test('erosion is bounded by its guard rail', () => {
  const f = alpineValley(64);
  const r = glaciate(f, { elaM: 2200, cycles: 20, maxIncisionM: 120 });
  assert.ok(r.stats.maxIncisionM <= 120 + 1e-6);
});

test('mass wasting removes slopes past the critical angle and conserves rock', () => {
  // The grid has to be wide enough for the debris to go somewhere: 60 m of
  // relief laid back to 35 degrees on a 10 m grid needs about nine cells of
  // run, and the first version of this test gave 200 m only fifteen.
  const f = makeField(64, 64, 10);
  fill(f, (x) => (x < 320 ? 60 : 0));
  const before = f.values.reduce((a, v) => a + v, 0);
  massWaste(f, { critDeg: 35, passes: 60 });
  const after = f.values.reduce((a, v) => a + v, 0);
  assert.ok(Math.abs(after - before) < 1e-6 * Math.abs(before) + 1e-6, 'material is moved, not created');
  // Nothing should still stand at 90 degrees.
  let worst = 0;
  for (let j = 0; j < 64; j++) {
    for (let i = 0; i < 63; i++) {
      worst = Math.max(worst, Math.abs(f.values[j * 64 + i + 1] - f.values[j * 64 + i]));
    }
  }
  const limit = Math.tan((35 * Math.PI) / 180) * 10;
  assert.ok(worst < limit * 1.6, `steepest remaining drop ${worst.toFixed(1)} m against a ${limit.toFixed(1)} m limit`);
});

test('valleyForm separates a U from a V', () => {
  const n = 64;
  const V = makeField(n, n, 10);
  fill(V, (x) => Math.abs(x - 315) * 1.0);
  // A U is FLAT in the middle and steep at the walls, so the exponent is
  // above one. Below one gives a cusp, which is the opposite landform.
  const U = makeField(n, n, 10);
  fill(U, (x) => Math.pow(Math.abs(x - 315) / 315, 2) * 315);
  const v = valleyForm(V, 32).ratio;
  const u = valleyForm(U, 32).ratio;
  assert.ok(u > v, `a U (${u.toFixed(3)}) must score above a V (${v.toFixed(3)})`);
});

// ---------------------------------------------------------------------------
// Cut, retreat, cut again

test('a steady climate neither advances nor retreats', () => {
  const f = alpineValley(48);
  const r = glaciate(f, { elaM: 2200, cycles: 6, elaSwingM: 0 });
  assert.equal(r.stats.elaColdestM, r.stats.elaWarmestM);
  assert.ok(Math.abs(r.stats.maxIcedFraction - r.stats.minIcedFraction) < 0.25,
    'with one climate the ice extent should settle, not swing');
});

test('an oscillating snowline makes the ice advance and retreat', () => {
  const f = alpineValley(48);
  // The snowline has to be high enough relative to the terrain for retreat
  // to be visible at all: with the mean low down, the height/mass-balance
  // feedback keeps 80% of the map under ice through the whole swing.
  const r = glaciate(f, { elaM: 3000, cycles: 24, elaSwingM: 700, glacialCycles: 2 });
  assert.ok(r.stats.elaWarmestM - r.stats.elaColdestM > 900, 'the snowline should actually move');
  assert.ok(r.stats.maxIcedFraction - r.stats.minIcedFraction > 0.3,
    `ice should come and go, got ${(r.stats.minIcedFraction * 100).toFixed(0)}%-${(r.stats.maxIcedFraction * 100).toFixed(0)}%`);
  assert.equal(r.history.length, 24, 'one climate entry per geomorphic cycle');
});

test('a schedule given outright is used as given', () => {
  const f = alpineValley(48);
  const sched = [2600, 2100, 2600, 2100];
  const r = glaciate(f, { cycles: 4, elaSchedule: sched });
  assert.equal(r.stats.elaColdestM, 2100);
  assert.equal(r.stats.elaWarmestM, 2600);
  assert.deepEqual(r.history.map((h) => h.elaM), sched);
});

test('the buzzsaw concentrates cutting near the snowline', () => {
  // On a uniform ramp under ice, erosion with the buzzsaw off should be set
  // by sliding alone; with it on, the band around the ELA takes noticeably
  // more. This is the one part of the erosion law put in by observation
  // rather than derived, so it is worth pinning down that it does what it
  // claims.
  const f = alpineValley(64);
  const ela = 2200;
  const plain = glaciate(f, { elaM: ela, cycles: 10, elaSwingM: 0, buzzsawGain: 0 });
  const sawn = glaciate(f, { elaM: ela, cycles: 10, elaSwingM: 0, buzzsawGain: 3 });
  const n = f.nx;
  // Compare cutting inside the ELA band against cutting well below it.
  let inBand = 0;
  let below = 0;
  for (let k = 0; k < n * n; k++) {
    const z0 = f.values[k];
    const dPlain = z0 - plain.bed.values[k];
    const dSawn = z0 - sawn.bed.values[k];
    if (Math.abs(z0 - ela) < 200) inBand += dSawn - dPlain;
    else if (z0 < ela - 700) below += dSawn - dPlain;
  }
  assert.ok(inBand > 0, 'the band around the snowline should be cut harder');
  assert.ok(inBand > below * 2,
    `cutting should concentrate at the snowline: ${inBand.toFixed(0)} in band against ${below.toFixed(0)} well below`);
});

test('glacial cutting is counted apart from creep', () => {
  // Hillslope creep lowers a ridge whether or not there is ice, so lumping
  // the two together reported incision on a run with no glacier at all.
  const f = alpineValley(48);
  const r = glaciate(f, { cycles: 3, maxAccumM: 0, accumGradient: 0, ablateGradient: 0, maxAblateM: 0, hillslopeD: 0.4 });
  assert.equal(r.stats.maxIceM, 0);
  assert.equal(r.stats.maxIncisionM, 0, 'no ice, no glacial cutting');
  assert.ok(r.stats.maxBedDropM > 0, 'but the ridge still creeps');
});

test('creep is what sorts cirques from grid noise', async () => {
  // Without hillslope diffusion, quarrying leaves the bed covered in
  // single-cell pits, and anything that merely counts closed hollows cannot
  // tell them from cirques. Diffusion damps a feature at a rate going as the
  // square of its wavenumber, so it takes the pits out and leaves the broad
  // basins -- which is the whole reason it is in the loop.
  const { depressionStats } = await import('../lib/basins.js');
  const run = (D) => {
    const r = glaciate(alpineValley(64, 200), { elaM: 2300, cycles: 20, hillslopeD: D });
    const st = depressionStats(r.bed, { minDepthM: 10 });
    return { count: st.count, tiny: st.basins.filter((b) => b.cells <= 2).length };
  };
  const off = run(0);
  const on = run(0.3);
  assert.ok(off.count > 10, `expected pitting with creep off, got ${off.count} hollows`);
  assert.ok(off.tiny / off.count > 0.8, 'and they should almost all be a cell or two');
  assert.ok(on.count < off.count / 3, `creep should clear most of them: ${on.count} against ${off.count}`);
  assert.ok(on.tiny < off.tiny / 3, `and the single-cell pits especially: ${on.tiny} against ${off.tiny}`);
});
