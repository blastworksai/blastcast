// ClaudeBWAI — einh 4 Oct ("A: amber Reconnecting…"): a media path that drops mid-call is recovered by the host restarting ICE.
import test, { mock } from 'node:test';
import assert from 'node:assert';
import { PeerCall, RECOVERY_DEADLINE_MS, RECOVERY_GRACE_MS, RECOVERY_ATTEMPT_MS } from '../dist/peer-call.js';

class FakeStream { constructor(t = []) { this.t = t; } getTracks() { return this.t; } addTrack(x) { this.t.push(x); } }
let pcs = [];
class FakePc {
  constructor() { this.connectionState = 'new'; this.signalingState = 'stable'; this.remoteDescription = null; this.restarts = 0; this.offerOptions = []; this.n = 0; pcs.push(this); }
  addTrack() {}
  addTransceiver() { return { mid: '2', sender: {}, receiver: { track: { kind: 'video' } } }; }
  getTransceivers() { return []; }
  restartIce() { this.restarts++; }
  async createOffer(options) { this.offerOptions.push(options); return { type: 'offer', sdp: `offer-${++this.n}` }; }
  async createAnswer() { return { type: 'answer', sdp: 'answer' }; }
  async setLocalDescription(d) { this.signalingState = d.type === 'offer' ? 'have-local-offer' : 'stable'; }
  async setRemoteDescription(d) { this.remoteDescription = d; this.signalingState = d.type === 'offer' ? 'have-remote-offer' : 'stable'; }
  async addIceCandidate() {}
  close() {}
  async getStats() { return new Map(); }
  drop(state) { this.connectionState = state; this.onconnectionstatechange?.(); }
}
global.RTCPeerConnection = FakePc;
global.MediaStream = FakeStream;
const flush = () => new Promise(r => setImmediate(r));

async function connected(role) {
  pcs = [];
  const sent = [], states = [];
  const call = new PeerCall({ role, stream: new FakeStream(['a']), send: async m => { sent.push(m); }, onRemoteStream: () => {}, onState: (s, m) => states.push(s) });
  await call.start();
  if (role === 'host') await call.receive({ type: 'description', description: { type: 'answer', sdp: 'a0' } });
  else await call.receive({ type: 'description', description: { type: 'offer', sdp: 'o0' } });
  await flush();
  const pc = pcs[0];
  pc.drop('connected');
  sent.length = 0;
  return { call, pc, sent, states };
}
const offers = sent => sent.filter(m => m.type === 'description' && m.description.type === 'offer');

test('host: disconnected -> reconnecting -> restartIce and a new offer after the grace', async t => {
  mock.timers.enable({ apis: ['setTimeout'] });
  t.after(() => mock.timers.reset());
  const { call, pc, sent, states } = await connected('host');
  pc.drop('disconnected');
  assert.strictEqual(states.at(-1), 'reconnecting');
  assert.strictEqual(pc.restarts, 0, 'not before the grace');
  mock.timers.tick(RECOVERY_GRACE_MS); await flush();
  assert.strictEqual(pc.restarts, 1);
  assert.deepStrictEqual(pc.offerOptions.at(-1), { iceRestart: true });
  const [offer] = offers(sent);
  assert.strictEqual(offer.iceRestart, true);
  assert.strictEqual(offer.generation, 1);
  call.close();
});

test('host: browser failed restarts at once, and recovery to connected clears the state and timers', async t => {
  mock.timers.enable({ apis: ['setTimeout'] });
  t.after(() => mock.timers.reset());
  const { call, pc, sent, states } = await connected('host');
  pc.drop('failed'); await flush();
  assert.strictEqual(states.at(-1), 'reconnecting');
  assert.strictEqual(pc.restarts, 1);
  await call.receive({ type: 'description', description: { type: 'answer', sdp: 'a1' }, generation: 1 });
  pc.drop('connecting');
  assert.strictEqual(states.at(-1), 'reconnecting', 'connecting does not hide the recovery');
  pc.drop('connected');
  assert.strictEqual(states.at(-1), 'connected');
  mock.timers.tick(RECOVERY_DEADLINE_MS * 2); await flush();
  assert.strictEqual(states.at(-1), 'connected', 'the deadline was cancelled');
  assert.strictEqual(pc.restarts, 1, 'no further attempts');
  call.close();
});

test('host: three failed attempts, then the deadline fails the call as before', async t => {
  mock.timers.enable({ apis: ['setTimeout'] });
  t.after(() => mock.timers.reset());
  const { pc, sent, states } = await connected('host');
  pc.drop('failed'); await flush();
  for (let i = 0; i < 6; i++) { mock.timers.tick(RECOVERY_ATTEMPT_MS); await flush(); }
  assert.strictEqual(pc.restarts, 3, 'at most three attempts');
  assert.deepStrictEqual(offers(sent).map(o => o.generation), [1, 2, 3]);
  assert.strictEqual(states.at(-1), 'failed');
});

test('host: the 30 s deadline fails the call even with no attempt answered', async t => {
  mock.timers.enable({ apis: ['setTimeout'] });
  t.after(() => mock.timers.reset());
  let reason = null;
  pcs = [];
  const states = [];
  const call = new PeerCall({ role: 'host', stream: new FakeStream(['a']), send: async () => {}, onRemoteStream: () => {}, onState: (s, m) => { states.push(s); if (s === 'failed') reason = m; } });
  await call.start(); await call.receive({ type: 'description', description: { type: 'answer', sdp: 'a0' } }); await flush();
  pcs[0].drop('connected'); pcs[0].drop('disconnected');
  mock.timers.tick(RECOVERY_DEADLINE_MS); await flush();
  assert.strictEqual(states.at(-1), 'failed');
  assert.match(reason, /30 s/);
});

test('host: a stale answer (older generation) is ignored; the current one is applied', async t => {
  mock.timers.enable({ apis: ['setTimeout'] });
  t.after(() => mock.timers.reset());
  const { call, pc } = await connected('host');
  pc.drop('failed'); await flush();
  mock.timers.tick(RECOVERY_ATTEMPT_MS); await flush(); // generation 2 is out
  let applied = 0; const set = pc.setRemoteDescription.bind(pc);
  pc.setRemoteDescription = async d => { applied++; return set(d); };
  await call.receive({ type: 'description', description: { type: 'answer', sdp: 'late' }, generation: 1 });
  assert.strictEqual(applied, 0, 'stale answer dropped');
  await call.receive({ type: 'description', description: { type: 'answer', sdp: 'now' }, generation: 2 });
  assert.strictEqual(applied, 1);
  call.close();
});

test('guest: never initiates a restart; shows reconnecting, answers the host re-offer with its generation, fails at the deadline', async t => {
  mock.timers.enable({ apis: ['setTimeout'] });
  t.after(() => mock.timers.reset());
  const { call, pc, sent, states } = await connected('guest');
  pc.drop('failed'); await flush();
  assert.strictEqual(states.at(-1), 'reconnecting');
  mock.timers.tick(RECOVERY_ATTEMPT_MS); await flush();
  assert.strictEqual(pc.restarts, 0, 'guest never calls restartIce');
  assert.strictEqual(pc.offerOptions.length, 0, 'guest never creates an offer');
  assert.strictEqual(offers(sent).length, 0);
  await call.receive({ type: 'description', description: { type: 'offer', sdp: 'o1' }, iceRestart: true, generation: 1 });
  const answer = sent.find(m => m.description?.type === 'answer');
  assert.strictEqual(answer.generation, 1);
  mock.timers.tick(15_000); await flush();
  assert.notStrictEqual(states.at(-1), 'failed', 'the re-offer did not arm the 15 s setup timeout');
  mock.timers.tick(RECOVERY_DEADLINE_MS); await flush();
  assert.strictEqual(states.at(-1), 'failed');
});

test('a call that never connected still fails on its own timeout, no recovery', async t => {
  mock.timers.enable({ apis: ['setTimeout'] });
  t.after(() => mock.timers.reset());
  pcs = []; const states = [];
  const call = new PeerCall({ role: 'host', stream: new FakeStream(['a']), send: async () => {}, onRemoteStream: () => {}, onState: s => states.push(s) });
  await call.start(); await flush();
  pcs[0].drop('failed');
  assert.strictEqual(states.at(-1), 'failed');
  assert.strictEqual(pcs[0].restarts, 0);
  void call;
});

test('host: disconnected then failed inside the grace window sends exactly one offer (generation 1), whose answer is accepted', async t => {
  mock.timers.enable({ apis: ['setTimeout'] });
  t.after(() => mock.timers.reset());
  const { call, pc, sent } = await connected('host');
  pc.drop('disconnected');
  mock.timers.tick(RECOVERY_GRACE_MS - 500);
  pc.drop('failed'); await flush();
  mock.timers.tick(1000); await flush(); // the old grace timer's moment
  assert.strictEqual(pc.restarts, 1, 'the grace timer must not start a second attempt');
  assert.deepStrictEqual(offers(sent).map(o => o.generation), [1]);
  let applied = 0; const set = pc.setRemoteDescription.bind(pc);
  pc.setRemoteDescription = async d => { applied++; return set(d); };
  await call.receive({ type: 'description', description: { type: 'answer', sdp: 'a1' }, generation: 1 });
  assert.strictEqual(applied, 1, 'the answer to generation 1 is accepted');
  mock.timers.tick(RECOVERY_ATTEMPT_MS - 1500); await flush();
  assert.strictEqual(offers(sent).length, 1, 'no further offer before RECOVERY_ATTEMPT_MS');
  for (let i = 0; i < 6; i++) { mock.timers.tick(RECOVERY_ATTEMPT_MS); await flush(); }
  assert.ok(offers(sent).length <= 3, 'never more than three offers');
  call.close();
});
