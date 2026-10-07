// CodexBWAI — pure geometry and shipping-asset contract for offline guest effects.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { coverRect } from '../dist/camera-background.js';

test('background images cover the camera frame without changing aspect ratio', () => {
  assert.deepEqual(coverRect(1920, 1080, 1280, 720), [0, 0, 1280, 720]);
  assert.deepEqual(coverRect(1000, 1000, 1280, 720), [0, -280, 1280, 1280]);
  assert.deepEqual(coverRect(2000, 1000, 720, 1280), [-920, 0, 2560, 1280]);
  assert.throws(() => coverRect(0, 100, 100, 100), /dimensions/);
});

test('guest page offers only offline off, blur and image modes', async () => {
  const html = await readFile(new URL('../dist/guest.html', import.meta.url), 'utf8');
  assert.match(html, /id="guest-background"/);
  assert.match(html, /<option value="off">Off<\/option><option value="blur">Blur<\/option><option value="image">Image<\/option>/);
  assert.doesNotMatch(html, /bodypix|tf\.min|body-pix/i);
  assert.doesNotMatch(html, /<script[^>]+src="https?:/);
  assert.doesNotMatch(html, /storage\.googleapis|cdn\.jsdelivr|unpkg/);
});

test('camera background engine is MediaPipe served from /mediapipe/ with no outside URL', async () => {
  const src = await readFile(new URL('../src/camera-background.ts', import.meta.url), 'utf8');
  for (const path of ['/mediapipe/vision_bundle.mjs', '/mediapipe/wasm', '/mediapipe/selfie_segmenter.tflite']) assert.ok(src.includes(path), path);
  assert.doesNotMatch(src, /https?:\/\//);
  assert.doesNotMatch(src, /window\.(tf|bodyPix)\b/);
});
