// ClaudeBWAI — 3.6a: Share screen on macOS lets macOS ask first (getSources), then shows BlastCast's message; never silent.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { openPicker } = require('../desktop/display-picker.cjs');
const { SCREEN_BLOCKED_MESSAGE, screenBlockedMessage, privacyUrl } = require('../desktop/media-access.cjs');
const { createChooseScreen } = require('../desktop/boundary.cjs');
const src = [{ id: 'screen:1', name: 'First', thumbnail: { toDataURL: () => '' } }];
function run({ platform = 'darwin', status = 'denied', sources = src, throws = false, withGate = true }) {
  const calls = []; const children = [];
  const contents = new EventEmitter(); const parent = new EventEmitter(); parent.webContents = contents; parent.isDestroyed = () => false; contents.isDestroyed = () => false;
  class Child extends EventEmitter {
    constructor() { super(); this.webContents = new EventEmitter(); this.webContents.session = { setPermissionRequestHandler() {}, setPermissionCheckHandler() {}, webRequest: { onBeforeRequest() {} }, protocol: { handle() {} } }; this.webContents.setWindowOpenHandler = () => {}; children.push(this); }
    isDestroyed() { return false; } destroy() {} async loadURL() {} show() { this.shown = true; }
  }
  const desktopCapturer = { getSources: async () => { calls.push(`getSources(status=${status})`); if (throws) throw new Error('denied'); return sources; } };
  const gate = () => { calls.push('gate'); return screenBlockedMessage({ platform, getStatus: () => status }); };
  const result = openPicker({ parent, stillTrusted: () => true, BrowserWindow: Child, desktopCapturer, icon: null, timeoutMs: 1000, platform, screenBlocked: withGate ? gate : null });
  return { calls, children, result, parent };
}
const tick = () => new Promise(r => setImmediate(r));
test('denied: getSources is called first, then the message comes back and no picker opens', async () => {
  const f = run({ status: 'denied' });
  assert.deepEqual(await f.result, { blocked: true, message: SCREEN_BLOCKED_MESSAGE });
  assert.deepEqual(f.calls, ['getSources(status=denied)', 'gate']);
  assert.equal(f.children.length, 0);
});
test('not-determined / unknown also reach getSources, then the message', async () => {
  for (const status of ['not-determined', 'restricted']) assert.equal((await run({ status }).result).blocked, true);
});
test('getSources throwing while blocked still ends in the message, not silence', async () => {
  assert.deepEqual(await run({ status: 'denied', throws: true }).result, { blocked: true, message: SCREEN_BLOCKED_MESSAGE });
});
test('granted: the picker opens, no message', async () => {
  const f = run({ status: 'granted' }); await tick(); await tick();
  assert.equal(f.children.length, 1); assert.equal(f.children[0].shown, true);
  f.parent.emit('closed'); assert.equal(await f.result, null);
});
test('darwin with an empty source list shows the message even when status reads granted', async () => {
  assert.deepEqual(await run({ status: 'granted', sources: [] }).result, { blocked: true, message: SCREEN_BLOCKED_MESSAGE });
});
test('non-darwin unchanged: empty list still opens the picker page, the status is never asked', async () => {
  for (const platform of ['linux', 'win32']) {
    const f = run({ platform, status: 'denied', sources: [] }); await tick(); await tick();
    assert.equal(f.children.length, 1); assert.equal(f.children[0].shown, true);
    f.parent.emit('closed'); assert.equal(await f.result, null);
  }
});
test('no gate configured: behaviour is exactly the old picker', async () => {
  const f = run({ withGate: false, sources: [] }); await tick(); await tick();
  assert.equal(f.children.length, 1); f.parent.emit('closed'); await f.result;
});
test('chooseScreen surfaces the message and the Screen Recording settings link exists', async () => {
  const permission = { breach: () => false, takeInput: () => true, disarm() {}, arm() { throw new Error('must not arm'); } };
  const out = await createChooseScreen({ permission, picker: { active: false, choose: async () => ({ blocked: true, message: SCREEN_BLOCKED_MESSAGE }) }, getContents: () => null })();
  assert.deepEqual(out, { ok: false, blocked: true, message: SCREEN_BLOCKED_MESSAGE });
  assert.match(privacyUrl('screen'), /^x-apple\.systempreferences:.*Privacy_ScreenCapture$/);
});
test('renderer: a blocked screen share points the existing settings button at Screen Recording', async () => {
  const { readFileSync } = await import('node:fs');
  const studio = readFileSync(new URL('../src/studio.ts', import.meta.url), 'utf8');
  const bridge = readFileSync(new URL('../src/bridge.ts', import.meta.url), 'utf8');
  assert.match(bridge, /openPrivacySettings\(kind:'camera'\|'microphone'\|'screen'\)/);
  assert.match(studio, /let privacyKind: 'camera' \| 'microphone' \| 'screen' \| null/);
  assert.match(studio, /chosen\?\.blocked === true[^\n]*privacyKind = 'screen'; privacyButton\.hidden = false; throw new ScreenBlockedError/);
  assert.match(studio, /const share = new ScreenShare\(async \(\) => \{\s*hidePrivacyButton\(\);/);
});
