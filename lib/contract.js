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
// THE CONTRACT, in three numbers:
//
//     edgeLandMM      every edge of every module stands this high at its rim.
//                     Flat, the whole way along, on all four sides. So any
//                     land edge mates with any land edge.
//     portWidthMM     where a channel crosses a rim it does so at the MIDDLE
//     channelDepthMM  of that side, this wide and this deep, in the one
//                     cross-section below. So any channel edge mates with any
//                     channel edge, whatever the two channels do inland.
//
// That is the whole of it. There are no plate levels, no falls and no corner
// heights to agree on, because there is no map: there is one piece, and the
// only promise it makes is at its rim.
//
// THE CROSS-SECTION is a parenthesis on its side -- a circular arc from one
// bank, down through the thalweg and up to the other, with no flat floor and
// no break in slope. channelShape() is that curve, and it is the ONE
// function both the rim profile and the carve use, so the channel a module
// cuts inland is the same curve it hands over at its edge.

export const DEFAULTS = {
  tileMM: 200, // footprint of one module, square
  edgeLandMM: 22, // the rim datum: how high every edge stands above the module's base
  portWidthMM: 30, // a channel crossing the rim is this wide, bank to bank
  channelDepthMM: 10, // and this deep below the land, at the rim and (by default) inland
  minLandMM: 6, // the land is never squeezed closer than this to the base
  minChannelFloorMM: 3, // plastic under a channel floor before it is called thin
  clearanceMM: 0.3, // slip fit, everywhere two printed parts meet
  // How far in from the rim the generator's ground is bent down to meet the
  // contract, once the module's overall tilt has been taken out everywhere
  // (see conformToContract in tile.js). The middle of the module, further
  // in than this, is the generator's own. 0 spreads the bend over the whole
  // module, which takes a ridge that crosses two sides out entirely.
  rimBlendMM: 60,
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

/** Channel widths the editor offers, bank to bank. Any width is allowed; these are the chips. */
export const WIDTHS = [20, 30, 40, 60];

export function makeContract(o = {}) {
  const c = { ...DEFAULTS, ...o };
  // Fields an older spec may still carry, from before there was one port.
  delete c.plateMM; delete c.outletZMM; delete c.inletZMM; delete c.fallMM;
  return c;
}

/** The channel floor at a port, above the module's base: the rim's land, one channel depth down. */
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
 * the channel's own, which is what makes any two channel edges mate.
 */
export function edgeProfile(c, port, s) {
  const land = c.edgeLandMM;
  if (!port) return land;
  const half = c.portWidthMM / 2;
  const d = Math.abs(s - c.tileMM / 2);
  if (d >= half) return land;
  const floor = portFloor(c);
  const depth = land - floor;
  return land - depth * channelShape(d / half, depth / half);
}

/**
 * The profile of one named edge of a module. `ports` is the set of edges a
 * channel crosses, as `{ N: true, ... }` or an array of letters.
 */
export function tileEdgeProfile(c, ports, e, s) {
  return edgeProfile(c, hasPort(ports, e), s);
}

export function hasPort(ports, e) {
  if (!ports) return false;
  if (Array.isArray(ports)) return ports.includes(e);
  if (ports instanceof Set) return ports.has(e);
  return !!ports[e];
}

/**
 * What an edge will mate with, as a short string: `land 22` goes against
 * `land 22`, `channel 30@12` against `channel 30@12`. Every module built to
 * one contract prints the same two strings, which is the point.
 */
export function edgeSignature(c, ports, e) {
  return hasPort(ports, e)
    ? `channel ${c.portWidthMM}@${portFloor(c).toFixed(0)} ${c.edgeLandMM}`
    : `land ${c.edgeLandMM}`;
}

/** Everything that is wrong with a contract, before anything is generated. */
export function check(c) {
  const out = [];
  if (c.edgeLandMM - c.channelDepthMM < c.minChannelFloorMM) {
    out.push({
      severity: 'warning',
      message:
        `A ${c.channelDepthMM} mm channel in a ${c.edgeLandMM} mm rim leaves ` +
        `${(c.edgeLandMM - c.channelDepthMM).toFixed(1)} mm of plastic under it at the edge; the floor is held at ` +
        `${c.minChannelFloorMM} mm instead, so the port is ${(c.edgeLandMM - c.minChannelFloorMM).toFixed(1)} mm deep. ` +
        'Raise edgeLandMM, or make the channel shallower.',
    });
  }
  if (c.portWidthMM >= c.tileMM / 2) {
    out.push({ severity: 'error', message: 'The port is wider than half the module: there is no rim left beside it.' });
  }
  if (c.minLandMM >= c.edgeLandMM) {
    out.push({ severity: 'error', message: `minLandMM (${c.minLandMM}) has to be below the rim (${c.edgeLandMM}).` });
  }
  out.push({
    severity: 'note',
    message: `Every edge stands ${c.edgeLandMM} mm high; a channel crosses it ${c.portWidthMM} mm wide and ` +
             `${(c.edgeLandMM - portFloor(c)).toFixed(0)} mm deep, in the middle of the side. Any module built to this mates with any other.`,
  });
  return out;
}
