// inspector.js — the parameters of what is selected, and nothing else.
//
// Nothing selected is the module itself: its seed and scale, the ground, the
// ice, the water, the woods that cover it all and the contract. Every field
// writes the spec through the api and reads back from it, so the JSON drawer
// and the canvas change with it. A field left empty is a key taken out: the
// default, as the CLI would read it.

import { EDGES, WIDTHS, makeContract } from '../lib/contract.js';
import { CHANNEL_DEFAULTS } from '../lib/channel.js';
import { LAKE_DEFAULTS, PROFILES } from '../lib/lake.js';
import { FOUNTAIN_DEFAULTS } from '../lib/fountain.js';
import { CANOPY_DEFAULTS } from '../lib/canopy.js';
import { DEFAULT_M_PER_MM } from '../lib/scale.js';
import * as ops from './specops.js';

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
    options.map(([v, t]) => h('button', { type: 'button', 'aria-pressed': String(String(v) === String(current)), onclick: () => pick(v) }, t)));
  return h('div', { class: `field${wide ? ' wide' : ''}` }, h('span', {}, label), h('span', { class: 'ctl' }, box));
}

const group = (title, ...kids) => h('fieldset', {}, h('legend', {}, title), ...kids);
const facts = (rows) => h('ul', { class: 'facts' }, rows.filter(Boolean).map(([k, v]) => h('li', {}, h('span', {}, k), h('span', {}, v))));
const del = (label, fn) => h('button', { type: 'button', class: 'danger', onclick: fn }, label);
const put = (list, i, k) => (x, v) => { if (v === undefined) delete x[list][i][k]; else x[list][i][k] = v; };
const at = (list, i, k) => (x) => x[list]?.[i]?.[k];

/* ------------------------------------------------------------------ root */

export function renderInspector(root, api) {
  const st = api.state;
  const sel = st.selection;
  let body;
  try {
    switch (sel?.type) {
      case 'channel': body = channelPanel(api, sel); break;
      case 'spine': body = spinePanel(api); break;
      case 'volcano': body = volcanoPanel(api, sel); break;
      case 'flat': body = flatPanel(api, sel); break;
      case 'lake': body = lakePanel(api, sel); break;
      case 'springpoint': body = springPanel(api, sel); break;
      case 'wood': body = woodPanel(api, sel); break;
      default: body = modulePanel(api);
    }
  } catch (err) {
    // A selection the spec no longer has (undone, deleted in the JSON): show the module.
    console.warn(err);
    body = modulePanel(api);
  }
  const focused = document.activeElement?.closest?.('#inspector') ? document.activeElement.getAttribute('data-field') : null;
  root.replaceChildren(h('div', { class: 'insp' }, body));
  if (focused) root.querySelector(`[data-field="${CSS.escape(focused)}"]`)?.focus();
}

/* ---------------------------------------------------------------- module */

function modulePanel(api) {
  const s = api.state.spec;
  const { T } = ops.dims(s);
  const c = makeContract(s.contract || {});
  const say = api.state.say;
  return [
    h('h2', {}, s.name || 'Untitled module'),
    h('p', { class: 'sub' }, `One ${T} mm module. Nothing selected, so this is the module.`),
    say ? h('p', { class: 'say-one' }, say.sentences.map((x) => x.text).join(' ')) : null,
    group('Module',
      text(api, 'Name', { get: (x) => x.name, set: (x, v) => { if (v === undefined) delete x.name; else x.name = v; } }),
      h('div', { class: 'field' }, h('span', {}, 'Seed'), h('span', { class: 'ctl' },
        numInput(api, 'Seed', (x) => x.seed, (x, v) => { x.seed = v ?? 1; }, { step: 1, min: 0 }),
        h('button', { type: 'button', class: 'mini', title: 'A different module, same rules', onclick: () => api.commit((x) => { x.seed = Math.floor(Math.random() * 100000); }, 'roll the seed') }, 'Roll'))),
      num(api, 'Scale', { get: (x) => x.metresPerMM, set: (x, v) => { if (v === undefined) delete x.metresPerMM; else x.metresPerMM = v; }, unit: 'm/mm', step: 1, min: 1, placeholder: String(DEFAULT_M_PER_MM), title: 'Metres of real ground per millimetre of print. The only place metres appear: it is what lets the glacier behave like a glacier.' }),
      num(api, 'Margin', { get: (x) => x.marginMM, set: (x, v) => { if (v === undefined) delete x.marginMM; else x.marginMM = v; }, unit: 'mm', step: 10, min: 0, placeholder: String(T / 2), title: 'How far the world runs past the rim on every side, so the ice has somewhere to come from. Grown, not printed.' }),
    ),
    group('Ground',
      num(api, 'Mountains', { get: (x) => x.spineHeightMM, set: (x, v) => { if (v === undefined) delete x.spineHeightMM; else x.spineHeightMM = v; }, unit: 'mm', step: 1, min: 0, placeholder: '60', title: 'How far the ridge stands above the low ground, on the print' }),
      num(api, 'Ridge width', { get: (x) => x.spineWidthMM, set: (x, v) => { if (v === undefined) delete x.spineWidthMM; else x.spineWidthMM = v; }, unit: 'mm', step: 5, min: 5, placeholder: String(Math.round(T * 0.45)) }),
      num(api, 'Roughness', { get: (x) => x.roughness, set: (x, v) => { if (v === undefined) delete x.roughness; else x.roughness = v; }, step: 0.02, min: 0, max: 1, placeholder: '0.22' }),
    ),
    group('Ice',
      check(api, 'Glaciate', { get: (x) => x.glacier !== false, set: (x, on) => { x.glacier = on ? (x.glacier && typeof x.glacier === 'object' ? x.glacier : { cycles: 30 }) : false; } }),
      s.glacier !== false ? [
        num(api, 'Cycles', { get: (x) => x.glacier?.cycles, set: (x, v) => ops.setPath(x, 'glacier.cycles', v), min: 1, max: 200, placeholder: 'default' }),
        num(api, 'Snowline swing', { get: (x) => x.glacier?.elaSwingMM, set: (x, v) => ops.setPath(x, 'glacier.elaSwingMM', v), unit: 'mm', step: 1, min: 0, placeholder: '18', title: 'How far the snowline moves either side of its mean. This is what leaves a staircase of cirques and a line of recessional moraines instead of one clean trough.' }),
        num(api, 'Till kept', { get: (x) => x.glacier?.tillYield, set: (x, v) => ops.setPath(x, 'glacier.tillYield', v), step: 0.05, min: 0, max: 1, placeholder: '0.55', title: 'How much of the rock the ice cuts it carries and puts back down as moraines, rather than exporting as rock flour.' }),
        num(api, 'Advances', { get: (x) => x.glacier?.glacialCycles, set: (x, v) => ops.setPath(x, 'glacier.glacialCycles', v), min: 1, max: 12, placeholder: '3' }),
        h('p', { class: 'hint' }, 'The ice carves, retreats, and melts out entirely before the module is cut: what is printed is the bed it left.'),
      ] : null,
    ),
    group('Channels',
      s.channels?.length ? h('ul', { class: 'facts' }, s.channels.map((ch, i) => {
        const ends = ops.channelEnds(s, ch);
        return h('li', { class: 'pick', onclick: () => api.select({ type: 'channel', index: i }) },
          h('span', {}, ch.name || `channel ${i + 1}`),
          h('span', {}, ends ? `${ends.from || '·'} → ${ends.to || '·'}` : 'will not cut'));
      })) : h('p', { class: 'hint' }, 'None yet. Draw one with the Channel tool: start or finish on a port to cross the rim.'),
      num(api, 'Default width', { get: (x) => x.channelDefaults?.widthMM, set: (x, v) => ops.setPath(x, 'channelDefaults.widthMM', v), unit: 'mm', step: 5, min: 4, placeholder: String(CHANNEL_DEFAULTS.widthMM) }),
      num(api, 'Default depth', { get: (x) => x.channelDefaults?.depthMM, set: (x, v) => ops.setPath(x, 'channelDefaults.depthMM', v), unit: 'mm', step: 1, min: 0.5, placeholder: String(c.channelDepthMM) }),
    ),
    group('Standing water',
      check(api, 'Tarns in hollows', { get: (x) => x.lakes?.fillHollows !== false, set: (x, on) => ops.setPath(x, 'lakes.fillHollows', on) }),
      num(api, 'Depth', { get: (x) => x.lakes?.depthMM, set: (x, v) => ops.setPath(x, 'lakes.depthMM', v), unit: 'mm', step: 0.5, min: 0.5, placeholder: String(LAKE_DEFAULTS.depthMM) }),
      num(api, 'Shore', { get: (x) => x.lakes?.shoreMM, set: (x, v) => ops.setPath(x, 'lakes.shoreMM', v), unit: 'mm', step: 0.5, min: 0, placeholder: String(LAKE_DEFAULTS.shoreMM) }),
      choose(api, 'Bed', { options: [['', 'default (dish)'], ...PROFILES.map((x) => [x, x])], get: (x) => x.lakes?.profile, set: (x, v) => ops.setPath(x, 'lakes.profile', v) }),
    ),
    group('Springs',
      check(api, 'At the start of every channel', {
        get: (x) => !!x.fountains && x.fountains.auto !== false,
        set: (x, on) => { x.fountains = { ...(x.fountains || {}), auto: on }; },
        title: 'Where a channel starts, the pump has to put the water',
      }),
      num(api, 'Tube OD', { get: (x) => x.fountains?.tubeOdMM, set: (x, v) => ops.setPath(x, 'fountains.tubeOdMM', v), unit: 'mm', step: 0.1, min: 3, placeholder: String(FOUNTAIN_DEFAULTS.tubeOdMM) }),
      num(api, 'Pool', { get: (x) => x.fountains?.poolRadiusMM, set: (x, v) => ops.setPath(x, 'fountains.poolRadiusMM', v), unit: 'mm', step: 0.5, min: 5, placeholder: String(FOUNTAIN_DEFAULTS.poolRadiusMM) }),
    ),
    group('Woods over the whole module', woodLayers(api)),
    group('Contract',
      num(api, 'Module', { get: (x) => x.contract?.tileMM, set: (x, v) => setContract(x, 'tileMM', v), unit: 'mm', step: 10, min: 50, placeholder: String(c.tileMM) }),
      num(api, 'Rim', { get: (x) => x.contract?.edgeLandMM, set: (x, v) => setContract(x, 'edgeLandMM', v), unit: 'mm', step: 1, min: 4, placeholder: String(c.edgeLandMM), title: 'How high every edge stands. Every module built to this contract has the same rim, so they mate.' }),
      num(api, 'Port width', { get: (x) => x.contract?.portWidthMM, set: (x, v) => setContract(x, 'portWidthMM', v), unit: 'mm', step: 5, min: 6, placeholder: String(c.portWidthMM), title: 'A channel crossing the rim is this wide there, whatever it is inland.' }),
      num(api, 'Channel depth', { get: (x) => x.contract?.channelDepthMM, set: (x, v) => setContract(x, 'channelDepthMM', v), unit: 'mm', step: 1, min: 1, placeholder: String(c.channelDepthMM), title: 'How deep a channel is below the ground, and how deep the port is.' }),
      h('p', { class: 'hint' }, `Every edge stands ${c.edgeLandMM} mm high; a channel crosses it ${c.portWidthMM} mm wide and ${Math.round(c.edgeLandMM - c.channelDepthMM) > 0 ? c.channelDepthMM : c.edgeLandMM - 3} mm deep, in the middle of the side. Any module built to this sits against any other.`),
    ),
    editsGroup(api),
    designNotes(api),
  ];
}

/** The contract is written whole once it is touched, so the four numbers read together in the JSON. */
function setContract(x, key, v) {
  const d = makeContract({});
  const cur = x.contract || {};
  x.contract = { tileMM: cur.tileMM ?? d.tileMM, edgeLandMM: cur.edgeLandMM ?? d.edgeLandMM, portWidthMM: cur.portWidthMM ?? d.portWidthMM, channelDepthMM: cur.channelDepthMM ?? d.channelDepthMM, ...cur };
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
  if (!layers.length) out.unshift(h('p', { class: 'hint' }, 'None yet. A wood drawn as a shape has its own inspector.'));
  return out;
}

function woodFields(api, i) {
  const id = (k) => `canopy.${i}.${k}`;
  return [
    choose(api, 'Kind', { options: [['deciduous', 'broadleaf'], ['conifer', 'conifer']], get: at('canopy', i, 'kind'), set: put('canopy', i, 'kind'), id: id('kind') }),
    num(api, 'Crown', { get: at('canopy', i, 'crownMM'), set: put('canopy', i, 'crownMM'), unit: 'mm', step: 0.5, min: 2, placeholder: String(CANOPY_DEFAULTS.crownMM), id: id('crownMM') }),
    num(api, 'Height', { get: at('canopy', i, 'heightMM'), set: put('canopy', i, 'heightMM'), unit: 'mm', step: 0.5, min: 1, placeholder: String(CANOPY_DEFAULTS.heightMM), id: id('heightMM') }),
    num(api, 'Density', { get: at('canopy', i, 'density'), set: put('canopy', i, 'density'), step: 0.01, min: 0.01, max: 1, placeholder: '0.4', id: id('density'), title: 'The fraction of ground under canopy: 0.05 scattered, 0.55 a proper wood, 1 closed' }),
    num(api, 'Lowest', { get: at('canopy', i, 'minZMM'), set: put('canopy', i, 'minZMM'), unit: 'mm', step: 1, placeholder: 'any', id: id('minZMM'), title: 'Height on the module, mm' }),
    num(api, 'Treeline', { get: at('canopy', i, 'maxZMM'), set: put('canopy', i, 'maxZMM'), unit: 'mm', step: 1, placeholder: 'none', id: id('maxZMM'), title: 'Height on the module, mm' }),
    num(api, 'Thinning', { get: at('canopy', i, 'thinningMM'), set: put('canopy', i, 'thinningMM'), unit: 'mm', step: 1, min: 0, placeholder: '0', id: id('thinningMM') }),
    num(api, 'Max slope', { get: at('canopy', i, 'maxSlopeDeg'), set: put('canopy', i, 'maxSlopeDeg'), unit: '°', step: 1, min: 0, max: 90, placeholder: 'any', id: id('maxSlopeDeg') }),
  ];
}

function designNotes(api) {
  const d = (api.state.say?.notes || []).filter((x) => x.severity === 'error' || x.severity === 'warning');
  if (!d.length) return group('To build it', h('p', { class: 'hint' }, 'Nothing stands in the way of growing this module.'));
  return group('To build it', d.map((x) => h('p', { class: x.severity === 'error' ? 'err-line' : 'warn-line' }, x.message)));
}

/**
 * The strokes made in Refine, oldest first, each one removable. They are
 * replayed in this order every time the module is grown.
 */
function editsGroup(api) {
  const list = (api.state.spec.edits || []).filter((e) => e && typeof e === 'object');
  if (!list.length) return null;
  return group(`Edits by hand (${list.length})`,
    h('ol', { class: 'edit-list' }, list.map((e, i) => h('li', {},
      h('span', {}, ops.describeEdit(e)),
      h('button', { type: 'button', class: 'mini', title: 'Take this edit off', 'aria-label': `Remove edit ${i + 1}`, 'data-edit': String(i), onclick: () => api.commit((x) => ops.removeEdit(x, i), 'remove an edit') }, '×')))),
    h('div', { class: 'row-btns' }, h('button', { type: 'button', class: 'danger', onclick: () => api.commit((x) => ops.clearEdits(x), 'clear the edits') }, 'Clear all')),
    h('p', { class: 'hint' }, 'Replayed in this order onto the ground every time it grows, so a new seed keeps them. None of them reaches the last 12 mm of the rim.'));
}

/* --------------------------------------------------------------- channel */

function channelPanel(api, sel) {
  const s = api.state.spec;
  const ch = s.channels?.[sel.index];
  if (!ch) throw new Error('no such channel');
  const i = sel.index;
  const c = ops.contractOf(s);
  const ends = ops.channelEnds(s, ch);
  const grown = api.state.grown?.report?.channels?.find((x) => x.name === (ch.name || `channel ${i + 1}`));
  const where = !ends ? 'It is too short to cut, or leaves by the side it came in.'
    : `${ends.from ? `In at the ${SIDE[ends.from]} port` : 'Starts inside the module'}, ${ends.to ? `out at the ${SIDE[ends.to]} port` : 'ends inside the module'}${ends.routed ? ', routed down the valley when it grows' : ''}.`;
  return [
    h('h2', {}, ch.name || `Channel ${i + 1}`),
    h('p', { class: 'sub' }, where),
    group('Channel',
      text(api, 'Name', { get: () => ch.name, set: put('channels', i, 'name'), id: 'channel.name' }),
      seg('Width', WIDTHS.map((w) => [w, `${w}`]), ch.widthMM ?? CHANNEL_DEFAULTS.widthMM, (v) => api.commit((x) => { x.channels[i].widthMM = v; }, 'channel width'), { wide: true, id: 'channel.width' }),
      num(api, 'Width', { get: at('channels', i, 'widthMM'), set: put('channels', i, 'widthMM'), unit: 'mm', step: 1, min: 4, placeholder: String(CHANNEL_DEFAULTS.widthMM), id: 'channel.widthMM', title: 'Bank to bank. At the rim it is the port\'s width whatever this says.' }),
      num(api, 'Depth', { get: at('channels', i, 'depthMM'), set: put('channels', i, 'depthMM'), unit: 'mm', step: 0.5, min: 0.5, placeholder: String(s.channelDefaults?.depthMM ?? c.channelDepthMM), id: 'channel.depthMM', title: 'Below the ground along its line. The cross-section is a circular arc, a ) on its side; deeper than half the width it gets straight walls.' }),
      Array.isArray(ch.path) ? h('p', { class: 'hint' }, `${ch.path.length} points. Drag a point to move it, or the line to move the whole channel.`)
        : [h('p', { class: 'hint' }, 'No line of its own: the generator routes it down the valley the ice left, between its two ends.'),
          grown?.pts ? h('div', { class: 'row-btns' }, h('button', { type: 'button', 'data-field': 'channel.take', onclick: () => api.commit((x) => ops.takeLine(x, i, grown.pts), 'take the channel\'s line') }, 'Take the line it found'),
            h('span', { class: 'hint' }, 'so you can drag its points')) : null],
    ),
    grown ? group('As grown', facts([
      ['Length', `${Math.round(grown.lengthMM)} mm`],
      ['Floor at the start', `${grown.startFloorMM.toFixed(1)} mm`],
      ['Floor at the end', `${grown.endFloorMM.toFixed(1)} mm`],
      ['Lowest', `${grown.lowestFloorMM.toFixed(1)} mm`],
      grown.climbMM > 0.5 ? ['Climbs', `${grown.climbMM.toFixed(1)} mm`] : null,
    ]), grown.climbMM > 0.5 ? h('p', { class: 'warn-line' }, 'The line runs over a rise, so water put in at the start ponds before it. Move the line, or dig it with the Lower brush.') : null) : null,
    h('div', { class: 'row-btns' }, del('Delete channel', () => { api.commit((x) => ops.removeChannel(x, i), 'delete a channel'); api.select(null); })),
  ];
}

/* ---------------------------------------------------------------- ground */

function spinePanel(api) {
  const s = api.state.spec;
  if (!s.spine) throw new Error('no spine');
  const { T } = ops.dims(s);
  return [
    h('h2', {}, 'The ridge'),
    h('p', { class: 'sub' }, `${s.spine.length} points. Drag a point to move it; it may run out into the margin.`),
    group('Range',
      num(api, 'Peak height', { get: (x) => x.spineHeightMM, set: (x, v) => { if (v === undefined) delete x.spineHeightMM; else x.spineHeightMM = v; }, unit: 'mm', step: 1, min: 0, placeholder: '60' }),
      num(api, 'Half-width', { get: (x) => x.spineWidthMM, set: (x, v) => { if (v === undefined) delete x.spineWidthMM; else x.spineWidthMM = v; }, unit: 'mm', step: 5, min: 5, placeholder: String(Math.round(T * 0.45)) }),
    ),
    group('Points', facts(s.spine.map((p, i) => [`${i + 1}`, `${Math.round(p[0])}, ${Math.round(p[1])} mm`]))),
    h('div', { class: 'row-btns' }, del('Delete the ridge', () => { api.commit((x) => { delete x.spine; }, 'delete the ridge'); api.select(null); })),
  ];
}

function volcanoPanel(api, sel) {
  const s = api.state.spec;
  const v = s.volcanoes?.[sel.index];
  if (!v) throw new Error('no volcano');
  const { T } = ops.dims(s);
  const i = sel.index;
  return [
    h('h2', {}, 'Volcano'),
    h('p', { class: 'sub' }, `At ${Math.round(v.at[0])}, ${Math.round(v.at[1])} mm.`),
    group('Cone',
      num(api, 'Height', { get: at('volcanoes', i, 'heightMM'), set: put('volcanoes', i, 'heightMM'), unit: 'mm', step: 1, min: 0, placeholder: '32', id: 'v.heightMM' }),
      num(api, 'Base radius', { get: at('volcanoes', i, 'baseRadiusMM'), set: put('volcanoes', i, 'baseRadiusMM'), unit: 'mm', step: 5, min: 5, placeholder: String(Math.round(T * 0.36)), id: 'v.baseRadiusMM' }),
      num(api, 'Crater radius', { get: at('volcanoes', i, 'craterRadiusMM'), set: put('volcanoes', i, 'craterRadiusMM'), unit: 'mm', step: 1, min: 0, placeholder: '16', id: 'v.craterRadiusMM' }),
      num(api, 'Crater depth', { get: at('volcanoes', i, 'craterDepthMM'), set: put('volcanoes', i, 'craterDepthMM'), unit: 'mm', step: 1, min: 0, placeholder: '7', id: 'v.craterDepthMM' }),
      num(api, 'Breached toward', { get: at('volcanoes', i, 'breachAzimuthDeg'), set: put('volcanoes', i, 'breachAzimuthDeg'), unit: '°', step: 5, min: 0, max: 359, placeholder: 'none', id: 'v.breach', title: '0 is east, 90 north, as the generator measures it' }),
      h('p', { class: 'hint' }, 'A breached wall is what most real cones have. 0 is east and 90 north.'),
    ),
    h('div', { class: 'row-btns' }, del('Delete volcano', () => { api.commit((x) => { x.volcanoes.splice(i, 1); ops.tidy(x); }, 'delete a volcano'); api.select(null); })),
  ];
}

function flatPanel(api, sel) {
  const s = api.state.spec;
  const f = s.flats?.[sel.index];
  if (!f) throw new Error('no flat');
  const { T } = ops.dims(s);
  const i = sel.index;
  return [
    h('h2', {}, 'Flat'),
    h('p', { class: 'sub' }, 'Ground the module keeps level.'),
    group('Flat',
      num(api, 'Radius', { get: at('flats', i, 'radiusMM'), set: put('flats', i, 'radiusMM'), unit: 'mm', step: 5, min: 5, placeholder: String(Math.round(T * 0.2)), id: 'f.radiusMM' }),
      num(api, 'Level at', { get: at('flats', i, 'elevMM'), set: put('flats', i, 'elevMM'), unit: 'mm', step: 1, placeholder: 'the ground there', id: 'f.elevMM' }),
    ),
    h('div', { class: 'row-btns' }, del('Delete flat', () => { api.commit((x) => { x.flats.splice(i, 1); ops.tidy(x); }, 'delete a flat'); api.select(null); })),
  ];
}

/* ----------------------------------------------------------------- on it */

function lakePanel(api, sel) {
  const s = api.state.spec;
  const l = s.lakes?.place?.[sel.index];
  if (!l) throw new Error('no lake');
  const i = sel.index;
  const where = Array.isArray(l.pathMM) ? `Painted along a stroke of ${l.pathMM.length} points, ${l.radiusMM * 2} mm wide; its surface sits at the lowest ground under it.`
    : `At ${l.atMM.join(', ')} mm. It fills whatever ground is low round that point.`;
  const g = (k) => (x) => x.lakes.place[i][k];
  const p = (k) => (x, val) => { if (val === undefined) delete x.lakes.place[i][k]; else x.lakes.place[i][k] = val; };
  return [
    h('h2', {}, 'Lake'),
    h('p', { class: 'sub' }, where),
    group('Lake',
      num(api, 'Depth', { get: g('depthMM'), set: p('depthMM'), unit: 'mm', step: 0.5, min: 0.5, placeholder: String(s.lakes?.depthMM ?? LAKE_DEFAULTS.depthMM), id: 'l.depthMM' }),
      num(api, 'Radius', { get: g('radiusMM'), set: p('radiusMM'), unit: 'mm', step: 1, min: 4, placeholder: 'flood', id: 'l.radiusMM', title: 'Set it to dig a round lake out whatever the ground does; leave it empty to flood the low ground' }),
      choose(api, 'Bed', { options: [['', 'as the module'], ...PROFILES.map((x) => [x, x])], get: g('profile'), set: p('profile'), id: 'l.profile' }),
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
    h('h2', {}, 'Spring'),
    h('p', { class: 'sub' }, `At ${sp.atMM.join(', ')} mm.`),
    h('p', { class: 'hint' }, `A ${s.fountains?.tubeOdMM ?? FOUNTAIN_DEFAULTS.tubeOdMM} mm tube comes up through the module into a pool with one notch, so the water leaves at the rate it arrives instead of squirting.`),
    h('div', { class: 'row-btns' }, del('Delete spring', () => { api.commit((x) => { x.fountains.place.splice(i, 1); ops.tidy(x); }, 'delete a spring'); api.select(null); })),
  ];
}

function woodPanel(api, sel) {
  const s = api.state.spec;
  const w = s.canopy?.[sel.index];
  if (!w) throw new Error('no wood');
  return [
    h('h2', {}, w.kind === 'conifer' ? 'Conifers' : 'Broadleaf'),
    h('p', { class: 'sub' }, w.region ? `Drawn as a shape of ${w.region.length} points. Drag a point to reshape it.` : 'Over the whole module.'),
    group('Wood', woodFields(api, sel.index)),
    h('div', { class: 'row-btns' }, del('Delete wood', () => { api.commit((x) => { x.canopy.splice(sel.index, 1); ops.tidy(x); }, 'delete a wood'); api.select(null); })),
  ];
}

export { EDGES };
