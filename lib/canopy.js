// canopy.js — trees, as texture you can print.
//
// WHY INSTANCES AND NOT NOISE. A noise field tuned to look bumpy gives
// bumpy ground, not a wood. What reads as forest from above is a field of
// SEPARATE CROWNS: round ones that merge into a lumpy mass for broadleaf,
// pointed ones that stay distinct for conifer. So each tree is placed and
// stamped, which also means its size is a number you set rather than a
// frequency you fiddle with -- the same stamp at 4 mm is a hedge, at 9 mm
// scrub, at 16 mm a mature canopy.
//
// THE TWO SHAPES.
//
// Deciduous is NOT a dome. A dome prints as a blister and reads as a
// boulder. A broadleaf crown seen from above is a few rounded lobes pushing
// against each other, so each tree here is three to five overlapping half
// ellipsoids at small offsets, combined by taking the highest. The lumpiness
// is then a property of the shape rather than noise laid over it, and it
// survives being scaled.
//
// Conifer is a cone, with the spire slightly convex and a few branch whorls
// stepped into the flank, because a plain cone reads as a traffic bollard.
//
// Crowns combine with a SMOOTH MAX, never by adding. Adding makes a dense
// wood swell into one mound and lose every crown edge. A plain max keeps
// the edges but creases where two crowns cross, so a dense stand reads as
// separate trees pressed together rather than as canopy. The soft union
// does both: far apart it is exactly max and low density still reads as
// distinct trees; where crowns overlap they interlock, as they do in a
// closed stand.
//
// EVERYTHING IS MILLIMETRES ON THE PLATE. Trees are placed after the tile
// has been conformed to its contract and are kept clear of the rim by their
// own radius, so no tree ever crosses a seam -- which is the rule the whole
// project runs on: terrain does not go past a tile.

const TAU = Math.PI * 2;

/** Deterministic [0,1) from a few integers, so a tile regrows identically. */
function rnd(a, b, c = 0, d = 0) {
  let h = (a | 0) * 374761393 + (b | 0) * 668265263 + (c | 0) * 2147483647 + (d | 0) * 1274126177;
  h = (h ^ (h >>> 13)) >>> 0;
  h = Math.imul(h, 1274126177) >>> 0;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

export const KINDS = ['deciduous', 'conifer'];

export const CANOPY_DEFAULTS = {
  kind: 'deciduous',
  crownMM: 9, // crown diameter
  heightMM: 7, // how far the crown stands above the ground
  // HOW THICK THE WOOD IS, as the fraction of ground under canopy. One
  // number from bare to closed, and it means something you can see rather
  // than a distance you have to work out from the crown size:
  //
  //   0.05  a few scattered trees
  //   0.25  open woodland, gaps everywhere
  //   0.55  proper wood, crowns nearly touching
  //   1.0   closed canopy, crowns overlapping
  //
  // Spacing follows from it and the crown size, so changing one does not
  // silently undo the other: trees on a grid of spacing s with crowns of
  // diameter d cover pi*d^2/(4*s^2) of the ground, so s = 0.886*d/sqrt(cover).
  // Set spacingMM instead to drive it the other way round.
  density: 0.35,
  spacingMM: null, // explicit trunk spacing; overrides density when set
  jitter: 0.55, // how far off its grid cell a tree may wander, 0..1
  sizeVariation: 0.35, // +/- fraction on crown and height
  // Deciduous only. Broadleaf canopy from above is a CAULIFLOWER: many
  // bumps at a quarter the width of the crown, not four bumps at half of
  // it. Six half-size lobes measured as 15% variation around a ring and
  // still read as a smooth ball, because at that scale the lobes ARE the
  // dome. Nine lobes at under a third of the radius breaks the silhouette.
  lobes: 9,
  // How far the outer lobes sit from the trunk, as a fraction of the crown
  // radius. This and the lobe size are what decide whether the crown READS
  // as lumpy. Tuned at 0.34 with lobes nearly as wide as the whole crown it
  // came out varying 3% around a ring -- geometrically lumpy, visually a
  // dome. Smaller lobes pushed further out give distinct masses.
  lobeSpread: 0.62,
  lobeSize: 0.30, // outer lobe radius, as a fraction of the crown radius
  whorls: 3, // conifer only: branch tiers stepped into the flank
  whorlDepth: 0.16, // how pronounced those tiers are
  spire: 1.25, // conifer profile exponent; >1 is a slim spire, 1 a plain cone
  lean: 0.1, // a little off-vertical, so a stand is not a pin cushion
  // A treeline is a band, not a line. Over the last this-many mm below
  // maxZMM (and above minZMM) the wood thins out instead of stopping dead,
  // which is what the edge of a real one does.
  thinningMM: 0,
  // How far crowns fuse where they overlap. 0 is a hard max, which creases.
  // Scaled with the crown in scatterCanopy, so it means the same thing on a
  // hedge and on a mature canopy.
  mergeFraction: 0.18,
};

/**
 * How much ground one crown actually covers, in mm^2.
 *
 * NOT pi*r^2. A lobed broadleaf crown does not fill its nominal circle --
 * there are gaps between the outer lobes -- and a conifer's out-of-round
 * plan does not either. Using the circle made `density: 1` come out at 58%
 * measured cover, so the number in the spec file meant nothing in
 * particular.
 *
 * So it is measured rather than assumed: stamp one tree and count. Done at
 * runtime because every shape parameter -- lobes, lobeSize, spire, whorls --
 * changes the answer, and a constant calibrated once would drift silently
 * the next time one of them was tuned. Averaged over a few phases because a
 * single tree is a bit lopsided by design.
 */
export function crownFootprintMM2(o, stepMM = Math.max(0.2, o.crownMM / 24)) {
  const R = o.crownMM / 2;
  const rad = Math.ceil((R * 1.3) / stepMM);
  let total = 0;
  const phases = [0.0, 1.3, 2.7, 4.4];
  for (const phase of phases) {
    const t = { ...o, id: 1 + Math.round(phase * 97), x: 0, y: 0, phase, leanX: 0, leanY: 0 };
    let cells = 0;
    for (let j = -rad; j <= rad; j++) {
      for (let i = -rad; i <= rad; i++) {
        if (crownHeight(t, i * stepMM, j * stepMM) > 0) cells++;
      }
    }
    total += cells * stepMM * stepMM;
  }
  return total / phases.length;
}

/**
 * Trunk spacing for a target canopy cover. See `density`.
 *
 * THE OVERLAP CORRECTION, which the first version did not have and which is
 * the whole reason a dense wood did not read as one.
 *
 * Dividing the footprint by the target cover assumes crowns never land on
 * each other, and it is fine while they do not. Once they do, every extra
 * tree covers less new ground than the last, so cover saturates: at
 * `density: 1` the spacing came out at 0.89 of a crown diameter -- crowns
 * just touching, ground visible between them, and a closed canopy that
 * still read as a scatter of separate trees.
 *
 * Scattered crowns cover ground like a Poisson process, so the fraction
 * NOT covered is exp(-lambda*A) and
 *
 *     cover = 1 - exp(-A / s^2)    =>    s = sqrt( A / -ln(1 - cover) )
 *
 * At 1.0 that is 0.39 of a crown diameter instead of 0.89, which is proper
 * overlap. A jittered grid spreads trees out a little more evenly than
 * Poisson, so this errs toward denser, which is the right way to err.
 */
export function spacingForDensity(o) {
  const cover = Math.max(0.004, Math.min(0.995, o.density));
  return Math.sqrt(crownFootprintMM2(o) / -Math.log(1 - cover));
}

/**
 * Smooth maximum: the polynomial soft union, blending over a width of k.
 *
 * A plain max of two crowns leaves a sharp crease where they cross, so a
 * dense wood comes out as separate trees pressed together rather than as
 * canopy. Real crowns in a closed stand interlock. Below k the two fuse;
 * well apart, this is exactly max, so a lone tree is unaffected and low
 * density still reads as distinct trees -- which is the half that was
 * already right.
 */
export function smoothMax(a, b, k) {
  if (!(k > 0)) return a > b ? a : b;
  const h = Math.max(0, Math.min(1, 0.5 + (0.5 * (a - b)) / k));
  return b + (a - b) * h + k * h * (1 - h);
}

/**
 * The height a single tree adds at a point, in mm above the ground, or 0.
 * `dx`,`dy` are offsets from the trunk.
 */
export function crownHeight(t, dx, dy) {
  const R = t.crownMM / 2;
  if (dx * dx + dy * dy > R * R * 1.3) return 0;
  if (t.kind === 'conifer') {
    // Slight lean, and an out-of-round plan, so no two are identical.
    const px = dx - t.leanX;
    const py = dy - t.leanY;
    const d = Math.hypot(px, py);
    const az = Math.atan2(py, px);
    const Rr = R * (1 + 0.12 * Math.sin(az * 3 + t.phase) + 0.07 * Math.sin(az * 5 - t.phase));
    if (d >= Rr) return 0;
    const u = d / Rr;
    let h = t.heightMM * Math.pow(1 - u, t.spire);
    // Branch whorls: shelves stepped into the flank, fading out at the tip.
    if (t.whorls > 0 && t.whorlDepth > 0) {
      const w = Math.sin(TAU * t.whorls * u + t.phase);
      h += t.heightMM * t.whorlDepth * Math.max(0, w) * (1 - u) * u;
    }
    return Math.max(0, h);
  }
  // Deciduous: the highest of several overlapping half ellipsoids. Lobe 0
  // sits over the trunk and guarantees the crown is filled; the rest ring
  // it and are what make the outline lumpy.
  let best = 0;
  const nLobes = Math.max(2, t.lobes);
  for (let i = 0; i < nLobes; i++) {
    let ox = t.leanX;
    let oy = t.leanY;
    let r;
    let hh;
    if (i === 0) {
      // A modest core, only there so the crown has no hole in the middle.
      // Made tall and wide it becomes the whole tree and every outer lobe
      // hides beneath its silhouette -- which is how the first version came
      // out looking like a bag of gumballs despite measuring as lumpy.
      r = R * 0.40;
      hh = t.heightMM * (0.78 + 0.14 * rnd(t.id, 0, 19));
    } else {
      const a = t.phase + (TAU * (i - 1)) / (nLobes - 1) + 0.6 * (rnd(t.id, i, 7) - 0.5);
      const off = t.lobeSpread * R * (0.78 + 0.42 * rnd(t.id, i, 11));
      ox += Math.cos(a) * off;
      oy += Math.sin(a) * off;
      r = R * t.lobeSize * (0.82 + 0.42 * rnd(t.id, i, 13));
      // Within reach of the core, so several masses share the skyline and
      // the eye reads lobes rather than one dome.
      hh = t.heightMM * (0.70 + 0.34 * rnd(t.id, i, 17));
    }
    const d = Math.hypot(dx - ox, dy - oy);
    if (d >= r) continue;
    const h = hh * Math.sqrt(Math.max(0, 1 - (d / r) * (d / r)));
    if (h > best) best = h;
  }
  return best;
}

/**
 * Where the trees go: a jittered grid, which is a cheap Poisson disk and
 * close enough for a wood. `accept(x, y)` decides whether a trunk may stand
 * at a point.
 */
export function placeTrees(o, extentMM, accept) {
  const spacing = Math.max(0.5, Number.isFinite(o.spacingMM) && o.spacingMM > 0
    ? o.spacingMM
    : spacingForDensity(o));
  const cells = Math.max(1, Math.floor(extentMM / spacing));
  const trees = [];
  let rejected = 0;
  let id = 0;
  for (let j = 0; j < cells; j++) {
    for (let i = 0; i < cells; i++) {
      id++;
      const jx = (rnd(o.seed, i, j, 1) - 0.5) * o.jitter * spacing;
      const jy = (rnd(o.seed, i, j, 2) - 0.5) * o.jitter * spacing;
      const x = (i + 0.5) * spacing + jx;
      const y = (j + 0.5) * spacing + jy;
      const v = (rnd(o.seed, i, j, 3) - 0.5) * 2 * o.sizeVariation;
      const crownMM = o.crownMM * (1 + v);
      const heightMM = o.heightMM * (1 + v * 0.8);
      if (crownMM <= 0 || heightMM <= 0) { rejected++; continue; }
      if (!accept(x, y, crownMM / 2, rnd(o.seed, i, j, 8))) { rejected++; continue; }
      const leanA = rnd(o.seed, i, j, 4) * TAU;
      const leanR = o.lean * (crownMM / 2) * rnd(o.seed, i, j, 5);
      // Spread the whole option set rather than naming the shape fields.
      // Naming them meant that adding `lobeSize` to the defaults and using
      // it in crownHeight left it UNDEFINED on every tree built here: the
      // lobe radius came out NaN, `d >= NaN` is false and `h > best` is
      // false, so every outer lobe was silently dropped and deciduous trees
      // rendered as the bare central dome. Nothing threw, and the unit test
      // passed because it built its own tree object from the defaults --
      // which is to say the test exercised a path production never took.
      trees.push({
        ...o,
        id: id + o.seed * 7919,
        x, y, crownMM, heightMM,
        phase: rnd(o.seed, i, j, 6) * TAU,
        leanX: Math.cos(leanA) * leanR,
        leanY: Math.sin(leanA) * leanR,
      });
    }
  }
  return { trees, rejected };
}

/**
 * Stamp a wood onto a tile, in place.
 *
 * `local` is the tile's height field in mm. `opts` takes CANOPY_DEFAULTS plus:
 *   seed          deterministic regrowth
 *   keepClearMM   how far a TRUNK stays from the rim, on top of its own radius
 *   wet           Uint8Array from the river carve; nothing is planted in water
 *   bankMM        how far back from the water the bank stays clear
 *   baseMM        the tile's plate stack, so the band below is read in WORLD
 *                 height. Without it a treeline is meaningless: every tile's
 *                 local heights start from its own base, so a summit tile
 *                 standing on six plates looks exactly like a valley tile to
 *                 a local-height test, and the first run planted woods over
 *                 every mountain top on the map.
 *   minZMM/maxZMM an elevation band in world mm — maxZMM is a treeline, and
 *                 it is the cheapest thing here that makes a mountain read
 *                 right
 *   maxSlopeDeg   nothing grows on a cliff
 */
export function scatterCanopy(local, opts = {}) {
  const o = { ...CANOPY_DEFAULTS, seed: 1, keepClearMM: 1, bankMM: 2, baseMM: 0, ...opts };
  const { nx, ny, step } = local;
  const extent = (nx - 1) * step;
  const z = local.values;
  const warnings = [];

  if (o.crownMM / step < 5) {
    warnings.push(
      `A ${o.crownMM} mm crown is only ${(o.crownMM / step).toFixed(1)} cells across at this mesh. ` +
      `It will print as a lump. Use meshMM of about ${(o.crownMM / 8).toFixed(2)} or smaller, or a bigger crown.`,
    );
  }

  const at = (i, j) => z[Math.min(ny - 1, Math.max(0, j)) * nx + Math.min(nx - 1, Math.max(0, i))];
  const slopeDeg = (i, j) => {
    const gx = (at(i + 1, j) - at(i - 1, j)) / (2 * step);
    const gy = (at(i, j + 1) - at(i, j - 1)) / (2 * step);
    return (Math.atan(Math.hypot(gx, gy)) * 180) / Math.PI;
  };
  const near = (x, y) => {
    const i = Math.round(x / step);
    const j = Math.round(y / step);
    return { i: Math.min(nx - 1, Math.max(0, i)), j: Math.min(ny - 1, Math.max(0, j)) };
  };
  const wetNear = (x, y, r) => {
    if (!o.wet) return false;
    const rad = Math.ceil((r + o.bankMM) / step);
    const { i, j } = near(x, y);
    for (let dj = -rad; dj <= rad; dj++) {
      for (let di = -rad; di <= rad; di++) {
        const ii = i + di;
        const jj = j + dj;
        if (ii < 0 || jj < 0 || ii >= nx || jj >= ny) continue;
        if (o.wet[jj * nx + ii]) return true;
      }
    }
    return false;
  };

  const reasons = { rim: 0, water: 0, band: 0, slope: 0, mask: 0, thinned: 0 };
  // How much of full density survives at this height. 1 in the middle of the
  // band, tapering to 0 over the last thinningMM at either end.
  const densityAt = (g) => {
    if (!(o.thinningMM > 0)) return 1;
    let f = 1;
    if (Number.isFinite(o.maxZMM)) f = Math.min(f, (o.maxZMM - g) / o.thinningMM);
    if (Number.isFinite(o.minZMM)) f = Math.min(f, (g - o.minZMM) / o.thinningMM);
    return Math.max(0, Math.min(1, f));
  };
  const accept = (x, y, r, roll = 1) => {
    const clear = r + o.keepClearMM;
    // No tree may cross a seam. Nothing is clipped at the boundary; a trunk
    // that cannot stand clear simply does not stand.
    if (x < clear || y < clear || x > extent - clear || y > extent - clear) { reasons.rim++; return false; }
    if (wetNear(x, y, r)) { reasons.water++; return false; }
    const { i, j } = near(x, y);
    const g = o.baseMM + z[j * nx + i]; // world height, not tile-local
    if (Number.isFinite(o.minZMM) && g < o.minZMM) { reasons.band++; return false; }
    if (Number.isFinite(o.maxZMM) && g > o.maxZMM) { reasons.band++; return false; }
    if (Number.isFinite(o.maxSlopeDeg) && slopeDeg(i, j) > o.maxSlopeDeg) { reasons.slope++; return false; }
    if (o.where && !o.where(x, y, g)) { reasons.mask++; return false; }
    if (roll > densityAt(g)) { reasons.thinned++; return false; }
    return true;
  };

  const { trees, rejected } = placeTrees(o, extent, accept);

  // Stamp. Crowns combine with max against the canopy only, then the canopy
  // is added to the ground -- so a tree on a slope stands up from the slope
  // rather than being sliced off by it.
  const add = new Float64Array(nx * ny);
  const mergeMM = Number.isFinite(o.mergeMM) ? o.mergeMM : o.mergeFraction * o.heightMM;
  for (const t of trees) {
    const R = t.crownMM / 2;
    const i0 = Math.max(0, Math.floor((t.x - R * 1.2) / step));
    const i1 = Math.min(nx - 1, Math.ceil((t.x + R * 1.2) / step));
    const j0 = Math.max(0, Math.floor((t.y - R * 1.2) / step));
    const j1 = Math.min(ny - 1, Math.ceil((t.y + R * 1.2) / step));
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const h = crownHeight(t, i * step - t.x, j * step - t.y);
        if (h <= 0) continue;
        const k = j * nx + i;
        // Fuse with whatever is already there, but only where there IS
        // something: blending against bare ground would lift a skirt of
        // soil around every isolated tree.
        add[k] = add[k] > 0 ? smoothMax(add[k], h, mergeMM) : h;
      }
    }
  }
  let planted = 0;
  for (let k = 0; k < add.length; k++) if (add[k] > 0) { z[k] += add[k]; planted++; }

  return {
    trees: trees.length,
    rejected,
    reasons,
    cells: planted,
    spacingMM: Math.max(0.5, Number.isFinite(o.spacingMM) && o.spacingMM > 0
      ? o.spacingMM : spacingForDensity(o)),
    // What fraction of the tile actually ended up under canopy. Measured,
    // not predicted: jitter, size variation, water, slope and the treeline
    // all take their cut, so the number asked for and the number on the
    // plate are not the same thing.
    coverFraction: planted / (nx * ny),
    tallestMM: trees.reduce((a, t) => Math.max(a, t.heightMM), 0),
    warnings,
  };
}
