import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeField } from '../lib/field.js';
import { makeContract } from '../lib/contract.js';
import { meshTile, checkWatertight, boundingBox } from '../lib/mesh.js';
import {
  padThickMM, edgeLocks, cutLockFeatures, cutSockets, keySolid, keyOutline, keySheet, earClip, usableKeys, camHeights, checkLock,
  edgeFrame, lockSettings, boreRadius, recessDepth, headSeatMM, headEntryMM, keySpanMM, lockDepths, shortestCamMM, LOCK_DEFAULTS,
} from '../lib/joint.js';
import { camSolid, camSettings, cavityContains, headCentre, camProfile } from '../lib/cam.js';

const c = makeContract();
const tile = (z = 22, n = 201) => {
  const f = makeField(n, n, c.tileMM / (n - 1));
  f.values.fill(z);
  return f;
};
const L = lockSettings();

test('the key\'s pad fills its pocket and its neck and head fit the hook, as a closed solid facing outward', () => {
  const l = lockSettings();
  const k = keySolid(l);
  assert.ok(checkWatertight(k).watertight);
  // Every directed edge once, the reverse once: the faces all point out.
  const dir = new Map();
  const key = (i) => `${Math.round(k[i] * 1000)},${Math.round(k[i + 1] * 1000)},${Math.round(k[i + 2] * 1000)}`;
  let vol = 0;
  for (let o = 0; o < k.length; o += 9) {
    const v = [key(o), key(o + 3), key(o + 6)];
    for (let e = 0; e < 3; e++) { const d = `${v[e]}>${v[(e + 1) % 3]}`; dir.set(d, (dir.get(d) || 0) + 1); }
    const [ax, ay, az, bx, by, bz, cx, cy, cz] = k.slice(o, o + 9);
    vol += (ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx)) / 6;
  }
  for (const [d, c] of dir) { const [a, b] = d.split('>'); assert.equal(c, 1); assert.equal(dir.get(`${b}>${a}`), 1); }
  assert.ok(vol > 0, 'outward');
  const bb = boundingBox(k);
  assert.ok(Math.abs(bb.size[2] - padThickMM(l)) < 1e-4, 'as thick as the pad');
  assert.ok(Math.abs(padThickMM(l) - (l.camHeightMM - l.clearanceMM)) < 1e-9, 'which fills its pocket, less the slip fit');
});

test('the key is a closed solid despite its reflex corners', () => {
  const poly = keyOutline();
  assert.equal(earClip(poly).length, poly.length - 2, 'a simple polygon of n vertices gives n-2 triangles');
  const w = checkWatertight(keySolid());
  assert.ok(w.watertight, `${w.unpaired} unpaired edges`);
  assert.ok(checkWatertight(keySheet(9)).watertight, 'and a sheet of them');
  assert.ok(Math.abs(boundingBox(keySolid()).size[2] - padThickMM(L)) < 1e-4, 'as thick as its pad; the neck and head are keyThickMM');
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

test('everything is cut into the underside: the top is not touched, and the cams\' bores are blind', () => {
  const f = tile(22, 161);
  const before = Float64Array.from(f.values);
  const r = cutLockFeatures(f, c, edgeLocks(c), {});
  assert.equal(r.placed.length, 8);
  assert.equal(r.bores.length, 4, 'one cam bore a side');
  for (const b of r.bores) {
    assert.ok(Math.abs(b.rMM - boreRadius(L)) < 1e-9);
    assert.equal(b.blindMM, L.camHeightMM, 'blind, as deep as the cam is tall');
  }
  assert.deepEqual(Array.from(f.values), Array.from(before), 'the ground is left as it was');
  assert.equal(r.keepClear, undefined, 'and there is no terrace for the woods to keep off');
  let cut = 0;
  for (const v of r.floor) if (v > 0) { cut++; assert.equal(v, recessDepth(L)); }
  assert.ok(cut > 0);
  assert.equal(recessDepth(L), L.camHeightMM, 'the pockets and the entry channels are as deep as the bores');
  const s = cutSockets(f, c, {}, r.floor, r.bores);
  assert.equal(s.placed.length, 4);
  const w = checkWatertight(meshTile(f, { floor: r.floor, bores: r.bores }));
  assert.ok(w.watertight, `${w.unpaired} unpaired, ${w.overused} overused`);
  assert.deepEqual(camHeights(r.placed), [L.camHeightMM], 'every cam the same height');
  for (const p of r.placed.filter((x) => x.kind === 'cam')) assert.equal(p.heightMM, L.camHeightMM);
});

test('a module with every lock feature and a socket in each corner is closed at a fine and a coarse grid, and with a spring bored through it', () => {
  for (const n of [223, 81]) {
    for (const springs of [[], [{ x: 100, y: 100, rMM: 6.75 }], [{ x: 150, y: 40, rMM: 6.75 }]]) {
      const f = tile(22, n);
      const r = cutLockFeatures(f, c, edgeLocks(c), {}, springs);
      const s = cutSockets(f, c, {}, r.floor, [...springs, ...r.bores]);
      assert.equal(r.placed.length, 8, `grid ${n}`);
      assert.equal(s.placed.length, 4, `grid ${n}`);
      const w = checkWatertight(meshTile(f, { floor: r.floor, bores: [...springs, ...r.bores] }));
      assert.equal(w.unpaired, 0, `grid ${n}, ${springs.length} springs: ${w.unpaired} unpaired`);
      assert.equal(w.overused, 0, `grid ${n}, ${springs.length} springs: ${w.overused} overused`);
    }
  }
});

test('nothing is cut into the top on high ground either: no terrace round a cam', () => {
  const f = makeField(201, 201, 1);
  for (let j = 0; j < 201; j++) for (let i = 0; i < 201; i++) f.values[j * 201 + i] = 30 + 10 * Math.sin(i / 17) * Math.cos(j / 23);
  const before = Float64Array.from(f.values);
  const r = cutLockFeatures(f, c, edgeLocks(c), {});
  assert.equal(r.placed.length, 8);
  assert.deepEqual(Array.from(f.values), Array.from(before));
  const tris = meshTile(f, { floor: r.floor, bores: r.bores });
  assert.ok(checkWatertight(tris).watertight);
  // Every node of the top is still a vertex of the mesh, at its height.
  const at = new Set();
  for (let o = 0; o < tris.length; o += 3) at.add(`${Math.round(tris[o] * 1000)},${Math.round(tris[o + 1] * 1000)},${Math.round(tris[o + 2] * 1000)}`);
  for (let j = 0; j < 201; j += 3) for (let i = 0; i < 201; i += 3) {
    assert.ok(at.has(`${i * 1000},${j * 1000},${Math.round(Math.fround(f.values[j * 201 + i]) * 1000)}`), `top node ${i},${j}`);
  }
});

test('face down, the key lies at the deep end of its pocket, inside the cam\'s hook; the coin slot is at the underside', () => {
  const d = lockDepths(L);
  const cam = camSettings(L);
  const prof = camProfile(cam);
  // The cam goes in hook end first, so its hook -- its own bottom hookMM --
  // is the deep end of the bore.
  assert.ok(Math.abs(d.hook[1] - d.hook[0] - prof.hookMM) < 1e-9, 'the same hook cam.js cuts');
  assert.equal(d.hook[1], L.camHeightMM);
  assert.equal(d.key[1], L.camHeightMM, 'the key against the roof of its pocket');
  assert.ok(d.key[0] >= d.hook[0] - 1e-9 && d.key[1] <= d.hook[1] + 1e-9, `the key at ${d.key} is inside the hook at ${d.hook}`);
  assert.ok(d.key[1] - d.key[0] >= L.keyThickMM, 'with room for the key');
  // And the coin slot, at the cam's own top, is flush with the underside,
  // below the hook: the cam's solid part is between them.
  assert.deepEqual(d.slot, [0, L.slotDepthMM]);
  assert.ok(d.slot[1] < d.hook[0], 'the slot does not reach the hook');
  assert.ok(Math.abs(shortestCamMM(L) - 8.1) < 1e-9);
  assert.ok(L.camHeightMM >= shortestCamMM(L));
  const solid = camSolid(cam, L.camHeightMM);
  assert.ok(checkWatertight(solid).watertight);
  assert.ok(Math.abs(boundingBox(solid).size[2] - L.camHeightMM) < 1e-6);
  assert.match(checkLock(c, { camHeightMM: 7 }).map((x) => x.message).join(' '), /needs 8\.1 mm/);
});

test('a feature where the ground runs low, or into a bore, is refused WHOLE', () => {
  const f = tile(5);
  const r = cutLockFeatures(f, c, [{ id: 'k', edge: 'E', kind: 'key', uMM: 50 }], {});
  assert.equal(r.placed.length, 0);
  assert.match(r.refused[0].why, /only 5\.0 mm/);
  for (const v of r.floor) assert.equal(v, 0, 'nothing was cut');
  const g = tile(22);
  const bore = { x: c.tileMM - 8, y: 50, rMM: 6.75 };
  const r2 = cutLockFeatures(g, c, [{ id: 'k', edge: 'E', kind: 'key', uMM: 50 }], {}, [bore]);
  assert.match(r2.refused[0].why, /tube bore/);
  // A cam needs camHeight + minFloor over its bore and its entry channel:
  // 10 mm of ground is enough, a hair under is not.
  const cam = [{ id: 'E-cam', edge: 'E', kind: 'cam', uMM: 150 }];
  assert.equal(cutLockFeatures(tile(L.camHeightMM + L.minFloorMM), c, cam, {}).placed.length, 1);
  const low = cutLockFeatures(tile(L.camHeightMM + L.minFloorMM - 0.05), c, cam, {});
  assert.equal(low.placed.length, 0);
  assert.equal(low.bores.length, 0);
  // Low ground only over the entry channel, the bore's ground high: still refused.
  const h = tile(22, 201);
  for (let k = 0; k < h.values.length; k++) {
    const x = (k % 201) * h.step; const y = Math.floor(k / 201) * h.step;
    if (x > c.tileMM - 3 && Math.abs(y - 150) < 3) h.values[k] = 9;
  }
  assert.match(cutLockFeatures(h, c, cam, {}).refused[0]?.why || '', /only 9\.0 mm/);
  // A spring beside the cam whose block would meet the cam's.
  const spring = { x: 182, y: 150 + 16, rMM: 6.75 };
  const r3 = cutLockFeatures(tile(22, 223), c, cam, {}, [spring]);
  assert.match(r3.refused[0]?.why || '', /tube bore/);
});

test('the keys to print are the key pockets that were cut', () => {
  assert.equal(usableKeys({ keys: [{ kind: 'key' }, { kind: 'cam' }, { kind: 'key' }] }).length, 2);
  assert.equal(usableKeys({}).length, 0);
  assert.equal(LOCK_DEFAULTS.offsetMM, 50);
});
