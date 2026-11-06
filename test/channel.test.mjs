import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeField, fill } from '../lib/field.js';
import { makeContract, portFloor, channelShape } from '../lib/contract.js';
import { valleyPath, meanderPath, snapToPorts, planChannels, profileChannels, carveChannels, portPoint, resample, measure, springOnChannel } from '../lib/channel.js';
import { conformToContract, verifyEdges } from '../lib/tile.js';

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
const at = (f, x, y) => f.values[Math.round(y / f.step) * f.nx + Math.round(x / f.step)];
const offAxis = (pts) => pts.reduce((a, [x, y]) => a + Math.abs(x - AXIS(y)), 0) / pts.length;
const line = (pts) => resample(pts, 2);

/* --------------------------------------------------------------- routing */

test('a routed channel follows the valley the glacier left', () => {
  const routed = valleyPath(gorge(), c, 'N', 'S', { seed: 1 });
  assert.ok(offAxis(routed) < 5, `routed channel should sit in the valley, was ${offAxis(routed).toFixed(1)} mm off`);
  assert.ok(offAxis([[100, 200], [100, 100], [100, 0]]) > 15, 'and a straight line would not — if this fails the fixture is wrong');
});

test('a routed path starts and ends exactly on its ends: a port, or a point', () => {
  const f = gorge();
  for (const [a, b] of [['N', 'S'], ['W', 'E'], ['N', 'E'], [[90, 150], 'S']]) {
    const p = valleyPath(f, c, a, b, { seed: 2 });
    const pa = typeof a === 'string' ? portPoint(c, a) : { x: a[0], y: a[1] };
    const pb = portPoint(c, b);
    assert.deepEqual(p[0], [pa.x, pa.y]);
    assert.deepEqual(p[p.length - 1], [pb.x, pb.y]);
  }
  assert.deepEqual(valleyPath(f, c, 'N', 'S', { seed: 3 }), valleyPath(f, c, 'N', 'S', { seed: 3 }), 'the same ground routes the same channel twice');
});

test('a routed channel will not climb a ridge to save distance', () => {
  const f = makeField(N, N, STEP);
  fill(f, (x, y) => (Math.abs(y - 100) < 10 && !(x > 150 && x < 180) ? 90 : 20));
  const p = valleyPath(f, c, 'N', 'S', { seed: 1 });
  let overTheWall = 0;
  for (const [x, y] of p) if ((x < 140 || x > 190) && at(f, x, y) > 60) overTheWall++;
  assert.equal(overTheWall, 0, 'the channel climbed the ridge instead of going round to the gap');
  assert.ok(p.some(([x, y]) => x > 145 && x < 185 && Math.abs(y - 100) < 12), 'and it should have used the gap');
});

test('a routed channel meanders on a floodplain and stays put in a gorge', () => {
  const flat = plain();
  let sinuosity = 0;
  for (const seed of [1, 2, 3, 4]) sinuosity += measure(meanderPath(valleyPath(flat, c, 'N', 'S', { seed }), flat, { seed })).lengthMM / c.tileMM;
  sinuosity /= 4;
  assert.ok(sinuosity > 1.1, `a floodplain channel should wander, sinuosity was ${sinuosity.toFixed(3)}`);
  const g = gorge();
  const straight = valleyPath(g, c, 'N', 'S', { seed: 1 });
  assert.ok(Math.abs(offAxis(meanderPath(straight, g, { seed: 1 })) - offAxis(straight)) < 2, 'a confined channel barely moves');
});

/* --------------------------------------------------------------- the line */

test('an end near a side snaps to that side\'s port and crosses it square; one inside stays inside', () => {
  const s = snapToPorts(c, [[60, 190], [80, 120], [120, 60], [140, 20]], 30);
  assert.equal(s.from, 'N');
  assert.equal(s.to, 'S');
  assert.deepEqual(s.pts[0], [100, 200], 'on the north port');
  assert.deepEqual(s.pts[1], [100, 185], 'then straight in, so the crossing is square');
  assert.deepEqual(s.pts[s.pts.length - 1], [100, 0]);
  const inside = snapToPorts(c, [[60, 150], [120, 60]], 30);
  assert.equal(inside.from, null);
  assert.equal(inside.to, null);
  assert.deepEqual(inside.pts[0], [60, 150]);
  // Points off the module are brought in by half a width, so the banks never reach the rim.
  const wild = snapToPorts(c, [[100, 100], [-40, 100], [100, 60]], 30);
  assert.equal(wild.from, null);
  assert.equal(wild.to, null);
  assert.ok(wild.pts.every(([x, y]) => x >= 15 && y >= 15 && x <= 185 && y <= 185), JSON.stringify(wild.pts));
  // An end within reach of a side goes to its port even if it was not quite there.
  const near = snapToPorts(c, [[100, 100], [120, 20]], 30);
  assert.equal(near.to, 'S');
  assert.deepEqual(near.pts[near.pts.length - 1], [100, 0]);
  assert.equal(snapToPorts(c, [[100, 198], [100, 199]], 30), null, 'in and out of the same side is not a channel');
  assert.equal(snapToPorts(c, [[100, 100]], 30), null, 'one point is not a line');
});

test('a channel is cut the contract\'s depth below the ground along its line, in the parenthesis section', () => {
  const f = plain(40);
  const spec = { channels: [{ name: 'c', widthMM: 30, depthMM: 10, path: [[40, 100], [160, 100]] }] };
  const planned = planChannels(c, spec, f);
  assert.equal(planned.channels.length, 1);
  assert.deepEqual(planned.ports, { N: false, E: false, S: false, W: false }, 'both ends are inside');
  profileChannels(f, c, planned.channels);
  const r = carveChannels(f, c, planned.channels);
  assert.ok(r.cells > 0);
  // Mid-channel, away from the tapered ends: 10 mm deep on the centre line, the arc either side, the bank at the ground.
  const ch = planned.channels[0];
  assert.ok(Math.abs(at(f, 100, 100) - 30) < 0.3, `thalweg at ${at(f, 100, 100).toFixed(2)}`);
  assert.ok(Math.abs(at(f, 100, 115) - 40) < 0.3, 'the bank is the ground');
  assert.ok(Math.abs(at(f, 100, 85) - 40) < 0.3);
  const want = 40 - 10 * channelShape(7.5 / 15, 10 / 15);
  assert.ok(Math.abs(at(f, 100, 107.5) - want) < 0.5, `half way out: ${at(f, 100, 107.5).toFixed(2)} against ${want.toFixed(2)} on the arc`);
  assert.equal(at(f, 100, 140), 40, 'beyond the bank nothing moved');
  // The free ends shallow out, so the channel does not stop at a cliff.
  assert.ok(40 - at(f, 42, 100) < 2, 'nearly nothing cut at the very start');
  assert.ok(ch.depth[0] < 0.5);
  // And water stands in it.
  assert.ok(r.wet.some((w) => w));
  assert.ok(!Number.isNaN(r.water[Math.round(100 / f.step) * f.nx + Math.round(100 / f.step)]));
});

test('a channel only ever cuts: across a hillside the downhill bank is the hill', () => {
  const f = makeField(N, N, STEP);
  fill(f, (x, y) => 20 + 0.4 * y); // rising to the north
  const planned = planChannels(c, { channels: [{ widthMM: 30, depthMM: 10, path: [[40, 100], [160, 100]] }] }, f);
  profileChannels(f, c, planned.channels);
  const before = Float64Array.from(f.values);
  carveChannels(f, c, planned.channels);
  for (let k = 0; k < f.values.length; k++) assert.ok(f.values[k] <= before[k] + 1e-9, 'nothing was raised');
  assert.ok(at(f, 100, 100) < before[Math.round(100 / STEP) * N + Math.round(100 / STEP)] - 8, 'the thalweg is cut');
});

test('where it crosses the rim a channel is the port: the contract\'s floor, width and depth, exactly', () => {
  const f = plain(45);
  const spec = { channels: [{ name: 'c', widthMM: 50, depthMM: 15, path: [[100, 200], [100, 0]] }] };
  const planned = planChannels(c, spec, f);
  assert.deepEqual(planned.ports, { N: true, E: false, S: true, W: false });
  conformToContract(f, c, planned.ports);
  profileChannels(f, c, planned.channels);
  carveChannels(f, c, planned.channels);
  conformToContract(f, c, planned.ports);
  const e = verifyEdges(f, c, planned.ports);
  assert.ok(e.worst < 1e-6, `edge error ${e.worst}`);
  const mid = Math.round(100 / STEP);
  assert.ok(Math.abs(f.values[(N - 1) * N + mid] - portFloor(c)) < 1e-6, 'the north port floor');
  assert.ok(Math.abs(f.values[mid] - portFloor(c)) < 1e-6, 'the south port floor');
  assert.equal(f.values[(N - 1) * N + mid + Math.round(16 / STEP)], c.edgeLandMM, 'and 16 mm along the rim it is land, whatever the channel is inland');
  // Inland the channel is its own width and depth.
  const ch = planned.channels[0];
  const k = Math.floor(ch.pts.length / 2);
  assert.ok(Math.abs(ch.width[k] - 50) < 1e-9);
  assert.ok(Math.abs(ch.depth[k] - 15) < 1e-9);
});

test('the floor follows the ground, smoothed, and a channel drawn over a rise is reported as climbing', () => {
  const f = makeField(N, N, STEP);
  fill(f, (x) => 30 + 10 * Math.exp(-(((x - 100) / 20) ** 2))); // a hump across the middle
  const planned = planChannels(c, { channels: [{ widthMM: 20, depthMM: 6, path: [[40, 100], [160, 100]] }] }, f);
  const [ch] = profileChannels(f, c, planned.channels);
  assert.ok(ch.climbMM > 3, `it climbs the hump: ${ch.climbMM.toFixed(1)} mm`);
  assert.ok(ch.lowestFloorMM < ch.floor[Math.floor(ch.pts.length / 2)], 'and is lowest off the hump');
  const flatOne = profileChannels(plain(40), c, planChannels(c, { channels: [{ widthMM: 20, depthMM: 6, path: [[40, 100], [160, 100]] }] }, plain(40)).channels)[0];
  assert.ok(flatOne.climbMM < 1e-9, 'on the flat it does not climb');
});

test('two channels on one side share the port, and that is said', () => {
  const planned = planChannels(c, { channels: [{ path: [[100, 200], [60, 60]] }, { path: [[100, 199], [140, 60]] }] }, plain());
  assert.equal(planned.channels.length, 2);
  assert.ok(planned.notes.some((n) => /both cross the N side/.test(n.message)));
  const none = planChannels(c, { channels: [{ path: [[100, 100]] }, { name: 'x' }] }, plain());
  assert.equal(none.channels.length, 0);
  assert.equal(none.notes.length, 2);
});

test('a spring on a channel sits at its start, clear of the rim, facing down it', () => {
  const planned = planChannels(c, { channels: [{ path: [[100, 200], [100, 0]] }] }, plain());
  const sp = springOnChannel(c, planned.channels[0], 40);
  assert.ok(Math.abs(sp.atMM[0] - 100) < 1e-6);
  assert.ok(sp.atMM[1] <= 160 && sp.atMM[1] > 140, `at y ${sp.atMM[1].toFixed(1)}: the first point 40 mm in`);
  assert.ok(Math.abs(sp.spillToward + Math.PI / 2) < 0.2, 'spilling south, down the channel');
});

test('resampling keeps the ends and spaces the line evenly', () => {
  const r = resample([[0, 0], [10, 0], [10, 30]], 2);
  assert.deepEqual(r[0], [0, 0]);
  assert.deepEqual(r[r.length - 1], [10, 30]);
  const m = measure(r);
  assert.ok(Math.abs(m.lengthMM - 40) < 1e-9);
  for (let i = 1; i < r.length; i++) assert.ok(Math.abs((m.s[i] - m.s[i - 1]) - 2) < 1e-9);
});
