// worker.js — the build, off the main thread.
//
// buildMap is a long synchronous job (seconds to tens of seconds) and it
// returns tens of megabytes of mesh. Both facts argue for the same thing: run
// it here, keep the result here, and send the main thread only what it draws.
// STLs are generated on demand and transferred, so the meshes are never
// copied across unless somebody actually asks for a file.

import { buildMap } from '../lib/build.js';
import { shadeMap } from '../lib/shade.js';
import { writeSTL, plateSTL } from '../lib/stl.js';
import { keySheet, keySolid, usableKeys } from '../lib/joint.js';
import { meshTile } from '../lib/mesh.js';
import { makeField } from '../lib/field.js';
import { trayField } from '../lib/fountain.js';
import { summarise } from './summary.js';
import { makeZip } from './zip.js';

let result = null;
let spec = null;

const post = (msg, transfer = []) => self.postMessage(msg, transfer);
const mapName = () => (spec && spec.name) || 'map';

/** The file set `mmb build` writes, as generators so nothing is built early. */
function manifest() {
  if (!result) return [];
  const c = result.contract;
  const out = [];

  for (const t of result.tiles) {
    out.push({
      id: `tile:${t.label}`,
      name: `${mapName()}-${t.label}.stl`,
      group: 'tiles',
      note: `${t.mesh.triangles.toLocaleString()} triangles`,
      make: () => writeSTL(t.tris, `${mapName()} ${t.label}`),
    });
  }

  out.push({
    id: 'plate',
    name: 'plate.stl',
    group: 'plates',
    note: `${c.tileMM} x ${c.tileMM} x ${c.plateMM} mm, print ${result.tiles.reduce((a, t) => a + t.stack.plates, 0)}`,
    make: () => writeSTL(plateSTL(c.tileMM, c.tileMM, c.plateMM), 'plate'),
  });

  // A plate with a tube through it is not the same part as one without.
  for (const t of result.tiles) {
    if (!(t.springs || []).length || t.stack.plates === 0) continue;
    out.push({
      id: `plate-drilled:${t.label}`,
      name: `plate-drilled-${t.label}.stl`,
      group: 'plates',
      note: `${t.stack.plates} needed under ${t.label}`,
      make: () => {
        const stepMM = 1.5;
        const n = Math.round(c.tileMM / stepMM) + 1;
        const flat = makeField(n, n, c.tileMM / (n - 1));
        flat.values.fill(c.plateMM);
        return writeSTL(meshTile(flat, { bores: t.springs.map((sp) => sp.bore) }), `plate ${t.label}`);
      },
    });
  }

  const usable = usableKeys(result).length;
  if (usable) {
    out.push({
      id: 'keys',
      name: 'keys.stl',
      group: 'joinery',
      note: `${usable} key${usable > 1 ? 's' : ''} laid out on one sheet`,
      make: () => writeSTL(keySheet(usable, result.joint), 'seam keys'),
    });
    out.push({
      id: 'key-one',
      name: 'key-one.stl',
      group: 'joinery',
      note: 'a single key, for test-fitting',
      make: () => writeSTL(keySolid(result.joint), 'seam key'),
    });
  }

  if (result.tiles.some((t) => (t.springs || []).length)) {
    out.push({
      id: 'tray',
      name: 'tray.stl',
      group: 'joinery',
      note: 'will need splitting for your bed',
      make: () => {
        let maxCol = 0;
        let maxRow = 0;
        for (const t of result.tiles) { maxCol = Math.max(maxCol, t.spec.col); maxRow = Math.max(maxRow, t.spec.row); }
        const tray = trayField(makeField, {
          widthMM: (maxCol + 1) * c.tileMM,
          depthMM: (maxRow + 1) * c.tileMM,
          ...(spec.tray || {}),
        });
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
    if (msg.type === 'run') {
      spec = msg.spec;
      const t0 = Date.now();
      // `check` is about the contract, not the rock — same as the CLI.
      const runSpec = msg.mode === 'check' ? { ...spec, glacier: false } : spec;
      result = null;
      result = buildMap(runSpec, (m) => post({ type: 'progress', message: m }));
      result.name = mapName();

      post({ type: 'progress', message: 'Shading' });
      const { rgb, width, height } = shadeMap(result, { pxPerTile: msg.pxPerTile || 170 });
      const report = summarise(result, { mode: msg.mode, spec: runSpec });
      const files = manifest().map(({ id, name, group, note }) => ({ id, name, group, note }));

      post({
        type: 'report',
        report,
        files,
        elapsedMS: Date.now() - t0,
        preview: { rgb, width, height },
      }, [rgb.buffer]);
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
      const blob = await makeZip(files, {
        onProgress: (n, total, name) => post({ type: 'progress', message: `Compressing ${name} (${n}/${total})` }),
      });
      post({ type: 'zip', blob, name: `${mapName()}-tiles.zip` });
      return;
    }

    throw new Error(`unknown message: ${msg.type}`);
  } catch (err) {
    post({ type: 'error', message: err && err.message ? err.message : String(err), stack: err && err.stack });
  }
};
