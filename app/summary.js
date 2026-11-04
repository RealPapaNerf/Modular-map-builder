// summary.js — a buildMap result turned into plain, structurally-cloneable
// data for the UI.
//
// The result itself holds 60-odd megabytes of Float32Array meshes and a
// couple of Maps; none of that crosses to the main thread. This is the part
// worth looking at: the same facts `mmb check` prints, as tables.

import { FALLS, EDGES, sizeFor } from '../lib/contract.js';
import { usableKeys } from '../lib/joint.js';

const num = (v, d = 1) => (Number.isFinite(v) ? Number(v.toFixed(d)) : null);

function portsOf(t) {
  return EDGES
    .filter((e) => t.spec.edges?.[e] && t.spec.edges[e].type !== 'land')
    .map((e) => {
      const ed = t.spec.edges[e];
      return {
        edge: e,
        dir: ed.type,
        widthMM: sizeFor(ed.size).widthMM,
        size: sizeFor(ed.size).id,
        drain: !!ed.drain,
        waterfallMM: ed.waterfallMM ?? null,
      };
    });
}

export function summarise(result, { mode = 'build', spec = null } = {}) {
  const c = result.contract;

  // Sorted the way the map reads: north row first, west to east. The build
  // order is whatever the river walk produced, which is nobody's mental model.
  const ordered = [...result.tiles].sort((a, b) => b.spec.row - a.spec.row || a.spec.col - b.spec.col);

  const tiles = ordered.map((t) => ({
    label: t.label,
    col: t.spec.col,
    row: t.spec.row,
    level: t.level,
    plates: t.stack.plates,
    standMM: num(t.stack.standMM, 0),
    fallMM: t.fallMM,
    ports: portsOf(t),
    trees: t.trees || 0,
    millilitres: num(t.millilitres, 1),
    printsMM: num(t.bbox.size[2], 1),
    edgeWorstMM: num(t.edges.worst, 4),
    watertight: t.mesh.watertight,
    triangles: t.mesh.triangles,
    channels: t.channels,
    keysCut: (t.keys || []).length,
    springs: (t.springs || []).length,
  }));

  const seamKinds = {};
  for (const s of result.seamChecks) seamKinds[s.kind] = (seamKinds[s.kind] || 0) + 1;
  const stepped = result.seamChecks
    .filter((sc) => !(result.keys || []).some((k) => k.id.startsWith(`${sc.from}-${sc.edge}-`)))
    .map((sc) => `${sc.from}/${sc.to}`);

  const refusedByWhy = {};
  for (const t of result.tiles) {
    for (const k of t.keysRefused || []) {
      const why = k.why.replace(/[\d.]+/g, 'N');
      refusedByWhy[why] = (refusedByWhy[why] || 0) + 1;
    }
  }

  const springs = result.tiles.flatMap((t) => (t.springs || []).map((sp) => ({
    tile: t.label,
    level: t.level,
    atMM: sp.atMM.map((v) => num(v, 0)),
    bedMM: num(sp.bedMM),
    spillMM: num(sp.spillMM),
    boreMM: num(sp.bore.rMM * 2),
    tubeOdMM: sp.tubeOdMM,
  })));

  const lakes = result.tiles.flatMap((t) => (t.lakes || []).map((l) => ({
    tile: t.label,
    what: l.what,
    areaMM2: num(l.areaMM2, 0),
    deepestMM: num(l.deepestMM),
    millilitres: num(l.millilitres, 2),
    clamped: l.clamped || 0,
  }))).sort((a, b) => b.millilitres - a.millilitres);

  const lakesByKind = {};
  for (const l of lakes) lakesByKind[l.what] = (lakesByKind[l.what] || 0) + 1;

  // A river path names its tiles, and those tiles get built whether or not
  // cols x rows reaches them. Shrinking the grid without shortening the
  // rivers therefore leaves tiles hanging off the edge of the map you asked
  // for, which is worth saying out loud rather than leaving to be counted.
  const wantCols = Number(spec?.cols) || null;
  const wantRows = Number(spec?.rows) || null;
  const orphans = tiles
    .filter((t) => (wantCols && t.col >= wantCols) || (wantRows && t.row >= wantRows))
    .map((t) => t.label);

  const usable = usableKeys(result);
  const maxLevel = Math.max(...result.tiles.map((t) => t.level));
  const g = result.world.glacierStats;

  return {
    mode,
    name: result.name || null,
    contract: {
      tileMM: c.tileMM, plateMM: c.plateMM, outletZMM: c.outletZMM, inletZMM: c.inletZMM,
      edgeLandMM: c.edgeLandMM, maxStackPlates: c.maxStackPlates,
      falls: FALLS, seamStyle: result.seam.style,
    },
    contractNotes: result.contractNotes.map((n) => ({ severity: n.severity, message: n.message })),
    errors: result.problems.filter((p) => p.severity === 'error').map((p) => p.message),
    warnings: [
      ...result.problems.filter((p) => p.severity === 'warning').map((p) => p.message),
      ...(orphans.length ? [`${orphans.length} tile(s) sit outside the ${wantCols}x${wantRows} grid you asked for `
        + `(${orphans.join(', ')}), because a river path names them. Shorten the rivers, or grow the grid.`] : []),
    ],
    notes: result.problems.filter((p) => p.severity !== 'error' && p.severity !== 'warning').map((p) => p.message),
    grid: {
      cols: Math.max(...result.tiles.map((t) => t.spec.col)) + 1,
      rows: Math.max(...result.tiles.map((t) => t.spec.row)) + 1,
    },
    tiles,
    seams: {
      kinds: seamKinds,
      notFlat: result.seamChecks.filter((s) => s.kind !== 'plane').map((s) => ({
        from: s.from, to: s.to, edge: s.edge, kind: s.kind,
        waterStepMM: num(s.waterStepMM, 1), landStepMM: num(s.landStepMM, 1),
      })),
      stepped,
    },
    keys: {
      planned: (result.keys || []).length,
      placed: result.tiles.reduce((a, t) => a + (t.keys || []).length, 0),
      halves: (result.keys || []).length * 2,
      usable: usable.length,
      refusedByWhy,
      joint: {
        padMM: result.joint.padMM, neckMM: result.joint.neckMM,
        depthMM: result.joint.depthMM, clearanceMM: result.joint.clearanceMM,
      },
    },
    springs,
    drilledPlates: springs.reduce((a, sp) => a + sp.level, 0),
    lakes: { byKind: lakesByKind, totalMl: num(lakes.reduce((a, l) => a + l.millilitres, 0), 1), top: lakes.slice(0, 8) },
    lakesSkipped: result.tiles.flatMap((t) => (t.lakesSkipped || []).map((x) => ({ tile: t.label, ...x }))),
    totals: {
      worstEdgeMM: num(Math.max(...result.tiles.map((t) => t.edges.worst)), 4),
      maxLevel,
      maxStackMM: maxLevel * c.plateMM,
      overStack: maxLevel > c.maxStackPlates,
      totalPlates: result.tiles.reduce((a, t) => a + t.stack.plates, 0),
      leaks: result.tiles.filter((t) => !t.mesh.watertight).length,
      triangles: result.tiles.reduce((a, t) => a + t.mesh.triangles, 0),
    },
    glacier: g ? {
      elaM: num(g.elaM, 0), glaciatedPct: num(g.glaciatedFraction * 100, 0),
      maxIceM: num(g.maxIceM, 0), maxSlideMPerYear: num(g.maxSlideMPerYear, 0),
      maxIncisionM: num(g.maxIncisionM, 0), runaway: !!g.runaway,
    } : null,
  };
}
