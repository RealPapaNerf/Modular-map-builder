import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeContract } from '../lib/contract.js';
import { meshTile, checkWatertight, boundingBox } from '../lib/mesh.js';
import { LOCK_DEFAULTS, lockSettings, boreRadius } from '../lib/joint.js';
import { PLATE_DEFAULTS, PLATE_HEIGHTS, plateSettings, plateFields, plateSolid, describePlate, pinSolid, pinSheet } from '../lib/plate.js';

const c = makeContract();
const T = c.tileMM;
const l = lockSettings();

test('a plate is a closed solid at the bottom and the top of the ladder, standing on z = 0, flat on both faces so it prints upside down with no support', () => {
  for (const heightMM of [PLATE_HEIGHTS[0], PLATE_HEIGHTS[PLATE_HEIGHTS.length - 1]]) {
    const tris = plateSolid(c, {}, { heightMM });
    const w = checkWatertight(tris);
    assert.ok(w.watertight, `${heightMM} mm: ${w.unpaired} unpaired, ${w.overused} overused`);
    const bb = boundingBox(tris);
    const want = [T, T, heightMM];
    for (let a = 0; a < 3; a++) {
      assert.ok(Math.abs(bb.size[a] - want[a]) < 1e-6, `${heightMM} mm: size ${bb.size} wanted ${want}`);
      assert.ok(Math.abs(bb.lo[a]) < 1e-6, `${heightMM} mm: lo ${bb.lo}`);
    }
  }
});

test('it closes on a 1 mm grid too, where the holes beside a cam have to go', () => {
  // The default grid is finer so those holes fit; the coarse grid is the
  // one where a hole's block would overlap the cam's and the skip rule is
  // what keeps the mesh stitched.
  const w = checkWatertight(plateSolid(c, {}, { heightMM: 20, stepMM: 1 }));
  assert.ok(w.watertight, `${w.unpaired} unpaired, ${w.overused} overused`);
});

test('it really is mostly hollow', () => {
  const p = plateFields(c, {}, { heightMM: 20 });
  assert.ok(p.hollowFraction >= 0.6, `hollow fraction ${p.hollowFraction.toFixed(3)}`);
  // And the hollow is the skin's thickness from the top, not something else.
  const hollow = 20 - PLATE_DEFAULTS.skinMM;
  let under = 0;
  for (const v of p.floor) if (v === hollow) under++;
  assert.equal(under / p.floor.length, p.hollowFraction);
});

test('every lock feature and a socket in each face at every corner is there, where a module expects them', () => {
  const p = plateFields(c, {}, { heightMM: 20 });
  assert.equal(p.locks.placed.length, 8, 'two lock features a side');
  assert.deepEqual(p.locks.refused, []);
  assert.equal(p.sockets.placed.length, 4);
  assert.deepEqual(p.sockets.refused, []);
  const s = LOCK_DEFAULTS.socketInsetMM;
  assert.deepEqual(p.pins, [[s, s], [T - s, s], [T - s, T - s], [s, T - s]]);
  // Nothing stands above the top: the sockets in it are sunk.
  const H = 20;
  for (const v of p.top.values) assert.ok(v <= H + 1e-9);
  for (const [sx, sy] of p.pins) {
    const k = Math.round(sy / p.top.step) * p.top.nx + Math.round(sx / p.top.step);
    assert.equal(p.top.values[k], H - LOCK_DEFAULTS.socketDepthMM, `no socket in the top at ${sx},${sy}`);
    assert.equal(p.floor[k], LOCK_DEFAULTS.socketDepthMM, `no socket in the underside at ${sx},${sy}`);
  }
});

test('the tube holes are on the grid and keep clear of the sockets and the cam bores', () => {
  const H = 20;
  const p = plateFields(c, {}, { heightMM: H });
  assert.ok(p.holes.length >= 70, `${p.holes.length} holes`);
  assert.equal(p.holes.length + p.holesSkipped.length, (T / PLATE_DEFAULTS.holePitchMM) ** 2);
  const holeR = PLATE_DEFAULTS.holeMM / 2;
  const socketR = l.socketMM / 2 + l.clearanceMM;
  const cams = p.bores.filter((b) => !b.hole);
  assert.equal(cams.length, 4, 'one cam bore a side');
  for (const cam of cams) assert.ok(Math.abs(cam.rMM - boreRadius(l)) < 1e-9);
  for (const h of p.holes) {
    const odd = (v) => Math.abs(v / 10 - Math.round(v / 10)) < 1e-9 && Math.round(v / 10) % 2 === 1;
    assert.ok(odd(h.x) && odd(h.y), `hole at ${h.x},${h.y} is off the grid`);
    for (const [sx, sy] of p.pins) {
      assert.ok(Math.hypot(h.x - sx, h.y - sy) >= holeR + socketR + 1, `hole at ${h.x},${h.y} runs into the socket at ${sx},${sy}`);
    }
    for (const cam of cams) {
      assert.ok(Math.hypot(h.x - cam.x, h.y - cam.y) >= holeR + cam.rMM + 1, `hole at ${h.x},${h.y} runs into the ${cam.lock} bore`);
    }
    // Under a hole is either the skin or a solid block it bores right
    // through: never a recess or a socket.
    const k = Math.round(h.y / p.top.step) * p.top.nx + Math.round(h.x / p.top.step);
    assert.ok(p.floor[k] === H - PLATE_DEFAULTS.skinMM || p.floor[k] === 0, `hole at ${h.x},${h.y} is over a ${p.floor[k]} mm floor`);
  }
  for (const h of p.holesSkipped) assert.match(h.why, /break into/);
  // And every hole is in the bore list, the size it should be.
  const bored = p.bores.filter((b) => b.hole);
  assert.equal(bored.length, p.holes.length);
  for (const b of bored) assert.equal(b.rMM, holeR);
});

test('the pin is a slip fit in two sockets and shorter than both, so the faces meet first', () => {
  const p = plateFields(c, {}, { heightMM: 20 });
  assert.ok(p.pinMM + 2 * l.clearanceMM <= l.socketMM + 1e-9, `pin ${p.pinMM} mm in a ${l.socketMM} mm socket`);
  const pin = pinSolid();
  assert.ok(checkWatertight(pin).watertight);
  const bb = boundingBox(pin);
  assert.ok(bb.size[2] < 2 * l.socketDepthMM, 'a pin taller than its two sockets holds the plates apart');
  assert.ok(bb.size[2] > l.socketDepthMM + 1, 'and reaches well into both');
  assert.ok(checkWatertight(pinSheet(8)).watertight);
});

test('the top really has holes in it', () => {
  const H = 20;
  const tris = plateSolid(c, {}, { heightMM: H });
  let flat = 0;
  for (let t = 0; t < tris.length; t += 9) {
    if (Math.abs(tris[t + 2] - H) > 1e-9 || Math.abs(tris[t + 5] - H) > 1e-9 || Math.abs(tris[t + 8] - H) > 1e-9) continue;
    const ux = tris[t + 3] - tris[t]; const uy = tris[t + 4] - tris[t + 1];
    const vx = tris[t + 6] - tris[t]; const vy = tris[t + 7] - tris[t + 1];
    flat += Math.abs(ux * vy - uy * vx) / 2;
  }
  const r = PLATE_DEFAULTS.holeMM / 2;
  assert.ok(flat < T * T - 60 * Math.PI * r * r * 0.9, `${flat.toFixed(0)} mm² of top left at ${H} mm`);
  assert.ok(flat > T * T * 0.4, 'but most of the skin between the holes is still there');
});

test('plates of different heights have their holes and sockets in the same places, so a stack lines up', () => {
  const a = plateFields(c, {}, { heightMM: 10 });
  const b = plateFields(c, {}, { heightMM: 50 });
  const pos = (p) => p.bores.map((x) => [x.x, x.y, x.rMM]);
  assert.deepEqual(pos(a), pos(b));
  assert.deepEqual(a.pins, b.pins);
  assert.deepEqual(a.holesSkipped, b.holesSkipped);
  // A hole is a hole through the skin whatever the height.
  const t = meshTile(a.top, { floor: a.floor, bores: a.bores });
  assert.ok(checkWatertight(t).watertight);
});

test('a plate under 10 mm is refused', () => {
  const o = plateSettings({ heightMM: 5 });
  assert.equal(o.heightMM, 5, 'the settings carry what was asked for');
  assert.throws(() => plateFields(c, {}, o), /10 mm/);
});

test('describePlate says what matters in one line', () => {
  const line = describePlate(plateFields(c, {}, { heightMM: 30 }));
  assert.match(line, /30 mm/);
  assert.match(line, /8\/8 lock features/);
  assert.match(line, /8 sockets for 4 pins/);
  assert.match(line, /\d+ tube holes/);
  assert.ok(!line.includes('\n'));
});
