import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeField, fill } from '../lib/field.js';
import { makeContract } from '../lib/contract.js';
import { valleyPath, meanderPath, riverPath, planChannels, carveChannels, portPoint } from '../lib/river.js';

const c = makeContract();
const N = 201;
const STEP = c.tileMM / (N - 1);
const AXIS = (y) => 100 + 55 * Math.sin((y / 200) * Math.PI * 1.1);

function gorge() {
  const f = makeField(N, N, STEP);
  fill(f, (x, y) => { const d = (x - AXIS(y)) / 26; return 60 - 32 * Math.exp(-(d * d)); });
  return f;
}
function plain(z = 40) {
  const f = makeField(N, N, STEP);
  f.values.fill(z);
  return f;
}
const offAxis = (p) => p.pts.reduce((a, q) => a + Math.abs(q.x - AXIS(q.y)), 0) / p.pts.length;

test('a river follows the valley the glacier left', () => {
  // The defect this guards: the first version drew a Bezier between the two
  // ports and never read the terrain at all, so the ice would carve a trough
  // and the river would wander over its shoulder.
  const f = gorge();
  const routed = valleyPath(f, c, 'N', 'S', { seed: 1 });
  const drawn = riverPath(c, 'N', 'S', { seed: 1 });
  assert.ok(offAxis(routed) < 5, `routed river should sit in the valley, was ${offAxis(routed).toFixed(1)} mm off`);
  assert.ok(offAxis(drawn) > 15, 'and the old curve should not — if this fails the fixture is wrong');
});

test('a routed path still starts and ends exactly on its ports', () => {
  const f = gorge();
  for (const [a, b] of [['N', 'S'], ['W', 'E'], ['N', 'E'], ['W', 'S']]) {
    const p = valleyPath(f, c, a, b, { seed: 2 });
    const pa = portPoint(c, a);
    const pb = portPoint(c, b);
    const first = p.pts[0];
    const last = p.pts[p.pts.length - 1];
    assert.equal(first.x, pa.x); assert.equal(first.y, pa.y);
    assert.equal(last.x, pb.x); assert.equal(last.y, pb.y);
  }
});

test('the same ground routes the same river twice', () => {
  const f = gorge();
  const a = valleyPath(f, c, 'N', 'S', { seed: 3 });
  const b = valleyPath(f, c, 'N', 'S', { seed: 3 });
  assert.deepEqual(a.pts.map((p) => [p.x, p.y]), b.pts.map((p) => [p.x, p.y]));
});

test('a river will not climb a ridge to save distance', () => {
  // A wall across the direct line, with a gap off to one side. The cheap
  // route is round through the gap, and a path that ignores climbing would
  // go straight over.
  const f = makeField(N, N, STEP);
  fill(f, (x, y) => {
    const onWall = Math.abs(y - 100) < 10;
    const inGap = x > 150 && x < 180;
    return onWall && !inGap ? 90 : 20;
  });
  const p = valleyPath(f, c, 'N', 'S', { seed: 1 });
  // "Did not climb the ridge" means it did not cross the wall AWAY from the
  // gap. A smoothed path threading a 30 mm gap clips its corner by a cell,
  // and asserting zero high cells was really asserting that it never
  // rounded a corner.
  let overTheWall = 0;
  for (const q of p.pts) {
    const i = Math.min(N - 1, Math.round(q.x / STEP));
    const j = Math.min(N - 1, Math.round(q.y / STEP));
    const far = q.x < 140 || q.x > 190;
    if (far && f.values[j * N + i] > 60) overTheWall++;
  }
  assert.equal(overTheWall, 0, 'the river climbed the ridge instead of going round to the gap');
  const throughGap = p.pts.some((q) => q.x > 145 && q.x < 185 && Math.abs(q.y - 100) < 12);
  assert.ok(throughGap, 'and it should have used the gap');
});

test('a river meanders on a floodplain and stays put in a gorge', () => {
  // One number does both: the offset is scaled by how far the ground lets
  // the river move. A cost field alone could not do this — raising the noise
  // in the routing saturated at sinuosity 1.07.
  const flat = plain();
  let sinuosity = 0;
  for (const seed of [1, 2, 3, 4]) {
    sinuosity += meanderPath(valleyPath(flat, c, 'N', 'S', { seed }), flat, { seed }).lengthMM / c.tileMM;
  }
  sinuosity /= 4;
  assert.ok(sinuosity > 1.1, `a floodplain river should wander, sinuosity was ${sinuosity.toFixed(3)}`);

  const g = gorge();
  const straight = valleyPath(g, c, 'N', 'S', { seed: 1 });
  const bent = meanderPath(straight, g, { seed: 1 });
  assert.ok(Math.abs(offAxis(bent) - offAxis(straight)) < 2,
    'a confined river should barely move when meandering is applied');
});

test('meandering keeps the channel clear of the rim', () => {
  const flat = plain();
  const p = meanderPath(valleyPath(flat, c, 'W', 'E', { seed: 7 }), flat, { seed: 7, amplitudeMM: 60 });
  for (let i = 1; i < p.pts.length - 1; i++) {
    const q = p.pts[i];
    assert.ok(q.x >= 25 && q.x <= c.tileMM - 25 && q.y >= 25 && q.y <= c.tileMM - 25,
      `a bend reached the rim at ${q.x.toFixed(1)},${q.y.toFixed(1)}`);
  }
});

test('the carved bed hits the declared port heights at both ends', () => {
  const f = plain(45);
  const spec = { col: 0, row: 0, fallMM: 30,
                 edges: { N: { type: 'in', size: 'river' }, S: { type: 'out', size: 'river' } } };
  const chans = planChannels(c, spec, { seed: 1, local: f });
  assert.equal(chans.length, 1);
  carveChannels(f, c, chans);
  const mid = Math.round(c.tileMM / 2 / STEP);
  const inlet = f.values[(N - 1) * N + mid];
  const outlet = f.values[0 * N + mid];
  assert.ok(Math.abs(inlet - (c.outletZMM + 30)) < 0.6, `inlet bed ${inlet.toFixed(2)} should be ${c.outletZMM + 30}`);
  assert.ok(Math.abs(outlet - c.outletZMM) < 0.6, `outlet bed ${outlet.toFixed(2)} should be ${c.outletZMM}`);
});

test('the bed falls all the way down, never back up', () => {
  const f = gorge();
  const spec = { col: 0, row: 0, fallMM: 20,
                 edges: { N: { type: 'in', size: 'river' }, S: { type: 'out', size: 'river' } } };
  const [ch] = planChannels(c, spec, { seed: 1, local: f });
  // The bed is interpolated in arc length, so it must be monotone in t.
  let worst = 0;
  for (let i = 1; i < ch.path.pts.length; i++) {
    const dz = (ch.fromZ + (ch.toZ - ch.fromZ) * ch.path.pts[i].t)
             - (ch.fromZ + (ch.toZ - ch.fromZ) * ch.path.pts[i - 1].t);
    if (dz > worst) worst = dz;
  }
  assert.ok(worst <= 1e-9, 'the channel floor must never rise along its length');
});
