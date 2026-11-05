// example.js — the spec the CLI prints and the browser app opens with.
//
// One copy, because it is also the worked example the README explains and a
// second one would drift from it. The comments are the point: they are where
// the reasoning behind each number lives.

export const EXAMPLE_SPEC = {
  name: 'glacier-valley',
  seed: 7,
  cols: 3,
  rows: 3,
  meshMM: 0.9,
  // THE SCALE, and the only place metres appear in a spec. 25 m of real
  // ground per millimetre of print: a 600 mm board is 15 km of country, and
  // a 1 km mountain stands 40 mm off the plate. Everything else in this file
  // is millimetres you can measure with callipers. See lib/scale.js.
  metresPerMM: 25,
  // 60 mm of mountain above the low ground. There is no relief budget to
  // squash it into any more -- what you type is what gets printed.
  spineHeightMM: 60,
  spine: [[0.1, 0.85], [0.5, 0.6], [0.9, 0.8]],
  volcanoes: [{ at: [0.78, 0.22], heightMM: 32, baseRadiusMM: 90, breachAzimuthDeg: 210 }],
  // The ice. 30 advances, and the snowline swinging 18 mm either side of its
  // mean is what leaves a staircase of cirques and a line of recessional
  // moraines rather than one clean trough.
  glacier: { cycles: 30, elaSwingMM: 18 },
  // Steep at the head, gentler as it goes down. Falls are per tile, in whole
  // plates, 10 to 50.
  falls: { '1,2': 40, '1,1': 30, '1,0': 10, '2,1': 20 },
  // An extra 20 mm of free-fall where the tributary comes off the bench.
  waterfalls: { '1,1': 20 },
  rivers: [
    // Sizes left out are worked out from the inflow and the fall.
    { name: 'main', sourceEdge: 'N', path: [[1, 2], [1, 1], [1, 0]], sinkEdge: 'S', sinkSize: 'bay', size: 'creek' },
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
  // Water that stands. Hollows the ice left become tarns; `place` puts one
  // where you want it. Depths are millimetres on the print, and the plan
  // says how many millilitres of epoxy each tile takes.
  lakes: { fillHollows: true, depthMM: 5, shoreMM: 10, profile: 'dish' },
  // Springs go in automatically wherever a river enters the map from
  // nowhere, which is exactly where a pump has to put the water. 3/8" ID
  // vinyl is 1/2" outside.
  fountains: { auto: true, tubeOdMM: 12.7, poolRadiusMM: 16 },
  // outletZMM 6 rather than the 2 the brief started from. The fall is
  // unchanged, so every plate count is the same -- but it puts 6 mm of
  // plate under the channel where it leaves the tile instead of 2, and it
  // gives a bay mouth room for a bed. See the README on the flow rule.
  contract: { tileMM: 200, plateMM: 10, outletZMM: 6, edgeLandMM: 22 },
};
