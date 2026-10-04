// ClaudeBWAI — einh 4 Oct (r10, real hardware): airplane mode on a phone guest for ~10 s silenced its page AND its media together.
// The host released the call when presence lapsed (cancelling the ICE restart) and showed Disconnected; the call came back as a new one.
// Within the 30 s recovery window a presence lapse must not release the call and the row must say Reconnecting….
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { HostCalls } from '../dist/host-calls.js';
import { GuestCall } from '../dist/guest-call.js';
import { RECOVERY_DEADLINE_MS } from '../dist/peer-call.js';
import { admissionRowLabel } from '../dist/admission-ui.js';
import { SessionDiagnosticsLog, DrawMeter, recorderInfo } from '../dist/session-diagnostics.js';
const require = createRequire(import.meta.url);
const { validDiagnostics, createSessionDiagnostics } = require('../desktop/session-diagnostics.cjs');

const flush = () => new Promise(resolve => setImmediate(resolve));
async function until(predicate) { for (let i = 0; i < 80; i++) { if (predicate()) return; await flush(); } assert.fail('Expected asynchronous step did not occur'); }
class Element {
  constructor(tag = 'div') { this.tag = tag; this.children = []; this.dataset = {}; this.classList = { toggle() {} }; this.value = ''; this.textContent = ''; this.srcObject = null; }
  addEventListener() {} append(...c) { this.children.push(...c); for (const x of c) x.parent = this; }
  remove() {} setAttribute() {} pause() {} play() { return Promise.resolve(); }
}
class Stream {
  constructor() { this.tracks = [{ kind: 'audio', stop() {} }]; }
  getTracks() { return this.tracks; } getAudioTracks() { return this.tracks; } getVideoTracks() { return []; } addTrack() {}
}
const peers = [];
class Peer {
  constructor(configuration) { this.configuration = configuration; this.connectionState = 'new'; this.signalingState = 'stable'; this.transceivers = []; this.sent = []; peers.push(this); }
  addTrack(t) { return this.addTransceiver(t.kind).sender; }
  addTransceiver(kind) { const tr = { mid: null, direction: 'sendrecv', sender: { track: null, async replaceTrack() {}, getParameters: () => ({ encodings: [{}] }), async setParameters() {} }, receiver: { track: { kind } } }; this.transceivers.push(tr); return tr; }
  getTransceivers() { return this.transceivers; }
  async createOffer() { return { type: 'offer', sdp: 'fixture' }; }
  async createAnswer() { return { type: 'answer', sdp: 'answer' }; }
  async setLocalDescription(d) { this.signalingState = d?.type === 'offer' ? 'have-local-offer' : 'stable'; this.transceivers.forEach((t, i) => { t.mid ??= String(i); }); }
  async setRemoteDescription(d) { this.remoteDescription = d; this.signalingState = d.type === 'offer' ? 'have-remote-offer' : 'stable'; }
  async addIceCandidate() {}
  restartIce() { this.restarts = (this.restarts ?? 0) + 1; }
  close() { this.closed = true; }
  async getStats() { return new Map(); }
  drop(state) { this.connectionState = state; this.onconnectionstatechange?.(); }
}
class AudioContextFake {
  constructor() { this.state = 'suspended'; this.destination = {}; }
  createGain() { return { gain: { value: 1 }, connect() {}, disconnect() {} }; }
  async resume() { this.state = 'running'; }
  createMediaStreamDestination() { return { stream: new Stream() }; }
  createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
  close() { return Promise.resolve(); }
}
globalThis.document = { createElement: tag => new Element(tag) };
globalThis.MediaStream = Stream;
globalThis.RTCPeerConnection = Peer;
globalThis.AudioContext = AudioContextFake;

const guestRow = presence => ({ alive: true, revoked: false, phase: 'admitted', presence, session: { id: 'session-r10', name: 'Phone', decidedAt: 100 } });
async function connectedHost() {
  peers.length = 0;
  const state = { guests: [guestRow('connected')], offers: 0 };
  const bridge = {
    guestStatus: async () => ({ ok: true, guests: state.guests }),
    getGuestCallConfiguration: async () => ({ ok: true, iceServers: [], iceTransportPolicy: 'all' }),
    sendGuestSignal: async (id, callId, message) => { if (message.type === 'description' && !message.iceRestart) state.offers++; return { ok: true }; },
    pollGuestSignals: async () => ({ ok: true, messages: [] }),
  };
  const host = new HostCalls(bridge, new Element(), new Element(), new Element('button'));
  const events = []; host.onCallEvent = (slot, st, reason) => events.push({ slot, st, reason });
  host.setStream(new Stream());
  await until(() => state.offers === 1);
  const pc = peers[0]; pc.drop('connected'); await flush();
  return { host, state, pc, events };
}
const lapse = async (host, state) => { state.guests = [guestRow('disconnected')]; await until(() => !host.busy); await host.poll(); await flush(); };

test('presence lapses while the call is reconnecting: the host keeps the call and the row says Reconnecting…', async t => {
  mock.timers.enable({ apis: ['setTimeout'] });
  const { host, state, pc } = await connectedHost(); t.after(() => { host.close(); mock.timers.reset(); });
  pc.drop('disconnected'); await flush();
  await lapse(host, state);
  assert.notEqual(pc.closed, true, 'the call is not released');
  assert.equal(host.calls.size, 1);
  assert.equal(admissionRowLabel(guestRow('disconnected')), 'Reconnecting…');
});

test('recovery succeeds after the guest resumes polling: connected on the same call, label back to normal', async t => {
  mock.timers.enable({ apis: ['setTimeout'] });
  const { host, state, pc, events } = await connectedHost(); t.after(() => { host.close(); mock.timers.reset(); });
  pc.drop('disconnected'); await flush();
  await lapse(host, state);
  state.guests = [guestRow('connected')]; pc.drop('connected'); await flush(); await host.poll();
  assert.equal(peers.length, 1, 'no second call was made');
  assert.notEqual(pc.closed, true);
  assert.equal(admissionRowLabel(guestRow('connected')), 'admitted');
  assert.deepEqual(events.map(e => [e.slot, e.st, e.reason]), [[1, 'connected', 'established'], [1, 'reconnecting', 'media-lost'], [1, 'connected', 'recovered']]);
});

test('the 30 s deadline passes: the call fails, the row says Disconnected and the next poll releases it as before', async t => {
  mock.timers.enable({ apis: ['setTimeout'] });
  const { host, state, pc, events } = await connectedHost(); t.after(() => { host.close(); mock.timers.reset(); });
  pc.drop('disconnected'); await flush();
  await lapse(host, state);
  mock.timers.tick(RECOVERY_DEADLINE_MS); await flush();
  assert.equal(admissionRowLabel(guestRow('disconnected')), 'Disconnected — can rejoin from the same browser');
  await lapse(host, state);
  assert.equal(pc.closed, true);
  assert.equal(host.calls.size, 0);
  assert.deepEqual(events.slice(-2).map(e => [e.st, e.reason]), [['failed', 'recovery-failed'], ['released', 'recovery-failed']]);
});

test('control: a presence lapse on a call that is NOT recovering still releases it', async t => {
  mock.timers.enable({ apis: ['setTimeout'] });
  const { host, state, pc } = await connectedHost(); t.after(() => { host.close(); mock.timers.reset(); });
  await lapse(host, state);
  assert.equal(pc.closed, true);
});

test('guest: poll failures through an outage longer than the give-up window do not tear down a reconnecting PeerCall, and the queued restart offer is answered afterwards', async t => {
  mock.timers.enable({ apis: ['Date'] });
  peers.length = 0;
  const sent = []; let mode = 'ok'; let polls = 0;
  const api = async endpoint => {
    if (endpoint === 'call/config') return { ok: true, iceServers: [], iceTransportPolicy: 'all' };
    if (endpoint === 'call/send') { sent.push(endpoint); return { ok: true }; }
    if (mode === 'down') throw new TypeError('network');
    polls++;
    if (mode === 'ok') return { ok: true, callId: 'c'.repeat(22), latest: 1, messages: polls === 1 ? [{ sequence: 1, message: { type: 'description', description: { type: 'offer', sdp: 'o' } } }] : [] };
    return { ok: true, callId: 'c'.repeat(22), latest: 2, messages: [{ sequence: 2, message: { type: 'description', description: { type: 'offer', sdp: 'restart' }, iceRestart: true, generation: 1 } }] };
  };
  const status = new Element();
  const guest = new GuestCall(api, new Element('video'), status, new Element('button'));
  t.after(() => guest.close());
  guest.update(true, new Stream());
  await until(() => peers.length === 1 && peers[0].remoteDescription);
  const pc = peers[0]; pc.drop('connected'); await flush();
  pc.drop('disconnected'); await flush();
  assert.equal(status.dataset.callState, 'reconnecting');
  mode = 'down';
  for (let i = 0; i < 20; i++) { mock.timers.tick(6000); await until(() => !guest.busy); await guest.poll(); await flush(); } // 120 s of failures
  assert.notEqual(pc.closed, true, 'the PeerCall survives the outage');
  assert.equal(status.dataset.callState, 'reconnecting');
  mode = 'restart'; mock.timers.tick(6000); await until(() => !guest.busy); await guest.poll(); await flush();
  assert.equal(pc.remoteDescription.sdp, 'restart', 'the restart offer is taken once polling resumes');
});

test('diagnostics: a call event is written as slot + state + reason only; names, tokens and unknown values are refused', async () => {
  const sent = [];
  const log = new SessionDiagnosticsLog({ recordSessionDiagnostics: async (id, payload) => { sent.push(payload); return { ok: true }; } }, new DrawMeter(), () => ({ participants: 1, guests: [] }), recorderInfo('video/webm;codecs=vp8,opus'), 3_600_000);
  log.event(1, 'reconnecting', 'media-lost'); await flush();
  assert.deepEqual(sent, [], 'nothing before a recording runs');
  log.start('12345678-1234-1234-1234-123456789abc', 1080);
  log.event(2, 'reconnecting', 'media-lost'); log.event(0, 'connected', 'recovered'); await flush();
  const call = sent.filter(p => p.kind === 'call');
  assert.deepEqual(call, [{ kind: 'call', slot: 2, state: 'reconnecting', reason: 'media-lost' }]);
  await log.stop('complete');
  assert.equal(validDiagnostics({ kind: 'call', slot: 2, state: 'reconnecting', reason: 'media-lost' }), true);
  for (const bad of [{ kind: 'call', slot: 2, state: 'reconnecting', reason: 'media-lost', name: 'Alice' }, { kind: 'call', slot: 2, state: 'Alice', reason: 'media-lost' },
    { kind: 'call', slot: 2, state: 'failed', reason: 'tok_abcdefghijklmnopqrstuv' }, { kind: 'call', slot: 9, state: 'failed', reason: 'recovered' }, { kind: 'call', slot: 1, state: null, reason: null }])
    assert.equal(validDiagnostics(bad), false);
  const lines = []; const writer = createSessionDiagnostics({ current: () => ({ id: '12345678-1234-1234-1234-123456789abc', target: '/rec/x.webm' }), io: { appendFile: async (f, l) => { lines.push(JSON.parse(l)); } }, now: () => new Date('2026-10-04T10:00:00.000Z') });
  await writer.record('12345678-1234-1234-1234-123456789abc', { kind: 'start', quality: 1080, participants: 1, recorder: { codec: 'vp8', mimeType: 'video/webm;codecs=vp8,opus' } });
  await writer.record('12345678-1234-1234-1234-123456789abc', { kind: 'call', slot: 3, state: 'failed', reason: 'recovery-failed' });
  assert.deepEqual(lines.at(-1), { type: 'call', t: '2026-10-04T10:00:00.000Z', slot: 3, state: 'failed', reason: 'recovery-failed' });
});

test('the media heals before the page polls again: the just-recovered call is held, not released (Agy r10 P1)', async t => {
  mock.timers.reset(); mock.timers.enable({ apis: ['setTimeout'] });
  const { host, state, pc } = await connectedHost(); t.after(() => { host.close(); mock.timers.reset(); });
  pc.drop('disconnected'); await flush();
  await lapse(host, state);
  pc.drop('connected'); await flush();
  await lapse(host, state); // presence still 'disconnected' on this poll
  assert.notEqual(pc.closed, true, 'the recovered call survives the stale presence');
  assert.equal(host.calls.size, 1);
  assert.equal(peers.length, 1, 'no second call was made');
});
