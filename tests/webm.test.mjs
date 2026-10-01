// CodexBWAI — deliberately small EBML fixtures exercise indexing without a codec.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { finalizeWebm, element as e, uint, ID, writeAll } from '../desktop/webm.cjs';
const b = Buffer;
// Independent test reader: follow the output's stored offsets, not producer helpers.
function unsigned(bytes, from, end) {
  let value = 0n;
  for (let at = from; at < end; at++) value = value * 256n + BigInt(bytes[at]);
  return Number(value);
}
function atElement(bytes, at) {
  const start = at;
  const width = first => { assert.ok(first > 0); return Math.clz32(first) - 23; };
  const idWidth = width(bytes[at]); const id = unsigned(bytes, at, at + idWidth); at += idWidth;
  const sizeWidth = width(bytes[at]);
  let size = BigInt(bytes[at] & (0xff >> sizeWidth));
  for (let i = 1; i < sizeWidth; i++) size = (size << 8n) | BigInt(bytes[at + i]);
  const data = at + sizeWidth;
  const end = size === (1n << BigInt(sizeWidth * 7)) - 1n ? null : data + Number(size);
  assert.ok(data <= bytes.length && (end === null || end <= bytes.length));
  return { id, start, data, end };
}
function entries(bytes, parent) {
  assert.notEqual(parent.end, null);
  const out = [];
  for (let at = parent.data; at < parent.end;) {
    const entry = atElement(bytes, at); assert.notEqual(entry.end, null); out.push(entry); at = entry.end;
  }
  return out;
}
function checkIndex(bytes) {
  const header = atElement(bytes, 0); const segment = atElement(bytes, header.end);
  assert.equal(segment.id, 0x18538067);
  const head = atElement(bytes, segment.data); assert.equal(head.id, 0x114d9b74);
  const seek = entries(bytes, entries(bytes, head)[0]);
  const position = seek.find(e => e.id === 0x53ac);
  assert.equal(unsigned(bytes, seek.find(e => e.id === 0x53ab).data, seek.find(e => e.id === 0x53ab).end), 0x1c53bb6b);
  const cues = atElement(bytes, segment.data + unsigned(bytes, position.data, position.end));
  assert.equal(cues.id, 0x1c53bb6b);
  const fields = { seek: position.end - 1, cluster: [], relative: [] };
  const times = [];
  for (const cue of entries(bytes, cues)) {
    const parts = entries(bytes, cue);
    const time = parts.find(e => e.id === 0xb3);
    const trackPosition = entries(bytes, parts.find(e => e.id === 0xb7));
    const track = trackPosition.find(e => e.id === 0xf7);
    const clusterPosition = trackPosition.find(e => e.id === 0xf1);
    const relativePosition = trackPosition.find(e => e.id === 0xf0);
    assert.equal(unsigned(bytes, track.data, track.end), 1);
    const cluster = atElement(bytes, segment.data + unsigned(bytes, clusterPosition.data, clusterPosition.end));
    assert.equal(cluster.id, 0x1f43b675);
    const timestamp = atElement(bytes, cluster.data); assert.equal(timestamp.id, 0xe7);
    const block = atElement(bytes, cluster.data + unsigned(bytes, relativePosition.data, relativePosition.end));
    assert.equal(block.id, 0xa3);
    assert.equal(bytes[block.data], 0x81); // CueTrack 1, first keyframe of this cluster.
    assert.ok(bytes[block.data + 3] & 0x80);
    const absoluteTime = unsigned(bytes, timestamp.data, timestamp.end) + bytes.readInt16BE(block.data + 1);
    assert.equal(unsigned(bytes, time.data, time.end), absoluteTime);
    times.push(absoluteTime);
    fields.cluster.push(clusterPosition.end - 1); fields.relative.push(relativePosition.end - 1);
  }
  assert.deepEqual(times, [0, 1000]);
  return fields;
}
function fixture(unknown = false) {
  const block = t => e(ID.SIMPLE, b.from([0x81, 0, t, 0x80, 1, 2, 3]));
  const cluster = time => {
    const contents = b.concat([e(ID.TIME, uint(time)), block(0), block(33)]);
    return unknown ? b.concat([b.from('1f43b675ff', 'hex'), contents]) : e(ID.CLUSTER, contents);
  };
  return b.concat([e(ID.EBML, e(0x4282, b.from('webm'))), b.from('18538067ff', 'hex'),
    e(ID.INFO, e(ID.SCALE, uint(1000000))),
    e(ID.TRACKS, e(0xae, b.concat([e(0xd7, uint(1)), e(0x83, uint(1))]))), cluster(0), cluster(1000)]);
}
for (const unknown of [false, true]) test(`indexes ${unknown ? 'unknown' : 'known'} size clusters with duration and cues`, async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'blastcast-webm-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const input = path.join(dir, 'raw'); const output = path.join(dir, 'done');
  await fs.writeFile(input, fixture(unknown));
  const result = await finalizeWebm(input, output);
  assert.equal(result.clusters, 2); assert.equal(result.cues, 2);
  assert.ok(result.durationSeconds > 1 && result.durationSeconds < 1.1);
  const bytes = await fs.readFile(output);
  const offsets = checkIndex(bytes);
  // Negative controls prove the read-back notices each independently corrupted offset.
  for (const field of [offsets.seek, ...offsets.cluster, ...offsets.relative]) {
    const corrupt = Buffer.from(bytes); corrupt[field] ^= 1;
    assert.throws(() => checkIndex(corrupt));
  }
  await assert.rejects(finalizeWebm(input, output), { code: 'EEXIST' });
});
test('truncated media never produces a final artifact', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'blastcast-webm-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const input = path.join(dir, 'raw'); const output = path.join(dir, 'done');
  await fs.writeFile(input, fixture().subarray(0, -2));
  await assert.rejects(finalizeWebm(input, output), /Truncated/);
  await assert.rejects(fs.stat(output), { code: 'ENOENT' });
});
test('writeAll handles short writes and rejects zero-progress storage', async () => {
  const pieces = [];
  await writeAll({ write: async (data, at) => { pieces.push(data[at]); return { bytesWritten: 1 }; } }, b.from([1, 2, 3]));
  assert.deepEqual(pieces, [1, 2, 3]);
  await assert.rejects(writeAll({ write: async () => ({ bytesWritten: 0 }) }, b.from([1])), /no progress/);
});

test('recorder block groups retain Opus padding and index only independent video frames', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'blastcast-webm-group-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const input = path.join(dir, 'raw'), output = path.join(dir, 'done');
  const group = (track, time, extra = []) => e(ID.GROUP, b.concat([e(ID.BLOCK, b.from([0x80|track, 0, time, 0, 1, 2, 3])), ...extra]));
  const independent = group(1, 0), dependent = group(1, 33, [e(0xfb,b.from([0xdf]))]);
  const audio = group(2, 60, [e(0x75a2,b.from([0x0f,0x42,0x40])), e(0x9b,uint(20))]);
  const cluster = e(ID.CLUSTER,b.concat([e(ID.TIME,uint(0)),independent,dependent,audio]));
  const head = b.concat([e(ID.EBML,e(0x4282,b.from('webm'))),b.from('18538067ff','hex'),
    e(ID.INFO,e(ID.SCALE,uint(1000000))),e(ID.TRACKS,e(0xae,b.concat([e(0xd7,uint(1)),e(0x83,uint(1))])))]);
  await fs.writeFile(input,b.concat([head,cluster]));
  const result = await finalizeWebm(input,output);
  assert.equal(result.cues,1); assert.ok(result.durationSeconds>=.08);
  const bytes=await fs.readFile(output),segment=atElement(bytes,atElement(bytes,0).end);
  const top=entries(bytes,segment),storedCluster=top.find(x=>x.id===ID.CLUSTER);
  assert.deepEqual(bytes.subarray(storedCluster.start,storedCluster.end),cluster,'all group bytes including DiscardPadding survive');
  const cue=entries(bytes,entries(bytes,top.find(x=>x.id===ID.CUES))[0]);
  const positions=entries(bytes,cue.find(x=>x.id===0xb7)),relative=positions.find(x=>x.id===0xf0);
  const target=atElement(bytes,storedCluster.data+unsigned(bytes,relative.data,relative.end));
  assert.deepEqual(bytes.subarray(target.start,target.end),independent,'cue points at independent group, not referenced frame');
  for (const invalid of [e(ID.GROUP,b.alloc(0)), e(ID.GROUP,b.concat([e(ID.BLOCK,b.from([0x81,0,0,0])),e(ID.BLOCK,b.from([0x81,0,0,0]))]))]) {
    await fs.writeFile(input,b.concat([head,e(ID.CLUSTER,b.concat([e(ID.TIME,uint(0)),invalid]))]));
    await assert.rejects(finalizeWebm(input,path.join(dir,'invalid')),/block group|group block/);
  }
});
