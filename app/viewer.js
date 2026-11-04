// viewer.js — the grown board in 3D. Browser only.
//
// relief's viewer with the geography taken out: one renderer, orbit
// controls, drawn only when something has changed, and the model built z-up
// (the printer's convention, and the library's) then tipped into three.js's
// y-up world, so every coordinate in here is a board millimetre.
//
// What it draws is the board as it sits on the table, not the files: each
// tile on its risers and turned the way it is placed, water where the board
// says the water is, a line round the top of every piece where the seams
// are, and the board's badges floating over the seams -- drawn by the same
// function the 2D board draws them with, onto a canvas laid over this one.
//
// The ground comes from the worker as one Float32Array of heights per tile
// (see heights.js), and the geometry is built straight from it: no STL, no
// triangle soup, and the normals come from the height field so neighbouring
// cells agree.
//
// In Refine it also takes tools: a brush that paints a stroke along the
// ground (the left button paints, the right one orbits), a click that places
// something, and handles to drag. It draws the band round every rim where a
// stroke fades out, and a cursor showing how much of the brush lands where
// -- the same weights lib/edits.js replays, so what is shown is what is done.

import * as THREE from 'three';
import { OrbitControls } from '../lib/vendor/OrbitControls.js';
import { OPPOSITE, STEP } from '../lib/contract.js';
import { facingEdge, normRot } from '../lib/board.js';
import { falloff, rimWeight } from '../lib/edits.js';
import { drawBadge, flowOnBoard } from './board.js';
import * as H from './heights.js';

const PLATE_GAP_MM = 1.2;   // between stacked risers, so the stack reads as a stack
const PLATE_INSET_MM = 1.5; // in from the tile's footprint, so the stack reads as a separate part
const BADGE_LIFT_MM = 7;    // how far over the seam a badge floats
const CURSOR_SIDE = 29;     // samples a side of the brush cursor

/** CSS colour to a THREE.Color, falling back when a custom property is missing. */
function colour(css, fallback = '#888888') {
  const c = new THREE.Color();
  try { c.setStyle(css || fallback); } catch { c.setStyle(fallback); }
  return c;
}

/** sRGB components (0..1) into the linear space vertex colours are read in. */
const toLinear = (v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);

/**
 * Whether the browser is drawing WebGL on the CPU: no GPU, or one it has
 * blocklisted, which is common on virtual machines and older Linux. Such a
 * renderer spends more than half its frame on multisampling, so it does not
 * get any.
 */
function softwareGL() {
  try {
    const c = document.createElement('canvas');
    const gl = c.getContext('webgl2') || c.getContext('webgl');
    if (!gl) return false;
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    const name = String(gl.getParameter(ext ? ext.UNMASKED_RENDERER_WEBGL : gl.RENDERER));
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    return /swiftshader|llvmpipe|softpipe|software|basic render/i.test(name);
  } catch {
    return false;
  }
}

// While the camera moves, a frame slower than this puts the view into its
// quick mode -- half the pixels, a quarter of the ground's triangles -- until
// it stops, when one full frame is drawn. A GPU never gets near it.
const SLOW_FRAME_MS = 45;
const SETTLE_MS = 280;

/** How each kind of handle is drawn: a fill and a letter. */
const HANDLE_LOOK = {
  lake: { fill: 'water', glyph: 'L' },
  springpoint: { fill: 'spring', glyph: 'S' },
  volcano: { fill: 'dam', glyph: 'V' },
  spine: { fill: 'ridge', glyph: '' },
  flat: { fill: 'cliff', glyph: 'F' },
};

/**
 * Make a viewer on `canvas`, with `overlay` (a 2D canvas the same size, on
 * top, pointer-transparent) for the badges and handles.
 *
 *   onHover(hit, px, py, busy)  the pointer moved; hit is a seam, a tile or null
 *   onPick(hit)                 a click that was not the end of an orbit
 *   onStroke(points)            a brushstroke ended: [{ x, y, z }] in board mm
 *   onPlace(hit)                a click with the place tool, on a tile
 *   onHandle(handle, hit, phase)  a handle dragged: phase 'move' or 'end'
 *
 * Throws if WebGL cannot be had; the caller falls back to the 2D board.
 */
export function createViewer({
  canvas, overlay, theme,
  onHover = () => {}, onPick = () => {}, onStroke = () => {}, onPlace = () => {}, onHandle = () => {},
}) {
  const software = softwareGL();
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: !software });
  const basePixelRatio = Math.min(window.devicePixelRatio || 1, 2);
  renderer.setPixelRatio(basePixelRatio);
  const octx = overlay.getContext('2d');

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(38, 1, 1, 20000);
  camera.position.set(300, 700, 900);

  const controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true;
  // A short glide: with damping the camera keeps easing after the pointer
  // lets go, and every frame of that is a full draw.
  controls.dampingFactor = 0.16;
  controls.maxPolarAngle = Math.PI / 2 - 0.04; // never under the table
  controls.zoomToCursor = true;
  const ORBIT_BUTTONS = { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.PAN };
  const ORBIT_TOUCHES = { ONE: THREE.TOUCH.ROTATE, TWO: THREE.TOUCH.DOLLY_PAN };
  // With a brush, the left button and one finger are the brush's; the
  // right button orbits (with Shift, pans), two fingers turn and zoom.
  const BRUSH_BUTTONS = { LEFT: -1, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.ROTATE };
  const BRUSH_TOUCHES = { ONE: -1, TWO: THREE.TOUCH.DOLLY_ROTATE };

  // Drawn only when something has changed: nine tiles redrawn sixty times a
  // second, in a pane that may not even be showing, is a laptop fan for
  // nothing -- and on a software renderer it starves everything else. The
  // camera counts as changed when it has moved a visible amount since the
  // last frame drawn, whoever moved it: the tail of a glide is sub-pixel
  // long before the controls stop reporting it.
  let needsRender = true;
  const invalidate = () => { needsRender = true; };
  const drawnFrom = { pos: new THREE.Vector3(Infinity, 0, 0), target: new THREE.Vector3() };
  const cameraMoved = () => {
    const visible = camera.position.distanceTo(controls.target) * 2e-4; // about a quarter of a pixel
    return camera.position.distanceTo(drawnFrom.pos) > visible || controls.target.distanceTo(drawnFrom.target) > visible;
  };

  scene.add(new THREE.HemisphereLight(0xeef2ff, 0x3a3326, 1.45));
  const key = new THREE.DirectionalLight(0xffffff, 2.0);
  key.position.set(-0.6, 1.6, -0.5); // from the north-west, as the hillshade is lit
  scene.add(key);
  const fill = new THREE.DirectionalLight(0xc9d6ff, 0.55);
  fill.position.set(1.2, 0.7, 1.4);
  scene.add(fill);

  // The board is built z-up; tip it into three.js's y-up world. Board north
  // (+y) goes away from a camera standing south of it.
  const root = new THREE.Group();
  root.rotation.x = -Math.PI / 2;
  scene.add(root);

  let th = theme;
  const overlayMat = (o = {}) => new THREE.MeshBasicMaterial({
    vertexColors: true, transparent: true, depthWrite: false,
    polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4, ...o,
  });
  const mat = {
    ground: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.93, metalness: 0 }),
    walls: new THREE.MeshStandardMaterial({ roughness: 0.88, metalness: 0, side: THREE.DoubleSide }),
    plate: new THREE.MeshStandardMaterial({ roughness: 0.8, metalness: 0 }),
    water: new THREE.MeshStandardMaterial({
      transparent: true, opacity: 0.6, roughness: 0.12, metalness: 0.05, depthWrite: false,
      polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -2,
    }),
    table: new THREE.MeshStandardMaterial({ roughness: 1, metalness: 0 }),
    band: overlayMat(),
    cursor: overlayMat(),
    trail: new THREE.LineBasicMaterial({ transparent: true, opacity: 0.9, depthTest: false }),
  };
  const table = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), mat.table);
  table.position.z = -0.4;
  root.add(table);

  const raycaster = new THREE.Raycaster();
  raycaster.layers.set(1); // the pick proxies live on layer 1, which the camera never draws

  let model = null; // { T, plateMM, tiles: Map(id -> tile object), span, payload }
  let framedFor = null; // the board footprint the camera was last framed for
  let board = { anchors: [], sel: null, hover: null };
  let badgeRects = [];
  let handleSpots = [];
  let disposed = false;
  let firstFrameAt = null;
  const frameTimes = [];
  const renderMS = [];
  let frames = 0;
  let fly = null;
  let quick = false;     // see setQuick
  let quickFrames = 0;
  let lastRenderAt = 0;
  let interval = 0;

  // Tools (Refine). `tool` is null (orbit and pick), or { kind: 'brush',
  // radiusMM, lockMM }, { kind: 'place' }, or { kind: 'select' } with
  // `handles` to drag.
  let tool = null;
  let handles = [];
  let stroke = null;   // the brushstroke being drawn: { pts, id }
  let dragging = null; // the handle being dragged: { h, id, last }
  let cursorAt = null; // where the brush cursor is, in board mm
  let hoverHandle = null;

  function applyTheme() {
    scene.background = colour(th.canvas, '#e9e7e0');
    mat.table.color = colour(th.grid, '#d6d2c7');
    mat.walls.color = colour('#857a66');
    // Risers are plain printed plates, not ground: a pale neutral, so a stack
    // reads as blocks under a tile and not as more of the tile.
    mat.plate.color = colour('#d9d6ce');
    mat.water.color = colour(th.water, '#2f7fd8');
    mat.trail.color = colour(th.select, '#2b6cb0');
    if (model) for (const t of model.tiles.values()) { paintRim(t); if (t.band) fillBand(t); }
    invalidate();
  }

  /* -------------------------------------------------------------- tiles */

  function disposeModel() {
    if (!model) return;
    for (const t of model.tiles.values()) {
      root.remove(t.group);
      t.group.traverse((o) => {
        if (o.geometry && o.geometry !== model.plateGeometry) o.geometry.dispose();
        if (o.material && o.material === t.rimMaterial) o.material.dispose();
      });
    }
    model.plateGeometry.dispose();
    model = null;
  }

  function geometry(arrays, colorSize = 3) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(arrays.position, 3));
    if (arrays.normal) g.setAttribute('normal', new THREE.BufferAttribute(arrays.normal, 3));
    if (arrays.color) g.setAttribute('color', new THREE.BufferAttribute(arrays.color, colorSize));
    if (arrays.index) g.setIndex(new THREE.BufferAttribute(arrays.index, 1));
    g.computeBoundingSphere();
    return g;
  }

  const drop = (t, name) => {
    const o = t[name];
    if (!o) return;
    t.inner.remove(o);
    o.geometry.dispose();
    t[name] = null;
  };

  /** One tile's meshes, made from its heights: built when grown, and again when a stroke is previewed. */
  function fillTile(t) {
    for (const name of ['ground', 'walls', 'rim', 'proxy', 'water']) drop(t, name);
    const h = t.h;
    const span = model.span;
    const tint = (kind, z) => H.groundColour(kind, (h.standMM + z - span.lo) / (span.hi - span.lo)).map(toLinear);
    const arrays = H.groundArrays(h, tint);
    // The same vertices with a quarter of the triangles, for quick mode,
    // after the full set in one index buffer: switching is a draw range.
    const coarse = H.gridIndex(h.nx, h.ny, 2);
    const both = new arrays.index.constructor(arrays.index.length + coarse.length);
    both.set(arrays.index, 0);
    both.set(coarse, arrays.index.length);
    t.ground = new THREE.Mesh(geometry({ ...arrays, index: both }), mat.ground);
    t.ground.userData.ranges = { full: [0, arrays.index.length], quick: [arrays.index.length, coarse.length] };
    t.ground.geometry.setDrawRange(...t.ground.userData.ranges[quick ? 'quick' : 'full']);
    t.inner.add(t.ground);
    t.walls = new THREE.Mesh(geometry(H.wallArrays(h)), mat.walls);
    t.inner.add(t.walls);
    t.rim = new THREE.LineLoop(geometry(H.rimLine(h)), t.rimMaterial);
    t.inner.add(t.rim);
    t.proxy = new THREE.Mesh(geometry(H.proxyArrays(h)), mat.ground);
    t.proxy.layers.set(1);
    t.proxy.userData.tile = t.id;
    t.inner.add(t.proxy);
    t.tops = Object.fromEntries(['N', 'E', 'S', 'W'].map((e) => [e, H.edgeTop(h, e)]));
    fillBand(t);
    t.waterKey = null;
    if (t.waterArgs) setWater(t, ...t.waterArgs);
  }

  /** The band round the rim where a stroke fades out, shown while a brush is in hand. */
  function fillBand(t) {
    drop(t, 'band');
    if (!(tool?.kind === 'brush' && tool.lockMM > 0)) return;
    const c = colour(th.dam, '#c2412d');
    t.band = new THREE.Mesh(geometry(H.lockBandArrays(t.h, tool.lockMM, [c.r, c.g, c.b], { alpha: 0.42 }), 4), mat.band);
    t.band.renderOrder = 2;
    t.inner.add(t.band);
  }

  /**
   * The grown tiles, as the worker sent them. Built once per grow; turning a
   * tile or flooding it later only moves and re-waters what is here.
   */
  function setTiles(payload) {
    disposeModel();
    if (!payload || !payload.tiles?.length) { invalidate(); return; }
    const T = payload.contract.tileMM;
    const plateMM = payload.contract.plateMM;
    const span = H.worldSpan(payload.tiles);
    const plateGeometry = new THREE.BoxGeometry(T - 2 * PLATE_INSET_MM, T - 2 * PLATE_INSET_MM, plateMM - PLATE_GAP_MM);
    model = { T, plateMM, span, plateGeometry, tiles: new Map(), payload };

    for (const h of payload.tiles) {
      const group = new THREE.Group();
      group.position.set(h.col * T, h.row * T, 0);
      group.name = h.label;

      // The risers, one block per plate, with a hairline between them.
      for (let k = 0; k < h.level; k++) {
        const p = new THREE.Mesh(plateGeometry, mat.plate);
        p.position.set(T / 2, T / 2, k * plateMM + (plateMM - PLATE_GAP_MM) / 2 + PLATE_GAP_MM / 2);
        group.add(p);
      }

      // The piece itself, turned about its own middle the way it sits.
      const piece = new THREE.Group();
      piece.position.set(T / 2, T / 2, h.standMM);
      group.add(piece);
      const inner = new THREE.Group();
      inner.position.set(-T / 2, -T / 2, 0);
      piece.add(inner);
      root.add(group);

      const t = {
        id: h.id, h, group, piece, inner, rimMaterial: new THREE.LineBasicMaterial({ transparent: true }),
        ground: null, walls: null, rim: null, proxy: null, band: null, water: null,
        waterKey: null, waterArgs: null, waterTris: 0, rot: 0, tops: null, hl: null,
      };
      model.tiles.set(h.id, t);
      fillTile(t);
      paintRim(t);
    }

    // The table: the board's footprint and a tile's width round it.
    let c0 = Infinity; let r0 = Infinity; let c1 = -Infinity; let r1 = -Infinity;
    for (const h of payload.tiles) { c0 = Math.min(c0, h.col); r0 = Math.min(r0, h.row); c1 = Math.max(c1, h.col + 1); r1 = Math.max(r1, h.row + 1); }
    table.scale.set((c1 - c0 + 2) * T, (r1 - r0 + 2) * T, 1);
    table.position.set(((c0 + c1) / 2) * T, ((r0 + r1) / 2) * T, -0.4);

    // A regrow of the same board keeps the camera where it was: in Refine
    // that is every stroke, and the view should not jump after each one.
    firstFrameAt = null;
    const footprint = `${c0},${r0},${c1},${r1},${T}`;
    if (footprint !== framedFor) reframe();
    framedFor = footprint;
    invalidate();
  }

  /**
   * New heights for one tile, before the build has caught up: a stroke
   * previewed on the ground as it stands, replaced when the regrow lands.
   */
  function updateHeights(id, heights) {
    const t = model?.tiles.get(id);
    if (!t || heights.length !== t.h.heights.length) return;
    t.h = { ...t.h, heights };
    fillTile(t);
    invalidate();
  }

  function paintRim(t) {
    const m = t.rimMaterial;
    if (t.hl === 'sel') { m.color = colour(th.select, '#2b6cb0'); m.opacity = 1; }
    else if (t.hl === 'hover') { m.color = colour(th.select, '#2b6cb0'); m.opacity = 0.55; }
    else { m.color = colour(th.edge, '#6b6455'); m.opacity = 0.75; }
  }

  function setWater(t, running, pondMM) {
    t.waterArgs = [running, pondMM];
    const k = `${running ? 1 : 0}|${pondMM === null ? '-' : pondMM.toFixed(2)}`;
    if (k === t.waterKey) return;
    t.waterKey = k;
    drop(t, 'water');
    const arrays = H.waterArrays(t.h, H.waterSurface(t.h, { running, pondMM }));
    t.waterTris = arrays.triangles;
    if (!arrays.triangles) return;
    t.water = new THREE.Mesh(geometry(arrays), mat.water);
    t.water.renderOrder = 1;
    t.inner.add(t.water);
  }

  /* -------------------------------------------------------------- board */

  /**
   * What the board says about the grown tiles: how each is turned, whether
   * its river runs, how high it ponds, and what every seam does. `plan` is
   * lib/board.js's plan for the spec the tiles were grown from, with the
   * turns as they are now -- a turn is play, it changes nothing printed.
   */
  function setBoard(plan, { selection = null, hover = null } = {}) {
    if (!model) return;
    const T = model.T;
    const byId = new Map((plan?.tiles || []).map((t) => [t.id, t]));
    for (const t of model.tiles.values()) {
      const p = byId.get(t.id);
      const rot = normRot(p?.rot);
      if (rot !== t.rot) {
        t.rot = rot;
        t.piece.rotation.z = -rot * Math.PI / 2; // a quarter turn clockwise, seen from above
      }
      const pond = p && p.ponds && Number.isFinite(p.levelMM) ? p.levelMM - t.h.standMM : null;
      setWater(t, !!p?.wet, pond);
      const hl = selection?.type === 'tile' && selection.col === t.h.col && selection.row === t.h.row ? 'sel'
        : hover?.kind === 'tile' && hover.id === t.id ? 'hover' : null;
      if (hl !== t.hl) { t.hl = hl; paintRim(t); }
    }

    // Where each badge floats: over the middle of its seam, a little above
    // the higher of the two sides there, which is the water if it crosses.
    const top = (id, edge) => {
      const t = model.tiles.get(id);
      return t ? t.h.standMM + t.tops[facingEdge(edge, t.rot)] : -Infinity;
    };
    const anchors = [];
    for (const s of plan?.seams || []) {
      if (s.kind === 'plane' || !model.tiles.has(s.a)) continue;
      const z = Math.max(top(s.a, s.edge), s.b ? top(s.b, OPPOSITE[s.edge]) : -Infinity) + BADGE_LIFT_MM;
      // A seam with nothing across it has its badge just off the edge, as on the board.
      const [ox, oy] = STEP[s.edge];
      const out = s.b ? 0 : 0.07 * T;
      anchors.push({ seam: s, pos: new THREE.Vector3(s.at.x + ox * out, s.at.y + oy * out, z), dir: flowOnBoard(s) });
    }
    board = {
      anchors,
      sel: selection?.type === 'seam' ? selection.id : null,
      hover: hover?.kind === 'seam' ? hover.id : null,
    };
    invalidate();
  }

  /* ------------------------------------------------------------- ground */

  /** The tile under a board point, if there is one. */
  function tileAt(x, y) {
    if (!model) return null;
    return model.tiles.get(`${Math.floor(x / model.T)},${Math.floor(y / model.T)}`) || null;
  }

  /** A board point in a tile's own millimetres, undoing its turn (features.js boardToLocal). */
  function localOf(t, x, y) {
    const T = model.T;
    let dx = x - (t.h.col * T + T / 2);
    let dy = y - (t.h.row * T + T / 2);
    for (let i = 0; i < t.rot; i++) [dx, dy] = [-dy, dx];
    return { x: dx + T / 2, y: dy + T / 2 };
  }

  /** The top of the ground at a board point, on the table: the tile's riser plus its own height. */
  function groundAt(x, y) {
    const t = tileAt(x, y);
    if (!t) return null;
    const l = localOf(t, x, y);
    return { t, z: t.h.standMM + H.sampleHeight(t.h, l.x, l.y), local: l };
  }

  /* ------------------------------------------------------------ overlay */

  const tmp = new THREE.Vector3();
  function toScreen(v, w, h) {
    tmp.copy(v).applyMatrix4(root.matrixWorld).project(camera);
    return { x: (tmp.x + 1) / 2 * w, y: (1 - tmp.y) / 2 * h, z: tmp.z };
  }

  function drawOverlay() {
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    if (overlay.width !== Math.round(w * dpr) || overlay.height !== Math.round(h * dpr)) {
      overlay.width = Math.round(w * dpr);
      overlay.height = Math.round(h * dpr);
    }
    octx.setTransform(dpr, 0, 0, dpr, 0, 0);
    octx.clearRect(0, 0, w, h);
    badgeRects = [];
    handleSpots = [];
    if (!model) return;
    const camPos = camera.position;
    const placed = board.anchors.map((a) => {
      const world = a.pos.clone().applyMatrix4(root.matrixWorld);
      return { a, dist: world.distanceTo(camPos) };
    }).sort((p, q) => q.dist - p.dist); // the far ones first, so the near ones sit on top
    const ahead = new THREE.Vector3();
    for (const { a } of placed) {
      const p = toScreen(a.pos, w, h);
      if (p.z > 1 || p.z < -1 || p.x < -40 || p.y < -40 || p.x > w + 40 || p.y > h + 40) continue;
      ahead.set(a.pos.x + a.dir.x * 20, a.pos.y + a.dir.y * 20, a.pos.z);
      const q = toScreen(ahead, w, h);
      const len = Math.hypot(q.x - p.x, q.y - p.y) || 1;
      const ring = board.sel === a.seam.id || board.hover === a.seam.id;
      const r = drawBadge(octx, a.seam, p.x, p.y, th, ring, { x: (q.x - p.x) / len, y: (q.y - p.y) / len });
      if (r) badgeRects.push({ id: a.seam.id, rect: r });
    }

    // Handles on top of the badges: they are what the select tool is for.
    if (tool?.kind === 'select') {
      const v = new THREE.Vector3();
      for (const hd of handles) {
        const g = groundAt(hd.x, hd.y);
        if (!g) continue;
        const p = toScreen(v.set(hd.x, hd.y, g.z + 1.5), w, h);
        if (p.z > 1 || p.z < -1) continue;
        const look = HANDLE_LOOK[hd.kind] || { fill: 'accent', glyph: '' };
        const on = dragging?.h.key === hd.key || hoverHandle === hd.key;
        const r = hd.kind === 'spine' ? 6 : 8;
        octx.beginPath();
        octx.arc(p.x, p.y, r, 0, Math.PI * 2);
        octx.fillStyle = th[look.fill] || th.accent;
        octx.fill();
        octx.lineWidth = on ? 3 : 1.5;
        octx.strokeStyle = on ? th.select : '#ffffff';
        octx.stroke();
        if (look.glyph) {
          octx.fillStyle = '#ffffff';
          octx.font = '700 9px system-ui, sans-serif';
          octx.textAlign = 'center';
          octx.textBaseline = 'middle';
          octx.fillText(look.glyph, p.x, p.y + 0.5);
        }
        handleSpots.push({ h: hd, x: p.x, y: p.y, r: r + 3 });
      }
    }
  }

  /* --------------------------------------------------- cursor and trail */

  const cursorGeo = new THREE.BufferGeometry();
  cursorGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(CURSOR_SIDE * CURSOR_SIDE * 3), 3));
  cursorGeo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(CURSOR_SIDE * CURSOR_SIDE * 4), 4));
  cursorGeo.setIndex(new THREE.BufferAttribute(H.gridIndex(CURSOR_SIDE, CURSOR_SIDE, 1), 1));
  const cursor = new THREE.Mesh(cursorGeo, mat.cursor);
  cursor.renderOrder = 3;
  cursor.visible = false;
  cursor.frustumCulled = false;
  root.add(cursor);

  const TRAIL_MAX = 4096;
  const trailGeo = new THREE.BufferGeometry();
  trailGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(TRAIL_MAX * 3), 3));
  trailGeo.setDrawRange(0, 0);
  const trail = new THREE.Line(trailGeo, mat.trail);
  trail.renderOrder = 4;
  trail.frustumCulled = false;
  root.add(trail);

  /**
   * The brush cursor at a board point: a patch of ground as wide as the
   * brush, tinted by how much of a stroke lands at each point -- the brush's
   * own falloff times the rim lock of whichever tile the point is on.
   */
  function placeCursor(x, y) {
    cursorAt = x === null ? null : { x, y };
    if (!cursorAt || tool?.kind !== 'brush' || !model) { cursor.visible = false; invalidate(); return; }
    const R = tool.radiusMM;
    const pos = cursorGeo.attributes.position.array;
    const col = cursorGeo.attributes.color.array;
    const c = colour(th.select, '#2b6cb0');
    const T = model.T;
    for (let j = 0; j < CURSOR_SIDE; j++) {
      for (let i = 0; i < CURSOR_SIDE; i++) {
        const k = j * CURSOR_SIDE + i;
        const px = x - R + (2 * R * i) / (CURSOR_SIDE - 1);
        const py = y - R + (2 * R * j) / (CURSOR_SIDE - 1);
        const g = groundAt(px, py);
        pos[k * 3] = px;
        pos[k * 3 + 1] = py;
        pos[k * 3 + 2] = (g ? g.z : 0) + 0.5;
        const wgt = g ? falloff(Math.hypot(px - x, py - y) / R) * rimWeight(g.local.x, g.local.y, T, tool.lockMM) : 0;
        col[k * 4] = c.r;
        col[k * 4 + 1] = c.g;
        col[k * 4 + 2] = c.b;
        col[k * 4 + 3] = 0.6 * wgt;
      }
    }
    cursorGeo.attributes.position.needsUpdate = true;
    cursorGeo.attributes.color.needsUpdate = true;
    cursor.visible = true;
    invalidate();
  }

  function drawTrail() {
    const pts = stroke?.pts || [];
    const a = trailGeo.attributes.position.array;
    const n = Math.min(pts.length, TRAIL_MAX);
    for (let i = 0; i < n; i++) {
      a[i * 3] = pts[i].x;
      a[i * 3 + 1] = pts[i].y;
      a[i * 3 + 2] = pts[i].z + 1;
    }
    trailGeo.attributes.position.needsUpdate = true;
    trailGeo.setDrawRange(0, n);
    invalidate();
  }

  /**
   * What to do with the pointer, in Refine: null to orbit and pick, or a
   * brush, a place tool or the select tool with handles. A brush shows the
   * rim lock on every tile, because that is where it stops working.
   */
  function setTool(next) {
    const was = tool;
    tool = next || null;
    const brushy = tool && (tool.kind === 'brush' || tool.kind === 'place');
    Object.assign(controls.mouseButtons, brushy ? BRUSH_BUTTONS : ORBIT_BUTTONS);
    Object.assign(controls.touches, brushy ? BRUSH_TOUCHES : ORBIT_TOUCHES);
    const bandWas = was?.kind === 'brush' ? was.lockMM : 0;
    const bandNow = tool?.kind === 'brush' ? tool.lockMM : 0;
    if (model && bandWas !== bandNow) for (const t of model.tiles.values()) fillBand(t);
    if (tool?.kind !== 'brush') cursor.visible = false;
    else if (cursorAt) placeCursor(cursorAt.x, cursorAt.y);
    if (tool?.kind !== 'select') hoverHandle = null;
    stroke = null;
    drawTrail();
    invalidate();
  }

  /** The things the select tool can drag, in board mm: [{ key, kind, index, x, y }]. */
  function setHandles(list) {
    handles = list || [];
    invalidate();
  }

  /* ------------------------------------------------------------ camera */

  function boardBox() {
    const box = new THREE.Box3();
    if (!model) return box;
    for (const t of model.tiles.values()) box.expandByObject(t.group);
    return box;
  }

  /** Put the whole board in view, from the south and a little east, looking down at it. */
  function reframe() {
    // The canvas may have changed shape while it was hidden; frame for the shape it is now.
    if (canvas.clientWidth && canvas.clientHeight && (canvas.clientWidth !== lastW || canvas.clientHeight !== lastH)) resize();
    root.updateMatrixWorld(true);
    const box = boardBox();
    if (box.isEmpty()) return;
    const sphere = box.getBoundingSphere(new THREE.Sphere());
    const vFov = (camera.fov * Math.PI) / 180;
    const hFov = 2 * Math.atan(Math.tan(vFov / 2) * camera.aspect);
    const distance = (sphere.radius / Math.sin(Math.min(vFov, hFov) / 2)) * 1.02;
    fly = null;
    controls.target.copy(sphere.center);
    const dir = new THREE.Vector3(0.32, 0.92, 1).normalize();
    camera.position.copy(sphere.center).addScaledVector(dir, distance);
    camera.near = Math.max(1, distance / 400);
    camera.far = distance * 12;
    camera.updateProjectionMatrix();
    controls.maxDistance = distance * 4;
    controls.minDistance = 40;
    controls.update();
    invalidate();
  }

  /** Swing round to one tile and come in close, over a third of a second. */
  function focusTile(id) {
    const t = model?.tiles.get(id);
    if (!t) return;
    root.updateMatrixWorld(true);
    const box = new THREE.Box3().expandByObject(t.group);
    const target = box.getCenter(new THREE.Vector3());
    const offset = camera.position.clone().sub(controls.target).setLength(model.T * 2.3);
    fly = {
      t0: performance.now(), ms: 340,
      fromTarget: controls.target.clone(), toTarget: target,
      fromPos: camera.position.clone(), toPos: target.clone().add(offset),
    };
    invalidate();
  }

  function zoomBy(f) {
    const off = camera.position.clone().sub(controls.target);
    const len = Math.max(controls.minDistance, Math.min(controls.maxDistance, off.length() / f));
    camera.position.copy(controls.target).add(off.setLength(len));
    controls.update();
    invalidate();
  }

  /* ------------------------------------------------------------ pointer */

  /**
   * The ground under a screen point: the coarse proxy finds the tile, then a
   * short march along the ray against the full heights finds the point, so a
   * stroke lands where the pointer is on a steep slope too.
   */
  function hitGround(px, py) {
    if (!model) return null;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    root.updateMatrixWorld(true);
    raycaster.setFromCamera(new THREE.Vector2((px / w) * 2 - 1, -(py / h) * 2 + 1), camera);
    const proxies = [...model.tiles.values()].map((t) => t.proxy);
    const hit = raycaster.intersectObjects(proxies, false)[0];
    if (!hit) return null;
    // The ray, in board mm.
    const o = root.worldToLocal(raycaster.ray.origin.clone());
    const d = root.worldToLocal(raycaster.ray.origin.clone().add(raycaster.ray.direction)).sub(o);
    const at = (s) => ({ x: o.x + d.x * s, y: o.y + d.y * s, z: o.z + d.z * s });
    const above = (s) => { const p = at(s); const g = groundAt(p.x, p.y); return g ? p.z - g.z : 1; };
    let s0 = hit.distance - 12;
    let s1 = hit.distance + 12;
    // Walk to the first crossing near the proxy's hit, then halve the gap.
    let prev = s0;
    let found = above(s0) <= 0 ? null : undefined;
    for (let s = s0 + 1.5; s <= s1 && found === undefined; s += 1.5) {
      if (above(s) <= 0) found = [prev, s];
      prev = s;
    }
    let s = hit.distance;
    if (found) {
      [s0, s1] = found;
      for (let i = 0; i < 16; i++) { const m = (s0 + s1) / 2; if (above(m) > 0) s0 = m; else s1 = m; }
      s = (s0 + s1) / 2;
    }
    const p = at(s);
    const g = groundAt(p.x, p.y) || { t: model.tiles.get(hit.object.userData.tile), z: p.z, local: { x: 0, y: 0 } };
    const t = g.t;
    return {
      kind: 'tile', id: t.id, col: t.h.col, row: t.h.row, label: t.h.label, rot: t.rot,
      x: p.x, y: p.y, z: g.z, localX: g.local.x, localY: g.local.y,
    };
  }

  function hitHandleAt(px, py) {
    let best = null;
    let bestD = Infinity;
    for (const s of handleSpots) {
      const dd = Math.hypot(px - s.x, py - s.y);
      if (dd <= s.r && dd < bestD) { best = s.h; bestD = dd; }
    }
    return best;
  }

  function hitAt(px, py) {
    // Nearest first: the badges were drawn far to near, so the last one
    // drawn is the one on top, and that is the one under the pointer.
    for (let i = badgeRects.length - 1; i >= 0; i--) {
      const b = badgeRects[i];
      const r = b.rect;
      if (px >= r.x - 3 && px <= r.x + r.w + 3 && py >= r.y - 3 && py <= r.y + r.h + 3) return { kind: 'seam', id: b.id };
    }
    return hitGround(px, py);
  }

  // A click is one pointer, pressed and let go within a few pixels and a
  // moment; anything else is the controls' (an orbit, a pan, a pinch) or
  // the tool's (a stroke, a drag).
  let down = null;
  let pendingMove = null;
  const pressed = new Set();
  const pos = (ev) => { const r = canvas.getBoundingClientRect(); return { x: ev.clientX - r.left, y: ev.clientY - r.top }; };
  const stepMM = () => Math.max(0.8, (tool?.radiusMM || 10) * 0.18);

  canvas.addEventListener('pointerdown', (ev) => {
    pressed.add(ev.pointerId);
    pendingMove = null; // a hover queued before the press is stale now
    const p = pos(ev);
    down = pressed.size === 1 ? { ...p, at: performance.now(), button: ev.button, id: ev.pointerId } : null;
    if (!down || ev.button !== 0) { if (stroke) { stroke = null; drawTrail(); } return; }
    if (tool?.kind === 'select') {
      const hd = hitHandleAt(p.x, p.y);
      if (hd) {
        dragging = { h: hd, id: ev.pointerId, last: null };
        controls.enabled = false;
        canvas.setPointerCapture(ev.pointerId);
        onHover(null, 0, 0, true);
        invalidate();
      }
    } else if (tool?.kind === 'brush') {
      const g = hitGround(p.x, p.y);
      if (g) {
        stroke = { id: ev.pointerId, pts: [{ x: g.x, y: g.y, z: g.z }] };
        canvas.setPointerCapture(ev.pointerId);
        onHover(null, 0, 0, true);
        drawTrail();
      }
    }
  });

  canvas.addEventListener('pointermove', (ev) => {
    const p = pos(ev);
    if (dragging && ev.pointerId === dragging.id) {
      const g = hitGround(p.x, p.y);
      if (g) { dragging.last = g; onHandle(dragging.h, g, 'move'); }
      return;
    }
    if (stroke && ev.pointerId === stroke.id) {
      const g = hitGround(p.x, p.y);
      if (g) {
        const last = stroke.pts[stroke.pts.length - 1];
        if (Math.hypot(g.x - last.x, g.y - last.y) >= stepMM()) { stroke.pts.push({ x: g.x, y: g.y, z: g.z }); drawTrail(); }
        placeCursor(g.x, g.y);
      }
      return;
    }
    if (ev.buttons) { onHover(null, 0, 0, true); return; }
    if (!pendingMove) {
      requestAnimationFrame(() => {
        const m = pendingMove;
        pendingMove = null;
        if (!m || disposed) return;
        if (tool?.kind === 'brush') {
          const g = hitGround(m.x, m.y);
          placeCursor(g ? g.x : null, g ? g.y : null);
          onHover(g, m.x, m.y, false);
          return;
        }
        if (tool?.kind === 'select') {
          const hd = hitHandleAt(m.x, m.y);
          if ((hd?.key ?? null) !== hoverHandle) { hoverHandle = hd?.key ?? null; invalidate(); }
          if (hd) { onHover({ kind: 'handle', h: hd, id: hd.key }, m.x, m.y, false); return; }
        }
        onHover(hitAt(m.x, m.y), m.x, m.y, false);
      });
    }
    pendingMove = p;
  });

  canvas.addEventListener('pointerup', (ev) => {
    pressed.delete(ev.pointerId);
    const p = pos(ev);
    if (dragging && ev.pointerId === dragging.id) {
      const g = hitGround(p.x, p.y) || dragging.last;
      const h = dragging.h;
      dragging = null;
      controls.enabled = true;
      onHandle(h, g, 'end');
      down = null;
      invalidate();
      return;
    }
    if (stroke && ev.pointerId === stroke.id) {
      const pts = stroke.pts;
      stroke = null;
      drawTrail();
      down = null;
      onStroke(pts);
      return;
    }
    const click = down && down.id === ev.pointerId && down.button === 0 && Math.hypot(p.x - down.x, p.y - down.y) < 5
      && performance.now() - down.at < 600;
    down = null;
    if (!click) return;
    if (tool?.kind === 'place') {
      const g = hitGround(p.x, p.y);
      if (g) onPlace(g);
      return;
    }
    onPick(hitAt(p.x, p.y), p.x, p.y);
  });

  canvas.addEventListener('pointercancel', (ev) => {
    pressed.delete(ev.pointerId);
    down = null;
    if (stroke) { stroke = null; drawTrail(); }
    if (dragging) { const h = dragging.h; const last = dragging.last; dragging = null; controls.enabled = true; if (last) onHandle(h, last, 'end'); }
  });
  canvas.addEventListener('pointerleave', () => {
    pendingMove = null;
    if (!stroke && !dragging) { placeCursor(null, null); onHover(null, 0, 0, true); }
  });
  canvas.addEventListener('dblclick', (ev) => {
    if (tool && tool.kind !== 'select') return;
    const p = pos(ev);
    const hit = hitAt(p.x, p.y);
    if (hit?.kind === 'tile') focusTile(hit.id);
  });
  canvas.addEventListener('contextmenu', (ev) => ev.preventDefault());

  /** Drop a stroke or a drag in progress, as Escape does. */
  function cancelGesture() {
    if (stroke) { stroke = null; drawTrail(); }
    if (dragging) { dragging = null; controls.enabled = true; invalidate(); }
  }

  /* --------------------------------------------------------------- loop */

  let lastW = 0;
  let lastH = 0;
  function resize() {
    const w = canvas.clientWidth || 1;
    const h = canvas.clientHeight || 1;
    lastW = w; lastH = h;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    invalidate();
  }

  // Quick mode: what a machine that cannot draw the full board at an
  // interactive rate draws while the camera is moving. The measure is the
  // interval between frames drawn on CONSECUTIVE ticks because the camera
  // moved: that is the machine's own pace. Two redraws a while apart -- a
  // hover, a turn -- say nothing about it, and nor does a pointer that only
  // moves every tenth of a second.
  function setQuick(on) {
    if (on === quick) return;
    quick = on;
    renderer.setPixelRatio(on ? basePixelRatio * 0.5 : basePixelRatio);
    if (model) for (const t of model.tiles.values()) t.ground.geometry.setDrawRange(...t.ground.userData.ranges[on ? 'quick' : 'full']);
  }

  let drewLastTick = false;
  function tick(now) {
    if (disposed) return;
    requestAnimationFrame(tick);
    // Nowhere to see it: the pane is hidden. Come back to a full frame.
    if (canvas.clientWidth === 0 || canvas.clientHeight === 0) {
      drewLastTick = false;
      if (quick) { setQuick(false); needsRender = true; }
      return;
    }
    if (canvas.clientWidth !== lastW || canvas.clientHeight !== lastH) resize();
    let moving = false;
    if (fly) {
      const u = Math.min(1, (now - fly.t0) / fly.ms);
      const e = u * u * (3 - 2 * u);
      controls.target.lerpVectors(fly.fromTarget, fly.toTarget, e);
      camera.position.lerpVectors(fly.fromPos, fly.toPos, e);
      if (u >= 1) fly = null;
      moving = true;
    }
    // With damping on, update() keeps the camera settling for a few frames
    // after the pointer stops.
    controls.update();
    if (cameraMoved()) moving = true;
    if (moving) needsRender = true;
    if (!needsRender) {
      drewLastTick = false;
      // Stopped: one full frame, so what is left on screen is the real thing.
      if (quick && now - lastRenderAt > SETTLE_MS) { setQuick(false); needsRender = true; }
      else return;
    }
    needsRender = false;
    const since = now - lastRenderAt;
    interval = moving && drewLastTick ? (interval ? interval * 0.6 + since * 0.4 : since) : 0;
    if (!quick && interval > SLOW_FRAME_MS) setQuick(true);
    drewLastTick = true;
    lastRenderAt = now;
    drawnFrom.pos.copy(camera.position);
    drawnFrom.target.copy(controls.target);
    const t0 = performance.now();
    renderer.render(scene, camera);
    drawOverlay();
    const t1 = performance.now();
    frames++;
    if (quick) quickFrames++;
    if (model && firstFrameAt === null) firstFrameAt = t1;
    renderMS.push(t1 - t0);
    frameTimes.push(t1);
    if (renderMS.length > 240) { renderMS.shift(); frameTimes.shift(); }
  }

  applyTheme();
  resize();
  requestAnimationFrame(tick);

  return {
    setTiles,
    setBoard,
    setTool,
    setHandles,
    updateHeights,
    cancelGesture,
    setTheme: (t) => { th = t; applyTheme(); },
    resize,
    reframe,
    focusTile,
    zoomBy,
    redraw: invalidate,
    hasModel: () => !!model,
    payload: () => model?.payload ?? null,
    /** For the browser test and the console: the camera and its controls. */
    debug: { camera, controls, invalidate },
    /** Where a board point (mm, z up from the table) is on the canvas, in CSS px. */
    project: (x, y, z) => {
      root.updateMatrixWorld(true);
      const p = toScreen(new THREE.Vector3(x, y, z), canvas.clientWidth, canvas.clientHeight);
      return { x: p.x, y: p.y };
    },
    /** The top of the ground at a board point, on whichever tile is there, turned as it is. */
    heightAt: (x, y) => groundAt(x, y)?.z ?? null,
    /** For the browser test: what is drawn, and how fast. */
    stats: () => ({
      frames,
      quickFrames,
      quick,
      software,
      firstFrameAt,
      renderMS: renderMS.slice(),
      frameTimes: frameTimes.slice(),
      tiles: model ? model.tiles.size : 0,
      triangles: renderer.info.render.triangles,
      water: model ? Object.fromEntries([...model.tiles.values()].map((t) => [t.h.label, t.waterTris])) : {},
      turned: model ? Object.fromEntries([...model.tiles.values()].map((t) => [t.h.label, t.rot])) : {},
      badges: badgeRects.map((b) => ({ id: b.id, x: b.rect.x + b.rect.w / 2, y: b.rect.y + b.rect.h / 2 })),
      handles: handleSpots.map((s) => ({ key: s.h.key, x: s.x, y: s.y })),
      bands: model ? [...model.tiles.values()].filter((t) => t.band).length : 0,
      cursor: cursor.visible,
      tool: tool?.kind ?? null,
      camera: camera.position.toArray(),
    }),
    dispose() {
      disposed = true;
      disposeModel();
      for (const m of Object.values(mat)) m.dispose();
      table.geometry.dispose();
      cursorGeo.dispose();
      trailGeo.dispose();
      controls.dispose();
      renderer.dispose();
    },
  };
}
