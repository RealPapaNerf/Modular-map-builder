// The grown module as arrays for the 3D view: what crosses the worker
// boundary, where the water is drawn, and the geometry built from it.

import test from 'node:test';
import assert from 'node:assert/strict';
import { makeField } from '../lib/field.js';
import { buildTile } from '../lib/build.js';
import {
  tileHeights, transferables, waterSurface, groundArrays, gridIndex, wallArrays, rimLine, waterArrays,
  proxyArrays, sampleHeight, groundColour, heightSpan, lockBandArrays, GROUND, RIVER, STILL, WOOD, lakeAt,
} from '../app/heights.js';

/** A 5 x 5 module, 200 mm across. */
function fakeTile({ values = null } = {}) {
  const local = makeField(5, 5, 50, 0, 0);
  local.values.set(values || [
    30, 30, 30, 30, 30,
    30, 20, 10, 20, 30,
    30, 20, 10, 20, 30,
    30, 20, 10, 20, 30,
    30, 30, 30, 30, 30,
  ]);
  const wet = new Uint8Array(25);
  const water = new Float32Array(25).fill(NaN);
  for (const k of [7, 12, 17]) { wet[k] = 1; water[k] = 13; } // the channel down the middle, 3 mm of water in it
  const lakeWet = new Uint8Array(25);
  lakeWet[6] = 1; // a lake cell at (1, 1)
  const woodMask = new Uint8Array(25);
  woodMask[0] = 1;
  woodMask[7] = 1; // a crown cannot stand in the channel
  return {
    local, wet, water,
    lakes: [{ what: 'tarn', surfaceZ: 24, wet: lakeWet }, { what: 'skipped', surfaceZ: 99 }],
    springs: [{ atMM: [150, 150], poolRadiusMM: 10, spillMM: 25 }],
    woods: [{ kind: 'conifer', mask: woodMask }],
  };
}

test('a built module crosses the boundary as Float32 heights, its water and what each cell is', () => {
  const h = tileHeights(fakeTile());
  assert.ok(h.heights instanceof Float32Array);
  assert.equal(h.heights.length, 25);
  assert.equal(h.heights[12], 10);
  assert.equal(h.kind[7], RIVER);
  assert.equal(h.water[12], 13, 'the channel carries its water at the level the carve set');
  assert.equal(h.kind[6], STILL, 'a lake cell is still water');
  assert.equal(h.water[6], 24, 'at its own surface');
  assert.equal(h.kind[18], STILL, 'the spring pool at (3, 3) is still water');
  assert.equal(h.water[18], 25, 'filled to the notch in its lip');
  assert.equal(h.kind[0], WOOD);
  assert.equal(h.kind[7], RIVER, 'a crown never turns a channel cell into wood');
  assert.equal(h.kind[24], GROUND);
  const buffers = transferables(h);
  assert.equal(buffers.length, 4, 'heights, water, kind, and which lake');
  assert.ok(buffers.every((b) => b instanceof ArrayBuffer));
  // A click on the lake finds it; one on dry ground finds none.
  assert.equal(lakeAt(h, 1 * h.step, 1 * h.step), 0, 'the lake at cell 6 is the build\'s first lake');
  assert.equal(lakeAt(h, 4 * h.step, 4 * h.step), -1);
});

test('every cell of the build\'s pool disc is pool or lip, never channel water', () => {
  const t = fakeTile();
  t.lakes = [];
  t.local.values[19] = 28; // (4, 3): a channel cell on the lip, above the spill
  t.wet[19] = 1; t.water[19] = 31;
  t.wet[18] = 1; t.water[18] = 13;
  const h = tileHeights(t);
  assert.equal(h.kind[18], STILL, 'the middle of the pool');
  assert.equal(h.kind[17], STILL, 'a channel cell in the disc, under the spill, is pool');
  assert.equal(h.water[17], 25);
  assert.equal(h.kind[19], GROUND, 'a cell in the disc over the spill is lip, not channel');
  assert.ok(Number.isNaN(h.water[19]));
  assert.equal(h.kind[12], RIVER, 'outside the disc the channel is still a channel');
  const s = waterSurface(h);
  for (const k of [17, 18]) assert.equal(s[k], 25, 'one surface over the whole pool');
});

test('a dry module with no lakes has no water at all; a channel\'s water reaches its banks and no further', () => {
  const t = fakeTile();
  t.lakes = [];
  t.springs = [];
  t.water.fill(NaN);
  assert.ok([...waterSurface(tileHeights(t))].every((v) => Number.isNaN(v)));
  const u = fakeTile();
  u.lakes = [];
  u.springs = [];
  const s = waterSurface(tileHeights(u));
  assert.equal(s[12], 13);
  assert.equal(s[11], 13, 'one cell round it is water too, so the channel meets its banks');
  assert.equal(s[2], 13);
  assert.ok(Number.isNaN(s[10]), 'and no further');
  assert.ok(Number.isNaN(s[14]));
});

test('a deeper lake keeps its own surface where two waters meet', () => {
  const t = fakeTile();
  t.lakes[0].surfaceZ = 26;
  const s = waterSurface(tileHeights(t));
  assert.equal(s[6], 26);
  assert.equal(s[0], 26, 'the ring round the water takes the highest water next to it');
});

test('the top surface: a vertex per sample, unit normals from the field, two counter-clockwise triangles a cell', () => {
  const flat = fakeTile({ values: new Array(25).fill(12) });
  const g = groundArrays(tileHeights(flat), () => [0.5, 0.5, 0.5]);
  assert.equal(g.position.length, 75);
  assert.equal(g.index.length, 16 * 6);
  for (let k = 0; k < 25; k++) assert.deepEqual([...g.normal.slice(k * 3, k * 3 + 3)].map((v) => v + 0), [0, 0, 1]);
  for (let i = 0; i < g.index.length; i += 3) {
    const p = (v) => [g.position[v * 3], g.position[v * 3 + 1]];
    const [a, b, c] = [p(g.index[i]), p(g.index[i + 1]), p(g.index[i + 2])];
    assert.ok((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]) > 0, 'faces up');
  }
  const sloped = groundArrays(tileHeights(fakeTile()), () => [0, 0, 0]);
  for (let k = 0; k < 25; k++) {
    const n = sloped.normal.slice(k * 3, k * 3 + 3);
    assert.ok(Math.abs(Math.hypot(...n) - 1) < 1e-6);
    assert.ok(n[2] > 0);
  }
  assert.ok(sloped.normal[11 * 3] > 0, 'down the west slope of the channel the normal leans east');
});

test('a coarse index covers the same square with a quarter of the triangles, rim included', () => {
  assert.equal(gridIndex(5, 5, 2).length, 2 * 2 * 6);
  const six = gridIndex(6, 6, 2);
  assert.equal(six.length, 3 * 3 * 6, 'an odd side still reaches the last sample');
  assert.ok(Math.max(...six) === 35 && Math.min(...six) === 0);
  assert.ok(gridIndex(300, 300, 1) instanceof Uint32Array, 'past 65535 vertices the index is 32-bit');
  assert.ok(gridIndex(200, 200, 1) instanceof Uint16Array);
});

test('the walls face out and come down to the bottom of the piece; the rim is the top edge', () => {
  const h = tileHeights(fakeTile());
  const w = wallArrays(h);
  assert.equal(w.position.length / 9, 2 * 4 * 4);
  for (let v = 0; v < w.position.length; v += 9) {
    const mx = (w.position[v] + w.position[v + 3] + w.position[v + 6]) / 3;
    const my = (w.position[v + 1] + w.position[v + 4] + w.position[v + 7]) / 3;
    assert.ok((mx - 100) * w.normal[v] + (my - 100) * w.normal[v + 1] > 0, 'outward');
  }
  assert.ok(Math.min(...[...w.position].filter((_, i) => i % 3 === 2)) === 0);
  const rim = rimLine(h);
  assert.equal(rim.position.length / 3, 16);
  assert.ok(Math.abs(rim.position[2] - (30 + 0.15)) < 1e-6);
});

test('water is drawn only over cells whose four corners are wet', () => {
  const h = tileHeights(fakeTile());
  const s = new Float32Array(25).fill(NaN);
  for (const k of [6, 7, 11, 12]) s[k] = 15;
  const w = waterArrays(h, s);
  assert.equal(w.triangles, 2);
  assert.equal(w.index.length, 6);
  assert.equal(w.position[6 * 3 + 2], 15);
  assert.equal(waterArrays(h, new Float32Array(25).fill(NaN)).triangles, 0);
});

test('the pick proxy is coarse, and the sampled height is the field\'s', () => {
  const h = tileHeights(fakeTile());
  assert.equal(proxyArrays(h, 3).position.length / 3, 9);
  assert.equal(sampleHeight(h, 100, 100), 10);
  assert.equal(sampleHeight(h, 75, 100), 15, 'bilinear between 20 and 10');
  assert.equal(sampleHeight(h, -10, 300), 30, 'clamped to the module');
});

test('colours follow the hillshade\'s bands, and the tops are rock, not snow', () => {
  const lo = groundColour(GROUND, 0);
  const hi = groundColour(GROUND, 1);
  assert.ok(lo[1] > lo[0], 'low ground is green');
  assert.ok(hi[0] < 0.85 && hi[1] < 0.85 && hi[2] < 0.85, 'the tops are grey-brown rock: white read as ice that was no longer there');
  assert.ok(hi[0] >= hi[2], 'and warm, not blue');
  assert.ok(groundColour(WOOD, 0.5)[1] > groundColour(WOOD, 0.5)[0]);
  assert.deepEqual(heightSpan(tileHeights(fakeTile())), { lo: 10, hi: 30 });
});

test('on a real build every carved cell is drawn as something, and the channel runs with water in it', () => {
  const spec = {
    seed: 3, meshMM: 5, glacier: false, worldGrid: 48,
    channels: [{ name: 'c', widthMM: 30, path: [[0, 100], [200, 100]] }],
    fountains: { auto: true },
    lakes: { fillHollows: false, place: [{ atMM: [100, 160], radiusMM: 18 }] },
    canopy: [{ kind: 'conifer', density: 0.5 }],
  };
  const r = buildTile(spec);
  const t = r.tile;
  const h = tileHeights(t);
  assert.equal(h.heights.length, t.local.nx * t.local.ny);
  const lip = new Set();
  for (const sp of t.springs) {
    const ri = Math.round(sp.atMM[0] / h.step);
    const rj = Math.round(sp.atMM[1] / h.step);
    const rad = Math.ceil(sp.poolRadiusMM / h.step);
    for (let j = rj - rad; j <= rj + rad; j++) {
      for (let i = ri - rad; i <= ri + rad; i++) {
        const k = j * h.nx + i;
        if (Math.hypot(i - ri, j - rj) <= rad && h.heights[k] >= sp.spillMM) lip.add(k);
      }
    }
  }
  for (let k = 0; k < h.kind.length; k++) if (t.wet[k] && !lip.has(k)) assert.notEqual(h.kind[k], GROUND, `cell ${k} is wet`);
  for (const k of lip) assert.notEqual(h.kind[k], RIVER, `cell ${k} is the pool's lip, not channel`);
  for (const l of t.lakes) {
    if (!l.wet) continue;
    for (let k = 0; k < h.kind.length; k++) if (l.wet[k]) assert.ok(h.water[k] >= l.surfaceZ - 1e-4, `${l.what} cell ${k}`);
  }
  const s = waterSurface(h);
  let runs = 0;
  for (let k = 0; k < h.kind.length; k++) if (h.kind[k] === RIVER && !Number.isNaN(s[k])) runs++;
  assert.ok(runs > 0, 'the channel is drawn with water in it');
  assert.ok(h.kind.some((k) => k === WOOD), 'the wood is drawn as wood');
  assert.ok(t.lakes.some((l) => l.what === 'lake'), 'the placed lake was carved');
});

test('the rim lock band covers the last 12 mm of every rim, opaque at the rim and clear where the lock ends', () => {
  const t = fakeTile();
  t.local = makeField(81, 81, 2.5, 0, 0);
  t.local.values.fill(20);
  t.wet = new Uint8Array(81 * 81);
  t.water = new Float32Array(81 * 81).fill(NaN);
  t.lakes = [];
  t.springs = [];
  t.woods = [];
  const h = tileHeights(t);
  const b = lockBandArrays(h, 12, [1, 0, 0], { alpha: 0.5 });
  const alpha = (i, j) => b.color[(j * 81 + i) * 4 + 3];
  assert.equal(alpha(0, 40), 0.5);
  assert.equal(alpha(40, 40), 0);
  assert.ok(alpha(2, 40) > 0 && alpha(2, 40) < 0.5);
  assert.equal(alpha(5, 40), 0, '12.5 mm in is past the lock');
  assert.equal(b.index.length / 6, 80 * 80 - 70 * 70);
  assert.ok(Math.abs(b.position[(40 * 81 + 40) * 3 + 2] - 20.3) < 1e-6, 'a hair above the ground');
});
