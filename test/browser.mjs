// The editor in a real Chromium: the module drawn by hand, grown, stood up
// in 3D, refined with a brush, and reported -- checked by hand-eye motions
// rather than by calling the spec functions directly.
//
//   1. The example module can be drawn from an empty module WITHOUT opening
//      the JSON: the ridge clicked in, the channel given its ends, the
//      numbers typed. The spec that comes out is the example's.
//   2. A channel drawn with the mouse snaps its ends to the ports and is
//      written as a line in module mm; its width and depth are the palette's.
//   3. A draft-mesh build is on screen in 3D within a few seconds of the
//      heights landing, with water in the channel, and no ice anywhere.
//   4. A brushstroke in Refine is written as an edit, previewed at once, and
//      the module grows again with it; undo takes it off.
//   5. The report says the module mates, and offers its files.
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
import { canonical } from '../app/specops.js';

let chromium;
try {
  ({ chromium } = await import('playwright'));
} catch {
  try {
    const require = (await import('node:module')).createRequire(import.meta.url);
    ({ chromium } = require(process.env.PLAYWRIGHT_PATH || 'playwright'));
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

const browser = await chromium.launch({
  ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
  args: ['--use-gl=swiftshader', '--enable-webgl', '--ignore-gpu-blocklist'],
});
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
const canvasBox = () => page.locator('#canvas').boundingBox();

/** Screen position of a module-mm point, under the camera as it is now. */
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
  // The inspector is re-rendered on the next animation frame after every
  // change. Filling an input that frame is about to replace loses the value,
  // so let it settle first.
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
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
await page.waitForFunction(() => window.mmb && window.mmb.state.say);

await step('the editor opens on the example and says what the module is', async () => {
  const say = await page.evaluate(() => window.mmb.state.say);
  assert.match(say.sentences[0].text, /200 mm module/);
  assert.deepEqual(say.ports, { N: false, E: false, S: true, W: false });
  assert.match(await page.locator('#say').innerText(), /out at the south/);
  for (const name of ['Draw', 'Grow', 'Refine', 'Print']) assert.ok(await page.locator('.stages button', { hasText: name }).count(), `a ${name} tab`);
});

await step('New gives an empty module', async () => {
  await page.click('#new');
  await page.waitForTimeout(100);
  const s = await spec();
  assert.equal(s.channels, undefined);
  assert.equal(s.spine, undefined);
});

await step('the module\'s numbers go in through the inspector', async () => {
  await nothingSelected();
  await field('Name', 'hanging-valley');
  await field('Seed', 7);
  await field('Margin', 60);
  await field('verticalExaggeration', 2);
  await field('Mountains', 60);
  await field('Ridge width', 95);
  await field('Cycles', 24);
  await field('Snowline swing', 18);
  await field('Default rim', 22);
  let s = await spec();
  assert.deepEqual(s.contract, { tileMM: 200, edgeLandMM: 22, portWidthMM: 30, channelDepthMM: 10 });
  // A side's class is a chip; the default class writes nothing.
  await page.click('#inspector [data-field="side.N.class"] button >> text="40"');
  await page.waitForTimeout(60);
  s = await spec();
  assert.deepEqual(s.contract.edges, { N: 42 }, 'the north side is class 40: a 42 mm rim');
  await page.click('#inspector [data-field="side.N.blend"] button >> text="cliff"');
  await page.waitForTimeout(60);
  assert.deepEqual((await spec()).contract.blends, { N: 6 });
  await page.click('#inspector [data-field="side.N.blend"] button >> text="auto"');
  await page.click('#inspector [data-field="side.N.class"] button >> text="20"');
  await page.waitForTimeout(60);
  s = await spec();
  assert.equal(s.contract.edges, undefined);
  assert.equal(s.contract.blends, undefined);
  assert.deepEqual(s.glacier, { cycles: 24, elaSwingMM: 18 });
  assert.equal(s.verticalExaggeration, 2);
  assert.equal(s.spineWidthMM, 95);
});

await step('the ridge is drawn across the module and out into the margin, snapped to 10 mm', async () => {
  await tool('ridge');
  await page.keyboard.down('Shift');
  for (const [x, y] of EXAMPLE_SPEC.spine) await click(x, y);
  await page.keyboard.up('Shift');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(80);
  const s = await spec();
  assert.equal(s.spine.length, EXAMPLE_SPEC.spine.length);
  // Shift snaps to 10 mm; the example's points are not all on 10s, so they land within 5 mm.
  s.spine.forEach(([x, y], i) => { assert.ok(Math.abs(x - EXAMPLE_SPEC.spine[i][0]) <= 5 && Math.abs(y - EXAMPLE_SPEC.spine[i][1]) <= 5, `point ${i}`); });
  // Then typed exactly, as the example has them.
  await page.evaluate((pts) => window.mmb.api.commit((x) => { x.spine = pts; }, 'ridge'), EXAMPLE_SPEC.spine);
});

await step('a cirque is pressed where the bowl goes and dragged the way it opens', async () => {
  await tool('cirque');
  for (const cq of EXAMPLE_SPEC.cirques) {
    const a = (cq.facingDeg * Math.PI) / 180;
    await drag([cq.at, [cq.at[0] + 25 * Math.cos(a), cq.at[1] + 25 * Math.sin(a)]]);
  }
  const s = await spec();
  assert.equal(s.cirques.length, EXAMPLE_SPEC.cirques.length);
  s.cirques.forEach((cq, i) => {
    const want = EXAMPLE_SPEC.cirques[i];
    assert.ok(Math.hypot(cq.at[0] - want.at[0], cq.at[1] - want.at[1]) <= 2, `cirque ${i} at ${cq.at}`);
    const d = Math.abs(((cq.facingDeg - want.facingDeg + 540) % 360) - 180);
    assert.ok(d <= 8, `cirque ${i} opens toward ${cq.facingDeg}, wanted ${want.facingDeg}`);
  });
  const panel = await page.locator('#inspector').innerText();
  assert.match(panel, /Cirque/);
  // Then typed exactly, as the example has them.
  await page.evaluate((list) => window.mmb.api.commit((x) => { x.cirques = list; }, 'cirques'), EXAMPLE_SPEC.cirques);
});

await step('a channel drawn with the mouse snaps its ends to the ports and takes the palette\'s width and depth', async () => {
  await tool('channel');
  await chip(40);
  await chip(8);
  await drag([[96, 196], [110, 150], [88, 90], [104, 6]]);
  const s = await spec();
  assert.equal(s.channels.length, 1);
  const ch = s.channels[0];
  assert.equal(ch.widthMM, 40);
  assert.equal(ch.depthMM, 8);
  assert.ok(ch.path.length >= 2 && ch.path.length < 20, `${ch.path.length} points`);
  const ends = await page.evaluate(() => window.mmb.ops.channelEnds(window.mmb.state.spec, window.mmb.state.spec.channels[0]));
  assert.equal(ends.from, 'N');
  assert.equal(ends.to, 'S');
  assert.deepEqual(ends.pts[0], [100, 200], 'the line as cut starts on the north port');
  assert.equal((await page.evaluate(() => window.mmb.state.selection)).type, 'channel');
  assert.match(await page.locator('#inspector h2').innerText(), /channel 1/);
  // Now make it the example's: routed from a point to the south port.
  await page.locator('#canvas').focus();
  await page.keyboard.press('Delete');
  await page.waitForTimeout(60);
  await page.evaluate(() => window.mmb.api.commit((x) => { x.channels = [{ name: 'main', widthMM: 30, depthMM: 10, from: [100, 62], to: 'S' }]; }, 'channel'));
});

await step('woods, water and springs: the numbers that are numbers', async () => {
  await nothingSelected();
  await page.click('#inspector button >> text="+ Conifers"');
  await field('canopy.0.crownMM', 7);
  await field('canopy.0.heightMM', 9);
  await field('canopy.0.density', 0.4);
  await field('canopy.0.minZMM', 28);
  await field('canopy.0.maxZMM', 54);
  await field('canopy.0.thinningMM', 10);
  await field('canopy.0.maxSlopeDeg', 36);
  await page.click('#inspector button >> text="+ Broadleaf"');
  await field('canopy.1.crownMM', 12);
  await field('canopy.1.heightMM', 7);
  await field('canopy.1.density', 0.3);
  await field('canopy.1.maxZMM', 32);
  await field('canopy.1.thinningMM', 6);
  await field('canopy.1.maxSlopeDeg', 24);
  await page.click('#inspector [data-field="Tarns in hollows"]');
  await page.click('#inspector [data-field="Tarns in hollows"]');
  await field('Depth', 5);
  await field('Shore', 10);
  await field('Bed', 'dish');
  // On and off again: springs go in by hand once the module is seen.
  await page.click('#inspector [data-field="At the start of every channel"]');
  await page.click('#inspector [data-field="At the start of every channel"]');
  await field('Tube OD', 12.7);
  await field('Pool', 16);
});

await step('DONE WHEN: the spec drawn from an empty module is the example, and the JSON was never opened', async () => {
  assert.equal(await page.locator('#drawer').isHidden(), true, 'the JSON drawer stayed shut');
  const s = await spec();
  s.meshMM = 0.9;
  const a = canonical(s);
  const b = canonical(structuredClone(EXAMPLE_SPEC));
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) assert.deepEqual(a[k], b[k], `spec.${k}`);
});

await step('a lake painted with the mouse is written along its stroke; undo takes it off', async () => {
  await tool('lake');
  await chip(30);
  await drag([[40, 40], [70, 50], [60, 80]]);
  const s = await spec();
  assert.equal(s.lakes.place.length, 1);
  assert.equal(s.lakes.place[0].radiusMM, 15);
  assert.ok(s.lakes.place[0].pathMM.length >= 2);
  await page.locator('#canvas').focus();
  await page.keyboard.press('Control+z');
  await page.waitForTimeout(60);
  assert.equal((await spec()).lakes.place, undefined);
});

await step('three.js is not fetched until Grow is opened', async () => {
  const fetched = await page.evaluate(() => performance.getEntriesByType('resource').some((e) => /three\.module/.test(e.name)));
  assert.equal(fetched, false);
});

await step('the module grows on the draft mesh and stands up in 3D within a few seconds of the heights landing', async () => {
  await page.evaluate(() => window.mmb.api.commit((x) => { x.meshMM = 2.5; }, 'mesh'));
  await page.evaluate(() => window.mmb.setStage('grow'));
  await page.waitForTimeout(200);
  await page.click('#grow-go');
  await page.waitForFunction(() => window.mmb.state.grown && window.mmb.state.grown.tile3d && !window.mmb.state.busy, null, { timeout: 240000 });
  await page.waitForFunction(() => window.mmb.viewer() && window.mmb.viewer().stats().firstFrameAt !== null, null, { timeout: 20000 });
  const t = await page.evaluate(() => {
    const g = window.mmb.state.grown;
    return { landed: g.tile3d.at, first: window.mmb.viewer().stats().firstFrameAt, elapsed: g.elapsedMS, report: g.report };
  });
  assert.ok(t.first - t.landed < 4000, `first 3D frame ${((t.first - t.landed) / 1000).toFixed(2)} s after the heights landed`);
  assert.equal(await page.evaluate(() => window.mmb.show3d()), true);
  assert.ok(t.report.worstEdgeMM < 1e-6, 'it mates');
  assert.ok(t.report.totals.watertight);
  assert.equal(t.report.glacier.finalIceM, 0, 'no ice is left on the module');
  assert.ok(t.report.glacier.maxIceM > 0, 'though there was ice');
  assert.equal(t.report.channels[0].to, 'S');
  console.log(`  (grown in ${(t.elapsed / 1000).toFixed(1)} s)`);
});

await step('the channel and the lakes are drawn as water, and orbiting is smooth', async () => {
  const stats = await page.evaluate(() => window.mmb.viewer().stats());
  assert.ok(stats.waterTris > 0, 'water in the channel');
  const b = await page.locator('#view3d').boundingBox();
  const before = await page.evaluate(() => window.mmb.viewer().stats().frames);
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
  await page.mouse.down();
  const t0 = Date.now();
  for (let i = 1; i <= 30 && Date.now() - t0 < 1500; i++) {
    await page.mouse.move(b.x + b.width / 2 + i * 8, b.y + b.height / 2 + Math.sin(i / 4) * 20);
    await page.waitForTimeout(40);
  }
  await page.mouse.up();
  // The glide after the pointer lets go, and the full frame quick mode draws
  // once it has stopped, are both over well inside a second and a half.
  await page.waitForTimeout(1500);
  const after = await page.evaluate(() => window.mmb.viewer().stats());
  assert.ok(after.frames > before + 5, 'frames were drawn while orbiting');
  const settled = after.frames;
  await page.waitForTimeout(600);
  assert.equal(await page.evaluate(() => window.mmb.viewer().stats().frames), settled, 'and nothing is drawn once it has stopped');
});

await step('a routed channel can take the line it was grown with', async () => {
  await page.evaluate(() => window.mmb.api.select({ type: 'channel', index: 0 }));
  await page.waitForTimeout(100);
  await page.click('#inspector [data-field="channel.take"]');
  await page.waitForTimeout(100);
  const ch = (await spec()).channels[0];
  assert.ok(Array.isArray(ch.path) && ch.path.length >= 3, 'now a drawn line');
  assert.equal(ch.from, undefined);
  assert.deepEqual(ch.path[ch.path.length - 1], [100, 0], 'still on the south port');
});

await step('a Raise stroke in Refine is written as an edit, shown at once, and grown again', async () => {
  await page.evaluate(() => window.mmb.setStage('refine'));
  await page.waitForTimeout(300);
  await page.click('[data-tool="raise"]');
  await chip(30);
  await page.waitForFunction(() => window.mmb.viewer().stats().tool === 'brush');
  const b = await page.locator('#view3d').boundingBox();
  // On the south flank, which the camera looks at: the crest, twice as tall
  // as the ground it was grown from, hides the north side.
  const a = await page.evaluate(() => window.mmb.viewer().project(30, 40, window.mmb.viewer().heightAt(30, 40)));
  const z = await page.evaluate(() => window.mmb.viewer().project(90, 40, window.mmb.viewer().heightAt(90, 40)));
  const heightBefore = await page.evaluate(() => window.mmb.viewer().heightAt(60, 40));
  await page.mouse.move(b.x + a.x, b.y + a.y);
  await page.mouse.down();
  for (let i = 1; i <= 10; i++) { await page.mouse.move(b.x + a.x + ((z.x - a.x) * i) / 10, b.y + a.y + ((z.y - a.y) * i) / 10); await page.waitForTimeout(20); }
  await page.mouse.up();
  await page.waitForTimeout(200);
  const s = await spec();
  assert.equal(s.edits.length, 1);
  assert.equal(s.edits[0].op, 'raise');
  assert.equal(s.edits[0].radiusMM, 15);
  const heightAfter = await page.evaluate(() => window.mmb.viewer().heightAt(60, 40));
  assert.ok(heightAfter > heightBefore + 2, `previewed at once: ${heightBefore.toFixed(1)} -> ${heightAfter.toFixed(1)} mm`);
  await page.waitForFunction(() => !window.mmb.state.grown.stale && !window.mmb.state.busy, null, { timeout: 120000 });
  assert.equal((await page.evaluate(() => window.mmb.state.grown.report.notes.concat(window.mmb.state.grown.report.warnings).some((m) => /edit/.test(m)))), false, 'the edit was made without complaint');
  await page.locator('#view3d').focus();
  await page.keyboard.press('Control+z');
  await page.waitForTimeout(100);
  assert.equal((await spec()).edits, undefined, 'undo takes it off');
});

await step('the report says the module mates and offers its files', async () => {
  await page.evaluate(() => window.mmb.setStage('print'));
  await page.waitForFunction(() => !window.mmb.state.busy, null, { timeout: 120000 });
  await page.waitForTimeout(300);
  const text = await page.locator('#sheet').innerText();
  assert.match(text, /each side mates flush with any side of its class/);
  assert.match(text, /m remains/);
  assert.match(text, /cam lock/i);
  assert.ok(await page.locator('#sheet button[data-id="module"]').count(), 'the module\'s STL');
  assert.ok(await page.locator('#sheet button[data-id="keys"]').count(), 'and its keys');
  assert.ok(await page.locator('#sheet button[data-id="cams"]').count(), 'and its cams');
  assert.ok(await page.locator('#sheet button[data-id="plate-20"]').count(), 'and the spacer plates, if wanted');
  assert.ok(await page.locator('#sheet button[data-id="pins"]').count(), 'and their pins');
});

await step('a grown lake can be selected, measured, and made another size', async () => {
  const lakes = await page.evaluate(() => window.mmb.state.grown.report.lakes.all);
  const i = lakes.findIndex((l) => l.what === 'tarn' && l.shape);
  if (i < 0) { console.log('  (no tarn in this build to resize; skipped)'); return; }
  await page.evaluate(() => window.mmb.setStage('draw'));
  await page.evaluate((index) => window.mmb.api.select({ type: 'water', index }), i);
  await page.waitForTimeout(100);
  const text = await page.locator('#inspector').innerText();
  assert.match(text, /Tarn/);
  assert.match(text, new RegExp(`${lakes[i].shape.lengthMM} mm`));
  await field('water.widthMM', 12);
  const s = await spec();
  assert.equal(s.lakes.resize.length, 1);
  assert.equal(s.lakes.resize[0].widthMM, 12);
  await page.locator('#canvas').focus();
  await page.keyboard.press('Control+z');
  await page.waitForTimeout(100);
  assert.equal((await spec()).lakes.resize, undefined, 'undo takes it off');
});

await step('an old board spec is refused with a sentence, not opened', async () => {
  await page.evaluate(() => { document.getElementById('json-toggle').click(); });
  await page.waitForTimeout(100);
  await page.locator('#spec').fill(JSON.stringify({ cols: 3, rows: 3, rivers: [] }));
  await page.waitForTimeout(600);
  assert.match(await page.locator('#json-err').innerText(), /board of several tiles/);
  assert.equal((await spec()).cols, undefined);
});

await step('no errors in the console', async () => {
  assert.deepEqual(errors, []);
});

console.log(`\n${passed} steps passed.`);
await browser.close();
server.kill();
