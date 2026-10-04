// ClaudeBWAI — lag fixes: per-sender call video caps, the 30 fps frame gate and the UI throttle.
import test from 'node:test';import assert from 'node:assert/strict';
import { PeerCall, applyVideoCap, replaceTrackCapped, scaleFor, createFrameGate, createThrottle, HOST_CALL_VIDEO_CAP, GUEST_CALL_VIDEO_CAP } from '../dist/peer-call.js';

const track = (kind, height) => ({ kind, getSettings: () => (height ? { width: height * 16 / 9, height } : {}) });
function sender(t) {
  const s = { track: t, calls: [], params: { encodings: [{}], transactionId: '1' },
    getParameters() { return structuredClone(this.params); },
    async setParameters(p) { this.calls.push(structuredClone(p)); this.params = p; },
    async replaceTrack(next) { this.track = next; this.params = { encodings: [{}], transactionId: '2' }; } };
  return s;
}

test('host call cap: 600 kbps, 15 fps, scaled to 360p from the scene size', async () => {
  const s = sender(track('video', 1080));
  assert.equal(await applyVideoCap(s, HOST_CALL_VIDEO_CAP), true);
  assert.deepEqual(s.calls[0].encodings, [{ maxBitrate: 600000, maxFramerate: 15, scaleResolutionDownBy: 3 }]);
  const big = sender(track('video', 2160)); await applyVideoCap(big, HOST_CALL_VIDEO_CAP);
  assert.equal(big.calls[0].encodings[0].scaleResolutionDownBy, 6);
});
test('guest cap keeps 1080p, halves 4K, never upscales', () => {
  assert.equal(scaleFor(2160, GUEST_CALL_VIDEO_CAP), 2);
  assert.equal(scaleFor(1080, GUEST_CALL_VIDEO_CAP), 1);
  assert.equal(scaleFor(720, GUEST_CALL_VIDEO_CAP), 1);
  assert.equal(scaleFor(undefined, GUEST_CALL_VIDEO_CAP), 1);
  assert.equal(scaleFor(0, HOST_CALL_VIDEO_CAP), 3);
});
test('cap is re-applied after replaceTrack and for the new size', async () => {
  const s = sender(track('video', 1080)); await applyVideoCap(s, HOST_CALL_VIDEO_CAP);
  const next = track('video', 2160);
  await replaceTrackCapped(s, next, HOST_CALL_VIDEO_CAP);
  assert.equal(s.track, next); assert.equal(s.calls.length, 2);
  assert.equal(s.calls[1].encodings[0].scaleResolutionDownBy, 6);
  await replaceTrackCapped(s, null, HOST_CALL_VIDEO_CAP); assert.equal(s.calls.length, 2);
});
test('a sender that rejects or lacks the API is skipped, not thrown', async () => {
  assert.equal(await applyVideoCap(null, HOST_CALL_VIDEO_CAP), false);
  assert.equal(await applyVideoCap({ track: null }, HOST_CALL_VIDEO_CAP), false);
  const bad = sender(track('video', 720)); bad.setParameters = async () => { throw new Error('InvalidStateError'); };
  assert.equal(await applyVideoCap(bad, HOST_CALL_VIDEO_CAP), false);
});
test('frame gate passes about 30 fps from 60, 144 and jittery ticks', () => {
  for (const hz of [60, 144, 240]) {
    const gate = createFrameGate(30); let passed = 0;
    for (let t = 0; t < 10000; t += 1000 / hz) if (gate(t)) passed++;
    assert.ok(passed >= 295 && passed <= 305, `${hz} Hz passed ${passed}`);
  }
  const slow = createFrameGate(30); let n = 0;
  for (let t = 0; t < 1000; t += 50) if (slow(t)) n++;   // 20 Hz source can never exceed its own rate
  assert.equal(n, 20);
  const gate = createFrameGate(30); assert.equal(gate(5000), true); assert.equal(gate(5010), false); assert.equal(gate(5034), true);
});
test('throttle runs at most once per interval and honours force', () => {
  let t = 0, runs = 0; const run = createThrottle(() => runs++, 500, () => t);
  run(); run(); t = 499; run(); assert.equal(runs, 1);
  t = 500; run(); assert.equal(runs, 2);
  t = 600; run(true); assert.equal(runs, 3);
  t = 1099; run(); assert.equal(runs, 3); t = 1100; run(); assert.equal(runs, 4);
});

class Stream{constructor(tracks=[]){this.tracks=[...tracks];}getTracks(){return this.tracks;}getVideoTracks(){return this.tracks.filter(t=>t.kind==='video');}addTrack(t){this.tracks.push(t);}}
const senders = [];
class PC{
  constructor(){this.transceivers=[];this.connectionState='new';}
  addTrack(t){const s=sender(t);s.kind=t.kind;senders.push(s);this.transceivers.push({mid:null,direction:'sendrecv',receiver:{track:{kind:t.kind}},sender:s});return s;}
  addTransceiver(kind){const t={mid:null,direction:'sendrecv',receiver:{track:{kind}},sender:{track:null,replaceTrack:async()=>{}}};this.transceivers.push(t);return t;}
  getTransceivers(){return this.transceivers;}
  async createOffer(){return {type:'offer',sdp:'o'};}async createAnswer(){return {type:'answer',sdp:'a'};}
  async setLocalDescription(){this.transceivers.forEach((t,i)=>t.mid=String(i));}
  async setRemoteDescription(){this.transceivers.forEach((t,i)=>t.mid=String(i));}
  async addIceCandidate(){}close(){}async getStats(){return new Map();}
}
globalThis.MediaStream=Stream;globalThis.RTCPeerConnection=PC;
const flush = () => new Promise(r => setTimeout(r, 0));
test('PeerCall caps the host program sender and the guest camera sender; audio is untouched', async t => {
  for (const [role, cap] of [['host', HOST_CALL_VIDEO_CAP], ['guest', GUEST_CALL_VIDEO_CAP]]) {
    senders.length = 0;
    const video = track('video', 2160), audio = track('audio');
    const peer = new PeerCall({ role, stream: new Stream([video, audio]), videoCap: role === 'host' ? cap : undefined,
      send: async () => {}, onRemoteStream: () => {}, onState: () => {} });
    t.after(() => peer.close());
    await flush();
    const [v, a] = senders;
    assert.equal(a.calls.length, 0);
    assert.equal(v.calls.at(-1).encodings[0].maxBitrate, cap.maxBitrate, role);
    assert.equal(v.calls.at(-1).encodings[0].scaleResolutionDownBy, role === 'host' ? 6 : 2);
    const before = v.calls.length;
    await peer.start(); await flush();
    assert.ok(v.calls.length >= before, 're-applied after negotiation');
    const next = track('video', 1080);
    await peer.replaceVideoTrack(next);
    assert.equal(v.track, next);
    assert.equal(v.calls.at(-1).encodings[0].scaleResolutionDownBy, role === 'host' ? 3 : 1);
  }
});
