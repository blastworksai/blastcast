// ClaudeBWAI — macOS camera/microphone decision grid.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const { decideMediaAccess, statusOf, privacyUrl } = createRequire(import.meta.url)('../desktop/media-access.cjs');
function run({ platform = 'darwin', mediaAllowed = false, status = {}, grant = {}, dialog = true } = {}) {
  const calls = { asked: [], dialogs: 0 };
  return decideMediaAccess({
    platform, mediaAllowed,
    getStatus: kind => status[kind],
    ask: async kind => { calls.asked.push(kind); return grant[kind] ?? true; },
    showDialog: async () => { calls.dialogs++; return dialog; },
  }).then(r => ({ ...r, ...calls }));
}
test('darwin granted+granted allows after the dialog, never asks macOS', async () => {
  const r = await run({ status: { camera: 'granted', microphone: 'granted' }, mediaAllowed: true });
  assert.deepEqual([r.allowed, r.dialogs, r.asked], [true, 0, []]);
});
test('darwin denied+denied refuses without BlastCast dialog or ask', async () => {
  const r = await run({ status: { camera: 'denied', microphone: 'denied' } });
  assert.deepEqual([r.allowed, r.blocked, r.dialogs, r.asked], [false, true, 0, []]);
  const s = await run({ status: { camera: 'restricted', microphone: 'denied' } });
  assert.deepEqual([s.allowed, s.dialogs, s.asked], [false, 0, []]);
});
test('darwin not-determined camera asks camera only', async () => {
  const r = await run({ status: { camera: 'not-determined', microphone: 'denied' } });
  assert.deepEqual([r.allowed, r.dialogs, r.asked], [true, 1, ['camera']]);
  const n = await run({ status: { camera: 'not-determined', microphone: 'denied' }, grant: { camera: false } });
  assert.equal(n.allowed, false);
});
test('darwin restricted+granted is allowed', async () => {
  const r = await run({ status: { camera: 'restricted', microphone: 'granted' } });
  assert.deepEqual([r.allowed, r.asked], [true, []]);
});
test('unknown status is asked like not-determined', async () => {
  const r = await run({ status: { camera: 'weird', microphone: undefined } });
  assert.deepEqual(r.asked, ['camera', 'microphone']);
});
test('a declined BlastCast dialog refuses', async () => {
  const r = await run({ status: { camera: 'granted', microphone: 'granted' }, dialog: false });
  assert.deepEqual([r.allowed, r.asked], [false, []]);
});
test('non-darwin keeps the dialog-only behaviour and never reads status', async () => {
  const r = await run({ platform: 'win32', status: { camera: 'denied', microphone: 'denied' } });
  assert.deepEqual([r.allowed, r.dialogs, r.asked], [true, 1, []]);
  assert.deepEqual(statusOf({ platform: 'linux', getStatus() { throw new Error('no'); } }), { camera: 'granted', microphone: 'granted' });
});
test('status maps unexpected values to unknown', () => {
  assert.deepEqual(statusOf({ platform: 'darwin', getStatus: k => (k === 'camera' ? 'denied' : 'banana') }), { camera: 'denied', microphone: 'unknown' });
});
test('privacy deep links are exactly camera or microphone', () => {
  assert.match(privacyUrl('camera'), /Privacy_Camera$/);
  assert.match(privacyUrl('microphone'), /Privacy_Microphone$/);
  assert.equal(privacyUrl('screen'), null);
  assert.equal(privacyUrl({ toString: () => 'camera' }), null);
});
