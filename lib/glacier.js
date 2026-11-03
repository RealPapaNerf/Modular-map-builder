// glacier.js — ice flowing over rock, and the rock it takes with it.
//
// WHY THIS IS SIMULATED WHEN THE ALCOVE IS NOT. relief's overhangs brief
// argues that simulation is unnecessary at print scale, and for a sandstone
// cliff that is right: the shape comes from a seepage band and a beam limit,
// both of which are closed-form. It does not transfer here. A glacial valley's
// shape IS the signature of the process -- the U section, the overdeepened
// floor, the cirque biting back into the divide, the tributary left hanging
// because it carried less ice, the arête where two cirques met. None of those
// is a function of a footprint you could draw. They emerge, or they are
// absent, and noise cannot stand in for them.
//
// THE PHYSICS, AND WHERE IT IS CUT SHORT.
//
// Ice is treated as a shallow, isothermal, Glen-law fluid: the standard
// shallow-ice approximation, which is the right level of theory for valley
// glaciers on a grid this coarse. Flux is written as a diffusion of the ice
// SURFACE, which is what makes it stable and what makes ice run downhill on
// the surface slope rather than on the bed slope -- the reason a glacier
// overdeepens its bed and leaves a basin behind, where a river never can.
//
//     q = -D grad(s),   s = b + H
//     D = (2A/(n+2)) (rho g)^n H^(n+2) |grad s|^(n-1)   [internal deformation]
//       +  C_s (rho g)^2 H^3 |grad s|                   [basal sliding]
//     dH/dt = mdot + div(D grad s)
//
// Mass balance is a simple ELA model: accumulation above the equilibrium line,
// melt below, both capped. Crude, and it is the single biggest lever on what
// the map comes out looking like, which is why it is exposed rather than
// buried.
//
// Erosion follows the sliding, not the ice: cold-based ice frozen to its bed
// erodes nothing, which is why plateaux survive between glaciated troughs.
//
//     edot = K * u_b^l     (Hallet; l = 1 operationally, 2 is also defended)
//
// WHAT IS LEFT OUT, deliberately: thermomechanics, so every glacier here is
// temperate and sliding; isostasy, invisible at this scale; sediment transport
// and deposition, so there are no moraines -- the troughs come out cleaner
// than real ones, and the fluvial pass afterwards puts some mess back.
//
// THE TIME AXIS IS COMPRESSED and that is not a cheat to be quiet about. Ice
// reaches a steady state in centuries; the landform takes 10^4-10^5 years.
// Coupling them at the ice timestep would mean millions of steps. So the loop
// relaxes the ice to near steady state, then erodes for a long geomorphic
// step with that frozen velocity field, then re-relaxes. Standard practice in
// landscape evolution models, and the error it makes is in the rate, not the
// shape.

import { cloneField, makeField } from './field.js';
import { massWaste } from './hillslope.js';

const RHO = 917; // kg/m^3
const GRAV = 9.81;
const GLEN_N = 3;

export const GLACIER_DEFAULTS = {
  elaM: null, // equilibrium line; null picks 72% of the way up the relief
  // Accumulation and ablation have DIFFERENT gradients, and collapsing them
  // into one number is what made the first version build an ice cap on every
  // terrain it was given. Melt responds to temperature far more steeply than
  // snowfall responds to height, so the ablation gradient is two to three
  // times the accumulation one. That asymmetry is the whole stabiliser: ice
  // thickens, its surface rises above the ELA, more of it accumulates -- the
  // height/mass-balance feedback -- and the only thing that stops the
  // runaway is a terminus descending into ablation strong enough to pay for
  // it. Give melt the same weak gradient as snowfall and nothing ever pays.
  accumGradient: 0.0040, // m ice/yr per m above the ELA
  ablateGradient: 0.0110, // m ice/yr per m below it
  maxAccumM: 1.3, // m/yr; alpine snowfall does not grow without limit
  maxAblateM: 14.0, // m/yr
  flowA: 1.0e-16, // Glen's A, Pa^-3 yr^-1, temperate ice
  // Sliding: u_b = slideC * tau^2, tau in Pa, u_b in m/yr. Calibrated so a
  // valley glacier under ~1 bar of basal shear slides at tens of metres a
  // year, which is what a temperate one does.
  slideC: 5.0e-9,
  // Basal shear yields. Ice is not elastic: above roughly a bar it deforms
  // plastically and the stress will not climb further, which is why real
  // glaciers sit near 0.5-1.5 bar almost regardless of how deep they are.
  // Without this cap a 1200 m trough glacier reached 5.4 bar and slid at
  // 1460 m/yr -- a surge, permanently, everywhere -- and the erosion
  // saturated its limiter on the first cycle and merely lowered the block.
  maxTauPa: 1.8e5,
  // Calibrated to real rates: ~2 mm/yr under a fast temperate glacier, which
  // is what puts 100-300 m of trough into 100,000 years. Glacial landscapes
  // genuinely take that long, and erodeYears x cycles is set to spend it.
  erosionK: 1.2e-5, // abrasion per (m/yr) of sliding
  erosionL: 1.0, // exponent on sliding speed; Hallet argues 2, 1 is steadier
  cycles: 40, // outer geomorphic steps; cycles x erodeYears is the time spent
  relaxSteps: 200, // ceiling on ice steps per cycle; it stops early when settled
  firstRelaxSteps: 1500, // ceiling for the cold start
  erodeYears: 2500, // geomorphic years applied per cycle
  // STEPPING. ADI is unconditionally stable only for the LINEAR problem. D
  // here goes as H^5, and a fixed step diverges: the first version of this
  // reached an ice thickness of 1e303, and the second grew 2500 m of ice in
  // 76 model years on a climate that can deliver 1.3 m a year. Measured
  // against the explicit limit dx^2/(4 Dmax), ADI tolerated about 360x on
  // this problem, so the step is taken from that limit each iteration rather
  // than fixed -- it is large while the ice is thin and tightens itself as
  // the ice thickens, which is exactly when it needs to.
  adiFactor: 150, // how far past the explicit limit to push; 360 was the edge
  maxDtYears: 25, // ceiling, so a bare bed does not take one enormous step
  minDtYears: 0.02,
  picard: 1, // nonlinear iterations per step; the step control does the work
  maxChangeM: 6, // most ice any one point may gain or lose in a single step
  // The diffusivity limiter. This is a real distortion and worth naming: ice
  // that would spread faster than this spreads at this rate instead, so a
  // surging outlet comes out thicker and slower than it should. The landform
  // is set by where ice sits and how hard it slides, both of which survive
  // it, and the alternative is an order of magnitude more steps.
  maxDiffusivity: 3.0e5, // m^2/yr
  settleRate: 0.004, // m/yr of mean thickening below which the ice is called settled
  maxIceM: 3000, // a divergence guard, not a physical statement
  maxIncisionM: 600, // total depth any one point may be cut, a guard rail
  // The wall above the ice. See hillslope.js: abrasion alone deepens a valley
  // and never widens it, so without this the output is a sharper V.
  wallCritDeg: 55,
  wallPasses: 4,
};

/**
 * Thomas algorithm: solve a tridiagonal system in place. Written out rather
 * than pulled in because it is fifteen lines and this repo has no
 * dependencies.
 */
function thomas(lower, diag, upper, rhs, out, n, cp, dp) {
  cp[0] = upper[0] / diag[0];
  dp[0] = rhs[0] / diag[0];
  for (let i = 1; i < n; i++) {
    const m = diag[i] - lower[i] * cp[i - 1];
    cp[i] = upper[i] / m;
    dp[i] = (rhs[i] - lower[i] * dp[i - 1]) / m;
  }
  out[n - 1] = dp[n - 1];
  for (let i = n - 2; i >= 0; i--) out[i] = dp[i] - cp[i] * out[i + 1];
}

/**
 * Carve a bed with ice. Returns the eroded bed plus the diagnostic fields,
 * which are worth keeping: `ice` says where the glaciers actually were, and
 * that is what decides where to paint snow and where a tarn goes.
 */
export function glaciate(bed, opts = {}) {
  const o = { ...GLACIER_DEFAULTS, ...opts };
  const nx = bed.nx;
  const ny = bed.ny;
  const dx = bed.step;
  const N = nx * ny;

  const b = Float64Array.from(bed.values);
  const b0 = Float64Array.from(bed.values);
  const H = new Float64Array(N);
  const s = new Float64Array(N);
  const slide = new Float64Array(N);
  const maxIce = new Float64Array(N);

  let lo = Infinity;
  let hi = -Infinity;
  for (const v of b) { if (v < lo) lo = v; if (v > hi) hi = v; }
  const ela = Number.isFinite(o.elaM) ? o.elaM : lo + 0.72 * (hi - lo);

  // Face diffusivities, lagged one step: Dx[k] sits between k and k+1 in x,
  // Dy[k] between k and k+nx in y.
  const Dx = new Float64Array(N);
  const Dy = new Float64Array(N);
  const mdot = new Float64Array(N);
  const expl = new Float64Array(N);
  const tmp = new Float64Array(N);

  const L = Math.max(nx, ny);
  const lower = new Float64Array(L);
  const diag = new Float64Array(L);
  const upper = new Float64Array(L);
  const rhs = new Float64Array(L);
  const sol = new Float64Array(L);
  const cp = new Float64Array(L);
  const dp = new Float64Array(L);

  const defCoef = ((2 * o.flowA) / (GLEN_N + 2)) * Math.pow(RHO * GRAV, GLEN_N);
  const slideCoef = o.slideC * Math.pow(RHO * GRAV, 2);

  const at = (arr, i, j) => arr[Math.min(ny - 1, Math.max(0, j)) * nx + Math.min(nx - 1, Math.max(0, i))];
  const edge = (i, j) => i === 0 || j === 0 || i === nx - 1 || j === ny - 1;

  /**
   * Recompute face diffusivities from the current ice and surface.
   *
   * Written out rather than with Math.pow because this is the hot loop and
   * the exponents are known: Glen's n = 3 makes the deformation term H^5
   * times |grad s|^2, and the SQUARED gradient is what the formula wants, so
   * no square root is needed for that half at all.
   */
  const Dcap = o.maxDiffusivity;
  function diffusivities() {
    let Dmax = 1e-9;
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx - 1; i++) {
        const k = j * nx + i;
        const Hf = 0.5 * (H[k] + H[k + 1]);
        if (Hf <= 0) { Dx[k] = 0; continue; }
        const dsdx = (s[k + 1] - s[k]) / dx;
        const dsdy = (at(s, i, j + 1) + at(s, i + 1, j + 1) - at(s, i, j - 1) - at(s, i + 1, j - 1)) / (4 * dx);
        const g2 = dsdx * dsdx + dsdy * dsdy;
        const H2 = Hf * Hf;
        const H3 = H2 * Hf;
        let D = defCoef * H2 * H3 * g2 + slideCoef * H3 * Math.sqrt(g2);
        if (D > Dcap) D = Dcap;
        if (D > Dmax) Dmax = D;
        Dx[k] = D;
      }
      Dx[j * nx + nx - 1] = 0;
    }
    for (let j = 0; j < ny - 1; j++) {
      for (let i = 0; i < nx; i++) {
        const k = j * nx + i;
        const Hf = 0.5 * (H[k] + H[k + nx]);
        if (Hf <= 0) { Dy[k] = 0; continue; }
        const dsdy = (s[k + nx] - s[k]) / dx;
        const dsdx = (at(s, i + 1, j) + at(s, i + 1, j + 1) - at(s, i - 1, j) - at(s, i - 1, j + 1)) / (4 * dx);
        const g2 = dsdx * dsdx + dsdy * dsdy;
        const H2 = Hf * Hf;
        const H3 = H2 * Hf;
        let D = defCoef * H2 * H3 * g2 + slideCoef * H3 * Math.sqrt(g2);
        if (D > Dcap) D = Dcap;
        if (D > Dmax) Dmax = D;
        Dy[k] = D;
      }
    }
    for (let i = 0; i < nx; i++) Dy[(ny - 1) * nx + i] = 0;
    return Dmax;
  }

  /**
   * One ADI step. Explicit diffusion here is hopeless: D runs to millions of
   * m^2/yr under a fast trough, and dx^2/(4D) is then under a thousandth of a
   * year, so steady state would want a million steps. Alternating direction
   * implicit is unconditionally stable, costs two tridiagonal sweeps, and
   * lets the step be three years.
   */
  const Hn = new Float64Array(N);
  const tend = new Float64Array(N);

  /**
   * The explicit tendency dH/dt with the ice as it stands, which is what sets
   * the step.
   *
   * Stability of the diffusion is NOT the only limit, and assuming it was is
   * what made the third version of this grow 169 m of ice in a 25-year step
   * on a climate capped at 1.3 m a year. The surface is split into an
   * implicit H and an explicit b, and at a valley axis the bed term
   * div(D grad b) is enormous -- ice converging into the trough. That is real,
   * but it can only deliver ice that exists, and with a large step it
   * delivers ice that does not. So the step is also held to a maximum change
   * in thickness, which costs one extra pass and cannot be fooled by a kink
   * in the bed.
   */
  function tendency() {
    let worst = 1e-9;
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const k = j * nx + i;
        if (edge(i, j)) { tend[k] = 0; continue; }
        const De = Dx[k];
        const Dw = Dx[k - 1];
        const Dn = Dy[k];
        const Ds = Dy[k - nx];
        const div =
          (De * (s[k + 1] - s[k]) - Dw * (s[k] - s[k - 1]) +
           Dn * (s[k + nx] - s[k]) - Ds * (s[k] - s[k - nx])) / (dx * dx);
        const t = mdot[k] + div;
        tend[k] = t;
        const a = t < 0 ? -t : t;
        if (a > worst) worst = a;
      }
    }
    return worst;
  }

  /** One step, with the step size taken from the ice as it currently stands. */
  function adiStep() {
    Hn.set(H);
    for (let k = 0; k < N; k++) s[k] = b[k] + H[k];
    const Dmax = diffusivities();
    for (let k = 0; k < N; k++) {
      const dz = s[k] - ela;
      mdot[k] = dz >= 0
        ? Math.min(o.maxAccumM, o.accumGradient * dz)
        : Math.max(-o.maxAblateM, o.ablateGradient * dz);
    }
    const worst = tendency();
    const dt = Math.max(
      o.minDtYears,
      Math.min(
        o.maxDtYears,
        (o.adiFactor * dx * dx) / (4 * Dmax), // diffusive stability
        o.maxChangeM / worst,                 // and no more than this much ice
      ),
    );
    adiSweep(dt, Hn, true);
    for (let p = 1; p < o.picard; p++) {
      for (let k = 0; k < N; k++) s[k] = b[k] + H[k];
      diffusivities();
      adiSweep(dt, Hn, true);
    }
    // Settling is judged on the MEAN rate of thickening, not the worst cell.
    // A glacier's terminus advances and retreats by a cell from one step to
    // the next for as long as you care to run it, so a max-based test never
    // reports settled and the relaxation runs to its ceiling every time.
    let moved = 0;
    let sum = 0;
    for (let k = 0; k < N; k++) {
      const d = Math.abs(H[k] - Hn[k]);
      sum += d;
      if (d > moved) moved = d;
    }
    return { dt, moved, Dmax, rate: sum / N / dt };
  }

  function adiSweep(dt, Hstart, reuseD) {
    const h = dt / 2;
    const r = h / (dx * dx);
    if (!reuseD) { H.set(Hstart); for (let k = 0; k < N; k++) s[k] = b[k] + H[k]; diffusivities(); }
    else H.set(Hstart);
    for (let k = 0; k < N; k++) s[k] = b[k] + H[k];

    // --- half step 1: implicit in x, explicit in y ---
    for (let k = 0; k < N; k++) {
      const i = k % nx;
      const j = (k - i) / nx;
      const Dn = Dy[k];
      const Ds = j > 0 ? Dy[k - nx] : 0;
      expl[k] = (Dn * (at(s, i, j + 1) - s[k]) - Ds * (s[k] - at(s, i, j - 1))) / (dx * dx);
    }
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const k = j * nx + i;
        if (edge(i, j)) { lower[i] = 0; diag[i] = 1; upper[i] = 0; rhs[i] = 0; continue; }
        const De = Dx[k];
        const Dw = Dx[k - 1];
        lower[i] = -r * Dw;
        diag[i] = 1 + r * (Dw + De);
        upper[i] = -r * De;
        // The bed part of the implicit operator is known, so it moves right.
        const Lb = (De * (b[k + 1] - b[k]) - Dw * (b[k] - b[k - 1])) / (dx * dx);
        rhs[i] = H[k] + h * (mdot[k] + Lb + expl[k]);
      }
      thomas(lower, diag, upper, rhs, sol, nx, cp, dp);
      for (let i = 0; i < nx; i++) tmp[j * nx + i] = sol[i] > 0 ? (sol[i] < o.maxIceM ? sol[i] : o.maxIceM) : 0;
    }
    H.set(tmp);

    // --- half step 2: implicit in y, explicit in x ---
    for (let k = 0; k < N; k++) s[k] = b[k] + H[k];
    for (let k = 0; k < N; k++) {
      const i = k % nx;
      const j = (k - i) / nx;
      const De = Dx[k];
      const Dw = i > 0 ? Dx[k - 1] : 0;
      expl[k] = (De * (at(s, i + 1, j) - s[k]) - Dw * (s[k] - at(s, i - 1, j))) / (dx * dx);
    }
    for (let i = 0; i < nx; i++) {
      for (let j = 0; j < ny; j++) {
        const k = j * nx + i;
        if (edge(i, j)) { lower[j] = 0; diag[j] = 1; upper[j] = 0; rhs[j] = 0; continue; }
        const Dn = Dy[k];
        const Ds = Dy[k - nx];
        lower[j] = -r * Ds;
        diag[j] = 1 + r * (Ds + Dn);
        upper[j] = -r * Dn;
        const Lb = (Dn * (b[k + nx] - b[k]) - Ds * (b[k] - b[k - nx])) / (dx * dx);
        rhs[j] = H[k] + h * (mdot[k] + Lb + expl[k]);
      }
      thomas(lower, diag, upper, rhs, sol, ny, cp, dp);
      for (let j = 0; j < ny; j++) tmp[j * nx + i] = sol[j] > 0 ? (sol[j] < o.maxIceM ? sol[j] : o.maxIceM) : 0;
    }
    H.set(tmp);
  }

  let years = 0;
  for (let cycle = 0; cycle < o.cycles; cycle++) {
    // Relax until the ice stops moving, not for a fixed count: a cold start
    // needs hundreds of steps and a re-equilibration after one geomorphic
    // step usually needs a handful.
    const steps = cycle === 0 ? o.firstRelaxSteps : o.relaxSteps;
    for (let step = 0; step < steps; step++) {
      const { dt, moved, Dmax, rate } = adiStep();
      years += dt;
      if (o.onStep) {
        let hm = 0;
        for (let k = 0; k < N; k++) if (H[k] > hm) hm = H[k];
        o.onStep({ cycle, step, dt, years, moved, rate, Dmax, maxH: hm });
      }
      if (rate < o.settleRate) break;
    }

    // ---- sliding speed on the relaxed ice ----
    for (let k = 0; k < N; k++) s[k] = b[k] + H[k];
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const k = j * nx + i;
        if (H[k] <= 0.5) { slide[k] = 0; continue; }
        const dsdx = (at(s, i + 1, j) - at(s, i - 1, j)) / (2 * dx);
        const dsdy = (at(s, i, j + 1) - at(s, i, j - 1)) / (2 * dx);
        const g = Math.hypot(dsdx, dsdy);
        let tau = RHO * GRAV * H[k] * g; // basal shear stress, Pa
        if (tau > o.maxTauPa) tau = o.maxTauPa; // plastic yield, see maxTauPa
        slide[k] = o.slideC * tau * tau; // m/yr
        if (H[k] > maxIce[k]) maxIce[k] = H[k];
      }
    }

    // ---- erode for a geomorphic step with that velocity field ----
    for (let k = 0; k < N; k++) {
      if (slide[k] <= 0) continue;
      const rate = o.erosionK * Math.pow(slide[k], o.erosionL);
      let cut = rate * o.erodeYears;
      const already = b0[k] - b[k];
      if (already + cut > o.maxIncisionM) cut = Math.max(0, o.maxIncisionM - already);
      b[k] -= cut;
    }

    // ---- and let the undercut walls come down ----
    if (o.wallPasses > 0) {
      massWaste({ nx, ny, step: dx, originX: bed.originX, originY: bed.originY, values: b },
        { critDeg: o.wallCritDeg, passes: o.wallPasses });
    }
  }

  const out = makeField(nx, ny, dx, bed.originX, bed.originY, b);
  const ice = makeField(nx, ny, dx, bed.originX, bed.originY, maxIce);
  let cutMax = 0;
  let cutSum = 0;
  for (let k = 0; k < N; k++) { const d = b0[k] - b[k]; cutSum += d; if (d > cutMax) cutMax = d; }
  let iced = 0;
  let clamped = 0;
  let slideMax = 0;
  for (let k = 0; k < N; k++) if (slide[k] > slideMax) slideMax = slide[k];
  for (let k = 0; k < N; k++) {
    if (maxIce[k] > 1) iced++;
    if (maxIce[k] >= o.maxIceM - 1e-6) clamped++;
  }

  return {
    bed: out,
    ice,
    stats: {
      elaM: ela,
      years: Math.round(years),
      maxIncisionM: cutMax,
      meanIncisionM: cutSum / N,
      glaciatedFraction: iced / N,
      maxIceM: maxIce.reduce((a, v) => (v > a ? v : a), 0),
      // Not a detail to bury. Ice against the ceiling means the climate and
      // the terrain given to this run build an ice CAP, not valley glaciers,
      // and the result will be a uniformly lowered block rather than a
      // carved one. Raise elaM, or give the map some low ground to melt on.
      clampedFraction: clamped / N,
      runaway: clamped / N > 0.02,
      maxSlideMPerYear: slideMax,
    },
  };
}

/**
 * How U-shaped a cross-section is.
 *
 * A V-section widens in proportion to height above the floor; a U-section
 * widens as roughly the square root of it, so it is already wide low down.
 * Comparing the width at a tenth of the depth with the width at half of it
 * separates the two without having to fit anything: a V gives about 0.2, a
 * glacial trough considerably more. Used by the tests, and worth having to
 * hand when tuning erosionK.
 */
export function valleyForm(field, j, { loFrac = 0.1, hiFrac = 0.5 } = {}) {
  const row = [];
  for (let i = 0; i < field.nx; i++) row.push(field.values[j * field.nx + i]);
  const floor = Math.min(...row);
  const rim = Math.max(...row);
  const depth = rim - floor;
  if (!(depth > 0)) return { ratio: NaN, depth: 0 };
  const widthAt = (frac) => {
    const z = floor + frac * depth;
    let n = 0;
    for (const v of row) if (v <= z) n++;
    return n * field.step;
  };
  const wLo = widthAt(loFrac);
  const wHi = widthAt(hiFrac);
  return { ratio: wHi > 0 ? wLo / wHi : NaN, depth, floor, rim, wLo, wHi };
}
