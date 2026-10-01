// CodexBWAI — exercise the shipping callers with controlled call/config delays.
import test from 'node:test';
import assert from 'node:assert/strict';
import { HostCalls } from '../dist/host-calls.js';
import { GuestCall } from '../dist/guest-call.js';

const relay = { ok: true, iceServers: [{ urls: 'turn:relay.expressturn.com:3478', username: 'fixture', credential: 'fixture' }], iceTransportPolicy: 'relay' };
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const tick = () => new Promise(resolve => setImmediate(resolve));
async function until(predicate) {
  for (let i = 0; i < 30; i++) { if (predicate()) return; await tick(); }
  assert.fail('Expected asynchronous call step did not occur');
}

class Element {
  constructor(tag = 'div') { this.tag = tag; this.children = []; this.dataset = {}; this.classList = { toggle() {} }; this.listeners = {}; this.value = ''; this.textContent = ''; this.srcObject = null; }
  addEventListener(type, fn) { this.listeners[type] = fn; }
  click() { this.listeners.click?.(); }
  append(...children) { this.children.push(...children); for (const child of children) child.parent = this; }
  querySelectorAll(tag) { return this.children.flatMap(child => [...(child.tag === tag ? [child] : []), ...child.querySelectorAll(tag)]); }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this); }
  setAttribute() {}
  pause() {}
  play() { return Promise.resolve(); }
}
class Stream {
  constructor() { this.tracks = [{ kind: 'audio', stopped: false, stop() { this.stopped = true; } }]; }
  getTracks() { return this.tracks; }
  getAudioTracks() { return this.tracks; }
  getVideoTracks() { return []; }
  addTrack(track) { this.tracks.push(track); }
}
const peers = [];
class Peer {
  constructor(configuration) { this.configuration = configuration; this.connectionState = 'new'; this.transceivers = []; this.localDescription = null; peers.push(this); }
  addTrack(track) { return this.addTransceiver(track.kind).sender; }
  addTransceiver(kind, options = {}) {
    const sender = { track: null, async replaceTrack(track) { this.track = track; } };
    const transceiver = { mid: null, direction: options.direction ?? 'sendrecv', sender, receiver: { track: { kind } } };
    this.transceivers.push(transceiver); return transceiver;
  }
  getTransceivers() { return this.transceivers; }
  async createOffer() { return { type: 'offer', sdp: 'fixture' }; }
  async setLocalDescription(description) { this.localDescription = description; this.transceivers.forEach((transceiver, i) => { transceiver.mid = String(i); }); }
  close() { this.closed = true; }
  async getStats() { return new Map(); }
}
class AudioContextFake {
  constructor() { this.state = 'suspended'; this.destination = {}; }
  createGain() { return { gain: { value: 1 }, connect() {}, disconnect() {} }; }
  async resume() { this.state = 'running'; }
  createMediaStreamDestination() { return { stream: new Stream() }; }
  createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
  close() { this.state = 'closed'; return Promise.resolve(); }
}
globalThis.document = { createElement: tag => new Element(tag) };
globalThis.MediaStream = Stream;
globalThis.RTCPeerConnection = Peer;
globalThis.AudioContext = AudioContextFake;

const entry = { alive: true, revoked: false, phase: 'admitted', session: { id: 'session-1', name: 'Guest' } };
function hostHarness() {
  const config = [], signals = [], container = new Element(), bridge = {
    guestStatus: async () => ({ ok: true, guests: [entry] }),
    getGuestCallConfiguration: () => { const item = deferred(); config.push(item); return item.promise; },
    sendGuestSignal: async (...args) => { signals.push(args); return { ok: true }; },
    pollGuestSignals: async () => ({ ok: true, messages: [] }),
  };
  const host = new HostCalls(bridge, container, new Element(), new Element('button'));
  const stream = new Stream();
  host.setStream(stream);
  return { host, stream, bridge, config, signals, container };
}
function guestHarness() {
  const fixture = { callId: 'call-1' };
  const config = [], signals = [], polls = [], api = (endpoint, body) => {
    if (endpoint === 'call/config') { const item = deferred(); config.push(item); return item.promise; }
    if (endpoint === 'call/poll') { polls.push(body); return Promise.resolve({ ok: true, callId: fixture.callId, messages: [], latest: 0 }); }
    signals.push({ endpoint, body }); return Promise.resolve({ ok: true });
  };
  const guest = new GuestCall(api, new Element('video'), new Element(), new Element('button'));
  const stream = new Stream();
  return { guest, stream, config, signals, polls, fixture };
}

test('both production callers pass admitted relay configuration to their peer', async t => {
  peers.length = 0;
  const h = hostHarness(); const g = guestHarness();
  t.after(() => { h.host.close(); g.guest.close(); });
  g.guest.update(true, g.stream);
  await until(() => h.config.length === 1 && g.config.length === 1);
  h.config[0].resolve(relay); g.config[0].resolve(relay);
  await until(() => peers.length === 2 && h.signals.some(([, , message]) => message.type === 'description'));
  for (const peer of peers) assert.deepEqual(peer.configuration, { iceServers: relay.iceServers, iceTransportPolicy: 'relay' });
  assert.equal(h.signals.filter(([, , message]) => message.type === 'description').length, 1);
  assert.equal(h.stream.tracks[0].stopped, false);
  assert.equal(g.stream.tracks[0].stopped, false);
});

test('guest stop and preview replacement discard delayed configuration without signaling or stopping originals', async t => {
  peers.length = 0;
  const g = guestHarness(); t.after(() => g.guest.close());
  g.guest.update(true, g.stream);
  await until(() => g.config.length === 1);
  g.guest.update(false, null);
  g.config[0].resolve(relay); await tick();
  assert.equal(peers.length, 0); assert.deepEqual(g.signals, []);
  const replacement = new Stream();
  g.fixture.callId = 'call-2';
  g.guest.update(true, replacement);
  await until(() => g.config.length === 2);
  const newer = new Stream();
  g.guest.update(true, newer);
  g.config[1].resolve(relay); await tick();
  assert.equal(peers.length, 0); assert.deepEqual(g.signals, []);
  assert.equal(g.stream.tracks[0].stopped, false);
  assert.equal(replacement.tracks[0].stopped, false);
  assert.equal(newer.tracks[0].stopped, false);
});

test('host removal, reconnect, and preview replacement discard delayed configuration', async t => {
  peers.length = 0;
  const h = hostHarness(); t.after(() => h.host.close());
  await until(() => h.config.length === 1);
  h.bridge.guestStatus = async () => ({ ok: true, guests: [] });
  await h.host.poll();
  h.config[0].resolve(relay); await tick();
  assert.equal(peers.length, 0); assert.deepEqual(h.signals, []);

  h.bridge.guestStatus = async () => ({ ok: true, guests: [entry] });
  await h.host.poll(); await until(() => h.config.length === 2);
  const row = h.container.children[0];
  row.querySelectorAll('button').find(child => child.textContent === 'Reconnect').click();
  await until(() => h.config.length === 3);
  h.config[1].resolve(relay); await tick();
  assert.equal(peers.length, 0); assert.deepEqual(h.signals, []);

  const previous = h.stream;
  h.host.setStream(new Stream());
  h.config[2].resolve(relay); await tick();
  assert.equal(peers.length, 0); assert.deepEqual(h.signals, []);
  assert.equal(previous.tracks[0].stopped, false);
  assert.equal(h.stream.tracks[0].stopped, false);
});
