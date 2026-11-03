// stl.js — binary STL. Eighty bytes of header nobody reads, a count, then
// fifty bytes per triangle. Normals are written as zero: every slicer in use
// recomputes them from the winding, and a stored normal that disagrees with
// the winding is worse than none.

export function writeSTL(tris, name = 'modular-map-builder') {
  const n = tris.length / 9;
  const buf = new ArrayBuffer(84 + n * 50);
  const view = new DataView(buf);
  const bytes = new Uint8Array(buf);
  const header = new TextEncoder().encode(name.slice(0, 79));
  bytes.set(header, 0);
  view.setUint32(80, n, true);
  let o = 84;
  for (let t = 0; t < n; t++) {
    const s = t * 9;
    view.setFloat32(o, 0, true);
    view.setFloat32(o + 4, 0, true);
    view.setFloat32(o + 8, 0, true);
    for (let v = 0; v < 9; v++) view.setFloat32(o + 12 + v * 4, tris[s + v], true);
    view.setUint16(o + 48, 0, true);
    o += 50;
  }
  return new Uint8Array(buf);
}

/** A plain rectangular plate — the 10 mm stacking plate, as a solid. */
export function plateSTL(widthMM, depthMM, heightMM) {
  const t = [];
  const v = (x, y, z) => [x, y, z];
  const quad = (a, b, c, d) => { t.push(a, b, c); t.push(a, c, d); };
  const x0 = 0, y0 = 0, x1 = widthMM, y1 = depthMM, z0 = 0, z1 = heightMM;
  quad(v(x0, y0, z1), v(x1, y0, z1), v(x1, y1, z1), v(x0, y1, z1)); // top
  quad(v(x0, y0, z0), v(x0, y1, z0), v(x1, y1, z0), v(x1, y0, z0)); // bottom
  quad(v(x0, y0, z0), v(x1, y0, z0), v(x1, y0, z1), v(x0, y0, z1)); // south
  quad(v(x1, y0, z0), v(x1, y1, z0), v(x1, y1, z1), v(x1, y0, z1)); // east
  quad(v(x1, y1, z0), v(x0, y1, z0), v(x0, y1, z1), v(x1, y1, z1)); // north
  quad(v(x0, y1, z0), v(x0, y0, z0), v(x0, y0, z1), v(x0, y1, z1)); // west
  const out = new Float32Array(t.length * 3);
  for (let i = 0; i < t.length; i++) {
    out[i * 3] = t[i][0]; out[i * 3 + 1] = t[i][1]; out[i * 3 + 2] = t[i][2];
  }
  return out;
}
