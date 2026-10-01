import assert from 'node:assert/strict';
import test from 'node:test';
import { composeProgramOutput } from '../dist/program-output.js';

test('program output sends only composed scene video plus the selected audio mix', () => {
  const sceneVideo = { kind: 'video', id: 'composed-scene' };
  const rawCamera = { kind: 'video', id: 'raw-camera' };
  const microphone = { kind: 'audio', id: 'host-microphone' };
  const tracks = [];
  const output = composeProgramOutput(
    { getVideoTracks: () => [sceneVideo] },
    { getAudioTracks: () => [microphone], getVideoTracks: () => [rawCamera] },
    () => ({ addTrack: track => tracks.push(track) }),
  );
  assert.ok(output);
  assert.deepEqual(tracks, [sceneVideo, microphone]);
  assert.ok(!tracks.includes(rawCamera));
});
