// ClaudeBWAI — einh's iPhone, 3 Oct (iOS 18.7, Safari 26.6.1): MediaRecorder ignores start(timeslice) and hands over
// one blob at stop, but requestData() slices (with empty blobs between real ones). The capture must drive slices
// itself, never send an empty slice, and accept (split) one big final blob instead of refusing it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { SourceCapture } from '../dist/source-capture.js';
import { SOURCE_TRANSFER_PIECE } from '../dist/source-outbox.js';

class Track { constructor() { this.readyState = 'live'; } getSettings() { return { width: 480, height: 640 }; } addEventListener() {} removeEventListener() {} }
class Stream { constructor() { this.v = [new Track()]; this.a = [new Track()]; } getVideoTracks() { return this.v; } getAudioTracks() { return this.a; } }
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const clock = { hostNowMs: 0, localMonoMs: 0, uncertaintyMs: 0 };

class BaseRecorder {
  constructor() { this.listeners = {}; this.state = 'inactive'; this.requests = 0; this.timeslice = undefined; }
  addEventListener(event, fn) { (this.listeners[event] ??= new Set()).add(fn); }
  removeEventListener(event, fn) { this.listeners[event]?.delete(fn); }
  emit(event, data) { for (const fn of this.listeners[event] ?? []) fn(data); }
  data(size) { this.emit('dataavailable', { data: new Blob([new Uint8Array(size).fill(7)]) }); }
}
/** Safari: start(timeslice) is ignored; requestData alternates a real piece and an empty one; stop flushes the rest. */
class SafariRecorder extends BaseRecorder {
  constructor(finalBytes = 3000) { super(); this.finalBytes = finalBytes; }
  start(timeslice) { this.state = 'recording'; this.timeslice = timeslice; }
  requestData() { if (this.state !== 'recording') throw new Error('InvalidStateError'); this.requests++; this.data(this.requests % 2 ? 0 : 4000); }
  stop() { this.state = 'inactive'; if (this.finalBytes) this.data(this.finalBytes); this.data(0); this.emit('stop'); }
}
/** Chromium: honours the timeslice on its own. requestData must never be needed. */
class ChromeRecorder extends BaseRecorder {
  start(timeslice) { this.state = 'recording'; this.timeslice = timeslice; this.timer = setInterval(() => this.data(2000), timeslice); }
  requestData() { this.requests++; }
  stop() { clearInterval(this.timer); this.state = 'inactive'; this.data(500); this.emit('stop'); }
}
class Transport {
  constructor() { this.appends = []; this.finished = null; }
  async begin(d) { return { ok: true, episodeId: d.episodeId, epochId: d.epochId }; }
  async append(c, bytes) { this.appends.push({ c, size: bytes.byteLength }); return { ok: true, episodeId: c.episodeId, epochId: c.epochId, sequence: c.sequence, sha256: c.sha256, byteLength: c.byteLength }; }
  async finish(e) { this.finished = e; return { ok: true, episodeId: e.episodeId, epochId: e.epochId, bytes: this.appends.reduce((n, a) => n + a.size, 0) }; }
}
/** A durable (guest) sink like SourceOutbox: stores pieces, reports acknowledged bytes, confirms the total at finish. */
function durableSink(log) {
  return (progress) => {
    let bytes = 0;
    return {
      async open() {},
      async append(chunk, data) { assert.ok(data.byteLength > 0 && data.byteLength <= SOURCE_TRANSFER_PIECE); log.push(data.byteLength); bytes += data.byteLength; },
      async finish(end) { progress({ acknowledgedBytes: bytes, message: 'delivered' }); return { ok: true, episodeId: end.episodeId, epochId: end.epochId, bytes }; },
      cancel() {},
    };
  };
}

test('a recorder that ignores the timeslice is driven by requestData: pieces flow every slice, empty blobs are never sent', async () => {
  const transport = new Transport(); let recorder;
  const capture = new SourceCapture({ transport, onState: () => {}, allowPartialSource: true, sliceMs: 25, sliceWatchMs: 60,
    makeRecorder: () => (recorder = new SafariRecorder()) });
  await capture.start(new Stream(), { episodeId: 'ep', epochId: 'one', clock });
  assert.equal(recorder.timeslice, 25, 'the timeslice is still asked for first');
  await sleep(40);
  assert.equal(recorder.requests, 0, 'no requestData before the watch window passes');
  await sleep(300);
  assert.ok(recorder.requests >= 6, `requestData drives the recorder (${recorder.requests} requests)`);
  const live = transport.appends.length;
  assert.ok(live >= 3, `pieces reach the host while recording (${live} chunks)`);
  await capture.stop();
  const stoppedAt = recorder.requests;
  await sleep(80);
  assert.equal(recorder.requests, stoppedAt, 'the slice timer stops with the capture');
  assert.equal(capture.state.phase, 'complete');
  assert.ok(transport.appends.every(a => a.size > 0), 'no empty chunk was ever sent');
  assert.deepEqual(transport.appends.map(a => a.c.sequence), transport.appends.map((_, i) => i));
  assert.equal(transport.finished.chunkCount, transport.appends.length);
});

test('a recorder that honours the timeslice (Chromium) is never asked for requestData', async () => {
  const transport = new Transport(); let recorder;
  const capture = new SourceCapture({ transport, onState: () => {}, allowPartialSource: true, sliceMs: 20, sliceWatchMs: 60,
    makeRecorder: () => (recorder = new ChromeRecorder()) });
  await capture.start(new Stream(), { episodeId: 'ep', epochId: 'one', clock });
  await sleep(200);
  await capture.stop();
  assert.equal(recorder.requests, 0);
  assert.equal(capture.state.phase, 'complete');
  assert.ok(transport.appends.length >= 5);
});

test('a guest recorder that only delivers one large blob at stop is split into pieces and completes, not refused', async () => {
  const pieces = []; let recorder;
  const big = 10 * 1024 * 1024 + 123; // > 8 MiB, the old whole-slice limit; about a minute of Safari camera video
  const capture = new SourceCapture({ transport: new Transport(), onState: () => {}, durable: durableSink(pieces),
    sliceMs: 25, sliceWatchMs: 10_000, makeRecorder: () => (recorder = new SafariRecorder(big)) });
  await capture.start(new Stream(), { episodeId: 'ep', epochId: 'one', clock });
  await capture.stop();
  assert.equal(capture.state.phase, 'complete', capture.state.message);
  assert.equal(pieces.reduce((n, size) => n + size, 0), big);
  assert.equal(pieces.length, Math.ceil(big / SOURCE_TRANSFER_PIECE));
  assert.equal(capture.state.acknowledgedBytes, big);
});

test('a slow store draining a big final blob is not cut off while it keeps moving (the drain timeout measures a stall)', async () => {
  let recorder; const pieces = [];
  const slow = progress => { const inner = durableSink(pieces)(progress); return { ...inner, async append(c, d) { await sleep(2); return inner.append(c, d); } }; };
  const capture = new SourceCapture({ transport: new Transport(), onState: () => {}, durable: slow, drainTimeoutMs: 40,
    sliceWatchMs: 10_000, makeRecorder: () => (recorder = new SafariRecorder(40 * SOURCE_TRANSFER_PIECE)) });
  await capture.start(new Stream(), { episodeId: 'ep', epochId: 'one', clock });
  await capture.stop(); // 40 pieces at ~2+ ms each takes longer than 40 ms in total, but never stalls for 40 ms
  assert.equal(capture.state.phase, 'complete', capture.state.message);
  assert.equal(pieces.length, 40);
});

// ClaudeBWAI — Codex review of 68ea271 (P2): a stalled browser store must not let slices pile up in memory without limit.
test('a guest store that stalls bounds the unsaved backlog at 16 MiB plus one slice and ends with a plain message', async () => {
  const { DURABLE_BACKLOG_MESSAGE } = await import('../dist/source-capture.js');
  let recorder; const states = [];
  const stalled = () => ({ async open() {}, append: () => new Promise(() => {}), async finish() { throw new Error('unreachable'); }, cancel() {} });
  const capture = new SourceCapture({ transport: new Transport(), onState: s => states.push(s), durable: stalled,
    sliceWatchMs: 10_000, makeRecorder: () => (recorder = new SafariRecorder(0)) });
  await capture.start(new Stream(), { episodeId: 'ep', epochId: 'one', clock });
  const slice = 300 * 1024; // a normal Safari requestData slice
  let sent = 0;
  while (capture.state.phase === 'recording' && sent < 40 * 1024 * 1024) { recorder.data(slice); sent += slice; await sleep(0); }
  assert.equal(capture.state.phase, 'incomplete');
  assert.equal(capture.state.message, DURABLE_BACKLOG_MESSAGE);
  assert.ok(sent <= 16 * 1024 * 1024 + 2 * slice, `stopped near the bound (${sent} bytes offered)`);
});
test('normal ~300 KB slices into a working store never hit the backlog bound', async () => {
  let recorder; const pieces = [];
  const capture = new SourceCapture({ transport: new Transport(), onState: () => {}, durable: durableSink(pieces),
    sliceWatchMs: 10_000, makeRecorder: () => (recorder = new SafariRecorder(0)) });
  await capture.start(new Stream(), { episodeId: 'ep', epochId: 'one', clock });
  for (let i = 0; i < 80; i++) { recorder.data(300 * 1024); await sleep(1); } // 24 MiB in total, stored as it arrives
  await capture.stop();
  assert.equal(capture.state.phase, 'complete', capture.state.message);
  assert.equal(pieces.reduce((n, size) => n + size, 0), 80 * 300 * 1024);
});
