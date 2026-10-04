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
test('chooseScreen refuses with the message and opens no picker when blocked; unchanged otherwise', async () => {
  let opened = 0, disarmed = 0, armed = 0;
  const permission = { breach: () => false, takeInput: () => true, disarm: () => { disarmed++; }, arm: () => { armed++; } };
  const picker = { active: false, choose: async () => { opened++; return { id: 's' }; } };
  const blocked = createChooseScreen({ permission, picker, getContents: () => null, screenBlocked: () => MESSAGE });
  assert.deepEqual(await blocked(), { ok: false, blocked: true, message: MESSAGE });
  assert.equal(opened, 0); assert.equal(armed, 0);
  const fine = createChooseScreen({ permission, picker, getContents: () => null, screenBlocked: () => null });
  assert.deepEqual(await fine(), { ok: true }); assert.equal(opened, 1);
  assert.deepEqual(await createChooseScreen({ permission, picker, getContents: () => null })(), { ok: true });
});
test('main wires the real platform and status reader; the studio shows the message', () => {
  const main = readFileSync(new URL('../desktop/main.cjs', import.meta.url), 'utf8');
  assert.match(main, /screenBlocked: \(\) => screenBlockedMessage\(\{ platform: process\.platform, getStatus: kind => systemPreferences\.getMediaAccessStatus\(kind\) \}\)/);
  const studio = readFileSync(new URL('../src/studio.ts', import.meta.url), 'utf8');
  assert.match(studio, /chosen\?\.blocked === true[^\n]*throw new ScreenBlockedError\(chosen\.message\)/);
});
test('ScreenShare reports the blocked message instead of the cancelled-picker line', async () => {
  const { ScreenShare, ScreenBlockedError } = await import('../dist/screen-share.js');
  const seen = [];
  await new ScreenShare(async () => { throw new ScreenBlockedError(MESSAGE); }, (_s, m) => seen.push(m)).start();
  assert.equal(seen.at(-1), MESSAGE);
});
