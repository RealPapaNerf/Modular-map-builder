// basins.js — closed hollows: finding them, and how much they would hold.
//
// This exists for two jobs. Right now it is the PROOF that the ice did what
// it was asked to: a glacier leaves closed basins -- cirque floors, tarns,
// overdeepenings along a trough -- and a river cannot leave a single one,
// because water running downhill fills them as it goes. Counting them is the
// sharpest available test of whether a run produced glacial landscape or
// merely a lowered one.
//
// Later it is the input to carving those basins as lakes, which is why it
// returns the filled surface and the volume rather than just a count.
//
// The algorithm is priority-flood: start from the border, always extend from
// the lowest cell on the frontier, and a cell's filled level is the highest
// "sill" that had to be crossed to reach it. Cells where that exceeds the
// bed are under water.

/** A tiny binary heap keyed on a float; enough for one flood. */
class Heap {
  constructor(cap) {
    this.k = new Float64Array(cap);
    this.v = new Int32Array(cap);
    this.n = 0;
  }
  push(key, val) {
    let i = this.n++;
    this.k[i] = key;
    this.v[i] = val;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.k[p] <= this.k[i]) break;
      [this.k[p], this.k[i]] = [this.k[i], this.k[p]];
      [this.v[p], this.v[i]] = [this.v[i], this.v[p]];
      i = p;
    }
  }
  pop() {
    const top = this.v[0];
    this.n--;
    if (this.n > 0) {
      this.k[0] = this.k[this.n];
      this.v[0] = this.v[this.n];
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < this.n && this.k[l] < this.k[m]) m = l;
        if (r < this.n && this.k[r] < this.k[m]) m = r;
        if (m === i) break;
        [this.k[m], this.k[i]] = [this.k[i], this.k[m]];
        [this.v[m], this.v[i]] = [this.v[i], this.v[m]];
        i = m;
      }
    }
    return top;
  }
}

/**
 * The surface water would stand at if every closed hollow filled to its sill
 * and drained off the edge of the map. Equal to the bed everywhere that
 * already drains.
 */
export function fillDepressions(field) {
  const { nx, ny } = field;
  const z = field.values;
  const N = nx * ny;
  const filled = Float64Array.from(z);
  const done = new Uint8Array(N);
  const heap = new Heap(N + 8);

  for (let i = 0; i < nx; i++) {
    for (const j of [0, ny - 1]) {
      const k = j * nx + i;
      if (!done[k]) { done[k] = 1; heap.push(z[k], k); }
    }
  }
  for (let j = 0; j < ny; j++) {
    for (const i of [0, nx - 1]) {
      const k = j * nx + i;
      if (!done[k]) { done[k] = 1; heap.push(z[k], k); }
    }
  }

  while (heap.n > 0) {
    const k = heap.pop();
    const i = k % nx;
    const j = (k - i) / nx;
    const level = filled[k];
    for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const ni = i + di;
      const nj = j + dj;
      if (ni < 0 || nj < 0 || ni >= nx || nj >= ny) continue;
      const nk = nj * nx + ni;
      if (done[nk]) continue;
      done[nk] = 1;
      // Either the cell drains at its own height, or it is dammed up to the
      // sill we came over.
      filled[nk] = Math.max(z[nk], level);
      heap.push(filled[nk], nk);
    }
  }
  return filled;
}

/**
 * How many separate closed hollows there are, how deep the deepest is, and
 * how much water they would hold in total.
 *
 * `minDepthM` throws away the one-cell dimples that any noisy surface has;
 * a basin has to be a basin.
 */
export function depressionStats(field, { minDepthM = 2 } = {}) {
  const { nx, ny, step } = field;
  const z = field.values;
  const filled = fillDepressions(field);
  const N = nx * ny;
  const wet = new Uint8Array(N);
  let volume = 0;
  let maxDepth = 0;
  for (let k = 0; k < N; k++) {
    const d = filled[k] - z[k];
    if (d > 1e-9) {
      wet[k] = 1;
      volume += d * step * step;
      if (d > maxDepth) maxDepth = d;
    }
  }

  // Label connected wet regions and keep the ones deep enough to mean it.
  const seen = new Uint8Array(N);
  let count = 0;
  const basins = [];
  const stack = [];
  for (let k0 = 0; k0 < N; k0++) {
    if (!wet[k0] || seen[k0]) continue;
    stack.length = 0;
    stack.push(k0);
    seen[k0] = 1;
    let cells = 0;
    let deepest = 0;
    let vol = 0;
    while (stack.length) {
      const k = stack.pop();
      const i = k % nx;
      const j = (k - i) / nx;
      const d = filled[k] - z[k];
      cells++;
      vol += d * step * step;
      if (d > deepest) deepest = d;
      for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const ni = i + di;
        const nj = j + dj;
        if (ni < 0 || nj < 0 || ni >= nx || nj >= ny) continue;
        const nk = nj * nx + ni;
        if (wet[nk] && !seen[nk]) { seen[nk] = 1; stack.push(nk); }
      }
    }
    if (deepest >= minDepthM) {
      count++;
      basins.push({ cells, deepestM: deepest, volumeM3: vol, areaM2: cells * step * step });
    }
  }
  basins.sort((a, b) => b.deepestM - a.deepestM);
  return { count, maxDepthM: maxDepth, totalVolumeM3: volume, basins, filled, wet };
}
