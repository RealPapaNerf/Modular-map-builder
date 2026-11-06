#!/usr/bin/env node
// mmb — build one modular map module from a spec.
//
//   node bin/mmb.mjs example > module.json
//   node bin/mmb.mjs check module.json          the contract and the channels, no ice
//   node bin/mmb.mjs build module.json --out out/
//   node bin/mmb.mjs preview module.json --out preview.png
//   node bin/mmb.mjs canopy --kind conifer --crown 8 --out sheet.png
//   node bin/mmb.mjs plate --height 20 --out plate-20.stl

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { buildTile } from '../lib/build.js';
import { writeSTL } from '../lib/stl.js';
import { meshTile } from '../lib/mesh.js';
import { WIDTHS, EDGES } from '../lib/contract.js';
import { renderTile, encodePNG } from '../lib/preview.js';
import { scatterCanopy } from '../lib/canopy.js';
import { makeField } from '../lib/field.js';
import { trayField } from '../lib/fountain.js';
import { keySheet, keySolid, usableKeys, lockSettings } from '../lib/joint.js';
import { camSheet, camSolid, camSettings } from '../lib/cam.js';
import { plateSolid, plateFields, describePlate, pinSheet, PLATE_HEIGHTS } from '../lib/plate.js';
import { makeContract, classOf } from '../lib/contract.js';
import { EXAMPLE_SPEC } from '../lib/example.js';
import { isBoardSpec, BOARD_SPEC_MESSAGE } from '../lib/scale.js';

function readSpec(path) {
  const raw = JSON.parse(readFileSync(path, 'utf8'));
  if (isBoardSpec(raw)) { console.error(`${path}: ${BOARD_SPEC_MESSAGE}`); process.exit(2); }
  return raw;
}

const args = process.argv.slice(2);
const cmd = args[0];
const flag = (name, dflt = null) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : (i >= 0 ? true : dflt);
};

function describe(r) {
  const lines = [];
  const c = r.contract;
  lines.push(`Contract: a ${c.tileMM} mm module, edge classes ${EDGES.map((e) => `${e} ${classOf(c, e)}`).join(', ')}; ports ${c.portWidthMM} mm wide and ` +
             `${c.channelDepthMM} mm deep in the middle of a side, rebated ${c.grooveDepthMM} mm for silicone at the seam.`);
  for (const n of r.contractNotes) lines.push(`  ${n.severity}: ${n.message}`);
  const errs = r.problems.filter((p) => p.severity === 'error');
  const notes = r.problems.filter((p) => p.severity !== 'error');
  if (errs.length) { lines.push('', 'PROBLEMS:'); for (const p of errs) lines.push(`  error: ${p.message}`); }
  if (notes.length) { lines.push('', 'Notes:'); for (const p of notes) lines.push(`  ${p.severity}: ${p.message}`); }
  return { lines, errs };
}

if (cmd === 'canopy') {
  // A contact sheet across the density range, because the only honest way
  // to pick a number for how thick a wood looks is to look at it.
  const kind = String(flag('kind', 'conifer'));
  const crownMM = Number(flag('crown', 9));
  const heightMM = Number(flag('height', crownMM * 1.1));
  const out = String(flag('out', 'canopy.png'));
  const steps = [0.05, 0.15, 0.3, 0.5, 0.7, 0.85, 1.0];
  const EXT = 70;
  const STEP = Math.min(0.3, crownMM / 24);
  const n = Math.round(EXT / STEP) + 1;
  const GAP = 6;
  const W = n * steps.length + GAP * (steps.length - 1);
  const rgb = new Uint8Array(W * n * 3).fill(16);
  let xoff = 0;
  console.log(`${kind}, ${crownMM} mm crowns:`);
  for (const density of steps) {
    const f = makeField(n, n, STEP);
    f.values.fill(10);
    const r = scatterCanopy(f, { kind, crownMM, heightMM, density, seed: 11 });
    let mx = 10;
    for (const v of f.values) mx = Math.max(mx, v);
    const at = (i, j) => f.values[Math.min(n - 1, Math.max(0, j)) * n + Math.min(n - 1, Math.max(0, i))];
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const gx = (at(i + 1, j) - at(i - 1, j)) / (2 * STEP);
        const gy = (at(i, j + 1) - at(i, j - 1)) / (2 * STEP);
        const sh = Math.max(0.06, (-gx * -0.55 + -gy * -0.55 + 0.63) / Math.hypot(-gx, -gy, 1));
        const h = (f.values[j * n + i] - 10) / Math.max(1e-6, mx - 10);
        const k = ((n - 1 - j) * W + xoff + i) * 3;
        const g = 40 + h * 150;
        rgb[k] = Math.min(255, g * 0.55 * sh * 1.9);
        rgb[k + 1] = Math.min(255, g * 1.05 * sh * 1.9);
        rgb[k + 2] = Math.min(255, g * 0.5 * sh * 1.9);
      }
    }
    console.log(`  density ${String(density).padEnd(5)} spacing ${r.spacingMM.toFixed(1).padStart(5)} mm  ` +
                `${String(r.trees).padStart(4)} trees  ${(100 * r.coverFraction).toFixed(0).padStart(3)}% cover`);
    xoff += n + GAP;
  }
  writeFileSync(out, encodePNG(rgb, W, n));
  console.log(`\n${out}: ${steps.length} patches, ${EXT} mm square, left to right in the order above.`);
} else if (cmd === 'plate') {
  // A spacer plate, on its own: not part of any module.
  const spec = args[1] && !args[1].startsWith('--') ? readSpec(args[1]) : {};
  const c = makeContract(spec.contract || {});
  const lock = lockSettings(spec.locks || {});
  const heights = flag('height') && flag('height') !== true ? String(flag('height')).split(',').map(Number) : [20];
  for (const h of heights) {
    const t0 = Date.now();
    const p = plateFields(c, lock, { ...(spec.plates || {}), heightMM: h });
    const tris = plateSolid(c, lock, { ...(spec.plates || {}), heightMM: h });
    const out = heights.length === 1 && flag('out') && flag('out') !== true ? String(flag('out')) : `plate-${h}.stl`;
    writeFileSync(out, writeSTL(tris, `spacer plate ${h} mm`));
    console.log(`${out}: ${describePlate(p)}; ${(tris.length / 9).toLocaleString()} triangles, ${((Date.now() - t0) / 1000).toFixed(1)}s.`);
  }
  writeFileSync('pins.stl', writeSTL(pinSheet(4 * heights.length, lock, spec.plates || {}), 'stack pins'));
  console.log(`pins.stl: ${4 * heights.length} pins, four for each plate: one in each corner socket, into whatever stands on it.`);
  if (!heights.every((h) => PLATE_HEIGHTS.includes(h))) console.log(`(The usual heights are ${PLATE_HEIGHTS.join(', ')} mm; any from 10 up will do.)`);
} else if (cmd === 'example') {
  process.stdout.write(JSON.stringify(EXAMPLE_SPEC, null, 2) + '\n');
} else if (cmd === 'check' || cmd === 'build' || cmd === 'preview') {
  const specPath = args[1];
  if (!specPath) { console.error('need a spec file; try: node bin/mmb.mjs example > module.json'); process.exit(2); }
  const spec = readSpec(specPath);
  if (cmd === 'check') spec.glacier = false; // check is about the contract, not the rock
  const t0 = Date.now();
  const r = buildTile(spec, (m) => process.stderr.write(`\r${m.padEnd(40)}`));
  process.stderr.write('\r'.padEnd(42) + '\r');
  const t = r.tile;

  if (cmd === 'preview') {
    const out = String(flag('out', 'preview.png'));
    writeFileSync(out, renderTile(t, { px: Number(flag('px', 512)) }).png);
    console.log(`${out}: the module hillshaded, in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    process.exit(0);
  }

  const { lines, errs } = describe(r);
  console.log(lines.join('\n'));

  console.log('\nEdges:');
  for (const e of EDGES) console.log(`  ${e}  ${t.signatures[e].padEnd(22)} err ${t.edges[e].toFixed(4)} mm`);
  console.log(`  worst edge error ${t.edges.worst.toFixed(4)} mm — ${t.edges.worst < 1e-6 ? 'it mates' : 'it does NOT mate'}`);

  if (t.channels.length) {
    console.log('\nChannels:');
    for (const ch of t.channels) {
      const ends = `${ch.from ? `in at ${ch.from}` : 'starts inside'}, ${ch.to ? `out at ${ch.to}` : 'ends inside'}`;
      console.log(`  ${ch.name.padEnd(10)} ${ch.widthMM} mm wide, ${ch.depthMM} mm deep, ${ch.lengthMM.toFixed(0)} mm long; ${ends}` +
                  `${ch.routed ? ' (routed down the valley)' : ''}; floor ${ch.startFloorMM.toFixed(1)} → ${ch.endFloorMM.toFixed(1)} mm` +
                  `${ch.gorgeMM > 0.5 ? `, a gorge ${ch.gorgeMM.toFixed(1)} mm deeper than drawn through high ground` : ''}${ch.pondMM > 0.5 ? `, ponds ${ch.pondMM.toFixed(1)} mm behind its exit` : ''}`);
    }
  }

  if (t.keys.length || t.keysRefused.length) {
    const cams = t.keys.filter((k) => k.kind === 'cam');
    console.log(`\nCam lock: ${cams.length} cam housing(s) and ${usableKeys(r).length} key pocket(s), ${t.sockets.length} corner socket(s); ${t.keysRefused.length + t.socketsRefused.length} left out.`);
    console.log(`  An ${r.joint.camMM} mm cam, a quarter turn with a coin, draws the key's head ${r.joint.drawMM} mm and the faces together. ` +
                `Print one key per pocket and one cam per housing, ${t.camHeights.join(', ')} mm tall.`);
    console.log('  It all goes in from the underside: lay the modules face down, butted together, drop a key into each seam (pad in the ' +
                'pocket, head in the next module\'s bore), drop a cam into each bore over the head, coin slot up, turn it a quarter turn, ' +
                'and turn the map over. Nothing shows on top.');
    for (const k of [...t.keysRefused, ...t.socketsRefused]) console.log(`  ${k.id} left out: ${k.why}`);
  }
  for (const sp of t.springs) {
    console.log(`\nSpring at ${sp.atMM.map((v) => v.toFixed(0)).join(',')} mm — pool bed ${sp.bedMM.toFixed(1)} mm, spills at ${sp.spillMM.toFixed(1)} mm, ` +
                `${(sp.bore.rMM * 2).toFixed(1)} mm bore for ${sp.tubeOdMM} mm tube.`);
  }
  if (t.lakes.length) {
    const byKind = {};
    for (const l of t.lakes) byKind[l.what] = (byKind[l.what] || 0) + 1;
    console.log(`\nStanding water: ${Object.entries(byKind).map(([k, v]) => `${v} ${k}${v > 1 ? 's' : ''}`).join(', ')}, ` +
                `${t.millilitres.toFixed(1)} ml of epoxy in all.`);
    for (const l of [...t.lakes].sort((a, b) => b.millilitres - a.millilitres).slice(0, 6)) {
      console.log(`  ${l.what.padEnd(6)} ${l.areaMM2.toFixed(0).padStart(6)} mm2  ${l.deepestMM.toFixed(1).padStart(4)} mm deep  ${l.millilitres.toFixed(2).padStart(6)} ml`);
    }
  }
  for (const sk of t.lakesSkipped) console.log(`  ${sk.what} not carved — ${sk.why}`);
  if (t.lakes.some((l) => l.shape)) {
    console.log('\nLakes, for a resize (lakes.resize: [{ atMM, lengthMM, widthMM }] or { atMM, fill: true }):');
    for (const l of t.lakes.filter((x) => x.shape)) {
      console.log(`  ${l.what.padEnd(6)} at ${l.shape.atMM.map((v) => v.toFixed(0)).join(', ')} mm: ${l.shape.lengthMM.toFixed(0)} long × ${l.shape.widthMM.toFixed(0)} wide` +
                  `${l.resized ? ` (resized from ${l.asDug.lengthMM.toFixed(0)} × ${l.asDug.widthMM.toFixed(0)})` : ''}`);
    }
  }
  console.log(`\nThe module: ${t.trees} trees, prints ${t.bbox.size[2].toFixed(1)} mm tall (land ${t.lowMM.toFixed(1)}–${t.highMM.toFixed(1)} mm), ` +
              `${t.mesh.triangles.toLocaleString()} triangles, ${t.mesh.watertight ? 'closed' : 'LEAKS'}.`);
  if (r.world.glacierStats) {
    const g = r.world.glacierStats;
    console.log(`Ice: ELA ${g.elaM.toFixed(0)} m, ${(g.glaciatedFraction * 100).toFixed(0)}% of the world glaciated at some point, ` +
                `up to ${g.maxIceM.toFixed(0)} m thick, cutting up to ${g.maxIncisionM.toFixed(0)} m. ` +
                `${g.iceBeforeMeltM.toFixed(0)} m of it was left when the climate finished; it melted out in ${g.meltYears} years, ` +
                `and ${g.finalIceM.toFixed(1)} m remains.`);
    if (g.runaway) console.log('  WARNING: ice is against its ceiling — this climate builds an ice cap, not valley glaciers. Raise glacier.elaMM.');
  }

  if (cmd === 'build') {
    if (errs.length) { console.error('\nNot writing STLs while the contract is broken.'); process.exit(1); }
    const dir = String(flag('out', 'out'));
    mkdirSync(dir, { recursive: true });
    const name = spec.name || 'module';
    writeFileSync(join(dir, `${name}.stl`), writeSTL(t.tris, name));
    const usable = usableKeys(r).length;
    const written = [];
    if (usable) {
      writeFileSync(join(dir, 'keys.stl'), writeSTL(keySheet(usable, r.joint), 'lock keys'));
      writeFileSync(join(dir, 'key-one.stl'), writeSTL(keySolid(r.joint), 'lock key'));
      written.push('keys.stl', 'key-one.stl');
    }
    const camHeights = t.keys.filter((k) => k.kind === 'cam').map((k) => k.heightMM);
    if (camHeights.length) {
      writeFileSync(join(dir, 'cams.stl'), writeSTL(camSheet(camSettings(r.joint), camHeights), 'lock cams'));
      writeFileSync(join(dir, 'cam-one.stl'), writeSTL(camSolid(camSettings(r.joint), camHeights[0]), 'lock cam'));
      written.push('cams.stl', 'cam-one.stl');
    }
    const plates = flag('plates');
    if (plates && plates !== true) {
      for (const h of String(plates).split(',').map(Number).filter((v) => v >= 10)) {
        writeFileSync(join(dir, `plate-${h}.stl`), writeSTL(plateSolid(r.contract, r.joint, { ...(spec.plates || {}), heightMM: h }), `spacer plate ${h} mm`));
        written.push(`plate-${h}.stl`);
      }
      writeFileSync(join(dir, 'pins.stl'), writeSTL(pinSheet(8, r.joint, spec.plates || {}), 'stack pins'));
      written.push('pins.stl');
    }
    writeFileSync(join(dir, 'preview.png'), renderTile(t).png);
    if (t.springs.length) {
      const tray = trayField(makeField, { widthMM: r.contract.tileMM, depthMM: r.contract.tileMM, ...(spec.tray || {}) });
      writeFileSync(join(dir, 'tray.stl'), writeSTL(meshTile(tray.field), 'tray'));
      console.log(`tray.stl: ${tray.outerMM.map((v) => v.toFixed(0)).join(' x ')} x ${tray.heightMM} mm, the module rests at ${tray.sitsAtMM} mm.`);
    }
    console.log(`\nWrote ${[`${name}.stl`, ...written, 'preview.png'].join(', ')} to ${dir}/ in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  }
} else {
  console.log(`mmb — modular map builder: one module at a time

  node bin/mmb.mjs example > module.json      a spec to start from
  node bin/mmb.mjs check module.json          the contract and the channels, no ice
  node bin/mmb.mjs build module.json --out out/
  node bin/mmb.mjs preview module.json --out preview.png
  node bin/mmb.mjs canopy --kind conifer --crown 8 --out sheet.png
  node bin/mmb.mjs plate --height 10,20,30,40       spacer plates, ${PLATE_HEIGHTS.join('/')} mm
  node bin/mmb.mjs build module.json --out out/ --plates 10,20

Channel widths the editor offers: ${WIDTHS.join(', ')} mm bank to bank; any width goes in the spec.`);
}
