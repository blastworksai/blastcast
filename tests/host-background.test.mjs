// ClaudeBWAI — host studio contract: background controls, denial button, static toggle names.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const html = await readFile(new URL('../dist/index.html', import.meta.url), 'utf8');
const studio = await readFile(new URL('../dist/studio.js', import.meta.url), 'utf8');

test('background select has off, blur and image', () => {
  const select = /<select id="camera-background"[^>]*>(.*?)<\/select>/s.exec(html)?.[1] ?? '';
  for (const value of ['off', 'blur', 'image']) assert.match(select, new RegExp(`<option value="${value}"`));
  assert.match(html, /id="camera-background-change"/);
});
test('privacy settings button exists and is hidden by default', () => {
  assert.match(html, /<button id="open-privacy-settings" class="secondary"[^>]*hidden[^>]*>Open System Settings<\/button>/);
});
test('no tf or bodypix script tags remain and nothing comes from a CDN', () => {
  assert.doesNotMatch(html, /bodypix|tf\.min|body-pix/i);
  assert.ok(html.indexOf('src="studio.js"') > -1);
  assert.doesNotMatch(html, /<script[^>]+src="https?:\/\//);
  assert.doesNotMatch(html, /storage\.googleapis|cdn\.jsdelivr|unpkg/);
});
test('toggle names are static and the studio persists the background', () => {
  assert.match(html, /aria-label="Mute microphone" aria-pressed="true"/);
  assert.match(html, /aria-label="Turn off camera" aria-pressed="true"/);
  assert.doesNotMatch(studio, /Enable microphone|Disable microphone|Enable camera|Disable camera/);
  assert.match(studio, /background:\s*background\.mode/);
  assert.match(studio, /chooseBackgroundImage/);
  assert.doesNotMatch(studio, /fetch\(\s*(dataUrl|stored)/);
});
