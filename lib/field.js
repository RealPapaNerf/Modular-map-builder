// field.js — a regular grid of heights, and the sampler everything reads it
// through.
//
// UNITS. Two frames are in play and mixing them is the bug this file exists to
// prevent:
//
//   * the WORLD field is in real metres, horizontally and vertically, because
//     that is the only frame the erosion physics is written in. A glacier does
//     not know about build plates.
//   * the PLATE is in millimetres. The conversion happens once, in tile.js,
//     and nowhere else.
//
// A Field is (nx x ny) samples with the first at (originX, originY) and a
// spacing of `step`. Sampling outside is clamped to the edge, which is what
// lets a blur or a flow step read past the border without a special case.

export function makeField(nx, ny, step, originX = 0, originY = 0, values = null) {
  const v = values || new Float64Array(nx * ny);
  if (v.length !== nx * ny) throw new Error(`field needs ${nx * ny} values, got ${v.length}`);
  return { nx, ny, step, originX, originY, values: v };
}

export function cloneField(f) {
  return makeField(f.nx, f.ny, f.step, f.originX, f.originY, Float64Array.from(f.values));
}

export const idx = (f, i, j) => j * f.nx + i;

/** Nearest node, clamped. */
export function at(f, i, j) {
  const ci = i < 0 ? 0 : i >= f.nx ? f.nx - 1 : i;
  const cj = j < 0 ? 0 : j >= f.ny ? f.ny - 1 : j;
  return f.values[cj * f.nx + ci];
}

/** Bilinear sample at a world position. */
export function sample(f, x, y) {
  const fx = (x - f.originX) / f.step;
  const fy = (y - f.originY) / f.step;
  const i = Math.floor(fx);
  const j = Math.floor(fy);
  const tx = fx - i;
  const ty = fy - j;
  const a = at(f, i, j);
  const b = at(f, i + 1, j);
  const c = at(f, i, j + 1);
  const d = at(f, i + 1, j + 1);
  return a * (1 - tx) * (1 - ty) + b * tx * (1 - ty) + c * (1 - tx) * ty + d * tx * ty;
}

export function minMax(f) {
  let min = Infinity;
  let max = -Infinity;
  for (const v of f.values) {
    if (v < min) min = v;
    if (v > max) max = v;
  }
  return { min, max };
}

export function fill(f, fn) {
  for (let j = 0; j < f.ny; j++) {
    const y = f.originY + j * f.step;
    for (let i = 0; i < f.nx; i++) {
      f.values[j * f.nx + i] = fn(f.originX + i * f.step, y, i, j);
    }
  }
  return f;
}

/** Rescale in place so the values span exactly [lo, hi]. */
export function normalize(f, lo, hi) {
  const { min, max } = minMax(f);
  const span = max - min;
  if (!(span > 0)) {
    f.values.fill(lo);
    return f;
  }
  const k = (hi - lo) / span;
  for (let i = 0; i < f.values.length; i++) f.values[i] = lo + (f.values[i] - min) * k;
  return f;
}

/**
 * One pass of a separable box blur of radius r nodes. Used for hillslope
 * smoothing and for relaxing the edge clamp, not for anything that claims to
 * be physics.
 */
export function blur(f, r = 1, passes = 1) {
  if (r < 1) return f;
  const w = 2 * r + 1;
  let src = f.values;
  let dst = new Float64Array(src.length);
  for (let p = 0; p < passes; p++) {
    for (let j = 0; j < f.ny; j++) {
      for (let i = 0; i < f.nx; i++) {
        let s = 0;
        for (let k = -r; k <= r; k++) {
          const ci = Math.min(f.nx - 1, Math.max(0, i + k));
          s += src[j * f.nx + ci];
        }
        dst[j * f.nx + i] = s / w;
      }
    }
    [src, dst] = [dst, src];
    for (let j = 0; j < f.ny; j++) {
      for (let i = 0; i < f.nx; i++) {
        let s = 0;
        for (let k = -r; k <= r; k++) {
          const cj = Math.min(f.ny - 1, Math.max(0, j + k));
          s += src[cj * f.nx + i];
        }
        dst[j * f.nx + i] = s / w;
      }
    }
    [src, dst] = [dst, src];
  }
  f.values.set(src);
  return f;
}

/**
 * The duck type relief's model.js expects of `terrain`: {n, values, min, max,
 * sample(x,y)} on a square grid centred on the origin, in metres.
 *
 * This is the whole integration surface with relief. createGround() in
 * relief/js/model.js touches nothing else, so a field that answers these five
 * questions can be meshed, scooped, keyed, tiled and risered by code that has
 * no idea the ground was invented.
 */
export function toReliefTerrain(f) {
  if (f.nx !== f.ny) throw new Error('relief terrain must be square');
  const { min, max } = minMax(f);
  return {
    n: f.nx,
    values: f.values,
    min,
    max,
    sample: (x, y) => sample(f, x, y),
  };
}
