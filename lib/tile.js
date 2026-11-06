// tile.js — the one place metres become millimetres.
//
// Everything upstream of here (terrain, glacier, hillslope) is real metres,
// because that is the frame the physics is written in. Everything downstream
// (channels, meshing, STL) is millimetres on the plate. Keeping the
// conversion to a single function is what stops the two frames leaking into
// each other.
//
// THE MODULE IS CUT FROM THE MIDDLE OF A BIGGER WORLD. The world the ice
// runs on is the module plus a margin on every side (spec.marginMM, half a
// module by default), because a glacier pinned to zero thickness at the
// domain's edge cannot flow into a module from outside it, and a mountain
// that stops dead at the rim has no catchment. The margin is thrown away;
// it only exists so the ice has somewhere to come from.
//
// WHY EVERY EDGE IS FORCED TO THE CONTRACT. A piece is only interchangeable
// if its boundary is a declared profile rather than whatever the generator
// happened to produce there. So the generator is free in the middle of a
// module and overruled at its rim, with a blend between.

import { makeField } from './field.js';
import { tileEdgeProfile, seamProfile, edgeLand, minEdgeLand, hasPort, inPort, grooveDepthAt, blendOf, EDGES } from './contract.js';

const smoothstep = (t) => { const u = Math.max(0, Math.min(1, t)); return u * u * (3 - 2 * u); };

/**
 * Cut the module out of the world field and return it as a local height
 * field in millimetres, measured from the module's own base.
 *
 *   world            the eroded bed, in metres, covering the module and its margin
 *   c                the contract
 *   opts.marginMM    how far the world runs past the module on each side
 *   opts.metresPerMM ground metres per print millimetre (see scale.js)
 *   opts.meshMM      grid spacing of the output, in mm on the plate
 *   opts.ports       which edges a channel crosses, if any
 *
 * THE DATUM. The contract says each rim stands at its class height, and a channel
 * crosses it channelDepthMM down, so the ground where a channel leaves the
 * module IS the rim height: the ground at the ports is put at the mean rim height of those sides
 * and everything else is measured from there. Mountains stand above it at
 * their true height; the valley the channel runs down is at the rim where
 * it crosses, and the rim either side of the port comes down to meet it
 * over the blend. With no channel, the rim's own mean is the datum.
 *
 * Ground BELOW the rim's height, once the valley's tilt is taken out (see
 * below) -- a trough the ice cut deeper than the valley floor at the rim --
 * is squeezed, smoothly, so that it never cuts through the plate: the
 * squeeze is nothing near the rim's height and saturates at `minLandMM`
 * above the base, and because it is a smooth function of depth it leaves
 * no step. An overdeepening is still a basin; it is a shallower one than
 * the metres say, and the report says so.
 */
export function cutTile(world, c, opts = {}) {
  const { marginMM = c.tileMM / 2, metresPerMM = 25, meshMM = 0.8, ports = {} } = opts;
  const T = c.tileMM;
  const n = Math.max(8, Math.round(T / meshMM) + 1);
  const step = T / (n - 1);
  const local = makeField(n, n, step, 0, 0);
  const sampleAt = (x, y) => sampleWorld(world, (marginMM + x) * metresPerMM, (marginMM + y) * metresPerMM);

  const portEdges = EDGES.filter((e) => ports && ports[e]);
  let sum = 0;
  let cnt = 0;
  if (portEdges.length) {
    for (const e of portEdges) {
      const [x, y] = e === 'N' ? [T / 2, T] : e === 'S' ? [T / 2, 0] : e === 'E' ? [T, T / 2] : [0, T / 2];
      sum += sampleAt(x, y);
      cnt++;
    }
  } else {
    const K = 64;
    for (let k = 0; k <= K; k++) {
      const s = (T * k) / K;
      for (const [x, y] of [[s, 0], [s, T], [0, s], [T, s]]) { sum += sampleAt(x, y); cnt++; }
    }
  }
  const refM = sum / cnt;
  // The datum: the mean rim height of the sides the channels cross, or of
  // all four when nothing crosses. Sides of different classes differ from
  // it; the lean below takes that up as a tilt, which is what a module whose
  // water comes in high and leaves low should have.
  const datumSides = portEdges.length ? portEdges : EDGES;
  const datumMM = datumSides.reduce((a, e) => a + edgeLand(c, e), 0) / datumSides.length;
  for (let j = 0; j < n; j++) {
    const y = j * step;
    for (let i = 0; i < n; i++) local.values[j * n + i] = datumMM + (sampleAt(i * step, y) - refM) / Math.max(1e-9, metresPerMM);
  }

  // TAKE THE TILT OUT FIRST. A valley runs DOWN through a module -- that is
  // what a valley does -- but the module's rim is level, so the fall across
  // it has to come out. Leaning the ground onto a flat rim with every side
  // land does that (see conformToContract: the plane through the rim
  // residuals is the fall). Done BEFORE the squeeze below, so the squeeze
  // works on the straightened ground and a reach that was only low because
  // it was downstream is not crushed for it.
  conformToContract(local, c, {});

  // Then the squeeze: smooth, nothing near the LOWEST rim's height,
  // saturating at minLandMM. Ground may go below the lowest side a module
  // has -- a lake, a low floor -- but it has to come back up to the rim, and
  // it never gets near the base. Every rim is at or above that height now,
  // so the rims are untouched.
  const low = minEdgeLand(c);
  const D = Math.max(0.5, low - c.minLandMM);
  let squeezedMM = 0;
  for (let k = 0; k < n * n; k++) {
    const z = local.values[k];
    if (z >= low) continue;
    const below = low - z;
    const to = D * Math.tanh(below / D);
    if (below - to > squeezedMM) squeezedMM = below - to;
    local.values[k] = low - to;
  }
  local.datumM = refM;
  local.squeezedMM = squeezedMM; // how much the deepest point was lifted to keep its floor
  return local;
}

/** Bilinear sample of a world field at world metres, clamped to the field. */
function sampleWorld(f, x, y) {
  const u = Math.max(0, Math.min(f.nx - 1, (x - f.originX) / f.step));
  const v = Math.max(0, Math.min(f.ny - 1, (y - f.originY) / f.step));
  const i = Math.min(f.nx - 2, Math.floor(u));
  const j = Math.min(f.ny - 2, Math.floor(v));
  const fu = u - i;
  const fv = v - j;
  const z = (a, b) => f.values[b * f.nx + a];
  return (z(i, j) * (1 - fu) + z(i + 1, j) * fu) * (1 - fv) + (z(i, j + 1) * (1 - fu) + z(i + 1, j + 1) * fu) * fv;
}

/**
 * Make a module agree with its contract at the rim, WITHOUT flattening it.
 * Always the last thing done to it.
 *
 * For each edge, take the residual between what the contract declares and
 * what the generator produced along that edge, and ADD a correction to the
 * module that is exactly that residual at the rim. Two parts:
 *
 *   THE TILT. A valley runs DOWN through a module, and the rim is level, so
 *   the fall across the module has to come out. The best-fit PLANE through
 *   the four rims' residuals is that fall, and it is added over the whole
 *   module: for a valley that falls steadily it leaves the valley's shape
 *   with its gradient gone, and it costs the middle nothing but a lean.
 *
 *   THE REST. What is left of the residual after the plane -- a ridge
 *   running out through a side, a noise bump on the rim, the step between
 *   two sides of different classes -- is fanned in from the four sides (see
 *   below) and faded out over each side's blend (`blendOf`) from its rim.
 *   Spread over the whole module instead (rimBlendMM 0) it would take a
 *   ridge that crosses both the east and the west sides out ENTIRELY: the
 *   ruled surface between two equal residuals is a constant. Confined to a
 *   band it does what a module's edge has to do anyway -- bring the ground
 *   down to the rim -- and leaves the mountain in the middle standing.
 *
 * At the rim both parts together are exactly the gap, so the boundary lands
 * exactly on the contract. `ports` is which edges a channel crosses.
 */
export function conformToContract(local, c, ports = {}) {
  const n = local.nx;
  const step = local.step;
  const T = c.tileMM;
  const g = (i, j) => local.values[j * n + i];
  const rS = new Float64Array(n);
  const rN = new Float64Array(n);
  const rW = new Float64Array(n);
  const rE = new Float64Array(n);
  for (let k = 0; k < n; k++) {
    const d = k * step;
    rS[k] = tileEdgeProfile(c, ports, 'S', d) - g(k, 0);
    rN[k] = tileEdgeProfile(c, ports, 'N', T - d) - g(k, n - 1);
    rW[k] = tileEdgeProfile(c, ports, 'W', T - d) - g(0, k);
    rE[k] = tileEdgeProfile(c, ports, 'E', d) - g(n - 1, k);
  }
  // rN is indexed by COLUMN like rS: rN[0] is the north-west end.

  // The plane a + b u + c v through the rim residuals, by least squares.
  let Suu = 0; let Svv = 0; let Suv = 0; let Su = 0; let Sv = 0; let S1 = 0;
  let Sr = 0; let Sru = 0; let Srv = 0;
  const take = (u, v, r) => { Suu += u * u; Svv += v * v; Suv += u * v; Su += u; Sv += v; S1 += 1; Sr += r; Sru += r * u; Srv += r * v; };
  for (let k = 0; k < n; k++) {
    const f = k / (n - 1);
    take(f, 0, rS[k]); take(f, 1, rN[k]); take(0, f, rW[k]); take(1, f, rE[k]);
  }
  // Solve [S1 Su Sv; Su Suu Suv; Sv Suv Svv] [a b c] = [Sr Sru Srv].
  const m = [[S1, Su, Sv], [Su, Suu, Suv], [Sv, Suv, Svv]];
  const rhs = [Sr, Sru, Srv];
  const det = (M) => M[0][0] * (M[1][1] * M[2][2] - M[1][2] * M[2][1]) - M[0][1] * (M[1][0] * M[2][2] - M[1][2] * M[2][0]) + M[0][2] * (M[1][0] * M[2][1] - M[1][1] * M[2][0]);
  const D = det(m);
  const col = (i) => m.map((row, r) => row.map((v, cc) => (cc === i ? rhs[r] : v)));
  const [a, b, cc] = Math.abs(D) > 1e-12 ? [det(col(0)) / D, det(col(1)) / D, det(col(2)) / D] : [0, 0, 0];
  const plane = (u, v) => a + b * u + cc * v;

  for (let k = 0; k < n; k++) {
    const f = k / (n - 1);
    rS[k] -= plane(f, 0); rN[k] -= plane(f, 1); rW[k] -= plane(0, f); rE[k] -= plane(1, f);
  }
  // Each side's leftover is faded out over that side's own blend: a short
  // one stands the ground up to the rim and drops it there as a cliff, a
  // long one slopes it down. 0 spreads it over the whole module.
  const band = (d, e) => { const b = blendOf(c, e); return b > 0 ? 1 - smoothstep(d / b) : 1; };

  // THE FAN. Each side's leftover residual is spread inward with a weight
  // that is 1 on that side and falls off as the inverse square of the
  // distance to it, the four weights normalised. Away from the corners that
  // is one side's residual, as a Coons patch would give. AT a corner, where
  // two sides of different classes meet and their residuals disagree by the
  // step between them, the weights go as cos^2 of the bearing from the
  // corner: the step is taken up over an arc that is a few millimetres wide
  // a few millimetres from the corner and widens with the distance -- a
  // steep ramp fanning out from the corner, vertical only at the corner
  // point itself, and gone where the band ends. A Coons patch cannot do
  // this: it assumes the two sides agree at the corner.
  //
  // The corner vertex itself belongs to the north or south side: a point
  // can only have one height, and the two sides' heights there differ.
  for (let j = 0; j < n; j++) {
    const v = j / (n - 1);
    const y = j * step;
    for (let i = 0; i < n; i++) {
      const u = i / (n - 1);
      const x = i * step;
      let D;
      if (j === 0) D = rS[i];
      else if (j === n - 1) D = rN[i];
      else if (i === 0) D = rW[j];
      else if (i === n - 1) D = rE[j];
      else {
        const wS = 1 / (y * y);
        const wN = 1 / ((T - y) * (T - y));
        const wW = 1 / (x * x);
        const wE = 1 / ((T - x) * (T - x));
        D = (wS * rS[i] * band(y, 'S') + wN * rN[i] * band(T - y, 'N') + wW * rW[j] * band(x, 'W') + wE * rE[j] * band(T - x, 'E'))
          / (wS + wN + wW + wE);
      }
      local.values[j * n + i] += plane(u, v) + D;
    }
  }
  return local;
}

/**
 * The silicone rebate: across every port, in the last grooveWidthMM before
 * the seam, the bed is cut grooveDepthMM below the profile the module was
 * just leaned onto. Done after the LAST conform, so it is a crisp step and
 * not a trough the band would spread inward. A bead of silicone laid in it
 * on each module meets the other's when the two are locked together.
 */
export function cutSeamGrooves(local, c, ports = {}) {
  const n = local.nx;
  const step = local.step;
  const T = c.tileMM;
  const W = c.grooveWidthMM;
  let cells = 0;
  if (!(W > 0)) return { cells };
  const reach = Math.ceil(W / step);
  for (const e of EDGES) {
    if (!hasPort(ports, e)) continue;
    const depth = grooveDepthAt(c, e);
    if (!(depth > 0)) continue;
    for (let a = 0; a <= reach; a++) {
      const d = a * step; // in from the seam
      if (d >= W) break;
      for (let k = 0; k < n; k++) {
        const s = k * step;
        if (!inPort(c, s)) continue;
        let i; let j; let along;
        if (e === 'S') { i = k; j = a; along = s; }
        else if (e === 'N') { i = k; j = n - 1 - a; along = T - s; }
        else if (e === 'W') { i = a; j = k; along = T - s; }
        else { i = n - 1 - a; j = k; along = s; }
        const want = tileEdgeProfile(c, ports, e, along) - depth;
        const idx = j * n + i;
        if (local.values[idx] > want) { local.values[idx] = want; cells++; }
      }
    }
  }
  return { cells };
}

/**
 * Prove a finished module honours its contract by measuring the boundary
 * of the thing that will actually be printed. Returns the worst
 * disagreement on each edge, in mm. A module that comes through here at
 * zero mates with every other module that does.
 */
export function verifyEdges(local, c, ports = {}, { grooves = true } = {}) {
  const n = local.nx;
  const step = local.step;
  const out = {};
  const profile = grooves ? seamProfile : tileEdgeProfile;
  for (const e of EDGES) {
    let worst = 0;
    // The corner vertices belong to the north and south sides (see
    // conformToContract), so the east and west sides are measured between
    // them. Where the classes agree the corners would pass anyway.
    const k0 = e === 'W' || e === 'E' ? 1 : 0;
    for (let k = k0; k < n - k0; k++) {
      const d = k * step;
      let got;
      let want;
      if (e === 'S') { got = local.values[k]; want = profile(c, ports, 'S', d); }
      else if (e === 'N') { got = local.values[(n - 1) * n + k]; want = profile(c, ports, 'N', c.tileMM - d); }
      else if (e === 'W') { got = local.values[k * n]; want = profile(c, ports, 'W', c.tileMM - d); }
      else { got = local.values[k * n + (n - 1)]; want = profile(c, ports, 'E', d); }
      worst = Math.max(worst, Math.abs(got - want));
    }
    out[e] = worst;
  }
  out.worst = Math.max(...EDGES.map((e) => out[e]));
  return out;
}
