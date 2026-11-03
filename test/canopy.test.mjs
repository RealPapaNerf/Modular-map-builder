import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeField, fill } from '../lib/field.js';
import { scatterCanopy, crownHeight, placeTrees, crownFootprintMM2, spacingForDensity, smoothMax, CANOPY_DEFAULTS } from '../lib/canopy.js';

const flatTile = (extent = 120, step = 0.5, z = 20) => {
  const n = Math.round(extent / step) + 1;
  const f = makeField(n, n, step);
  f.values.fill(z);
  return f;
};
const tree = (over) => ({ ...CANOPY_DEFAULTS, id: 1, x: 0, y: 0, phase: 0.3, leanX: 0, leanY: 0, ...over });

test('a conifer is a spire — tallest at the trunk, falling away all the way out', () => {
  const t = tree({ kind: 'conifer', crownMM: 10, heightMM: 14 });
  const centre = crownHeight(t, 0, 0);
  assert.ok(centre > 12, `apex should be near the full height, got ${centre.toFixed(1)}`);
  // Sampled out along one radius, the trend is downward and reaches zero.
  let prev = centre;
  let dropped = 0;
  for (let r = 0.5; r <= 6; r += 0.5) {
    const h = crownHeight(t, r, 0);
    if (h < prev) dropped++;
    prev = h;
  }
  assert.ok(dropped >= 9, 'a cone falls away from its apex');
  assert.equal(crownHeight(t, 9, 0), 0, 'and ends');
});

test('a broadleaf crown is markedly lumpier round a ring than a conifer', () => {
  // Not "a cone is perfectly round" -- conifers here carry a deliberate
  // out-of-round plan so no two are identical, and asserting roundness
  // failed on that. What has to hold is the CONTRAST: the broadleaf crown
  // is several separate masses and the conifer is one spire.
  const pick = (kind) => placeTrees({ ...CANOPY_DEFAULTS, kind, crownMM: 12, heightMM: 8,
                                      spacingMM: 40, seed: 1, sizeVariation: 0 }, 200, () => true).trees[0];
  const dome = pick('conifer');
  const leafy = pick('deciduous');
  const ring = (t, r) => {
    const hs = [];
    for (let a = 0; a < 36; a++) hs.push(crownHeight(t, r * Math.cos((a * Math.PI) / 18), r * Math.sin((a * Math.PI) / 18)));
    const mean = hs.reduce((x, y) => x + y, 0) / hs.length;
    return Math.sqrt(hs.reduce((x, y) => x + (y - mean) ** 2, 0) / hs.length);
  };
  const spire = ring(dome, 3);
  const broadleaf = ring(leafy, 3);
  assert.ok(broadleaf > 2 * spire,
    `broadleaf (${broadleaf.toFixed(2)}) should be well over twice as lumpy as conifer (${spire.toFixed(2)})`);
  assert.ok(broadleaf > 1.2, 'and lumpy in absolute terms, or it prints as a ball');
});

test('crowns are the same shape at any size — a hedge is a scaled wood', () => {
  const small = tree({ kind: 'deciduous', crownMM: 6, heightMM: 4 });
  const big = tree({ kind: 'deciduous', crownMM: 18, heightMM: 12 });
  for (const u of [0, 0.2, 0.4, 0.6]) {
    const a = crownHeight(small, u * 3, 0) / 4;
    const b = crownHeight(big, u * 9, 0) / 12;
    assert.ok(Math.abs(a - b) < 0.02, `profile should scale: at u=${u}, ${a.toFixed(3)} vs ${b.toFixed(3)}`);
  }
});

test('no tree crosses a seam — the rim is untouched', () => {
  const f = flatTile();
  const before = Float64Array.from(f.values);
  const r = scatterCanopy(f, { kind: 'conifer', crownMM: 8, heightMM: 10, spacingMM: 9, seed: 3 });
  assert.ok(r.trees > 20, `expected a wood, got ${r.trees} trees`);
  const n = f.nx;
  for (let k = 0; k < n; k++) {
    for (const idx of [k, (n - 1) * n + k, k * n, k * n + (n - 1)]) {
      assert.equal(f.values[idx], before[idx], 'a boundary cell was raised by a tree');
    }
  }
});

test('nothing is planted in the river', () => {
  const f = flatTile();
  const n = f.nx;
  const wet = new Uint8Array(n * n);
  // A band of water straight down the middle.
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) if (Math.abs(i - n / 2) < 12) wet[j * n + i] = 1;
  const before = Float64Array.from(f.values);
  const r = scatterCanopy(f, { crownMM: 8, heightMM: 6, spacingMM: 9, seed: 5, wet, bankMM: 2 });
  assert.ok(r.reasons.water > 0, 'some trees should have been refused for standing in water');
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      if (wet[j * n + i]) assert.equal(f.values[j * n + i], before[j * n + i], 'a tree grew in the river');
    }
  }
});

test('a treeline keeps the summits bare', () => {
  const n = 241;
  const f = makeField(n, n, 0.5);
  fill(f, (x) => 10 + x * 0.4); // a ramp from 10 mm to 58 mm
  const before = Float64Array.from(f.values);
  scatterCanopy(f, { crownMM: 7, heightMM: 6, spacingMM: 9, seed: 2, maxZMM: 30 });
  let aboveChanged = 0;
  let belowChanged = 0;
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const k = j * n + i;
      if (f.values[k] === before[k]) continue;
      if (before[k] > 36) aboveChanged++; else belowChanged++;
    }
  }
  assert.ok(belowChanged > 0, 'trees below the line');
  assert.equal(aboveChanged, 0, 'nothing above it');
});

test('cliffs stay bare', () => {
  const n = 241;
  const f = makeField(n, n, 0.5);
  // Gentle on the left, near-vertical on the right.
  fill(f, (x) => (x < 60 ? 10 + x * 0.05 : 13 + (x - 60) * 2.0));
  const before = Float64Array.from(f.values);
  const r = scatterCanopy(f, { crownMM: 7, heightMM: 6, spacingMM: 9, seed: 4, maxSlopeDeg: 30 });
  assert.ok(r.reasons.slope > 0, 'some trees refused for slope');
  let onCliff = 0;
  for (let j = 0; j < n; j++) for (let i = 140; i < n; i++) if (f.values[j * n + i] !== before[j * n + i]) onCliff++;
  assert.equal(onCliff, 0);
});

test('crowns combine by max, so a dense wood keeps its gaps', () => {
  const t = tree({ kind: 'deciduous', crownMM: 10, heightMM: 8 });
  const a = crownHeight(t, 0, 0);
  const f = flatTile(60, 0.4, 20);
  scatterCanopy(f, { kind: 'deciduous', crownMM: 10, heightMM: 8, spacingMM: 4, seed: 9, sizeVariation: 0 });
  let tallest = 0;
  for (const v of f.values) tallest = Math.max(tallest, v - 20);
  assert.ok(tallest <= a * 1.35 + 1e-6,
    `overlapping crowns must not stack: tallest ${tallest.toFixed(2)} against a single crown of ${a.toFixed(2)}`);
});

test('the same tile grows the same wood twice', () => {
  const a = flatTile();
  const b = flatTile();
  scatterCanopy(a, { crownMM: 9, heightMM: 7, spacingMM: 11, seed: 42 });
  scatterCanopy(b, { crownMM: 9, heightMM: 7, spacingMM: 11, seed: 42 });
  assert.deepEqual(Array.from(a.values), Array.from(b.values));
});

test('a different seed grows a different wood', () => {
  const a = flatTile();
  const b = flatTile();
  scatterCanopy(a, { crownMM: 9, heightMM: 7, spacingMM: 11, seed: 1 });
  scatterCanopy(b, { crownMM: 9, heightMM: 7, spacingMM: 11, seed: 2 });
  assert.notDeepEqual(Array.from(a.values), Array.from(b.values));
});

test('closer spacing plants more trees', () => {
  const far = scatterCanopy(flatTile(), { crownMM: 6, heightMM: 5, spacingMM: 20, seed: 8 });
  const near = scatterCanopy(flatTile(), { crownMM: 6, heightMM: 5, spacingMM: 8, seed: 8 });
  assert.ok(near.trees > far.trees * 3, `${near.trees} against ${far.trees}`);
});

test('a crown too coarse for the mesh is reported, not silently printed as a lump', () => {
  const coarse = makeField(61, 61, 2); // 2 mm cells
  coarse.values.fill(20);
  const r = scatterCanopy(coarse, { crownMM: 6, heightMM: 5, spacingMM: 9, seed: 1 });
  assert.ok(r.warnings.some((w) => /cells across/.test(w)));
});

test('a jittered grid is not a grid', () => {
  const { trees } = placeTrees({ ...CANOPY_DEFAULTS, seed: 1, spacingMM: 10, jitter: 0.6, sizeVariation: 0.3 },
    200, () => true);
  const offsets = trees.map((t) => t.x % 10);
  const spread = Math.max(...offsets) - Math.min(...offsets);
  assert.ok(spread > 2, `trunks should not line up, spread was ${spread.toFixed(2)}`);
  assert.ok(new Set(trees.map((t) => t.crownMM.toFixed(3))).size > 10, 'and they should not all be one size');
});

test('a tree built the way scatterCanopy builds one is still lumpy', () => {
  // Deliberately goes through placeTrees rather than constructing a tree by
  // hand. The hand-built version is what the lumpiness test above uses, and
  // for a while it passed while every tree the renderer actually produced
  // was a smooth dome: placeTrees listed the shape fields it copied, and
  // `lobeSize` was not among them, so the lobe radius was NaN and every
  // outer lobe fell out of the max. A test that builds its own input is not
  // testing the thing that ships.
  const { trees } = placeTrees({ ...CANOPY_DEFAULTS, kind: 'deciduous', crownMM: 14, heightMM: 9,
                                 spacingMM: 30, seed: 3, sizeVariation: 0 }, 200, () => true);
  assert.ok(trees.length > 0);
  const t = trees[0];
  for (const key of ['lobes', 'lobeSize', 'lobeSpread', 'whorls', 'whorlDepth', 'spire']) {
    assert.ok(Number.isFinite(t[key]), `tree is missing shape field ${key}`);
  }
  const ring = (r) => {
    const hs = [];
    for (let a = 0; a < 36; a++) hs.push(crownHeight(t, r * Math.cos((a * Math.PI) / 18), r * Math.sin((a * Math.PI) / 18)));
    const m = hs.reduce((x, y) => x + y, 0) / hs.length;
    return { m, sd: Math.sqrt(hs.reduce((x, y) => x + (y - m) ** 2, 0) / hs.length) };
  };
  const { m, sd } = ring(4.5);
  assert.ok(m > 1, 'there should be crown out at a third of the radius');
  assert.ok(sd / m > 0.12, `crown should vary by more than 12% around a ring, got ${(100 * sd / m).toFixed(0)}%`);
});

test('a treeline is a WORLD elevation, not a tile-local one', () => {
  // Tiles stand on different numbers of plates, so local heights say nothing
  // about how high a piece of ground actually is. Read locally, a treeline
  // planted woods over every summit on the map, because a tile six plates up
  // looks exactly like a valley tile from the inside.
  const mk = () => { const f = makeField(241, 241, 0.5); f.values.fill(25); return f; };
  const valley = mk();
  const summit = mk();
  const opts = { crownMM: 7, heightMM: 6, spacingMM: 10, seed: 6, maxZMM: 50 };
  const low = scatterCanopy(valley, { ...opts, baseMM: 0 });
  const high = scatterCanopy(summit, { ...opts, baseMM: 60 });
  assert.ok(low.trees > 50, 'the valley is below the line and should be wooded');
  assert.equal(high.trees, 0, 'the same ground six plates up is above it and should be bare');
});

// ---------------------------------------------------------------------------
// Density

test('density is monotone — more of it means more wood', () => {
  let lastTrees = -1;
  let lastCover = -1;
  for (const density of [0.05, 0.15, 0.3, 0.5, 0.7, 1.0]) {
    const f = flatTile(200, 0.5, 20);
    const r = scatterCanopy(f, { kind: 'conifer', crownMM: 10, heightMM: 8, density, seed: 5 });
    assert.ok(r.trees > lastTrees, `density ${density} planted ${r.trees}, not more than ${lastTrees}`);
    assert.ok(r.coverFraction > lastCover, `density ${density} covered ${r.coverFraction.toFixed(3)}`);
    lastTrees = r.trees;
    lastCover = r.coverFraction;
  }
});

test('density means measured ground cover, near enough, where crowns do not pile up', () => {
  // Calibrated against the real stamped footprint rather than pi*r^2. With
  // the circle it was out by nearly half -- density 1 gave 58% cover -- and
  // the number in the spec file meant nothing in particular.
  for (const kind of ['conifer', 'deciduous']) {
    for (const density of [0.15, 0.3, 0.5]) {
      const f = flatTile(200, 0.5, 20);
      const r = scatterCanopy(f, { kind, crownMM: 10, heightMM: 7, density, seed: 5 });
      const err = Math.abs(r.coverFraction - density) / density;
      assert.ok(err < 0.25,
        `${kind} at density ${density} measured ${(100 * r.coverFraction).toFixed(0)}% cover`);
    }
  }
});

test('density 1 is a closed canopy with the ground hidden', () => {
  // This test used to assert the opposite -- that cover saturated around
  // 0.6 and "you cannot cover every square millimetre by scattering discs".
  // That was over-general: you cannot at a FIXED spacing, but the spacing
  // is not fixed, and compensating for the overlap closes the canopy
  // properly. The old version pinned a limitation of the formula as though
  // it were a fact about trees.
  for (const kind of ['conifer', 'deciduous']) {
    const f = flatTile(200, 0.5, 20);
    const r = scatterCanopy(f, { kind, crownMM: 10, heightMM: 7, density: 1.0, seed: 5 });
    assert.ok(r.coverFraction > 0.88,
      `${kind} at density 1 covered only ${(100 * r.coverFraction).toFixed(0)}% — the ground still shows`);
  }
});

test('crowns fuse where they overlap instead of creasing', () => {
  // Two crowns a little apart. Under a hard max the surface between them
  // has a crease -- a V with a sharp bottom. Under the soft union it is
  // rounded, which is what a closed stand looks like and what prints.
  const sep = 6;
  const t = (x) => ({ ...CANOPY_DEFAULTS, kind: 'conifer', crownMM: 10, heightMM: 8,
                      id: 1, x, y: 0, phase: 0, leanX: 0, leanY: 0 });
  const a = t(-sep / 2);
  const b = t(sep / 2);
  const at = (x, k) => smoothMax(crownHeight(a, x - a.x, 0), crownHeight(b, x - b.x, 0), k);
  const hard = at(0, 0);
  const soft = at(0, 1.4);
  assert.ok(soft > hard, `the saddle should be filled in: ${soft.toFixed(2)} against ${hard.toFixed(2)}`);
  // Far from any neighbour the soft union must change nothing.
  assert.equal(smoothMax(crownHeight(a, 0, 0), 0, 1.4), crownHeight(a, 0, 0));
});

test('a lobed crown does not fill its nominal circle, and a cone roughly does', () => {
  // This is the whole reason the footprint is measured rather than assumed.
  // Assuming pi*r^2 for both prices the broadleaf crown about 27% too high,
  // which is how density 1 came out at 58% measured cover.
  const nominal = Math.PI * 5 * 5;
  const cone = crownFootprintMM2({ ...CANOPY_DEFAULTS, kind: 'conifer', crownMM: 10, heightMM: 7 });
  const leafy = crownFootprintMM2({ ...CANOPY_DEFAULTS, kind: 'deciduous', crownMM: 10, heightMM: 7 });
  assert.ok(Math.abs(cone - nominal) / nominal < 0.15,
    `a cone fills its circle, give or take: ${cone.toFixed(1)} against ${nominal.toFixed(1)}`);
  assert.ok(leafy < nominal * 0.85,
    `gaps between the lobes should cost it real area: ${leafy.toFixed(1)} against ${nominal.toFixed(1)}`);
  assert.ok(leafy > nominal * 0.4, 'but it is still a crown, not a twig');
});

test('spacing accounts for crowns landing on each other', () => {
  // cover = 1 - exp(-A/s^2), not A/s^2. Ignoring the overlap made
  // `density: 1` come out at 0.89 of a crown diameter -- crowns just
  // touching, ground visible between them -- so a closed canopy still read
  // as a scatter of separate trees.
  const o = { ...CANOPY_DEFAULTS, kind: 'conifer', crownMM: 10, heightMM: 7, density: 0.25 };
  const A = crownFootprintMM2(o);
  const s = spacingForDensity(o);
  assert.ok(Math.abs((1 - Math.exp(-A / (s * s))) - 0.25) < 1e-6);
  const tight = spacingForDensity({ ...o, density: 1.0 });
  assert.ok(tight < s, 'denser means closer');
  assert.ok(tight < 0.55 * o.crownMM,
    `a closed canopy needs real overlap, got ${(tight / o.crownMM).toFixed(2)} of a crown diameter`);
});

test('an explicit spacing overrides density', () => {
  const f = flatTile(200, 0.5, 20);
  const r = scatterCanopy(f, { kind: 'conifer', crownMM: 10, heightMM: 7, density: 1.0, spacingMM: 40, seed: 5 });
  assert.equal(r.spacingMM, 40);
  assert.ok(r.trees < 40, 'spacing of 40 mm on a 200 mm tile is a sparse stand whatever density says');
});

test('a treeline can be a band rather than a line', () => {
  const n = 401;
  const f = makeField(n, n, 0.5);
  fill(f, (x) => 10 + x * 0.2); // 10 mm to 50 mm across the tile
  const r = scatterCanopy(f, { kind: 'conifer', crownMM: 8, heightMM: 7, density: 0.5,
                               seed: 3, maxZMM: 44, thinningMM: 12 });
  assert.ok(r.reasons.thinned > 0, 'some trees should be thinned out, not just cut off');
  // Count trunks in the band just below the line against well below it.
  const band = (lo, hi) => {
    let k = 0;
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const g = 10 + i * 0.5 * 0.2;
        if (g >= lo && g < hi && f.values[j * n + i] > g + 0.01) k++;
      }
    }
    return k;
  };
  const low = band(20, 28);
  const high = band(36, 44);
  assert.ok(high > 0, 'the band just below the line should still have some trees');
  assert.ok(high < low * 0.7, `and fewer than well below it: ${high} against ${low}`);
});
