// ClaudeBWAI — the macOS permission denial grid.
import test from 'node:test';
import assert from 'node:assert/strict';
import { denialMessage } from '../dist/media-denial.js';

const generic = /Access was not granted/;
test('granted and unknown states keep the generic text', () => {
  for (const [camera, microphone] of [['granted','granted'],['not-determined','unknown'],['unknown','not-determined'],['granted','not-determined']]) {
    const result = denialMessage({ camera, microphone });
    assert.match(result.text, generic); assert.equal(result.settings, null);
  }
});
test('denied camera only names the camera', () => {
  const result = denialMessage({ camera: 'denied', microphone: 'granted' });
  assert.match(result.text, /your camera\. Turn BlastCast on in System Settings/); assert.doesNotMatch(result.text, /microphone/); assert.equal(result.settings, 'camera');
});
test('restricted microphone only names the microphone', () => {
  const result = denialMessage({ camera: 'granted', microphone: 'restricted' });
  assert.match(result.text, /your microphone\./); assert.doesNotMatch(result.text, /camera/); assert.equal(result.settings, 'microphone');
});
test('both blocked name both and open the camera pane', () => {
  const result = denialMessage({ camera: 'denied', microphone: 'denied' });
  assert.match(result.text, /camera and microphone/); assert.equal(result.settings, 'camera');
});
