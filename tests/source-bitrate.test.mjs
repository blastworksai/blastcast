// ClaudeBWAI — "Adaptive at take start" (einh, 4 Oct 2026): the take's bitrate is chosen once from the live uplink.
import test from 'node:test';
import assert from 'node:assert/strict';
import { SourceCapture } from '../dist/source-capture.js';
import { SourceOutbox } from '../dist/source-outbox.js';
import * as bitrate from '../dist/source-bitrate.js';
import { PeerCall } from '../dist/peer-call.js';

const clock = { hostNowMs: 0, localMonoMs: 0, uncertaintyMs: 0 };
class Track { constructor() { this.readyState = 'live'; } getSettings() { return { width: 640, height: 480 }; } addEventListener() {} removeEventListener() {} }
class Stream { getVideoTracks() { return [new Track()]; } getAudioTracks() { return [new Track()]; } }
class Rec { constructor() { this.l = {}; this.state = 'inactive'; } addEventListener(e, f) { (this.l[e] ??= new Set()).add(f); } removeEventListener() {}
  start() { this.state = 'recording'; } requestData() {} stop() { this.state = 'inactive'; for (const f of this.l.stop ?? []) f(); } }
const transport = { begin: async d => ({ ok: true, episodeId: d.episodeId, epochId: d.epochId }), append: async () => ({ ok: false, message: 'x' }), finish: async () => ({ ok: false, message: 'x' }) };
async function startWith(uplink, extra = {}) {
  let bits; const opens = [];
  const capture = new SourceCapture({ transport, onState: () => {}, allowPartialSource: true, uplink,
    makeRecorder: (_s, b) => { bits = b; return new Rec(); },
    durable: () => ({ async open(d, rate) { opens.push(rate); }, async append() {}, async finish() {}, cancel() {} }), ...extra });
  await capture.start(new Stream(), { episodeId: 'ep', epochId: 'one', clock });
  await new Promise(r => setTimeout(r, 5));
  await capture.fail('test over'); // clears the capture's timers so the runner can exit
  return { bits, opens, capture };
}

test('rule: fast uplink picks 4 Mbit/s, slow 1.8, unknown 1.8; phone cap lowers the bar', () => {
  assert.equal(bitrate.chooseSourceVideoBps(12_000_000, 4_000_000), 4_000_000);
  assert.equal(bitrate.chooseSourceVideoBps(9_000_000, 4_000_000), 1_800_000);
  assert.equal(bitrate.chooseSourceVideoBps(null, 4_000_000), 1_800_000);
  assert.equal(bitrate.chooseSourceVideoBps(undefined, 1_500_000), 1_800_000);
  assert.equal(bitrate.chooseSourceVideoBps(0, 1_500_000), 1_800_000);
  assert.equal(bitrate.chooseSourceVideoBps(NaN, 1_500_000), 1_800_000);
  // phone: 1.5 + 4.128*1.25 = 6.66 Mbit/s; the same 9 Mbit/s that is too slow for desktop is fast for a phone
  assert.equal(bitrate.chooseSourceVideoBps(9_000_000, 1_500_000), 4_000_000);
  assert.equal(bitrate.chooseSourceVideoBps(6_600_000, 1_500_000), 1_800_000);
  assert.equal(bitrate.chooseSourceVideoBps(6_700_000, 1_500_000), 4_000_000);
  assert.equal(bitrate.SOURCE_AUDIO_BPS, 128_000);
});

test('the recorder is constructed with the chosen bits (fast, slow, null, no provider, throwing, hanging provider)', async () => {
  assert.deepEqual((await startWith(async () => ({ availableBps: 20e6, callCapBps: 4e6 }))).bits, { videoBitsPerSecond: 4_000_000, audioBitsPerSecond: 128_000 });
  assert.deepEqual((await startWith(async () => ({ availableBps: 3e6, callCapBps: 4e6 }))).bits, { videoBitsPerSecond: 1_800_000, audioBitsPerSecond: 128_000 });
  assert.equal((await startWith(async () => ({ availableBps: null, callCapBps: 4e6 }))).bits.videoBitsPerSecond, 1_800_000);
  assert.equal((await startWith(undefined)).bits.videoBitsPerSecond, 1_800_000);
  assert.equal((await startWith(async () => { throw new Error('stats'); })).bits.videoBitsPerSecond, 1_800_000);
});

test('a provider that never answers does not hold the take: safe rate after the probe timeout', async () => {
  const t0 = Date.now();
  const r = await startWith(() => new Promise(() => {}));
  assert.equal(r.bits.videoBitsPerSecond, 1_800_000);
  assert.ok(Date.now() - t0 < bitrate.SOURCE_PROBE_TIMEOUT_MS + 1500);
});

test('the chosen rate reaches the durable sink when the epoch opens', async () => {
  const r = await startWith(async () => ({ availableBps: 20e6, callCapBps: 4e6 }));
  assert.deepEqual(r.opens, [{ videoBps: 4_000_000, audioBps: 128_000 }]);
});

test('pace follows the rate with the old 262144 B/s floor', () => {
  assert.equal(bitrate.sourcePaceBytesPerSec(4_000_000), 619_200);
  assert.equal(bitrate.sourcePaceBytesPerSec(1_800_000), 289_200);
  assert.equal(bitrate.sourcePaceBytesPerSec(100_000), 262_144);
});

test('the outbox spaces during-recording uploads by the take rate, and 1 MiB/s after stop', async () => {
  for (const [rate, bytesPerSec] of [[{ videoBps: 4_000_000 }, 619_200], [undefined, 262_144]]) {
    const sleeps = []; let now = 0;
    const store = { async create() {}, async append() {}, async peek() { return { record: { descriptor: { episodeId: 'e', epochId: 'p' }, acked: 0, ackedBytes: 0, end: null }, item: { chunk: { episodeId: 'e', epochId: 'p', sequence: 0, byteLength: 619_200, sha256: 'a' }, bytes: new ArrayBuffer(1) } }; },
      async acknowledge() {}, async seal() {}, async complete() {}, close() {} };
    let appends = 0;
    const outbox = new SourceOutbox({ store, progress() {}, failed() {}, now: () => now, sleep: async ms => { sleeps.push(ms); now += ms; },
      transport: { begin: async d => ({ ok: true, episodeId: 'e', epochId: 'p' }), append: async c => { appends++; if (appends > 2) { outbox.cancel(); } return { ok: true, ...c }; }, finish: async () => ({ ok: false }) } });
    await outbox.open({ episodeId: 'e', epochId: 'p' }, rate);
    for (let i = 0; i < 100 && appends < 2; i++) await new Promise(r => setTimeout(r, 2));
    outbox.cancel();
    assert.ok(appends >= 2);
    // second upload waits for the first chunk (619200 B) to drain at the pace
    assert.equal(Math.round(sleeps[0]), Math.round(619_200 / bytesPerSec * 1000), `pace ${bytesPerSec}`);
  }
});

test('PeerCall.outgoingBitrate reads availableOutgoingBitrate from the selected pair, null when absent', async () => {
  const mk = stats => { const p = Object.create(PeerCall.prototype); p.pc = { getStats: async () => new Map(stats.map(s => [s.id, s])) }; p.state = 'connected'; return p; };
  const pair = extra => [{ id: 't', type: 'transport', selectedCandidatePairId: 'cp' }, { id: 'cp', type: 'candidate-pair', state: 'succeeded', ...extra }];
  assert.equal(await mk(pair({ availableOutgoingBitrate: 7_500_000 })).outgoingBitrate(), 7_500_000);
  assert.equal(await mk(pair({})).outgoingBitrate(), null);
  assert.equal(await mk([{ id: 'cp', type: 'candidate-pair', nominated: true, state: 'succeeded', availableOutgoingBitrate: 3e6 }]).outgoingBitrate(), 3e6);
  const closed = mk([]); closed.state = 'closed'; assert.equal(await closed.outgoingBitrate(), null);
});
