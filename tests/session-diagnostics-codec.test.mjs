// ClaudeBWAI — einh 4 Oct (CP4a): decoder/encode stats, scene.backend and compositor events stay enumerated and under the payload cap.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { decoderName, GuestDeltas, DrawMeter, SessionDiagnosticsLog, logCompositorEvent, recorderInfo, videoStreams } from '../dist/session-diagnostics.js';
import { RECORDING_MIME_TYPE } from '../dist/recording.js';
const require = createRequire(import.meta.url);
const { validDiagnostics, MAX_PAYLOAD_CHARS, DECODERS, CODECS, ENCODERS, COMPOSITOR_REASONS, BACKENDS } = require('../desktop/session-diagnostics.cjs');

const recorder = recorderInfo(RECORDING_MIME_TYPE);
const scene = { framesDrawn: 150, drawnFps: 30, avgDrawMs: 4.2, maxDrawMs: 11.5, backend: 'canvas2d' };
const inbound = { codec: 'video/VP8', width: 1920, height: 1080, fps: 29.9, framesDropped: 2, framesDecoded: 148, jitter: 0.004, packetsLost: 0, decoderImplementation: 'D3D11VideoDecoder', powerEfficientDecoder: true };
const outbound = { codec: 'video/VP8', width: 640, height: 360, fps: 15, encoderImplementation: 'libvpx', powerEfficientEncoder: false, qualityLimitationReason: 'none', framesEncoded: 75, totalEncodeTime: 0.4, qpSum: 900 };
const sample = (guests, s = scene) => ({ kind: 'sample', windowMs: 5000, participants: 2, scene: s, recorder, guests });
const one = (i = inbound, o = outbound) => sample([{ slot: 1, inbound: [i], outbound: [o] }]);

test('decoder names normalise by substring, specific before generic', () => {
  assert.equal(decoderName('ExternalDecoder (D3D11VideoDecoder)'), 'D3D11VideoDecoder');
  assert.equal(decoderName('ExternalDecoder'), 'ExternalDecoder');
  assert.equal(decoderName('MediaFoundationVideoDecoder'), 'MediaFoundation');
  assert.equal(decoderName('VideoToolbox'), 'VideoToolbox');
  assert.equal(decoderName('VDAVideoDecoder'), 'VDAVideoDecoder');
  assert.equal(decoderName('FFmpegVideoDecoder'), 'FFmpeg');
  assert.equal(decoderName('libvpx'), 'libvpx');
  assert.equal(decoderName('libaom'), 'libaom');
  assert.equal(decoderName('Alice Smith'), 'other');
  assert.equal(decoderName(''), null); assert.equal(decoderName(undefined), null);
});

test('inbound decoder fields and outbound encode counters come through videoStreams and become window deltas', () => {
  const report = (frames, time, qp) => [
    { id: 'I', type: 'inbound-rtp', kind: 'video', bytesReceived: 1e6, decoderImplementation: 'ExternalDecoder (D3D11VideoDecoder)', powerEfficientDecoder: true },
    { id: 'O', type: 'outbound-rtp', kind: 'video', bytesSent: 1e6, framesEncoded: frames, totalEncodeTime: time, qpSum: qp },
  ];
  const s = videoStreams(report(10, 1, 100));
  assert.equal(s.inbound[0].video.decoderImplementation, 'D3D11VideoDecoder'); assert.equal(s.inbound[0].video.powerEfficientDecoder, true);
  const d = new GuestDeltas(), peer = {};
  assert.equal(d.sample([{ slot: 1, source: peer, entries: report(10, 1, 100) }])[0].outbound[0].framesEncoded, null);
  const second = d.sample([{ slot: 1, source: peer, entries: report(40, 1.75, 400) }])[0].outbound[0];
  assert.deepEqual([second.framesEncoded, second.totalEncodeTime, second.qpSum], [30, 0.75, 300]);
  const reset = d.sample([{ slot: 1, source: peer, entries: report(5, 0.1, 10) }])[0].outbound[0];
  assert.deepEqual([reset.framesEncoded, reset.totalEncodeTime, reset.qpSum], [null, null, null]);
});

test('maximum shape (7 guests x 4 inbound + 4 outbound, longest enum values) stays under MAX_PAYLOAD_CHARS', () => {
  const longest = list => list.reduce((a, b) => (b.length > a.length ? b : a));
  const inb = { codec: longest(CODECS), width: 16384, height: 16384, fps: 999.999, framesDropped: 1e9, framesDecoded: 1e9, jitter: 9999.999, packetsLost: 1e9,
    decoderImplementation: longest(DECODERS), powerEfficientDecoder: false };
  const out = { codec: longest(CODECS), width: 16384, height: 16384, fps: 999.999, encoderImplementation: longest(ENCODERS), powerEfficientEncoder: false, qualityLimitationReason: 'bandwidth',
    framesEncoded: 1e9, totalEncodeTime: 9999999.999, qpSum: 1e12 };
  const guests = Array.from({ length: 7 }, (_, i) => ({ slot: i + 1, inbound: Array(4).fill(inb), outbound: Array(4).fill(out) }));
  const payload = sample(guests, { ...scene, backend: longest(BACKENDS), framesDrawn: 1e6, drawnFps: 999.999, avgDrawMs: 59999.99, maxDrawMs: 59999.99 });
  const size = JSON.stringify(payload).length;
  assert.ok(size < MAX_PAYLOAD_CHARS, `${size} chars`);
  assert.equal(validDiagnostics(payload), true);
});

test('free text in any new field is refused', () => {
  assert.equal(validDiagnostics(one()), true);
  for (const bad of [
    one({ ...inbound, decoderImplementation: 'Alice Smith' }), one({ ...inbound, decoderImplementation: 'ExternalDecoder (D3D11VideoDecoder)' }),
    one({ ...inbound, powerEfficientDecoder: 'yes' }), one({ ...inbound, decoderImplementation: undefined }),
    one(inbound, { ...outbound, framesEncoded: 'many' }), one(inbound, { ...outbound, totalEncodeTime: '1s' }), one(inbound, { ...outbound, qpSum: -1 }), one(inbound, { ...outbound, qpSum: 1.5 }),
    sample([], { ...scene, backend: 'Alice' }), sample([], { ...scene, backend: 'webgl' }), sample([], { ...scene, backend: null }), sample([], { framesDrawn: 1, drawnFps: 1, avgDrawMs: 1, maxDrawMs: 1 }),
  ]) assert.equal(validDiagnostics(bad), false, JSON.stringify(bad));
  assert.equal(validDiagnostics(sample([], { ...scene, backend: 'webgl2' })), true);
});

test('compositor events: enumerated reason and backend only', () => {
  for (const reason of COMPOSITOR_REASONS) for (const backend of BACKENDS) assert.equal(validDiagnostics({ kind: 'compositor', backend, reason }), true, `${backend} ${reason}`);
  assert.deepEqual(COMPOSITOR_REASONS, ['webgl2-unavailable', 'context-lost', 'context-restored', 'fallback-canvas2d', 'recording-failed']);
  for (const bad of [{ kind: 'compositor', backend: 'webgl2', reason: 'because Alice' }, { kind: 'compositor', backend: 'vulkan', reason: 'context-lost' }, { kind: 'compositor', backend: 'webgl2', reason: null },
    { kind: 'compositor', reason: 'context-lost' }, { kind: 'compositor', backend: 'webgl2', reason: 'context-lost', note: 'x' }])
    assert.equal(validDiagnostics(bad), false, JSON.stringify(bad));
});

test('logCompositorEvent sends only inside a recording, only valid values, and never throws', async () => {
  const sent = [], ID = '12345678-1234-1234-1234-123456789abc';
  const log = new SessionDiagnosticsLog({ recordSessionDiagnostics: async (id, p) => { sent.push(p); return { ok: true }; } }, new DrawMeter(), () => ({ participants: 1, guests: [] }), recorder, 1e6);
  logCompositorEvent(log, 'context-lost', 'webgl2'); assert.equal(sent.length, 0, 'dropped outside a recording');
  log.start(ID, 1080);
  logCompositorEvent(log, 'fallback-canvas2d', 'canvas2d'); logCompositorEvent(log, 'bogus', 'canvas2d'); logCompositorEvent(log, 'context-lost', 'bogus'); logCompositorEvent(null, 'context-lost', 'webgl2');
  await log.stop('complete');
  assert.deepEqual(sent.map(p => p.kind), ['start', 'compositor', 'end']);
  assert.deepEqual(sent[1], { kind: 'compositor', backend: 'canvas2d', reason: 'fallback-canvas2d' });
  assert.equal(validDiagnostics(sent[1]), true);
  const meter = new DrawMeter(); meter.backend = 'webgl2'; assert.equal(meter.take(1000).backend, 'webgl2');
});
