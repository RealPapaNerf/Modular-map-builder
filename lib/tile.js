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
import { tileEdgeProfile, EDGES } from './contract.js';

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
 * THE DATUM. The contract says the rim stands at edgeLandMM, and a channel
 * crosses it channelDepthMM down, so the ground where a channel leaves the
 * module IS the rim height: the ground at the ports is put at edgeLandMM
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
  for (let j = 0; j < n; j++) {
    const y = j * step;
    for (let i = 0; i < n; i++) local.values[j * n + i] = c.edgeLandMM + (sampleAt(i * step, y) - refM) / Math.max(1e-9, metresPerMM);
  }

  // TAKE THE TILT OUT FIRST. A valley runs DOWN through a module -- that is
  // what a valley does -- but the module's rim is level, so the fall across
  // it has to come out. Leaning the ground onto a flat rim with every side
  // land does that (see conformToContract: the plane through the rim
  // residuals is the fall). Done BEFORE the squeeze below, so the squeeze
  // works on the straightened ground and a reach that was only low because
  // it was downstream is not crushed for it.
  conformToContract(local, c, {});

  // Then the squeeze: smooth, nothing near the rim's height, saturating at
  // minLandMM. The rim is at edgeLandMM everywhere now, so it is untouched.
  const D = Math.max(0.5, c.edgeLandMM - c.minLandMM);
  let squeezedMM = 0;
  for (let k = 0; k < n * n; k++) {
    const z = local.values[k];
    if (z >= c.edgeLandMM) continue;
    const below = c.edgeLandMM - z;
    const to = D * Math.tanh(below / D);
    if (below - to > squeezedMM) squeezedMM = below - to;
    local.values[k] = c.edgeLandMM - to;
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
 *   running out through a side, a noise bump on the rim -- is a Coons patch
 *   of the four leftover curves, faded out over `rimBlendMM` from the rim.
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
  const sw = rS[0];
  const se = rS[n - 1];
  const nw = rN[0];
  const ne = rN[n - 1];
  const blend = c.rimBlendMM > 0 ? c.rimBlendMM : 0;

  for (let j = 0; j < n; j++) {
    const v = j / (n - 1);
    const y = j * step;
    for (let i = 0; i < n; i++) {
      const u = i / (n - 1);
      const x = i * step;
      const ruled = (1 - u) * rW[j] + u * rE[j] + (1 - v) * rS[i] + v * rN[i];
      const bilinear = (1 - u) * (1 - v) * sw + u * (1 - v) * se + (1 - u) * v * nw + u * v * ne;
      let w = 1;
      if (blend > 0) {
        const dRim = Math.min(x, y, T - x, T - y);
        w = 1 - smoothstep(dRim / blend);
      }
      local.values[j * n + i] += plane(u, v) + (ruled - bilinear) * w;
    }
  }
  return local;
}

/**
 * Prove a finished module honours its contract by measuring the boundary
 * of the thing that will actually be printed. Returns the worst
 * disagreement on each edge, in mm. A module that comes through here at
 * zero mates with every other module that does.
 */
export function verifyEdges(local, c, ports = {}) {
  const n = local.nx;
  const step = local.step;
  const out = {};
  for (const e of EDGES) {
    let worst = 0;
    for (let k = 0; k < n; k++) {
      const d = k * step;
      let got;
      let want;
      if (e === 'S') { got = local.values[k]; want = tileEdgeProfile(c, ports, 'S', d); }
      else if (e === 'N') { got = local.values[(n - 1) * n + k]; want = tileEdgeProfile(c, ports, 'N', c.tileMM - d); }
      else if (e === 'W') { got = local.values[k * n]; want = tileEdgeProfile(c, ports, 'W', c.tileMM - d); }
      else { got = local.values[k * n + (n - 1)]; want = tileEdgeProfile(c, ports, 'E', d); }
      worst = Math.max(worst, Math.abs(got - want));
    }
    out[e] = worst;
  }
  out.worst = Math.max(...EDGES.map((e) => out[e]));
  return out;
}
