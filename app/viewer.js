// viewer.js — the grown module in 3D. Browser only.
//
// One renderer, orbit controls, drawn only when something has changed, and
// the model built z-up (the printer's convention, and the library's) then
// tipped into three.js's y-up world, so every coordinate in here is a
// module millimetre.
//
// What it draws is the module as printed: the ground, its walls down to
// the table, a line round the rim, and the water the module holds -- in
// its channels, its lakes and its spring pools. The ground comes from the
// worker as one Float32Array of heights (see heights.js), and the geometry
// is built straight from it: no STL, no triangle soup.
//
// In Refine it also takes tools: a brush that paints a stroke along the
// ground (the left button paints, the right one orbits), a click that
// places something, and handles to drag. It draws the band round the rim
// where a stroke fades out, and a cursor showing how much of the brush
// lands where -- the same weights lib/edits.js replays.

import * as THREE from 'three';
import { OrbitControls } from '../lib/vendor/OrbitControls.js';
import { falloff, rimWeight } from '../lib/edits.js';
import * as H from './heights.js';

const CURSOR_SIDE = 29; // samples a side of the brush cursor

/** CSS colour to a THREE.Color, falling back when a custom property is missing. */
function colour(css, fallback = '#888888') {
  const c = new THREE.Color();
  try { c.setStyle(css || fallback); } catch { c.setStyle(fallback); }
  return c;
}

/** sRGB components (0..1) into the linear space vertex colours are read in. */
const toLinear = (v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);

/** Whether the browser is drawing WebGL on the CPU, which gets no multisampling. */
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
// quick mode -- half the pixels, a quarter of the ground's triangles --
// until it stops, when one full frame is drawn.
const SLOW_FRAME_MS = 45;
const SETTLE_MS = 280;

/** How each kind of handle is drawn: a fill and a letter. */
const HANDLE_LOOK = {
  lake: { fill: 'water', glyph: 'L' },
  springpoint: { fill: 'spring', glyph: 'S' },
  volcano: { fill: 'dam', glyph: 'V' },
  spine: { fill: 'ridge', glyph: '' },
  flat: { fill: 'cliff', glyph: 'F' },
  'channel-vertex': { fill: 'water', glyph: '' },
};

/**
 * Make a viewer on `canvas`, with `overlay` (a 2D canvas the same size, on
 * top, pointer-transparent) for the handles and marks.
 *
 *   onHover(hit, px, py, busy)  the pointer moved; hit is the ground or null
 *   onPick(hit)                 a click that was not the end of an orbit
 *   onStroke(points)            a brushstroke ended: [{ x, y, z }] in module mm
 *   onPlace(hit)                a click with the place tool, on the ground
 *   onHandle(handle, at, phase) a handle: 'move' and 'end' as it is dragged,
 *                               'click' if it was only clicked, 'cancel' if dropped
 *
 * Throws if WebGL cannot be had; the caller falls back to the flat canvas.
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
  camera.position.set(100, 300, 400);

  const controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true;
  controls.dampingFactor = 0.16;
  controls.maxPolarAngle = Math.PI / 2 - 0.04; // never under the table
  controls.zoomToCursor = true;
  const ORBIT_BUTTONS = { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.PAN };
  const ORBIT_TOUCHES = { ONE: THREE.TOUCH.ROTATE, TWO: THREE.TOUCH.DOLLY_PAN };
  const BRUSH_BUTTONS = { LEFT: -1, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.ROTATE };
  const BRUSH_TOUCHES = { ONE: -1, TWO: THREE.TOUCH.DOLLY_ROTATE };

  let needsRender = true;
  const invalidate = () => { needsRender = true; };
  const drawnFrom = { pos: new THREE.Vector3(Infinity, 0, 0), target: new THREE.Vector3() };
  const cameraMoved = () => {
    const visible = camera.position.distanceTo(controls.target) * 2e-4;
    return camera.position.distanceTo(drawnFrom.pos) > visible || controls.target.distanceTo(drawnFrom.target) > visible;
  };

  scene.add(new THREE.HemisphereLight(0xeef2ff, 0x3a3326, 1.45));
  const key = new THREE.DirectionalLight(0xffffff, 2.0);
  key.position.set(-0.6, 1.6, -0.5); // from the north-west, as the hillshade is lit
  scene.add(key);
  const fill = new THREE.DirectionalLight(0xc9d6ff, 0.55);
  fill.position.set(1.2, 0.7, 1.4);
  scene.add(fill);

  // The module is built z-up; tip it into three.js's y-up world.
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
  raycaster.layers.set(1); // the pick proxy lives on layer 1, which the camera never draws

  let model = null; // { T, h, group, span, payload, ground, walls, rim, proxy, water, band }
  let framedFor = null;
  let marks = []; // polylines in module mm to draw on the overlay: [{ pts: [[x, y]], color }]
  let handleSpots = [];
  let disposed = false;
  let firstFrameAt = null;
  const frameTimes = [];
  const renderMS = [];
  let frames = 0;
  let quick = false;
  let quickFrames = 0;
  let lastRenderAt = 0;
  let interval = 0;

  let tool = null;
  let handles = [];
  let stroke = null;
  let dragging = null;
  let controlsOffTillUp = false;
  let cursorAt = null;
  let hoverHandle = null;
  const rimMaterial = new THREE.LineBasicMaterial({ transparent: true });

  function applyTheme() {
    scene.background = colour(th.canvas, '#e9e7e0');
    mat.table.color = colour(th.grid, '#d6d2c7');
    mat.walls.color = colour('#857a66');
    mat.water.color = colour(th.water, '#2f7fd8');
    mat.trail.color = colour(th.select, '#2b6cb0');
    rimMaterial.color = colour(th.edge, '#6b6455');
    rimMaterial.opacity = 0.75;
    if (model) fillBand();
    invalidate();
  }

  /* -------------------------------------------------------------- model */

  function geometry(arrays, colorSize = 3) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(arrays.position, 3));
    if (arrays.normal) g.setAttribute('normal', new THREE.BufferAttribute(arrays.normal, 3));
    if (arrays.color) g.setAttribute('color', new THREE.BufferAttribute(arrays.color, colorSize));
    if (arrays.index) g.setIndex(new THREE.BufferAttribute(arrays.index, 1));
    g.computeBoundingSphere();
    return g;
  }

  const drop = (name) => {
    const o = model?.[name];
    if (!o) return;
    model.group.remove(o);
    o.geometry.dispose();
    model[name] = null;
  };

  function disposeModel() {
    if (!model) return;
    for (const name of ['ground', 'walls', 'rim', 'proxy', 'water', 'band']) drop(name);
    root.remove(model.group);
    model = null;
  }

  /** The module's meshes, made from its heights: built when grown, and again when a stroke is previewed. */
  function fillModel() {
    for (const name of ['ground', 'walls', 'rim', 'proxy', 'water']) drop(name);
    const h = model.h;
    const span = model.span;
    const tint = (kind, z) => H.groundColour(kind, (z - span.lo) / (span.hi - span.lo)).map(toLinear);
    const arrays = H.groundArrays(h, tint);
    const coarse = H.gridIndex(h.nx, h.ny, 2);
    const both = new arrays.index.constructor(arrays.index.length + coarse.length);
    both.set(arrays.index, 0);
    both.set(coarse, arrays.index.length);
    model.ground = new THREE.Mesh(geometry({ ...arrays, index: both }), mat.ground);
    model.ground.userData.ranges = { full: [0, arrays.index.length], quick: [arrays.index.length, coarse.length] };
    model.ground.geometry.setDrawRange(...model.ground.userData.ranges[quick ? 'quick' : 'full']);
    model.group.add(model.ground);
    model.walls = new THREE.Mesh(geometry(H.wallArrays(h)), mat.walls);
    model.group.add(model.walls);
    model.rim = new THREE.LineLoop(geometry(H.rimLine(h)), rimMaterial);
    model.group.add(model.rim);
    model.proxy = new THREE.Mesh(geometry(H.proxyArrays(h)), mat.ground);
    model.proxy.layers.set(1);
    model.group.add(model.proxy);
    const water = H.waterArrays(h, H.waterSurface(h));
    model.waterTris = water.triangles;
    if (water.triangles) {
      model.water = new THREE.Mesh(geometry(water), mat.water);
      model.water.renderOrder = 1;
      model.group.add(model.water);
    }
    fillBand();
  }

  /** The band round the rim where a stroke fades out, shown while a brush is in hand. */
  function fillBand() {
    drop('band');
    if (!model || !(tool?.kind === 'brush' && tool.lockMM > 0)) return;
    const c = colour(th.dam, '#c2412d');
    model.band = new THREE.Mesh(geometry(H.lockBandArrays(model.h, tool.lockMM, [c.r, c.g, c.b], { alpha: 0.42 }), 4), mat.band);
    model.band.renderOrder = 2;
    model.group.add(model.band);
  }

  /** The grown module, as the worker sent it: { contract: { tileMM }, tile: heights }. */
  function setTile(payload) {
    disposeModel();
    if (!payload || !payload.tile) { invalidate(); return; }
    const T = payload.contract.tileMM;
    const group = new THREE.Group();
    root.add(group);
    model = { T, h: payload.tile, group, span: H.heightSpan(payload.tile), payload, ground: null, walls: null, rim: null, proxy: null, water: null, band: null, waterTris: 0 };
    fillModel();
    table.scale.set(T * 3, T * 3, 1);
    table.position.set(T / 2, T / 2, -0.4);
    firstFrameAt = null;
    // A regrow of the same module keeps the camera where it was: in Refine
    // that is every stroke, and the view should not jump after each one.
    if (framedFor !== T) reframe();
    framedFor = T;
    invalidate();
  }

  /** New heights before the build has caught up: a stroke previewed on the ground as it stands. */
  function updateHeights(heights) {
    if (!model || heights.length !== model.h.heights.length) return;
    model.h = { ...model.h, heights };
    fillModel();
    invalidate();
  }

  /** The height of the ground at a module point. */
  function groundAt(x, y) {
    if (!model) return null;
    const T = model.T;
    if (x < 0 || y < 0 || x > T || y > T) return null;
    return { z: H.sampleHeight(model.h, x, y), local: { x, y } };
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
    handleSpots = [];
    if (!model) return;
    const v = new THREE.Vector3();
    // Marks: a selected channel's line, drawn a hair over the ground.
    for (const m of marks) {
      octx.strokeStyle = m.color || th.select;
      octx.lineWidth = 2;
      octx.setLineDash(m.dashed ? [5, 4] : []);
      octx.beginPath();
      let first = true;
      for (const [x, y] of m.pts) {
        const g = groundAt(x, y);
        if (!g) continue;
        const p = toScreen(v.set(x, y, g.z + 1), w, h);
        if (first) octx.moveTo(p.x, p.y); else octx.lineTo(p.x, p.y);
        first = false;
      }
      octx.stroke();
      octx.setLineDash([]);
    }
    if (tool?.kind === 'select') {
      for (const hd of handles) {
        const g = groundAt(hd.x, hd.y);
        if (!g) continue;
        const p = toScreen(v.set(hd.x, hd.y, g.z + 1.5), w, h);
        if (p.z > 1 || p.z < -1) continue;
        const look = HANDLE_LOOK[hd.kind] || { fill: 'accent', glyph: '' };
        const on = dragging?.h.key === hd.key || hoverHandle === hd.key;
        const r = hd.kind === 'spine' || hd.kind === 'channel-vertex' ? 6 : 8;
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

  /** The brush cursor: a patch of ground as wide as the brush, tinted by how much of a stroke lands at each point. */
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
        const wgt = g ? falloff(Math.hypot(px - x, py - y) / R) * rimWeight(px, py, T, tool.lockMM) : 0;
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

  /** What to do with the pointer: null to orbit and pick, or a brush, a place tool or the select tool with handles. */
  function setTool(next) {
    const was = tool;
    tool = next || null;
    const brushy = tool && (tool.kind === 'brush' || tool.kind === 'place');
    Object.assign(controls.mouseButtons, brushy ? BRUSH_BUTTONS : ORBIT_BUTTONS);
    Object.assign(controls.touches, brushy ? BRUSH_TOUCHES : ORBIT_TOUCHES);
    const bandWas = was?.kind === 'brush' ? was.lockMM : 0;
    const bandNow = tool?.kind === 'brush' ? tool.lockMM : 0;
    if (model && bandWas !== bandNow) fillBand();
    if (tool?.kind !== 'brush') cursor.visible = false;
    else if (cursorAt) placeCursor(cursorAt.x, cursorAt.y);
    if (tool?.kind !== 'select') hoverHandle = null;
    stroke = null;
    drawTrail();
    invalidate();
  }

  /** The things the select tool can drag, in module mm: [{ key, kind, index, vertex?, x, y }]. */
  function setHandles(list) {
    handles = list || [];
    invalidate();
  }

  /** Lines to draw over the ground: [{ pts: [[x, y], ...], color, dashed }]. */
  function setMarks(list) {
    marks = list || [];
    invalidate();
  }

  /* ------------------------------------------------------------ camera */

  /** Put the module in view, from the south and a little east, looking down at it. */
  function reframe() {
    if (canvas.clientWidth && canvas.clientHeight && (canvas.clientWidth !== lastW || canvas.clientHeight !== lastH)) resize();
    root.updateMatrixWorld(true);
    if (!model) return;
    const box = new THREE.Box3().expandByObject(model.group);
    if (box.isEmpty()) return;
    const sphere = box.getBoundingSphere(new THREE.Sphere());
    const vFov = (camera.fov * Math.PI) / 180;
    const hFov = 2 * Math.atan(Math.tan(vFov / 2) * camera.aspect);
    const distance = (sphere.radius / Math.sin(Math.min(vFov, hFov) / 2)) * 1.02;
    controls.target.copy(sphere.center);
    const dir = new THREE.Vector3(0.32, 0.92, 1).normalize();
    camera.position.copy(sphere.center).addScaledVector(dir, distance);
    camera.near = Math.max(1, distance / 400);
    camera.far = distance * 12;
    camera.updateProjectionMatrix();
    controls.maxDistance = distance * 4;
    controls.minDistance = 20;
    controls.update();
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
   * The ground under a screen point: the coarse proxy finds it, then a
   * short march along the ray against the full heights finds the point, so
   * a stroke lands where the pointer is on a steep slope too.
   */
  function hitGround(px, py) {
    if (!model) return null;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    root.updateMatrixWorld(true);
    raycaster.setFromCamera(new THREE.Vector2((px / w) * 2 - 1, -(py / h) * 2 + 1), camera);
    const hit = raycaster.intersectObject(model.proxy, false)[0];
    if (!hit) return null;
    const o = root.worldToLocal(raycaster.ray.origin.clone());
    const d = root.worldToLocal(raycaster.ray.origin.clone().add(raycaster.ray.direction)).sub(o);
    const at = (s) => ({ x: o.x + d.x * s, y: o.y + d.y * s, z: o.z + d.z * s });
    const above = (s) => { const p = at(s); const g = groundAt(p.x, p.y); return g ? p.z - g.z : 1; };
    let s0 = hit.distance - 12;
    let s1 = hit.distance + 12;
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
    const g = groundAt(p.x, p.y) || { z: p.z, local: { x: Math.max(0, Math.min(model.T, p.x)), y: Math.max(0, Math.min(model.T, p.y)) } };
    return { kind: 'tile', x: g.local.x, y: g.local.y, z: g.z, localX: g.local.x, localY: g.local.y };
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

  let down = null;
  let pendingMove = null;
  const pressed = new Set();
  const pos = (ev) => { const r = canvas.getBoundingClientRect(); return { x: ev.clientX - r.left, y: ev.clientY - r.top }; };
  const stepMM = () => Math.max(0.8, (tool?.radiusMM || 10) * 0.18);

  canvas.addEventListener('pointerdown', (ev) => {
    pressed.add(ev.pointerId);
    pendingMove = null;
    const p = pos(ev);
    down = pressed.size === 1 ? { ...p, at: performance.now(), button: ev.button, id: ev.pointerId } : null;
    if (!down || ev.button !== 0) { if (stroke) { stroke = null; drawTrail(); } return; }
    if (tool?.kind === 'select') {
      const hd = hitHandleAt(p.x, p.y);
      if (hd) {
        const g = hitGround(p.x, p.y);
        dragging = { h: hd, id: ev.pointerId, last: null, moved: false, from: p, offset: g ? { x: hd.x - g.x, y: hd.y - g.y } : { x: 0, y: 0 } };
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
      if (!dragging.moved && Math.hypot(p.x - dragging.from.x, p.y - dragging.from.y) < 4) return;
      dragging.moved = true;
      const g = hitGround(p.x, p.y);
      if (g) {
        dragging.last = { x: g.x + dragging.offset.x, y: g.y + dragging.offset.y };
        onHandle(dragging.h, dragging.last, 'move');
      }
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
        onHover(hitGround(m.x, m.y), m.x, m.y, false);
      });
    }
    pendingMove = p;
  });

  canvas.addEventListener('pointerup', (ev) => {
    pressed.delete(ev.pointerId);
    const p = pos(ev);
    if (controlsOffTillUp && !pressed.size) { controlsOffTillUp = false; controls.enabled = true; }
    if (dragging && ev.pointerId === dragging.id) {
      const { h, moved, last } = dragging;
      dragging = null;
      controls.enabled = true;
      if (!moved) onHandle(h, null, 'click');
      else onHandle(h, last, 'end');
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
    const click = down && down.id === ev.pointerId && down.button === 0 && Math.hypot(p.x - down.x, p.y - down.y) < 5 && performance.now() - down.at < 600;
    down = null;
    if (!click) return;
    if (tool?.kind === 'place') {
      const g = hitGround(p.x, p.y);
      if (g) onPlace(g);
      return;
    }
    onPick(hitGround(p.x, p.y), p.x, p.y);
  });

  canvas.addEventListener('pointercancel', (ev) => {
    pressed.delete(ev.pointerId);
    down = null;
    if (stroke) { stroke = null; drawTrail(); }
    if (dragging) { const h = dragging.h; dragging = null; controls.enabled = true; onHandle(h, null, 'cancel'); }
    if (controlsOffTillUp && !pressed.size) { controlsOffTillUp = false; controls.enabled = true; }
  });
  canvas.addEventListener('pointerleave', () => {
    pendingMove = null;
    if (!stroke && !dragging) { placeCursor(null, null); onHover(null, 0, 0, true); }
  });
  canvas.addEventListener('dblclick', () => { if (!tool || tool.kind === 'select') reframe(); });
  canvas.addEventListener('contextmenu', (ev) => ev.preventDefault());

  /** Drop a stroke or a drag in progress, as Escape does. A dropped drag is reported, so whatever it moved can be put back. */
  function cancelGesture() {
    down = null;
    if (stroke) { stroke = null; drawTrail(); }
    if (dragging) {
      const h = dragging.h;
      dragging = null;
      controlsOffTillUp = pressed.size > 0;
      if (!controlsOffTillUp) controls.enabled = true;
      invalidate();
      onHandle(h, null, 'cancel');
    }
  }

  /** The bare ground near a point: where trees stand, the nearest cell not under a crown, so a flatten begun in a wood levels the ground. */
  function bareAt(x, y, searchMM = 10) {
    const g = groundAt(x, y);
    if (!g) return null;
    const h = model.h;
    const i0 = Math.round(x / h.step);
    const j0 = Math.round(y / h.step);
    const k0 = Math.min(h.ny - 1, Math.max(0, j0)) * h.nx + Math.min(h.nx - 1, Math.max(0, i0));
    if (h.kind[k0] !== H.WOOD) return g.z;
    const r = Math.ceil(searchMM / h.step);
    let best = null;
    let bestD = Infinity;
    for (let j = Math.max(0, j0 - r); j <= Math.min(h.ny - 1, j0 + r); j++) {
      for (let i = Math.max(0, i0 - r); i <= Math.min(h.nx - 1, i0 + r); i++) {
        const k = j * h.nx + i;
        if (h.kind[k] === H.WOOD) continue;
        const d = Math.hypot(i - i0, j - j0);
        if (d < bestD) { bestD = d; best = h.heights[k]; }
      }
    }
    return best === null ? g.z : best;
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

  function setQuick(on) {
    if (on === quick) return;
    quick = on;
    renderer.setPixelRatio(on ? basePixelRatio * 0.5 : basePixelRatio);
    if (model?.ground) model.ground.geometry.setDrawRange(...model.ground.userData.ranges[on ? 'quick' : 'full']);
  }

  let drewLastTick = false;
  function tick(now) {
    if (disposed) return;
    requestAnimationFrame(tick);
    if (canvas.clientWidth === 0 || canvas.clientHeight === 0) {
      drewLastTick = false;
      if (quick) { setQuick(false); needsRender = true; }
      return;
    }
    if (canvas.clientWidth !== lastW || canvas.clientHeight !== lastH) resize();
    controls.update();
    const moving = cameraMoved();
    if (moving) needsRender = true;
    if (!needsRender) {
      drewLastTick = false;
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
    setTile,
    setTool,
    setHandles,
    setMarks,
    updateHeights,
    cancelGesture,
    setTheme: (t) => { th = t; applyTheme(); },
    resize,
    reframe,
    zoomBy,
    redraw: invalidate,
    hasModel: () => !!model,
    payload: () => model?.payload ?? null,
    debug: { camera, controls, invalidate },
    project: (x, y, z) => {
      root.updateMatrixWorld(true);
      const p = toScreen(new THREE.Vector3(x, y, z), canvas.clientWidth, canvas.clientHeight);
      return { x: p.x, y: p.y };
    },
    heightAt: (x, y) => groundAt(x, y)?.z ?? null,
    bareAt,
    stats: () => ({
      frames, quickFrames, quick, software, firstFrameAt,
      renderMS: renderMS.slice(), frameTimes: frameTimes.slice(),
      triangles: renderer.info.render.triangles,
      waterTris: model ? model.waterTris : 0,
      handles: handleSpots.map((s) => ({ key: s.h.key, x: s.x, y: s.y })),
      band: !!model?.band,
      cursor: cursor.visible,
      tool: tool?.kind ?? null,
      camera: camera.position.toArray(),
    }),
    dispose() {
      disposed = true;
      disposeModel();
      for (const m of Object.values(mat)) m.dispose();
      rimMaterial.dispose();
      table.geometry.dispose();
      cursorGeo.dispose();
      trailGeo.dispose();
      controls.dispose();
      renderer.dispose();
    },
  };
}
