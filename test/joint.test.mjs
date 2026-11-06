import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeField } from '../lib/field.js';
import { makeContract } from '../lib/contract.js';
import { meshTile, checkWatertight, boundingBox } from '../lib/mesh.js';
import {
  edgeLocks, cutLockFeatures, cutSockets, keySolid, keyOutline, keySheet, earClip, usableKeys, camHeights, checkLock,
  edgeFrame, lockSettings, boreRadius, recessDepth, headSeatMM, headEntryMM, keySpanMM, LOCK_DEFAULTS,
} from '../lib/joint.js';
import { camSolid, camSettings, cavityContains, headCentre } from '../lib/cam.js';

const c = makeContract();
const tile = (z = 22, n = 201) => {
  const f = makeField(n, n, c.tileMM / (n - 1));
  f.values.fill(z);
  return f;
};
const L = lockSettings();

test('the key is a closed solid despite its reflex corners', () => {
  const poly = keyOutline();
  assert.equal(earClip(poly).length, poly.length - 2, 'a simple polygon of n vertices gives n-2 triangles');
  const w = checkWatertight(keySolid());
  assert.ok(w.watertight, `${w.unpaired} unpaired edges`);
  assert.ok(checkWatertight(keySheet(9)).watertight, 'and a sheet of them');
  assert.equal(boundingBox(keySolid()).size[2], L.keyThickMM);
});

test('the head is wider than the neck, so the cam has something to hook', () => {
  const l = lockSettings({ headMM: 4, neckMM: 4.5 });
  assert.ok(l.headMM >= l.neckMM + 2, `head ${l.headMM} on a ${l.neckMM} neck`);
});

test('the turn ends TIGHT: seated, the head is further in than touching faces allow, by the preload', () => {
  // With the faces touching and the pad's front on the shoulder of its
  // pocket, the head would be at keySpan - (neckReach - clearance) past the
  // faces. The cam takes it to headSeat. The difference is the preload.
  const touching = keySpanMM(L) - (L.neckReachMM - L.clearanceMM);
  assert.ok(Math.abs(headSeatMM(L) - touching - L.preloadMM) < 1e-9);
  assert.ok(L.preloadMM > 0 && L.preloadMM < L.drawMM, 'some, and less than the cam can draw');
  // Open, the head is a draw further out, and the pad still fits its pocket.
  assert.ok(Math.abs(headSeatMM(L) - headEntryMM(L) - L.drawMM) < 1e-9);
  const pocketBack = L.neckReachMM + L.padReachMM + L.clearanceMM + L.drawMM;
  const padBackOpen = keySpanMM(L) - headEntryMM(L) + (L.padReachMM - L.clearanceMM);
  assert.ok(padBackOpen < pocketBack, `open, the pad's back is ${padBackOpen.toFixed(2)} mm in, the pocket ${pocketBack.toFixed(2)}`);
});

test('the cam and the key agree on where the head is: in the hollow open, and seated after a quarter turn', () => {
  const cam = camSettings(L);
  // The cam's own frame: the key module toward -x. Open, the head is at the
  // cam's inset less the entry distance; the cam's own geometry agrees.
  const open = headCentre(cam, 0);
  assert.ok(Math.abs(open.L - (L.camInsetMM - headEntryMM(L))) < 1e-9);
  const tight = headCentre(cam, L.turnDeg);
  assert.ok(Math.abs(tight.L - (L.camInsetMM - headSeatMM(L))) < 1e-9);
  assert.ok(cavityContains(cam, open.x, open.y) && cavityContains(cam, tight.x, tight.y));
  assert.ok(checkWatertight(camSolid(cam, 22)).watertight);
});

test('every side gets a cam and a key, mirrored about its middle, so any two modules\' halves meet', () => {
  const locks = edgeLocks(c);
  assert.equal(locks.length, 8);
  const T = c.tileMM;
  for (const e of ['N', 'E', 'S', 'W']) {
    const cam = locks.find((k) => k.edge === e && k.kind === 'cam');
    const key = locks.find((k) => k.edge === e && k.kind === 'key');
    assert.ok(Math.abs(cam.uMM + key.uMM - T) < 1e-9, 'the cam at u meets the neighbour\'s key at T - u');
    for (const k of [cam, key]) assert.ok(Math.abs(k.uMM - T / 2) > c.portWidthMM / 2 + 10, 'never under the port');
  }
  // A on the left, B on the right: A's east cam lands on B's west key.
  const fa = edgeFrame(c, 'E');
  const fb = edgeFrame(c, 'W');
  const at = (f, u) => [f.o[0] + f.u[0] * u, f.o[1] + f.u[1] * u];
  const camA = locks.find((k) => k.edge === 'E' && k.kind === 'cam');
  const keyB = locks.find((k) => k.edge === 'W' && k.kind === 'key');
  assert.ok(Math.abs(at(fa, camA.uMM)[1] - at(fb, keyB.uMM)[1]) < 1e-9, 'same place along the seam');
  assert.equal(edgeLocks(c, { enabled: false }).length, 0);
  assert.deepEqual(checkLock(c), []);
});

test('the features are cut into the underside and the cams are bored; the module is still a closed solid', () => {
  const f = tile(22, 161);
  const before = Float64Array.from(f.values);
  const r = cutLockFeatures(f, c, edgeLocks(c), {});
  assert.equal(r.placed.length, 8);
  assert.equal(r.bores.length, 4, 'one cam bore a side');
  for (const b of r.bores) assert.ok(Math.abs(b.rMM - boreRadius(L)) < 1e-9);
  assert.deepEqual(Array.from(f.values), Array.from(before), 'on flat ground at the rim\'s height the terraces change nothing');
  let cut = 0;
  for (const v of r.floor) if (v > 0) { cut++; assert.ok(Math.abs(v - recessDepth(L)) < 1e-9); }
  assert.ok(cut > 0);
  const s = cutSockets(f, c, {}, r.floor, r.bores);
  assert.equal(s.placed.length, 4);
  const w = checkWatertight(meshTile(f, { floor: r.floor, bores: r.bores }));
  assert.ok(w.watertight, `${w.unpaired} unpaired, ${w.overused} overused`);
  assert.deepEqual(camHeights(r.placed), [22]);
});

test('a cam on high ground stands in a terrace at its side\'s rim height', () => {
  const f = tile(40, 201);
  const r = cutLockFeatures(f, c, edgeLocks(c), {}, [], { topAt: () => 22 });
  const [ax, ay] = r.placed.find((p) => p.kind === 'cam').axisMM;
  const k = Math.round(ay / f.step) * f.nx + Math.round(ax / f.step);
  assert.ok(Math.abs(f.values[k] - 22) < 1e-9, `the ground at the cam is ${f.values[k].toFixed(2)}`);
  assert.ok(r.keepClear[k], 'and no tree may stand there');
});

test('a feature where the plate runs thin, or into a bore, is refused WHOLE', () => {
  const f = tile(5);
  const r = cutLockFeatures(f, c, [{ id: 'k', edge: 'E', kind: 'key', uMM: 50 }], {});
  assert.equal(r.placed.length, 0);
  assert.match(r.refused[0].why, /only 5\.0 mm/);
  for (const v of r.floor) assert.equal(v, 0, 'nothing was cut');
  const g = tile(22);
  const bore = { x: c.tileMM - 8, y: 50, rMM: 6.75 };
  const r2 = cutLockFeatures(g, c, [{ id: 'k', edge: 'E', kind: 'key', uMM: 50 }], {}, [bore]);
  assert.match(r2.refused[0].why, /tube bore/);
});

test('the keys to print are the key pockets that were cut', () => {
  assert.equal(usableKeys({ keys: [{ kind: 'key' }, { kind: 'cam' }, { kind: 'key' }] }).length, 2);
  assert.equal(usableKeys({}).length, 0);
  assert.equal(LOCK_DEFAULTS.offsetMM, 50);
});
