// ClaudeBWAI — dependency-free .icns writer/reader; PNG payloads only, so no image library is needed.
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
// [chunk type, pixel size]: the @2x types reuse a larger PNG.
export const ICNS_CHUNKS = [['icp4', 16], ['icp5', 32], ['icp6', 64], ['ic07', 128], ['ic08', 256], ['ic09', 512], ['ic10', 1024], ['ic11', 32], ['ic12', 64], ['ic13', 256], ['ic14', 512]];
export function pngSize(png) {
  if (!Buffer.isBuffer(png) || png.length < 24 || !png.subarray(0, 8).equals(PNG_MAGIC) || png.toString('latin1', 12, 16) !== 'IHDR') throw new Error('Not a PNG');
  return [png.readUInt32BE(16), png.readUInt32BE(20)];
}
export function writeIcns(map) {
  const chunks = ICNS_CHUNKS.map(([type, size]) => {
    const png = map[size];
    if (!png) throw new Error(`Missing ${size}px PNG for ${type}`);
    const [w, h] = pngSize(png);
    if (w !== size || h !== size) throw new Error(`PNG for ${type} is ${w}x${h}, expected ${size}x${size}`);
    const head = Buffer.alloc(8); head.write(type, 0, 'latin1'); head.writeUInt32BE(8 + png.length, 4);
    return Buffer.concat([head, png]);
  });
  const total = 8 + chunks.reduce((n, c) => n + c.length, 0);
  const head = Buffer.alloc(8); head.write('icns', 0, 'latin1'); head.writeUInt32BE(total, 4);
  return Buffer.concat([head, ...chunks]);
}
export function readIcns(buf) {
  if (buf.length < 8 || buf.toString('latin1', 0, 4) !== 'icns' || buf.readUInt32BE(4) !== buf.length) throw new Error('Not an icns file');
  const out = [];
  for (let at = 8; at < buf.length;) {
    const len = buf.readUInt32BE(at + 4);
    if (len < 8 || at + len > buf.length) throw new Error('Corrupt icns chunk');
    out.push({ type: buf.toString('latin1', at, at + 4), data: buf.subarray(at + 8, at + len) });
    at += len;
  }
  return out;
}
