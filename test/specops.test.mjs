import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as ops from '../app/specops.js';
import { EXAMPLE_SPEC } from '../lib/example.js';

// What the editor does when the example is drawn by hand: the ridge tool
// clicks its points, the channel is given its two ends, the inspector
// types the numbers that are numbers.
function drawTheExample() {
  const s = ops.blankSpec();
  Object.assign(s, { name: 'hanging-valley', seed: 7, meshMM: 0.9, metresPerMM: 25, marginMM: 100, spineHeightMM: 60 });
  ops.setSpine(s, [{ x: -100, y: 112 }, { x: 30, y: 98 }, { x: 105, y: 104 }, { x: 190, y: 94 }, { x: 300, y: 86 }]);
  s.spineWidthMM = 95;
  ops.setPath(s, 'glacier.cycles', 30);
  ops.setPath(s, 'glacier.elaSwingMM', 18);
  s.channels = [{ name: 'main', widthMM: 30, depthMM: 10, from: [100, 62], to: 'S' }];
  const conifer = ops.addWoodLayer(s, 'conifer');
  Object.assign(s.canopy[conifer], { crownMM: 7, heightMM: 9, density: 0.4, minZMM: 28, maxZMM: 54, thinningMM: 10, maxSlopeDeg: 36 });
  const broad = ops.addWoodLayer(s, 'deciduous');
  Object.assign(s.canopy[broad], { crownMM: 12, heightMM: 7, density: 0.3, maxZMM: 32, thinningMM: 6, maxSlopeDeg: 24 });
  for (const [k, v] of Object.entries({ fillHollows: true, depthMM: 5, shoreMM: 10, profile: 'dish' })) ops.setPath(s, `lakes.${k}`, v);
  ops.setPath(s, 'fountains.auto', true);
  ops.setPath(s, 'fountains.tubeOdMM', 12.7);
  ops.setPath(s, 'fountains.poolRadiusMM', 16);
  ops.setPath(s, 'contract', { tileMM: 200, edgeLandMM: 22, portWidthMM: 30, channelDepthMM: 10 });
  return s;
}

test('the example can be drawn from a blank module with the tools alone', () => {
  assert.deepEqual(ops.canonical(drawTheExample()), ops.canonical(structuredClone(EXAMPLE_SPEC)));
});

test('a drawn channel is thinned to a few points and keeps its width and depth', () => {
  const s = ops.blankSpec();
  const pts = [];
  for (let y = 200; y >= 0; y -= 1) pts.push({ x: 100 + 20 * Math.sin((y / 200) * Math.PI), y });
  const i = ops.addChannel(s, pts, { widthMM: 40, depthMM: 8 });
  assert.equal(i, 0);
  const ch = s.channels[0];
  assert.ok(ch.path.length < 30, `${ch.path.length} points, not one per mouse move`);
  assert.deepEqual(ch.path[0], [100, 200]);
  assert.deepEqual(ch.path[ch.path.length - 1], [100, 0]);
  assert.equal(ch.widthMM, 40);
  assert.equal(ch.depthMM, 8);
  assert.equal(ch.name, 'channel 1');
  const ends = ops.channelEnds(s, ch);
  assert.equal(ends.from, 'N');
  assert.equal(ends.to, 'S');
  // The default depth is not written down.
  const j = ops.addChannel(s, pts, { widthMM: 30, depthMM: 10 });
  assert.equal(s.channels[j].depthMM, undefined);
  assert.equal(s.channels[j].name, 'channel 2');
  // Too short to be one.
  assert.equal(ops.addChannel(s, [{ x: 100, y: 100 }], {}), -1);
  ops.removeChannel(s, 1);
  ops.removeChannel(s, 0);
  assert.equal(s.channels, undefined);
});

test('a routed channel can take the line it was grown with, and is then a drawn one', () => {
  const s = structuredClone(EXAMPLE_SPEC);
  const pts = [];
  for (let y = 118; y >= 0; y -= 2) pts.push([100 + 10 * Math.sin(y / 20), y]);
  ops.takeLine(s, 0, pts);
  const ch = s.channels[0];
  assert.equal(ch.from, undefined);
  assert.equal(ch.to, undefined);
  assert.ok(ch.path.length >= 4 && ch.path.length < 40);
  assert.deepEqual(ch.path[ch.path.length - 1], [100, 0]);
  assert.equal(ops.channelEnds(s, ch).to, 'S');
});

test('the module is described in sentences, with the ports its channels cross', () => {
  const d = ops.describe(structuredClone(EXAMPLE_SPEC));
  assert.ok(d.sentences.length >= 2);
  assert.match(d.sentences[0].text, /200 mm module/);
  assert.match(d.sentences[0].text, /main: 30 by 10 mm, from inside, out at the south/i);
  assert.deepEqual(d.ports, { N: false, E: false, S: true, W: false });
  assert.equal(d.notes.length, 0);
  const two = ops.describe({ channels: [{ path: [[100, 200], [60, 60]] }, { path: [[100, 199], [140, 60]] }] });
  assert.ok(two.notes.some((n) => /both cross the N side/.test(n.message)));
  const none = ops.describe({});
  assert.match(none.sentences[none.sentences.length - 1].text, /All four sides are land/);
});

test('a stroke is written as an edit in module millimetres, and one that only grazes the rim writes nothing', () => {
  const s = ops.blankSpec();
  assert.equal(ops.addStroke(s, [{ x: 40, y: 40 }, { x: 160, y: 160 }], { op: 'raise', radiusMM: 10, mm: 4 }), true);
  assert.deepEqual(s.edits, [{ op: 'raise', path: [[40, 40], [160, 160]], radiusMM: 10, mm: 4 }]);
  assert.equal(ops.addStroke(s, [{ x: 0, y: 100 }, { x: 0, y: 110 }], { op: 'raise', radiusMM: 1.5, mm: 4 }), false, 'on the rim, inside the lock');
  assert.equal(ops.addStroke(s, [{ x: -50, y: 100 }], { op: 'raise', radiusMM: 10, mm: 4 }), false, 'off the module');
  assert.equal(ops.addStroke(s, [{ x: 100, y: 100 }], { op: 'flatten', radiusMM: 20, toMM: 1 }), true);
  assert.equal(s.edits[1].toMM, 2, 'never below the floor');
  assert.equal(ops.addStroke(s, [{ x: 100, y: 100 }], { op: 'plant', radiusMM: 20, kind: 'conifer' }), true);
  assert.equal(s.edits[2].kind, 'conifer');
  ops.removeEdit(s, 1);
  assert.equal(s.edits.length, 2);
  assert.equal(s.edits[1].op, 'plant');
  ops.clearEdits(s);
  assert.equal(s.edits, undefined);
});

test('a stroke that doubles back, or comes round in a circle, keeps its shape when it is thinned', () => {
  const back = [];
  for (let x = 20; x <= 100; x += 1) back.push([x, 100]);
  for (let x = 100; x >= 20; x -= 1) back.push([x, 100.5]);
  const t = ops.thin(back, 1);
  assert.ok(t.length <= 4, `${t.length} points for out and back`);
  assert.deepEqual(t[0], [20, 100]);
  assert.deepEqual(t[t.length - 1], [20, 100.5]);
  assert.ok(t.some(([x]) => x === 100), 'the far end is kept: it did go there');
  const ring = [];
  for (let a = 0; a <= 2 * Math.PI + 1e-9; a += Math.PI / 60) ring.push([100 + 30 * Math.cos(a), 100 + 30 * Math.sin(a)]);
  const r = ops.thin(ring, 1);
  assert.ok(r.length >= 8, `a circle keeps enough points to still be round, ${r.length}`);
});

test('painting water writes a lake along the stroke; a click writes a round one with a handle', () => {
  const s = ops.blankSpec();
  const i = ops.addWaterStroke(s, [{ x: 50, y: 50 }, { x: 100, y: 80 }, { x: 150, y: 50 }], { radiusMM: 12 });
  assert.equal(i, 0);
  assert.deepEqual(s.lakes.place[0].pathMM[0], [50, 50]);
  assert.equal(s.lakes.place[0].radiusMM, 12);
  assert.equal(s.lakes.place[0].atMM, undefined);
  const j = ops.addWaterStroke(s, [{ x: 70, y: 70 }], { radiusMM: 12 });
  assert.deepEqual(s.lakes.place[j], { atMM: [70, 70], radiusMM: 12 });
  assert.equal(ops.addWaterStroke(s, [{ x: -80, y: -80 }], { radiusMM: 12 }), -1, 'off the module');
  const k = ops.addLake(s, [120, 120]);
  assert.deepEqual(s.lakes.place[k], { atMM: [120, 120] });
});

test('moving things: a ridge point goes anywhere, a channel point and a lake stay on the module', () => {
  const s = structuredClone(EXAMPLE_SPEC);
  ops.moveFeature(s, 'spine', 0, { x: -140, y: 250 });
  assert.deepEqual(s.spine[0], [-140, 250]);
  const ch = ops.addChannel(s, [{ x: 100, y: 200 }, { x: 100, y: 100 }, { x: 100, y: 0 }], {});
  ops.moveFeature(s, 'channel-vertex', ch, { x: 260, y: -20 }, 1);
  assert.deepEqual(s.channels[ch].path[1], [200, 0]);
  ops.shiftFeature(s, 'channel', ch, 10, 0);
  assert.deepEqual(s.channels[ch].path[0], [110, 200]);
  const l = ops.addLake(s, [100, 100]);
  ops.moveFeature(s, 'lake', l, { x: 300, y: 100 });
  assert.deepEqual(s.lakes.place[l].atMM, [200, 100]);
  const v = ops.addVolcano(s, { x: 50, y: 50 }, 40);
  ops.moveFeature(s, 'volcano', v, { x: -30, y: 240 });
  assert.deepEqual(s.volcanoes[v].at, [-30, 240]);
  const w = ops.addWood(s, [[20, 20], [60, 20], [40, 60]], 'conifer');
  ops.moveFeature(s, 'wood-vertex', w, { x: 90, y: 10 }, 2);
  assert.deepEqual(s.canopy[w].region[2], [90, 10]);
});

test('a point spring on a module with no fountains turns on that one only', () => {
  const s = ops.blankSpec();
  ops.addSpringPoint(s, [80, 120]);
  assert.deepEqual(s.fountains, { auto: false, place: [{ atMM: [80, 120] }] });
  const t = structuredClone(EXAMPLE_SPEC);
  ops.addSpringPoint(t, [80, 120]);
  assert.equal(t.fountains.auto, true, 'and leaves auto alone where it was on');
});

test('the JSON drawer\'s formatting reads like the example and parses back to the same spec', () => {
  const s = structuredClone(EXAMPLE_SPEC);
  const text = ops.formatSpec(s);
  assert.deepEqual(JSON.parse(text), ops.canonical(s));
  assert.match(text, /"spine": \[\[-100, 112\], \[30, 98\]/, 'a short array of points on one line');
  assert.match(text, /"contract": \{ "tileMM": 200/, 'a small object on one line');
  const lines = text.split('\n');
  assert.ok(lines.every((l) => l.length <= 100), 'nothing runs off the right of the drawer');
  // Keys come out in the example's order however they went in.
  const shuffled = Object.fromEntries(Object.entries(s).reverse());
  assert.equal(ops.formatSpec(shuffled), text);
});

test('tidy drops empty lists and a ridge of one point, and a blank module is a module', () => {
  const s = { ...ops.blankSpec(), channels: [], canopy: [], spine: [[1, 2]], lakes: { place: [] }, edits: [] };
  ops.tidy(s);
  assert.deepEqual(s, { ...ops.blankSpec(), lakes: {} });
  const d = ops.describe(ops.blankSpec());
  assert.match(d.sentences[0].text, /no channels/i);
});

test('a side\'s class and how it meets its rim are written into the contract, and the default class is no entry at all', () => {
  const s = ops.blankSpec();
  ops.setEdgeClass(s, 'N', 40);
  ops.setEdgeClass(s, 'S', 10);
  assert.deepEqual(s.contract.edges, { N: 42, S: 12 });
  ops.setEdgeClass(s, 'N', 20);
  assert.deepEqual(s.contract.edges, { S: 12 }, 'class 20 is the default: written as nothing');
  ops.setEdgeBlend(s, 'E', 6);
  assert.deepEqual(s.contract.blends, { E: 6 });
  ops.setEdgeBlend(s, 'E', undefined);
  ops.setEdgeClass(s, 'S', 20);
  assert.equal(s.contract, undefined, 'and a contract with nothing left in it goes');
  const say = ops.describe({ ...ops.blankSpec(), contract: { edges: { S: 32 } }, channels: [{ path: [[100, 200], [100, 0]] }] });
  assert.ok(say.notes.some((n) => /would have to climb/.test(n.message)), 'in at a lower class than out is said before it grows');
});

test('a grown lake is resized by writing its size at its middle; again replaces, fill and back-to-as-dug do what they say', () => {
  const s = ops.blankSpec();
  const lake = { shape: { atMM: [100.04, 80], lengthMM: 150, widthMM: 70 }, resizeIndex: null };
  assert.equal(ops.resizeLake(s, lake, { lengthMM: 40, widthMM: 30 }), 0);
  assert.deepEqual(s.lakes.resize, [{ atMM: [100, 80], lengthMM: 40, widthMM: 30 }]);
  ops.resizeLake(s, { ...lake, resizeIndex: 0 }, { lengthMM: 50, widthMM: 30 });
  assert.equal(s.lakes.resize.length, 1, 'replaced, not stacked');
  ops.resizeLake(s, lake, { lengthMM: 50, widthMM: 20 });
  assert.equal(s.lakes.resize.length, 1, 'and a second change before it has grown again finds the first by where it is');
  assert.equal(s.lakes.resize[0].lengthMM, 50);
  ops.fillLake(s, { ...lake, resizeIndex: 0 });
  assert.deepEqual(s.lakes.resize, [{ atMM: [100, 80], fill: true }]);
  ops.unresizeLake(s, 0);
  assert.equal(s.lakes.resize, undefined);
});
