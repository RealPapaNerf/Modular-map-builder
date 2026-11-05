import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as ops from '../app/specops.js';
import { EXAMPLE_SPEC } from '../lib/example.js';
import { plan } from '../lib/board.js';

// What the editor does when the example is drawn by hand: the place tool
// adds the cells, the tile canvas draws the ridge and the volcano (snapped to
// whole millimetres), the river tool draws two strokes, the fall tool and the
// spring tool click, and the inspector types the numbers that are numbers.
function drawTheExample() {
  const s = ops.blankSpec();
  ops.growBoard(s, 'E'); ops.growBoard(s, 'E');
  ops.growBoard(s, 'N'); ops.growBoard(s, 'N');

  Object.assign(s, { name: 'glacier-valley', seed: 7, meshMM: 0.9, metresPerMM: 25, spineHeightMM: 60 });
  ops.setPath(s, 'glacier.cycles', 30);
  ops.setPath(s, 'glacier.elaSwingMM', 18);
  ops.setPath(s, 'contract', { tileMM: 200, plateMM: 10, outletZMM: 6, edgeLandMM: 22 });

  ops.setSpine(s, [{ x: 60, y: 510 }, { x: 300, y: 360 }, { x: 540, y: 480 }]);
  const v = ops.addVolcano(s, { x: 468, y: 132 }, 90);
  Object.assign(s.volcanoes[v], { heightMM: 32, breachAzimuthDeg: 210 });

  // From above B3, straight down and off the bottom of the board.
  const main = ops.addRiver(s, ops.strokeToRiver(s, [{ x: 300, y: 650 }, { x: 302, y: 300 }, { x: 299, y: -40 }]));
  Object.assign(s.rivers[main], { name: 'main', sinkSize: 'bay' });
  // From off the east edge into C2, and on into B2 where it joins.
  const trib = ops.addRiver(s, ops.strokeToRiver(s, [{ x: 640, y: 290 }, { x: 450, y: 300 }, { x: 310, y: 305 }]));
  s.rivers[trib].name = 'trib';

  ops.setFall(s, 1, 2, 40); ops.setFall(s, 1, 1, 30); ops.setFall(s, 1, 0, 10); ops.setFall(s, 2, 1, 20);
  ops.setWaterfall(s, 1, 1, 20);

  const conifer = ops.addWoodLayer(s, 'conifer');
  Object.assign(s.canopy[conifer], { density: 0.62, minZMM: 34, maxZMM: 96, thinningMM: 18 });
  const broad = ops.addWoodLayer(s, 'deciduous');
  Object.assign(s.canopy[broad], { maxZMM: 40, thinningMM: 10 });

  for (const [k, v2] of Object.entries({ fillHollows: true, depthMM: 5, shoreMM: 10, profile: 'dish' })) ops.setPath(s, `lakes.${k}`, v2);
  ops.toggleSpring(s, 'B3', 'N');
  ops.toggleSpring(s, 'C2', 'E');
  ops.setPath(s, 'fountains.tubeOdMM', 12.7);
  ops.setPath(s, 'fountains.poolRadiusMM', 16);
  return s;
}

test('the example map can be drawn from a blank board with the tools alone', () => {
  assert.deepEqual(drawTheExample(), structuredClone(EXAMPLE_SPEC));
});

test('the drawn example is read by the board exactly as the shipped one is', () => {
  const a = plan(drawTheExample());
  const b = plan(structuredClone(EXAMPLE_SPEC));
  assert.deepEqual(a.sentences, b.sentences);
});

test('labels go both ways, past Z', () => {
  assert.deepEqual(ops.parseLabel('B2'), { col: 1, row: 1 });
  assert.deepEqual(ops.parseLabel('AA10'), { col: 26, row: 9 });
  assert.equal(ops.labelOf(26, 9), 'AA10');
  assert.equal(ops.parseLabel('nope'), null);
});

test('board mm and world fractions round-trip, and land on round numbers', () => {
  const s = { cols: 3, rows: 3 };
  assert.deepEqual(ops.toWorld(s, { x: 60, y: 510 }), [0.1, 0.85]);
  assert.deepEqual(ops.toBoard(s, [0.5, 0.6]), { x: 300, y: 360 });
});

test('a stroke that cuts a corner still gives edge-adjacent tiles', () => {
  const s = { cols: 3, rows: 3 };
  const cells = ops.strokeCells(s, [{ x: 100, y: 100 }, { x: 500, y: 500 }]);
  for (let i = 1; i < cells.length; i++) {
    const d = Math.abs(cells[i][0] - cells[i - 1][0]) + Math.abs(cells[i][1] - cells[i - 1][1]);
    assert.equal(d, 1, `${cells[i - 1]} to ${cells[i]} is not a step across one edge`);
  }
  assert.deepEqual(cells[0], [0, 0]);
  assert.deepEqual(cells[cells.length - 1], [2, 2]);
});

test('a stroke from off the board brings the river in from that side, and off it drains', () => {
  const s = { cols: 3, rows: 3 };
  assert.deepEqual(ops.strokeToRiver(s, [{ x: -30, y: 100 }, { x: 650, y: 100 }]),
    { path: [[0, 0], [1, 0], [2, 0]], sourceEdge: 'W', sinkEdge: 'E' });
  assert.deepEqual(ops.strokeToRiver(s, [{ x: 100, y: 100 }, { x: 300, y: 100 }]),
    { path: [[0, 0], [1, 0]], sourceEdge: null, sinkEdge: null });
  assert.equal(ops.strokeToRiver(s, [{ x: 100, y: 100 }, { x: 120, y: 110 }]), null, 'one tile, no ports, is not a river');
});

test('doubling back over a stroke rubs the loop out', () => {
  const s = { cols: 3, rows: 3 };
  const r = ops.strokeToRiver(s, [{ x: 100, y: 100 }, { x: 500, y: 100 }, { x: 500, y: 300 }, { x: 300, y: 300 }, { x: 300, y: 100 }, { x: 300, y: 500 }]);
  assert.deepEqual(r.path, [[0, 0], [1, 0], [1, 1], [1, 2]]);
});

test('growing the board west moves every reference east by one, features and all', () => {
  const s = structuredClone(EXAMPLE_SPEC);
  s.lakes.place = [{ tile: 'B2', atMM: [50, 50] }];
  s.rot = { '1,1': 1 };
  ops.growBoard(s, 'W');
  assert.equal(s.cols, 4);
  assert.deepEqual(s.rivers[0].path, [[2, 2], [2, 1], [2, 0]]);
  assert.deepEqual(Object.keys(s.falls).sort(), ['2,0', '2,1', '2,2', '3,1']);
  assert.equal(s.lakes.place[0].tile, 'C2');
  assert.deepEqual(s.rot, { '2,1': 1 });
  // The volcano stays over the same ground: 0.78 of three tiles is 2.34 tiles in.
  assert.ok(Math.abs(s.volcanoes[0].at[0] * 4 - (0.78 * 3 + 1)) < 1e-5);
  // And the board reads the same, one column further east.
  const was = structuredClone(EXAMPLE_SPEC);
  was.rot = { '1,1': 1 };
  const kinds = (p) => p.sentences.map((x) => x.kind).join();
  assert.equal(kinds(plan(s)), kinds(plan(was)));
  delete s.rot;
  assert.equal(kinds(plan(s)), 'spring,waterfall,flow,flow,drains');
});

test('taking a column off cuts the river, and the cut ends come in from and drain off the edge', () => {
  const s = structuredClone(EXAMPLE_SPEC);
  ops.shrinkBoard(s, 'E');
  assert.equal(s.cols, 2);
  const trib = s.rivers.find((r) => r.name === 'trib');
  assert.deepEqual(trib.path, [[1, 1]]);
  assert.equal(trib.sourceEdge, 'E', 'the tributary now comes in from off the map');
  assert.equal(trib.size, 'creek');
  assert.equal(s.falls['2,1'], undefined);
  const s2 = structuredClone(EXAMPLE_SPEC);
  ops.shrinkBoard(s2, 'S');
  const main = s2.rivers.find((r) => r.name === 'main');
  assert.deepEqual(main.path, [[1, 1], [1, 0]]);
  assert.equal(main.sinkEdge, 'S', 'the main river drains off the new south edge');
  assert.equal(main.sinkSize, undefined, 'and its width is worked out again');
  assert.equal(s2.rows, 2);
});

test('a river cut in the middle becomes two', () => {
  const s = { cols: 3, rows: 2, rivers: [{ name: 'r', size: 'creek', path: [[0, 0], [0, 1], [1, 1], [2, 1], [2, 0]] }] };
  ops.shrinkBoard(s, 'S');
  assert.equal(s.rivers.length, 1, 'the south row held both ends; what is left is the middle');
  assert.deepEqual(s.rivers[0].path, [[0, 0], [1, 0], [2, 0]]);
  assert.equal(s.rivers[0].sourceEdge, 'S');
  assert.equal(s.rivers[0].sinkEdge, 'S');
  const t = { cols: 3, rows: 2, rivers: [{ name: 'r', size: 'creek', path: [[0, 1], [1, 1], [2, 1]] }] };
  ops.shrinkBoard(t, 'W');
  assert.deepEqual(t.rivers[0].path, [[0, 1], [1, 1]]);
  assert.equal(t.rivers[0].sourceEdge, 'W');
});

test('a riser the river would choose anyway is not written down', () => {
  const s = structuredClone(EXAMPLE_SPEC);
  ops.setRiser(s, 1, 0, 1);
  assert.deepEqual(s.levels, { '1,0': 1 });
  ops.setRiser(s, 1, 0, 0);
  assert.equal(s.levels, undefined, 'back to what the river gives: the key goes');
});

test('a spring on every open inlet is written as auto, on some as ports', () => {
  const s = structuredClone(EXAMPLE_SPEC);
  delete s.fountains;
  assert.deepEqual(ops.openInlets(s).map((o) => `${o.tile}:${o.edge}`).sort(), ['B3:N', 'C2:E']);
  ops.toggleSpring(s, 'C2', 'E');
  assert.deepEqual(s.fountains, { auto: false, place: [{ tile: 'C2', edge: 'E' }] });
  ops.toggleSpring(s, 'B3', 'N');
  assert.deepEqual(s.fountains, { auto: true });
  ops.toggleSpring(s, 'B3', 'N');
  assert.deepEqual(s.fountains, { auto: false, place: [{ tile: 'C2', edge: 'E' }] });
  assert.equal(plan(s).springs.length, 1);
});

test('the spring tool on the first tile of a river with no way in gives it one', () => {
  const s = { cols: 1, rows: 2, rivers: [{ name: 'r', size: 'creek', path: [[0, 1], [0, 0]], sinkEdge: 'S' }] };
  ops.toggleSpring(s, 'A2', 'N');
  assert.equal(s.rivers[0].sourceEdge, 'N');
  assert.ok(ops.springOn(s, 'A2', 'N'));
});

test('the drain tool makes a river end off the board, and only off it', () => {
  const s = { cols: 2, rows: 1, rivers: [{ name: 'r', size: 'creek', path: [[0, 0], [1, 0]] }] };
  ops.toggleDrain(s, 'B1', 'W');
  assert.equal(s.rivers[0].sinkEdge, undefined, 'west of B1 is A1, not the tray');
  ops.toggleDrain(s, 'B1', 'E');
  assert.equal(s.rivers[0].sinkEdge, 'E');
  ops.toggleDrain(s, 'B1', 'E');
  assert.equal(s.rivers[0].sinkEdge, undefined);
});

test('a point spring on a map with no fountains turns on that one only', () => {
  const s = structuredClone(EXAMPLE_SPEC);
  delete s.fountains;
  ops.addSpringPoint(s, 'A1', [50, 60]);
  assert.deepEqual(s.fountains, { auto: false, place: [{ tile: 'A1', atMM: [50, 60] }] });
  assert.deepEqual(plan(s).springs.map((x) => x.id), ['0,0']);
});

test('a drawn wood belongs to its tile and keeps its shape', () => {
  const s = ops.blankSpec();
  ops.addWood(s, 'A1', [[10, 10], [90.04, 10], [50, 80]], 'conifer');
  assert.deepEqual(s.canopy[0].tiles, ['A1']);
  assert.deepEqual(s.canopy[0].region, [[10, 10], [90, 10], [50, 80]]);
  assert.equal(s.canopy[0].kind, 'conifer');
});

test('the JSON drawer\'s formatting reads like the example and parses back to the same spec', () => {
  const text = ops.formatSpec(EXAMPLE_SPEC);
  assert.deepEqual(JSON.parse(text), structuredClone(EXAMPLE_SPEC));
  assert.match(text, /"spine": \[\[0\.1, 0\.85\], \[0\.5, 0\.6\], \[0\.9, 0\.8\]\],/);
  assert.match(text, /"falls": \{ "1,2": 40, "1,1": 30, "1,0": 10, "2,1": 20 \},/);
  const drawn = ops.formatSpec(drawTheExample());
  assert.equal(drawn, text, 'and the drawn one prints the same, key for key');
});

test('a stroke through an exact grid corner does not run off along the ray', () => {
  const s = { cols: 3, rows: 3 };
  const cells = ops.strokeCells(s, [{ x: 300, y: 500 }, { x: 400, y: 200 }]);
  assert.ok(cells.length < 8, `${cells.length} cells`);
  assert.deepEqual(ops.strokeToRiver(s, [{ x: 300, y: 500 }, { x: 400, y: 200 }]),
    { path: [[1, 2], [1, 1], [2, 1]], sourceEdge: null, sinkEdge: null });
});

test('in and straight back out of the same side is not a river', () => {
  assert.equal(ops.strokeToRiver({ cols: 3, rows: 3 }, [{ x: -50, y: 100 }, { x: 100, y: 100 }, { x: -50, y: 110 }]), null);
});

test('toggling one spring leaves every other spring entry as it was', () => {
  const s = structuredClone(EXAMPLE_SPEC);
  s.fountains = { auto: false, place: [{ tile: 'B3', edge: 'N', poolRadiusMM: 22 }] };
  ops.toggleSpring(s, 'C2', 'E');
  assert.deepEqual(s.fountains, { auto: false, place: [{ tile: 'B3', edge: 'N', poolRadiusMM: 22 }, { tile: 'C2', edge: 'E' }] },
    'not collapsed to auto, which would lose the 22 mm pool');
  // A spring on a port that is not an open inlet: shown, built, and still removable.
  const t = structuredClone(EXAMPLE_SPEC);
  t.fountains = { auto: false, place: [{ tile: 'B2', edge: 'N' }] };
  ops.toggleSpring(t, 'B3', 'N');
  ops.toggleSpring(t, 'C2', 'E');
  assert.deepEqual(t.fountains, { auto: true, place: [{ tile: 'B2', edge: 'N' }] }, 'other springs never touch it');
  ops.toggleSpring(t, 'B2', 'N');
  assert.deepEqual(t.fountains, { auto: true }, 'and it comes off when asked');
});

test('growing the board past a river\'s open end carries the river out to the new edge', () => {
  const kinds = (sp) => plan(sp).sentences.map((x) => x.kind).join();
  const south = structuredClone(EXAMPLE_SPEC);
  ops.growBoard(south, 'S');
  assert.deepEqual(south.rivers[0].path, [[1, 3], [1, 2], [1, 1], [1, 0]]);
  assert.equal(south.rivers[0].sinkEdge, 'S');
  assert.equal(kinds(south), 'spring,waterfall,flow,flow,flow,drains');
  const north = structuredClone(EXAMPLE_SPEC);
  ops.growBoard(north, 'N');
  assert.deepEqual(north.rivers[0].path, [[1, 3], [1, 2], [1, 1], [1, 0]]);
  assert.equal(north.rivers[0].sourceEdge, 'N');
  assert.ok(!plan(north).sentences.some((x) => x.kind === 'dry'), 'the spring moves out to the new edge with it');
  const east = structuredClone(EXAMPLE_SPEC);
  ops.growBoard(east, 'E');
  assert.deepEqual(east.rivers[1].path, [[3, 1], [2, 1], [1, 1]]);
});

test('setting a tile to the height it already has does not move its neighbours', () => {
  const s = { cols: 2, rows: 2, levels: { '0,0': 3, '1,0': 3, '0,1': 0 } };
  const before = plan(s).levels.get('1,1');
  ops.setRiser(s, 1, 0, 3);
  assert.deepEqual(s.levels, { '0,0': 3, '1,0': 3, '0,1': 0 }, 'B1\'s key stays: B2 takes its level from it');
  assert.equal(plan(s).levels.get('1,1'), before);
});

/* ------------------------------------------------------------- refine */

const board3 = (spec) => plan(spec).placements.map((p) => ({ col: p.col, row: p.row, rot: p.rot, label: p.label, riserMM: p.riserMM }));

test('a stroke is written on each tile it reaches, in that tile\'s own millimetres', () => {
  const s = structuredClone(EXAMPLE_SPEC);
  // From B2's middle east into C2: two tiles, each in its own frame.
  const touched = ops.addStroke(s, board3(s), [{ x: 300, y: 300 }, { x: 360, y: 300 }, { x: 460, y: 300 }], { op: 'raise', radiusMM: 10, mm: 4 });
  assert.deepEqual(touched.sort(), ['B2', 'C2']);
  assert.deepEqual(s.edits.B2, [{ op: 'raise', path: [[100, 100], [260, 100]], radiusMM: 10, mm: 4 }], 'the straight run is one segment');
  assert.deepEqual(s.edits.C2[0].path, [[-100, 100], [60, 100]]);
});

test('a stroke on a turned tile is turned back into the tile\'s frame, so it stays where it was drawn', () => {
  const s = structuredClone(EXAMPLE_SPEC);
  s.rot = { '1,1': 1 }; // B2 a quarter turn clockwise: its own north faces east
  ops.addStroke(s, board3(s), [{ x: 300, y: 330 }, { x: 300, y: 370 }], { op: 'lower', radiusMM: 8, mm: 2 });
  // On the board the stroke runs north from 30 mm above B2's middle; in B2's own frame that is west of it.
  assert.deepEqual(s.edits.B2[0].path, [[70, 100], [30, 100]]);
});

test('a stroke that only grazes a tile across a seam writes nothing there', () => {
  const s = structuredClone(EXAMPLE_SPEC);
  // 5 mm from the seam inside A2, with a 6 mm brush: it reaches 1 mm into B2,
  // where the rim lock leaves nothing of it. A2, 5 mm in, keeps a third.
  const touched = ops.addStroke(s, board3(s), [{ x: 195, y: 300 }], { op: 'raise', radiusMM: 6, mm: 4 });
  assert.deepEqual(touched, ['A2']);
  assert.equal(s.edits.B2, undefined);
});

test('a flatten is to one height on the table, so each tile gets it less its own riser', () => {
  const s = structuredClone(EXAMPLE_SPEC);
  const pl = board3(s);
  const b3 = pl.find((p) => p.label === 'B3');
  const b2 = pl.find((p) => p.label === 'B2');
  ops.addStroke(s, pl, [{ x: 300, y: 380 }, { x: 300, y: 420 }], { op: 'flatten', radiusMM: 10, toWorldMM: 90 });
  assert.equal(s.edits.B2[0].toMM, 90 - b2.riserMM);
  assert.equal(s.edits.B3[0].toMM, 90 - b3.riserMM);
});

test('edits come off one at a time or all together, and an empty list is not kept', () => {
  const s = structuredClone(EXAMPLE_SPEC);
  ops.addStroke(s, board3(s), [{ x: 300, y: 300 }], { op: 'smooth', radiusMM: 15, strength: 0.5 });
  ops.addStroke(s, board3(s), [{ x: 320, y: 300 }], { op: 'plant', radiusMM: 15, kind: 'conifer' });
  assert.equal(s.edits.B2.length, 2);
  assert.equal(ops.describeEdit(s.edits.B2[0]), 'Smoothed, 30 mm wide');
  assert.equal(ops.describeEdit(s.edits.B2[1]), 'Conifers planted, 30 mm wide');
  ops.removeEdit(s, 'B2', 0);
  assert.equal(s.edits.B2[0].op, 'plant');
  ops.clearEdits(s, 'B2');
  assert.equal(s.edits, undefined);
});

test('a handle drag moves a world feature by its fraction and a lake within its own tile, turned back', () => {
  const s = structuredClone(EXAMPLE_SPEC);
  ops.moveFeature(s, 'volcano', 0, { x: 120, y: 480 });
  assert.deepEqual(s.volcanoes[0].at, [0.2, 0.8]);
  ops.moveFeature(s, 'spine', 1, { x: 300, y: 300 });
  assert.deepEqual(s.spine[1], [0.5, 0.5]);
  s.lakes = { place: [{ tile: 'B2', atMM: [50, 50] }] };
  s.rot = { '1,1': 2 }; // half a turn: the board's north-east of B2 is its own south-west
  ops.moveFeature(s, 'lake', 0, { x: 360, y: 340 });
  assert.deepEqual(s.lakes.place[0].atMM, [40, 60]);
  ops.moveFeature(s, 'lake', 0, { x: 900, y: 900 });
  assert.deepEqual(s.lakes.place[0].atMM, [2, 2], 'kept on its tile');
});

test('edits go with their tiles when the board grows or shrinks on the west or south', () => {
  const s = structuredClone(EXAMPLE_SPEC);
  s.edits = { A1: [{ op: 'raise', path: [[100, 100]], radiusMM: 10, mm: 3 }], B2: [{ op: 'lower', path: [[50, 50]], radiusMM: 10, mm: 2 }] };
  ops.growBoard(s, 'W');
  assert.deepEqual(Object.keys(s.edits).sort(), ['B1', 'C2'], 'every tile moved one column east, and its edits with it');
  ops.shrinkBoard(s, 'W');
  assert.deepEqual(Object.keys(s.edits).sort(), ['A1', 'B2'], 'and back');
  ops.shrinkBoard(s, 'W');
  assert.deepEqual(Object.keys(s.edits), ['A2'], 'the removed column\'s edits go with it; B2\'s come to A2');
  ops.growBoard(s, 'S');
  assert.deepEqual(Object.keys(s.edits), ['A3']);
});

test('a stroke that doubles back, or comes round in a circle, keeps its shape when it is thinned', () => {
  const s = structuredClone(EXAMPLE_SPEC);
  const out = [];
  for (let x = 300; x <= 360; x += 2) out.push({ x, y: 300 });
  for (let x = 360; x >= 310; x -= 2) out.push({ x, y: 300 });
  ops.addStroke(s, board3(s), out, { op: 'raise', radiusMM: 8, mm: 2 });
  const path = s.edits.B2[0].path;
  assert.ok(path.some(([x]) => x >= 159), `the turn at 160 is kept: ${JSON.stringify(path)}`);
  const ring = [];
  for (let a = 0; a <= 2 * Math.PI + 1e-9; a += Math.PI / 24) ring.push({ x: 300 + 30 * Math.cos(a), y: 300 + 30 * Math.sin(a) });
  ops.addStroke(s, board3(s), ring, { op: 'smooth', radiusMM: 6 });
  const circle = s.edits.B2[1].path;
  assert.ok(circle.length >= 8, `a ring of ${circle.length} points, not a dot`);
  const far = Math.max(...circle.map(([x, y]) => Math.hypot(x - 100, y - 100)));
  assert.ok(far > 29, 'still 30 mm round');
});

test('a world feature dragged on a turned tile goes back through that tile\'s turn', () => {
  const s = structuredClone(EXAMPLE_SPEC);
  s.rot = { '2,0': 2 }; // C1 half way round
  const v = s.volcanoes[0].at; // in C1
  const shown = ops.turnPoint(s, ops.toBoard(s, v));
  const b = ops.toBoard(s, v);
  assert.deepEqual([Math.round(shown.x), Math.round(shown.y)], [Math.round(1000 - b.x), Math.round(200 - b.y)], 'drawn where its ground has turned to');
  assert.deepEqual(ops.unturnPoint(s, shown), b, 'and back');
  ops.moveFeature(s, 'volcano', 0, shown);
  assert.deepEqual(s.volcanoes[0].at, v, 'dropped where it is drawn, it stays where it was');
  ops.moveFeature(s, 'spine', 0, { x: 100, y: 100 }); // A1 is not turned
  assert.deepEqual(s.spine[0], [100 / 600, 100 / 600].map((q) => Math.round(q * 1e6) / 1e6));
});
