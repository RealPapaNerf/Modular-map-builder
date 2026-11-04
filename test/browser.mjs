// The editor in a real Chromium: phase 1's "done when", checked by hand-eye
// motions rather than by calling the spec functions directly.
//
//   1. The example map can be drawn from an empty board WITHOUT opening the
//      JSON: place the tiles, draw the ridge and the volcano, draw both rivers,
//      set the falls and the waterfall, put the springs on, and type the
//      numbers that are numbers. The spec that comes out is the example's.
//   2. Dragging one tile up a riser flips its seam's badge live, mid-drag.
//
// Plus the rest of the Draw stage once each: a turn, the tile view's lake,
// spring, wood and corner tools, undo, and no errors in the console.
//
// Then phase 2's, on the 3D view in Grow:
//
//   3. A draft-mesh build is on screen in 3D within a few seconds: the 3D
//      view's own part, from the heights landing to the first frame, is
//      timed and held to it; the build before it is reported, because most
//      of it is the ice, which phase 6 caches.
//   4. Orbiting it is smooth: a drag of a second and a half, every frame's
//      interval measured, and the view drawing nothing once it has stopped.
//
// Plus: three.js is not fetched until Grow is opened, the water is where the
// board says it is, R turns a tile in 3D without growing again, a badge
// says its sentence and selects its seam, and an out-of-date view says so.
//
// Needs Playwright (`npm install playwright`, anywhere on the path); set
// CHROMIUM_PATH to use a Chromium that is already installed. Skips, and says
// so, when Playwright is not there.
//
//   npm run test:browser

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { EXAMPLE_SPEC } from '../lib/example.js';

let chromium;
try {
  ({ chromium } = await import('playwright'));
} catch {
  // A global Playwright is invisible to import() but not to require().
  try {
    const require = (await import('node:module')).createRequire(import.meta.url);
    ({ chromium } = require('playwright'));
  } catch {
    console.log('Playwright is not installed - skipping the browser test.');
    console.log('  npm install playwright');
    process.exit(0);
  }
}

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT || 8823);
const server = spawn('python3', ['-m', 'http.server', String(PORT), '--bind', '127.0.0.1', '--directory', ROOT], { stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 900));

const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
page.on('console', (m) => { if (m.type() === 'error' && !/favicon/i.test(m.text())) errors.push(`console: ${m.text()}`); });

let passed = 0;
async function step(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`ok - ${name}`);
  } catch (e) {
    console.log(`not ok - ${name}\n  ${String(e.stack || e).split('\n').slice(0, 6).join('\n  ')}`);
    await page.screenshot({ path: path.join(ROOT, 'test', 'browser-failure.png') }).catch(() => {});
    await browser.close();
    server.kill();
    process.exit(1);
  }
}

/* ------------------------------------------------------------------ helpers */

const spec = () => page.evaluate(() => window.mmb.state.spec);
const plan = () => page.evaluate(() => ({ sentences: window.mmb.state.plan.sentences, seams: window.mmb.state.plan.seams.map((s) => ({ id: s.id, kind: s.kind, wet: s.wet })) }));
const canvasBox = () => page.locator('#canvas').boundingBox();

/** Screen position of a board-mm point, under the camera as it is now. */
async function at(x, y) {
  const b = await canvasBox();
  const p = await page.evaluate(([x, y]) => { const c = window.mmb.state.cam; return { x: c.sx(x), y: c.sy(y) }; }, [x, y]);
  return { x: b.x + p.x, y: b.y + p.y };
}
async function click(x, y, opts = {}) {
  const p = await at(x, y);
  await page.mouse.click(p.x, p.y, opts);
  await page.waitForTimeout(60);
}
async function drag(points, { steps = 6 } = {}) {
  const first = await at(...points[0]);
  await page.mouse.move(first.x, first.y);
  await page.mouse.down();
  for (const pt of points.slice(1)) {
    const p = await at(...pt);
    await page.mouse.move(p.x, p.y, { steps });
  }
  await page.mouse.up();
  await page.waitForTimeout(80);
}
const tool = async (id) => { await page.click(`[data-tool="${id}"]`); };
const chip = async (v) => { await page.click(`[data-chip="${v}"]`); };
async function field(id, value) {
  const f = page.locator(`#inspector [data-field="${id}"]`).first();
  if (await f.evaluate((e) => e.tagName) === 'SELECT') await f.selectOption(String(value));
  else {
    await f.fill(String(value));
    await f.dispatchEvent('change');
  }
  await page.waitForTimeout(60);
}
async function nothingSelected() {
  await page.locator('#canvas').focus();
  await page.keyboard.press('Escape');
  await page.waitForTimeout(60);
}

/* --------------------------------------------------------------------- run */

await page.goto(`http://127.0.0.1:${PORT}/app/`);
await page.evaluate(() => localStorage.clear());
await page.reload();
await page.waitForFunction(() => window.mmb && window.mmb.state.plan);

await step('the editor opens on the example, with the board saying what the water does', async () => {
  const p = await plan();
  assert.deepEqual(p.sentences.map((s) => s.kind), ['spring', 'waterfall', 'flow', 'flow', 'drains']);
  assert.match(await page.locator('#say').innerText(), /B3 falls 20 mm into B2/);
  for (const name of ['Draw', 'Grow', 'Refine', 'Print']) assert.ok(await page.locator('.stages button', { hasText: name }).count(), `a ${name} tab`);
});

await step('New gives an empty board: one plain tile', async () => {
  await page.click('#new');
  await page.waitForTimeout(100);
  const s = await spec();
  assert.equal(s.cols, 1);
  assert.equal(s.rows, 1);
  assert.equal(s.rivers, undefined);
});

await step('the place tool grows the board to 3 x 3', async () => {
  await tool('place');
  await click(300, 100); // the + east of A1
  await click(500, 100);
  await click(100, 300); // the + north
  await click(100, 500);
  const s = await spec();
  assert.equal(s.cols, 3);
  assert.equal(s.rows, 3);
});

await step('the map\'s numbers go in through the inspector', async () => {
  await nothingSelected();
  await field('Name', 'glacier-valley');
  await field('Seed', 7);
  await field('Relief', 42);
  await field('World size', 16);
  await field('Mountains', 1600);
  await field('Cycles', 30);
  await field('Outlet floor', 6);
  await field('Land datum', 22);
  const s = await spec();
  assert.deepEqual(s.contract, { tileMM: 200, plateMM: 10, outletZMM: 6, edgeLandMM: 22 });
  assert.deepEqual(s.glacier, { cycles: 30 });
});

await step('the ridge is drawn on the board, three clicks snapped to 10 mm', async () => {
  await tool('ridge');
  await page.keyboard.down('Shift');
  await click(60, 510);
  await click(300, 360);
  await click(540, 480);
  await page.keyboard.up('Shift');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(80);
  assert.deepEqual((await spec()).spine, EXAMPLE_SPEC.spine);
});

await step('the volcano is placed in C1\'s tile view and dragged out to its foot', async () => {
  await tool('select');
  const p = await at(500, 100);
  await page.mouse.dblclick(p.x, p.y);
  await page.waitForTimeout(150);
  assert.equal(await page.evaluate(() => window.mmb.state.view.mode), 'tile');
  await tool('volcano');
  await drag([[468, 132], [520, 132], [558, 132]], { steps: 4 });
  await field('v.heightM', 800);
  await field('v.breach', 210);
  assert.deepEqual((await spec()).volcanoes, EXAMPLE_SPEC.volcanoes);
  await page.click('#crumbs button');
  await page.waitForTimeout(100);
  assert.equal(await page.evaluate(() => window.mmb.state.view.mode), 'board');
});

await step('both rivers are drawn as strokes: in from the north, off the south, and a tributary from the east', async () => {
  await tool('river');
  await drag([[300, 660], [302, 300], [299, -50]]);
  await field('river.name', 'main');
  await field('river.sinkSize', 'bay');
  await drag([[650, 290], [450, 300], [310, 305]]);
  await field('river.name', 'trib');
  assert.deepEqual((await spec()).rivers, EXAMPLE_SPEC.rivers);
});

await step('the fall tool paints each river tile\'s fall', async () => {
  await tool('fall');
  for (const [v, x, y] of [[40, 300, 500], [30, 300, 300], [10, 300, 100], [20, 500, 300]]) {
    await chip(v);
    await click(x, y);
  }
  assert.deepEqual((await spec()).falls, EXAMPLE_SPEC.falls);
});

await step('the waterfall into B2 is set from its inspector', async () => {
  await tool('select');
  await click(250, 250);
  await page.click('#inspector [data-field="Waterfall in at N"] >> text="+20"');
  await page.waitForTimeout(60);
  assert.deepEqual((await spec()).waterfalls, EXAMPLE_SPEC.waterfalls);
});

await step('the spring tool puts springs on both open inlets, which is written as auto', async () => {
  await tool('spring');
  await click(300, 590);
  await click(590, 300);
  assert.deepEqual((await spec()).fountains, { auto: true });
});

await step('woods, water and springs: the numbers that are numbers', async () => {
  await nothingSelected();
  await page.click('#inspector button >> text="+ Conifers"');
  await field('canopy.0.density', 0.62);
  await field('canopy.0.minZMM', 34);
  await field('canopy.0.maxZMM', 96);
  await field('canopy.0.thinningMM', 18);
  await page.click('#inspector button >> text="+ Broadleaf"');
  await field('canopy.1.maxZMM', 40);
  await field('canopy.1.thinningMM', 10);
  await page.click('#inspector [data-field="Tarns in hollows"]');
  await page.click('#inspector [data-field="Tarns in hollows"]');
  await field('Depth', 5);
  await field('Shore', 10);
  await field('Bed', 'dish');
  await field('Tube OD', 12.7);
  await field('Pool', 16);
});

await step('DONE WHEN: the spec drawn from an empty board is the example, and the JSON was never opened', async () => {
  assert.equal(await page.locator('#drawer').isHidden(), true, 'the JSON drawer stayed shut');
  assert.deepEqual(await spec(), structuredClone(EXAMPLE_SPEC));
  const p = await plan();
  assert.deepEqual(p.sentences.map((s) => s.kind), ['spring', 'waterfall', 'flow', 'flow', 'drains']);
});

await step('DONE WHEN: dragging one tile up a riser flips its seam\'s badge live', async () => {
  await tool('riser');
  const kind = () => page.evaluate(() => window.mmb.state.plan.seams.find((s) => s.id === 'B1|N').kind);
  assert.equal(await kind(), 'flow');
  const p = await at(300, 100);
  await page.mouse.move(p.x, p.y);
  await page.mouse.down();
  await page.mouse.move(p.x, p.y - 30, { steps: 6 });
  assert.equal(await kind(), 'dam', 'the badge has flipped while the pointer is still down');
  assert.match(await page.locator('#say').innerText(), /B2 meets B1 10 mm higher/);
  await page.mouse.up();
  assert.deepEqual((await spec()).levels, { '1,0': 1 });
  await page.locator('#canvas').focus();
  await page.keyboard.press('Control+z');
  await page.waitForTimeout(80);
  assert.equal((await spec()).levels, undefined, 'and undo puts it back in one step');
  assert.equal(await kind(), 'flow');
});

await step('R turns the tile under the pointer, and the water does something else', async () => {
  const p = await at(300, 300);
  await page.mouse.move(p.x, p.y);
  await page.keyboard.press('r');
  await page.waitForTimeout(80);
  assert.deepEqual((await spec()).rot, { '1,1': 1 });
  const kinds = (await plan()).sentences.map((s) => s.kind);
  assert.ok(kinds.includes('overtops') || kinds.includes('blocked'), kinds.join());
  await page.keyboard.press('Control+z');
  await page.waitForTimeout(80);
  assert.equal((await spec()).rot, undefined);
});

await step('the tile view writes a lake, a spring, a wood and a corner raise into A1', async () => {
  await tool('select');
  const p = await at(100, 100);
  await page.mouse.dblclick(p.x, p.y);
  await page.waitForTimeout(120);
  await tool('lake');
  await click(60, 140);
  await tool('springpoint');
  await click(150, 60);
  await tool('wood');
  await click(20, 20); await click(90, 20); await click(90, 90); await click(20, 90);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(60);
  await tool('corner');
  await click(200, 200);
  const s = await spec();
  assert.deepEqual(s.lakes.place, [{ tile: 'A1', atMM: [60, 140] }]);
  assert.deepEqual(s.fountains.place, [{ tile: 'A1', atMM: [150, 60] }]);
  const wood = s.canopy.find((l) => l.region);
  assert.deepEqual(wood.tiles, ['A1']);
  assert.deepEqual(wood.region, [[20, 20], [90, 20], [90, 90], [20, 90]]);
  assert.deepEqual(s.cornerRaise, { '1,1': 10 });
  await page.keyboard.press('Escape');
});

/* ------------------------------------------------------------------ phase 2 */

const stats = () => page.evaluate(() => window.mmb.viewer()?.stats() ?? null);
const threeFetched = () => page.evaluate(() => performance.getEntriesByType('resource').some((r) => /three\.module\.min\.js$/.test(r.name)));
const box3d = () => page.locator('#view3d').boundingBox();
/** Screen position of a board point on the 3D view, at the height of the ground there (plus `lift`). */
async function at3d(x, y, lift = 0) {
  const b = await box3d();
  const p = await page.evaluate(([x, y, lift]) => { const v = window.mmb.viewer(); return v.project(x, y, v.heightAt(x, y) + lift); }, [x, y, lift]);
  return { x: b.x + p.x, y: b.y + p.y };
}

await step('three.js is not fetched while drawing; Grow fetches it, and says nothing is grown yet', async () => {
  assert.equal(await threeFetched(), false, 'Draw never needed it');
  await page.click('#example');
  await page.click('.stages button[data-stage="grow"]');
  await page.waitForFunction(() => performance.getEntriesByType('resource').some((r) => /three\.module\.min\.js$/.test(r.name)));
  assert.match(await page.locator('#crumbs').innerText(), /Nothing grown yet/);
  assert.equal(await page.locator('#canvas').isVisible(), true, 'the board stays until there is something to stand up');
  assert.equal(await page.locator('#view3d').isVisible(), false);
});

await step('DONE WHEN: a draft-mesh build is on screen in 3D within a few seconds', async () => {
  await page.click('.chips button >> text="Draft 2.5"');
  assert.equal((await spec()).meshMM, 2.5);
  const t0 = await page.evaluate(() => performance.now());
  await page.click('#grow-go');
  await page.waitForFunction(() => window.mmb.state.grown?.tiles3d, null, { timeout: 240000 });
  await page.waitForFunction(() => window.mmb.viewer()?.stats().firstFrameAt, null, { timeout: 30000 });
  const t = await page.evaluate(() => ({ landed: window.mmb.state.grown.tiles3d.at, worker: window.mmb.state.grown.elapsedMS, frame: window.mmb.viewer().stats().firstFrameAt }));
  const view = t.frame - t.landed;
  console.log(`    grown in ${((t.landed - t0) / 1000).toFixed(1)} s (${(t.worker / 1000).toFixed(1)} s of it in the worker); in 3D ${Math.round(view)} ms after the heights landed`);
  assert.ok(view < 2500, `the 3D view took ${Math.round(view)} ms after the build`);
  assert.equal(await page.locator('#view3d').isVisible(), true);
  assert.equal(await page.locator('#canvas').isVisible(), false);
  const shape = await page.evaluate(() => window.mmb.state.grown.tiles3d.tiles.map((h) => ({ f32: h.heights instanceof Float32Array, n: h.heights.length, nx: h.nx })));
  assert.equal(shape.length, 9);
  assert.ok(shape.every((x) => x.f32 && x.nx === 81 && x.n === 81 * 81), 'one Float32Array of 81 x 81 heights per tile');
  const st = await stats();
  assert.equal(st.tiles, 9);
  const seams = await page.evaluate(() => window.mmb.state.plan.seams.filter((s) => s.kind !== 'plane').map((s) => s.id).sort());
  assert.deepEqual(st.badges.map((b) => b.id).sort(), seams, 'a badge over every seam that does something');
});

await step('the water is where the board says it is', async () => {
  const st = await stats();
  for (const label of ['B3', 'B2', 'B1', 'C2']) assert.ok(st.water[label] > 0, `${label}'s river runs`);
  const dry = await page.evaluate(() => window.mmb.state.plan.tiles.filter((t) => !t.wet).map((t) => t.label));
  assert.ok(dry.includes('A1') && !dry.includes('B2'), dry.join());
});

await step('DONE WHEN: orbiting it is smooth', async () => {
  const b = await box3d();
  const cx = b.x + b.width / 2;
  const cy = b.y + b.height * 0.6;
  const cam0 = (await stats()).camera;
  await page.mouse.move(cx, cy);
  const t0 = await page.evaluate(() => performance.now());
  await page.mouse.down();
  for (let i = 1; i <= 90; i++) {
    await page.mouse.move(cx + 260 * Math.sin(i / 15), cy + 50 * Math.sin(i / 10));
    await page.waitForTimeout(16);
  }
  await page.mouse.up();
  const t1 = await page.evaluate(() => performance.now());
  const st = await stats();
  const during = st.frameTimes.filter((x) => x > t0 && x <= t1);
  const gaps = during.slice(1).map((x, i) => x - during[i]).sort((p, q) => p - q);
  const median = gaps[Math.floor(gaps.length / 2)];
  const p90 = gaps[Math.floor(gaps.length * 0.9)];
  const script = st.renderMS.slice(-during.length).sort((p, q) => p - q)[Math.floor(during.length / 2)];
  console.log(`    ${during.length} frames in ${((t1 - t0) / 1000).toFixed(1)} s: ${median.toFixed(0)} ms apart (${Math.round(1000 / median)} fps), 90% within ${p90.toFixed(0)} ms, `
    + `${script.toFixed(1)} ms of script each; ${st.software ? 'a software renderer, so the quick mode drew the moving frames' : 'on the GPU'}`);
  assert.notDeepEqual(st.camera, cam0, 'the camera went round');
  assert.ok(during.length >= 20, `only ${during.length} frames while orbiting`);
  assert.ok(median <= 50, `frames ${median.toFixed(0)} ms apart while orbiting`);
  assert.ok(script < 8, `${script.toFixed(1)} ms of script a frame`);
  // Once it stops: the glide eases out, one full frame, and then nothing at all.
  const released = await page.evaluate(() => performance.now());
  await page.waitForFunction(() => !window.mmb.viewer().stats().quick, null, { timeout: 3000 });
  const settled = await page.evaluate(() => performance.now());
  const a = await stats();
  await page.waitForTimeout(700);
  const z = await stats();
  console.log(`    back to the full view ${Math.round(settled - released)} ms after letting go`);
  assert.equal(z.frames, a.frames, 'nothing is drawn while nothing changes');
});

await step('R over a tile in 3D turns it: play, so the board answers at once and nothing grows again', async () => {
  await page.click('#zoom-fit');
  await page.waitForTimeout(250);
  const before = await stats();
  const p = await at3d(300, 300);
  await page.mouse.move(p.x, p.y);
  await page.waitForFunction(() => window.mmb.state.hover?.label === 'B2');
  await page.keyboard.press('r');
  await page.waitForTimeout(250);
  assert.deepEqual((await spec()).rot, { '1,1': 1 });
  assert.equal(await page.evaluate(() => window.mmb.state.grown.stale), false, 'a turn changes nothing printed');
  assert.equal(await page.evaluate(() => window.mmb.state.busy), null, 'and grows nothing');
  const after = await stats();
  assert.equal(after.turned.B2, 1);
  assert.equal(await page.evaluate(() => window.mmb.state.plan.seams.find((s) => s.id === 'B2|N').kind), 'blocked', 'B3 now runs into a bank');
  assert.ok(after.water.B1 < before.water.B1, 'B1\'s river has dried up');
  assert.ok(after.water.B1 > 0, 'but its bay is still there');
  await page.keyboard.press('Control+z');
  await page.waitForTimeout(250);
  assert.equal((await stats()).turned.B2, 0);
  assert.equal((await stats()).water.B1, before.water.B1);
});

await step('a badge in 3D says its sentence, and a click on it selects its seam', async () => {
  const badge = (await stats()).badges.find((x) => x.id === 'B2|N');
  const b = await box3d();
  await page.mouse.move(b.x + badge.x, b.y + badge.y);
  await page.waitForFunction(() => window.mmb.state.hover?.kind === 'seam');
  assert.match(await page.locator('#tip').innerText(), /B3 falls 20 mm into B2/);
  await page.mouse.click(b.x + badge.x, b.y + badge.y);
  await page.waitForTimeout(120);
  assert.deepEqual(await page.evaluate(() => window.mmb.state.selection), { type: 'seam', id: 'B2|N' });
  const t = await at3d(500, 300);
  await page.mouse.click(t.x, t.y);
  await page.waitForTimeout(120);
  assert.deepEqual(await page.evaluate(() => window.mmb.state.selection), { type: 'tile', col: 2, row: 1 });
  assert.match(await page.locator('#inspector').innerText(), /C2/);
});

await step('Board and 3D swap; an out-of-date 3D view says so and still shows what was grown', async () => {
  await page.click('#view-mode button[data-view="2d"]');
  await page.waitForTimeout(100);
  assert.equal(await page.locator('#canvas').isVisible(), true);
  assert.equal(await page.locator('#view3d').isVisible(), false);
  await page.click('#view-mode button[data-view="3d"]');
  await page.waitForTimeout(100);
  assert.equal(await page.locator('#view3d').isVisible(), true);
  await page.click('.stages button[data-stage="draw"]');
  await nothingSelected();
  await field('Seed', 8);
  await page.click('.stages button[data-stage="grow"]');
  await page.waitForTimeout(200);
  assert.equal(await page.evaluate(() => window.mmb.state.grown.stale), true);
  assert.match(await page.locator('#crumbs').innerText(), /from before the last change/);
  assert.equal(await page.locator('#view3d').isVisible(), true);
  assert.equal((await stats()).tiles, 9);
});

await step('nothing went to the console', async () => {
  assert.deepEqual(errors, []);
});

console.log(`\n${passed} passed`);
await browser.close();
server.kill();
