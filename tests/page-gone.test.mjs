// ClaudeBWAI — einh 4 Oct (r10) "Add a 'tab closed' signal": a guest page that closes sends one note (sendBeacon on pagehide, credential in the
// body); the server marks presence gone at once and flags pageGone; the host skips call recovery for that call and shows Disconnected.
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { HostCalls } from '../dist/host-calls.js';
import { admissionRowLabel } from '../dist/admission-ui.js';
const require = createRequire(import.meta.url);
const { createGuestServer, createPresenceTracker } = require('../desktop/guests.cjs');
const { configureReady } = require('./helpers/network-readiness.cjs');

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


const guestRowGone = (presence, pageGone) => ({ ...guestRow(presence), ...(pageGone ? { pageGone: true } : {}) });
const lapseWith = async (host, state, row) => { state.guests = [row]; await until(() => !host.busy); await host.poll(); await flush(); };

test('host: a reconnecting call whose guest page said it was closing is released at once (page-gone) and the row says Disconnected', async t => {
  mock.timers.enable({ apis: ['setTimeout'] });
  const { host, state, pc, events } = await connectedHost(); t.after(() => { host.close(); mock.timers.reset(); });
  pc.drop('disconnected'); await flush();
  await lapseWith(host, state, guestRowGone('disconnected', true));
  assert.equal(pc.closed, true, 'recovery is skipped');
  assert.equal(host.calls.size, 0);
  assert.deepEqual([events.at(-1).st, events.at(-1).reason], ['released', 'page-gone']);
  assert.equal(admissionRowLabel(guestRowGone('disconnected', true)), 'Disconnected — can rejoin from the same browser');
});

test('host: the label says Disconnected for pageGone even while the call is still marked reconnecting', async t => {
  mock.timers.enable({ apis: ['setTimeout'] });
  const { host, state, pc } = await connectedHost(); t.after(() => { host.close(); mock.timers.reset(); });
  pc.drop('disconnected'); await flush();
  assert.equal(admissionRowLabel(guestRowGone('disconnected', true)), 'Disconnected — can rejoin from the same browser');
  assert.equal(admissionRowLabel(guestRowGone('disconnected', false)), 'Reconnecting…', 'a plain lapse still says Reconnecting');
});

test('control: a plain presence lapse WITHOUT pageGone still holds a reconnecting call (a983431 behaviour)', async t => {
  mock.timers.enable({ apis: ['setTimeout'] });
  const { host, state, pc } = await connectedHost(); t.after(() => { host.close(); mock.timers.reset(); });
  pc.drop('disconnected'); await flush();
  await lapseWith(host, state, guestRowGone('disconnected', false));
  assert.notEqual(pc.closed, true);
  assert.equal(host.calls.size, 1);
});

test('presence tracker: markGone is disconnected now and flagged; the next touch clears it', () => {
  const presence = createPresenceTracker({ now: () => 0 });
  presence.touch('a'); presence.markGone('a');
  assert.deepEqual([presence.state('a'), presence.isGone('a')], ['disconnected', true]);
  presence.touch('a');
  assert.deepEqual([presence.state('a'), presence.isGone('a')], ['connected', false]);
});

function rawPost(port, path, { body, type = 'application/json', headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const payload = typeof body === 'string' ? body : JSON.stringify(body ?? {});
    const request = http.request({ hostname: '127.0.0.1', port, path, method: 'POST', agent: false,
      headers: { Host: 'gone.test', Origin: 'https://gone.test', 'Content-Type': type, 'Content-Length': Buffer.byteLength(payload), ...headers } }, response => {
      let data = ''; response.on('data', c => { data += c; }); response.on('end', () => resolve({ status: response.statusCode, data }));
    });
    request.on('error', reject); request.end(payload);
  });
}
const freePort = () => new Promise(resolve => { const probe = http.createServer(); probe.listen(0, '127.0.0.1', () => { const { port } = probe.address(); probe.close(() => resolve(port)); }); });

test('POST /api/page-gone: valid body marks the guest gone at once; bad shapes, URL tokens, oversize and unknown sessions are refused', async t => {
  const time = 1_000_000;
  const server = createGuestServer({ directory: '.', now: () => time, probe: async () => {} });
  t.after(() => server.stop());
  const port = await freePort();
  assert.equal((await configureReady(server, { origin: 'https://gone.test', port })).ok, true);
  const invite = new URL(server.invite().invite.url).hash.split('=')[1];
  const redeemed = JSON.parse((await rawPost(port, '/api/redeem', { body: { redemptionKey: 'k'.repeat(43) }, headers: { Authorization: `Bearer ${invite}` } })).data);
  const credential = redeemed.sessionCredential;
  const auth = { Authorization: `Bearer ${credential}` };
  assert.equal((await rawPost(port, '/api/join', { body: { name: 'Phone', consent: true }, headers: auth })).status, 200);
  const sessionId = server.status().guests[0].session.id;
  assert.equal(server.admit(sessionId).ok, true);
  assert.deepEqual([server.status().guests[0].presence, server.status().guests[0].pageGone], ['connected', undefined]);

  // refused: token in the URL (not a route), wrong shape, extra key, bad credential, unknown session, oversize, wrong content type
  assert.equal((await rawPost(port, `/api/page-gone?session=${credential}`, { body: { session: credential } })).status, 404);
  assert.equal((await rawPost(port, '/api/page-gone', { body: {} })).status, 400);
  assert.equal((await rawPost(port, '/api/page-gone', { body: { session: credential, extra: 1 } })).status, 400);
  assert.equal((await rawPost(port, '/api/page-gone', { body: { session: 5 } })).status, 400);
  assert.equal((await rawPost(port, '/api/page-gone', { body: ['x'] })).status, 400);
  assert.equal((await rawPost(port, '/api/page-gone', { body: { session: 'short' } })).status, 410);
  assert.equal((await rawPost(port, '/api/page-gone', { body: { session: 'u'.repeat(43) } })).status, 410);
  // oversize: the server cuts the connection (as every bounded JSON route does) or answers 400; either way nothing is marked
  const big = await rawPost(port, '/api/page-gone', { body: { session: credential, pad: 'x'.repeat(400) } }).catch(e => ({ status: e.code }));
  assert.ok([400, 'ECONNRESET'].includes(big.status), String(big.status));
  assert.equal((await rawPost(port, '/api/page-gone', { body: { session: credential }, type: 'text/plain' })).status, 400);
  assert.equal((await rawPost(port, '/api/page-gone', { body: { session: 'u'.repeat(43) }, headers: auth })).status, 410, 'a header credential is not used');
  assert.equal(server.status().guests[0].pageGone, undefined, 'none of those marked the guest gone');
  const noOrigin = await rawPost(port, '/api/page-gone', { body: { session: credential }, headers: { Origin: 'https://evil.test' } });
  assert.equal(noOrigin.status, 403);

  const ok = await rawPost(port, '/api/page-gone', { body: { session: credential } });
  assert.equal(ok.status, 204);
  const row = server.status().guests[0];
  assert.deepEqual([row.phase, row.presence, row.pageGone], ['admitted', 'disconnected', true], 'disconnected immediately, no 12 s wait');
  assert.equal(admissionRowLabel(row), 'Disconnected — can rejoin from the same browser');

  // the page comes back (polls again): flag cleared
  assert.equal((await rawPost(port, '/api/status', { body: {}, headers: auth })).status, 200);
  const back = server.status().guests[0];
  assert.deepEqual([back.presence, back.pageGone], ['connected', undefined]);
});

test('guest page source: pagehide sends the beacon with the credential in the BODY, only when admitted, and forgets nothing', () => {
  const src = fs.readFileSync(new URL('../src/guest.ts', import.meta.url), 'utf8');
  const fn = src.slice(src.indexOf('function announcePageGone'), src.indexOf("window.addEventListener('pagehide'"));
  assert.match(fn, /if \(!admitted \|\| terminal \|\| !sessionCredential/, 'only when admitted with a credential');
  assert.match(fn, /navigator\.sendBeacon\('\/api\/page-gone', new Blob\(\[JSON\.stringify\(\{ session: sessionCredential \}\)\], \{ type: 'application\/json' \}\)\)/);
  assert.doesNotMatch(fn, /page-gone\?|\$\{sessionCredential\}|forgetInvite/, 'never in the URL; forgets nothing');
  const handler = src.slice(src.indexOf("window.addEventListener('pagehide'")).split('\n')[0];
  assert.ok(handler.indexOf('announcePageGone()') > 0 && handler.indexOf('announcePageGone()') < handler.indexOf('terminal = true'), 'sent before the teardown flips terminal');
  assert.doesNotMatch(handler, /forgetInvite|sessionStorage/);
  assert.equal((src.match(/announcePageGone\(\)/g) ?? []).length, 2, 'declared once, called once (pagehide only)');
});
