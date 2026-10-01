// CodexBWAI — orchestration proof, separate from the real media smoke.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Recording, MAX_CHUNK, MAX_PENDING, recordingVideoBitrate } from '../dist/recording.js';
const stream = { getTracks: () => [{ readyState: 'live' }] };
test('recording bitrate follows the selected output resolution', () => {
  const media = (width, height) => ({ getVideoTracks: () => [{ getSettings: () => ({ width, height }) }] });
  assert.equal(recordingVideoBitrate(media(1920, 1080)), 6000000);
  assert.equal(recordingVideoBitrate(media(3840, 2160)), 24000000);
});
function fixture(overrides = {}) {
  const calls = [];
  const bridge = {
    beginRecording: async () => ({ ok: true, id: 'one' }),
    appendRecording: async (id, sequence, bytes) => { calls.push(['append', sequence, bytes.byteLength]); return { ok: true }; },
    finishRecording: async () => { calls.push(['finish']); return { ok: true, name: 'episode.webm' }; },
    abortRecording: async () => { calls.push(['abort']); return { ok: false, message: 'Aborted' }; },
    ...overrides,
  };
  const recorder = {
    state: 'inactive', start() { this.state = 'recording'; },
    stop() { this.state = 'inactive'; queueMicrotask(() => {
      this.ondataavailable({ data: new Blob(['tail']) }); this.onstop();
    }); },
  };
  return { recording: new Recording(bridge, () => {}, () => recorder), recorder, calls };
}
test('stop drains the final data event before finalization; second recording starts cleanly', async () => {
  const { recording, recorder, calls } = fixture();
  await recording.start(stream);
  recorder.ondataavailable({ data: new Blob(['start']) });
  await recording.stop();
  assert.deepEqual(calls, [['append', 0, 5], ['append', 1, 4], ['finish']]);
  assert.equal(recording.state.phase, 'complete');
  assert.equal(recording.state.pendingBytes, 0);
  calls.length = 0;
  await recording.start(stream); await recording.stop();
  assert.deepEqual(calls, [['append', 0, 4], ['finish']]);
});
test('oversize media stops honestly without publishing success', async () => {
  const { recording, recorder, calls } = fixture();
  await recording.start(stream);
  recorder.ondataavailable({ data: { size: MAX_CHUNK + 1 } });
  await recording.stop();
  assert.equal(recording.state.phase, 'error');
  assert.equal(calls.some(call => call[0] === 'finish'), false);
  assert.equal(recording.state.peakBytes, 0);
});
test('disk rejection aborts after draining instead of finishing', async () => {
  const { recording, recorder, calls } = fixture({ appendRecording: async () => ({ ok: false, message: 'Disk full' }) });
  await recording.start(stream);
  recorder.ondataavailable({ data: new Blob(['media']) });
  await recording.stop();
  assert.equal(recording.state.phase, 'error');
  assert.match(recording.state.message, /Disk full/);
  assert.equal(calls.some(call => call[0] === 'finish'), false);
});
test('slow disk saturates the queue at its fixed ceiling and waits for pending writes before abort', async () => {
  let release; let entered;
  const pending = new Promise(resolve => { release = resolve; });
  const writing = new Promise(resolve => { entered = resolve; });
  const { recording, recorder, calls } = fixture({ appendRecording: async () => { entered(); await pending; return { ok: true }; } });
  await recording.start(stream);
  const blob = new Blob([new Uint8Array(MAX_CHUNK)]);
  recorder.ondataavailable({ data: blob }); await writing;
  recorder.ondataavailable({ data: blob });
  recorder.ondataavailable({ data: new Blob(['overflow']) });
  assert.equal(recording.state.peakBytes, MAX_PENDING);
  assert.equal(calls.length, 0);
  release(); await recording.stop();
  assert.equal(recording.state.phase, 'error');
  assert.equal(recording.state.pendingBytes, 0);
  assert.ok(calls.some(call => call[0] === 'abort'));
  assert.equal(calls.some(call => call[0] === 'finish'), false);
});
test('device loss during file opening aborts without starting capture', async () => {
  let opened;
  const { recording, recorder, calls } = fixture({ beginRecording: () => new Promise(resolve => { opened = resolve; }) });
  const start = recording.start(stream);
  await recording.fail('Device disappeared');
  opened({ ok: true, id: 'one' }); await start;
  assert.equal(recorder.state, 'inactive');
  assert.equal(recording.state.phase, 'error');
  assert.deepEqual(calls, [['abort']]);
});

test('episode identity comes from begin, survives completion, and clears before a failed new start', async () => {
  let next;
  const { recording } = fixture({ beginRecording: () => new Promise(resolve => { next = resolve; }) });
  assert.equal(recording.state.episodeId, null);
  const first = recording.start(stream);
  assert.equal(recording.state.episodeId, null);
  next({ ok: true, id: 'first-episode' }); await first;
  assert.equal(recording.state.episodeId, 'first-episode');
  await recording.stop();
  assert.equal(recording.state.episodeId, 'first-episode');
  const second = recording.start(stream);
  assert.equal(recording.state.phase, 'starting');
  assert.equal(recording.state.episodeId, null, 'previous saved originals cannot belong to a new attempt');
  next({ ok: false, message: 'Folder unavailable' }); await second;
  assert.equal(recording.state.phase, 'error');
  assert.equal(recording.state.episodeId, null);
  const third = recording.start(stream);
  next({ ok: true, id: 'third-episode' }); await third;
  await recording.fail('Device interrupted');
  assert.equal(recording.state.phase, 'error');
  assert.equal(recording.state.episodeId, 'third-episode', 'retained originals stay bound to the failed episode');
});
