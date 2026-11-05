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
// SEDIMENT IS CARRIED AND PUT BACK DOWN. This file used to say it was not,
// and that was the single biggest thing wrong with the landscapes it made.
// A glacier is not only a chisel; it is a conveyor. What it quarries it
// carries, and where it can no longer carry it, it drops it -- in a ridge
// across the valley at the snout (a terminal moraine), along the flanks
// where the ice edge runs with the flow (lateral moraines), and in a
// staircase of them down-valley as the snout pulls back (recessional).
// That matters far beyond tidiness: MOST REAL ALPINE LAKES ARE MORAINE-
// DAMMED, not rock-basin. Without deposition the model could only make the
// rarer kind, and valleys came out swept clean in a way no real one is.
// See the till block in GLACIER_DEFAULTS for the model and its limits.
//
// WHAT IS LEFT OUT, deliberately: thermomechanics, so every glacier here is
// temperate and sliding; isostasy, invisible at this scale; and a deformable
// bed -- till thickness does not feed back into how fast the ice slides.
// That last one is real and the omission is deliberate: it is a rabbit hole,
// and it changes rates more than it changes shapes.
//
// THE TIME AXIS IS COMPRESSED and that is not a cheat to be quiet about. Ice
// reaches a steady state in centuries; the landform takes 10^4-10^5 years.
// Coupling them at the ice timestep would mean millions of steps. So the loop
// relaxes the ice to near steady state, then erodes for a long geomorphic
// step with that frozen velocity field, then re-relaxes. Standard practice in
// landscape evolution models, and the error it makes is in the rate, not the
// shape.

import { cloneField, makeField, blur } from './field.js';
import { massWaste, diffuse } from './hillslope.js';
import { depressionStats } from './basins.js';

const RHO = 917; // kg/m^3
const GRAV = 9.81;
const GLEN_N = 3;

export const GLACIER_DEFAULTS = {
  elaM: null, // MEAN equilibrium line; null picks 72% of the way up the relief
  // CUT, RETREAT, CUT AGAIN. One glaciation at one climate carves one trough
  // and nothing else. Real glacial landscape is the work of a dozen advances
  // and retreats with the snowline moving hundreds of metres between them,
  // and the landforms that make it recognisable are the ones only an
  // OSCILLATING climate can produce:
  //
  //   cirques       bite in at the snowline. A snowline that moves leaves a
  //                 staircase of them at different heights, instead of one.
  //   hanging       a tributary carries less ice than the trunk, so it cuts
  //   valleys       less deep. Every advance widens the gap, and the
  //                 tributary is left hanging above the main floor.
  //   waterfalls    are what a hanging valley is, once the ice has gone.
  //   tarns         sit in the overdeepened cirque floors afterwards.
  //
  // So the ELA swings as a cosine: warm at the start, coldest half way
  // through each cycle, warm again at the end -- which leaves the map
  // deglaciated, the state you would print.
  elaSwingM: 450, // how far the snowline moves either side of the mean
  glacialCycles: 3, // how many advances over the whole run
  elaSchedule: null, // or give the ELA for each geomorphic cycle outright
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
  erosionK: 0.9e-5, // abrasion per (m/yr) of sliding
  erosionL: 1.0, // exponent on sliding speed; Hallet argues 2, 1 is steadier
  // QUARRYING, which is the other half of glacial erosion and the half that
  // makes a cirque. Abrasion is ice dragging grit over rock and scales with
  // speed alone, so it polishes the whole bed fairly evenly and deepens a
  // valley without ever steepening anything. Quarrying is blocks being
  // levered out, and it concentrates where the bed is already STEEP -- the
  // lee of a bedrock step, the back wall of a hollow. That is the term that
  // makes a headwall retreat into a cirque instead of being smoothed off.
  // Keyed to a SMOOTHED bed, which is not a detail. Quarrying responds to
  // bedrock steps metres to tens of metres across; read off the raw grid it
  // responds to single-cell noise instead, and that is a positive feedback
  // -- a cell slightly below its neighbours has a steeper local gradient, so
  // it quarries harder, so it drops further. The first run of this turned a
  // valley into 175 pits and called them basins.
  quarryK: 3.0e-5, // per (m/yr) of sliding, per unit of bed slope
  quarrySmoothCells: 2, // radius the bed is smoothed over before its slope is taken
  // THE GLACIAL BUZZSAW, and why it is here rather than emerging.
  //
  // Erosion scaling with sliding alone cannot make a cirque, and this is a
  // limitation of the shallow-ice approximation rather than a bug. Sliding
  // goes as the square of basal shear, which goes as ice thickness, so the
  // HEAD of a glacier -- where the ice is thin -- erodes least. Real cirques
  // are excavated at exactly that spot, by rotational flow in a closed cell
  // that the SIA has no way to represent: it only knows flux down the
  // surface slope.
  //
  // So the observation goes in directly. Glacial erosion is concentrated in
  // a band around the equilibrium line -- the "glacial buzzsaw" -- which is
  // why cirque floors across a range cluster at one elevation, and why a
  // snowline that MOVES leaves a staircase of them. Erosion is multiplied by
  // a bump centred on the ELA. Set buzzsawGain to 0 for sliding alone.
  buzzsawGain: 2.8,
  buzzsawBandM: 220,
  // Outer geomorphic steps. With an oscillating snowline this has to be
  // generous: each advance only erodes while it is cold, so three cycles
  // over 36 steps does LESS work than one steady climate over 36 and comes
  // out softer. Sixty gives each advance about twenty steps, which is where
  // the troughs start showing rounded heads instead of a uniform comb.
  cycles: 60,
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
  // Creep and infill. This is what decides which hollows count as cirques
  // and which are grid noise -- see hillslope.js diffuse().
  hillslopeD: 0.14, // m^2/yr
  // THE ICE GOES AT THE END. The cosine schedule ends warm, but warm is not
  // gone: the last advance's remnants were still sitting in the cirques
  // when the run stopped, and a bed is not a landscape until the ice has
  // left it. So after the last cycle the snowline is lifted clear of the
  // summits and the ice is relaxed until there is none, and whatever till
  // it was still carrying grounds where it is (ablation till). What comes
  // out is the terrain the glacier carved, with no glacier on it.
  meltOut: true,
  meltSteps: 4000, // ceiling on ice steps for the melt; it stops when the ice is gone
  meltMaxChangeM: 40, // thinning ice is not a stability problem, so it may go faster

  // ---- TILL: what the ice carries, and where it puts it down ----
  //
  // Three operations per geomorphic cycle, in the same loop as the erosion.
  //
  // ENTRAINMENT. The rock the erosion block cuts does not vanish any more.
  // A fraction of it becomes transportable till; the rest leaves the system
  // as rock flour, which is a real and large export -- it is what makes
  // glacial meltwater milky, and it ends up far downstream rather than in
  // any landform on this map.
  tillYield: 0.55,
  // TRANSPORT. Till moves with the ICE, not with gravity -- that is the
  // whole point and the reason a moraine can sit on a ridge above a valley
  // floor. It is advected upwind along the depth-averaged velocity the flux
  // already implies, u = -D grad(s) / H, with the same CFL sub-stepping the
  // ice solve uses.
  //
  // DEPOSITION. One rule covers the terminal and lateral moraines both,
  // which is less code and better physics than two cases: carrying capacity
  // scales with sliding speed, so till drops wherever the ice slows or
  // thins. At the snout the ice stops, capacity goes to zero, and
  // everything arriving is dropped -- a ridge across the valley. Along the
  // margins the ice is thin and slow, so it sheds its load on the flanks.
  tillCapacityK: 0.020, // m of till carried per (m/yr) of sliding
  tillCapacityMinM: 0.6, // capacity floor under fast ice, so a trunk stays swept
  // Guard rail, in the spirit of maxIncisionM: the most the ice may build
  // any one point up above the bed it started from. A trunk valley on a
  // 15 km map settles around 180 m of its own accord, so this is a rail and
  // not a tuning knob -- if a map is pinned against it, the climate is
  // depositing far more than it should and that is worth knowing.
  maxTillM: 220,
  // Loose till stands at a lower angle than rock, and a moraine that does
  // not slump is a knife edge no real one has. Wasted on its own repose
  // angle rather than the rock's.
  tillCritDeg: 33,
  tillPasses: 2,
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
 * Carve a bed with ice. Returns the eroded bed plus the diagnostic fields:
 * `ice` is the most ice each point ever carried, which says where the
 * glaciers WERE; `finalIce` is what is left when the run ends, which with
 * meltOut on is zero everywhere. The bed is the landscape; the ice is not
 * part of it.
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
  const bsm = new Float64Array(N);
  // Glacial cutting only, kept apart from total bed change: creep lowers a
  // ridge too, and lumping the two together means a run with no ice at all
  // still reports incision.
  const cutField = new Float64Array(N);
  // Till in transit, in metres of loose sediment riding on the ice, and the
  // running total of what has been put down. Deposited till is added into
  // `b`, so a later advance can pick a moraine up again and re-work it --
  // which is how a big readvance overrides a recessional sequence.
  const till = new Float64Array(N);
  // NOTE ON THE GUARD RAIL. An earlier attempt kept a separate "till
  // standing on the bed" field and capped that. It does not survive contact
  // with mass wasting: massWaste moves `b` and knows nothing about the
  // bookkeeping field, so after the first slump the two disagree and the
  // cap is being applied to a number that no longer describes the ground.
  // The rail is therefore applied to the one quantity that is always true
  // and always measurable -- how much higher this point is than the bed the
  // run started from. Erosion alone can never make that positive, so it is
  // exactly "how big is the landform the ice BUILT here".
  const tillTmp = new Float64Array(N);
  const uxF = new Float64Array(N);
  const uyF = new Float64Array(N);
  const FxB = new Float64Array(N);
  const FyB = new Float64Array(N);
  let tillExported = 0; // rock flour that left as suspended load
  let tillDropped = 0;
  let tillOutwash = 0; // till the melt could not put down, carried off by the meltwater

  let lo = Infinity;
  let hi = -Infinity;
  for (const v of b) { if (v < lo) lo = v; if (v > hi) hi = v; }
  const elaMean = Number.isFinite(o.elaM) ? o.elaM : lo + 0.72 * (hi - lo);
  // The snowline for geomorphic cycle k. Warm at k = 0, coldest at the
  // middle of each advance, warm again at the end.
  const elaAt = (k) => {
    if (Array.isArray(o.elaSchedule) && o.elaSchedule.length) {
      return o.elaSchedule[Math.min(o.elaSchedule.length - 1, k)];
    }
    if (!(o.elaSwingM > 0) || !(o.glacialCycles > 0)) return elaMean;
    const phase = (2 * Math.PI * o.glacialCycles * k) / Math.max(1, o.cycles);
    return elaMean + o.elaSwingM * Math.cos(phase);
  };
  let ela = elaAt(0);

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

  let melting = false;
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
        (melting ? o.meltMaxChangeM : o.maxChangeM) / worst, // and no more than this much ice
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

  /**
   * Carry the till with the ice for one geomorphic step, then drop whatever
   * the ice can no longer hold. Returns the metres of till deposited.
   *
   * VELOCITY. The ice solve already writes its flux as q = -D grad(s), and
   * q = u H by definition, so the depth-averaged velocity is u = -D grad(s)/H
   * and costs nothing extra -- D and s are both in scope and current. Taken
   * on the faces, where D already lives.
   *
   * UPWIND, not centred. A centred difference on a till field with a sharp
   * front oscillates, and the overshoot goes NEGATIVE -- which here would be
   * sediment the glacier never had. Upwind is first-order and smears the
   * front a little; that is the right trade for a quantity that must not go
   * below zero.
   */
  function moveAndDropTill() {
    for (let k = 0; k < N; k++) s[k] = b[k] + H[k];

    let umax = 1e-9;
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx - 1; i++) {
        const k = j * nx + i;
        const Hf = 0.5 * (H[k] + H[k + 1]);
        uxF[k] = Hf > 1 ? (-Dx[k] * (s[k + 1] - s[k])) / dx / Hf : 0;
        const a = uxF[k] < 0 ? -uxF[k] : uxF[k];
        if (a > umax) umax = a;
      }
    }
    for (let j = 0; j < ny - 1; j++) {
      for (let i = 0; i < nx; i++) {
        const k = j * nx + i;
        const Hf = 0.5 * (H[k] + H[k + nx]);
        uyF[k] = Hf > 1 ? (-Dy[k] * (s[k + nx] - s[k])) / dx / Hf : 0;
        const a = uyF[k] < 0 ? -uyF[k] : uyF[k];
        if (a > umax) umax = a;
      }
    }

    // CFL. The ice solve is implicit and may take a long step; this one is
    // explicit, so it takes its own.
    const dtMax = Math.max(1e-6, (0.4 * dx) / umax);
    let remaining = o.erodeYears;
    let guard = 0;
    while (remaining > 1e-9 && guard++ < 20000) {
      const dt = remaining < dtMax ? remaining : dtMax;
      remaining -= dt;
      tillTmp.set(till);
      // CONSERVATIVE BY CONSTRUCTION. The flux across each face is computed
      // ONCE and then subtracted from the cell on one side and added to the
      // cell on the other, so the interior sum telescopes to zero exactly --
      // whatever one cell loses, its neighbour gains, to the last bit.
      //
      // The first version of this updated only interior cells, which quietly
      // destroyed every grain that crossed into the boundary ring: the cell
      // it left was debited and the cell it entered was never credited. The
      // mass-conservation test is what caught it, which is the reason that
      // test was written first.
      //
      // The outer faces of the domain carry no flux, so the ice cannot post
      // sediment off the edge of the map. Ice is already pinned to zero
      // thickness at the boundary, so nothing is sliding there to carry it
      // anyway, and anything that reaches the edge grounds and is deposited.
      for (let j = 0; j < ny; j++) {
        for (let i = 0; i < nx - 1; i++) {
          const k = j * nx + i;
          const u = uxF[k];
          FxB[k] = u >= 0 ? u * tillTmp[k] : u * tillTmp[k + 1];
        }
      }
      for (let j = 0; j < ny - 1; j++) {
        for (let i = 0; i < nx; i++) {
          const k = j * nx + i;
          const u = uyF[k];
          FyB[k] = u >= 0 ? u * tillTmp[k] : u * tillTmp[k + nx];
        }
      }
      for (let j = 0; j < ny; j++) {
        for (let i = 0; i < nx; i++) {
          const k = j * nx + i;
          const Fe = i < nx - 1 ? FxB[k] : 0;
          const Fw = i > 0 ? FxB[k - 1] : 0;
          const Fn = j < ny - 1 ? FyB[k] : 0;
          const Fs = j > 0 ? FyB[k - nx] : 0;
          const v = tillTmp[k] - (dt * (Fe - Fw + Fn - Fs)) / dx;
          till[k] = v > 0 ? v : 0;
        }
      }
    }

    // DEPOSITION. Capacity scales with how fast the bed is sliding, so this
    // one rule is both moraines at once: at the snout the ice stops, the
    // capacity goes to zero and the whole load is dropped as a ridge across
    // the valley; along the margins the ice is thin and slow, so it sheds on
    // the flanks. Where there is no ice at all, everything grounds.
    let dropped = 0;
    for (let k = 0; k < N; k++) {
      if (till[k] <= 0) continue;
      const cap = H[k] > 1 ? Math.max(o.tillCapacityMinM, o.tillCapacityK * slide[k]) : 0;
      let drop = till[k] - cap;
      if (drop <= 0) continue;
      // How much this point has already been built up above the bed the run
      // started from. See the note where the fields are allocated.
      const built = b[k] - b0[k];
      if (built + drop > o.maxTillM) drop = Math.max(0, o.maxTillM - built);
      if (drop <= 0) continue;
      till[k] -= drop;
      b[k] += drop;
      dropped += drop;
    }
    return dropped;
  }

  let years = 0;
  const history = [];
  for (let cycle = 0; cycle < o.cycles; cycle++) {
    ela = elaAt(cycle);
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
    // A smoothed copy of the bed, for the quarrying slope only. See quarryK.
    bsm.set(b);
    if (o.quarrySmoothCells > 0) {
      blur({ nx, ny, step: dx, originX: 0, originY: 0, values: bsm }, o.quarrySmoothCells, 1);
    }
    let iceNow = 0;
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const k = j * nx + i;
        if (H[k] > 1) iceNow++;
        if (slide[k] <= 0) continue;
        const abrade = o.erosionK * Math.pow(slide[k], o.erosionL);
        // Bed slope, which is what quarrying keys on: steep bed, more
        // plucking. Measured on the BED, not the ice surface -- a smooth
        // ice surface can run over a very rough bed, and it is the rough
        // bed that gets quarried.
        const dbdx = (at(bsm, i + 1, j) - at(bsm, i - 1, j)) / (2 * dx);
        const dbdy = (at(bsm, i, j + 1) - at(bsm, i, j - 1)) / (2 * dx);
        const quarry = o.quarryK * slide[k] * Math.hypot(dbdx, dbdy);
        // Near the snowline, cut harder. See buzzsawGain.
        let saw = 1;
        if (o.buzzsawGain > 0) {
          const u = (b[k] - ela) / o.buzzsawBandM;
          saw = 1 + o.buzzsawGain * Math.exp(-u * u);
        }
        let cut = (abrade + quarry) * saw * o.erodeYears;
        if (cutField[k] + cut > o.maxIncisionM) cut = Math.max(0, o.maxIncisionM - cutField[k]);
        cutField[k] += cut;
        b[k] -= cut;
        // The rock does not vanish. Most of it rides on as till; the rest
        // leaves as rock flour and is accounted for so the mass balance can
        // be checked.
        till[k] += cut * o.tillYield;
        tillExported += cut * (1 - o.tillYield);
      }
    }

    // ---- carry the till, and put it down where the ice gives up ----
    if (o.tillYield > 0) tillDropped += moveAndDropTill();

    history.push({ cycle, elaM: ela, icedFraction: iceNow / N });

    // ---- creep and infill, which is what sorts cirques from pits ----
    if (o.hillslopeD > 0) {
      diffuse({ nx, ny, step: dx, originX: 0, originY: 0, values: b },
        { D: o.hillslopeD, years: o.erodeYears });
    }

    // ---- and let the undercut walls come down ----
    if (o.wallPasses > 0) {
      massWaste({ nx, ny, step: dx, originX: bed.originX, originY: bed.originY, values: b },
        { critDeg: o.wallCritDeg, passes: o.wallPasses });
    }

    // Loose till slumps at a lower angle than rock. Run after the rock
    // wasting so a fresh moraine crest settles to something a real one
    // could stand at, rather than the knife edge the deposition rule
    // leaves when a snout sits still for a whole cycle.
    if (o.tillYield > 0 && o.tillPasses > 0) {
      massWaste({ nx, ny, step: dx, originX: bed.originX, originY: bed.originY, values: b },
        { critDeg: o.tillCritDeg, passes: o.tillPasses });
    }
  }

  // ---- and then the ice goes ----
  let meltYears = 0;
  let meltSteps = 0;
  let tillAtMelt = 0;
  let iceLeftM = 0;
  for (let k = 0; k < N; k++) if (H[k] > iceLeftM) iceLeftM = H[k];
  const iceBeforeMeltM = iceLeftM;
  if (o.meltOut) {
    melting = true;
    ela = hi + 1e5; // above everything: ablation everywhere, at its cap
    while (iceLeftM > 0.5 && meltSteps < o.meltSteps) {
      const { dt } = adiStep();
      years += dt;
      meltYears += dt;
      meltSteps++;
      iceLeftM = 0;
      for (let k = 0; k < N; k++) if (H[k] > iceLeftM) iceLeftM = H[k];
    }
    // Whatever was still riding on the ice is let go where it is. The
    // rail still applies: a point is never built up past maxTillM.
    for (let k = 0; k < N; k++) {
      if (till[k] <= 0) continue;
      const built = b[k] - b0[k];
      const drop = Math.max(0, Math.min(till[k], o.maxTillM - built));
      till[k] -= drop;
      b[k] += drop;
      tillAtMelt += drop;
      tillDropped += drop;
      // What the rail would not let stand goes out with the meltwater, as
      // outwash: counted apart from the flour, so the mass balance can
      // still be read.
      tillOutwash += till[k];
      till[k] = 0;
    }
    if (tillAtMelt > 0 && o.tillPasses > 0) {
      massWaste({ nx, ny, step: dx, originX: bed.originX, originY: bed.originY, values: b },
        { critDeg: o.tillCritDeg, passes: o.tillPasses });
    }
    // Numerically the ice is a few millimetres by now; physically it is
    // gone, and the bed is what is handed on.
    H.fill(0);
    iceLeftM = 0;
    melting = false;
  }

  const out = makeField(nx, ny, dx, bed.originX, bed.originY, b);
  const ice = makeField(nx, ny, dx, bed.originX, bed.originY, maxIce);
  const finalIce = makeField(nx, ny, dx, bed.originX, bed.originY, Float64Array.from(H));
  let cutMax = 0;
  let cutSum = 0;
  let dropMax = 0;
  for (let k = 0; k < N; k++) {
    const g = cutField[k];
    cutSum += g;
    if (g > cutMax) cutMax = g;
    const d = b0[k] - b[k];
    if (d > dropMax) dropMax = d;
  }
  let iced = 0;
  let clamped = 0;
  let slideMax = 0;
  for (let k = 0; k < N; k++) if (slide[k] > slideMax) slideMax = slide[k];
  for (let k = 0; k < N; k++) {
    if (maxIce[k] > 1) iced++;
    if (maxIce[k] >= o.maxIceM - 1e-6) clamped++;
  }

  // Closed hollows are the proof. A river cannot leave one; a glacier
  // leaves cirque floors, tarns and overdeepenings along its trough.
  const hollows = depressionStats(out, { minDepthM: 3 });

  return {
    bed: out,
    ice,
    finalIce,
    history,
    stats: {
      elaM: elaMean,
      years: Math.round(years),
      // The melt. iceBeforeMeltM is what the schedule alone left behind,
      // which is why the melt exists; finalIceM is what is on the map now.
      iceBeforeMeltM,
      meltYears: Math.round(meltYears),
      meltSteps,
      finalIceM: iceLeftM,
      tillAtMeltM: tillAtMelt,
      tillOutwashM: tillOutwash,
      maxIncisionM: cutMax, // glacial cutting only
      meanIncisionM: cutSum / N,
      maxBedDropM: dropMax, // including creep, which happens with or without ice
      glaciatedFraction: iced / N,
      maxIceM: maxIce.reduce((a, v) => (v > a ? v : a), 0),
      // Not a detail to bury. Ice against the ceiling means the climate and
      // the terrain given to this run build an ice CAP, not valley glaciers,
      // and the result will be a uniformly lowered block rather than a
      // carved one. Raise elaM, or give the map some low ground to melt on.
      clampedFraction: clamped / N,
      runaway: clamped / N > 0.02,
      maxSlideMPerYear: slideMax,
      elaMeanM: elaMean,
      elaSwingM: o.elaSwingM,
      glacialCycles: o.glacialCycles,
      elaColdestM: Math.min(...history.map((h) => h.elaM)),
      elaWarmestM: Math.max(...history.map((h) => h.elaM)),
      maxIcedFraction: Math.max(...history.map((h) => h.icedFraction)),
      minIcedFraction: Math.min(...history.map((h) => h.icedFraction)),
      basins: hollows.count,
      deepestBasinM: hollows.maxDepthM,
      // TILL. The mass balance is worth reporting rather than asserting
      // only in a test: eroded = still in transit + put down + exported as
      // flour, and if those stop adding up the advection is leaking.
      tillDepositedM: tillDropped,
      tillExportedM: tillExported,
      tillInTransitM: till.reduce((a, v) => a + v, 0),
      // The tallest thing the ice BUILT, and how much of the map it built
      // on. Measured as ground that finished higher than it started, which
      // erosion alone can never do.
      maxMoraineM: (() => { let m = 0; for (let k = 0; k < N; k++) { const d = b[k] - b0[k]; if (d > m) m = d; } return m; })(),
      morainedFraction: (() => { let c = 0; for (let k = 0; k < N; k++) if (b[k] - b0[k] > 1) c++; return c / N; })(),
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
