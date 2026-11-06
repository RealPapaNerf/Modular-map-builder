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
  // What a spring is. 'chamber': a room under the ground with a screened
  // lid whose top IS the ground -- from above, hillside with water welling
  // out of it (see carveChamber). 'lake': the tube straight up into a
  // lake's bed, where the lake itself takes the jet; a spring placed in
  // standing water is one of these whatever this says. 'pool': the old
  // open pool with a lip and a notch.
  kind: 'chamber',
  chamberRadiusMM: 17, // the lid's radius, near enough: room for a screen twice the bore round the jet
  chamberDepthMM: 8, // how far the chamber's floor is below the ledge the lid sits on
  capMM: 3, // the lid is at least this thick, at the lowest ground over it
  shelfMM: 2, // the ledge the lid rests on
  lidClearanceMM: 0.3, // the lid is this much smaller than its hole all round
  holeMM: 2.2, // the screen's holes
  webMM: 1.1, // and the plastic between them
  tubeIdMM: 9.5, // 3/8" ID: the bore the water arrives through, for the area sum
  openRatio: 2, // the screen opens this many times the tube's bore: it leaves at half the speed it came
  jetClearMM: 2, // no hole within this of the jet (the tube's inside): it hits solid lid and spreads
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


/**
 * A spring as a CHAMBER: a room under the ground, and a lid whose top is the
 * ground, screened with holes. From relief, for the same reason: a tube
 * opening onto a hillside squirts, and a pool big enough to calm it looks
 * wrong at the top of a mountain. The tube fills the room, the jet hits the
 * underside of the lid -- no hole is drilled over it -- and the water wells
 * up through the screen and runs off down the hill.
 *
 * WHAT DECIDES IT IS AREA. Water leaving through holes that add up to less
 * than the tube's bore comes out FASTER than it went in, however big the
 * room behind them. So the screen opens `openRatio` times the bore -- twice,
 * by default: it leaves at half the speed it arrived -- and what it really
 * opened is measured and reported.
 *
 * The chamber is cut down from the surface, so it is all height field: a
 * ledge `shelfMM` wide at `capMM` below the LOWEST ground over the lid, so
 * the lid is never thinner than that, and a floor `chamberDepthMM` below the
 * ledge. The lid is a separate part, printed flat side down. It drops onto
 * the ledge and lifts out, so the chamber can be resined and cleaned.
 *
 * Returns the spring, with `lid` (its top heights, for lidSolid) and
 * `cover` (the ground over the hole, so a view of the module shows the lid
 * in place), or `{ skipped }`.
 */
export function carveChamber(local, o = {}) {
  const f = { ...FOUNTAIN_DEFAULTS, ...o };
  const { nx, ny, step } = local;
  const z = local.values;
  const [x, y] = f.atMM;
  const R = f.chamberRadiusMM;
  const extent = (nx - 1) * step;
  if (Math.min(x, y, extent - x, extent - y) < R + 2) return { skipped: `a ${R} mm chamber does not fit that close to the rim` };
  const rBore = boreRadiusMM(f);
  const inner = R - f.shelfMM;
  const jetR = f.tubeIdMM / 2 + f.jetClearMM;
  if (inner < Math.max(rBore + 1, jetR + f.holeMM)) return { skipped: `a ${R} mm chamber has no room round its ${(2 * rBore).toFixed(1)} mm bore` };

  // The ground before anything is cut, for the lid's top.
  const ground = (px, py) => {
    const u = Math.max(0, Math.min(nx - 1, px / step));
    const v = Math.max(0, Math.min(ny - 1, py / step));
    const i = Math.min(nx - 2, Math.floor(u));
    const j = Math.min(ny - 2, Math.floor(v));
    const fu = u - i;
    const fv = v - j;
    const g = (a, b) => z[b * nx + a];
    return (g(i, j) * (1 - fu) + g(i + 1, j) * fu) * (1 - fv) + (g(i, j + 1) * (1 - fu) + g(i + 1, j + 1) * fu) * fv;
  };
  let lowest = Infinity;
  let highest = -Infinity;
  for (let r = 0; r <= R; r += Math.max(0.5, R / 8)) {
    for (let a = 0; a < 32; a++) {
      const t = (2 * Math.PI * a) / 32;
      const g = ground(x + r * Math.cos(t), y + r * Math.sin(t));
      if (g < lowest) lowest = g;
      if (g > highest) highest = g;
    }
  }
  const ledgeZ = lowest - f.capMM;
  const floorZ = Math.max(f.floorMM, ledgeZ - f.chamberDepthMM);
  if (ledgeZ - f.floorMM < 2.5) {
    return { skipped: `there is not enough ground here to roof a chamber: ${lowest.toFixed(1)} mm, and the lid wants ${f.capMM} mm over a room` };
  }

  // The lid's top: the ground as it is now, on a fine grid of its own.
  const lidR = R - f.lidClearanceMM;
  const lstep = 0.25;
  const ln = Math.ceil((2 * lidR) / lstep) + 2;
  const l0 = -(ln - 1) * lstep / 2;
  const top = new Float32Array(ln * ln);
  for (let j = 0; j < ln; j++) for (let i = 0; i < ln; i++) top[j * ln + i] = ground(x + l0 + i * lstep, y + l0 + j * lstep) - ledgeZ;
  // The screen: a triangular lattice over the open room, none over the jet.
  const pitch = f.holeMM + f.webMM;
  const holes = [];
  const reach = inner - f.holeMM / 2 - f.webMM / 2;
  for (let row = -40; row <= 40; row++) {
    const hy = row * pitch * Math.sqrt(3) / 2;
    if (Math.abs(hy) > reach) continue;
    for (let col = -40; col <= 40; col++) {
      const hx = (col + (row % 2 ? 0.5 : 0)) * pitch;
      const d = Math.hypot(hx, hy);
      if (d > reach || d < jetR + f.holeMM / 2) continue;
      holes.push([hx, hy]);
    }
  }
  const tubeArea = Math.PI * (f.tubeIdMM / 2) ** 2;
  const holeArea = Math.PI * (f.holeMM / 2) ** 2;
  // Enough to reach openRatio, spread out from the middle; all of them if
  // that is what it takes.
  holes.sort((a, b) => Math.hypot(a[0], a[1]) - Math.hypot(b[0], b[1]));
  const want = Math.ceil((f.openRatio * tubeArea) / holeArea);
  const used = holes.length > want ? spreadPick(holes, want) : holes;

  // Cut the hole the lid sits in: the ledge, then the room. Only cuts.
  const cover = [];
  const i0 = Math.max(0, Math.floor((x - R) / step));
  const i1 = Math.min(nx - 1, Math.ceil((x + R) / step));
  const j0 = Math.max(0, Math.floor((y - R) / step));
  const j1 = Math.min(ny - 1, Math.ceil((y + R) / step));
  for (let j = j0; j <= j1; j++) {
    for (let i = i0; i <= i1; i++) {
      const d = Math.hypot(i * step - x, j * step - y);
      if (d > R) continue;
      const k = j * nx + i;
      cover.push([k, z[k]]);
      const want2 = d >= inner ? ledgeZ : floorZ;
      if (z[k] > want2) z[k] = want2;
    }
  }
  return {
    kind: 'chamber',
    atMM: [x, y],
    bore: { x, y, rMM: rBore },
    bedMM: floorZ,
    ledgeMM: ledgeZ,
    // Where the water comes out: the ground over the lid.
    spillMM: lowest,
    poolRadiusMM: R,
    tubeOdMM: f.tubeOdMM,
    lid: { radiusMM: lidR, step: lstep, n: ln, origin: l0, top, holes: used, holeMM: f.holeMM, capMinMM: f.capMM, capMaxMM: highest - ledgeZ },
    openAreaMM2: used.length * holeArea,
    tubeAreaMM2: tubeArea,
    openRatio: (used.length * holeArea) / tubeArea,
    cover: { cells: Int32Array.from(cover, (c) => c[0]), z: Float32Array.from(cover, (c) => c[1]) },
  };
}

/** `count` of the points, spread evenly by angle and distance: every other one, every third... */
function spreadPick(pts, count) {
  const stride = pts.length / count;
  const out = [];
  for (let k = 0; k < count; k++) out.push(pts[Math.min(pts.length - 1, Math.floor(k * stride + stride / 2))]);
  return out;
}

/**
 * A chamber's lid as a closed solid, printed flat side down: the bottom is
 * the face that sits on the ledge, the top is the ground that was there.
 */
export function lidSolid(lid, meshMasked) {
  const { n, step, origin, top, holes, holeMM, radiusMM } = lid;
  const rh = holeMM / 2;
  const cellIn = (i, j) => {
    const cx = origin + (i + 0.5) * step;
    const cy = origin + (j + 0.5) * step;
    if (Math.hypot(cx, cy) > radiusMM) return false;
    for (const [hx, hy] of holes) if (Math.hypot(cx - hx, cy - hy) < rh) return false;
    return true;
  };
  return meshMasked(n, n, step, top, cellIn, 0);
}

/** Several lids side by side, for one STL. */
export function lidSheet(lids, meshMasked) {
  const parts = lids.map((l) => ({ tris: lidSolid(l, meshMasked), w: l.n * l.step }));
  const total = parts.reduce((a, p) => a + p.tris.length, 0);
  const out = new Float32Array(total);
  let at = 0;
  let dx = 0;
  for (const p of parts) {
    for (let i = 0; i < p.tris.length; i += 3) { out[at + i] = p.tris[i] + dx; out[at + i + 1] = p.tris[i + 1]; out[at + i + 2] = p.tris[i + 2]; }
    at += p.tris.length;
    dx += p.w + 4;
  }
  return out;
}

/** A spring straight into a lake: the tube up through its bed, and nothing else. The lake takes the jet. */
export function lakeSpring(local, o = {}) {
  const f = { ...FOUNTAIN_DEFAULTS, ...o };
  const [x, y] = f.atMM;
  return { kind: 'lake', atMM: [x, y], bore: { x, y, rMM: boreRadiusMM(f) }, tubeOdMM: f.tubeOdMM, poolRadiusMM: 0 };
}
