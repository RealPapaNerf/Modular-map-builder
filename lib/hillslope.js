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

/**
 * Soil creep and debris infill, as linear diffusion: dz/dt = D grad^2 z.
 *
 * This is the thing that decides WHICH hollows survive, and it is not
 * cosmetic. Diffusion damps a feature at a rate proportional to the square
 * of its wavenumber, so a 300 m pit is smoothed roughly fifty times faster
 * than a 2 km cirque. Without it, quarrying leaves a bed covered in
 * two-cell pits -- 175 of them, on the first run -- and they are
 * indistinguishable from cirques to anything that just counts closed
 * hollows. With it, the small ones fill and the big ones stay, which is
 * what happens on real ground: talus and till pack a dimple and barely
 * touch a corrie.
 *
 * The critical-angle rule above cannot do this job. On a 133 m grid, 55
 * degrees allows a 190 m step between neighbours, so a 40 m pit is nowhere
 * near steep enough to trigger it.
 *
 * Explicit, sub-stepped to stay under the stability limit D dt / dx^2 < 1/4.
 */
export function diffuse(field, { D = 0.08, years = 1000, maxCourant = 0.2 } = {}) {
  const { nx, ny, step } = field;
  const z = field.values;
  const dx2 = step * step;
  const total = D * years;
  if (!(total > 0)) return { substeps: 0 };
  const substeps = Math.max(1, Math.ceil(total / (maxCourant * dx2)));
  const k = total / substeps / dx2;
  const next = new Float64Array(z.length);
  const at = (i, j) => z[Math.min(ny - 1, Math.max(0, j)) * nx + Math.min(nx - 1, Math.max(0, i))];
  for (let p = 0; p < substeps; p++) {
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const c = z[j * nx + i];
        next[j * nx + i] = c + k * (at(i + 1, j) + at(i - 1, j) + at(i, j + 1) + at(i, j - 1) - 4 * c);
      }
    }
    z.set(next);
  }
  return { substeps };
}
