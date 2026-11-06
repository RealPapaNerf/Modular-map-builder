// summary.js — a buildTile result turned into plain, structurally-cloneable
// data for the UI.
//
// The result itself holds megabytes of Float32Array mesh; none of that
// crosses to the main thread. This is the part worth looking at: the same
// facts `mmb check` prints, as tables.

import { EDGES } from '../lib/contract.js';
import { usableKeys } from '../lib/joint.js';
import { classOf, edgeLand, portFloorAt } from '../lib/contract.js';

const num = (v, d = 1) => (Number.isFinite(v) ? Number(v.toFixed(d)) : null);

export function summarise(result, { mode = 'build', spec = null } = {}) {
  const c = result.contract;
  const t = result.tile;
  const g = result.world.glacierStats;
  const shape = (sh) => (sh ? {
    atMM: sh.atMM.map((v) => num(v, 1)), lengthMM: num(sh.lengthMM, 0), widthMM: num(sh.widthMM, 0), angleDeg: num(sh.angleDeg, 0),
  } : null);
  // Every body of water, with its size, so the editor can say how big a lake
  // is when it is clicked and write a resize against it. `index` is its
  // place in the build's list, which is what the 3D view's pick map holds.
  const all = (t.lakes || []).map((l, index) => ({
    index, what: l.what, areaMM2: num(l.areaMM2, 0), deepestMM: num(l.deepestMM), millilitres: num(l.millilitres, 2), clamped: l.clamped || 0,
    surfaceMM: num(l.surfaceZ, 1), shape: shape(l.shape), asDug: shape(l.asDug), resizeIndex: l.resized ? l.resized.index : null,
    dammed: l.resized?.dammed || 0, clipped: l.resized?.clipped || 0,
  }));
  const lakes = [...all].sort((a, b) => b.millilitres - a.millilitres);
  const lakesByKind = {};
  for (const l of lakes) lakesByKind[l.what] = (lakesByKind[l.what] || 0) + 1;

  return {
    mode,
    name: result.name || spec?.name || null,
    contract: {
      tileMM: c.tileMM, edgeLandMM: c.edgeLandMM, portWidthMM: c.portWidthMM, channelDepthMM: c.channelDepthMM,
      portFloorMM: num(result.portFloorMM), grooveWidthMM: c.grooveWidthMM, grooveDepthMM: c.grooveDepthMM,
      rims: Object.fromEntries(EDGES.map((e) => [e, edgeLand(c, e)])),
      classes: Object.fromEntries(EDGES.map((e) => [e, classOf(c, e)])),
      portFloors: Object.fromEntries(EDGES.map((e) => [e, num(portFloorAt(c, e))])),
    },
    contractNotes: result.contractNotes.map((n) => ({ severity: n.severity, message: n.message })),
    errors: result.problems.filter((p) => p.severity === 'error').map((p) => p.message),
    warnings: result.problems.filter((p) => p.severity === 'warning').map((p) => p.message),
    notes: result.problems.filter((p) => p.severity !== 'error' && p.severity !== 'warning').map((p) => p.message),
    edges: Object.fromEntries(EDGES.map((e) => [e, { signature: t.signatures[e], errMM: num(t.edges[e], 4), port: !!t.ports[e], classMM: classOf(c, e), rimMM: edgeLand(c, e) }])),
    worstEdgeMM: num(t.edges.worst, 4),
    channels: (t.channels || []).map((ch) => ({
      name: ch.name, from: ch.from, to: ch.to, routed: ch.routed, widthMM: ch.widthMM, depthMM: ch.depthMM, lengthMM: num(ch.lengthMM, 0),
      startFloorMM: num(ch.startFloorMM), endFloorMM: num(ch.endFloorMM), lowestFloorMM: num(ch.lowestFloorMM), climbMM: num(ch.climbMM),
      pondMM: num(ch.pondMM), gorgeMM: num(ch.gorgeMM),
      // The line as grown, every few samples: enough to take over as a drawn path.
      pts: ch.pts.filter((_, k) => k % 4 === 0 || k === ch.pts.length - 1).map(([x, y]) => [Number(x.toFixed(1)), Number(y.toFixed(1))]),
    })),
    keys: {
      placed: (t.keys || []).length,
      cams: (t.keys || []).filter((k) => k.kind === 'cam').map((k) => ({ id: k.id, heightMM: num(k.heightMM, 1) })),
      camHeights: t.camHeights || [],
      sockets: (t.sockets || []).length,
      refused: [...(t.keysRefused || []), ...(t.socketsRefused || [])].map((k) => ({ id: k.id, why: k.why })),
      usable: usableKeys(result).length,
      joint: {
        camMM: result.joint.camMM, headMM: result.joint.headMM, drawMM: result.joint.drawMM, preloadMM: result.joint.preloadMM,
        offsetMM: result.joint.offsetMM, clearanceMM: result.joint.clearanceMM, enabled: result.joint.enabled,
      },
    },
    springs: (t.springs || []).map((sp) => ({
      atMM: sp.atMM.map((v) => num(v, 0)), bedMM: num(sp.bedMM), spillMM: num(sp.spillMM), boreMM: num(sp.bore.rMM * 2), tubeOdMM: sp.tubeOdMM,
    })),
    lakes: { byKind: lakesByKind, totalMl: num(lakes.reduce((a, l) => a + l.millilitres, 0), 1), top: lakes.slice(0, 8), all },
    lakesSkipped: (t.lakesSkipped || []).map((x) => ({ what: x.what, why: x.why })),
    lakesFilledIn: (t.lakesFilledIn || []).map((x) => ({ resizeIndex: x.resizeIndex, asDug: shape(x.asDug) })),
    totals: {
      trees: t.trees || 0,
      printsMM: num(t.bbox.size[2], 1),
      lowMM: num(t.lowMM, 1),
      highMM: num(t.highMM, 1),
      triangles: t.mesh.triangles,
      watertight: t.mesh.watertight,
      millilitres: num(t.millilitres, 1),
    },
    glacier: g ? {
      elaM: num(g.elaM, 0), glaciatedPct: num(g.glaciatedFraction * 100, 0), maxIceM: num(g.maxIceM, 0),
      maxSlideMPerYear: num(g.maxSlideMPerYear, 0), maxIncisionM: num(g.maxIncisionM, 0), runaway: !!g.runaway,
      iceBeforeMeltM: num(g.iceBeforeMeltM, 0), meltYears: g.meltYears, finalIceM: num(g.finalIceM, 2), basins: g.basins,
    } : null,
  };
}
