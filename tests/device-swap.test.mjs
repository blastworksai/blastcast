// ClaudeBWAI — einh 3 Oct, items 5 and 6: a device that stops sending is named and can be reconnected, and toggling
// or reconnecting ONE device replaces only that track; the other kind's track is never stopped or replaced.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Preview, deviceNoticeText, hostOs, reconnectLabel } from '../dist/preview.js';
import { PeerCall } from '../dist/peer-call.js';
import { HostAudioMixer } from '../dist/audio-mix.js';

let nextId = 0;
class Track extends EventTarget {
  constructor(kind, label = '', settings = {}) { super(); this.id = `t${++nextId}`; this.kind = kind; this.label = label; this.settings = settings; this.readyState = 'live'; this.muted = false; this.enabled = true; this.stopped = 0; }
  getSettings() { return this.settings; }
  stop() { this.stopped++; this.readyState = 'ended'; }
  mute() { this.muted = true; this.dispatchEvent(new Event('mute')); }
  unmute() { this.muted = false; this.dispatchEvent(new Event('unmute')); }
}
class Stream {
  constructor(tracks = []) { this.tracks = [...tracks]; }
  getTracks() { return [...this.tracks]; }
  getVideoTracks() { return this.tracks.filter(t => t.kind === 'video'); }
  getAudioTracks() { return this.tracks.filter(t => t.kind === 'audio'); }
  addTrack(t) { this.tracks.push(t); }
  removeTrack(t) { const i = this.tracks.indexOf(t); if (i >= 0) this.tracks.splice(i, 1); }
}
const allow = async () => true;
const both = { camera: 'cam-1', microphone: 'mic-1', height: 1080, cameraEnabled: true, microphoneEnabled: true };

/** A preview whose acquire hands out one fresh track per requested kind and records every request. */
function rig(options = {}) {
  const requests = [], states = [];
  let shown = null;
  const labels = { video: 'HD Webcam', audio: 'Shure MV7', ...options.labels };
  const acquire = async request => {
    requests.push(request);
    const tracks = [];
    if (request.video) tracks.push(new Track('video', labels.video, { width: 1280, height: 720 }));
    if (request.audio) { const t = new Track('audio', labels.audio); if (options.freshMuted) t.muted = true; tracks.push(t); }
    return new Stream(tracks);
  };
  let clock = 0;
  const preview = new Preview(acquire, (state, stream) => { states.push(state); shown = stream; },
    { deviceNotices: true, createStream: tracks => new Stream(tracks), now: () => clock });
  return { preview, requests, states, get shown() { return shown; }, advance: ms => { clock += ms; } };
}

test('device notice wording names the kind and the device, generic word when the label is empty', () => {
  assert.equal(deviceNoticeText({ kind: 'microphone', label: 'Shure MV7', stillMuted: false }),
    'Your microphone (Shure MV7) stopped sending sound — it may be muted in Windows or in use by another app.');
  assert.equal(deviceNoticeText({ kind: 'microphone', label: '', stillMuted: false }),
    'Your microphone stopped sending sound — it may be muted in Windows or in use by another app.');
  assert.equal(deviceNoticeText({ kind: 'camera', label: 'HD Webcam', stillMuted: false }),
    'Your camera (HD Webcam) stopped sending video — it may be turned off in Windows or in use by another app.');
  assert.equal(deviceNoticeText({ kind: 'microphone', label: 'Shure MV7', stillMuted: true }),
    "Still no sound from Shure MV7. Check that it isn't muted in Windows Sound settings and that no other app is using it exclusively.");
  assert.equal(deviceNoticeText({ kind: 'microphone', label: '', stillMuted: true }),
    "Still no sound from your microphone. Check that it isn't muted in Windows Sound settings and that no other app is using it exclusively.");
  assert.match(deviceNoticeText({ kind: 'camera', label: '', stillMuted: true }), /^Still no video from your camera\./);
  assert.equal(reconnectLabel('microphone'), 'Reconnect microphone');
  assert.equal(reconnectLabel('camera'), 'Reconnect camera');
});

test('a muted track publishes a named notice of its kind; unmuting on its own clears it', async () => {
  const r = rig();
  await r.preview.start(both, allow);
  const mic = r.shown.getAudioTracks()[0];
  mic.mute();
  assert.equal(r.preview.state.phase, 'interrupted');
  assert.deepEqual(r.preview.state.notices, [{ kind: 'microphone', label: 'Shure MV7', stillMuted: false }]);
  assert.match(r.preview.state.message, /^Your microphone \(Shure MV7\) stopped sending sound/);
  r.shown.getVideoTracks()[0].mute();
  assert.deepEqual(r.preview.state.notices.map(n => n.kind).sort(), ['camera', 'microphone'], 'both quiet: both lines');
  mic.unmute(); r.shown.getVideoTracks()[0].unmute();
  assert.equal(r.preview.state.phase, 'live');
  assert.equal(r.preview.state.notices, undefined);
});

test('the guest page (no deviceNotices) keeps its generic wording', async () => {
  const preview = new Preview(async () => new Stream([new Track('video'), new Track('audio')]), () => {});
  await preview.start({ camera: '', microphone: '', height: 'auto' }, allow);
  const track = preview['current'].getAudioTracks()[0];
  track.mute();
  assert.equal(preview.state.message, 'A device is temporarily unavailable. Check its privacy switch or other apps.');
  assert.equal(preview.state.notices?.[0]?.kind, 'microphone');
});

test('Mic off then on never stops or replaces the video track', async () => {
  const r = rig();
  await r.preview.start(both, allow);
  const video = r.shown.getVideoTracks()[0], firstMic = r.shown.getAudioTracks()[0];
  const before = r.shown;
  await r.preview.setDevice('microphone', { ...both, microphoneEnabled: false }, allow);
  assert.notEqual(r.shown, before, 'a new stream object, so a recorder holding the old one never sees its tracks change');
  assert.deepEqual(r.shown.getTracks(), [video]);
  assert.equal(video.stopped, 0); assert.equal(firstMic.stopped, 1);
  await r.preview.setDevice('microphone', both, allow);
  assert.equal(r.shown.getVideoTracks()[0], video, 'same video track object');
  assert.equal(video.stopped, 0);
  assert.equal(r.shown.getAudioTracks().length, 1);
  assert.deepEqual(r.requests.at(-1), { video: false, audio: r.requests.at(-1).audio }, 'only audio was requested');
  assert.equal(r.requests.at(-1).audio.deviceId.exact, 'mic-1');
  assert.equal(r.preview.state.phase, 'live');
});

test('Camera off then on never stops or replaces the audio track', async () => {
  const r = rig();
  await r.preview.start(both, allow);
  const mic = r.shown.getAudioTracks()[0];
  await r.preview.setDevice('camera', { ...both, cameraEnabled: false }, allow);
  assert.deepEqual(r.shown.getTracks(), [mic]);
  await r.preview.setDevice('camera', both, allow);
  assert.equal(r.shown.getAudioTracks()[0], mic);
  assert.equal(mic.stopped, 0);
  assert.equal(r.requests.at(-1).audio, false);
  assert.equal(r.requests.at(-1).video.deviceId.exact, 'cam-1');
});

test('Reconnect restarts only that device with the same deviceId; retain hands the old track back unstopped', async () => {
  const r = rig();
  await r.preview.start(both, allow);
  const video = r.shown.getVideoTracks()[0], oldMic = r.shown.getAudioTracks()[0];
  oldMic.mute();
  const result = await r.preview.setDevice('microphone', both, allow, { reconnect: true, retain: true });
  assert.deepEqual(result.retired, [oldMic]);
  assert.equal(oldMic.stopped, 0, 'a running original still holds it');
  assert.equal(r.shown.getVideoTracks()[0], video); assert.equal(video.stopped, 0);
  assert.notEqual(r.shown.getAudioTracks()[0], oldMic);
  assert.equal(r.requests.at(-1).audio.deviceId.exact, 'mic-1');
  assert.equal(r.preview.state.phase, 'live');
  assert.equal(r.preview.state.notices, undefined, 'the fresh track is sending: the notice clears');
  oldMic.unmute(); assert.equal(r.preview.state.phase, 'live', 'a retired track no longer drives the state');
});

test('a fresh track that is also muted after Reconnect says so explicitly', async () => {
  const r = rig({ freshMuted: true });
  await r.preview.start({ ...both, microphoneEnabled: false }, allow);
  await r.preview.setDevice('microphone', both, allow); // turned on: muted on arrival, not a reconnect
  assert.deepEqual(r.preview.state.notices, [{ kind: 'microphone', label: 'Shure MV7', stillMuted: false }]);
  await r.preview.setDevice('microphone', both, allow, { reconnect: true });
  assert.deepEqual(r.preview.state.notices, [{ kind: 'microphone', label: 'Shure MV7', stillMuted: true }]);
  assert.match(r.preview.state.message, /^Still no sound from Shure MV7\./);
});

test('a reconnected track that mutes within the window is still-muted; later it is an ordinary notice', async () => {
  const r = rig();
  await r.preview.start(both, allow);
  await r.preview.setDevice('microphone', both, allow, { reconnect: true });
  r.advance(1000); r.shown.getAudioTracks()[0].mute();
  assert.equal(r.preview.state.notices[0].stillMuted, true);
  r.shown.getAudioTracks()[0].unmute();
  r.advance(10_000); r.shown.getAudioTracks()[0].mute();
  assert.equal(r.preview.state.notices[0].stillMuted, false);
});

test('a failed Reconnect keeps the quiet track and its notice; the other device is untouched', async () => {
  const r = rig();
  await r.preview.start(both, allow);
  const video = r.shown.getVideoTracks()[0], mic = r.shown.getAudioTracks()[0];
  mic.mute();
  r.preview['acquire'] = async () => { throw Object.assign(new Error('busy'), { name: 'NotReadableError' }); };
  await r.preview.setDevice('microphone', both, allow, { reconnect: true });
  assert.equal(r.shown.getAudioTracks()[0], mic); assert.equal(mic.stopped, 0);
  assert.equal(r.shown.getVideoTracks()[0], video);
  assert.equal(r.preview.state.notices[0].kind, 'microphone');
  assert.match(r.preview.state.errors.microphone, /^Microphone: A device could not be opened/);
});

test('turning the last device off leaves the preview idle with nothing running', async () => {
  const r = rig();
  await r.preview.start({ ...both, cameraEnabled: false }, allow);
  const mic = r.shown.getAudioTracks()[0];
  await r.preview.setDevice('microphone', { ...both, cameraEnabled: false, microphoneEnabled: false }, allow);
  assert.equal(r.shown, null); assert.equal(mic.stopped, 1); assert.equal(r.preview.state.phase, 'idle');
});

test('setDevice with nothing running falls back to a normal start', async () => {
  const r = rig();
  await r.preview.setDevice('camera', { ...both, microphoneEnabled: false }, allow);
  assert.equal(r.shown.getVideoTracks().length, 1); assert.equal(r.shown.getAudioTracks().length, 0);
});

// ---- the call and the mix take the new microphone without touching video or renegotiating ----
class PC {
  constructor() { this.transceivers = []; this.negotiations = 0; }
  addTrack(t) { const s = { track: t, replaced: [], replaceTrack: async n => { s.replaced.push(n); s.track = n; }, getParameters: () => ({ encodings: [{}] }), setParameters: async () => {} };
    this.transceivers.push({ mid: null, receiver: { track: { kind: t.kind } }, sender: s }); return s; }
  addTransceiver(kind) { const s = { track: null, replaced: [], replaceTrack: async n => { s.replaced.push(n); s.track = n; } };
    const t = { mid: null, direction: 'sendrecv', receiver: { track: { kind } }, sender: s }; this.transceivers.push(t); return t; }
  getTransceivers() { return this.transceivers; }
  async createOffer() { this.negotiations++; return { type: 'offer', sdp: 'o' }; }
  async setLocalDescription() { this.transceivers.forEach((t, i) => { t.mid = String(i); }); }
  close() {}
}
globalThis.RTCPeerConnection = PC; globalThis.MediaStream = Stream;

test('PeerCall.replaceAudioTrack swaps only the audio sender, and adds a mic to a reserved section without renegotiation', async () => {
  for (const startWithMic of [true, false]) {
    const video = new Track('video'), mic = new Track('audio');
    const peer = new PeerCall({ role: 'host', screenShare: true, stream: new Stream(startWithMic ? [video, mic] : [video]),
      send: async () => {}, onRemoteStream: () => {}, onState: () => {} });
    const pc = peer['pc'];
    const videoSender = pc.transceivers.find(t => t.sender.track === video).sender;
    const fresh = new Track('audio');
    assert.equal(await peer.replaceAudioTrack(fresh), true);
    const audio = pc.transceivers.find(t => t.receiver.track.kind === 'audio' && t !== peer['screenTransceiver']);
    assert.equal(audio.sender.track, fresh);
    assert.deepEqual(videoSender.replaced, [], 'video sender untouched');
    assert.equal(peer['screenTransceiver'].sender.replaced.length, 0, 'screen sender untouched');
    assert.equal(pc.negotiations, 0);
    assert.equal(await peer.replaceAudioTrack(null), true);
    assert.equal(audio.sender.track, null);
    peer.close();
  }
});

test('HostAudioMixer.setHostStream swaps the host source; the mixed stream object (what a recording holds) is unchanged', () => {
  const made = [];
  class Node { constructor(kind) { this.kind = kind; this.connections = []; made.push(this); } connect(n) { this.connections.push(n); return n; } disconnect() { this.disconnected = true; this.connections = []; } }
  globalThis.AudioContext = class {
    constructor() { this.destination = new Node('speakers'); }
    createGain() { const g = new Node('gain'); g.gain = { value: 1 }; return g; }
    createMediaStreamDestination() { const d = new Node('mixed'); d.stream = new Stream([new Track('audio')]); return d; }
    createMediaStreamSource(stream) { const s = new Node('source'); s.stream = stream; return s; }
    createAnalyser() { return new Node('analyser'); }
    async resume() {} async close() {}
  };
  const first = new Stream([new Track('audio')]);
  const mixer = new HostAudioMixer(first);
  const mixed = mixer.getMixedStream();
  const oldSource = made.find(n => n.kind === 'source' && n.stream === first);
  const second = new Stream([new Track('audio')]);
  mixer.setHostStream(second);
  assert.equal(oldSource.disconnected, true);
  const newSource = made.find(n => n.kind === 'source' && n.stream === second);
  assert.ok(newSource.connections.some(n => n.kind === 'mixed'));
  assert.equal(mixer.getMixedStream(), mixed);
  mixer.setHostStream(new Stream([])); // mic off: no host source, mix still there
  assert.equal(newSource.disconnected, true);
  assert.equal(mixer.getMixedStream(), mixed);
});

// ClaudeBWAI — the mute hint names the host's own OS; einh's "Windows" wording stays on Windows.
test('device notice names the host OS where the device is muted', () => {
  assert.equal(hostOs('Mozilla/5.0 (Windows NT 10.0; Win64; x64)'), 'windows');
  assert.equal(hostOs('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)'), 'macos');
  assert.equal(hostOs('Mozilla/5.0 (X11; Linux x86_64)'), 'linux');
  const mic = { kind: 'microphone', label: 'Shure MV7', stillMuted: false };
  assert.match(deviceNoticeText(mic, 'windows'), /muted in Windows or in use/);
  assert.match(deviceNoticeText(mic, 'macos'), /muted in macOS or in use/);
  assert.doesNotMatch(deviceNoticeText({ ...mic, stillMuted: true }, 'macos'), /Windows/);
  assert.match(deviceNoticeText({ ...mic, stillMuted: true }, 'macos'), /System Settings › Sound/);
  assert.doesNotMatch(deviceNoticeText({ kind: 'camera', label: '', stillMuted: true }, 'linux'), /Windows/);
});

// ---- Codex review of 68ea271 ----
test('Mute also silences a microphone replaced mid-take that still feeds the host original; unmute re-enables it (P1)', async () => {
  const r = rig();
  await r.preview.start(both, allow);
  const oldMic = r.shown.getAudioTracks()[0];
  await r.preview.setDevice('microphone', both, allow, { reconnect: true, retain: true });
  const newMic = r.shown.getAudioTracks()[0];
  r.preview.setMicrophoneMuted(true);
  assert.deepEqual([oldMic.enabled, newMic.enabled], [false, false], 'Muted means every microphone the host records from');
  r.preview.setMicrophoneMuted(false);
  assert.deepEqual([oldMic.enabled, newMic.enabled], [true, true]);
  r.preview.setMicrophoneMuted(true);
  await r.preview.setDevice('microphone', both, allow, { reconnect: true, retain: true });
  assert.equal(newMic.enabled, false, 'a track retained while muted stays muted');
  r.preview.releaseRetained();
  assert.deepEqual([oldMic.stopped, newMic.stopped], [1, 1], 'released once the original finished');
  r.preview.setMicrophoneMuted(false);
  assert.equal(oldMic.enabled, false, 'a released track is no longer touched');
});

test('whether a replaced track is kept is decided at the swap, not when the acquisition started (P2)', async () => {
  for (const [atSwap, kept] of [[true, true], [false, false]]) {
    const r = rig();
    await r.preview.start(both, allow);
    const oldMic = r.shown.getAudioTracks()[0];
    let recording = !atSwap, asked = 0;
    const acquire = r.preview['acquire'];
    r.preview['acquire'] = async request => { recording = atSwap; return acquire(request); }; // Record pressed (or not) mid-acquisition
    const result = await r.preview.setDevice('microphone', both, allow, { retain: () => { asked++; return recording; } });
    assert.equal(asked, 1);
    assert.equal(oldMic.stopped, kept ? 0 : 1, `recording at swap: ${atSwap}`);
    assert.deepEqual(result.retired, kept ? [oldMic] : []);
  }
});

test('HostCalls.replaceProgramVideo hands every call and the shared call stream the new scene track, audio untouched (P2)', async () => {
  const { HostCalls } = await import('../dist/host-calls.js');
  const element = () => ({ addEventListener() {}, textContent: '', hidden: false, disabled: false });
  const calls = new HostCalls({}, element(), element(), element());
  try {
    const oldVideo = new Track('video'), mic = new Track('audio'), next = new Track('video');
    const shared = new Stream([oldVideo, mic]);
    calls['stream'] = shared;
    const replaced = [];
    calls['calls'].set('a', { peer: { replaceVideoTrack: async t => replaced.push(['a', t]) } });
    calls['calls'].set('b', { peer: { replaceVideoTrack: async t => replaced.push(['b', t]) } });
    calls['calls'].set('c', { peer: null });
    await calls.replaceProgramVideo(next);
    assert.deepEqual(replaced, [['a', next], ['b', next]]);
    assert.deepEqual(shared.getTracks(), [mic, next], 'new calls start from the live scene track');
    calls['calls'].clear(); calls['stream'] = null;
  } finally { calls['destroyed'] = true; clearInterval(calls['timer']); }
});
