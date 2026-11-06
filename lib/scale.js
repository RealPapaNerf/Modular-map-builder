// scale.js — the one number that ties the printed model to the ground it
// stands for.
//
// WHY THIS FILE EXISTS. Everything a user types is MILLIMETRES ON THE PRINT,
// because that is the thing they can hold: a 200 mm module, a mountain that
// stands 42 mm proud of the valley floor. Everything the GENERATOR works in
// is metres of real ground, because that is the only way the glacier means
// anything -- ice physics on a 200 mm domain is not ice physics, it is noise
// with a Glen exponent. So there is exactly one conversion, it lives here,
// and it is stated rather than hidden:
//
//     metres of ground  =  millimetres on the print  x  metresPerMM
//
// THE SAME SCALE RUNS BOTH WAYS, horizontally and vertically. That makes the
// model a true scale model rather than a relief map with a stretched z, and
// it is why a number you type is a number you can measure off the print.

/** Metres of real ground per millimetre of print, when a spec does not say. */
export const DEFAULT_M_PER_MM = 25;

/** The scale a spec is drawn at. */
export function scaleOf(spec) {
  const v = spec?.metresPerMM;
  return Number.isFinite(v) && v > 0 ? v : DEFAULT_M_PER_MM;
}

/**
 * How much taller the print stands than the ground it was grown from.
 *
 * THE ONE PLACE THE MODEL STOPS BEING A TRUE SCALE MODEL, on purpose. At one
 * scale both ways a real range seen from above is flat: the Grand Teton
 * stands 2100 m over Jackson Hole, which is 42 mm on a 10 km module. Real
 * mountains look sheer because they are seen from below; a model on a table
 * is seen from above. So the print is stretched upward by this factor, and
 * the ice and the rivers run on ground that much lower in real metres -- a
 * 60 mm mountain at 2x is 750 m of real relief at 25 m/mm, which is what
 * the ice cuts into -- and the troughs come out twice as deep on the print
 * as they would at one scale. Every height a spec gives in millimetres is a
 * height on the PRINT: what you type is still what you get.
 */
export function verticalOf(spec) {
  const v = spec?.verticalExaggeration;
  return Number.isFinite(v) && v > 0 ? v : 1;
}

/** How far the world runs past the module on every side, in mm. See tile.js. */
export function marginOf(spec, tileMM = 200) {
  const v = spec?.marginMM;
  // 30% of the module: room for the ice to come from, without spending most
  // of the ice's grid on ground that is thrown away.
  return Number.isFinite(v) && v >= 0 ? v : tileMM * 0.3;
}

/** The world's side in millimetres: the module and its margins. */
export function worldMM(spec, tileMM = 200) {
  return tileMM + 2 * marginOf(spec, tileMM);
}

/** How much real ground the world covers, in metres. */
export function worldSizeM(spec, tileMM = 200) {
  return worldMM(spec, tileMM) * scaleOf(spec);
}

export const mmToM = (mm, spec) => mm * scaleOf(spec);
export const mToMM = (m, spec) => m / scaleOf(spec);

/**
 * True for a spec written for the old builder, which made a board of
 * several tiles with rivers running between them. There is no honest
 * conversion of one of those into one module -- which of its nine tiles
 * would it be? -- so it is refused with a sentence rather than guessed at.
 */
export function isBoardSpec(spec) {
  if (!spec || typeof spec !== 'object') return false;
  if (Array.isArray(spec.rivers) || spec.levels || spec.falls || spec.waterfalls || spec.rot || spec.cornerRaise) return true;
  if ((Number(spec.cols) || 1) > 1 || (Number(spec.rows) || 1) > 1) return true;
  if (spec.spine && spec.spine.length && spec.spine.every(([u, v]) => Math.abs(u) <= 1 && Math.abs(v) <= 1)) return true;
  return false;
}

export const BOARD_SPEC_MESSAGE = 'This is a board of several tiles from the old builder. The builder now makes one module at a time, '
  + 'with its channels drawn on it, and a board cannot be read as one module. Start from the example and draw it again.';
