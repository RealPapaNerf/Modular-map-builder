// fountain.js — making the water actually run.
//
// THE CIRCUIT. A pump sits in a tray under the assembled map. A tube runs up
// through the plate stack and comes out at a spring somewhere near the top of
// the map. From there the water is on its own: down the channel, over each
// seam, one plate lower every tile, and off the drain edge back into the
// tray. Nothing is pumped sideways and no tube ever crosses a seam, because a
// tube across a seam is a map that cannot be taken apart.
//
// A SPRING IS A POOL, not a nozzle. A tube opening straight onto a hillside
// squirts -- there is nothing between the pump and the air -- and a jet at the
// top of a map is exactly where you least want one. So the tube opens into a
// small pool with a raised lip and one notch in it, and the water leaves over
// the notch at whatever rate it arrives. The pool takes the velocity out.
//
// relief solves the same problem with a buffer chamber under a lid whose top
// is the real ground, so that from above there is no pool at all. That needs
// rock standing over air -- a column holding more than one solid interval --
// and nothing here does that yet. A pool is the honest version: it is all
// height field, it is watertight by construction, and it works.
//
// WHERE THE TUBE GOES. Up the middle of the pool, so the outlet is under
// water whatever the pump does, and straight down through every plate in the
// stack. The plates need the same hole, which is why `plateBores` exists.

const TAU = Math.PI * 2;

export const FOUNTAIN_DEFAULTS = {
  tubeOdMM: 12.7, // 1/2" OD, which is 3/8" ID vinyl
  clearanceMM: 0.4, // a tube pushes through this, then gets siliconed
  poolRadiusMM: 16, // the still water the tube opens into
  lipHeightMM: 3, // how far the rim stands above the pool's water
  lipWidthMM: 7, // how wide that rim is
  blendMM: 14, // how far past the lip the ground eases back to itself
  floorMM: 2.5, // plate left under the pool bed, outside the bore
  notchDeg: 46, // the gap in the lip the water leaves through
  spillDropMM: 1.2, // how far the notch sits below the rest of the rim
};

/** The radius of the hole a tube needs. */
export function boreRadiusMM(o = {}) {
  const f = { ...FOUNTAIN_DEFAULTS, ...o };
  return f.tubeOdMM / 2 + f.clearanceMM;
}

/**
 * Cut a spring pool into a tile, in place, and say where the bore goes.
 *
 * All of it is a height field: a flat bed, a rim standing proud of the water
 * all the way round except for one notch, and a blend back to whatever the
 * ground was doing. The bore then runs up the middle, and because a bore ends
 * at the lowest ground above it, it comes out at the pool bed without having
 * to be told.
 *
 * `spillToward` is a bearing in radians -- where the water should leave.
 */
export function carveSpring(local, o = {}) {
  const f = { ...FOUNTAIN_DEFAULTS, ...o };
  const { nx, ny, step } = local;
  const z = local.values;
  const [x, y] = f.atMM;
  const rBore = boreRadiusMM(f);

  if (f.poolRadiusMM < rBore + 2) {
    return { skipped: `a ${f.poolRadiusMM} mm pool is too small for a ${(2 * rBore).toFixed(1)} mm bore` };
  }

  // The water sits at the bed plus nothing: the bed IS the waterline here,
  // and the lip stands above it. Read the ground first so the pool sits in
  // the hillside rather than on it.
  const gi = Math.min(nx - 1, Math.max(0, Math.round(x / step)));
  const gj = Math.min(ny - 1, Math.max(0, Math.round(y / step)));
  const ground = z[gj * nx + gi];
  const bed = Math.max(f.floorMM, ground - f.lipHeightMM);
  const rim = bed + f.lipHeightMM;
  const spill = rim - f.spillDropMM;

  const outer = f.poolRadiusMM + f.lipWidthMM + f.blendMM;
  const half = (f.notchDeg * Math.PI) / 360;
  const smooth = (t) => { const u = Math.max(0, Math.min(1, t)); return u * u * (3 - 2 * u); };

  let cells = 0;
  const i0 = Math.max(0, Math.floor((x - outer) / step));
  const i1 = Math.min(nx - 1, Math.ceil((x + outer) / step));
  const j0 = Math.max(0, Math.floor((y - outer) / step));
  const j1 = Math.min(ny - 1, Math.ceil((y + outer) / step));
  for (let j = j0; j <= j1; j++) {
    for (let i = i0; i <= i1; i++) {
      const dx = i * step - x;
      const dy = j * step - y;
      const d = Math.hypot(dx, dy);
      if (d > outer) continue;
      const k = j * nx + i;
      const here = z[k];

      // How much of the rim is here: full, except across the notch.
      let da = Math.abs(((Math.atan2(dy, dx) - f.spillToward + Math.PI * 3) % TAU) - Math.PI);
      const inNotch = da < half;
      const top = inNotch ? spill : rim;

      let target;
      if (d <= f.poolRadiusMM) target = bed;
      else if (d <= f.poolRadiusMM + f.lipWidthMM) {
        target = bed + (top - bed) * smooth((d - f.poolRadiusMM) / f.lipWidthMM);
      } else {
        target = top + (here - top) * smooth((d - f.poolRadiusMM - f.lipWidthMM) / f.blendMM);
      }
      if (Math.abs(target - here) > 1e-9) { z[k] = target; cells++; }
    }
  }

  return {
    atMM: [x, y],
    bore: { x, y, rMM: rBore },
    bedMM: bed,
    rimMM: rim,
    spillMM: spill,
    poolRadiusMM: f.poolRadiusMM,
    cells,
    tubeOdMM: f.tubeOdMM,
  };
}

/**
 * Where the tube has to pass through the plates under a tile.
 *
 * Every plate in that tile's stack needs the same hole in the same place, or
 * the stack cannot go together with the tube in it. Returned per plate so the
 * plan can say "three of these with a hole, nine without" -- two plates of the
 * same size are only interchangeable if they are drilled the same.
 */
export function plateBores(springs, level) {
  if (!springs.length || level <= 0) return [];
  return Array.from({ length: level }, (_, i) => ({
    index: i,
    bores: springs.map((s) => ({ ...s.bore })),
  }));
}

/**
 * The tray the whole map stands in, as a height field to be meshed.
 *
 * Not a clever shape: a flat floor, four walls, and a ledge the plates rest
 * on so the map sits a little above the water with a gap all round for
 * runoff to fall back in. The pump lives under the map and its cord leaves
 * through a notch in one wall.
 */
export function trayField(makeField, o = {}) {
  const {
    widthMM, depthMM,
    wallMM = 4,
    rimMM = 3, // how far the ledge is below the top of the wall
    heightMM = 42,
    clearanceMM = 1.5, // slack so the map drops in
    ledgeMM = 7, // how wide the ledge the plates rest on is
    gapMM = 4, // the runoff slot between the map and the wall
    cordNotchMM = 16,
    stepMM = 2,
  } = o;

  const W = widthMM + 2 * (clearanceMM + gapMM + wallMM);
  const D = depthMM + 2 * (clearanceMM + gapMM + wallMM);
  const nx = Math.round(W / stepMM) + 1;
  const ny = Math.round(D / stepMM) + 1;
  const f = makeField(nx, ny, stepMM);

  const ledgeOuter = wallMM;
  const ledgeInner = wallMM + ledgeMM;
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const x = i * stepMM;
      const y = j * stepMM;
      const edge = Math.min(x, y, W - x, D - y);
      let h;
      if (edge < ledgeOuter) h = heightMM; // the wall
      else if (edge < ledgeInner) h = heightMM - rimMM; // the ledge the map rests on
      else h = wallMM; // the floor of the tub
      // A notch in the back wall for the pump's cord.
      if (y > D - ledgeOuter - 1e-9 && Math.abs(x - W / 2) < cordNotchMM / 2) {
        h = Math.min(h, heightMM - rimMM - 4);
      }
      f.values[j * nx + i] = h;
    }
  }
  return { field: f, outerMM: [W, D], heightMM, sitsAtMM: heightMM - rimMM };
}
