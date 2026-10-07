// ClaudeBWAI — session diagnostics log: renderer sample shape, main-side schema, bridge refusals, the writer and its cap.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { DrawMeter, GuestDeltas, SessionDiagnosticsLog, recorderInfo, videoStreams } from '../dist/session-diagnostics.js';
import { RECORDING_MIME_TYPE } from '../dist/recording.js';
const require = createRequire(import.meta.url);
const { createSessionDiagnostics, validDiagnostics, diagnosticsPath, processMetrics, MAX_PAYLOAD_CHARS } = require('../desktop/session-diagnostics.cjs');
const { registerRecordingBridge, STUDIO_URL } = require('../desktop/boundary.cjs');
const { createRecordingStore } = require('../desktop/recording.cjs');

const ID = '12345678-1234-1234-1234-123456789abc';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const recorder = recorderInfo(RECORDING_MIME_TYPE);
const scene = { framesDrawn: 150, drawnFps: 30, avgDrawMs: 4.2, maxDrawMs: 11.5, backend: 'canvas2d' };
const inbound = { codec: 'video/VP8', width: 1920, height: 1080, fps: 29.9, framesDropped: 2, framesDecoded: 148, jitter: 0.004, packetsLost: 0, decoderImplementation: 'D3D11VideoDecoder', powerEfficientDecoder: true };
const outbound = { codec: 'video/VP8', width: 640, height: 360, fps: 15, encoderImplementation: 'libvpx', powerEfficientEncoder: false, qualityLimitationReason: 'none', framesEncoded: 75, totalEncodeTime: 0.4, qpSum: 900 };
const start = () => ({ kind: 'start', quality: 1080, participants: 2, recorder });
const sample = (guests = [{ slot: 1, inbound: [inbound], outbound: [outbound] }]) => ({ kind: 'sample', windowMs: 5000, participants: 2, scene, recorder, guests });
// A getStats report as Chromium hands it over, with the identifying entries a careless summary would leak.
function report({ dropped = 10, decoded = 300, lost = 1, encoded = 100, encodeTime = 1, qp = 1000 } = {}) {
  return [
    { id: 'CIT01_96', type: 'codec', mimeType: 'video/VP8' },
    { id: 'IT01V', type: 'inbound-rtp', kind: 'video', codecId: 'CIT01_96', frameWidth: 1920, frameHeight: 1080, framesPerSecond: 30, framesDropped: dropped, framesDecoded: decoded, jitter: 0.005, packetsLost: lost, decoderImplementation: 'ExternalDecoder (D3D11VideoDecoder)', powerEfficientDecoder: true, bytesReceived: 9e6, trackIdentifier: 'Ada Lovelace camera' },
    { id: 'IT01A', type: 'inbound-rtp', kind: 'audio', codecId: 'CIT01_111', bytesReceived: 1e5 },
    { id: 'OT01V', type: 'outbound-rtp', kind: 'video', codecId: 'CIT01_96', frameWidth: 640, frameHeight: 360, framesPerSecond: 15, encoderImplementation: 'libvpx', powerEfficientEncoder: false, qualityLimitationReason: 'bandwidth', framesEncoded: encoded, totalEncodeTime: encodeTime, qpSum: qp, bytesSent: 4e6, rid: 'token-abc' },
    { id: 'IT02V', type: 'inbound-rtp', kind: 'video', bytesReceived: 0, jitter: 0 },
    { id: 'OT02V', type: 'outbound-rtp', kind: 'video', codecId: 'CIT01_96', bytesSent: 0, qualityLimitationReason: 'none' },
    { id: 'Lc1', type: 'local-candidate', address: '192.168.1.20', ip: '192.168.1.20', port: 50000, candidateType: 'host', usernameFragment: 'ufrag-secret' },
    { id: 'Rc1', type: 'remote-candidate', address: '203.0.113.9', candidateType: 'srflx' },
    { id: 'CP1', type: 'candidate-pair', localCandidateId: 'Lc1', remoteCandidateId: 'Rc1', state: 'succeeded' },
  ];
}

test('a renderer sample carries slots, video stats and deltas only: no names, addresses, candidates or tokens, and main accepts it', async () => {
  const sent = []; const meter = new DrawMeter();
  const peer = {}; let entries = report();
  const log = new SessionDiagnosticsLog({ recordSessionDiagnostics: async (id, payload) => { sent.push([id, payload]); return { ok: true }; } }, meter,
    () => ({ participants: 2, guests: [{ slot: 3, source: peer, entries }] }), recorder, 10);
  log.start(ID, 2160);
  for (const ms of [3, 5, 13]) meter.add(ms);
  entries = report({ dropped: 14, decoded: 450, lost: 3, encoded: 175, encodeTime: 1.5, qp: 2200 });
  await sleep(35); log.pause(); await log.stop('complete');
  const kinds = sent.map(([, payload]) => payload.kind);
  assert.equal(kinds[0], 'start'); assert.ok(kinds.includes('sample')); assert.equal(kinds.at(-1), 'end');
  for (const [id, payload] of sent) { assert.equal(id, ID); assert.equal(validDiagnostics(payload), true, JSON.stringify(payload)); }
  const first = sent.find(([, payload]) => payload.kind === 'sample')[1];
  assert.deepEqual(first.guests, [{ slot: 3,
    inbound: [{ codec: 'video/VP8', width: 1920, height: 1080, fps: 30, framesDropped: 4, framesDecoded: 150, jitter: 0.005, packetsLost: 2, decoderImplementation: 'D3D11VideoDecoder', powerEfficientDecoder: true }],
    outbound: [{ codec: 'video/VP8', width: 640, height: 360, fps: 15, encoderImplementation: 'libvpx', powerEfficientEncoder: false, qualityLimitationReason: 'bandwidth', framesEncoded: 75, totalEncodeTime: 0.5, qpSum: 1200 }] }]);
  assert.deepEqual(first.scene, { framesDrawn: 3, drawnFps: first.scene.drawnFps, avgDrawMs: 7, maxDrawMs: 13, backend: 'canvas2d' });
  assert.deepEqual(first.recorder, { codec: 'vp8', mimeType: 'video/webm;codecs=vp8,opus' });
  assert.deepEqual(sent[0][1], { kind: 'start', quality: 2160, participants: 2, recorder });
  const text = JSON.stringify(sent);
  for (const leak of ['192.168', '203.0.113', 'Ada', 'ufrag', 'token', 'candidate', 'IT01', 'OT01', 'address']) assert.equal(text.includes(leak), false, leak);
});

test('deltas are null on first sight and after a counter reset; a new peer starts fresh; idle transceivers are skipped', () => {
  assert.deepEqual([videoStreams(report()).inbound.length, videoStreams(report()).outbound.length], [1, 1]);
  const deltas = new GuestDeltas(); const peer = {};
  assert.equal(deltas.sample([{ slot: 1, source: peer, entries: report() }])[0].inbound[0].framesDropped, null);
  assert.equal(deltas.sample([{ slot: 1, source: peer, entries: report({ dropped: 12 }) }])[0].inbound[0].framesDropped, 2);
  assert.equal(deltas.sample([{ slot: 1, source: peer, entries: report({ dropped: 1 }) }])[0].inbound[0].framesDropped, null);
  assert.equal(deltas.sample([{ slot: 1, source: {}, entries: report({ dropped: 50 }) }])[0].inbound[0].framesDropped, null);
  // A value outside the shared patterns becomes null rather than getting the sample refused.
  const odd = report(); odd[3] = { ...odd[3], encoderImplementation: 'Encoder at 10.0.0.5', frameWidth: 1e9 };
  const [stream] = videoStreams(odd).outbound;
  assert.equal(stream.video.encoderImplementation, 'other'); assert.equal(stream.video.width, null);
});

// ClaudeBWAI — Codex review of 68ea271 (P2): every string is enumerated; free text never reaches the log.
test('renderer maps codec and encoder names onto the enumerated sets', async () => {
  const { codecName, encoderName } = await import('../dist/session-diagnostics.js');
  assert.equal(encoderName('SimulcastEncoderAdapter (libvpx, libvpx)'), 'SimulcastEncoderAdapter');
  assert.equal(encoderName('libvpx'), 'libvpx');
  assert.equal(encoderName('MediaFoundationVideoEncodeAccelerator'), 'MediaFoundationVideoEncoder');
  assert.equal(encoderName('Alice Smith'), 'other');
  assert.equal(encoderName(undefined), null);
  assert.equal(codecName('video/vp8'), 'video/VP8');
  assert.equal(codecName('video/AbCdEfGhIjKlMnOpQrStUv'), 'other');
});
test('main refuses a name or a token in any string field (encoder, codec, recorder)', () => {
  const token = 'Ab3_dE-fGh1jKlMnOpQrStUvWxYz0123456789abcde'; // 43 base64url characters
  for (const payload of [
    sample([{ slot: 1, inbound: [], outbound: [{ ...outbound, encoderImplementation: 'Alice Smith' }] }]),
    sample([{ slot: 1, inbound: [], outbound: [{ ...outbound, encoderImplementation: token }] }]),
    sample([{ slot: 1, inbound: [], outbound: [{ ...outbound, encoderImplementation: 'libvpx2' }] }]),
    sample([{ slot: 1, inbound: [{ ...inbound, codec: 'video/AbCdEfGhIjKlMnOpQrStUvWx' }], outbound: [] }]),
    sample([{ slot: 1, inbound: [], outbound: [{ ...outbound, codec: `video/${token.slice(0, 24)}` }] }]),
    { ...start(), recorder: { codec: 'alicesmith', mimeType: 'video/webm;codecs=vp8,opus' } },
    { ...start(), recorder: { codec: 'vp8', mimeType: 'video/webm;codecs=alicesmith' } },
    sample([{ slot: 1, inbound: [], outbound: [{ ...outbound, qualityLimitationReason: 'Alice' }] }]),
  ]) assert.equal(validDiagnostics(payload), false, JSON.stringify(payload));
  for (const encoderImplementation of ['libvpx', 'SimulcastEncoderAdapter', 'MediaFoundationVideoEncoder', 'VideoToolbox', 'ExternalEncoder', 'other'])
    assert.equal(validDiagnostics(sample([{ slot: 1, inbound: [], outbound: [{ ...outbound, encoderImplementation }] }])), true, encoderImplementation);
});

test('main refuses a misshapen, oversized, identifying or path-carrying payload', () => {
  assert.equal(validDiagnostics(start()), true); assert.equal(validDiagnostics(sample()), true); assert.equal(validDiagnostics({ kind: 'end', outcome: 'complete' }), true);
  const refused = [
    null, [], 'start', { kind: 'unknown' }, { ...start(), path: '/home/einh/x.jsonl' }, { ...start(), file: '../../etc/passwd' }, { ...start(), quality: 720 },
    { ...sample(), name: 'Ada' }, sample([{ slot: 1, name: 'Ada', inbound: [], outbound: [] }]), sample([{ slot: 0, inbound: [], outbound: [] }]),
    sample([{ slot: 1, inbound: [{ ...inbound, address: '192.168.1.2' }], outbound: [] }]),
    sample([{ slot: 1, inbound: [{ ...inbound, codec: '../../video' }], outbound: [] }]),
    sample([{ slot: 1, inbound: [], outbound: [{ ...outbound, encoderImplementation: 'relay 203.0.113.9' }] }]),
    sample([{ slot: 1, inbound: [], outbound: [{ ...outbound, encoderImplementation: 'C:\\Users\\einh' }] }]),
    sample([{ slot: 1, inbound: [{ ...inbound, fps: -1 }], outbound: [] }]),
    sample(Array.from({ length: 8 }, (_, i) => ({ slot: (i % 7) + 1, inbound: [], outbound: [] }))),
    { ...start(), recorder: { codec: 'vp8', mimeType: 'video/webm;codecs=vp8,opus', extra: 1 } },
    { ...sample(), scene: { ...scene, maxDrawMs: 'slow' } },
    { kind: 'end', outcome: 'complete', t: 'forged' },
  ];
  for (const payload of refused) assert.equal(validDiagnostics(payload), false, JSON.stringify(payload));
  const big = sample([{ slot: 1, inbound: [inbound, inbound, inbound, inbound], outbound: [outbound, outbound, outbound, outbound] }]);
  assert.equal(validDiagnostics(big), true);
  assert.equal(validDiagnostics({ ...start(), recorder: { codec: 'vp8', mimeType: `video/webm;codecs=${'a'.repeat(MAX_PAYLOAD_CHARS)}` } }), false);
});

test('the recording bridge refuses a foreign frame, a bad id, a misshapen or oversized payload and an extra path argument', () => {
  const handlers = new Map(); const calls = [];
  const frame = { url: STUDIO_URL }; const contents = { mainFrame: frame, isDestroyed: () => false };
  let activated = true;
  registerRecordingBridge({ handle: (name, method) => handlers.set(name, method) }, () => contents, {
    append() {}, finish() {}, abort() {}, diagnostics: (...args) => { calls.push(args); return { ok: true }; } }, () => activated);
  const handler = handlers.get('blastcast:recordSessionDiagnostics'); const event = { sender: contents, senderFrame: frame };
  assert.deepEqual(handler(event, ID, start()), { ok: true });
  assert.throws(() => handler({ ...event, sender: {} }, ID, start()));
  assert.throws(() => handler(event, 'not-a-uuid', start()));
  assert.throws(() => handler(event, ID, start(), '/arbitrary/path'));
  assert.throws(() => handler(event, ID));
  assert.throws(() => handler(event, ID, { ...start(), path: '/tmp/x' }));
  assert.throws(() => handler(event, ID, { ...start(), recorder: { codec: 'vp8', mimeType: 'x'.repeat(MAX_PAYLOAD_CHARS + 1) } }));
  activated = false; assert.throws(() => handler(event, ID, start()), /activation/);
  assert.equal(calls.length, 1);
});

test('the writer appends JSONL beside the recording, in order, and only for the active recording', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'blastcast-diagnostics-'));
  try {
    const store = createRecordingStore({ folder: () => root });
    const begin = await store.begin(); assert.equal(begin.ok, true);
    const expected = path.join(root, begin.name.replace(/\.webm$/, '-diagnostics.jsonl'));
    assert.equal(diagnosticsPath(store.current().target), expected);
    const metrics = [{ type: 'Browser', cpu: { percentCPUUsage: 3.25 }, memory: { workingSetSize: 100 } }, { type: 'Tab', cpu: { percentCPUUsage: 40 }, memory: { workingSetSize: 500 } },
      { type: 'Tab', cpu: { percentCPUUsage: 1 }, memory: { workingSetSize: 50 } }, { type: 'GPU', cpu: { percentCPUUsage: 12 }, memory: { workingSetSize: 300 } }];
    const writer = createSessionDiagnostics({ current: store.current, metrics: () => metrics, info: async () => ({ app: '0.2.3', cpuCores: 8 }), now: () => new Date('2026-10-03T10:00:00.000Z') });
    assert.deepEqual(await writer.record(begin.id, sample()), { ok: false }, 'a sample before start is refused');
    assert.deepEqual(await writer.record('00000000-0000-0000-0000-000000000000', start()), { ok: false }, 'another recording id is refused');
    assert.deepEqual(await writer.record(begin.id, { ...start(), path: path.join(root, 'evil.jsonl') }), { ok: false });
    assert.deepEqual(await writer.record(begin.id, start()), { ok: true });
    assert.deepEqual(await writer.record(begin.id, start()), { ok: false }, 'one start per recording');
    await Promise.all([writer.record(begin.id, sample()), writer.record(begin.id, sample())]);
    assert.deepEqual(await writer.record(begin.id, { kind: 'end', outcome: 'complete' }), { ok: true });
    assert.deepEqual(await writer.record(begin.id, sample()), { ok: false }, 'nothing after the end line');
    const lines = (await fs.readFile(expected, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    assert.deepEqual(lines.map(line => line.type), ['start', 'sample', 'sample', 'end']);
    assert.deepEqual(lines[0], { type: 'start', t: '2026-10-03T10:00:00.000Z', app: '0.2.3', cpuCores: 8, quality: 1080, participants: 2, recorder });
    assert.deepEqual(lines[1].process, { cpu: 56.3, memoryKiB: 950, byType: { Browser: { count: 1, cpu: 3.3, memoryKiB: 100 }, Renderer: { count: 2, cpu: 41, memoryKiB: 550 }, GPU: { count: 1, cpu: 12, memoryKiB: 300 } } });
    assert.deepEqual(lines[1].guests, sample().guests);
    assert.equal((await fs.readdir(root)).filter(name => !name.endsWith('.partial')).length, 1, 'only the diagnostics file sits beside the partial recording');
    if (process.platform !== 'win32') assert.equal((await fs.stat(expected)).mode & 0o777, 0o600);
    await store.abort(begin.id);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('the writer stops at the size cap and never grows past it', async () => {
  const appended = [];
  const io = { appendFile: async (file, line) => { appended.push([file, line]); } };
  const writer = createSessionDiagnostics({ current: () => ({ id: ID, target: '/rec/BlastCast-x.webm' }), io, maxBytes: 2000 });
  assert.equal((await writer.record(ID, start())).ok, true);
  let results = [];
  for (let i = 0; i < 20; i++) results.push((await writer.record(ID, sample())).ok);
  const bytes = appended.reduce((sum, [, line]) => sum + Buffer.byteLength(line), 0);
  assert.ok(bytes <= 2000, `${bytes} bytes`); assert.ok(results.includes(false)); assert.equal(results.indexOf(true, results.indexOf(false)), -1, 'once full, it stays off');
  assert.ok(appended.every(([file]) => file === path.join('/rec', 'BlastCast-x-diagnostics.jsonl')));
});

test('an I/O failure is swallowed: the writer stops logging and never throws, and the recording keeps going', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'blastcast-diagnostics-'));
  try {
    const store = createRecordingStore({ folder: () => root });
    const begin = await store.begin();
    let attempts = 0;
    const io = { appendFile: async () => { attempts++; throw Object.assign(new Error('disk gone'), { code: 'EIO' }); } };
    const writer = createSessionDiagnostics({ current: store.current, io });
    assert.deepEqual(await writer.record(begin.id, start()), { ok: false });
    assert.deepEqual(await writer.record(begin.id, sample()), { ok: false });
    assert.equal(attempts, 1, 'no retry after a failure');
    const broken = createSessionDiagnostics({ current: () => { throw new Error('store'); } });
    assert.deepEqual(await broken.record(begin.id, start()), { ok: false });
    const failingInfo = createSessionDiagnostics({ current: store.current, io: { appendFile: async () => {} }, info: async () => { throw new Error('gpu'); } });
    assert.deepEqual(await failingInfo.record(begin.id, start()), { ok: false });
    assert.deepEqual(await store.append(begin.id, 0, new Uint8Array([1, 2, 3]).buffer), { ok: true, bytes: 3 });
    await store.abort(begin.id);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('the renderer log turns itself off after a refusal or a rejected bridge call', async () => {
  let calls = 0;
  const log = new SessionDiagnosticsLog({ recordSessionDiagnostics: async () => { calls++; throw new Error('Invalid recording request'); } }, new DrawMeter(),
    () => ({ participants: 1, guests: [] }), recorder, 5);
  log.start(ID, 1080); await sleep(40); await log.stop('error');
  assert.equal(calls, 1);
  assert.deepEqual(processMetrics(null), { cpu: 0, memoryKiB: 0, byType: {} });
  const meter = new DrawMeter(); assert.deepEqual(meter.take(5000), { framesDrawn: 0, drawnFps: 0, avgDrawMs: null, maxDrawMs: null, backend: 'canvas2d' });
});
