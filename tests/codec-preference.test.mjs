// ClaudeBWAI — einh 4 Oct (CP4b): camera-transceiver codec preference, both directions. Fake peer connection + capabilities.
import test from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { PeerCall, desktopGuestCodecOptions, isFirefoxUserAgent } from '../dist/peer-call.js';

const CAPS = [
  { mimeType: 'video/VP8' },
  { mimeType: 'video/H264', sdpFmtpLine: 'level-asymmetry-allowed=1;packetization-mode=0;profile-level-id=42e01f' },
  { mimeType: 'video/H264', sdpFmtpLine: 'level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f' },
  { mimeType: 'video/rtx' },
];
class Tx { constructor(sender) { this.sender = sender; this.prefs = null; this.receiver = { track: { kind: 'video' } }; } setCodecPreferences(p) { this.prefs = p; } }
class FakePC {
  constructor() { this.transceivers = []; }
  addTrack(track) { const t = new Tx({ track }); this.transceivers.push(t); return t.sender; }
  addTransceiver() { const t = new Tx({ track: null }); this.transceivers.push(t); return t; }
  getTransceivers() { return this.transceivers; }
  async createOffer() { return { type: 'offer', sdp: 'o' }; }
  async createAnswer() { return { type: 'answer', sdp: 'a' }; }
  async setLocalDescription() {}
  async setRemoteDescription() {}
  close() {}
  async getStats() { return new Map(); }
}
globalThis.RTCPeerConnection = FakePC;
globalThis.RTCRtpReceiver = { getCapabilities: () => ({ codecs: CAPS }) };
globalThis.MediaStream = class { constructor(t = []) { this.t = t; } getTracks() { return this.t; } };

async function run(role, options) {
  const sent = [];
  const call = new PeerCall({ role, stream: new MediaStream([{ kind: 'video' }]), screenShare: true, send: async m => { sent.push(m); }, onRemoteStream() {}, onState() {}, ...options });
  const pc = call.pc;
  await call.start();
  if (role === 'guest') await call.receive({ type: 'description', description: { type: 'offer', sdp: 'x' } });
  call.close();
  return { camera: pc.transceivers[0], screen: pc.transceivers.slice(1) };
}
const order = prefs => prefs.map(c => c.mimeType + (c.sdpFmtpLine?.includes('packetization-mode=1') ? ':1' : ''));

test('desktop options: H.264 first, Firefox native', () => {
  assert.deepStrictEqual(desktopGuestCodecOptions('Mozilla/5.0 Chrome/154.0 Safari/537.36'), { preferH264: true });
  assert.deepStrictEqual(desktopGuestCodecOptions('Mozilla/5.0 (Macintosh) Version/19 Safari/605.1.15'), { preferH264: true });
  assert.deepStrictEqual(desktopGuestCodecOptions('Mozilla/5.0 (Windows NT 10.0; rv:140.0) Gecko/20100101 Firefox/140.0'), { nativeCodecOrder: true });
  assert.ok(isFirefoxUserAgent('FxiOS/140'));
});
test('host offer to a desktop guest: H.264 mode 1 first, VP8 kept, screen untouched', async () => {
  const { camera, screen } = await run('host', { preferH264: true });
  const o = order(camera.prefs);
  assert.strictEqual(o[0], 'video/H264:1');
  assert.ok(o.includes('video/VP8'));
  assert.ok(screen.every(t => t.prefs === null));
});
test('guest answer: desktop Chrome H.264 first; Firefox native order; screen untouched', async () => {
  const chrome = await run('guest', desktopGuestCodecOptions('Chrome/154'));
  assert.strictEqual(order(chrome.camera.prefs)[0], 'video/H264:1');
  assert.ok(order(chrome.camera.prefs).includes('video/VP8'));
  assert.ok(chrome.screen.every(t => t.prefs === null));
  const ff = await run('guest', desktopGuestCodecOptions('Firefox/140.0'));
  assert.deepStrictEqual(order(ff.camera.prefs), order(CAPS));
  assert.ok(ff.screen.every(t => t.prefs === null));
});
test('no preference requested: transceiver untouched', async () => {
  const { camera } = await run('host', {});
  assert.strictEqual(camera.prefs, null);
});
test('both directions are wired in the shipped sources; phone path unchanged', () => {
  const host = readFileSync(new URL('../src/host-calls.ts', import.meta.url), 'utf8');
  const guest = readFileSync(new URL('../src/guest-call.ts', import.meta.url), 'utf8');
  assert.match(host, /videoCap: HOST_CALL_VIDEO_CAP, preferH264: true,/);
  assert.match(guest, /desktopGuestCodecOptions\(/);
  assert.match(guest, /preferH264: true, videoCap: MOBILE_GUEST_CALL_VIDEO_CAP/);
});
