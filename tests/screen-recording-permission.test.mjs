// ClaudeBWAI — macOS Screen Recording permission notice before a host screen share.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { screenBlockedMessage, SCREEN_BLOCKED_MESSAGE } = require('../desktop/media-access.cjs');
const { createChooseScreen } = require('../desktop/boundary.cjs');
const MESSAGE = 'macOS is blocking screen sharing. Turn on BlastCast in System Settings → Privacy & Security → Screen Recording, then restart BlastCast.';
test('darwin with a denied status shows the message verbatim', () => {
  const asked = [];
  assert.equal(screenBlockedMessage({ platform: 'darwin', getStatus: k => { asked.push(k); return 'denied'; } }), MESSAGE);
  assert.deepEqual(asked, ['screen']);
  assert.equal(SCREEN_BLOCKED_MESSAGE, MESSAGE);
  for (const s of ['not-determined', 'restricted', 'unknown']) assert.equal(screenBlockedMessage({ platform: 'darwin', getStatus: () => s }), MESSAGE);
  assert.equal(screenBlockedMessage({ platform: 'darwin', getStatus: () => { throw new Error('x'); } }), MESSAGE);
});
test('darwin granted, linux and windows show nothing and never ask', () => {
  assert.equal(screenBlockedMessage({ platform: 'darwin', getStatus: () => 'granted' }), null);
  for (const platform of ['linux', 'win32']) assert.equal(screenBlockedMessage({ platform, getStatus: () => { throw new Error('must not ask'); } }), null);
});
// 3.6a: the old assertions pinned a silent pre-picker short-circuit in chooseScreen and main's screenBlocked wiring into it; both replaced.
test('chooseScreen passes a picker blocked result through with the message, arms nothing; a real pick still arms', async () => {
  let armed = 0;
  const permission = { breach: () => false, takeInput: () => true, disarm: () => {}, arm: () => { armed++; } };
  const blocked = createChooseScreen({ permission, picker: { active: false, choose: async () => ({ blocked: true, message: MESSAGE }) }, getContents: () => null });
  assert.deepEqual(await blocked(), { ok: false, blocked: true, message: MESSAGE });
  assert.equal(armed, 0);
  const fine = createChooseScreen({ permission, picker: { active: false, choose: async () => ({ id: 's' }) }, getContents: () => null });
  assert.deepEqual(await fine(), { ok: true }); assert.equal(armed, 1);
});
test('chooseScreen no longer short-circuits before the picker', () => {
  const boundary = readFileSync(new URL('../desktop/boundary.cjs', import.meta.url), 'utf8');
  assert.doesNotMatch(boundary, /screenBlocked\(\)/);
});
test('main hands the status gate to the picker, not to chooseScreen', () => {
  const main = readFileSync(new URL('../desktop/main.cjs', import.meta.url), 'utf8');
  const call = (name) => { const at = main.indexOf(`${name}(`); let depth = 0; for (let i = main.indexOf('(', at); i < main.length; i++) { if (main[i] === '(') depth++; else if (main[i] === ')' && --depth === 0) return main.slice(at, i + 1); } return ''; };
  assert.match(call('installDisplayPicker'), /screenBlocked:\s*\(\)\s*=>\s*screenBlockedMessage\(\{[^}]*getMediaAccessStatus\(kind\)/);
  assert.doesNotMatch(call('createChooseScreen'), /screenBlocked/);
});
test('the studio shows the blocked message', () => {
  const studio = readFileSync(new URL('../src/studio.ts', import.meta.url), 'utf8');
  assert.match(studio, /chosen\?\.blocked === true[^\n]*throw new ScreenBlockedError\(chosen\.message\)/);
});
test('ScreenShare reports the blocked message instead of the cancelled-picker line', async () => {
  const { ScreenShare, ScreenBlockedError } = await import('../dist/screen-share.js');
  const seen = [];
  await new ScreenShare(async () => { throw new ScreenBlockedError(MESSAGE); }, (_s, m) => seen.push(m)).start();
  assert.equal(seen.at(-1), MESSAGE);
});
