import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Preview, constraints, mediaError } from '../dist/preview.js';

class Track extends EventTarget {
  constructor(kind, settings = {}) { super(); this.kind = kind; this.settings = settings; this.readyState = 'live'; this.muted = false; this.stopped = 0; }
  getSettings() { return this.settings; }
  stop() { this.stopped++; this.readyState = 'ended'; }
}
function stream(settings = { width: 1280, height: 720 }) {
  const tracks = [new Track('video', settings), new Track('audio')];
  return { tracks, getTracks: () => [...tracks], addTrack: track => tracks.push(track), removeTrack: track => { const i = tracks.indexOf(track); if (i >= 0) tracks.splice(i, 1); }, getVideoTracks: () => tracks.filter(t => t.kind === 'video'), getAudioTracks: () => tracks.filter(t => t.kind === 'audio') };
}
const selection = { camera: '', microphone: '', height: 1080 };
const allow = async () => true;
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

test('requests 1080p or 4K host capture and automatic guest capture up to 4K', () => {
  const value = constraints({ camera: 'cam', microphone: 'mic', height: 1080 });
  assert.deepEqual(value.video.deviceId, { exact: 'cam' });
  assert.deepEqual(value.audio.deviceId, { exact: 'mic' });
  assert.equal(value.video.height.max, 1080);
  assert.equal(value.video.width.max, 1920);
  assert.equal(value.video.frameRate.max, 30);
  const ultra = constraints({ ...selection, height: 2160 });
  assert.equal(ultra.video.height.max, 2160);
  assert.equal(ultra.video.width.max, 3840);
  const automatic = constraints({ ...selection, height: 'auto' });
  assert.equal(automatic.video.height.ideal, 2160);
  assert.equal(automatic.video.width.ideal, 3840);
  assert.throws(() => constraints({ ...selection, height: 720 }));
});
test('denied or cancelled app permission never acquires devices', async () => {
  let calls = 0;
  const preview = new Preview(async () => { calls++; return stream(); }, () => {});
  await preview.start(selection, async () => false);
  assert.equal(calls, 0); assert.equal(preview.state.phase, 'idle');
});
test('cancelling while native permission is pending never opens devices', async () => {
  const permission = deferred(); let calls = 0;
  const preview = new Preview(async () => { calls++; return stream(); }, () => {});
  const pending = preview.start(selection, () => permission.promise);
  preview.stop(); permission.resolve(true); await pending;
  assert.equal(calls, 0); assert.equal(preview.state.phase, 'idle');
});
test('late acquisition after cancel immediately releases every track', async () => {
  const media = deferred(); const acquired = stream();
  const preview = new Preview(() => media.promise, () => {});
  const pending = preview.start(selection, allow); await Promise.resolve();
  preview.stop(); media.resolve(acquired); await pending;
  assert.ok(acquired.tracks.every(t => t.stopped === 1)); assert.equal(preview.state.phase, 'idle');
});
test('a stale request cannot replace a newer preview', async () => {
  const old = deferred(); const first = stream(); const latest = stream(); let calls = 0; let shown;
  const preview = new Preview(() => ++calls === 1 ? old.promise : Promise.resolve(latest), (_, s) => { shown = s; });
  const pending = preview.start(selection, allow); await Promise.resolve();
  await preview.start(selection, allow); old.resolve(first); await pending;
  assert.equal(shown, latest); assert.ok(first.tracks.every(t => t.stopped === 1));
  preview.stop(); assert.ok(latest.tracks.every(t => t.stopped === 1));
});
for (const name of ['NotAllowedError', 'NotFoundError', 'NotReadableError', 'OverconstrainedError', 'AbortError']) {
  test(`${name} is visible and can recover on retry`, async () => {
    let fail = true; const acquired = stream();
    const preview = new Preview(async () => { if (fail) throw Object.assign(new Error('private driver detail'), { name }); return acquired; }, () => {});
    await preview.start(selection, allow);
    assert.equal(preview.state.phase, 'error'); assert.equal(preview.state.message, mediaError(Object.assign(new Error(), { name })));
    assert.ok(!preview.state.message.includes('private driver detail'));
    fail = false; await preview.start(selection, allow); assert.equal(preview.state.phase, 'live'); preview.stop();
  });
}
test('device loss closes its companion track and exposes a recovery path', async () => {
  const acquired = stream(); const preview = new Preview(async () => acquired, () => {});
  await preview.start(selection, allow); acquired.tracks[0].dispatchEvent(new Event('ended'));
  assert.equal(preview.state.phase, 'error'); assert.ok(acquired.tracks.every(t => t.stopped === 1));
});
test('temporary mute is not ready; both tracks must recover', async () => {
  const acquired = stream(); const preview = new Preview(async () => acquired, () => {});
  await preview.start(selection, allow);
  for (const track of acquired.tracks) { track.muted = true; track.dispatchEvent(new Event('mute')); }
  assert.equal(preview.state.phase, 'interrupted');
  acquired.tracks[0].muted = false; acquired.tracks[0].dispatchEvent(new Event('unmute'));
  assert.equal(preview.state.phase, 'interrupted');
  acquired.tracks[1].muted = false; acquired.tracks[1].dispatchEvent(new Event('unmute'));
  assert.equal(preview.state.phase, 'live'); preview.stop();
});
test('resolution above the selected host output or missing audio cannot become ready', async () => {
  for (const acquired of [stream({ width: 3840, height: 2160 }), stream()]) {
    if (acquired.tracks[0].settings.width === 1280) acquired.tracks.pop();
    const preview = new Preview(async () => acquired, () => {});
    await preview.start(selection, allow);
    assert.equal(preview.state.phase, 'error'); assert.ok(acquired.tracks.every(t => t.stopped === 1));
  }
});
test('a stream already muted when acquired is not reported ready', async () => {
  const acquired = stream(); acquired.tracks[1].muted = true;
  const preview = new Preview(async () => acquired, () => {});
  await preview.start(selection, allow);
  assert.equal(preview.state.phase, 'interrupted'); preview.stop();
});

test('manual mute disables audio, preserves video and survives restart', async () => {
  let acquired; const preview = new Preview(async () => (acquired = stream()), () => {});
  preview.setMicrophoneMuted(true);
  await preview.start(selection, allow);
  assert.equal(acquired.getAudioTracks()[0].enabled, false);
  assert.equal(acquired.getVideoTracks()[0].readyState, 'live');
  preview.setMicrophoneMuted(false);
  assert.equal(acquired.getAudioTracks()[0].enabled, true);
  preview.setMicrophoneMuted(true);
  preview.stop(); await preview.start(selection, allow);
  assert.equal(acquired.getAudioTracks()[0].enabled, false);
  assert.equal(preview.state.phase, 'live'); preview.stop();
});


// CodexBWAI: explicit host source toggles; legacy guest requests remain both-device.
function sourceStream(kind) {
  const media = stream();
  media.tracks.splice(kind === 'video' ? 1 : 0, 1);
  return media;
}
test('disabled sources never authorize or acquire', async () => {
  let calls = 0;
  const preview = new Preview(async () => { calls++; return stream(); }, () => {});
  await preview.start({ ...selection, cameraEnabled: false, microphoneEnabled: false }, async () => { calls++; return true; });
  assert.equal(calls, 0); assert.equal(preview.state.phase, 'idle');
});
for (const kind of ['video', 'audio']) {
  test(`independent ${kind} source works without its companion`, async () => {
    let seen; let shown;
    const media = sourceStream(kind);
    const preview = new Preview(async c => { seen = c; return media; }, (_, s) => { shown = s; });
    await preview.start({ ...selection, cameraEnabled: kind === 'video', microphoneEnabled: kind === 'audio' }, allow);
    assert.equal(preview.state.phase, 'live'); assert.equal(shown, media);
    assert.equal(seen[kind === 'video' ? 'audio' : 'video'], false);
    assert.equal(shown.getTracks().length, 1);
    await preview.start({ ...selection, cameraEnabled: false, microphoneEnabled: false }, allow);
    assert.equal(media.tracks[0].stopped, 1); assert.equal(shown, null);
  });
}
test('camera failure leaves microphone active, and retry clears source errors', async () => {
  let fail = true; let shown; const acquired = [];
  const preview = new Preview(async c => {
    if (c.video && fail) throw Object.assign(new Error('driver secret'), { name: 'NotReadableError' });
    const media = sourceStream(c.video ? 'video' : 'audio'); acquired.push(media); return media;
  }, (_, s) => { shown = s; });
  const enabled = { ...selection, cameraEnabled: true, microphoneEnabled: true };
  preview.setMicrophoneMuted(true);
  await preview.start(enabled, allow);
  assert.equal(preview.state.phase, 'live'); assert.match(preview.state.errors.camera, /^Camera:/);
  assert.equal(shown.getAudioTracks()[0].enabled, false); assert.equal(shown.getVideoTracks().length, 0);
  fail = false; await preview.start(enabled, allow);
  assert.equal(preview.state.errors, undefined); assert.equal(shown.getTracks().length, 2);
  assert.equal(shown.getAudioTracks()[0].enabled, false); preview.stop();
});
test('independent device loss retains the other active source', async () => {
  let shown;
  const preview = new Preview(async c => sourceStream(c.video ? 'video' : 'audio'), (_, s) => { shown = s; });
  await preview.start({ ...selection, cameraEnabled: true, microphoneEnabled: true }, allow);
  const mic = shown.getAudioTracks()[0]; const cam = shown.getVideoTracks()[0];
  cam.dispatchEvent(new Event('ended'));
  assert.equal(preview.state.phase, 'live'); assert.match(preview.state.errors.camera, /disconnected/);
  assert.equal(mic.stopped, 0); assert.equal(shown.getVideoTracks().length, 0); preview.stop();
  assert.equal(mic.stopped, 1);
});
test('cancel releases an acquired source while the other permission remains pending', async () => {
  const pending = deferred(); const camera = sourceStream('video'); const mic = sourceStream('audio');
  const preview = new Preview(async c => c.video ? camera : pending.promise, () => {});
  const starting = preview.start({ ...selection, cameraEnabled: true, microphoneEnabled: true }, allow);
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
  preview.stop(); assert.equal(camera.tracks[0].stopped, 1);
  pending.resolve(mic); await starting;
  assert.equal(mic.tracks[0].stopped, 1); assert.equal(preview.state.phase, 'idle');
});
test('unrequested tracks are released and never exposed', async () => {
  const media = stream(); const unwanted = media.getAudioTracks()[0]; let shown;
  const preview = new Preview(async () => media, (_, s) => { shown = s; });
  await preview.start({ ...selection, cameraEnabled: true, microphoneEnabled: false }, allow);
  assert.equal(unwanted.stopped, 1); assert.equal(shown.getAudioTracks().length, 0); preview.stop();
});
