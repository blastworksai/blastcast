// CodexBWAI — bounded, non-transcoding finalizer for Electron's WebM recorder.
// Reads EBML headers by offset. Media payload is copied in 1 MiB blocks, never accumulated.
const fs = require('node:fs/promises');
const ID = { EBML: 0x1a45dfa3, SEGMENT: 0x18538067, INFO: 0x1549a966, TRACKS: 0x1654ae6b,
  CLUSTER: 0x1f43b675, TIME: 0xe7, SIMPLE: 0xa3, GROUP: 0xa0, BLOCK: 0xa1, SCALE: 0x2ad7b1,
  DURATION: 0x4489, CUES: 0x1c53bb6b, SEEK: 0x114d9b74 };
const MAX_METADATA = 1024 * 1024;
const MAX_CLUSTERS = 100000;
function vint(bytes, at = 0, keepMarker = false) {
  const first = bytes[at];
  if (!first) throw new Error('Invalid EBML integer');
  let length = 1;
  while (!(first & (0x80 >> (length - 1)))) length++;
  if (length > 8 || at + length > bytes.length) throw new Error('Truncated EBML integer');
  let value = BigInt(keepMarker ? first : first & ((0x80 >> (length - 1)) - 1));
  for (let i = 1; i < length; i++) value = (value << 8n) | BigInt(bytes[at + i]);
  const unknown = !keepMarker && value === (1n << BigInt(7 * length)) - 1n;
  if (!unknown && value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('EBML value exceeds supported size');
  return { length, value: unknown ? null : Number(value) };
}
function size(value, width) {
  const n = BigInt(value);
  let length = width ?? 1;
  while (n >= (1n << BigInt(7 * length)) - 1n) length++;
  if (length > 8) throw new Error('EBML size overflow');
  let encoded = n | (1n << BigInt(7 * length));
  const bytes = Buffer.alloc(length);
  for (let i = length - 1; i >= 0; i--) { bytes[i] = Number(encoded & 255n); encoded >>= 8n; }
  return bytes;
}
function idBytes(id) { return Buffer.from(id.toString(16).padStart(id.toString(16).length + id.toString(16).length % 2, '0'), 'hex'); }
function element(id, data) { return Buffer.concat([idBytes(id), size(data.length), data]); }
function uint(value) {
  let n = BigInt(value); let hex = n.toString(16); if (hex.length % 2) hex = '0' + hex;
  return Buffer.from(hex, 'hex');
}
function number(bytes) {
  if (!bytes.length || bytes.length > 8) throw new Error('Invalid EBML unsigned value');
  let n = 0n; for (const b of bytes) n = (n << 8n) | BigInt(b);
  if (n > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('EBML integer overflow');
  return Number(n);
}
async function read(handle, at, count) {
  const data = Buffer.alloc(count); let got = 0;
  while (got < count) { const r = await handle.read(data, got, count - got, at + got); if (!r.bytesRead) throw new Error('Truncated WebM'); got += r.bytesRead; }
  return data;
}
async function header(handle, at, end) {
  const bytes = await read(handle, at, Math.min(16, end - at));
  const id = vint(bytes, 0, true); const len = vint(bytes, id.length);
  const data = at + id.length + len.length;
  const stop = len.value === null ? null : data + len.value;
  if (data > end || (stop !== null && stop > end)) throw new Error('Truncated WebM element');
  return { id: id.value, at, data, end: stop };
}
function children(data) {
  const result = []; let at = 0;
  while (at < data.length) {
    const id = vint(data, at, true); const len = vint(data, at + id.length);
    const start = at + id.length + len.length;
    if (len.value === null || start + len.value > data.length) throw new Error('Invalid WebM metadata');
    const end = start + len.value;
    result.push({ id: id.value, data: data.subarray(start, end), raw: data.subarray(at, end) }); at = end;
  }
  return result;
}
async function blockHeader(source, block, timestamp) {
  const prefix = await read(source, block.data, Math.min(12, block.end - block.data));
  const track = vint(prefix);
  if (!track.value || prefix.length < track.length + 3 || timestamp === undefined) throw new Error('Invalid WebM block');
  return { track: track.value, time: timestamp + prefix.readInt16BE(track.length), flags: prefix[track.length + 2] };
}
async function writeAll(handle, data) {
  let at = 0;
  while (at < data.length) { const { bytesWritten } = await handle.write(data, at, data.length - at); if (!bytesWritten) throw new Error('Recording write made no progress'); at += bytesWritten; }
}
async function finalizeWebm(input, output, io = fs) {
  const source = await io.open(input, 'r'); let target;
  try {
    const total = (await source.stat()).size;
    const ebml = await header(source, 0, total);
    if (ebml.id !== ID.EBML || ebml.end === null || ebml.end > MAX_METADATA) throw new Error('Unsupported WebM header');
    const segment = await header(source, ebml.end, total);
    if (segment.id !== ID.SEGMENT || (segment.end !== null && segment.end !== total)) throw new Error('Unsupported WebM segment');
    let at = segment.data; let info; let tracks; let scale = 1000000; let videoTrack;
    let maxTime = -1; const clusters = []; const cues = [];
    while (at < total) {
      const h = await header(source, at, total);
      if (h.id === ID.INFO || h.id === ID.TRACKS) {
        if (h.end === null || h.end - h.data > MAX_METADATA) throw new Error('WebM metadata too large');
        const data = await read(source, h.data, h.end - h.data);
        if (h.id === ID.INFO) {
          if (info) throw new Error('Duplicate WebM info');
          info = children(data).filter(e => e.id !== ID.DURATION).map(e => e.raw);
          const stamp = children(data).find(e => e.id === ID.SCALE); if (stamp) scale = number(stamp.data);
          if (scale <= 0) throw new Error('Invalid timestamp scale');
        } else {
          if (tracks) throw new Error('Duplicate WebM tracks');
          tracks = element(ID.TRACKS, data);
          for (const entry of children(data).filter(e => e.id === 0xae)) {
            const fields = children(entry.data);
            if (fields.some(e => e.id === 0x83 && number(e.data) === 1)) {
              const track = fields.find(e => e.id === 0xd7); if (track) videoTrack = number(track.data);
            }
          }
        }
        at = h.end;
      } else if (h.id === ID.CLUSTER) {
        if (!info || !tracks || !videoTrack) throw new Error('Missing WebM video metadata');
        if (clusters.length >= MAX_CLUSTERS) throw new Error('WebM cluster limit exceeded');
        const end = h.end ?? total; let p = h.data; let timestamp; let keyframe;
        while (p < end) {
          const child = await header(source, p, end);
          if (h.end === null && [ID.CLUSTER, ID.CUES, ID.INFO, ID.TRACKS, ID.SEEK].includes(child.id)) break;
          if (child.end === null) throw new Error('Unsupported unknown-size cluster child');
          if (child.id === ID.TIME) {
            if (child.end - child.data > 8) throw new Error('Invalid cluster time');
            timestamp = number(await read(source, child.data, child.end - child.data));
          } else if (child.id === ID.SIMPLE) {
            const block = await blockHeader(source, child, timestamp);
            maxTime = Math.max(maxTime, block.time);
            if (block.track === videoTrack && (block.flags & 0x80) && !keyframe) keyframe = { time: block.time, relative: child.at - h.data };
          } else if (child.id === ID.GROUP) {
            // Chromium emits a final Opus BlockGroup with DiscardPadding. Keep its
            // bytes verbatim; inspect only bounded headers for timestamps and cues.
            // Format reference: https://www.webmproject.org/docs/container/#cluster
            let block, referenced = false, blockDuration = 0;
            for (let q = child.data; q < child.end;) {
              const field = await header(source, q, child.end);
              if (field.end === null) throw new Error('Unknown-size WebM block group field');
              if (field.id === ID.BLOCK) {
                if (block) throw new Error('Duplicate WebM group block');
                block = await blockHeader(source, field, timestamp);
              } else if (field.id === 0xfb) referenced = true;
              else if (field.id === 0x9b) {
                if (field.end - field.data > 8) throw new Error('Invalid block duration');
                blockDuration = number(await read(source, field.data, field.end - field.data));
              }
              q = field.end;
            }
            if (!block || !Number.isSafeInteger(block.time + blockDuration)) throw new Error('Invalid WebM block group');
            maxTime = Math.max(maxTime, block.time + blockDuration);
            // BlockGroup keyframes have no ReferenceBlock; the Block flags do not mark keyframes.
            if (block.track === videoTrack && !referenced && !keyframe) keyframe = { time: block.time, relative: child.at - h.data };
          }
          p = child.end;
        }
        if (timestamp === undefined) throw new Error('Missing cluster timestamp');
        if (keyframe) cues.push({ ...keyframe, index: clusters.length });
        clusters.push({ start: h.at, end: p }); at = p;
      } else {
        if (h.end === null) throw new Error('Unknown-size WebM element');
        at = h.end; // Old indexes and optional metadata are replaced, not interpreted as media.
      }
    }
    if (!clusters.length || !cues.length || maxTime < 0) throw new Error('No complete seekable video frames');
    const duration = Buffer.alloc(8); duration.writeDoubleBE(maxTime + 34 * 1000000 / scale);
    const newInfo = element(ID.INFO, Buffer.concat([...info, element(ID.DURATION, duration)]));
    const ebmlBytes = await read(source, 0, ebml.end);
    // Fixed-width offsets keep SeekHead length constant while positions are calculated.
    function seekHead(position) {
      const pos = Buffer.alloc(8); pos.writeBigUInt64BE(BigInt(position));
      return element(ID.SEEK, element(0x4dbb, Buffer.concat([element(0x53ab, idBytes(ID.CUES)), element(0x53ac, pos)])));
    }
    const prefixLength = seekHead(0).length + newInfo.length + tracks.length;
    let offset = prefixLength;
    for (const cluster of clusters) { cluster.offset = offset; offset += cluster.end - cluster.start; }
    const index = element(ID.CUES, Buffer.concat(cues.map(cue => element(0xbb, Buffer.concat([
      element(0xb3, uint(Math.max(0, cue.time))), element(0xb7, Buffer.concat([
        element(0xf7, uint(videoTrack)), element(0xf1, uint(clusters[cue.index].offset)), element(0xf0, uint(cue.relative)),
      ])),
    ])))));
    target = await io.open(output, 'wx', 0o600);
    await writeAll(target, Buffer.concat([ebmlBytes, idBytes(ID.SEGMENT), size(offset + index.length, 8), seekHead(offset), newInfo, tracks]));
    for (const cluster of clusters) {
      for (let p = cluster.start; p < cluster.end;) {
        const count = Math.min(MAX_METADATA, cluster.end - p);
        await writeAll(target, await read(source, p, count)); p += count;
      }
    }
    await writeAll(target, index); await target.sync();
    return { durationSeconds: duration.readDoubleBE() * scale / 1e9, clusters: clusters.length, cues: cues.length, copyBufferBytes: MAX_METADATA };
  } finally {
    // Both handles close even when the first close itself fails.
    try { if (target) await target.close(); } finally { await source.close(); }
  }
}
module.exports = { finalizeWebm, writeAll, element, uint, ID };
