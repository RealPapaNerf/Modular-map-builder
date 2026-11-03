#!/usr/bin/env node
// mmb — build modular map tiles from a spec.
//
//   node bin/mmb.mjs build <spec.json> --out tiles/
//   node bin/mmb.mjs check <spec.json>
//   node bin/mmb.mjs plate --size 200 --thick 10 --out plate.stl
//   node bin/mmb.mjs preview <spec.json> --out preview.png
//   node bin/mmb.mjs example > map.json

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { buildMap } from '../lib/build.js';
import { writeSTL, plateSTL } from '../lib/stl.js';
import { makeContract, check, SIZES, SIZE_LADDER, FALLS, sizeFor } from '../lib/contract.js';
import { renderMap, encodePNG } from '../lib/preview.js';
import { scatterCanopy, spacingForDensity } from '../lib/canopy.js';
import { makeField } from '../lib/field.js';

const args = process.argv.slice(2);
const cmd = args[0];
const flag = (name, dflt = null) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : (i >= 0 ? true : dflt);
};

const EXAMPLE = {
  name: 'glacier-valley',
  seed: 7,
  cols: 3,
  rows: 3,
  reliefMM: 42,
  meshMM: 0.9,
  worldSizeM: 16000,
  spineHeightM: 1600,
  spine: [[0.1, 0.85], [0.5, 0.6], [0.9, 0.8]],
  volcanoes: [{ at: [0.78, 0.22], heightM: 800, baseRadiusM: 2400, breachAzimuthDeg: 210 }],
  glacier: { cycles: 30 },
  // Steep at the head, gentler as it goes down. Falls are per tile, in whole
  // plates, 10 to 50.
  falls: { '1,2': 40, '1,1': 30, '1,0': 10, '2,1': 20 },
  // An extra 20 mm of free-fall where the tributary comes off the bench.
  waterfalls: { '1,1': 20 },
  rivers: [
    // Sizes left out are worked out from the inflow and the fall.
    { name: 'main', sourceEdge: 'N', path: [[1, 2], [1, 1], [1, 0]], sinkEdge: 'S', size: 'creek' },
    { name: 'trib', sourceEdge: 'E', path: [[2, 1], [1, 1]], size: 'creek' },
  ],
  // Woods. maxZMM is a treeline and it is the cheapest thing in the file
  // that makes a mountain read right; maxSlopeDeg keeps them off the cliffs.
  canopy: [
    { kind: 'conifer', crownMM: 7, heightMM: 9, density: 0.62,
      minZMM: 34, maxZMM: 96, thinningMM: 18, maxSlopeDeg: 36 },
    { kind: 'deciduous', crownMM: 12, heightMM: 7, density: 0.5,
      maxZMM: 40, thinningMM: 10, maxSlopeDeg: 24 },
  ],
  contract: { tileMM: 200, plateMM: 10, outletZMM: 2, edgeLandMM: 18 },
};

function describe(r) {
  const lines = [];
  lines.push(`Contract: ${r.contract.tileMM} mm tiles on ${r.contract.plateMM} mm plates, outlet at ` +
             `${r.contract.outletZMM} mm, falls ${FALLS.join('/')} mm, seam ${r.seam.style}.`);
  for (const n of r.contractNotes) lines.push(`  ${n.severity}: ${n.message}`);
  const errs = r.problems.filter((p) => p.severity === 'error');
  const notes = r.problems.filter((p) => p.severity !== 'error');
  if (errs.length) { lines.push('', 'PROBLEMS:'); for (const p of errs) lines.push(`  error: ${p.message}`); }
  if (notes.length) { lines.push('', 'Notes:'); for (const p of notes) lines.push(`  ${p.message}`); }
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
} else if (cmd === 'example') {
  process.stdout.write(JSON.stringify(EXAMPLE, null, 2) + '\n');
} else if (cmd === 'plate') {
  const size = Number(flag('size', 200));
  const thick = Number(flag('thick', 10));
  const out = String(flag('out', 'plate.stl'));
  writeFileSync(out, plateSTL(size, size, thick));
  console.log(`${out}: ${size} x ${size} x ${thick} mm plate`);
} else if (cmd === 'check' || cmd === 'build') {
  const specPath = args[1];
  if (!specPath) { console.error('need a spec file; try: node bin/mmb.mjs example > map.json'); process.exit(2); }
  const spec = JSON.parse(readFileSync(specPath, 'utf8'));
  if (cmd === 'check') spec.glacier = false; // check is about the contract, not the rock
  const t0 = Date.now();
  const r = buildMap(spec, (m) => process.stderr.write(`\r${m.padEnd(40)}`));
  process.stderr.write('\r'.padEnd(42) + '\r');

  const { lines, errs } = describe(r);
  console.log(lines.join('\n'));

  console.log('\nTiles:');
  let worstEdge = 0;
  let leaks = 0;
  for (const t of r.tiles) {
    worstEdge = Math.max(worstEdge, t.edges.worst);
    if (!t.mesh.watertight) leaks++;
    const ports = ['N', 'E', 'S', 'W']
      .filter((e) => t.spec.edges?.[e] && t.spec.edges[e].type !== 'land')
      .map((e) => `${e}:${t.spec.edges[e].type === 'in' ? '>' : '<'}${sizeFor(t.spec.edges[e].size).widthMM}`)
      .join(' ') || '-';
    console.log(
      `  ${t.label.padEnd(4)} ${String(t.stack.plates).padStart(2)} plates ` +
      `(${String(t.stack.standMM).padStart(3)} mm) fall ${String(t.fallMM).padStart(2)}  ` +
      `${ports.padEnd(20)} ${String(t.trees || 0).padStart(4)} trees  ` +
      `prints ${t.bbox.size[2].toFixed(1).padStart(5)} mm, ` +
      `edge err ${t.edges.worst.toFixed(4)}, ` +
      `${t.mesh.watertight ? 'closed' : 'LEAKS'}`,
    );
  }
  const kinds = {};
  for (const s2 of r.seamChecks) kinds[s2.kind] = (kinds[s2.kind] || 0) + 1;
  const interesting = r.seamChecks.filter((s2) => s2.kind !== 'plane');
  if (interesting.length) {
    console.log('\nSeams that are not flat:');
    for (const s2 of interesting) {
      const h = s2.waterStepMM != null && Math.abs(s2.waterStepMM) > 1e-6
        ? `${Math.abs(s2.waterStepMM).toFixed(0)} mm of water`
        : `${Math.abs(s2.landStepMM).toFixed(0)} mm of land`;
      console.log(`  ${s2.from} ${s2.edge} to ${s2.to}: ${s2.kind.toUpperCase()}, ${h}`);
    }
  }
  console.log(`\nSeams: ${Object.entries(kinds).map(([k, v]) => `${v} ${k}`).join(', ')}`);
  const maxLevel = Math.max(...r.tiles.map((t) => t.level));
  console.log(`\nWorst edge error across every tile: ${worstEdge.toFixed(4)} mm`);
  console.log(`Tallest stack: ${maxLevel} plates (${maxLevel * r.contract.plateMM} mm) under the highest tile.`);
  if (maxLevel > r.contract.maxStackPlates) {
    console.log(`  WARNING: that is ${maxLevel * r.contract.plateMM} mm of plates before the terrain starts. ` +
                `Gentler falls, or a shorter river, would bring it down.`);
  }
  console.log(`Total plates to print: ${r.tiles.reduce((a, t) => a + t.stack.plates, 0)}`);
  if (leaks) console.log(`${leaks} tile(s) did not come out closed.`);
  if (r.world.glacierStats) {
    const g = r.world.glacierStats;
    console.log(`\nIce: ELA ${g.elaM.toFixed(0)} m, ${(g.glaciatedFraction * 100).toFixed(0)}% of the map glaciated, ` +
                `up to ${g.maxIceM.toFixed(0)} m thick, sliding to ${g.maxSlideMPerYear.toFixed(0)} m/yr, ` +
                `cutting up to ${g.maxIncisionM.toFixed(0)} m.`);
    if (g.runaway) console.log('  WARNING: ice is against its ceiling — this climate builds an ice cap, not valley glaciers. Raise glacier.elaM.');
  }

  if (cmd === 'build') {
    if (errs.length) { console.error('\nNot writing STLs while the contract is broken.'); process.exit(1); }
    const dir = String(flag('out', 'tiles'));
    mkdirSync(dir, { recursive: true });
    for (const t of r.tiles) {
      const f = join(dir, `${spec.name || 'map'}-${t.label}.stl`);
      writeFileSync(f, writeSTL(t.tris, `${spec.name || 'map'} ${t.label}`));
    }
    writeFileSync(join(dir, 'plate.stl'), plateSTL(r.contract.tileMM, r.contract.tileMM, r.contract.plateMM));
    const { png } = renderMap(r);
    writeFileSync(join(dir, 'preview.png'), png);
    console.log(`\nWrote ${r.tiles.length} tiles, plate.stl and preview.png to ${dir}/ in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  }
} else {
  console.log(`mmb — modular map builder

  node bin/mmb.mjs example > map.json      a spec to start from
  node bin/mmb.mjs check map.json          contract, levels and seams, no rock
  node bin/mmb.mjs build map.json --out tiles/
  node bin/mmb.mjs plate --size 200 --thick 10 --out plate.stl
  node bin/mmb.mjs canopy --kind conifer --crown 8 --out sheet.png
  (build also writes preview.png — a hillshade of the assembled map)

River sizes: ${SIZE_LADDER.map((s) => `${s.id} ${s.widthMM}mm${s.kind === 'water-body' ? ' (opening)' : ''}`).join(', ')}
Falls per tile: ${FALLS.join(', ')} mm`);
}
