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
import { makeContract, check, SIZES } from '../lib/contract.js';
import { renderMap } from '../lib/preview.js';

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
  rivers: [
    { name: 'main', size: 'river', sourceEdge: 'N', path: [[1, 2], [1, 1], [1, 0]], sinkEdge: 'S' },
    { name: 'trib', size: 'creek', sourceEdge: 'E', path: [[2, 1], [1, 1]] },
  ],
  contract: { tileMM: 200, plateMM: 10, outletZMM: 2, edgeLandMM: 18 },
};

function describe(r) {
  const lines = [];
  lines.push(`Contract: ${r.contract.tileMM} mm tiles, ${r.contract.plateMM} mm plates, ` +
             `river in at ${r.contract.inletZMM} mm and out at ${r.contract.outletZMM} mm, seam ${r.seam.style}.`);
  for (const n of r.contractNotes) lines.push(`  ${n.severity}: ${n.message}`);
  const errs = r.problems.filter((p) => p.severity === 'error');
  const notes = r.problems.filter((p) => p.severity !== 'error');
  if (errs.length) { lines.push('', 'PROBLEMS:'); for (const p of errs) lines.push(`  error: ${p.message}`); }
  if (notes.length) { lines.push('', 'Notes:'); for (const p of notes) lines.push(`  ${p.message}`); }
  return { lines, errs };
}

if (cmd === 'example') {
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
    console.log(
      `  ${t.label.padEnd(4)} level ${String(t.level).padStart(2)} ` +
      `(${String(t.stack.plates).padStart(2)} plates = ${String(t.stack.standMM).padStart(3)} mm) ` +
      `prints ${t.bbox.size[2].toFixed(1).padStart(5)} mm tall, ` +
      `${String(t.mesh.triangles).padStart(7)} tris, ` +
      `edge err ${t.edges.worst.toFixed(4)} mm, ` +
      `${t.mesh.watertight ? 'closed' : 'LEAKS'}`,
    );
  }
  const maxLevel = Math.max(...r.tiles.map((t) => t.level));
  console.log(`\nWorst edge error across every tile: ${worstEdge.toFixed(4)} mm`);
  console.log(`Tallest stack: ${maxLevel} plates (${maxLevel * r.contract.plateMM} mm) under the highest tile.`);
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
  (build also writes preview.png — a hillshade of the assembled map)

River sizes: ${Object.keys(SIZES).join(', ')}`);
}
