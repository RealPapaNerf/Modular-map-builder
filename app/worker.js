// worker.js — the build, off the main thread.
//
// buildTile is a long synchronous job (seconds to tens of seconds) and it
// returns megabytes of mesh. Both facts argue for the same thing: run it
// here, keep the result here, and send the main thread only what it draws.
// STLs are generated on demand and transferred, so the mesh is never copied
// across unless somebody actually asks for a file.
//
// The editor runs two of these. One builds. The other answers `estimate`:
// the module cut from the ground WITHOUT its ice, hillshaded, in a fraction
// of a second, so the canvas shows the ridge taking shape while it is drawn.
//
// After every build the builder also sends `heights`: the module's ground,
// its water and its cell kinds as typed arrays, TRANSFERRED rather than
// copied, which is all the 3D view needs. The mesh stays here.

import { buildTile, buildWorld, worldKey } from '../lib/build.js';
import { makeContract } from '../lib/contract.js';
import { cutTile } from '../lib/tile.js';
import { scaleOf, marginOf } from '../lib/scale.js';
import { shadeTile } from '../lib/shade.js';
import { writeSTL } from '../lib/stl.js';
import { keySheet, keySolid, usableKeys } from '../lib/joint.js';
import { meshTile } from '../lib/mesh.js';
import { makeField } from '../lib/field.js';
import { trayField } from '../lib/fountain.js';
import { summarise } from './summary.js';
import { makeZip } from './zip.js';
import { tileHeights, transferables } from './heights.js';

let result = null;
let spec = null;
// The last world grown, and the key it was grown for. The ground is a pure
// function of worldKey(spec, { ice: true }), so a rebuild that changed
// nothing in it -- a brushstroke, a channel -- reuses it and skips the ice,
// which is most of a build.
let kept = null;

const post = (msg, transfer = []) => self.postMessage(msg, transfer);
const moduleName = () => (spec && spec.name) || 'module';

/** The file set `mmb build` writes, as generators so nothing is built early. */
function manifest() {
  if (!result) return [];
  const t = result.tile;
  const out = [];
  out.push({
    id: 'module', name: `${moduleName()}.stl`, group: 'module',
    note: `${t.mesh.triangles.toLocaleString()} triangles`,
    make: () => writeSTL(t.tris, moduleName()),
  });
  const usable = usableKeys(result).length;
  if (usable) {
    out.push({ id: 'keys', name: 'keys.stl', group: 'joinery', note: `${usable} key${usable > 1 ? 's' : ''} on one sheet, one per recess`, make: () => writeSTL(keySheet(usable, result.joint), 'seam keys') });
    out.push({ id: 'key-one', name: 'key-one.stl', group: 'joinery', note: 'a single key, for test-fitting', make: () => writeSTL(keySolid(result.joint), 'seam key') });
  }
  if (t.springs.length) {
    out.push({
      id: 'tray', name: 'tray.stl', group: 'joinery', note: 'the tub the module stands in, with the pump under it',
      make: () => {
        const c = result.contract;
        const tray = trayField(makeField, { widthMM: c.tileMM, depthMM: c.tileMM, ...(spec.tray || {}) });
        return writeSTL(meshTile(tray.field), 'tray');
      },
    });
  }
  return out;
}

function find(id) {
  const f = manifest().find((x) => x.id === id);
  if (!f) throw new Error(`no such file: ${id}`);
  return f;
}

self.onmessage = async (ev) => {
  const msg = ev.data;
  try {
    if (msg.type === 'estimate') {
      // The ground without its ice, cut and shaded: a draft of what the
      // ridge and the volcanoes do, before anything is grown.
      const s = { ...msg.spec, glacier: false };
      const c = makeContract(s.contract || {});
      const w = buildWorld(s);
      const local = cutTile(w.bed, c, { marginMM: marginOf(s, c.tileMM), metresPerMM: scaleOf(s), meshMM: 2.5 });
      const { rgb, width, height } = shadeTile({ local }, { px: msg.px || 256 });
      post({ type: 'estimate', key: msg.key ?? worldKey(msg.spec), preview: { rgb, width, height } }, [rgb.buffer]);
      return;
    }

    if (msg.type === 'run') {
      spec = msg.spec;
      const t0 = Date.now();
      const runSpec = msg.mode === 'check' ? { ...spec, glacier: false } : spec;
      result = null;
      const key = worldKey(runSpec, { ice: true });
      result = buildTile(runSpec, (m) => post({ type: 'progress', message: m }), { world: kept?.key === key ? kept.world : null });
      kept = { key, world: result.world };
      result.name = moduleName();

      post({ type: 'progress', message: 'Shading' });
      const { rgb, width, height } = shadeTile(result.tile, { px: msg.px || 512 });
      const report = summarise(result, { mode: msg.mode, spec: runSpec });
      const files = manifest().map(({ id, name, group, note }) => ({ id, name, group, note }));
      post({
        type: 'report', report, files, elapsedMS: Date.now() - t0,
        preview: { rgb, width, height }, worldKey: key, id: msg.id ?? null,
      }, [rgb.buffer]);

      const tile = tileHeights(result.tile);
      post({ type: 'heights', id: msg.id ?? null, contract: { tileMM: result.contract.tileMM, rimLockMM: result.contract.rimLockMM }, tile }, transferables(tile));
      return;
    }

    if (msg.type === 'stl') {
      const f = find(msg.id);
      const bytes = f.make();
      post({ type: 'file', name: f.name, bytes }, [bytes.buffer]);
      return;
    }

    if (msg.type === 'zip') {
      const all = manifest();
      const files = [];
      for (let i = 0; i < all.length; i++) {
        post({ type: 'progress', message: `Packing ${all[i].name} (${i + 1}/${all.length})` });
        files.push({ name: all[i].name, bytes: all[i].make() });
      }
      const blob = await makeZip(files, { onProgress: (n, total, name) => post({ type: 'progress', message: `Compressing ${name} (${n}/${total})` }) });
      post({ type: 'zip', blob, name: `${moduleName()}-files.zip` });
      return;
    }

    throw new Error(`unknown message: ${msg.type}`);
  } catch (err) {
    post({ type: 'error', message: err && err.message ? err.message : String(err), stack: err && err.stack });
  }
};
