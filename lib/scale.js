// scale.js — the one number that ties the printed model to the ground it
// stands for, and the migration for maps written before it existed.
//
// WHY THIS FILE EXISTS. Everything a user types is MILLIMETRES ON THE PRINT,
// because that is the thing they can hold: a 200 mm tile, a 50 mm plate, a
// mountain that stands 42 mm proud of the valley floor. Everything the
// GENERATOR works in is metres of real ground, because that is the only way
// the glacier means anything -- ice physics on a 200 mm domain is not ice
// physics, it is noise with a Glen exponent. So there is exactly one
// conversion, it lives here, and it is stated rather than hidden:
//
//     metres of ground  =  millimetres on the print  x  metresPerMM
//
// THE SAME SCALE RUNS BOTH WAYS, horizontally and vertically. That makes the
// model a true scale model rather than a relief map with a stretched z, and
// it is why a number you type is a number you can measure off the print with
// callipers. A 1:25000-ish model of a real range already has all the relief
// anyone wants; the Lauterbrunnen wall is 800 m, which at 25 m/mm is 32 mm
// standing off the valley floor on a 10 mm plate.
//
// WHAT THIS REPLACED, and why it was wrong. The heights used to be
// NORMALISED: whatever the generator produced was squashed to fit a
// `reliefMM` budget. That meant the metre values were only ever ratios --
// raising a volcano quietly shortened every mountain on the map, because the
// span it was all divided through by had grown. Nothing you typed had a
// predictable printed height. Relief is now an OUTPUT: it is however tall
// the thing you built came out.

/** Metres of real ground per millimetre of print, when a spec does not say. */
export const DEFAULT_M_PER_MM = 25;

/** The scale a spec is drawn at. */
export function scaleOf(spec) {
  const v = spec?.metresPerMM;
  return Number.isFinite(v) && v > 0 ? v : DEFAULT_M_PER_MM;
}

/**
 * The board's longest side in millimetres.
 *
 * The world is square and gets stretched onto the board, which is how it
 * already worked; this just says which dimension sets its size.
 */
export function boardMM(spec, tileMM) {
  const cols = spec?.cols || 3;
  const rows = spec?.rows || 3;
  return Math.max(cols, rows) * tileMM;
}

/** How much real ground the board covers, in metres. */
export function worldSizeM(spec, tileMM) {
  return boardMM(spec, tileMM) * scaleOf(spec);
}

export const mmToM = (mm, spec) => mm * scaleOf(spec);
export const mToMM = (m, spec) => m / scaleOf(spec);

/**
 * Bring a spec written in world metres up to one written in print
 * millimetres.
 *
 * Horizontal is preserved exactly: the scale is recovered from the old
 * `worldSizeM` and the board it was spread over, so the map covers the same
 * ground and every normalised [u,v] still lands in the same place.
 *
 * Vertical is NOT preserved, and cannot be. The old file squashed its
 * heights into `reliefMM`, so an old `spineHeightM` of 1600 did not describe
 * a height -- it described a ratio against whatever else happened to be on
 * the map. Converting it at the recovered scale is the honest reading of
 * what the number said, and it is what makes the result measurable. Expect
 * an old map to come out taller and more dramatic than its preview; that is
 * the squash coming off, not a bug.
 */
export function migrateSpec(spec, tileMM = 200) {
  if (!spec || typeof spec !== 'object') return spec;
  const out = { ...spec };
  const cols = out.cols || 3;
  const rows = out.rows || 3;
  const board = Math.max(cols, rows) * (out.contract?.tileMM ?? tileMM);

  if (out.metresPerMM === undefined && Number.isFinite(out.worldSizeM)) {
    out.metresPerMM = out.worldSizeM / board;
  }
  const scale = scaleOf(out);
  const toMM = (m) => Math.round((m / scale) * 100) / 100;

  const move = (obj, fromKey, toKey) => {
    if (obj && Number.isFinite(obj[fromKey]) && obj[toKey] === undefined) {
      obj[toKey] = toMM(obj[fromKey]);
    }
    if (obj) delete obj[fromKey];
  };

  move(out, 'spineHeightM', 'spineHeightMM');
  move(out, 'spineWidthM', 'spineWidthMM');
  move(out, 'baseElevM', 'baseElevMM');
  delete out.worldSizeM;
  // reliefMM is an output now. Keeping it would look like a control that
  // does nothing, which is worse than dropping it.
  delete out.reliefMM;

  if (Array.isArray(out.volcanoes)) {
    out.volcanoes = out.volcanoes.map((v) => {
      const n = { ...v };
      move(n, 'heightM', 'heightMM');
      move(n, 'baseRadiusM', 'baseRadiusMM');
      move(n, 'craterRadiusM', 'craterRadiusMM');
      move(n, 'craterDepthM', 'craterDepthMM');
      return n;
    });
  }
  if (Array.isArray(out.flats)) {
    out.flats = out.flats.map((f) => {
      const n = { ...f };
      move(n, 'radiusM', 'radiusMM');
      move(n, 'elevM', 'elevMM');
      return n;
    });
  }
  if (out.glacier && typeof out.glacier === 'object') {
    const g = { ...out.glacier };
    move(g, 'elaSwingM', 'elaSwingMM');
    move(g, 'elaM', 'elaMM');
    out.glacier = g;
  }
  return out;
}

/** True when a spec still speaks in world metres. */
export function needsMigration(spec) {
  if (!spec || typeof spec !== 'object') return false;
  const keys = ['worldSizeM', 'spineHeightM', 'spineWidthM', 'baseElevM', 'reliefMM'];
  if (keys.some((k) => spec[k] !== undefined)) return true;
  if ((spec.volcanoes || []).some((v) => v.heightM !== undefined || v.baseRadiusM !== undefined)) return true;
  if ((spec.flats || []).some((f) => f.radiusM !== undefined || f.elevM !== undefined)) return true;
  if (spec.glacier && (spec.glacier.elaSwingM !== undefined || spec.glacier.elaM !== undefined)) return true;
  return false;
}
