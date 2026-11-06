import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkWatertight, boundingBox } from '../lib/mesh.js';
import {
  CAM_DEFAULTS, camSettings, headCentre, cavityContains, camProfile, camSolid, camSheet,
} from '../lib/cam.js';

const lock = camSettings();
const R = CAM_DEFAULTS.camMM / 2;
const CIRCLE_AREA = Math.PI * R * R;

const polyArea = (poly) => {
  let a = 0;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i];
    const q = poly[(i + 1) % poly.length];
    a += p[0] * q[1] - q[0] * p[1];
  }
  return a / 2;
};

/** Total area of the triangles whose three vertices all sit at height z. */
const areaAtZ = (tris, z) => {
  let area = 0;
  for (let o = 0; o < tris.length; o += 9) {
    if (Math.abs(tris[o + 2] - z) > 1e-6 || Math.abs(tris[o + 5] - z) > 1e-6 || Math.abs(tris[o + 8] - z) > 1e-6) continue;
    const ux = tris[o + 3] - tris[o], uy = tris[o + 4] - tris[o + 1];
    const vx = tris[o + 6] - tris[o], vy = tris[o + 7] - tris[o + 1];
    area += Math.abs(ux * vy - uy * vx) / 2;
  }
  return area;
};

const hasVertexAtZ = (tris, z) => {
  for (let i = 2; i < tris.length; i += 3) if (Math.abs(tris[i] - z) < 1e-6) return true;
  return false;
};

test('the cam is a closed solid of the right size at every height', () => {
  const s = camSolid(lock, 22);
  const w = checkWatertight(s);
  assert.equal(w.unpaired, 0, `${w.unpaired} unpaired edges`);
  assert.equal(w.overused, 0, `${w.overused} overused edges`);
  const { size } = boundingBox(s);
  assert.ok(Math.abs(size[0] - 18) < 1e-6 && Math.abs(size[1] - 18) < 1e-6 && Math.abs(size[2] - 22) < 1e-6, JSON.stringify(size));
  for (const h of [12, 62]) {
    const ww = checkWatertight(camSolid(lock, h));
    assert.ok(ww.watertight, `${h} mm cam: ${ww.unpaired} unpaired, ${ww.overused} overused`);
  }
});

test('the head sits inside the hollow at both ends of the turn', () => {
  for (const theta of [0, 90]) {
    const c = headCentre(lock, theta);
    assert.ok(cavityContains(lock, c.x, c.y), `head centre at ${theta} deg`);
    // Half a millimetre inside the head's edge, on the side toward the rim.
    const k = (lock.headMM / 2 - 0.5) / c.L;
    assert.ok(cavityContains(lock, c.x * (1 + k), c.y * (1 + k)), `head edge at ${theta} deg`);
  }
  assert.equal(cavityContains(lock, R - 0.5, 0), false, 'the far side of the cam is solid');
  assert.doesNotThrow(() => cavityContains(lock, 0, 0));
});

test('a quarter turn draws the head in by drawMM and never lets it back out', () => {
  assert.ok(Math.abs(headCentre(lock, 0).L - headCentre(lock, 90).L - lock.drawMM) < 1e-9);
  let last = Infinity;
  for (let th = 0; th <= 90; th += 5) {
    const { L } = headCentre(lock, th);
    assert.ok(L <= last + 1e-12, `L rose at ${th} deg`);
    last = L;
  }
});

test('the wall left at the seat is reported, and most of the bottom remains', () => {
  const prof = camProfile(lock);
  assert.ok(prof.wallMM >= 1.2, `${prof.wallMM} mm wall`);
  assert.ok(Math.abs(prof.wallMM - 1.7) < 1e-9);
  assert.ok(polyArea(prof.hook) >= 0.4 * CIRCLE_AREA, `hook is ${polyArea(prof.hook).toFixed(1)} of ${CIRCLE_AREA.toFixed(1)}`);
});

test('the mesh really has the hollow cut out of its bottom', () => {
  const s = camSolid(lock, 22);
  const bottom = areaAtZ(s, 0);
  assert.ok(bottom > 0);
  assert.ok(bottom < CIRCLE_AREA - 1, `bottom covers ${bottom.toFixed(1)} of ${CIRCLE_AREA.toFixed(1)}`);
  for (let i = 2; i < s.length; i += 3) assert.ok(s[i] >= 0, 'nothing below z = 0');
});

test('the coin slot is cut across the top', () => {
  const H = 22;
  const s = camSolid(lock, H);
  assert.ok(hasVertexAtZ(s, H - lock.slotDepthMM));
  assert.ok(hasVertexAtZ(s, H));
  const top = areaAtZ(s, H);
  assert.ok(top < CIRCLE_AREA - lock.slotWidthMM * 2 * R * 0.8, `top caps cover ${top.toFixed(1)}`);
});

test('a sheet of cams is a closed solid laid out along x', () => {
  const sh = camSheet(lock, [12, 22]);
  assert.ok(checkWatertight(sh).watertight);
  assert.ok(boundingBox(sh).size[0] > 36);
});

test('a cam shorter than its hook and slot is refused', () => {
  assert.throws(() => camSolid(lock, 6), /too short/);
});
