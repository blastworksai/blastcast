// ClaudeBWAI — einh 3 Oct, "Phone-only fix in r8": a phone guest's call video asks for H.264 first and is capped at
// 720p (short side) / 24 fps / 1.5 Mbps; a desktop guest keeps the VP8-default order and the 1080p cap.
import test from 'node:test';
import assert from 'node:assert/strict';
import { PeerCall, preferH264, scaleFor, applyVideoCap, GUEST_CALL_VIDEO_CAP, MOBILE_GUEST_CALL_VIDEO_CAP } from '../dist/peer-call.js';
import { GuestCall } from '../dist/guest-call.js';
import { codecName } from '../dist/session-diagnostics.js';

const CAPS = [
  { mimeType: 'video/VP8', clockRate: 90000 },
  { mimeType: 'video/rtx', clockRate: 90000 },
  { mimeType: 'video/VP9', clockRate: 90000, sdpFmtpLine: 'profile-id=0' },
  { mimeType: 'video/H264', clockRate: 90000, sdpFmtpLine: 'level-asymmetry-allowed=1;packetization-mode=0;profile-level-id=42e01f' },
  { mimeType: 'video/H264', clockRate: 90000, sdpFmtpLine: 'level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f' },
  { mimeType: 'video/AV1', clockRate: 90000 },
  { mimeType: 'video/red', clockRate: 90000 },
];
let nextId = 0;
const track = (kind, width = 1080, height = 1920) => ({ id: `t${++nextId}`, kind, readyState: 'live', getSettings: () => ({ width, height }) });
class Stream { constructor(t = []) { this.t = [...t]; } getTracks() { return this.t; } getVideoTracks() { return this.t.filter(x => x.kind === 'video'); } getAudioTracks() { return this.t.filter(x => x.kind === 'audio'); } addTrack(x) { this.t.push(x); } }
const pcs = [];
class PC {
  constructor() { this.transceivers = []; pcs.push(this); }
  transceiver(kind, senderTrack) {
    const sender = { track: senderTrack, params: [], getParameters: () => ({ encodings: [{}] }), setParameters: async p => { sender.params.push(p); }, replaceTrack: async t => { sender.track = t; } };
    const t = { mid: null, direction: 'sendrecv', receiver: { track: { kind } }, sender, preferences: null, setCodecPreferences(list) { t.preferences = list; } };
    this.transceivers.push(t); return t;
  }
  addTrack(t) { return this.transceiver(t.kind, t).sender; }
  addTransceiver(kind) { return this.transceiver(kind, null); }
  getTransceivers() { return this.transceivers; }
  async createOffer() { return { type: 'offer', sdp: 'o' }; } async createAnswer() { return { type: 'answer', sdp: 'a' }; }
  async setLocalDescription() { this.transceivers.forEach((t, i) => { t.mid = String(i); }); }
  async setRemoteDescription() { this.transceivers.forEach((t, i) => { t.mid = String(i); }); }
  async addIceCandidate() {} close() {} async getStats() { return new Map(); }
}
globalThis.RTCPeerConnection = PC; globalThis.MediaStream = Stream;
globalThis.RTCRtpReceiver = { getCapabilities: kind => (kind === 'video' ? { codecs: CAPS } : null) };
const flush = () => new Promise(r => setTimeout(r, 0));

test('preferH264 puts H.264 first (packetization-mode=1 before 0) and keeps every other codec in order', () => {
  assert.deepEqual(preferH264(CAPS).map(c => `${c.mimeType}${/mode=(\d)/.exec(c.sdpFmtpLine ?? '')?.[1] ?? ''}`),
    ['video/H2641', 'video/H2640', 'video/VP8', 'video/rtx', 'video/VP9', 'video/AV1', 'video/red']);
  assert.deepEqual(preferH264(CAPS.filter(c => c.mimeType !== 'video/H264')).map(c => c.mimeType), ['video/VP8', 'video/rtx', 'video/VP9', 'video/AV1', 'video/red']);
});

test('mobile cap: 720p on the short side, 24 fps, 1.5 Mbps; the desktop guest cap is unchanged', async () => {
  assert.deepEqual(MOBILE_GUEST_CALL_VIDEO_CAP, { maxBitrate: 1_500_000, maxHeight: 720, maxFramerate: 24, shortSide: true });
  assert.deepEqual(GUEST_CALL_VIDEO_CAP, { maxBitrate: 4_000_000, maxHeight: 1080, maxFramerate: 30 });
  const portrait = { track: track('video', 1080, 1920), getParameters: () => ({ encodings: [{}] }), setParameters: async p => { portrait.last = p; } };
  await applyVideoCap(portrait, MOBILE_GUEST_CALL_VIDEO_CAP);
  assert.deepEqual(portrait.last.encodings[0], { maxBitrate: 1_500_000, maxFramerate: 24, scaleResolutionDownBy: 1.5 }); // 1080×1920 → 720×1280
  await applyVideoCap(portrait, GUEST_CALL_VIDEO_CAP);
  assert.equal(portrait.last.encodings[0].scaleResolutionDownBy, scaleFor(1920, GUEST_CALL_VIDEO_CAP), 'desktop cap still measures height');
});

/** Drives a real GuestCall through one host offer and returns the guest PeerConnection it built. */
async function answerOne(mobile) {
  pcs.length = 0;
  let polls = 0;
  const api = async endpoint => {
    if (endpoint === 'call/config') return { ok: true, iceServers: [], iceTransportPolicy: 'all' };
    if (endpoint === 'call/send') return { ok: true };
    polls++;
    return { ok: true, callId: 'call-1', latest: 1, messages: polls === 1 ? [{ sequence: 1, message: { type: 'description', description: { type: 'offer', sdp: 'o' } } }] : [] };
  };
  const video = { srcObject: null, pause() {}, play: async () => {} };
  const call = new GuestCall(api, video, { textContent: '', dataset: {} }, { addEventListener() {}, hidden: true }, () => {}, mobile);
  call.update(true, new Stream([track('video', 1080, 1920), track('audio')]));
  for (let i = 0; i < 50 && !pcs[0]?.transceivers.some(t => t.preferences !== null || t.sender.params.length); i++) await flush();
  await flush(); await flush();
  call.close();
  return pcs[0];
}

test('a phone guest asks for H.264 first on its camera video (not the screen slot) and applies the mobile cap', async () => {
  const pc = await answerOne(true);
  const cameraVideo = pc.transceivers.find(t => t.sender.track?.kind === 'video');
  assert.equal(cameraVideo.preferences?.[0]?.mimeType, 'video/H264');
  assert.match(cameraVideo.preferences[0].sdpFmtpLine, /packetization-mode=1/);
  assert.equal(cameraVideo.preferences.length, CAPS.length, 'nothing is dropped');
  assert.ok(pc.transceivers.filter(t => t !== cameraVideo).every(t => t.preferences === null), 'audio and screen transceivers untouched');
  const caps = cameraVideo.sender.params.at(-1).encodings[0];
  assert.deepEqual([caps.maxBitrate, caps.maxFramerate, caps.scaleResolutionDownBy], [1_500_000, 24, 1.5]);
});

test('a desktop guest is unchanged: no codec preference, the 1080p guest cap', async () => {
  const pc = await answerOne(false);
  assert.ok(pc.transceivers.every(t => t.preferences === null));
  const caps = pc.transceivers.find(t => t.sender.track?.kind === 'video').sender.params.at(-1).encodings[0];
  assert.deepEqual([caps.maxBitrate, caps.maxFramerate], [4_000_000, 30]);
});

test('a browser without setCodecPreferences still answers (silent fallback)', async () => {
  const original = PC.prototype.transceiver;
  PC.prototype.transceiver = function (...args) { const t = original.apply(this, args); delete t.setCodecPreferences; return t; };
  try { const pc = await answerOne(true); assert.ok(pc.transceivers.length >= 2); }
  finally { PC.prototype.transceiver = original; }
});

test('the host offers H.264 first on the program/camera m-line only for a phone guest (the offer order decides what the guest sends)', async () => {
  for (const phone of [true, false]) {
    pcs.length = 0;
    const host = new PeerCall({ role: 'host', screenShare: true, preferH264: phone, stream: new Stream([track('video', 1920, 1080), track('audio')]), send: async () => {}, onRemoteStream: () => {}, onState: () => {} });
    await host.start(); await flush();
    const program = pcs[0].transceivers.find(t => t.sender.track?.kind === 'video');
    assert.equal(program.preferences?.[0]?.mimeType ?? null, phone ? 'video/H264' : null);
    assert.ok(pcs[0].transceivers.filter(t => t !== program).every(t => t.preferences === null), 'screen and audio untouched');
    host.close();
  }
});

test('join carries device "phone" for a phone guest only; any other value is refused; a rejoin clears it', async () => {
  const { createRequire } = await import('node:module');
  const { createAdmissionStore } = createRequire(import.meta.url)('../desktop/admission.cjs');
  const store = createAdmissionStore();
  const invite = store.createInvitation().invite;
  const key = 'p'.repeat(43);
  let cred = store.redeemInvitation(invite.token, key).sessionCredential;
  assert.equal(store.requestJoin(cred, { name: 'Phone', consent: true, device: 'desktop' }).ok, false);
  assert.equal(store.requestJoin(cred, { name: 'Phone', consent: true, device: 'Alice' }).ok, false);
  assert.equal(store.requestJoin(cred, { name: 'Phone', consent: true, device: 'phone' }).ok, true);
  assert.equal(store.hostList().guests[0].session.device, 'phone');
  cred = store.redeemInvitation(invite.token, key).sessionCredential; // same browser, rejoin
  assert.equal(store.hostList().guests[0].session.device, null);
  assert.equal(store.requestJoin(cred, { name: 'Phone', consent: true }).ok, true);
  assert.equal(store.hostList().guests[0].session.device, null, 'a desktop sends nothing and stays desktop');
});

test('session log: an H.264 inbound stream shows as video/H264', () => {
  assert.equal(codecName('video/H264'), 'video/H264');
  assert.equal(codecName('video/h264'), 'video/H264');
});
