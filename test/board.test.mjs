import { test } from 'node:test';
import assert from 'node:assert/strict';
import { solveBoard, describeBoard, plan, boardFromSpec, turnTile, turnEdge, facingEdge, normRot,
         placedSignatures, countBoard } from '../lib/board.js';
import { makeContract, edgeSignature, EDGES } from '../lib/contract.js';
import { cornerLattice } from '../lib/build.js';
import { EXAMPLE_SPEC } from '../lib/example.js';

// The blueprint's numbers: 12 in, 2 out, a 10 mm fall, so a tile one riser
// below its neighbour takes the river at exactly the height it left.
const C = makeContract({ outletZMM: 2, fallMM: 10 });

const flat = (h) => ({ sw: h, se: h, nw: h, ne: h });
const river = (edges, rim = 20, extra = {}) => ({ edges, corners: flat(rim), ...extra });
const out = (size = 'creek') => ({ type: 'out', size });
const inn = (size = 'creek') => ({ type: 'in', size });

/** A pair, A west of B, water running east out of A into B. */
function pair({ riserA = 0, riserB = 0, rimA = 20, rimB = 20, a = { E: out() }, b = { W: inn(), E: out() }, fed = true }) {
  return solveBoard({
    contract: C,
    placements: [
      { col: 0, row: 0, riserMM: riserA, tile: river(a, rimA) },
      { col: 1, row: 0, riserMM: riserB, tile: river(b, rimB) },
    ],
    springs: fed ? [{ id: '0,0' }] : [],
  });
}
const seamAB = (board) => board.seams.find((s) => s.tiles.length === 2 && s.edge === 'E');
const tile = (board, label) => board.tiles.find((t) => t.label === label);

/* ----------------------------------------------- §3.2: where the next tile stands */

test('one riser lower: the river runs across — the designed case', () => {
  const b = pair({ riserA: 10, riserB: 0 });
  const s = seamAB(b);
  assert.equal(s.kind, 'flow');
  assert.ok(s.wet, 'water crosses');
  assert.equal(tile(b, 'A1').ponds, false);
  assert.ok(tile(b, 'B1').wet);
});

test('two risers lower: a 10 mm waterfall', () => {
  const s = seamAB(pair({ riserA: 20, riserB: 0 }));
  assert.equal(s.kind, 'waterfall');
  assert.equal(s.dropMM, 10);
  assert.ok(s.wet);
});

test('level with this one: a 10 mm dam that ponds to 12 — a 20 mm rim holds it', () => {
  const b = pair({ riserA: 0, riserB: 0, rimA: 20 });
  const s = seamAB(b);
  assert.equal(s.kind, 'dam');
  assert.equal(s.pondToMM, 12);
  assert.equal(s.holds, true);
  assert.ok(s.wet, 'it fills, then runs on over the dam');
  assert.ok(tile(b, 'A1').ponds);
  assert.equal(tile(b, 'A1').overtops, false);
  assert.ok(tile(b, 'B1').wet, 'the water carries on into the tall tile');
});

test('level with this one: the same 10 mm dam overtops a 10 mm rim', () => {
  const b = pair({ riserA: 0, riserB: 0, rimA: 10 });
  const s = seamAB(b);
  assert.equal(s.kind, 'dam');
  assert.equal(s.holds, false);
  assert.equal(s.wouldPondToMM, 12);
  assert.equal(tile(b, 'A1').overtops, true);
  assert.equal(tile(b, 'A1').levelMM, 10, 'the pond stops at the rim');
  assert.equal(tile(b, 'B1').wet, false, 'nothing gets past a dam it cannot fill');
});

test('one riser higher: a 20 mm dam ponds to 22 — 20 overtops, 30 holds', () => {
  const low = pair({ riserA: 0, riserB: 10, rimA: 20 });
  assert.equal(seamAB(low).kind, 'dam');
  assert.equal(seamAB(low).wouldPondToMM, 22);
  assert.equal(tile(low, 'A1').overtops, true);
  const high = pair({ riserA: 0, riserB: 10, rimA: 30 });
  assert.equal(seamAB(high).pondToMM, 22);
  assert.equal(seamAB(high).holds, true);
  assert.equal(tile(high, 'A1').overtops, false);
});

test('land across the seam: a dam to that edge\'s height, overtopping at this tile\'s own', () => {
  const over = pair({ rimA: 20, rimB: 30, b: {} });
  const s = seamAB(over);
  assert.equal(s.kind, 'blocked');
  assert.equal(s.wouldPondToMM, 30, 'it would have to get over the 30 mm bank');
  assert.equal(tile(over, 'A1').overtops, true);
  assert.equal(tile(over, 'A1').levelMM, 20, 'and goes over its own 20 mm rim first');
  const held = pair({ rimA: 40, rimB: 30, b: {} });
  assert.equal(seamAB(held).pondToMM, 30);
  assert.equal(seamAB(held).holds, true);
  assert.ok(tile(held, 'B1').wet, 'over the bank, the water is on the next tile');
});

test('an outlet above the land across it pours down onto it', () => {
  const s = seamAB(pair({ riserA: 30, rimB: 20, b: {} }));
  assert.equal(s.kind, 'spills');
  assert.equal(s.dropMM, 12, 'outlet at 32 over land at 20');
  assert.ok(s.wet);
});

/* ------------------------------------------------------------- §4.2, the rest */

test('an outlet facing nothing drains into the tray', () => {
  const b = solveBoard({ contract: C, placements: [{ col: 0, row: 0, tile: river({ E: out() }) }], springs: [{ id: '0,0' }] });
  const s = b.seams.find((x) => x.kind === 'drains');
  assert.ok(s, 'a drain seam');
  assert.equal(s.edge, 'E');
  assert.ok(s.wet);
  assert.equal(b.tiles[0].ponds, false);
});

test('an inlet fed by nothing is a dry bed, and a spring on it is not', () => {
  const dry = solveBoard({ contract: C, placements: [{ col: 0, row: 0, tile: river({ W: inn(), E: out() }) }] });
  assert.equal(dry.seams.find((x) => x.edge === 'W').kind, 'dry');
  assert.equal(dry.tiles[0].wet, false);
  const fed = solveBoard({ contract: C, placements: [{ col: 0, row: 0, tile: river({ W: inn(), E: out() }) }],
    springs: [{ id: '0,0', edge: 'W' }] });
  assert.equal(fed.seams.find((x) => x.edge === 'W').kind, 'spring');
  assert.ok(fed.tiles[0].wet);
});

test('a river bed with nothing upstream is dry all the way down, which is fine', () => {
  const b = pair({ riserA: 10, fed: false });
  const s = seamAB(b);
  assert.equal(s.kind, 'flow', 'it is still a flow, geometrically');
  assert.equal(s.wet, false);
  assert.ok(countBoard(b).dry >= 1);
});

test('a wide port meeting a narrow one spreads, and is not refused', () => {
  const s = seamAB(pair({ riserA: 10, a: { E: out('bay') }, b: { W: inn('creek') } }));
  assert.equal(s.kind, 'flow');
  assert.equal(s.spreads, true);
  assert.deepEqual(s.widths, [40, 10]);
  const wider = seamAB(pair({ riserA: 10, a: { E: out('creek') }, b: { W: inn('bay') } }));
  assert.equal(wider.spreads, false, 'into a wider channel is just a river');
});

test('a pond above its own inlet is flagged as backing up into the tile behind', () => {
  // U feeds A, A is dammed one riser by B: A ponds to 22, above its 12 mm inlet.
  const b = solveBoard({
    contract: C,
    placements: [
      { col: 0, row: 0, riserMM: 10, tile: river({ E: out() }, 30) },
      { col: 1, row: 0, riserMM: 0, tile: river({ W: inn(), E: out() }, 30) },
      { col: 2, row: 0, riserMM: 10, tile: river({ W: inn(), E: out() }, 30) },
    ],
    springs: [{ id: '0,0' }],
  });
  const A = tile(b, 'B1');
  assert.equal(A.levelMM, 22);
  assert.deepEqual(A.backsUp, ['W']);
  assert.ok(describeBoard(b).some((x) => x.kind === 'backs-up' && /backs up into A1/.test(x.text)));
});

test('a ring of tiles at one level is a chain of dams, not an error', () => {
  // A river round a 2x2 block: A1 -> B1 -> B2 -> A2 -> A1, every tile on the floor.
  const placements = [
    { col: 0, row: 0, tile: river({ E: out(), N: inn() }) },
    { col: 1, row: 0, tile: river({ W: inn(), N: out() }) },
    { col: 1, row: 1, tile: river({ S: inn(), W: out() }) },
    { col: 0, row: 1, tile: river({ E: inn(), S: out() }) },
  ];
  const b = solveBoard({ contract: C, placements, springs: [{ id: '0,0' }] });
  const water = b.seams.filter((s) => s.tiles.length === 2);
  assert.equal(water.length, 4);
  for (const s of water) assert.equal(s.kind, 'dam', `${s.id} is a ${s.kind}`);
  assert.equal(b.order.length, 4, 'the water goes all the way round');
});

test('two outlets facing: the higher falls into the lower channel, level ones go nowhere', () => {
  const hi = pair({ riserA: 20, riserB: 0, b: { W: out() } });
  const s = seamAB(hi);
  assert.equal(s.kind, 'head-on');
  assert.equal(s.from, 'A1');
  assert.ok(tile(hi, 'B1').wet, 'the lower tile takes the water');
  const level = pair({ riserA: 0, riserB: 0, b: { W: out() } });
  assert.equal(seamAB(level).from, null);
  assert.equal(tile(level, 'A1').overtops, true, 'with no way out it fills to its rim');
});

test('two inlets facing are both dry', () => {
  const s = seamAB(pair({ a: { E: inn() }, b: { W: inn() } }));
  assert.equal(s.kind, 'dry');
  assert.equal(s.wet, false);
});

test('two land edges a riser apart are a cliff, and level ones are not', () => {
  const step = pair({ riserA: 10, a: {}, b: {} });
  assert.equal(seamAB(step).kind, 'cliff');
  assert.equal(seamAB(step).landStepMM, 10);
  assert.equal(seamAB(pair({ a: {}, b: {} })).kind, 'plane');
});

test('every sentence is a sentence, and the board says what the water does', () => {
  const b = pair({ riserA: 0, riserB: 0, rimA: 10 });
  const said = describeBoard(b);
  assert.ok(said.every((x) => typeof x.text === 'string' && /\.$/.test(x.text)));
  assert.ok(said.some((x) => x.kind === 'overtops' && /runs over its .* side into the tray/.test(x.text)));
});

/* ---------------------------------------------------------------- rotation */

test('a turn moves every edge one place clockwise, and turning back undoes it', () => {
  assert.equal(turnEdge('N', 1), 'E');
  assert.equal(turnEdge('W', 1), 'N');
  assert.equal(turnEdge('N', 2), 'S');
  assert.equal(normRot(-1), 3);
  for (const e of EDGES) for (let r = 0; r < 4; r++) assert.equal(facingEdge(turnEdge(e, r), r), e);
});

test('a placed tile\'s four signatures are the design\'s, rotated', () => {
  const c = makeContract({ outletZMM: 6 });
  const design = {
    edges: { N: { type: 'in', size: 'creek' }, S: { type: 'out', size: 'stream' }, E: { type: 'in', size: 'creek' } },
    corners: { sw: 20, se: 30, nw: 40, ne: 50 },
    fallMM: 20,
  };
  for (let rot = 0; rot < 4; rot++) {
    const placed = placedSignatures(c, design, rot, 30);
    for (const e of EDGES) {
      assert.equal(placed[turnEdge(e, rot)], edgeSignature(c, design, e, 3), `rot ${rot}: ${e} should face ${turnEdge(e, rot)}`);
    }
  }
});

test('turning a tile turns its corners with it', () => {
  const t = turnTile({ edges: {}, corners: { sw: 1, se: 2, nw: 3, ne: 4 } }, 1);
  assert.deepEqual(t.corners, { nw: 1, sw: 2, ne: 3, se: 4 });
});

test('turning the middle of a river round makes the water do something else', () => {
  const placements = (rot) => [
    { col: 0, row: 0, riserMM: 20, tile: river({ E: out() }, 30) },
    { col: 1, row: 0, riserMM: 10, rot, tile: river({ W: inn(), E: out() }, 30) },
    { col: 2, row: 0, riserMM: 0, tile: river({ W: inn() }, 30) },
  ];
  const straight = solveBoard({ contract: C, placements: placements(0), springs: [{ id: '0,0' }] });
  assert.deepEqual(straight.seams.filter((s) => s.tiles.length === 2).map((s) => s.kind), ['flow', 'flow']);
  const turned = solveBoard({ contract: C, placements: placements(2), springs: [{ id: '0,0' }] });
  const kinds = turned.seams.filter((s) => s.tiles.length === 2).map((s) => s.kind);
  assert.deepEqual(kinds, ['head-on', 'dry'], 'turned round, its outlet faces upstream and its inlet faces an inlet');
});

/* ------------------------------------------------------ the map-style spec */

test('the example map reads as springs, a waterfall, two flows and a drain', () => {
  const p = plan(structuredClone(EXAMPLE_SPEC));
  const kinds = p.sentences.map((s) => s.kind);
  assert.deepEqual(kinds, ['spring', 'waterfall', 'flow', 'flow', 'drains']);
  assert.equal(p.sentences[1].text, 'B3 falls 20 mm into B2.');
  assert.equal(p.counts.ponds, 0);
  assert.equal(p.placements.length, 9);
});

test('dragging one tile up a riser flips its seams: B1 up one plate dams B2', () => {
  const spec = structuredClone(EXAMPLE_SPEC);
  const before = plan(spec).seams.find((s) => s.id === 'B1|N');
  assert.equal(before.kind, 'flow');
  spec.levels = { '1,0': 1 };
  const after = plan(spec);
  const s = after.seams.find((x) => x.id === 'B1|N');
  assert.equal(s.kind, 'dam');
  assert.equal(s.from, 'B2');
  assert.equal(s.pondToMM, 10 + 6 + 10, 'B1\'s inlet, one plate up');
  assert.ok(after.sentences.some((x) => x.kind === 'dam' && /^B2 meets B1 10 mm higher/.test(x.text)));
});

test('a turn in the spec is read by the board and changes nothing the build reads', () => {
  const spec = structuredClone(EXAMPLE_SPEC);
  spec.rot = { '1,1': 1 };
  const p = plan(spec);
  assert.equal(p.placements.find((x) => x.label === 'B2').rot, 1);
  assert.ok(p.counts.overtops >= 1 || p.counts.blocked >= 1, 'B2 turned blocks the river');
  // The design checker sees the design, which a turn does not touch.
  const designErrors = (s) => boardFromSpec(s).design.filter((d) => d.severity === 'error').length;
  assert.equal(designErrors(spec), designErrors(EXAMPLE_SPEC));
});

test('springs land where the build would put them', () => {
  const p = boardFromSpec(structuredClone(EXAMPLE_SPEC));
  assert.deepEqual(p.springs.map((s) => `${s.id}:${s.edge}`).sort(), ['1,2:N', '2,1:E']);
  const off = boardFromSpec({ ...structuredClone(EXAMPLE_SPEC), fountains: { auto: false, place: [{ tile: 'B3', edge: 'N' }] } });
  assert.deepEqual(off.springs.map((s) => `${s.id}:${s.edge}`), ['1,2:N']);
  const none = boardFromSpec({ ...structuredClone(EXAMPLE_SPEC), fountains: undefined });
  assert.equal(none.springs.length, 0, 'no fountains, no springs: the rivers are dry');
});

test('the board never throws: a river that jumps is a design error, not a crash', () => {
  const p = plan({ cols: 2, rows: 1, rivers: [{ path: [[0, 0], [2, 0]] }] });
  assert.ok(p.design.some((d) => d.severity === 'error' && /edge-adjacent/.test(d.message)));
  assert.equal(p.placements.length, 2);
});

test('without ground the rims sit at their floor; a raised corner lifts four tiles at once', () => {
  const c = makeContract({ edgeLandMM: 22 });
  const levels = new Map([['0,0', 0], ['1,0', 0], ['0,1', 0], ['1,1', 2]]);
  const g = cornerLattice(null, c, levels, { cols: 2, rows: 2, reliefMM: 40 });
  assert.equal(g.get('0,0'), 22, 'flat ground: the land datum');
  assert.equal(g.get('1,1'), 42, 'the middle corner clears the tile two plates up');
  const raised = cornerLattice(null, c, levels, { cols: 2, rows: 2, reliefMM: 40, raise: { '0,0': 10 } });
  assert.equal(raised.get('0,0'), 32);
  assert.equal(raised.get('1,0'), 22, 'only the corner asked for');
  const p = plan({ cols: 2, rows: 2, contract: { edgeLandMM: 22 }, cornerRaise: { '1,1': 10 } });
  const at = (label) => p.placements.find((x) => x.label === label).tile.corners;
  assert.equal(at('A1').ne, 32, 'the middle corner, a plate up');
  assert.equal(at('B2').sw, 32, 'the same corner, read from the other side');
  assert.equal(at('A2').se, 32);
  assert.equal(at('B1').nw, 32);
  assert.equal(at('A1').sw, 22, 'and nothing else moved');
  assert.equal(p.seams.filter((s) => s.kind === 'cliff').length, 0, 'every seam still mates');
});
