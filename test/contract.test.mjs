import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeContract, edgeProfile, tileEdgeProfile, seamMismatch, assignLevels, check, seamGeometry, SIZES } from '../lib/contract.js';

const mk = (col, row, edges, level) => [`${col},${row}`, { col, row, edges, level }];

test('the flow rule forces one plate of fall per tile', () => {
  const c = makeContract();
  assert.equal(c.inletZMM - c.outletZMM, c.plateMM);
  const c2 = makeContract({ outletZMM: 4, plateMM: 10 });
  assert.equal(c2.inletZMM, 14, 'raising the outlet carries the inlet with it');
});

// Two tiles meeting east-west. The corner lattice is in WORLD mm, so each
// tile's local corners are the world height less its own plate stack -- which
// is what a correctly staggered pair looks like.
function pair(c, levelA, levelB, edgeA, edgeB, worldLand = 30) {
  const loc = (lvl) => worldLand - lvl * c.plateMM;
  const A = { col: 0, row: 0, edges: { E: edgeA },
              corners: { sw: loc(levelA), se: loc(levelA), nw: loc(levelA), ne: loc(levelA) } };
  const B = { col: 1, row: 0, edges: { W: edgeB },
              corners: { sw: loc(levelB), se: loc(levelB), nw: loc(levelB), ne: loc(levelB) } };
  return seamMismatch(c, A, levelA, B, levelB, 'E');
}

test('a correctly staggered seam puts the water at exactly the same height', () => {
  const c = makeContract();
  const m = pair(c, 1, 0, { type: 'out', size: 'river' }, { type: 'in', size: 'river' });
  assert.ok(m.ok, `channel out by ${m.channel}, land out by ${m.land}`);
  assert.equal(m.channel, 0);
  assert.equal(m.land, 0, 'the corner lattice puts the land at one world height, so it meets too');
});

test('two tiles at the same level do NOT line up — the stagger is load-bearing', () => {
  const c = makeContract();
  const m = pair(c, 1, 1, { type: 'out', size: 'river' }, { type: 'in', size: 'river' });
  assert.equal(m.ok, false);
  assert.ok(Math.abs(m.channel - c.plateMM) < 1e-9);
});

test('land meets land with no step when the corners agree', () => {
  const c = makeContract();
  const m = pair(c, 3, 3, { type: 'land' }, { type: 'land' });
  assert.equal(m.channel, 0);
  assert.equal(m.land, 0);
});

test('a tile whose corners disagree with its neighbour is caught', () => {
  const c = makeContract();
  const A = { col: 0, row: 0, edges: {}, corners: { sw: 20, se: 20, nw: 20, ne: 20 } };
  const B = { col: 1, row: 0, edges: {}, corners: { sw: 30, se: 30, nw: 30, ne: 30 } };
  const m = seamMismatch(c, A, 0, B, 0, 'E');
  assert.equal(m.ok, false);
  assert.ok(Math.abs(m.land - 10) < 1e-9);
});

test('an edge ramps between its two corners', () => {
  const c = makeContract();
  const spec = { edges: {}, corners: { sw: 20, se: 40, nw: 20, ne: 40 } };
  assert.equal(tileEdgeProfile(c, spec, 'S', 0), 20);
  assert.equal(tileEdgeProfile(c, spec, 'S', c.tileMM), 40);
  assert.equal(tileEdgeProfile(c, spec, 'S', c.tileMM / 2), 30);
});

test('the channel sits in the middle of the side at its declared width', () => {
  const c = makeContract();
  const e = { type: 'in', size: 'river' };
  const half = SIZES.river.widthMM / 2;
  assert.equal(edgeProfile(c, e, c.tileMM / 2), c.inletZMM, 'floor at the midpoint');
  assert.equal(edgeProfile(c, e, c.tileMM / 2 - half), c.inletZMM, 'floor to the edge of the channel');
  assert.equal(edgeProfile(c, e, 0), c.edgeLandMM, 'land at the corner');
  assert.equal(edgeProfile(c, e, c.tileMM), c.edgeLandMM);
});

test('every river size uses the same floor heights, so sizes interoperate', () => {
  const c = makeContract();
  for (const size of Object.keys(SIZES)) {
    assert.equal(edgeProfile(c, { type: 'in', size }, c.tileMM / 2), c.inletZMM);
    assert.equal(edgeProfile(c, { type: 'out', size }, c.tileMM / 2), c.outletZMM);
  }
});

test('a straight run steps down one plate per tile', () => {
  const tiles = new Map([
    mk(0, 0, { E: { type: 'out', size: 'river' } }),
    mk(1, 0, { W: { type: 'in', size: 'river' }, E: { type: 'out', size: 'river' } }),
    mk(2, 0, { W: { type: 'in', size: 'river' } }),
  ]);
  const { levels, problems } = assignLevels(tiles);
  assert.equal(levels.get('0,0'), 2);
  assert.equal(levels.get('1,0'), 1);
  assert.equal(levels.get('2,0'), 0);
  assert.equal(problems.filter((p) => p.severity === 'error').length, 0);
});

test('a dry tile takes its neighbour’s level instead of dropping to zero', () => {
  const tiles = new Map([
    mk(0, 0, { E: { type: 'out', size: 'river' } }),
    mk(1, 0, { W: { type: 'in', size: 'river' } }),
    mk(0, 1, {}),
  ]);
  const { levels } = assignLevels(tiles);
  assert.equal(levels.get('0,0'), 1);
  assert.equal(levels.get('0,1'), 1, 'the dry tile sits with the tile it touches, not at the bottom');
});

test('an explicit level wins, so a mountain block can stand proud', () => {
  const tiles = new Map([mk(0, 0, {}, 4), mk(1, 0, {})]);
  const { levels } = assignLevels(tiles);
  assert.equal(levels.get('0,0'), 4);
  assert.equal(levels.get('1,0'), 4);
});

test('branches of unequal length at a confluence are reported, not papered over', () => {
  const tiles = new Map([
    mk(0, 0, { E: { type: 'out', size: 'river' } }),
    mk(1, 0, { W: { type: 'in', size: 'river' }, E: { type: 'out', size: 'river' } }),
    mk(2, 0, { W: { type: 'in', size: 'river' }, N: { type: 'in', size: 'river' } }),
    mk(2, 1, { S: { type: 'out', size: 'river' } }),
  ]);
  const { problems } = assignLevels(tiles);
  const conflict = problems.find((p) => p.kind === 'level-conflict');
  assert.ok(conflict, 'a two-tile branch and a one-tile branch cannot both arrive at inletZ');
  assert.match(conflict.message, /Lengthen the shorter branch/);
});

test('a river that loops back on itself is caught', () => {
  const tiles = new Map([
    mk(0, 0, { E: { type: 'out', size: 'river' }, N: { type: 'in', size: 'river' } }),
    mk(1, 0, { W: { type: 'in', size: 'river' }, N: { type: 'out', size: 'river' } }),
    mk(1, 1, { S: { type: 'in', size: 'river' }, W: { type: 'out', size: 'river' } }),
    mk(0, 1, { E: { type: 'in', size: 'river' }, S: { type: 'out', size: 'river' } }),
  ]);
  const { problems } = assignLevels(tiles);
  assert.ok(problems.some((p) => p.kind === 'cycle'), 'water cannot flow uphill back to where it started');
});

test('an outlet facing a neighbour that is not expecting it is an error', () => {
  const tiles = new Map([mk(0, 0, { E: { type: 'out', size: 'river' } }), mk(1, 0, {})]);
  const { problems } = assignLevels(tiles);
  assert.ok(problems.some((p) => p.kind === 'unmatched-port'));
});

test('mismatched river sizes across a seam are an error', () => {
  const tiles = new Map([
    mk(0, 0, { E: { type: 'out', size: 'wide' } }),
    mk(1, 0, { W: { type: 'in', size: 'creek' } }),
  ]);
  const { problems } = assignLevels(tiles);
  assert.ok(problems.some((p) => p.kind === 'size-mismatch'));
});

test('a 2 mm outlet is flagged as thin, and raising it keeps the same fall', () => {
  const thin = check(makeContract({ outletZMM: 2 }));
  assert.ok(thin.some((p) => p.severity === 'warning' && /thin/.test(p.message)));
  const thick = check(makeContract({ outletZMM: 5 }));
  assert.equal(thick.filter((p) => p.severity === 'warning').length, 0);
  assert.equal(makeContract({ outletZMM: 5 }).inletZMM - 5, 10);
});

test('an overlapping seam is refused when there is no plate to cut the shelf from', () => {
  const g = seamGeometry(makeContract({ seam: 'overlap', outletZMM: 2 }));
  assert.equal(g.ok, false);
  assert.match(g.why, /Raise outletZMM/);
  const ok = seamGeometry(makeContract({ seam: 'overlap', outletZMM: 6 }));
  assert.equal(ok.ok, true);
  assert.ok(ok.rebateDepthMM > ok.tongueThickMM, 'the rebate clears the shelf');
});

test('land below the inlet is refused — a river with no banks runs out of the side', () => {
  const bad = check(makeContract({ edgeLandMM: 8, outletZMM: 2 }));
  assert.ok(bad.some((p) => p.severity === 'error' && /banks/.test(p.message)));
});
