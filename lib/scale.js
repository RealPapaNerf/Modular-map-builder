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

/** How far the world runs past the module on every side, in mm. See tile.js. */
export function marginOf(spec, tileMM = 200) {
  const v = spec?.marginMM;
  return Number.isFinite(v) && v >= 0 ? v : tileMM / 2;
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
