// inspector.js — the parameters of what is selected, and nothing else.
//
// Nothing selected is the map itself: its seed and scale, the ground, the
// ice, the water, the woods that cover it all and the contract. Every field
// writes the spec through the api and reads back from it, so the JSON drawer
// and the board change with it. A field left empty is a key taken out: the
// default, as the CLI would read it.

import { EDGES, SIZES, FALLS, portFloor, sizeFor, makeContract } from '../lib/contract.js';
import { LAKE_DEFAULTS, PROFILES } from '../lib/lake.js';
import { FOUNTAIN_DEFAULTS } from '../lib/fountain.js';
import { CANOPY_DEFAULTS } from '../lib/canopy.js';
import { facingEdge } from '../lib/board.js';
import * as ops from './specops.js';

const SIZE_IDS = Object.keys(SIZES);
const SIDE = { N: 'north', E: 'east', S: 'south', W: 'west' };

/* ------------------------------------------------------------------ dom */

function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'text') el.textContent = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid === null || kid === undefined || kid === false) continue;
    el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  return el;
}

/** A number field. `get` reads the spec; `set(spec, value|undefined)` writes it. */
function num(api, label, { get, set, unit = '', step = 1, min = null, max = null, placeholder = '', id = null, title = null }) {
  const v = get(api.state.spec);
  const input = h('input', {
    type: 'number', step, min, max, placeholder, value: Number.isFinite(v) ? String(v) : '',
    'data-field': id || label, 'aria-label': label, title,
  });
  input.addEventListener('change', () => {
    const raw = input.value.trim();
    let value = raw === '' ? undefined : Number(raw);
    if (value !== undefined && !Number.isFinite(value)) return;
    if (value !== undefined && min !== null) value = Math.max(Number(min), value);
    if (value !== undefined && max !== null) value = Math.min(Number(max), value);
    api.commit((s) => set(s, value), label.toLowerCase());
  });
  return h('label', { class: 'field' }, h('span', {}, label), h('span', { class: 'ctl' }, input, unit ? h('span', { class: 'unit' }, unit) : null));
}

function text(api, label, { get, set, id }) {
  const input = h('input', { type: 'text', value: get(api.state.spec) ?? '', 'data-field': id || label, 'aria-label': label, spellcheck: 'false' });
  input.addEventListener('change', () => api.commit((s) => set(s, input.value.trim() || undefined), label.toLowerCase()));
  return h('label', { class: 'field' }, h('span', {}, label), h('span', { class: 'ctl' }, input));
}

function check(api, label, { get, set, id, title }) {
  const input = h('input', { type: 'checkbox', 'data-field': id || label, title });
  input.checked = !!get(api.state.spec);
  input.addEventListener('change', () => api.commit((s) => set(s, input.checked), label.toLowerCase()));
  return h('label', { class: 'field' }, h('span', {}, label), h('span', { class: 'ctl' }, input));
}

function choose(api, label, { options, get, set, id }) {
  const cur = get(api.state.spec);
  const sel = h('select', { 'data-field': id || label, 'aria-label': label },
    options.map(([v, t]) => h('option', { value: String(v), selected: String(cur ?? '') === String(v) }, t)));
  sel.addEventListener('change', () => api.commit((s) => set(s, sel.value === '' ? undefined : sel.value), label.toLowerCase()));
  return h('label', { class: 'field' }, h('span', {}, label), h('span', { class: 'ctl' }, sel));
}

/** A row of buttons, one of which is current. */
function seg(label, options, current, pick, { wide = false, id = null } = {}) {
  const box = h('span', { class: 'seg', role: 'group', 'aria-label': label, 'data-field': id || label },
    options.map(([v, t]) => h('button', {
      type: 'button', 'aria-pressed': String(String(v) === String(current)),
      onclick: () => pick(v),
    }, t)));
  return h('div', { class: `field${wide ? ' wide' : ''}` }, h('span', {}, label), h('span', { class: 'ctl' }, box));
}

const group = (title, ...kids) => h('fieldset', {}, h('legend', {}, title), ...kids);
const facts = (rows) => h('ul', { class: 'facts' }, rows.filter(Boolean).map(([k, v]) => h('li', {}, h('span', {}, k), h('span', {}, v))));
const del = (label, fn) => h('button', { type: 'button', class: 'danger', onclick: fn }, label);

/* ------------------------------------------------------------- panels */

export function renderInspector(root, api) {
  const st = api.state;
  const sel = st.selection;
  let body;
  try {
    switch (sel?.type) {
      case 'tile': body = tilePanel(api, sel); break;
      case 'river': body = riverPanel(api, sel); break;
      case 'seam': body = seamPanel(api, sel); break;
      case 'spine': body = spinePanel(api); break;
      case 'volcano': body = volcanoPanel(api, sel); break;
      case 'flat': body = flatPanel(api, sel); break;
      case 'lake': body = lakePanel(api, sel); break;
      case 'springpoint': body = springPanel(api, sel); break;
      case 'wood': body = woodPanel(api, sel); break;
      case 'corner': body = cornerPanel(api, sel); break;
      default: body = mapPanel(api);
    }
  } catch (err) {
    // A selection the spec no longer has (undone, deleted in the JSON): show the map.
    console.warn(err);
    body = mapPanel(api);
  }
  const focused = document.activeElement?.closest?.('#inspector') ? document.activeElement.getAttribute('data-field') : null;
  root.replaceChildren(h('div', { class: 'insp' }, body));
  if (focused) root.querySelector(`[data-field="${CSS.escape(focused)}"]`)?.focus();
}

function mapPanel(api) {
  const s = api.state.spec;
  const { cols, rows, T } = ops.dims(s);
  const c = makeContract(s.contract || {});
  const p = api.state.plan;
  const springs = p.springs.length;
  return [
    h('h2', {}, s.name || 'Untitled map'),
    h('p', { class: 'sub' }, `${cols} × ${rows} tiles of ${T} mm, on ${c.plateMM} mm plates. Nothing selected, so this is the map.`),
    group('Map',
      text(api, 'Name', { get: (x) => x.name, set: (x, v) => { if (v === undefined) delete x.name; else x.name = v; } }),
      h('div', { class: 'field' }, h('span', {}, 'Seed'), h('span', { class: 'ctl' },
        numInput(api, 'Seed', (x) => x.seed, (x, v) => { x.seed = v ?? 1; }, { step: 1, min: 0 }),
        h('button', { type: 'button', class: 'mini', title: 'A different map, same rules', onclick: () => api.commit((x) => { x.seed = Math.floor(Math.random() * 100000); }, 'roll the seed') }, 'Roll'))),
      num(api, 'Relief', { get: (x) => x.reliefMM, set: (x, v) => { x.reliefMM = v; }, unit: 'mm', min: 5, max: 200, placeholder: '40', title: 'The height the whole world maps onto, on the print' }),
    ),
    group('Ground',
      num(api, 'World size', { get: (x) => (x.worldSizeM ? x.worldSizeM / 1000 : undefined), set: (x, v) => { if (v === undefined) delete x.worldSizeM; else x.worldSizeM = Math.round(v * 1000); }, unit: 'km', step: 0.5, min: 1, placeholder: '16' }),
      num(api, 'Mountains', { get: (x) => x.spineHeightM, set: (x, v) => { if (v === undefined) delete x.spineHeightM; else x.spineHeightM = v; }, unit: 'm', step: 50, min: 0, placeholder: '1500', title: 'Peak height on the ridge' }),
      num(api, 'Ridge width', { get: (x) => x.spineWidthM, set: (x, v) => { if (v === undefined) delete x.spineWidthM; else x.spineWidthM = v; }, unit: 'm', step: 100, min: 100, placeholder: String(Math.round((s.worldSizeM || 16000) * 0.22)) }),
      num(api, 'Roughness', { get: (x) => x.roughness, set: (x, v) => { if (v === undefined) delete x.roughness; else x.roughness = v; }, step: 0.02, min: 0, max: 1, placeholder: '0.22' }),
    ),
    group('Ice',
      check(api, 'Glaciate', { get: (x) => x.glacier !== false, set: (x, on) => { x.glacier = on ? (x.glacier && typeof x.glacier === 'object' ? x.glacier : { cycles: 30 }) : false; } }),
      s.glacier !== false ? [
        num(api, 'Cycles', { get: (x) => x.glacier?.cycles, set: (x, v) => ops.setPath(x, 'glacier.cycles', v), min: 1, max: 200, placeholder: 'default' }),
        num(api, 'Snowline swing', { get: (x) => x.glacier?.elaSwingM, set: (x, v) => ops.setPath(x, 'glacier.elaSwingM', v), unit: 'm', step: 50, min: 0, placeholder: '450' }),
        num(api, 'Advances', { get: (x) => x.glacier?.glacialCycles, set: (x, v) => ops.setPath(x, 'glacier.glacialCycles', v), min: 1, max: 12, placeholder: '3' }),
      ] : null,
    ),
    group('Standing water',
      check(api, 'Tarns in hollows', { get: (x) => x.lakes?.fillHollows !== false, set: (x, on) => ops.setPath(x, 'lakes.fillHollows', on) }),
      num(api, 'Depth', { get: (x) => x.lakes?.depthMM, set: (x, v) => ops.setPath(x, 'lakes.depthMM', v), unit: 'mm', step: 0.5, min: 0.5, placeholder: String(LAKE_DEFAULTS.depthMM) }),
      num(api, 'Shore', { get: (x) => x.lakes?.shoreMM, set: (x, v) => ops.setPath(x, 'lakes.shoreMM', v), unit: 'mm', step: 0.5, min: 0, placeholder: String(LAKE_DEFAULTS.shoreMM) }),
      choose(api, 'Bed', { options: [['', 'default (dish)'], ...PROFILES.map((x) => [x, x])], get: (x) => x.lakes?.profile, set: (x, v) => ops.setPath(x, 'lakes.profile', v) }),
    ),
    group('Springs',
      check(api, 'On every open inlet', {
        get: (x) => !!x.fountains && x.fountains.auto !== false,
        set: (x, on) => { x.fountains = { ...(x.fountains || {}), auto: on }; if (on) x.fountains.place = (x.fountains.place || []).filter((sp) => sp.atMM); if (x.fountains.place && !x.fountains.place.length) delete x.fountains.place; },
        title: 'Where a river comes in from nowhere, the pump has to put the water',
      }),
      num(api, 'Tube OD', { get: (x) => x.fountains?.tubeOdMM, set: (x, v) => ops.setPath(x, 'fountains.tubeOdMM', v), unit: 'mm', step: 0.1, min: 3, placeholder: String(FOUNTAIN_DEFAULTS.tubeOdMM) }),
      num(api, 'Pool', { get: (x) => x.fountains?.poolRadiusMM, set: (x, v) => ops.setPath(x, 'fountains.poolRadiusMM', v), unit: 'mm', step: 0.5, min: 5, placeholder: String(FOUNTAIN_DEFAULTS.poolRadiusMM) }),
      h('p', { class: 'hint' }, springs ? `${springs} spring${springs > 1 ? 's' : ''} on the board.` : 'No springs: the rivers are dry until one goes on. Use the spring tool on an open inlet.'),
    ),
    group('Woods over the whole map', woodLayers(api)),
    group('Contract',
      num(api, 'Tile', { get: (x) => x.contract?.tileMM, set: (x, v) => setContract(x, 'tileMM', v), unit: 'mm', step: 10, min: 50, placeholder: String(c.tileMM) }),
      num(api, 'Plate', { get: (x) => x.contract?.plateMM, set: (x, v) => setContract(x, 'plateMM', v), unit: 'mm', step: 1, min: 2, placeholder: String(c.plateMM) }),
      num(api, 'Outlet floor', { get: (x) => x.contract?.outletZMM, set: (x, v) => setContract(x, 'outletZMM', v), unit: 'mm', step: 1, min: 1, placeholder: String(c.outletZMM), title: 'Where the river leaves a tile, above its bottom. The inlet is this plus the fall.' }),
      num(api, 'Land datum', { get: (x) => x.contract?.edgeLandMM, set: (x, v) => setContract(x, 'edgeLandMM', v), unit: 'mm', step: 1, min: 4, placeholder: String(c.edgeLandMM) }),
      h('p', { class: 'hint' }, `A river leaves at ${c.outletZMM} mm and arrives at ${c.outletZMM} + its fall. Every tile reads these, so changing one changes them all.`),
    ),
    designNotes(api),
  ];
}

/** The contract is written whole once it is touched, so the four numbers read together in the JSON. */
function setContract(x, key, v) {
  const d = makeContract({});
  const cur = x.contract || {};
  x.contract = { tileMM: cur.tileMM ?? d.tileMM, plateMM: cur.plateMM ?? d.plateMM, outletZMM: cur.outletZMM ?? d.outletZMM, edgeLandMM: cur.edgeLandMM ?? d.edgeLandMM, ...cur };
  if (v === undefined) delete x.contract[key]; else x.contract[key] = v;
}

function numInput(api, label, get, set, { step = 1, min = null } = {}) {
  const v = get(api.state.spec);
  const input = h('input', { type: 'number', step, min, value: Number.isFinite(v) ? String(v) : '', 'data-field': label, 'aria-label': label });
  input.addEventListener('change', () => {
    const value = input.value.trim() === '' ? undefined : Number(input.value);
    if (value !== undefined && !Number.isFinite(value)) return;
    api.commit((s) => set(s, value), label.toLowerCase());
  });
  return input;
}

function woodLayers(api) {
  const s = api.state.spec;
  const layers = (s.canopy || []).map((l, i) => ({ l, i })).filter(({ l }) => !Array.isArray(l.region));
  const out = layers.map(({ l, i }) => h('div', { class: 'layer' },
    h('div', { class: 'layer-head' }, h('span', {}, l.kind === 'conifer' ? 'Conifers' : 'Broadleaf'), h('span', { class: 'grow' }),
      h('button', { type: 'button', class: 'mini danger', onclick: () => api.commit((x) => { x.canopy.splice(i, 1); ops.tidy(x); }, 'remove a wood') }, 'Remove')),
    woodFields(api, i)));
  out.push(h('div', { class: 'row-btns' },
    h('button', { type: 'button', class: 'mini', onclick: () => api.commit((x) => ops.addWoodLayer(x, 'conifer'), 'add conifers') }, '+ Conifers'),
    h('button', { type: 'button', class: 'mini', onclick: () => api.commit((x) => ops.addWoodLayer(x, 'deciduous'), 'add broadleaf') }, '+ Broadleaf')));
  if (!layers.length) out.unshift(h('p', { class: 'hint' }, 'None yet. A wood drawn on one tile is in that tile’s inspector.'));
  return out;
}

function woodFields(api, i) {
  const at = (k) => (x) => x.canopy?.[i]?.[k];
  const put = (k) => (x, v) => { if (v === undefined) delete x.canopy[i][k]; else x.canopy[i][k] = v; };
  const id = (k) => `canopy.${i}.${k}`;
  return [
    choose(api, 'Kind', { options: [['deciduous', 'broadleaf'], ['conifer', 'conifer']], get: at('kind'), set: put('kind'), id: id('kind') }),
    num(api, 'Crown', { get: at('crownMM'), set: put('crownMM'), unit: 'mm', step: 0.5, min: 2, placeholder: String(CANOPY_DEFAULTS.crownMM), id: id('crownMM') }),
    num(api, 'Height', { get: at('heightMM'), set: put('heightMM'), unit: 'mm', step: 0.5, min: 1, placeholder: String(CANOPY_DEFAULTS.heightMM), id: id('heightMM') }),
    num(api, 'Density', { get: at('density'), set: put('density'), step: 0.01, min: 0.01, max: 1, placeholder: '0.4', id: id('density'), title: 'The fraction of ground under canopy: 0.05 scattered, 0.55 a proper wood, 1 closed' }),
    num(api, 'Lowest', { get: at('minZMM'), set: put('minZMM'), unit: 'mm', step: 1, placeholder: 'any', id: id('minZMM'), title: 'World height, mm' }),
    num(api, 'Treeline', { get: at('maxZMM'), set: put('maxZMM'), unit: 'mm', step: 1, placeholder: 'none', id: id('maxZMM'), title: 'World height, mm' }),
    num(api, 'Thinning', { get: at('thinningMM'), set: put('thinningMM'), unit: 'mm', step: 1, min: 0, placeholder: '0', id: id('thinningMM') }),
    num(api, 'Max slope', { get: at('maxSlopeDeg'), set: put('maxSlopeDeg'), unit: '°', step: 1, min: 0, max: 90, placeholder: 'any', id: id('maxSlopeDeg') }),
  ];
}

function designNotes(api) {
  const d = api.state.plan.design.filter((x) => x.severity === 'error' || x.severity === 'warning');
  if (!d.length) return group('To build it', h('p', { class: 'hint' }, 'Nothing stands in the way of growing this map.'));
  return group('To build it', d.map((x) => h('p', { class: x.severity === 'error' ? 'err-line' : 'warn-line' }, x.message)));
}

/* -------------------------------------------------------------------- tile */

function tilePanel(api, sel) {
  const st = api.state;
  const s = st.spec;
  const p = st.plan.placements.find((q) => q.col === sel.col && q.row === sel.row);
  const t = st.plan.tiles.find((q) => q.col === sel.col && q.row === sel.row);
  if (!p || !t) throw new Error('no such tile');
  const k = ops.keyOf(sel.col, sel.row);
  const c = st.plan.contract;
  const explicit = Number.isFinite(s.levels?.[k]);
  const ports = EDGES.filter((e) => p.tile.edges?.[e] && p.tile.edges[e].type !== 'land');
  const firstIn = EDGES.find((e) => p.tile.edges?.[e]?.type === 'in');
  const said = st.plan.sentences.filter((x) => x.tile === t.id || (x.seam && x.seam.startsWith(`${t.label}|`)) || x.text.startsWith(`${t.label} `) || x.text.startsWith(`${t.label}'s`));
  const { cols, rows } = ops.dims(s);
  const edges = [];
  if (sel.col === 0 || sel.col === cols - 1) edges.push(['col', sel.col === 0 ? 'W' : 'E']);
  if (sel.row === 0 || sel.row === rows - 1) edges.push(['row', sel.row === 0 ? 'S' : 'N']);

  const water = !t.wet ? 'Dry: no water reaches it.'
    : t.overtops ? `Fills to its rim at ${Math.round(t.rimMM)} mm and runs over its ${SIDE[t.overSide]} side.`
      : t.ponds ? `Ponds to ${Math.round(t.levelMM)} mm; its rim holds at ${Math.round(t.rimMM)}.`
        : 'Water runs through it.';

  return [
    h('h2', {}, t.label),
    h('p', { class: 'sub' }, `Stands on ${t.riserMM} mm of plates${t.rot ? `, turned ${t.rot * 90}°` : ''}. ${ports.length ? `Fall ${t.fallMM} mm.` : 'No river.'}`),
    h('p', { class: `say-one${t.overtops ? ' overtops' : t.ponds ? ' dam' : !t.wet ? ' dry' : ''}` }, water),
    said.length ? h('ul', { class: 'said' }, said.slice(0, 5).map((x) => h('li', { class: x.kind }, x.text))) : null,
    group('On the board',
      h('div', { class: 'field' }, h('span', {}, 'Riser'), h('span', { class: 'ctl' },
        h('button', { type: 'button', class: 'mini', 'aria-label': 'One plate lower', onclick: () => api.commit((x) => ops.setRiser(x, sel.col, sel.row, Math.max(0, p.level - 1)), `lower ${t.label}`) }, '−'),
        h('b', { 'data-field': 'riser' }, `${p.level * c.plateMM} mm`),
        h('button', { type: 'button', class: 'mini', 'aria-label': 'One plate higher', onclick: () => api.commit((x) => ops.setRiser(x, sel.col, sel.row, p.level + 1), `raise ${t.label}`) }, '+'),
        h('button', { type: 'button', class: 'mini', disabled: !explicit, title: 'Let the river decide', onclick: () => api.commit((x) => ops.setLevel(x, sel.col, sel.row, null), `riser ${t.label} auto`) }, 'auto'))),
      seg('Turn', [[0, '0°'], [1, '90'], [2, '180'], [3, '270']], t.rot, (v) => api.commit((x) => ops.setRot(x, sel.col, sel.row, v), `turn ${t.label}`)),
      h('p', { class: 'hint' }, 'The riser is part of the design in a map-style spec: the corners and any dam reservoir are cut for it. A turn is only how the piece sits.'),
    ),
    group('Design',
      seg('Fall', [...FALLS.map((f) => [f, String(f)]), ['', 'default']], Number.isFinite(s.falls?.[k]) ? s.falls[k] : '',
        (v) => api.commit((x) => ops.setFall(x, sel.col, sel.row, v === '' ? null : v), `fall ${t.label}`), { wide: true }),
      firstIn ? seg(`Waterfall in at ${firstIn}`, [[0, 'none'], ...[10, 20, 30, 40, 50].map((f) => [f, `+${f}`])], s.waterfalls?.[k] || 0,
        (v) => api.commit((x) => ops.setWaterfall(x, sel.col, sel.row, v || null), `waterfall into ${t.label}`), { wide: true }) : null,
      ports.length ? facts(ports.map((e) => {
        const ed = p.tile.edges[e];
        return [`${SIDE[e]}${t.rot ? ` (faces ${['N', 'E', 'S', 'W'][(EDGES.indexOf(e) + t.rot) % 4]})` : ''}`, `${ed.type} ${sizeFor(ed.size).id} @${portFloor(c, p.tile, ed.type)} mm${ed.drain ? ', drains' : ''}`];
      })) : h('p', { class: 'hint' }, 'All four sides are land. Draw a river across it to give it ports.'),
      facts([['Corners (sw se nw ne)', ['sw', 'se', 'nw', 'ne'].map((q) => Math.round(p.tile.corners[q])).join(' ')], ['Rim, on the table', `${Math.round(t.rimMM)} mm`]]),
    ),
    group('On this tile',
      facts([
        ['Lakes placed', String((s.lakes?.place || []).filter((x) => x.tile === t.label).length)],
        ['Springs at a point', String((s.fountains?.place || []).filter((x) => x.tile === t.label && x.atMM).length)],
        ['Woods drawn', String((s.canopy || []).filter((x) => (x.tiles || []).includes(t.label) && x.region).length)],
      ]),
      h('div', { class: 'row-btns' }, h('button', { type: 'button', class: 'primary', onclick: () => api.openTile(sel.col, sel.row) }, `Open ${t.label}`)),
    ),
    editsGroup(api, t.label),
    edges.length ? group('Remove', h('div', { class: 'row-btns' }, edges.map(([kind, side]) => h('button', {
      type: 'button', class: 'danger',
      onclick: () => { api.commit((x) => ops.shrinkBoard(x, side), `remove a ${kind === 'col' ? 'column' : 'row'}`); api.select(null); },
    }, kind === 'col' ? `Remove column ${t.label.replace(/\d+$/, '')}` : `Remove row ${sel.row + 1}`))),
    h('p', { class: 'hint' }, 'A map-style board is a rectangle, so a tile goes with its row or column. Rivers through it are cut.')) : null,
  ];
}

/**
 * The strokes made on a tile in Refine, oldest first, each one removable.
 * They are replayed in this order every time the tile is grown.
 */
function editsGroup(api, label) {
  const list = (api.state.spec.edits?.[label] || []).filter((e) => e && typeof e === 'object');
  if (!list.length) return null;
  return group(`Edits by hand (${list.length})`,
    h('ol', { class: 'edit-list' }, list.map((e, i) => h('li', {},
      h('span', {}, ops.describeEdit(e)),
      h('button', {
        type: 'button', class: 'mini', title: 'Take this edit off', 'aria-label': `Remove edit ${i + 1}`, 'data-edit': String(i),
        onclick: () => api.commit((x) => ops.removeEdit(x, label, i), `remove an edit on ${label}`),
      }, '×')))),
    h('div', { class: 'row-btns' }, h('button', {
      type: 'button', class: 'danger', onclick: () => api.commit((x) => ops.clearEdits(x, label), `clear the edits on ${label}`),
    }, 'Clear all')),
    h('p', { class: 'hint' }, 'Replayed in this order onto the ground every time it grows, so a new seed keeps them. None of them reaches the last 12 mm of the rim.'));
}

/* ------------------------------------------------------------------- river */

function riverPanel(api, sel) {
  const s = api.state.spec;
  const r = s.rivers?.[sel.index];
  if (!r) throw new Error('no such river');
  const i = sel.index;
  const path = (r.path || []).map(([c, w]) => ops.labelOf(c, w));
  const set = (k) => (x, v) => { const rr = x.rivers[i]; if (v === undefined) delete rr[k]; else rr[k] = v; x.rivers[i] = ops.orderRiver(rr); };
  return [
    h('h2', {}, r.name || `River ${i + 1}`),
    h('p', { class: 'sub' }, `${r.sourceEdge ? `In from the ${SIDE[r.sourceEdge]}, ` : ''}${path.join(' → ')}${r.sinkEdge ? `, out to the ${SIDE[r.sinkEdge]}` : ''}.`),
    group('River',
      text(api, 'Name', { get: () => r.name, set: set('name'), id: 'river.name' }),
      choose(api, 'Starts as', { options: [['', 'auto (river)'], ...SIZE_IDS.map((x) => [x, `${x}, ${SIZES[x].widthMM} mm`])], get: () => r.size, set: set('size'), id: 'river.size' }),
      choose(api, 'Comes in from', { options: [['', 'rises on the tile'], ...EDGES.map((e) => [e, SIDE[e]])], get: () => r.sourceEdge, set: set('sourceEdge'), id: 'river.sourceEdge' }),
      choose(api, 'Drains to', { options: [['', 'ends on the tile'], ...EDGES.map((e) => [e, SIDE[e]])], get: () => r.sinkEdge, set: set('sinkEdge'), id: 'river.sinkEdge' }),
      r.sinkEdge ? choose(api, 'Mouth', { options: [['', 'auto, from the flow'], ...SIZE_IDS.map((x) => [x, `${x}, ${SIZES[x].widthMM} mm`])], get: () => r.sinkSize, set: set('sinkSize'), id: 'river.sinkSize' }) : null,
      h('p', { class: 'hint' }, 'The line says which tiles and which sides. When it grows, the channel is routed down the valley the ground has, so it will not follow the line exactly.'),
    ),
    h('div', { class: 'row-btns' }, del('Delete river', () => { api.commit((x) => ops.removeRiver(x, i), 'delete a river'); api.select(null); })),
  ];
}

/* -------------------------------------------------------------------- seam */

function seamPanel(api, sel) {
  const st = api.state;
  const sm = st.plan.seams.find((x) => x.id === sel.id);
  if (!sm) throw new Error('no such seam');
  const said = st.plan.sentences.filter((x) => x.seam === sm.id);
  const KIND = {
    flow: 'The river runs across', waterfall: 'Waterfall', dam: 'Dam', blocked: 'Into a bank', spills: 'Spills onto land',
    'head-on': 'Head on', drains: 'Drains into the tray', spring: 'Spring', dry: 'Dry', cliff: 'Cliff', plane: 'Level ground',
  };
  const rows = [
    sm.dropMM ? ['Drop', `${Math.round(sm.dropMM)} mm`] : null,
    Number.isFinite(sm.pondToMM) ? ['Ponds to', `${Math.round(sm.pondToMM)} mm`] : null,
    Number.isFinite(sm.wouldPondToMM) ? ['Would need', `${Math.round(sm.wouldPondToMM)} mm`] : null,
    sm.widths?.length === 2 ? ['Widths', `${sm.widths[0]} → ${sm.widths[1]} mm${sm.spreads ? ', spreads' : ''}`] : sm.widths ? ['Width', `${sm.widths[0]} mm`] : null,
    Number.isFinite(sm.landStepMM) ? ['Land step', `${Math.round(Math.abs(sm.landStepMM))} mm`] : null,
    ['Water crosses', sm.wet ? 'yes' : 'no'],
  ];
  const kids = [
    h('h2', {}, sm.tiles.join(' | ')),
    h('p', { class: 'sub' }, `${KIND[sm.kind] || sm.kind}${sm.holds === false ? ', and it overtops' : ''}.`),
    said.length ? said.map((x) => h('p', { class: `say-one ${x.kind}` }, x.text)) : h('p', { class: `say-one ${sm.kind}` }, describeQuiet(sm)),
    facts(rows),
  ];
  // A waterfall can be declared on the downstream tile's first inlet, which is what the spec can say.
  if (['flow', 'waterfall', 'dam'].includes(sm.kind) && sm.to) {
    const down = st.plan.tiles.find((t) => t.label === sm.to);
    const place = st.plan.placements.find((p) => p.id === down?.id);
    const placedSide = down && (sm.a === down.id ? sm.edge : ['S', 'W', 'N', 'E'][['N', 'E', 'S', 'W'].indexOf(sm.edge)]);
    const designSide = down ? facingEdge(placedSide, down.rot) : null;
    const firstIn = place && EDGES.find((e) => place.tile.edges?.[e]?.type === 'in');
    if (down && designSide === firstIn) {
      const k = ops.keyOf(down.col, down.row);
      kids.push(group('Waterfall',
        seg(`Extra drop into ${down.label}`, [[0, 'none'], ...[10, 20, 30, 40, 50].map((f) => [f, `+${f}`])], st.spec.waterfalls?.[k] || 0,
          (v) => api.commit((x) => ops.setWaterfall(x, down.col, down.row, v || null), `waterfall into ${down.label}`), { wide: true }),
        h('p', { class: 'hint' }, `${down.label} stands that much further below, and the river free-falls the difference. A waterfall at a seam is also the best answer to leaking: airborne water cannot find the gap.`)));
    }
  }
  if (sm.kind === 'spring' || (sm.kind === 'dry' && !sm.b)) {
    const t = st.plan.tiles.find((x) => x.label === sm.to);
    if (t) kids.push(h('div', { class: 'row-btns' }, h('button', { type: 'button', onclick: () => api.commit((x) => ops.toggleSpring(x, t.label, facingEdge(sm.edge, t.rot)), 'spring') }, sm.kind === 'spring' ? 'Take the spring off' : 'Put a spring here')));
  }
  if (sm.kind === 'drains') {
    const t = st.plan.tiles.find((x) => x.label === sm.from);
    if (t) kids.push(h('div', { class: 'row-btns' }, h('button', { type: 'button', onclick: () => api.commit((x) => ops.toggleDrain(x, t.label, facingEdge(sm.edge, t.rot)), 'stop draining') }, 'Stop draining here')));
  }
  return kids;
}

function describeQuiet(sm) {
  if (sm.kind === 'cliff') return `The land steps ${Math.round(Math.abs(sm.landStepMM))} mm along this seam.`;
  if (sm.kind === 'plane') return 'Level ground runs straight across.';
  if (!sm.wet && ['flow', 'waterfall', 'dam', 'blocked', 'spills', 'drains'].includes(sm.kind)) return 'A river bed with no water in it: nothing upstream feeds it.';
  return 'Nothing crosses here.';
}

/* ---------------------------------------------------------------- ground */

function spinePanel(api) {
  const s = api.state.spec;
  if (!s.spine) throw new Error('no spine');
  return [
    h('h2', {}, 'The ridge'),
    h('p', { class: 'sub' }, `${s.spine.length} points across the map. Drag a point to move it.`),
    group('Range',
      num(api, 'Peak height', { get: (x) => x.spineHeightM, set: (x, v) => { if (v === undefined) delete x.spineHeightM; else x.spineHeightM = v; }, unit: 'm', step: 50, min: 0, placeholder: '1500' }),
      num(api, 'Half-width', { get: (x) => x.spineWidthM, set: (x, v) => { if (v === undefined) delete x.spineWidthM; else x.spineWidthM = v; }, unit: 'm', step: 100, min: 100, placeholder: String(Math.round((s.worldSizeM || 16000) * 0.22)) }),
    ),
    group('Points', facts(s.spine.map((p, i) => { const b = ops.toBoard(s, p); return [`${i + 1}`, `${Math.round(b.x)}, ${Math.round(b.y)} mm`]; }))),
    h('div', { class: 'row-btns' }, del('Delete the ridge', () => { api.commit((x) => { delete x.spine; }, 'delete the ridge'); api.select(null); })),
  ];
}

function volcanoPanel(api, sel) {
  const s = api.state.spec;
  const v = s.volcanoes?.[sel.index];
  if (!v) throw new Error('no volcano');
  const i = sel.index;
  const at = (k) => (x) => x.volcanoes[i][k];
  const put = (k) => (x, val) => { if (val === undefined) delete x.volcanoes[i][k]; else x.volcanoes[i][k] = val; };
  const b = ops.toBoard(s, v.at);
  return [
    h('h2', {}, 'Volcano'),
    h('p', { class: 'sub' }, `At ${Math.round(b.x)}, ${Math.round(b.y)} mm on the board.`),
    group('Cone',
      num(api, 'Height', { get: at('heightM'), set: put('heightM'), unit: 'm', step: 50, min: 0, placeholder: '900', id: 'v.heightM' }),
      num(api, 'Base radius', { get: at('baseRadiusM'), set: put('baseRadiusM'), unit: 'm', step: 100, min: 100, placeholder: String(Math.round((s.worldSizeM || 16000) * 0.18)), id: 'v.baseRadiusM' }),
      num(api, 'Crater radius', { get: at('craterRadiusM'), set: put('craterRadiusM'), unit: 'm', step: 20, min: 0, placeholder: '400', id: 'v.craterRadiusM' }),
      num(api, 'Crater depth', { get: at('craterDepthM'), set: put('craterDepthM'), unit: 'm', step: 10, min: 0, placeholder: '180', id: 'v.craterDepthM' }),
      num(api, 'Breached toward', { get: at('breachAzimuthDeg'), set: put('breachAzimuthDeg'), unit: '°', step: 5, min: 0, max: 359, placeholder: 'none', id: 'v.breach', title: '0 is east, 90 north, as the generator measures it' }),
      h('p', { class: 'hint' }, 'A breached wall is what most real cones have. 0 is east and 90 north.'),
    ),
    h('div', { class: 'row-btns' }, del('Delete volcano', () => { api.commit((x) => { x.volcanoes.splice(i, 1); ops.tidy(x); }, 'delete a volcano'); api.select(null); })),
  ];
}

function flatPanel(api, sel) {
  const s = api.state.spec;
  const f = s.flats?.[sel.index];
  if (!f) throw new Error('no flat');
  const i = sel.index;
  const at = (k) => (x) => x.flats[i][k];
  const put = (k) => (x, val) => { if (val === undefined) delete x.flats[i][k]; else x.flats[i][k] = val; };
  return [
    h('h2', {}, 'Flat'),
    h('p', { class: 'sub' }, 'Ground the map keeps level.'),
    group('Flat',
      num(api, 'Radius', { get: at('radiusM'), set: put('radiusM'), unit: 'm', step: 100, min: 100, placeholder: String(Math.round((s.worldSizeM || 16000) * 0.1)), id: 'f.radiusM' }),
      num(api, 'Level at', { get: at('elevM'), set: put('elevM'), unit: 'm', step: 10, placeholder: 'the ground there', id: 'f.elevM' }),
    ),
    h('div', { class: 'row-btns' }, del('Delete flat', () => { api.commit((x) => { x.flats.splice(i, 1); ops.tidy(x); }, 'delete a flat'); api.select(null); })),
  ];
}

/* ------------------------------------------------------------------ tile */

function lakePanel(api, sel) {
  const s = api.state.spec;
  const l = s.lakes?.place?.[sel.index];
  if (!l) throw new Error('no lake');
  const i = sel.index;
  const at = (k) => (x) => x.lakes.place[i][k];
  const put = (k) => (x, val) => { if (val === undefined) delete x.lakes.place[i][k]; else x.lakes.place[i][k] = val; };
  return [
    h('h2', {}, `Lake on ${l.tile}`),
    h('p', { class: 'sub' }, `At ${l.atMM.join(', ')} mm in the tile. It fills whatever ground is low round that point.`),
    group('Lake',
      num(api, 'Depth', { get: at('depthMM'), set: put('depthMM'), unit: 'mm', step: 0.5, min: 0.5, placeholder: String(s.lakes?.depthMM ?? LAKE_DEFAULTS.depthMM), id: 'l.depthMM' }),
      num(api, 'Radius', { get: at('radiusMM'), set: put('radiusMM'), unit: 'mm', step: 1, min: 4, placeholder: 'flood', id: 'l.radiusMM', title: 'Set it to dig a round lake out whatever the ground does; leave it empty to flood the low ground' }),
      choose(api, 'Bed', { options: [['', 'as the map'], ...PROFILES.map((x) => [x, x])], get: at('profile'), set: put('profile'), id: 'l.profile' }),
    ),
    h('div', { class: 'row-btns' }, del('Delete lake', () => { api.commit((x) => { x.lakes.place.splice(i, 1); ops.tidy(x); }, 'delete a lake'); api.select(null); })),
  ];
}

function springPanel(api, sel) {
  const s = api.state.spec;
  const sp = s.fountains?.place?.[sel.index];
  if (!sp) throw new Error('no spring');
  const i = sel.index;
  return [
    h('h2', {}, `Spring on ${sp.tile}`),
    h('p', { class: 'sub' }, sp.atMM ? `At ${sp.atMM.join(', ')} mm in the tile.` : `On its ${sp.edge} inlet.`),
    h('p', { class: 'hint' }, `A ${s.fountains?.tubeOdMM ?? FOUNTAIN_DEFAULTS.tubeOdMM} mm tube comes up through every plate under it into a pool with one notch, so the water leaves at the rate it arrives instead of squirting.`),
    h('div', { class: 'row-btns' }, del('Delete spring', () => { api.commit((x) => { x.fountains.place.splice(i, 1); ops.tidy(x); }, 'delete a spring'); api.select(null); })),
  ];
}

function woodPanel(api, sel) {
  const s = api.state.spec;
  const w = s.canopy?.[sel.index];
  if (!w) throw new Error('no wood');
  return [
    h('h2', {}, `${w.kind === 'conifer' ? 'Conifers' : 'Broadleaf'}${w.tiles ? ` on ${w.tiles.join(', ')}` : ''}`),
    h('p', { class: 'sub' }, w.region ? `Drawn as a shape of ${w.region.length} points. Drag a point to reshape it.` : 'Over the whole map.'),
    group('Wood', woodFields(api, sel.index)),
    h('div', { class: 'row-btns' }, del('Delete wood', () => { api.commit((x) => { x.canopy.splice(sel.index, 1); ops.tidy(x); }, 'delete a wood'); api.select(null); })),
  ];
}

function cornerPanel(api, sel) {
  const st = api.state;
  const key = `${sel.cc},${sel.rr}`;
  const lift = st.spec.cornerRaise?.[key] || 0;
  const plate = st.plan.contract.plateMM;
  const world = st.plan.corners.get(key);
  const touching = [[0, 0], [-1, 0], [0, -1], [-1, -1]]
    .map(([dc, dr]) => st.plan.placements.find((p) => p.col === sel.cc + dc && p.row === sel.rr + dr))
    .filter(Boolean).map((p) => p.label);
  return [
    h('h2', {}, 'Corner'),
    h('p', { class: 'sub' }, `Shared by ${touching.join(', ')}. Every tile here reads one height for it, so they mate whatever it is.`),
    facts([['On the table', `${Math.round(world ?? 0)} mm`], ['Raised by', `${lift} mm`]]),
    seg('Raise', [[0, '0'], [plate, `+${plate}`], [2 * plate, `+${2 * plate}`], [3 * plate, `+${3 * plate}`]], lift,
      (v) => api.commit((x) => { if (!v) { if (x.cornerRaise) delete x.cornerRaise[key]; ops.tidy(x); } else { x.cornerRaise = x.cornerRaise || {}; x.cornerRaise[key] = v; } }, 'raise a corner'), { wide: true }),
    h('p', { class: 'hint' }, 'A higher corner is a higher rim: it is how a tile behind a dam is made to hold its pond instead of running over.'),
  ];
}
