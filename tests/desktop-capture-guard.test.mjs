// ClaudeBWAI — the studio refuses the picker-less chromeMediaSource getUserMedia form.
import test from 'node:test';
import assert from 'node:assert/strict';
globalThis.DOMException ??= class extends Error { constructor(m, n) { super(m); this.name = n; } };
const { asksForDesktop, guardDesktopCapture } = await import('../dist/desktop-capture-guard.js');

test('detects chromeMediaSource anywhere in the constraints', () => {
  assert.equal(asksForDesktop({ video: { mandatory: { chromeMediaSource: 'desktop' } } }), true);
  assert.equal(asksForDesktop({ audio: { mandatory: { chromeMediaSource: 'desktop' } } }), true);
  assert.equal(asksForDesktop({ video: { chromeMediaSourceId: 'screen:0:0' } }), true);
  assert.equal(asksForDesktop({ video: { deviceId: { exact: 'cam' }, height: 1080 }, audio: true }), false);
  assert.equal(asksForDesktop(undefined), false);
});

test('guarded getUserMedia refuses desktop capture and passes camera/mic through, and cannot be restored', async () => {
  const calls = [];
  const devices = { getUserMedia: async c => { calls.push(c); return 'stream'; } };
  guardDesktopCapture(devices);
  await assert.rejects(devices.getUserMedia({ video: { mandatory: { chromeMediaSource: 'desktop' } } }), e => e.name === 'NotAllowedError');
  assert.equal(await devices.getUserMedia({ video: true, audio: true }), 'stream');
  assert.equal(calls.length, 1);
  assert.throws(() => { 'use strict'; devices.getUserMedia = async () => 'bypass'; });
});

test('the prototype method is guarded too, so .call() on the native method cannot reach desktop capture', async () => {
  const calls = [];
  class FakeMediaDevices { async getUserMedia(c) { calls.push([this, c]); return 'stream'; } }
  const devices = new FakeMediaDevices();
  guardDesktopCapture(devices);
  const viaPrototype = Object.getPrototypeOf(devices).getUserMedia;
  await assert.rejects(viaPrototype.call(devices, { video: { mandatory: { chromeMediaSource: 'desktop' } } }), e => e.name === 'NotAllowedError');
  await assert.rejects(FakeMediaDevices.prototype.getUserMedia.call(devices, { video: { chromeMediaSourceId: 'screen:0:0' } }), e => e.name === 'NotAllowedError');
  assert.equal(await devices.getUserMedia({ audio: true }), 'stream');
  assert.equal(calls.length, 1); assert.equal(calls[0][0], devices);
});
