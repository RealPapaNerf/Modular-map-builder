import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeContract, edgeProfile, tileEdgeProfile, edgeSignature, channelShape, portFloor, check, DEFAULTS, EDGES } from '../lib/contract.js';

const c = makeContract();

test('the rim is one flat height on every side, so any land edge mates with any land edge', () => {
  for (const e of EDGES) {
    for (let s = 0; s <= c.tileMM; s += 7) assert.equal(tileEdgeProfile(c, {}, e, s), c.edgeLandMM);
    assert.equal(edgeSignature(c, {}, e), `land ${c.edgeLandMM}`);
  }
});

test('a channel crosses the rim in the middle of the side, at the contract\'s width and depth, whatever the channel is inland', () => {
  const half = c.portWidthMM / 2;
  const floor = portFloor(c);
  assert.equal(floor, c.edgeLandMM - c.channelDepthMM);
  const mid = c.tileMM / 2;
  assert.ok(Math.abs(edgeProfile(c, true, mid) - floor) < 1e-9, 'the thalweg is on the centre line');
  assert.equal(edgeProfile(c, true, mid - half), c.edgeLandMM, 'the bank top is the rim');
  assert.equal(edgeProfile(c, true, mid + half), c.edgeLandMM);
  assert.equal(edgeProfile(c, true, 0), c.edgeLandMM, 'away from the port the rim is the rim');
  assert.equal(edgeProfile(c, true, c.tileMM), c.edgeLandMM);
  // Symmetric about the middle, so a turned module still mates.
  for (let d = 0; d <= half; d += 1) assert.ok(Math.abs(edgeProfile(c, true, mid - d) - edgeProfile(c, true, mid + d)) < 1e-9);
  assert.equal(edgeSignature(c, { N: true }, 'N'), `channel ${c.portWidthMM}@${floor} ${c.edgeLandMM}`);
  assert.equal(edgeSignature(c, { N: true }, 'S'), `land ${c.edgeLandMM}`);
});

test('two modules read the same edge the same way round, so N against S is one line', () => {
  // A's north edge runs east to west; B's south edge runs west to east. The
  // profile is symmetric, so s on one is T - s on the other and the heights
  // agree all the way along.
  for (let s = 0; s <= c.tileMM; s += 2.5) {
    assert.ok(Math.abs(tileEdgeProfile(c, { N: true }, 'N', s) - tileEdgeProfile(c, { S: true }, 'S', c.tileMM - s)) < 1e-9);
  }
});

test('the cross-section is a circular arc: a parenthesis on its side', () => {
  // Chord 2, sagitta a: the circle through the two bank tops and the thalweg.
  for (const a of [0.2, 0.5, 1]) {
    const r = (1 + a * a) / (2 * a);
    for (let u = 0; u <= 1; u += 0.05) {
      const down = a * channelShape(u, a); // how far below the bank top, in half-widths
      const onCircle = r - Math.sqrt(Math.max(0, r * r - u * u));
      assert.ok(Math.abs(down - (a - onCircle)) < 1e-9, `aspect ${a}, u ${u.toFixed(2)}`);
    }
  }
  assert.equal(channelShape(0, 0.5), 1, 'deepest on the centre line');
  assert.equal(channelShape(1, 0.5), 0, 'nothing at the bank');
  assert.ok(channelShape(0.5, 0.5) > 0.5, 'and rounder than a V: still deep half way out');
  // Deeper than a semicircle: straight walls over a semicircular bottom.
  assert.equal(channelShape(0, 2), 1);
  assert.equal(channelShape(1, 2), 0);
  assert.ok(channelShape(0.9, 2) > 0.5, 'the wall is steep, so it is still deep near the bank');
  assert.ok(channelShape(0.95, 2) > channelShape(0.99, 2));
  // Monotone from the centre out, for any aspect.
  for (const a of [0.3, 1, 1.8]) {
    let last = 2;
    for (let u = 0; u <= 1; u += 0.01) { const v = channelShape(u, a); assert.ok(v <= last + 1e-12); last = v; }
  }
});

test('a 30 mm port 10 mm deep is a shallow smile; 20 mm at 10 deep is a semicircle', () => {
  const smile = makeContract({ portWidthMM: 30, channelDepthMM: 10 });
  const d = (cc, s) => cc.edgeLandMM - edgeProfile(cc, true, cc.tileMM / 2 + s);
  assert.ok(Math.abs(d(smile, 0) - 10) < 1e-9);
  assert.ok(d(smile, 7.5) > 6.5 && d(smile, 7.5) < 8.5, `half way out a smile is still ${d(smile, 7.5).toFixed(2)} mm deep`);
  const semi = makeContract({ portWidthMM: 20, channelDepthMM: 10 });
  assert.ok(Math.abs(d(semi, 0) - 10) < 1e-9);
  assert.ok(Math.abs(d(semi, 10 * Math.SQRT1_2) - 10 * Math.SQRT1_2) < 1e-6, 'a point on the circle: 45 degrees round from the bank');
});

test('a contract is checked before anything is grown', () => {
  assert.ok(check(c).every((n) => n.severity !== 'error'));
  const thin = check(makeContract({ edgeLandMM: 10, channelDepthMM: 10 }));
  assert.ok(thin.some((n) => n.severity === 'warning' && /plastic/.test(n.message)));
  assert.equal(portFloor(makeContract({ edgeLandMM: 10, channelDepthMM: 10 })), DEFAULTS.minChannelFloorMM, 'the floor is held up');
  const wide = check(makeContract({ portWidthMM: 150 }));
  assert.ok(wide.some((n) => n.severity === 'error'));
});

test('an old contract\'s plate fields are dropped on the way in', () => {
  const old = makeContract({ tileMM: 200, plateMM: 10, outletZMM: 6, edgeLandMM: 22 });
  assert.equal(old.plateMM, undefined);
  assert.equal(old.outletZMM, undefined);
  assert.equal(old.edgeLandMM, 22);
});
