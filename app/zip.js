// zip.js — a ZIP writer, because a nine-tile map is a dozen STLs and a
// browser will not hand over a dozen downloads.
//
// Deflated where the platform has CompressionStream('deflate-raw'), stored
// otherwise; both are valid ZIP and every unzipper reads them. No ZIP64:
// a map of this kind is tens of megabytes, not gigabytes.

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(bytes) {
  let crc = -1;
  for (let i = 0; i < bytes.length; i++) crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ bytes[i]) & 0xff];
  return (crc ^ -1) >>> 0;
}

export const canDeflate = typeof CompressionStream === 'function';

async function deflateRaw(bytes) {
  const cs = new CompressionStream('deflate-raw');
  const w = cs.writable.getWriter();
  w.write(bytes);
  w.close();
  const chunks = [];
  let total = 0;
  const reader = cs.readable.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.length;
  }
  const out = new Uint8Array(total);
  let o = 0;
  for (const ch of chunks) { out.set(ch, o); o += ch.length; }
  return out;
}

/** DOS date/time. Anything before 1980 is unrepresentable, so clamp. */
function dosStamp(d = new Date()) {
  const y = Math.max(1980, d.getFullYear());
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
    date: ((y - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

/**
 * files: [{ name, bytes }]. Returns a Blob.
 *
 * Each file is compressed and appended in turn, so peak memory is the output
 * plus one file, not the whole map twice over.
 */
export async function makeZip(files, { compress = canDeflate, onProgress = () => {} } = {}) {
  const enc = new TextEncoder();
  const { time, date } = dosStamp();
  const parts = [];
  const central = [];
  let offset = 0;
  let done = 0;

  for (const f of files) {
    const name = enc.encode(f.name);
    const raw = f.bytes;
    const crc = crc32(raw);
    let body = raw;
    let method = 0;
    if (compress) {
      try {
        const z = await deflateRaw(raw);
        // Only worth it if it actually got smaller.
        if (z.length < raw.length) { body = z; method = 8; }
      } catch { /* stored */ }
    }

    const lfh = new DataView(new ArrayBuffer(30));
    lfh.setUint32(0, 0x04034b50, true);
    lfh.setUint16(4, 20, true);
    lfh.setUint16(6, 0, true);
    lfh.setUint16(8, method, true);
    lfh.setUint16(10, time, true);
    lfh.setUint16(12, date, true);
    lfh.setUint32(14, crc, true);
    lfh.setUint32(18, body.length, true);
    lfh.setUint32(22, raw.length, true);
    lfh.setUint16(26, name.length, true);
    lfh.setUint16(28, 0, true);
    parts.push(new Uint8Array(lfh.buffer), name, body);

    const cdh = new DataView(new ArrayBuffer(46));
    cdh.setUint32(0, 0x02014b50, true);
    cdh.setUint16(4, 20, true);
    cdh.setUint16(6, 20, true);
    cdh.setUint16(8, 0, true);
    cdh.setUint16(10, method, true);
    cdh.setUint16(12, time, true);
    cdh.setUint16(14, date, true);
    cdh.setUint32(16, crc, true);
    cdh.setUint32(20, body.length, true);
    cdh.setUint32(24, raw.length, true);
    cdh.setUint16(28, name.length, true);
    cdh.setUint16(30, 0, true);
    cdh.setUint16(32, 0, true);
    cdh.setUint16(34, 0, true);
    cdh.setUint16(36, 0, true);
    cdh.setUint32(38, 0, true);
    cdh.setUint32(42, offset, true);
    central.push(new Uint8Array(cdh.buffer), name);

    offset += 30 + name.length + body.length;
    onProgress(++done, files.length, f.name);
  }

  let cdSize = 0;
  for (const p of central) cdSize += p.length;

  const eocd = new DataView(new ArrayBuffer(22));
  eocd.setUint32(0, 0x06054b50, true);
  eocd.setUint16(4, 0, true);
  eocd.setUint16(6, 0, true);
  eocd.setUint16(8, files.length, true);
  eocd.setUint16(10, files.length, true);
  eocd.setUint32(12, cdSize, true);
  eocd.setUint32(16, offset, true);
  eocd.setUint16(20, 0, true);

  return new Blob([...parts, ...central, new Uint8Array(eocd.buffer)], { type: 'application/zip' });
}
