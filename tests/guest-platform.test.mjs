// ClaudeBWAI — phone support helpers for the guest page.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { timeoutSignal, WakeLockManager, isMobileDevice, isPhoneUserAgent } from '../dist/guest-platform.js';

test('timeoutSignal uses the native implementation when present', () => {
  const marker = new AbortController().signal;
  let asked = 0;
  assert.equal(timeoutSignal(1234, { timeout: ms => { asked = ms; return marker; } }), marker);
  assert.equal(asked, 1234);
});

test('timeoutSignal fallback aborts after the delay with a TimeoutError', async () => {
  const signal = timeoutSignal(20, {});
  assert.equal(signal.aborted, false);
  await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
  assert.equal(signal.aborted, true);
  assert.equal(signal.reason?.name, 'TimeoutError');
});

function fixture({ supported = true, visible = true, failRequest = false } = {}) {
  const listeners = [];
  const sentinels = [];
  const document = { visibilityState: visible ? 'visible' : 'hidden', addEventListener: (_t, fn) => listeners.push(fn) };
  const navigator = supported ? { wakeLock: { request: async type => {
    assert.equal(type, 'screen');
    if (failRequest) throw new DOMException('denied', 'NotAllowedError');
    const releaseListeners = [];
    const sentinel = { released: false, release: async () => { sentinel.released = true; }, addEventListener: (_t, fn) => releaseListeners.push(fn), fire: () => releaseListeners.forEach(f => f()) };
    sentinels.push(sentinel); return sentinel;
  } } } : {};
  const manager = new WakeLockManager({ navigator, document });
  const show = state => { document.visibilityState = state; listeners.forEach(fn => fn()); };
  return { manager, sentinels, show };
}
const tick = () => new Promise(resolve => setTimeout(resolve, 0));

test('wake lock is requested when wanted and released when not', async () => {
  const { manager, sentinels } = fixture();
  manager.setWanted(true); await tick();
  assert.equal(sentinels.length, 1); assert.equal(manager.held, true);
  manager.setWanted(true); await tick();
  assert.equal(sentinels.length, 1);
  manager.setWanted(false); await tick();
  assert.equal(sentinels[0].released, true); assert.equal(manager.held, false);
});

test('wake lock is re-acquired when the page returns to visible', async () => {
  const { manager, sentinels, show } = fixture();
  manager.setWanted(true); await tick();
  show('hidden'); sentinels[0].fire(); await tick(); // browsers drop the lock when hidden
  assert.equal(manager.held, false);
  show('visible'); await tick();
  assert.equal(sentinels.length, 2); assert.equal(manager.held, true);
});

test('returning to the page while a request is pending retries after that request fails', async () => {
  let reject; const sentinels = [];
  const listeners = [];
  const document = { visibilityState: 'visible', addEventListener: (_t, fn) => listeners.push(fn) };
  let first = true;
  const navigator = { wakeLock: { request: () => {
    if (first) { first = false; return new Promise((_r, j) => { reject = j; }); }
    const s = { release: async () => {}, addEventListener: () => {} }; sentinels.push(s); return Promise.resolve(s);
  } } };
  const manager = new WakeLockManager({ navigator, document });
  const show = state => { document.visibilityState = state; listeners.forEach(fn => fn()); };
  manager.setWanted(true); await tick();
  show('hidden'); show('visible');
  reject(new DOMException('page hidden', 'NotAllowedError')); await tick(); await tick();
  assert.equal(sentinels.length, 1); assert.equal(manager.held, true);
});

test('wake lock is not requested while hidden and is never re-acquired when unwanted', async () => {
  const { manager, sentinels, show } = fixture({ visible: false });
  manager.setWanted(true); await tick();
  assert.equal(sentinels.length, 0);
  manager.setWanted(false); show('visible'); await tick();
  assert.equal(sentinels.length, 0);
});

test('unsupported or refused wake lock never throws', async () => {
  const none = fixture({ supported: false });
  none.manager.setWanted(true); await tick(); none.show('visible'); none.manager.setWanted(false); await tick();
  assert.equal(none.manager.supported, false); assert.equal(none.manager.held, false);
  const refused = fixture({ failRequest: true });
  refused.manager.setWanted(true); await tick();
  assert.equal(refused.manager.held, false);
});

test('mobile hint uses a coarse pointer or a phone user agent only', () => {
  const mm = matches => () => ({ matches });
  assert.equal(isMobileDevice({ matchMedia: mm(true), navigator: { userAgent: 'x' } }), true);
  assert.equal(isMobileDevice({ matchMedia: mm(false), navigator: { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 15_0)' } }), true);
  assert.equal(isMobileDevice({ matchMedia: mm(false), navigator: { userAgent: 'Mozilla/5.0 (X11; Linux x86_64) Chrome/120' } }), false);
  assert.equal(isMobileDevice({ navigator: {} }), false);
});

test('isPhoneUserAgent is true for phone and tablet UAs only', () => {
  assert.equal(isPhoneUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 15_0 like Mac OS X)'), true);
  assert.equal(isPhoneUserAgent('Mozilla/5.0 (iPad; CPU OS 15_0 like Mac OS X)'), true);
  assert.equal(isPhoneUserAgent('Mozilla/5.0 (Linux; Android 13; Pixel 7) Chrome/120 Mobile'), true);
  assert.equal(isPhoneUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36'), false);
  assert.equal(isPhoneUserAgent('Mozilla/5.0 (X11; Linux x86_64) Chrome/120'), false);
  assert.equal(isPhoneUserAgent(undefined), false);
});

function joinDeviceIsUaOnly(source) {
  return /const phoneGuest = isPhoneUserAgent\(navigator\.userAgent\);/.test(source)
    && /\.\.\.\(phoneGuest \? \{ device: 'phone' \} : \{\}\)/.test(source)
    && !/mobileGuest \? \{ device: 'phone' \}/.test(source)
    && /\}, phoneGuest\);/.test(source) && !/\}, mobileGuest\);/.test(source); // GuestCall's codec/cap switch
}
test('guest join sends device phone from the user agent, never from a coarse pointer', () => {
  assert.equal(joinDeviceIsUaOnly(readFileSync(new URL('../src/guest.ts', import.meta.url), 'utf8')), true);
});
