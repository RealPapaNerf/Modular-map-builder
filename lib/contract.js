// contract.js — the edge contract. Design this first; everything else is
// downstream of it.
//
// WHAT PROBLEM THIS SOLVES. A module is built on its own, months apart from
// the module that will one day sit next to it, by a generator that has never
// seen that neighbour. For the two to meet, the boundary of a module cannot
// be whatever the generator produced there -- it has to be a DECLARED
// PROFILE that every module is held to, and the generator is only free in
// the middle.
//
// THE CONTRACT:
//
//     an edge CLASS      every side of a module is one of a ladder of
//                        heights: class 10, 20, 30 ... 190, which is the rim
//                        standing baseMM + class above the module's base --
//                        12, 22, 32 ... 192 mm. Flat the whole
//                        way along that side. A class-20 side mates flush
//                        with any class-20 side; against a class-30 side it
//                        is a 10 mm step, which is a cliff, and cliffs are
//                        terrain. The author decides each side's class.
//     portWidthMM        where a channel crosses a side it does so at the
//     channelDepthMM     MIDDLE of that side, this wide and this deep, in the
//                        one cross-section below. The channel floor at the
//                        port is therefore the side's class less 8: 2, 12, 22,
//                        32, 42 or 52 mm. So water enters a module at 12..52
//                        and leaves it at 2..42, one class lower, and a module
//                        standing on a stack of 10 mm spacer plates hands its
//                        water to any module whose entry floor matches.
//     the seam groove    across every port, in the last grooveWidthMM before
//                        the seam, the bed is rebated grooveDepthMM for a bead
//                        of silicone. Two beads press together when the
//                        modules are locked and the junction is watertight.
//
// There are no plate levels, no falls and no corner heights to agree on,
// because there is no map: there is one piece, and the only promise it
// makes is at its rim. Where two sides of different classes meet at a
// corner, the step between them is the module's own business (see tile.js).
//
// THE CROSS-SECTION is a parenthesis on its side -- a circular arc from one
// bank, down through the thalweg and up to the other, with no flat floor and
// no break in slope. channelShape() is that curve, and it is the ONE
// function both the rim profile and the carve use, so the channel a module
// cuts inland is the same curve it hands over at its edge.

export const DEFAULTS = {
  tileMM: 200, // footprint of one module, square
  baseMM: 2, // plastic under the lowest port floor: the module's floor plate
  edgeStepMM: 10, // the ladder of edge classes
  edgeLandMM: 22, // the rim datum for any side not given its own: class 20
  edges: null, // per-side rim heights, { N, E, S, W }, each baseMM + a class
  portWidthMM: 30, // a channel crossing the rim is this wide, bank to bank
  channelDepthMM: 10, // and this deep below the land, at the rim and (by default) inland
  minLandMM: 6, // the land is never squeezed closer than this to the base
  minChannelFloorMM: 2, // plastic under a channel floor before it is called thin
  clearanceMM: 0.3, // slip fit, everywhere two printed parts meet
  grooveWidthMM: 3, // the silicone rebate across a port: this far in from the seam
  grooveDepthMM: 1, // and this deep below the bed
  // How far in from the rim the generator's ground is bent down to meet the
  // contract, once the module's overall tilt has been taken out everywhere
  // (see conformToContract in tile.js). The middle of the module, further
  // in than this, is the generator's own. 0 spreads the bend over the whole
  // module, which takes a ridge that crosses two sides out entirely.
  rimBlendMM: 60,
  // Per side, the same distance: { N: 8 } stands a mountain right up to the
  // north rim and drops it as a cliff there; { N: 90 } slopes it down.
  blends: null,
  // How far in from the rim a hand edit fades to nothing. See edits.js.
  rimLockMM: 12,
  // How close to the rim a channel's end has to come to be taken as crossing
  // it. An end that close is snapped to that side's port.
  portSnapMM: 30,
};

export const EDGES = ['N', 'E', 'S', 'W'];
export const OPPOSITE = { N: 'S', S: 'N', E: 'W', W: 'E' };
/** Unit step out of a tile across each edge, x east and y north. */
export const STEP = { N: [0, 1], S: [0, -1], E: [1, 0], W: [-1, 0] };

/**
 * The edge classes the editor offers as chips: the ones a channel can cross
 * by, where water comes in at 12..52 mm and leaves at 2..42 through the
 * spacer plates. A class is the rim less the base. Any multiple of the step
 * up to MAX_CLASS is on the ladder: a side that is all mountain can stand
 * as high as the print, and mates with any side of its class.
 */
export const EDGE_CLASSES = [10, 20, 30, 40, 50, 60];
export const MAX_CLASS = 190;

/** Channel widths the editor offers, bank to bank. Any width is allowed; these are the chips. */
export const WIDTHS = [20, 30, 40, 60];

export function makeContract(o = {}) {
  const c = { ...DEFAULTS, ...o };
  // Fields an older spec may still carry, from before there was one port.
  delete c.plateMM; delete c.outletZMM; delete c.inletZMM; delete c.fallMM;
  // Per-side heights: only the four letters, only finite numbers.
  if (c.edges && typeof c.edges === 'object') {
    const e = {};
    for (const k of EDGES) if (Number.isFinite(c.edges[k])) e[k] = c.edges[k];
    c.edges = Object.keys(e).length ? e : null;
  } else {
    c.edges = null;
  }
  if (c.blends && typeof c.blends === 'object') {
    const b = {};
    for (const k of EDGES) if (Number.isFinite(c.blends[k]) && c.blends[k] >= 0) b[k] = c.blends[k];
    c.blends = Object.keys(b).length ? b : null;
  } else {
    c.blends = null;
  }
  return c;
}

/** How far in from one side the ground is bent to meet its rim. */
export function blendOf(c, e) {
  const v = c.blends?.[e];
  return Number.isFinite(v) ? v : c.rimBlendMM;
}

/** The blends the editor offers: a cliff at the rim, the default, a long slope. */
export const BLENDS = [[6, 'cliff'], [20, 'steep'], [60, 'slope'], [100, 'long slope']];

/** How high one side's rim stands above the module's base. */
export function edgeLand(c, e) {
  const v = c.edges?.[e];
  return Number.isFinite(v) ? v : c.edgeLandMM;
}

/** The class of one side: its rim less the base, so 22 mm is class 20. */
export const classOf = (c, e) => edgeLand(c, e) - c.baseMM;
/** The rim height a class stands at. */
export const landOfClass = (c, k) => c.baseMM + k;
/** Is this rim height on the ladder? */
export function onLadder(c, land) {
  const k = land - c.baseMM;
  return Math.abs(k / c.edgeStepMM - Math.round(k / c.edgeStepMM)) < 1e-9 && k >= EDGE_CLASSES[0] - 1e-9 && k <= MAX_CLASS + 1e-9;
}

export const minEdgeLand = (c) => Math.min(...EDGES.map((e) => edgeLand(c, e)));
export const maxEdgeLand = (c) => Math.max(...EDGES.map((e) => edgeLand(c, e)));

/** The channel floor at one side's port, above the module's base: that side's land, one channel depth down. */
export function portFloorAt(c, e) {
  return Math.max(c.minChannelFloorMM, edgeLand(c, e) - c.channelDepthMM);
}

/** The channel floor at a port on a side of the default class. */
export function portFloor(c) {
  return Math.max(c.minChannelFloorMM, c.edgeLandMM - c.channelDepthMM);
}

/**
 * The cross-section: how far DOWN the channel is at `u` (0 on the centre
 * line, 1 at the bank), as a fraction of its depth, 1 at the centre and 0
 * at the bank.
 *
 * `aspect` is depth over half-width. Up to 1 the curve is the circular arc
 * through the bank tops and the thalweg -- the parenthesis -- which is a
 * shallow smile for a wide channel and a semicircle when the depth is half
 * the width. Past 1 the channel is deeper than a semicircle can be, so it is
 * a semicircle under straight walls: the walls lean in over a small fraction
 * of the width so the surface still prints as a height field.
 */
export function channelShape(u, aspect) {
  const a = Math.max(1e-6, aspect);
  const x = Math.min(1, Math.max(0, Math.abs(u)));
  if (x >= 1) return 0; // the bank top is the ground, exactly
  if (a <= 1) {
    // Circle through (0, 0), (1, a) and (-1, a), in units of the half-width:
    // radius (1 + a^2) / 2a, centre above the thalweg.
    const r = (1 + a * a) / (2 * a);
    const z = r - Math.sqrt(Math.max(0, r * r - x * x)); // down from the bank top, 0..a
    return 1 - z / a;
  }
  const lean = 0.1; // the fraction of the half-width the wall climbs over
  const R = 1 - lean;
  if (x <= R) {
    const z = R - Math.sqrt(Math.max(0, R * R - x * x)); // the semicircle, 0..R
    return 1 - z / a;
  }
  // The wall: straight from the semicircle's lip up to the bank top.
  const lip = 1 - R / a;
  return lip * (1 - (x - R) / lean);
}

/**
 * The declared height along one edge, above the module's base, as a function
 * of the distance `s` in mm from the edge's start. `port` says whether a
 * channel crosses this edge; the width and depth are the contract's, never
 * the channel's own, which is what makes any two channel edges mate. `land`
 * is the rim height of that side; it defaults to the contract's default side.
 */
export function edgeProfile(c, port, s, land = c.edgeLandMM) {
  if (!port) return land;
  const half = c.portWidthMM / 2;
  const d = Math.abs(s - c.tileMM / 2);
  if (d >= half) return land;
  const floor = Math.max(c.minChannelFloorMM, land - c.channelDepthMM);
  const depth = land - floor;
  return land - depth * channelShape(d / half, depth / half);
}

/** Is `s` along a side inside the port's width? */
export function inPort(c, s) {
  return Math.abs(s - c.tileMM / 2) < c.portWidthMM / 2;
}

/**
 * The profile of one named edge of a module. `ports` is the set of edges a
 * channel crosses, as `{ N: true, ... }` or an array of letters.
 */
export function tileEdgeProfile(c, ports, e, s) {
  return edgeProfile(c, hasPort(ports, e), s, edgeLand(c, e));
}

/**
 * What the printed module actually shows at its seam face: the edge profile,
 * rebated by the silicone groove across the port. The groove is cut AFTER the
 * module has been leaned onto its rim (see cutSeamGrooves in tile.js), so the
 * conform works to tileEdgeProfile and the check works to this.
 */
export function seamProfile(c, ports, e, s) {
  const z = tileEdgeProfile(c, ports, e, s);
  return hasPort(ports, e) && inPort(c, s) ? z - grooveDepthAt(c, e) : z;
}

/** How deep the silicone rebate is on one side: the contract's depth, never into the last millimetre of plastic. */
export function grooveDepthAt(c, e) {
  if (!(c.grooveDepthMM > 0) || !(c.grooveWidthMM > 0)) return 0;
  return Math.max(0, Math.min(c.grooveDepthMM, portFloorAt(c, e) - 1));
}

export function hasPort(ports, e) {
  if (!ports) return false;
  if (Array.isArray(ports)) return ports.includes(e);
  if (ports instanceof Set) return ports.has(e);
  return !!ports[e];
}

/**
 * What an edge will mate with, as a short string: `land 22` goes against
 * `land 22`, `channel 30@12 22` against `channel 30@12 22`. Every module built
 * to one contract prints the same strings for the same classes, which is the
 * point.
 */
export function edgeSignature(c, ports, e) {
  const land = edgeLand(c, e);
  return hasPort(ports, e)
    ? `channel ${c.portWidthMM}@${portFloorAt(c, e).toFixed(0)} ${land}`
    : `land ${land}`;
}

/** Everything that is wrong with a contract, before anything is generated. */
export function check(c) {
  const out = [];
  for (const e of EDGES) {
    const land = edgeLand(c, e);
    if (land - c.channelDepthMM < c.minChannelFloorMM) {
      out.push({
        severity: 'warning',
        message:
          `A ${c.channelDepthMM} mm channel in the ${land} mm rim of the ${e} side leaves ` +
          `${(land - c.channelDepthMM).toFixed(1)} mm of plastic under it at the edge; the floor is held at ` +
          `${c.minChannelFloorMM} mm instead, so that port is ${(land - c.minChannelFloorMM).toFixed(1)} mm deep. ` +
          'Give the side a higher class, or make the channel shallower.',
      });
    }
    if (!onLadder(c, land)) {
      out.push({
        severity: 'warning',
        message:
          `The ${e} side stands ${land} mm, which is not on the ladder of edge classes ` +
          `(${EDGE_CLASSES.map((k) => landOfClass(c, k)).join(', ')} mm). It mates only with a side at exactly ${land} mm, ` +
          'and its port will not line up with other modules through the spacer plates.',
      });
    }
    if (c.grooveDepthMM > 0 && portFloorAt(c, e) - grooveDepthAt(c, e) < 1.5) {
      out.push({
        severity: 'note',
        message:
          `The silicone groove across a port on the ${e} side leaves ${(portFloorAt(c, e) - grooveDepthAt(c, e)).toFixed(1)} mm of plastic ` +
          'under it at the seam: that is the lowest class, and it is thin there. A class-20 exit has 11 mm.',
      });
    }
  }
  if (c.portWidthMM >= c.tileMM / 2) {
    out.push({ severity: 'error', message: 'The port is wider than half the module: there is no rim left beside it.' });
  }
  if (c.minLandMM >= minEdgeLand(c)) {
    out.push({ severity: 'error', message: `minLandMM (${c.minLandMM}) has to be below the lowest rim (${minEdgeLand(c)}).` });
  }
  const classes = EDGES.map((e) => `${e} ${classOf(c, e)}`).join(', ');
  out.push({
    severity: 'note',
    message: `Edge classes ${classes}: the rims stand ${EDGES.map((e) => edgeLand(c, e)).join('/')} mm; a channel crosses a side ` +
             `${c.portWidthMM} mm wide and ${c.channelDepthMM} mm deep in its middle, floor at ${EDGES.map((e) => portFloorAt(c, e).toFixed(0)).join('/')} mm. ` +
             'A side mates flush with any side of its class.',
  });
  return out;
}
