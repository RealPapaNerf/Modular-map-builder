// example.js — the spec the CLI prints and the browser app opens with.
//
// One copy, because it is also the worked example the README explains and a
// second one would drift from it. The comments are the point: they are where
// the reasoning behind each number lives.
//
// Everything is millimetres on the module, with (0, 0) at its south-west
// corner. A point may be outside 0..200: that is the margin, the ground the
// ice comes down from, which is grown but not printed.

export const EXAMPLE_SPEC = {
  name: 'hanging-valley',
  seed: 7,
  meshMM: 0.9,
  // THE SCALE, and the only place metres appear in a spec. 25 m of real
  // ground per millimetre of print: a 200 mm module is 5 km of country, and
  // a 1 km mountain stands 40 mm off the plate. See lib/scale.js.
  metresPerMM: 25,
  // The world runs this far past the module on every side, so the ice has
  // somewhere to come from and a mountain somewhere to go.
  marginMM: 100,
  // 60 mm of mountain above the low ground. What you type is what gets
  // printed; there is no relief budget to squash it into.
  spineHeightMM: 60,
  // The range runs across the middle of the module and out into the margin
  // both sides, its flanks reaching the north and south rims, so the module
  // is a mountain with a glaciated valley down each side of it. The rim is
  // level, so the crest is kept a flank's width inside it: a ridge that ran
  // out through a side would have to come down to the rim there. A 60 mm
  // crest on a 95 mm half-width is a 32 degree flank, which stands; at
  // 60 mm it was 45 degrees, and mass wasting took the top off it.
  spine: [[-100, 112], [30, 98], [105, 104], [190, 94], [300, 86]],
  spineWidthMM: 95,
  // The ice. 30 advances, and the snowline swinging 18 mm either side of its
  // mean is what leaves a staircase of cirques and a line of recessional
  // moraines rather than one clean trough. It all melts out at the end: the
  // module is the bed, with no ice on it.
  glacier: { cycles: 30, elaSwingMM: 18 },
  // A channel: from a point under the crest, down whatever valley the ice
  // leaves, out at the south port. Given as two ends and no line, it is
  // ROUTED down the valley when the module grows, so it follows the ground
  // whatever the seed; draw one with the Channel tool instead, or take this
  // one's line in the inspector, to put it exactly where you want it. 30 mm
  // bank to bank and 10 mm deep, in a parenthesis cross-section; where it
  // crosses the rim it is the port every module agrees on.
  channels: [
    { name: 'main', widthMM: 30, depthMM: 10, from: [100, 62], to: 'S' },
  ],
  // Woods. maxZMM is a treeline and it is the cheapest thing in the file
  // that makes a mountain read right; maxSlopeDeg keeps them off the cliffs.
  canopy: [
    { kind: 'conifer', crownMM: 7, heightMM: 9, density: 0.4, minZMM: 28, maxZMM: 54, thinningMM: 10, maxSlopeDeg: 36 },
    { kind: 'deciduous', crownMM: 12, heightMM: 7, density: 0.3, maxZMM: 32, thinningMM: 6, maxSlopeDeg: 24 },
  ],
  // Water that stands. Hollows the ice left become tarns; `place` puts one
  // where you want it. Depths are millimetres on the print, and the report
  // says how many millilitres of epoxy the module takes.
  lakes: { fillHollows: true, depthMM: 5, shoreMM: 10, profile: 'dish' },
  // A spring at the start of every channel, which is where a pump has to
  // put the water. 3/8" ID vinyl is 1/2" outside.
  fountains: { auto: true, tubeOdMM: 12.7, poolRadiusMM: 16 },
  // THE CONTRACT. Every edge stands 22 mm high; a channel crosses it 30 mm
  // wide and 10 mm deep in the middle of the side. Any module built to this
  // sits against any other.
  contract: { tileMM: 200, edgeLandMM: 22, portWidthMM: 30, channelDepthMM: 10 },
};
