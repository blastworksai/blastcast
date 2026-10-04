// ClaudeBWAI — invite survives a refresh in the same tab (einh, 4 Oct: "Keep invite in the tab").
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolveInvite, forgetInvite, INVITE_STORAGE_KEY } from '../dist/guest-invite.js';

const TOKEN = 'A'.repeat(43);
const makeStore = () => { const m = new Map(); return { m, getItem: k => m.get(k) ?? null, setItem: (k, v) => void m.set(k, v), removeItem: k => void m.delete(k) }; };
const throwing = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); }, removeItem() { throw new Error('denied'); } };

test('a fragment token is returned and stored for the tab', () => {
  const s = makeStore();
  assert.equal(resolveInvite(`#invite=${TOKEN}`, s), TOKEN);
  assert.equal(s.m.get(INVITE_STORAGE_KEY), TOKEN);
});
test('a refresh without a fragment reads the tab store', () => {
  const s = makeStore(); resolveInvite(`#invite=${TOKEN}`, s);
  assert.equal(resolveInvite('', s), TOKEN);
});
test('an invalid stored value is rejected', () => {
  const s = makeStore();
  for (const bad of ['short', 'A'.repeat(44), `${'A'.repeat(42)}!`, '']) { s.m.set(INVITE_STORAGE_KEY, bad); assert.equal(resolveInvite('', s), ''); }
  assert.equal(resolveInvite('#invite=bad', s), '');
});
test('throwing or absent storage falls back to fragment-only', () => {
  assert.equal(resolveInvite(`#invite=${TOKEN}`, throwing), TOKEN);
  assert.equal(resolveInvite('', throwing), '');
  assert.equal(resolveInvite(`#invite=${TOKEN}`, null), TOKEN);
  assert.equal(resolveInvite('', null), '');
});
test('forget clears the tab copy and this invite\'s redemption keys only', () => {
  const s = makeStore(), l = makeStore(); s.m.set(INVITE_STORAGE_KEY, TOKEN);
  l.m.set('blastcast.guest.abc.key', 'k'); l.m.set('blastcast.guest.abc.name', 'n'); l.m.set('blastcast.guest.other.key', 'o');
  forgetInvite(s, l, 'blastcast.guest.abc');
  assert.equal(s.m.size, 0);
  assert.deepEqual([...l.m.keys()], ['blastcast.guest.other.key']);
  assert.doesNotThrow(() => forgetInvite(throwing, throwing, 'p'));
});

const src = readFileSync(new URL('../src/guest.ts', import.meta.url), 'utf8');
test('guest.ts forgets the invite on Leave and on 410, never on pagehide or beforeunload', () => {
  const leave = /el\('guest-leave'\)\.addEventListener\('click', \(\) => \{[\s\S]*?\n\}\);/.exec(src)?.[0] ?? '';
  assert.match(leave, /forgetInvite\(/);
  const gone = /response\.status === 410\) \{[\s\S]*?\n    \}/.exec(src)?.[0] ?? '';
  assert.match(gone, /forgetInvite\(/);
  for (const ev of ['pagehide', 'beforeunload']) {
    const line = src.split('\n').find(l => l.includes(`addEventListener('${ev}'`)) ?? '';
    assert.ok(line, ev); assert.doesNotMatch(line, /forgetInvite/);
  }
  assert.equal(src.split('forgetInvite(').length - 1, 2, 'exactly the Leave and 410 calls');
});
