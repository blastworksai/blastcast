// ClaudeBWAI — host must track the admission/call identity, not only the session id.
import test from 'node:test';
import assert from 'node:assert/strict';
import { HostCalls } from '../dist/host-calls.js';

const tick = () => new Promise(resolve => setImmediate(resolve));
async function until(predicate) {
  for (let i = 0; i < 50; i++) { if (predicate()) return; await tick(); }
  assert.fail('Expected asynchronous step did not occur');
}
class Element {
  constructor(tag = 'div') { this.tag = tag; this.children = []; this.dataset = {}; this.classList = { toggle() {} }; this.value = ''; this.textContent = ''; this.srcObject = null; }
  addEventListener() {}
  append(...c) { this.children.push(...c); for (const x of c) x.parent = this; }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter(x => x !== this); }
  setAttribute() {} pause() {} play() { return Promise.resolve(); }
}
class Stream {
  constructor() { this.tracks = [{ kind: 'audio', stop() {} }]; }
  getTracks() { return this.tracks; } getAudioTracks() { return this.tracks; } getVideoTracks() { return []; } addTrack() {}
}
const peers = [];
class Peer {
  constructor(configuration) { this.configuration = configuration; this.connectionState = 'new'; this.transceivers = []; peers.push(this); }
  addTrack(t) { return this.addTransceiver(t.kind).sender; }
  addTransceiver(kind) { const tr = { mid: null, direction: 'sendrecv', sender: { track: null, async replaceTrack() {} }, receiver: { track: { kind } } }; this.transceivers.push(tr); return tr; }
  getTransceivers() { return this.transceivers; }
  async createOffer() { return { type: 'offer', sdp: 'fixture' }; }
  async setLocalDescription() { this.transceivers.forEach((t, i) => { t.mid = String(i); }); }
  close() { this.closed = true; }
  async getStats() { return new Map(); }
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

const guest = decidedAt => ({ alive: true, revoked: false, phase: 'admitted', session: { id: 'session-1', name: 'Guest', decidedAt } });
function harness(initial) {
  const state = { guests: [guest(initial)], offers: [], polls: [], pollResult: () => ({ ok: true, messages: [] }) };
  const bridge = {
    guestStatus: async () => ({ ok: true, guests: state.guests }),
    getGuestCallConfiguration: async () => ({ ok: true, iceServers: [], iceTransportPolicy: 'all' }),
    sendGuestSignal: async (id, callId, message) => { if (message.type === 'description') state.offers.push(callId); return { ok: true }; },
    pollGuestSignals: async (id, callId) => { state.polls.push(callId); return state.pollResult(callId); },
  };
  const host = new HostCalls(bridge, new Element(), new Element(), new Element('button'));
  host.setStream(new Stream());
  return { host, state };
}

test('normal path: one peer, one callId, polled under it', async t => {
  peers.length = 0;
  const { host, state } = harness(100); t.after(() => host.close());
  await until(() => state.offers.length === 1);
  await host.poll(); await host.poll();
  assert.equal(peers.length, 1); assert.equal(peers[0].closed, undefined);
  assert.equal(state.offers.length, 1);
  assert.ok(state.polls.length > 0 && state.polls.every(id => id === state.offers[0]));
});

test('quick re-admit (new decidedAt, never seen leaving admitted) closes old peer and offers a new callId', async t => {
  peers.length = 0;
  const { host, state } = harness(100); t.after(() => host.close());
  await until(() => state.offers.length === 1);
  state.guests = [guest(250)];
  await host.poll();
  await until(() => state.offers.length === 2);
  assert.equal(peers.length, 2); assert.equal(peers[0].closed, true); assert.notEqual(peers[1].closed, true);
  assert.notEqual(state.offers[0], state.offers[1]);
});

test('broker reports the call gone (Stale callId) closes the old peer and accepts a new call', async t => {
  peers.length = 0;
  const { host, state } = harness(100); t.after(() => host.close());
  await until(() => state.offers.length === 1);
  state.pollResult = () => ({ ok: false, message: 'Stale callId.' });
  await host.poll();
  assert.equal(peers[0].closed, true);
  state.pollResult = () => ({ ok: true, messages: [] });
  await host.poll();
  await until(() => state.offers.length === 2);
  assert.equal(peers.length, 2); assert.notEqual(state.offers[0], state.offers[1]);
});
