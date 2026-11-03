// hillslope.js — rock that will not stand up.
//
// Glacial abrasion on its own deepens a valley; it does not widen one. Run
// the ice alone and a V comes out a deeper, sharper V, which is the opposite
// of the thing a glaciated valley is famous for. What actually widens a
// trough is the WALL above the ice failing: the glacier undercuts its own
// flanks, the rock over the undercut passes its angle of repose, and it
// comes down. The ice then carries the debris away and the wall is undercut
// again.
//
// So the U is a two-part landform -- ice cutting the floor, gravity taking
// the walls -- and modelling only the first half gets you neither.
//
// The rule is the simplest one that is honest: no slope may stand steeper
// than the material's critical angle. Where one does, move just enough
// material down the steepest neighbour to bring it back, and let it pile up
// where it lands. Bedrock stands much steeper than loose debris, which is
// why `critDeg` is a parameter and not a constant: 60-70 degrees for a rock
// wall, 33-37 for the talus that collects under it.

/**
 * Relax a field until nothing stands steeper than `critDeg`.
 *
 * `passes` bounds the work: a full relaxation of a tall cliff can take many
 * sweeps, and the first few move almost all of the material.
 */
export function massWaste(field, { critDeg = 60, passes = 6, fraction = 0.5 } = {}) {
  const { nx, ny, step } = field;
  const z = field.values;
  const maxDrop = Math.tan((critDeg * Math.PI) / 180) * step;
  const diagDrop = maxDrop * Math.SQRT2;
  const delta = new Float64Array(nx * ny);
  const NB = [
    [1, 0, maxDrop], [-1, 0, maxDrop], [0, 1, maxDrop], [0, -1, maxDrop],
    [1, 1, diagDrop], [1, -1, diagDrop], [-1, 1, diagDrop], [-1, -1, diagDrop],
  ];

  let moved = 0;
  for (let p = 0; p < passes; p++) {
    delta.fill(0);
    let any = false;
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const k = j * nx + i;
        // Find the steepest neighbour that this column overhangs.
        let bestK = -1;
        let bestExcess = 0;
        for (const [di, dj, lim] of NB) {
          const ni = i + di;
          const nj = j + dj;
          if (ni < 0 || nj < 0 || ni >= nx || nj >= ny) continue;
          const nk = nj * nx + ni;
          const excess = z[k] - z[nk] - lim;
          if (excess > bestExcess) { bestExcess = excess; bestK = nk; }
        }
        if (bestK < 0) continue;
        // Half the excess, split between the two columns, so the pair ends up
        // at the critical slope rather than overshooting past it.
        const give = bestExcess * fraction * 0.5;
        delta[k] -= give;
        delta[bestK] += give;
        any = true;
        if (give > moved) moved = give;
      }
    }
    if (!any) break;
    for (let k = 0; k < nx * ny; k++) z[k] += delta[k];
  }
  return { maxMovedM: moved };
}
