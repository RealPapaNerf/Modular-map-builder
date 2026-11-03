// noise.js — value noise that is a pure function of world position.
//
// The seam-stability property is the whole point and it is worth stating
// plainly: a tile must not be able to tell which tile it is. Every texture
// here is evaluated at WORLD coordinates, so the rock along the east edge of
// B2 and the rock along the west edge of C2 are the same rock, computed twice.
// Lifted from relief's alcove.js, where it exists for exactly this reason.

function hash3(i, j, k, seed) {
  let h = (i | 0) * 374761393 + (j | 0) * 668265263 + (k | 0) * 2147483647 + (seed | 0) * 1274126177;
  h = (h ^ (h >>> 13)) >>> 0;
  h = Math.imul(h, 1274126177) >>> 0;
  h = (h ^ (h >>> 16)) >>> 0;
  return h / 4294967296;
}

function smooth(t) {
  return t * t * (3 - 2 * t);
}

/** Value noise in 3D, in [0, 1), smooth across every lattice face. */
export function valueNoise(x, y, z, seed = 1) {
  const i = Math.floor(x);
  const j = Math.floor(y);
  const k = Math.floor(z);
  const fx = smooth(x - i);
  const fy = smooth(y - j);
  const fz = smooth(z - k);
  const mix = (a, b, t) => a + (b - a) * t;
  const c = (di, dj, dk) => hash3(i + di, j + dj, k + dk, seed);
  const y0 = mix(mix(c(0, 0, 0), c(1, 0, 0), fx), mix(c(0, 1, 0), c(1, 1, 0), fx), fy);
  const y1 = mix(mix(c(0, 0, 1), c(1, 0, 1), fx), mix(c(0, 1, 1), c(1, 1, 1), fx), fy);
  return mix(y0, y1, fz);
}

/**
 * Fractal sum, in [-1, 1]. `scale` is the wavelength of the first octave in
 * the same units as x and y.
 */
export function fbm(x, y, { scale = 1, octaves = 5, gain = 0.5, lacunarity = 2, seed = 1 } = {}) {
  let sum = 0;
  let amp = 1;
  let norm = 0;
  let f = 1 / Math.max(1e-9, scale);
  for (let o = 0; o < octaves; o++) {
    // Each octave on its own lattice orientation: value noise is blobby on its
    // own axes, and stacked octaves in register read as a grid of dents.
    const u = 0.8 * x * f - 0.6 * y * f;
    const v = 0.6 * x * f + 0.8 * y * f;
    sum += amp * (2 * valueNoise(u, v, o * 17.3, seed) - 1);
    norm += amp;
    amp *= gain;
    f *= lacunarity;
  }
  return sum / (norm || 1);
}

/**
 * Ridged fractal — the absolute value folded over, which puts a crease along
 * every zero crossing. This is what makes an aretê rather than a dune.
 */
export function ridged(x, y, { scale = 1, octaves = 5, gain = 0.5, lacunarity = 2, seed = 1 } = {}) {
  let sum = 0;
  let amp = 1;
  let norm = 0;
  let f = 1 / Math.max(1e-9, scale);
  for (let o = 0; o < octaves; o++) {
    const u = 0.8 * x * f - 0.6 * y * f;
    const v = 0.6 * x * f + 0.8 * y * f;
    const n = 2 * valueNoise(u, v, o * 31.7, seed) - 1;
    sum += amp * (1 - Math.abs(n));
    norm += amp;
    amp *= gain;
    f *= lacunarity;
  }
  return sum / (norm || 1);
}
