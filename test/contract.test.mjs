import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeContract, edgeProfile, tileEdgeProfile, seamMismatch, classifySeam, assignLevels, check,
         seamGeometry, SIZES, SIZE_LADDER, FALLS, sizeFor, confluenceSize, widthForFall,
         portFloor, fallOf, edgeSignature } from '../lib/contract.js';

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
  assert.ok(m.channel < 1e-9);
  assert.ok(m.land < 1e-9, 'the corner lattice puts the land at one world height, so it meets too');
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
  assert.ok(m.channel < 1e-9);
  assert.ok(m.land < 1e-9);
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

test('two tributaries of different lengths are FINE — their sources just sit higher', () => {
  // This was reported as a conflict by the first solver, which pinned every
  // source at level zero and then found they disagreed. They do not. A
  // tributary that has run one tile and one that has run two simply start at
  // different heights, which is what tributaries look like.
  const tiles = new Map([
    mk(0, 0, { E: { type: 'out', size: 'creek' } }),
    mk(1, 0, { W: { type: 'in', size: 'creek' }, E: { type: 'out', size: 'creek' } }),
    mk(2, 0, { W: { type: 'in', size: 'creek' }, N: { type: 'in', size: 'creek' } }),
    mk(2, 1, { S: { type: 'out', size: 'creek' } }),
  ]);
  const { levels, problems } = assignLevels(tiles, makeContract());
  assert.equal(problems.filter((p) => p.severity === 'error').length, 0);
  assert.equal(levels.get('2,0'), 0, 'the confluence is lowest');
  assert.equal(levels.get('0,0'), 2, 'the long branch starts two plates up');
  assert.equal(levels.get('2,1'), 1, 'the short one starts one plate up');
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


// ---------------------------------------------------------------------------
// Variable falls, the width ladder, and seams that are features not faults

test('a tile falls by whatever it declares, in whole plates', () => {
  const c = makeContract();
  for (const f of FALLS) {
    assert.equal(portFloor(c, { fallMM: f }, 'in'), c.outletZMM + f);
    assert.equal(portFloor(c, { fallMM: f }, 'out'), c.outletZMM);
  }
});

test('a fall off the ladder is snapped onto it rather than accepted', () => {
  const c = makeContract();
  assert.equal(fallOf(c, { fallMM: 23 }), 20);
  assert.equal(fallOf(c, { fallMM: 5 }), 10, 'below the gentlest');
  assert.equal(fallOf(c, { fallMM: 900 }), 50, 'above the steepest');
});

test('the width ladder is whole centimetres, 10 to 50', () => {
  assert.deepEqual(SIZE_LADDER.map((s) => s.widthMM), [10, 20, 30, 40, 50]);
  assert.equal(sizeFor(30).id, 'river');
  assert.equal(sizeFor('creek').widthMM, 10);
  assert.equal(sizeFor(40).kind, 'water-body', '40 and 50 are bays and fjords, not rivers');
  assert.equal(sizeFor(50).kind, 'water-body');
  assert.equal(sizeFor(30).kind, 'channel');
});

test('confluences widen by quadrature — the two cases from the brief', () => {
  assert.equal(confluenceSize(['creek', 'creek']).widthMM, 20, 'two 10 mm inlets -> 20 mm out');
  assert.equal(confluenceSize(['creek', 'creek', 'creek']).widthMM, 20, 'three 10 mm inlets -> 20 mm out');
});

test('confluence widening is monotone and never narrows', () => {
  assert.equal(confluenceSize(['creek']).widthMM, 10, 'one in, same out');
  assert.ok(confluenceSize(['stream', 'stream']).widthMM > 20);
  assert.ok(confluenceSize(['river', 'river']).widthMM >= 30);
  for (const a of SIZE_LADDER) {
    for (const b of SIZE_LADDER) {
      assert.ok(confluenceSize([a.id, b.id]).widthMM >= Math.max(a.widthMM, b.widthMM),
        `${a.id}+${b.id} must not come out narrower than either`);
    }
  }
});

test('a steeper tile carries the same water in a narrower channel', () => {
  const c = makeContract();
  const gentle = widthForFall('river', 10, c).widthMM;
  const steep = widthForFall('river', 50, c).widthMM;
  assert.equal(gentle, 30, 'the gentlest fall is the reference, so nothing changes');
  assert.ok(steep < gentle, `a 25% gradient should need less than ${gentle} mm, got ${steep}`);
});

test('two tiles at one height make a plane', () => {
  const c = makeContract();
  const flat = (v) => ({ sw: v, se: v, nw: v, ne: v });
  const A = { col: 0, row: 0, edges: {}, corners: flat(30) };
  const B = { col: 1, row: 0, edges: {}, corners: flat(30) };
  const r = classifySeam(c, A, 0, B, 0, 'E');
  assert.equal(r.kind, 'plane');
  assert.ok(r.flush);
});

test('a 50 mm edge against a 10 mm edge is a cliff, not an error', () => {
  const c = makeContract();
  const flat = (v) => ({ sw: v, se: v, nw: v, ne: v });
  const high = { col: 0, row: 0, edges: {}, corners: flat(50) };
  const low = { col: 1, row: 0, edges: {}, corners: flat(10) };
  const r = classifySeam(c, high, 0, low, 0, 'E');
  assert.equal(r.kind, 'cliff');
  assert.equal(r.landStepMM, 40, 'positive means the upstream side is higher');
});

test('a river crossing a step is a waterfall', () => {
  const c = makeContract();
  const flat = (v) => ({ sw: v, se: v, nw: v, ne: v });
  // A sits 3 plates up and its outlet is 2 mm above its own base, so the
  // water leaves at 32 mm. B falls only 10, so its inlet is 12 mm up at
  // level 0. The water drops 20 mm across the seam.
  const A = { col: 0, row: 0, edges: { E: { type: 'out', size: 'river' } }, corners: flat(60 - 30) };
  const B = { col: 1, row: 0, edges: { W: { type: 'in', size: 'river' } }, fallMM: 10, corners: flat(60) };
  const r = classifySeam(c, A, 3, B, 0, 'E');
  assert.equal(r.kind, 'waterfall');
  assert.equal(r.waterStepMM, 20);
});

test('the same step the other way round is a dam', () => {
  const c = makeContract();
  const flat = (v) => ({ sw: v, se: v, nw: v, ne: v });
  const A = { col: 0, row: 0, edges: { E: { type: 'out', size: 'river' } }, corners: flat(60) };
  const B = { col: 1, row: 0, edges: { W: { type: 'in', size: 'river' } }, fallMM: 10, corners: flat(60 - 30) };
  const r = classifySeam(c, A, 0, B, 3, 'E');
  assert.equal(r.kind, 'dam');
  assert.ok(r.waterStepMM < 0, 'negative means the downstream side is higher, so it ponds');
});

test('a 30 mm fall with the tile 3 plates lower runs level — no step at all', () => {
  const c = makeContract();
  const flat = (v) => ({ sw: v, se: v, nw: v, ne: v });
  const A = { col: 0, row: 0, edges: { E: { type: 'out', size: 'river' } }, corners: flat(60 - 30) };
  const B = { col: 1, row: 0, edges: { W: { type: 'in', size: 'river' } }, fallMM: 30, corners: flat(60) };
  const r = classifySeam(c, A, 3, B, 0, 'E');
  assert.equal(r.kind, 'plane');
  assert.equal(r.waterStepMM, 0);
});

test('plate levels follow each tile’s own fall, not a hop count', () => {
  const mk = (col, row, edges, fallMM) => [`${col},${row}`, { col, row, edges, fallMM }];
  const c = makeContract();
  const tiles = new Map([
    mk(0, 0, { E: { type: 'out', size: 'river' } }, 10),
    mk(1, 0, { W: { type: 'in', size: 'river' }, E: { type: 'out', size: 'river' } }, 30),
    mk(2, 0, { W: { type: 'in', size: 'river' } }, 20),
  ]);
  const { levels, problems } = assignLevels(tiles, c);
  assert.equal(problems.filter((p) => p.severity === 'error').length, 0);
  // B falls 30 so it sits 3 plates under A; C falls 20 so 2 more under B.
  assert.equal(levels.get('0,0'), 5);
  assert.equal(levels.get('1,0'), 2);
  assert.equal(levels.get('2,0'), 0);
});

test('a channel that splits and rejoins must drop the same both ways round', () => {
  // The only shape that really constrains anything: an island. Going round
  // the loop has to sum to zero, and here the north channel falls 30 where
  // the south one falls 10.
  const mkf = (col, row, edges, fallMM) => [`${col},${row}`, { col, row, edges, fallMM }];
  const island = (northFall) => new Map([
    mkf(0, 0, { E: { type: 'out', size: 'creek' }, N: { type: 'out', size: 'creek' } }, 10),
    mkf(1, 0, { W: { type: 'in', size: 'creek' }, N: { type: 'out', size: 'creek' } }, 10),
    mkf(0, 1, { S: { type: 'in', size: 'creek' }, E: { type: 'out', size: 'creek' } }, northFall),
    mkf(1, 1, { S: { type: 'in', size: 'creek' }, W: { type: 'in', size: 'creek' } }, 10),
  ]);
  const bad = assignLevels(island(30), makeContract());
  const conflict = bad.problems.find((p) => p.kind === 'level-conflict');
  assert.ok(conflict, 'a 40 mm way round and a 20 mm way round cannot both be right');
  assert.match(conflict.message, /splits and rejoins/);

  const good = assignLevels(island(10), makeContract());
  assert.equal(good.problems.filter((p) => p.severity === 'error').length, 0,
    'matching the two channels resolves it');
  assert.equal(good.levels.get('1,1'), 0);
  assert.equal(good.levels.get('0,0'), 2);
});

test('an edge signature says what it will mate with', () => {
  const c = makeContract();
  const spec = { col: 0, row: 0, edges: { E: { type: 'out', size: 'river' } },
                 corners: { sw: 20, se: 30, nw: 20, ne: 40 } };
  assert.equal(edgeSignature(c, spec, 'W', 0), 'land 20/20');
  assert.match(edgeSignature(c, spec, 'E', 0), /^out river@2 30\/40$/);
  assert.match(edgeSignature(c, spec, 'E', 2), /^out river@22 50\/60$/, 'a stack raises the whole signature');
});

test('a waterfall is a waterfall from either side of the seam', () => {
  // The sign has to come from the ports, not from the order the tiles are
  // passed in. Reading the same join the other way round reported every
  // north-flowing waterfall as a dam.
  const c = makeContract();
  const flat = (v) => ({ sw: v, se: v, nw: v, ne: v });
  const up = { col: 0, row: 1, edges: { S: { type: 'out', size: 'river' } }, corners: flat(60 - 30) };
  const down = { col: 0, row: 0, edges: { N: { type: 'in', size: 'river' } }, fallMM: 10, corners: flat(60) };
  const fromDownstream = classifySeam(c, down, 0, up, 3, 'N');
  const fromUpstream = classifySeam(c, up, 3, down, 0, 'S');
  assert.equal(fromDownstream.kind, 'waterfall');
  assert.equal(fromUpstream.kind, 'waterfall');
  assert.equal(fromDownstream.waterStepMM, fromUpstream.waterStepMM);
  assert.equal(fromDownstream.waterStepMM, 20);
});

test('a bay or fjord mouth is an opening, a river is a channel', () => {
  for (const id of ['creek', 'stream', 'river']) assert.equal(SIZES[id].kind, 'channel');
  for (const id of ['bay', 'fjord']) assert.equal(SIZES[id].kind, 'water-body');
});
